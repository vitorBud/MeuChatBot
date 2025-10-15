import os, sys, json, logging, time, math, statistics, requests
from pathlib import Path
from urllib.parse import quote_plus
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from flask import Flask, render_template, request, jsonify

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

# --- Helpers LLM ------------------------------------------------------------
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

# --- Web (views) ------------------------------------------------------------
@app.get("/")
def index():
    return render_template("index.html")

@app.post("/responder")
def responder():
    if not get_api_key():
        return jsonify({"resposta": "Servidor sem GEMINI_API_KEY configurada."}), 500

    dados = request.get_json(force=True) or {}
    pergunta = (dados.get("mensagem") or "").strip()
    if not pergunta:
        return jsonify({"resposta": "Manda a pergunta"}), 400

    try:
        resp = _call_gemini(pergunta)
    except Exception as e:
        logging.exception("Falha na requisição ao Gemini")
        return jsonify({"resposta": f"Ocorreu um erro de rede: {e}"}), 200

    if resp.status_code != 200:
        try:
            err = resp.json().get("error", {})
            msg = err.get("message") or resp.text
        except Exception:
            msg = resp.text
        logging.warning("Gemini HTTP %s: %s", resp.status_code, msg)
        low = (msg or "").lower()
        if "expired" in low or "revoked" in low:
            return jsonify({"resposta": "A chave de API está expirada/revogada. Atualize GEMINI_API_KEY no .env e reinicie."}), 200
        return jsonify({"resposta": f"Erro {resp.status_code}: {msg}"}), 200

    body = resp.json()
    pf = body.get("promptFeedback") or {}
    if pf.get("blockReason"):
        return jsonify({"resposta": f"Pedido bloqueado pela política ({pf.get('blockReason')})."}), 200

    text = _extract_texts(body)
    if not text:
        logging.warning("Sem texto na resposta:\n%s", json.dumps(body, ensure_ascii=False, indent=2))
        return jsonify({"resposta": "Não consegui gerar texto agora. Tenta reformular a pergunta."}), 200

    return jsonify({"resposta": text}), 200

@app.get("/health")
def health():
    return jsonify({
        "ok": bool(get_api_key()),
        "model": MODEL_NAME,
        "api_key_masked": _mask(get_api_key()),
        "gen_cfg": get_gen_cfg(),
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
    # garante ordenação e integridade
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

    # 6) resposta JSON estável
    resp = {
        "previsao": previsao_txt,
        "series": series,               # [{ date: "YYYY-MM-DD", count: int }]
        "trend": trend,                 # { slope, pct, last_delta, confidence, score }
        "artigos": artigos_out,         # [{ titulo, url, data_iso, fonte }]
        "hipoteses": hipoteses,         # sugestões rule-based
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

    logging.info("[/prever] tema='%s' dias=%s -> pontos=%s artigos=%s trend=%s%% (Δ=%s)",
                 tema, dias, len(series), len(artigos_out), resp["trend"]["pct"], resp["trend"]["last_delta"])

    return jsonify(resp), 200

# --- Main -------------------------------------------------------------------
if __name__ == "__main__":
    debug = os.getenv("FLASK_DEBUG", "1") == "1"
    port = int(os.getenv("PORT", "5000"))
    # use_reloader=False evita duplicar processo no Windows e "loops" estranhos
    app.run(host="127.0.0.1", port=port, debug=debug, use_reloader=False)
