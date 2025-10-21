import os, sys, json, logging, time, math, statistics, re, requests
from pathlib import Path
from urllib.parse import quote_plus, urlparse
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from functools import lru_cache

from flask import Flask, render_template, request, jsonify, Response, stream_with_context

# Multi-provedor (Gemini / Ollama)
from providers import call_llm

logging.basicConfig(level=logging.INFO, stream=sys.stdout)

# --- .env (prioriza .env sobre variáveis do SO) -----------------------------
try:
    from dotenv import load_dotenv
    DOTENV_PATH = Path(__file__).resolve().parent / ".env"
    if DOTENV_PATH.exists():
        load_dotenv(DOTENV_PATH, override=True)
        logging.info(f".env carregado de: {DOTENV_PATH}")
    else:
        logging.warning(f".env NÃO encontrado em: {DOTENV_PATH}")
except Exception:
    logging.warning("python-dotenv não instalado; seguindo sem .env.")

app = Flask(__name__)

# --- Config base ------------------------------------------------------------
MODEL_NAME = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
API_BASE   = os.getenv("GEMINI_API_BASE", "https://generativelanguage.googleapis.com")
API_URL    = f"{API_BASE}/v1beta/models/{MODEL_NAME}:generateContent"

LLM_PROVIDER = os.getenv("LLM_PROVIDER", "gemini").lower()
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "phi4")

def get_api_key() -> str:
    return (os.getenv("GEMINI_API_KEY") or "").strip()

def get_headers() -> dict:
    return {
        "Content-Type": "application/json",
        "x-goog-api-key": get_api_key(),
    }

def get_gen_cfg() -> dict:
    return {
        "temperature": float(os.getenv("GEN_TEMPERATURE", "0.5")),
        "topP": float(os.getenv("GEN_TOP_P", "0.9")),
        "maxOutputTokens": int(os.getenv("GEN_MAX_TOKENS", "700")),
    }

BOT_PERSONA = (
    "Você é um analista pragmático. Faça leituras claras, evite floreios, "
    "e proponha hipóteses testáveis com validações rápidas e baratas."
)

# --- Helpers LLM (para refino Gemini opcional) ------------------------------
def _extract_texts(data: dict) -> str:
    texts = []
    for cand in data.get("candidates", []):
        for part in (cand.get("content", {}).get("parts") or []):
            t = part.get("text")
            if t:
                texts.append(t)
    return "\n".join(texts).strip()

def _payload(prompt: str) -> dict:
    return {
        "systemInstruction": {"role": "system", "parts": [{"text": BOT_PERSONA}]},
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": get_gen_cfg(),
    }

def _call_gemini(prompt: str):
    return requests.post(API_URL, headers=get_headers(), json=_payload(prompt), timeout=(5, 30))

def _mask(s: str) -> str:
    if not s: return "NONE"
    s = s.strip()
    return (s[:6] + "…" + s[-4:]) if len(s) > 10 else "****"

# ===================== RAG LOCAL (embeddings se disponível; fallback TF-IDF) =====================
EMBED_ON = False
EMBED_MODEL_NAME = os.getenv("EMBED_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
_embeddings = None
_vec = None
_docs = []          # lista de strings
_embs = None        # numpy array (n_docs x dim) normalizado

def _load_corpus():
    """Carrega textos de ./data/*.txt (corta p/ segurança)"""
    global _docs
    _docs = []
    data_dir = Path("data")
    if data_dir.exists():
        for p in data_dir.glob("*.txt"):
            try:
                t = p.read_text(encoding="utf-8", errors="ignore")
                t = t.strip()
                if t:
                    _docs.append(t[:6000])
            except Exception:
                logging.exception("Falha lendo %s", p)
    logging.info("RAG: %s docs em ./data", len(_docs))

def _boot_embeddings():
    """Tenta carregar SentenceTransformers; senão, cai em TF-IDF."""
    global EMBED_ON, _embeddings, _embs, _vec
    _load_corpus()
    if not _docs:
        logging.info("RAG: sem documentos; contexto ficará vazio.")
        return
    try:
        from sentence_transformers import SentenceTransformer
        import numpy as np
        _embeddings = SentenceTransformer(EMBED_MODEL_NAME)
        embs = _embeddings.encode(_docs, convert_to_numpy=True, normalize_embeddings=True)
        _embs = embs
        EMBED_ON = True
        logging.info("RAG: embeddings ON (%s) para %s docs", EMBED_MODEL_NAME, len(_docs))
    except Exception:
        logging.warning("RAG: embeddings OFF, usando TF-IDF")
        EMBED_ON = False
        try:
            from sklearn.feature_extraction.text import TfidfVectorizer
            _vec = TfidfVectorizer(stop_words="portuguese").fit(_docs)
            logging.info("RAG: TF-IDF pronto (%s docs)", len(_docs))
        except Exception:
            logging.exception("RAG: TF-IDF indisponível")

def _rag_topk(query: str, k=5):
    """Retorna top-k trechos de contexto por similaridade."""
    if not _docs:
        return []
    try:
        if EMBED_ON and _embeddings is not None and _embs is not None:
            import numpy as np
            q = _embeddings.encode([query], convert_to_numpy=True, normalize_embeddings=True)[0]
            sims = (_embs @ q)  # cos sim porque normalizado
            idx = sims.argsort()[::-1][:k]
            return [(_docs[i], float(sims[i])) for i in idx]
        else:
            if _vec is None:
                return []
            from sklearn.feature_extraction.text import TfidfVectorizer  # import para mypy
            dv = _vec.transform(_docs)
            qv = _vec.transform([query])
            scores = (qv @ dv.T).toarray()[0]
            idx = scores.argsort()[::-1][:k]
            return [(_docs[i], float(scores[i])) for i in idx]
    except Exception:
        logging.exception("RAG: falha no topk")
        return []

def _compose_with_context(query: str) -> str:
    hits = _rag_topk(query, k=5)
    ctx_parts = [t for (t, _) in hits][:3]
    if ctx_parts:
        context = "\n\n---\n".join(ctx_parts)
        return f"Use estritamente o contexto abaixo para responder com precisão.\n\n[CONTEXTO]\n{context}\n\n[PERGUNTA]\n{query}"
    return query

# ===================== Ferramentas gratuitas (slash-commands) =====================
SAFE_HOSTS = set([
    "raw.githubusercontent.com","data.gov.br","dados.gov.br",
    "www.gov.br","g1.globo.com","www1.folha.uol.com.br"
])

def _safe_http_get(url:str, timeout=(5,10)):
    try:
        u = urlparse(url)
        if u.scheme not in ("http","https"): return None
        if u.netloc not in SAFE_HOSTS: return None
        r = requests.get(url, timeout=timeout)
        r.raise_for_status()
        return r.text[:10000]
    except Exception:
        return None

def _calc(expr:str):
    if not re.fullmatch(r"[0-9\.\+\-\*\/\(\)\s%]+", expr):
        raise ValueError("Expressão inválida")
    return str(eval(expr))

def _rss_search(q:str, n=10):
    try:
        url = f"https://news.google.com/rss/search?q={quote_plus(q)}&hl=pt-BR&gl=BR&ceid=BR:pt-419"
        r = requests.get(url, timeout=(5,10)); r.raise_for_status()
        import xml.etree.ElementTree as ET
        root=ET.fromstring(r.text); out=[]
        for it in root.findall(".//item")[:n]:
            out.append({"title": it.findtext("title") or "", "link": it.findtext("link") or ""})
        return out
    except Exception:
        return []

# ===================== Cache semântico + Draft->Critic =====================
def _norm(s:str) -> str:
    return " ".join((s or "").lower().split())[:2000]

@lru_cache(maxsize=256)
def _cached_answer(norm_q:str, prompt:str, persona:str, cfg_tuple:tuple):
    return call_llm(prompt, persona, {
        "temperature": cfg_tuple[0], "topP": cfg_tuple[1], "maxOutputTokens": cfg_tuple[2]
    })

# ===================== Web (views) =====================
@app.get("/")
def index():
    return render_template("index.html")

# ---- Chat síncrono (com RAG, ferramentas, draft+critic) ----
@app.post("/responder")
def responder():
    dados = request.get_json(force=True) or {}
    pergunta = (dados.get("mensagem") or "").strip()
    if not pergunta:
        return jsonify({"resposta": "Manda a pergunta"}), 400

    # Slash-commands (barato e direto)
    if pergunta.startswith("/calc "):
        try:
            return jsonify({"resposta": _calc(pergunta[6:])}), 200
        except Exception as e:
            return jsonify({"resposta": f"Erro no calc: {e}"}), 200

    if pergunta.startswith("/http "):
        txt = _safe_http_get(pergunta[6:].strip())
        return jsonify({"resposta": txt or "URL não permitida ou vazia."}), 200

    if pergunta.startswith("/rss "):
        items = _rss_search(pergunta[5:].strip(), n=8)
        if not items: return jsonify({"resposta":"Nada encontrado."}), 200
        lista = "\n".join([f"- [{i['title']}]({i['link']})" for i in items])
        return jsonify({"resposta": f"**RSS** sobre “{pergunta[5:].strip()}”:\n\n{lista}"}), 200

    # Prompt com contexto (RAG)
    gen = get_gen_cfg()
    cfg_tuple = (gen["temperature"], gen["topP"], gen["maxOutputTokens"])
    final_prompt = _compose_with_context(pergunta)
    norm_q = _norm(final_prompt)

    try:
        draft = _cached_answer(norm_q, final_prompt, BOT_PERSONA, cfg_tuple)
        if not draft:
            draft = "Não consegui gerar resposta agora. Tente reformular a pergunta."
    except Exception as e:
        logging.exception("Falha no draft")
        draft = f"Erro na geração: {e}"

    # Crítica curta (segundo passo) – eleva consistência
    try:
        critic_prompt = (
          "Revise a resposta abaixo para corrigir erros e torná-la mais útil. "
          "Se estiver incerto, seja explícito e proponha verificação. "
          "Responda em **Markdown** e de forma direta.\n\n"
          f"Pergunta: {pergunta}\n\nRascunho:\n{draft}\n\nFinal:"
        )
        final = call_llm(critic_prompt, BOT_PERSONA, gen) or draft
    except Exception:
        logging.exception("Falha na crítica; devolvendo rascunho")
        final = draft

    return jsonify({"resposta": final}), 200

# ---- Chat streaming (SSE) ----
@app.get("/responder_stream")
def responder_stream():
    q = (request.args.get("q") or "").strip()
    if not q:
        return Response("event: error\ndata: Falta parâmetro q\n\n", mimetype="text/event-stream")

    def gen():
        yield "event: start\ndata: {}\n\n"
        try:
            if LLM_PROVIDER == "ollama":
                # Streaming nativo via Ollama
                payload = {
                    "model": OLLAMA_MODEL,
                    "prompt": f"<<SYS>>\n{BOT_PERSONA}\n<</SYS>>\n\n{q}",
                    "stream": True,
                    "options": {"temperature": float(get_gen_cfg()["temperature"])}
                }
                with requests.post("http://127.0.0.1:11434/api/generate", json=payload, stream=True, timeout=(10, 180)) as r:
                    r.raise_for_status()
                    for line in r.iter_lines(decode_unicode=True):
                        if not line: continue
                        try:
                            obj = json.loads(line)
                            chunk = obj.get("response","")
                            if chunk:
                                yield f"data: {json.dumps({'delta': chunk})}\n\n"
                        except Exception:
                            pass
                yield "event: end\ndata: {}\n\n"
            else:
                # Gemini v1beta sem stream -> chunking local
                text = call_llm(q, BOT_PERSONA, get_gen_cfg()) or ""
                for part in [text[i:i+220] for i in range(0, len(text), 220)]:
                    yield f"data: {json.dumps({'delta': part})}\n\n"
                yield "event: end\ndata: {}\n\n"
        except Exception as e:
            yield f"event: error\ndata: {str(e)}\n\n"

    return Response(stream_with_context(gen()), mimetype="text/event-stream")

@app.get("/health")
def health():
    return jsonify({
        "provider": LLM_PROVIDER,
        "ollama_model": OLLAMA_MODEL if LLM_PROVIDER=="ollama" else None,
        "ok": True if (LLM_PROVIDER=="ollama" or get_api_key()) else False,
        "model": MODEL_NAME if LLM_PROVIDER=="gemini" else None,
        "api_key_masked": _mask(get_api_key()) if LLM_PROVIDER=="gemini" else None,
        "gen_cfg": get_gen_cfg(),
        "rag": {
            "embeddings": bool(EMBED_ON),
            "docs": len(_docs)
        }
    })

# ===================== CÉREBRO “PREVISÕES” (sem custos) =====================

# Cache leve em memória p/ RSS (TTL curto evita loop/rajada)
_RSS_CACHE = {}  # key: (tema_normalizado, max_items) -> {ts, items}
_RSS_TTL_SECONDS = 300  # 5 min de cache

def _rss_cache_key(tema: str, max_items: int) -> str:
    return f"{tema.strip().lower()}::{max_items}"

def _from_cache(tema: str, max_items: int):
    try:
        k = _rss_cache_key(tema, max_items)
        ent = _RSS_CACHE.get(k)
        if ent and (time.time() - ent["ts"] < _RSS_TTL_SECONDS):
            return ent["items"]
    except Exception:
        pass
    return None

def _to_cache(tema: str, max_items: int, items: list):
    try:
        k = _rss_cache_key(tema, max_items)
        _RSS_CACHE[k] = {"ts": time.time(), "items": items}
    except Exception:
        pass

def _fetch_news(tema: str, max_items: int = 80):
    """
    Retorna lista de artigos: [{'titulo','url','dt'}] usando Google News RSS.
    Resiliente: usa cache curto, timeout, e evita quebrar a pipeline.
    """
    cached = _from_cache(tema, max_items)
    if cached is not None:
        return cached

    url = (
        "https://news.google.com/rss/search?"
        f"q={quote_plus(tema)}&hl=pt-BR&gl=BR&ceid=BR:pt-419"
    )
    headers = {
        "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) "
                       "Chrome/124.0 Safari/537.36")
    }

    # retries simples
    last_err = None
    for attempt in range(3):
        try:
            r = requests.get(url, headers=headers, timeout=(5, 15))
            r.raise_for_status()
            break
        except Exception as e:
            last_err = e
            time.sleep(0.4 * (attempt + 1))
    else:
        logging.warning("Falha ao buscar RSS (esgotou retries): %s", last_err)
        _to_cache(tema, max_items, [])
        return []

    import xml.etree.ElementTree as ET
    items = []
    try:
        root = ET.fromstring(r.text)
        for it in root.findall(".//item"):
            title = (it.findtext("title") or "").strip()
            link  = (it.findtext("link") or "").strip()
            pub   = (it.findtext("pubDate") or "").strip()
            try:
                dt = parsedate_to_datetime(pub)
                if not dt.tzinfo:
                    dt = dt.replace(tzinfo=timezone.utc)
                dt = dt.astimezone(timezone.utc)
            except Exception:
                dt = datetime.now(timezone.utc)
            if title and link:
                items.append({"titulo": title, "url": link, "dt": dt})
            if len(items) >= max_items:
                break
    except Exception:
        logging.exception("Erro parseando RSS")
        _to_cache(tema, max_items, [])
        return []

    _to_cache(tema, max_items, items)
    return items

def _build_series(articles, dias: int):
    """Agrega por dia (últimos N dias, incluindo hoje). Sempre retorna N pontos."""
    if not isinstance(dias, int):
        try:
            dias = int(dias)
        except Exception:
            dias = 7
    dias = max(1, min(180, dias))  # trava em 180 dias por segurança

    today = datetime.now(timezone.utc).date()
    buckets = {(today + timedelta(days=i)).isoformat(): 0 for i in range(-(dias-1), 1)}

    for a in articles:
        try:
            d = a["dt"].astimezone(timezone.utc).date().isoformat()
            if d in buckets:
                buckets[d] += 1
        except Exception:
            pass

    series = [{"date": k, "count": buckets[k]} for k in sorted(buckets.keys())]
    return series

def _analyze(series):
    vals = [int(p.get("count", 0)) for p in series] or [0]
    last = vals[-1]
    prev = vals[:-1] or [0]
    mean_prev = sum(prev)/max(1, len(prev))
    change = last - (prev[-1] if prev else 0)
    momentum = change - ((prev[-1] - prev[-2]) if len(prev) > 1 else 0)

    if mean_prev == 0 and last == 0:
        label = "sem variação (baixa cobertura)"
    elif last > mean_prev * 1.25:
        label = "em alta"
    elif last < mean_prev * 0.75:
        label = "em baixa"
    else:
        label = "estável"

    resumo = (
        f"Volume {label}. Último dia: {last}. "
        f"Média anterior: {mean_prev:.1f}. Δ diário: {change:+d}. "
        f"Momentum: {momentum:+d}."
    )

    hipoteses = [
        {
            "descricao": "Cobertura deve manter inércia de curto prazo.",
            "indicadores": ["Contagem diária de manchetes (RSS)", "Média móvel de 3 dias"],
            "validacaoRapida": ["Coletar por 3–5 dias e comparar com janela anterior"]
        },
        {
            "descricao": "Acontecimentos de governo/políticas geram picos pontuais.",
            "indicadores": ["Termos: Ministério, Secretaria, projeto de lei"],
            "validacaoRapida": ["Filtrar manchetes por termos regulatórios", "Checar fontes oficiais"]
        },
        {
            "descricao": "Influencers/edtechs podem criar ondas de atenção.",
            "indicadores": ["Posts patrocinados", "Lives/lançamentos"],
            "validacaoRapida": ["Monitorar hashtags no X/YouTube", "Olhar Google Trends 7 vs 30 dias"]
        },
    ]
    return resumo, hipoteses

def _llm_refine_resumo(tema, series, resumo_base):
    """Opcional: refina o resumo com LLM (se houver chave). Fallback seguro."""
    if not get_api_key():
        return resumo_base
    try:
        compact = json.dumps(series, ensure_ascii=False)
        prompt = (
            f"Tema: {tema}\n"
            f"Série (lista de objetos com date e count): {compact}\n"
            f"Escreva um parágrafo curto (máx. 3 linhas) resumindo a tendência. "
            f"Seja direto. Rascunho: '{resumo_base}'!"
        )
        resp = _call_gemini(prompt)
        if resp.status_code == 200:
            txt = _extract_texts(resp.json()).strip()
            return txt or resumo_base
        else:
            logging.warning("Refino LLM falhou HTTP %s", resp.status_code)
    except Exception:
        logging.exception("Refino LLM disparou exceção")
    return resumo_base

def _trend_confidence(vals):
    """Computa slope, variação percentual do período e last_delta + confiança simples."""
    n = len(vals)
    if n < 2:
        return 0.0, 0.0, 0, 0.5, "Média"

    x = list(range(n))
    mean_x = sum(x) / n
    mean_y = sum(vals) / n
    num = sum((x[i]-mean_x)*(vals[i]-mean_y) for i in range(n))
    den = sum((x[i]-mean_x)**2 for i in range(n)) or 1
    slope = num / den

    first, last = vals[0], vals[-1]
    pct = ((last - first) / first * 100.0) if first else 0.0
    last_delta = last - vals[-2]

    try:
        stdev = statistics.pstdev(vals)
        score = 1 / (1 + math.exp(-slope / (stdev + 1e-6)))
        if score > 0.66:
            conf_label = "Alta"
        elif score < 0.33:
            conf_label = "Baixa"
        else:
            conf_label = "Média"
    except Exception:
        score, conf_label = 0.5, "Média"

    return slope, pct, last_delta, score, conf_label

# ------------------------- ROTA /prever -------------------------------------
@app.post("/prever")
def prever():
    dados = request.get_json(force=True) or {}
    tema = (dados.get("tema") or "").strip()
    dias = dados.get("dias", 7)
    ano_ini = int(dados.get("anos_de", 0) or 0)
    ano_fim = int(dados.get("anos_ate", 0) or 0)

    if not tema:
        return jsonify({"erro": "Informe 'tema' no body JSON."}), 400

    # Sanitiza dias
    try:
        dias = int(dias)
    except Exception:
        dias = 7
    dias = max(1, min(180, dias))

    # 1) coleta RSS (com cache curto + retries)
    artigos = _fetch_news(tema, max_items=120)
    if ano_ini and ano_fim and ano_ini <= ano_fim:
        artigos = [a for a in artigos if ano_ini <= a["dt"].year <= ano_fim]

    # 2) série de contagens por dia
    series = _build_series(artigos, dias)
    series = sorted(series, key=lambda p: p["date"])
    vals = [int(p.get("count", 0)) for p in series] or [0]

    # 3) análise + (opcional) refino LLM
    resumo_base, hipoteses = _analyze(series)
    previsao_txt = _llm_refine_resumo(tema, series, resumo_base)

    # 4) tendência e confiança
    slope, pct, last_delta, score, conf_label = _trend_confidence(vals)
    trend = {
        "slope": round(slope, 6),
        "pct": round(pct, 2),
        "last_delta": int(last_delta),
        "confidence": conf_label,
        "score": round(float(score), 4)
    }

    # 5) artigos recentes (até 12)
    artigos_out = []
    for a in sorted(artigos, key=lambda x: x["dt"], reverse=True)[:12]:
        artigos_out.append({
            "titulo": a["titulo"],
            "url": a["url"],
            "data_iso": a["dt"].astimezone(timezone.utc).isoformat(),
            "fonte": a["url"].split('/')[2] if '//' in a["url"] else ''
        })

    # 6) extras grátis: sentimento e picos
    def _sentiment(items):
        try:
            from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
            an = SentimentIntensityAnalyzer()
            scores = [an.polarity_scores(i["titulo"])["compound"] for i in items]
            return scores
        except Exception:
            return [0.0 for _ in items]

    sent = _sentiment(artigos)
    sent_mean = round(sum(sent)/max(1,len(sent)), 3) if sent else 0.0

    mu = sum(vals)/max(1,len(vals))
    sd = (sum((x-mu)**2 for x in vals)/max(1,len(vals)))**0.5 if vals else 0.0
    spikes = [series[i]["date"] for i,x in enumerate(vals) if sd>1e-6 and (x-mu)/sd >= 2.0]

    # 7) resposta JSON estável
    resp = {
        "previsao": previsao_txt,
        "series": series,
        "trend": trend,
        "artigos": artigos_out,
        "hipoteses": hipoteses,
        "analytics": {
            "sentiment_mean": sent_mean,
            "spikes": spikes
        },
        "meta": {
            "tema": tema,
            "dias": dias,
            "filtrado_por_ano": bool(ano_ini and ano_fim and ano_ini <= ano_fim),
            "anos_de": ano_ini or None,
            "anos_ate": ano_fim or None,
            "series_total": len(series),
            "artigos_total": len(artigos_out)
        }
    }

    logging.info("[/prever] tema='%s' dias=%s -> pontos=%s artigos=%s trend=%s%% (Δ=%s) sent=%.3f spikes=%s",
                 tema, dias, len(series), len(artigos_out), resp["trend"]["pct"], resp["trend"]["last_delta"],
                 sent_mean, len(spikes))

    return jsonify(resp), 200

# --- Boot RAG ---------------------------------------------------------------
def _bootstrap_rag():
    try:
        _boot_embeddings()
    except Exception:
        logging.exception("Falha ao inicializar RAG")

_bootstrap_rag()

# --- Main -------------------------------------------------------------------
if __name__ == "__main__":
    debug = os.getenv("FLASK_DEBUG", "1") == "1"
    port = int(os.getenv("PORT", "5000"))
    # use_reloader=False evita duplicar processo no Windows e "loops" estranhos
    app.run(host="127.0.0.1", port=port, debug=debug, use_reloader=False)
