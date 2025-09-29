import os, sys, json, logging, requests
from pathlib import Path
from urllib.parse import quote_plus
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from flask import Flask, render_template, request, jsonify

logging.basicConfig(level=logging.INFO, stream=sys.stdout)

# --- .env (o .env deve prevalecer) -----------------------------------------
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
    return {"Content-Type": "application/json", "x-goog-api-key": get_api_key()}

def get_gen_cfg() -> dict:
    return {
        "temperature": float(os.getenv("GEN_TEMPERATURE", "0.5")),
        "topP": float(os.getenv("GEN_TOP_P", "0.9")),
        "maxOutputTokens": int(os.getenv("GEN_MAX_TOKENS", "700")),
    }

BOT_PERSONA = (
    "Você é um analista pragmático. Faça leituras claras, evite floreios, e proponha "
    "hipóteses testáveis com validações rápidas e baratas."
)

# --- Helpers LLM ------------------------------------------------------------
def _extract_texts(data: dict) -> str:
    texts = []
    for cand in data.get("candidates", []):
        for part in (cand.get("content", {}).get("parts") or []):
            t = part.get("text")
            if t: texts.append(t)
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

# ===================== NOVO “CÉREBRO” DO PREVISÕES ==========================
# 1) Coleta simples via Google News RSS (grátis)
def _fetch_news(tema: str, max_items: int = 80):
    """Retorna lista de artigos: [{'titulo','url','dt'}] usando Google News RSS."""
    url = (
        "https://news.google.com/rss/search?"
        f"q={quote_plus(tema)}&hl=pt-BR&gl=BR&ceid=BR:pt-419"
    )
    try:
        r = requests.get(url, timeout=(5, 15))
        r.raise_for_status()
    except Exception as e:
        logging.warning("Falha ao buscar RSS: %s", e)
        return []

    # parse leve do XML (sem dependências externas)
    import xml.etree.ElementTree as ET
    items = []
    try:
        root = ET.fromstring(r.text)
        for it in root.iterfind(".//item"):
            title = (it.findtext("title") or "").strip()
            link  = (it.findtext("link") or "").strip()
            pub   = (it.findtext("pubDate") or "").strip()
            try:
                dt = parsedate_to_datetime(pub)
                if not dt.tzinfo:
                    dt = dt.replace(tzinfo=timezone.utc)
            except Exception:
                dt = datetime.now(timezone.utc)
            if title and link:
                items.append({"titulo": title, "url": link, "dt": dt})
            if len(items) >= max_items:
                break
    except Exception as e:
        logging.exception("Erro parseando RSS")
        return []

    return items

# 2) Agrega por dia (últimos N)
def _build_series(articles, dias: int):
    """Retorna lista [{date:'YYYY-MM-DD', count:int}] dos últimos N dias."""
    if dias < 1: dias = 7
    today = datetime.now(timezone.utc).date()
    buckets = { (today + timedelta(days=i)).isoformat(): 0 for i in range(-(dias-1), 1) }

    for a in articles:
        try:
            d = a["dt"].astimezone(timezone.utc).date().isoformat()
            if d in buckets:
                buckets[d] += 1
        except Exception:
            pass

    series = [{"date": k, "count": buckets[k]} for k in sorted(buckets.keys())]
    return series

# 3) Heurísticas de tendência + hipóteses rule-based (sem LLM)
def _analyze(series):
    vals = [p["count"] for p in series] or [0]
    last = vals[-1]
    prev = vals[:-1] or [0]
    mean_prev = sum(prev)/max(1, len(prev))
    change = last - (prev[-1] if prev else 0)
    momentum = change - ((prev[-1] - prev[-2]) if len(prev) > 1 else 0)

    if last > mean_prev * 1.25:
        label = "alta"
    elif last < mean_prev * 0.75:
        label = "baixa"
    else:
        label = "estável"

    resumo = (
        f"Volume de notícias {label}. Último dia: {last}. "
        f"Média anterior: {mean_prev:.1f}. Variação diária: {change:+d}. "
        f"Momentum: {momentum:+d}."
    )

    hipoteses = [
        {
            "descricao": "Cobertura midiática deve seguir o padrão atual (inércia de curto prazo).",
            "indicadores": ["Contagem diária de manchetes (RSS)", "Média móvel 3 dias"],
            "validacaoRapida": ["Repetir coleta RSS por 3–5 dias", "Comparar com janela anterior"]
        },
        {
            "descricao": "Eventos/políticas locais podem criar picos pontuais.",
            "indicadores": ["Menções a 'Ministério', 'Secretaria', 'projeto de lei'"],
            "validacaoRapida": ["Filtrar manchetes por termos regulatórios", "Checar diários oficiais/sites gov"]
        },
        {
            "descricao": "Influência de criadores/edtechs gera ondas de atenção.",
            "indicadores": ["Picos de YouTube/TikTok", "Posts patrocinados"],
            "validacaoRapida": ["Monitorar hashtags no X/YouTube 3–5 dias", "Olhar Google Trends"]
        },
    ]
    return resumo, hipoteses

# 4) Opcional: LLM apenas para redigir melhor o resumo usando os números
def _llm_refine_resumo(tema, series, resumo_base):
    if not get_api_key():
        return resumo_base
    try:
        compact = json.dumps(series, ensure_ascii=False)
        prompt = (
            f"Tema: {tema}\n"
            f"Série (date,count): {compact}\n"
            f"Escreva um parágrafo curto (máx. 3 linhas) resumindo a tendência, sem floreios. "
            f"Isto é o rascunho: '{resumo_base}'. Seja direto."
        )
        resp = _call_gemini(prompt)
        if resp.status_code == 200:
            txt = _extract_texts(resp.json()).strip()
            return txt or resumo_base
    except Exception:
        pass
    return resumo_base

# ------------------------- ROTA /prever -------------------------------------
@app.post("/prever")
def prever():
    dados = request.get_json(force=True) or {}
    tema = (dados.get("tema") or "").strip()
    dias = int(dados.get("dias", 7))
    if not tema:
        return jsonify({"erro": "Informe 'tema' no body JSON."}), 400

    # 1) coleta
    articles = _fetch_news(tema, max_items=120)

    # 2) série (se nada vier, ainda assim devolvemos série “zerada”)
    series = _build_series(articles, dias)

    # 3) análise
    resumo_base, hipoteses = _analyze(series)
    previsao_txt = _llm_refine_resumo(tema, series, resumo_base)

    # 4) top artigos recentes (até 12)
    artigos_out = []
    for a in sorted(articles, key=lambda x: x["dt"], reverse=True)[:12]:
        artigos_out.append({
            "titulo": a["titulo"],
            "url": a["url"],
            "data_iso": a["dt"].astimezone(timezone.utc).isoformat()
        })

    return jsonify({
        "previsao": previsao_txt,
        "hipoteses": hipoteses,
        "series": series,          # <- formato que seu script.js usa: {date, count}
        "artigos": artigos_out
    }), 200

# --- Main -------------------------------------------------------------------
if __name__ == "__main__":
    debug = os.getenv("FLASK_DEBUG", "1") == "1"
    port = int(os.getenv("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=debug)
