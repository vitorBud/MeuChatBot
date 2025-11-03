# app_oop.py
# OrionAI (POO Edition) — Flask + RAG + RSS + Trend Analytics
# Mantém rotas: "/", "/responder", "/responder_stream", "/health", "/prever"
# Personalidade: direto, pragmático e levemente espirituoso.

import os, sys, json, logging, time, math, statistics, re, requests
from pathlib import Path
from urllib.parse import quote_plus, urlparse
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from functools import lru_cache

from flask import Flask, render_template, request, jsonify, Response, stream_with_context

# Multi-provedor (Gemini / Ollama) — aproveita seu provider atual:
from providers import call_llm

# ----------------------------- Logging ---------------------------------------
logging.basicConfig(level=logging.INFO, stream=sys.stdout)
log = logging.getLogger("orionai")

# ----------------------------- Infra Utils -----------------------------------
def _mask(s: str) -> str:
    if not s:
        return "NONE"
    s = s.strip()
    return (s[:6] + "…" + s[-4:]) if len(s) > 10 else "****"

def _norm(s:str) -> str:
    return " ".join((s or "").lower().split())[:2000]

# =============================== Config ======================================
class AppConfig:
    """Carrega e centraliza configuração do app."""
    def __init__(self):
        self._load_dotenv()
        self.LLM_PROVIDER = os.getenv("LLM_PROVIDER", "gemini").lower()
        self.OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "phi4")
        self.GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
        self.GEMINI_API_BASE = os.getenv("GEMINI_API_BASE", "https://generativelanguage.googleapis.com")
        self.GEMINI_API_KEY = (os.getenv("GEMINI_API_KEY") or "").strip()

        self.GEN_TEMPERATURE = float(os.getenv("GEN_TEMPERATURE", "0.5"))
        self.GEN_TOP_P = float(os.getenv("GEN_TOP_P", "0.9"))
        self.GEN_MAX_TOKENS = int(os.getenv("GEN_MAX_TOKENS", "700"))

        # Persona com personalidade (“direto, pragmático e levemente espirituoso”)
        self.BOT_PERSONA = os.getenv("BOT_PERSONA",
            "Você é o OrionAI: direto, pragmático e levemente espirituoso. "
            "Priorize respostas claras, hipótese → validação, sem floreios desnecessários. "
            "Se não tiver certeza, diga como validar rápido e barato."
        )

        # RSS Cache
        self.RSS_TTL_SECONDS = int(os.getenv("RSS_TTL_SECONDS", "300"))
        self.RSS_MAX_ITEMS = int(os.getenv("RSS_MAX_ITEMS", "120"))

        # Servidor Flask
        self.FLASK_DEBUG = os.getenv("FLASK_DEBUG", "1") == "1"
        self.PORT = int(os.getenv("PORT", "5000"))

        # Segurança para /http
        self.SAFE_HOSTS = set([
            "raw.githubusercontent.com","data.gov.br","dados.gov.br",
            "www.gov.br","g1.globo.com","www1.folha.uol.com.br"
        ])

    def _load_dotenv(self):
        try:
            from dotenv import load_dotenv
            dotenv_path = Path(__file__).resolve().parent / ".env"
            if dotenv_path.exists():
                load_dotenv(dotenv_path, override=True)
                log.info(f".env carregado de: {dotenv_path}")
            else:
                log.warning(f".env NÃO encontrado em: {dotenv_path}")
        except Exception:
            log.warning("python-dotenv não instalado; seguindo sem .env.")

    @property
    def gemini_api_url(self) -> str:
        return f"{self.GEMINI_API_BASE}/v1beta/models/{self.GEMINI_MODEL}:generateContent"

    def gen_cfg(self) -> dict:
        return {
            "temperature": self.GEN_TEMPERATURE,
            "topP": self.GEN_TOP_P,
            "maxOutputTokens": self.GEN_MAX_TOKENS,
        }

# =============================== LLM Layer ===================================
class LLMClient:
    """Fachada para múltiplos provedores, reusando seu call_llm para simplicidade."""
    def __init__(self, cfg: AppConfig):
        self.cfg = cfg

    def answer(self, prompt: str) -> str:
        # Usa call_llm diretamente (seu provider), mantendo compatibilidade
        try:
            return call_llm(prompt, self.cfg.BOT_PERSONA, self.cfg.gen_cfg()) or ""
        except Exception as e:
            log.exception("LLM answer falhou")
            return f"Falhou gerar resposta: {e}"

    def refine(self, pergunta: str, draft: str) -> str:
        critic_prompt = (
            "Revise a resposta abaixo para corrigir erros e torná-la mais útil. "
            "Se estiver incerto, seja explícito e proponha verificação. "
            "Responda em **Markdown** e de forma direta.\n\n"
            f"Pergunta: {pergunta}\n\nRascunho:\n{draft}\n\nFinal:"
        )
        try:
            final = call_llm(critic_prompt, self.cfg.BOT_PERSONA, self.cfg.gen_cfg())
            return final or draft
        except Exception:
            log.exception("Falha no refine; retornando draft")
            return draft

# =============================== RAG Engine ==================================
class RAGEngine:
    """Carrega documentos e atende buscas com Embeddings ou TF-IDF."""
    def __init__(self, data_dir="data", embed_model="sentence-transformers/all-MiniLM-L6-v2"):
        self.data_dir = Path(data_dir)
        self.embed_model_name = embed_model
        self.docs = []
        self.embed_on = False
        self._embeddings = None
        self._embs = None
        self._vec = None
        self._boot()

    def _load_corpus(self):
        self.docs = []
        if self.data_dir.exists():
            for p in self.data_dir.glob("*.txt"):
                try:
                    t = p.read_text(encoding="utf-8", errors="ignore").strip()
                    if t:
                        self.docs.append(t[:6000])
                except Exception:
                    log.exception("Falha lendo %s", p)
        log.info("RAG: %s docs em ./data", len(self.docs))

    def _boot(self):
        self._load_corpus()
        if not self.docs:
            log.info("RAG: sem documentos; contexto ficará vazio.")
            return
        try:
            from sentence_transformers import SentenceTransformer
            import numpy as np  # noqa: F401
            self._embeddings = SentenceTransformer(self.embed_model_name)
            embs = self._embeddings.encode(self.docs, convert_to_numpy=True, normalize_embeddings=True)
            self._embs = embs
            self.embed_on = True
            log.info("RAG: embeddings ON (%s) para %s docs", self.embed_model_name, len(self.docs))
        except Exception:
            log.warning("RAG: embeddings OFF, usando TF-IDF")
            self.embed_on = False
            try:
                from sklearn.feature_extraction.text import TfidfVectorizer
                self._vec = TfidfVectorizer(stop_words="portuguese").fit(self.docs)
                log.info("RAG: TF-IDF pronto (%s docs)", len(self.docs))
            except Exception:
                log.exception("RAG: TF-IDF indisponível")

    def topk(self, query: str, k=5):
        if not self.docs:
            return []
        try:
            if self.embed_on and self._embeddings is not None and self._embs is not None:
                import numpy as np
                q = self._embeddings.encode([query], convert_to_numpy=True, normalize_embeddings=True)[0]
                sims = (self._embs @ q)
                idx = sims.argsort()[::-1][:k]
                return [(self.docs[i], float(sims[i])) for i in idx]
            else:
                if self._vec is None:
                    return []
                from sklearn.feature_extraction.text import TfidfVectorizer  # noqa
                dv = self._vec.transform(self.docs)
                qv = self._vec.transform([query])
                scores = (qv @ dv.T).toarray()[0]
                idx = scores.argsort()[::-1][:k]
                return [(self.docs[i], float(scores[i])) for i in idx]
        except Exception:
            log.exception("RAG: falha no topk")
            return []

    def compose_with_context(self, query: str) -> str:
        hits = self.topk(query, k=5)
        ctx_parts = [t for (t, _) in hits][:3]
        if ctx_parts:
            context = "\n\n---\n".join(ctx_parts)
            return f"Use estritamente o contexto abaixo para responder com precisão.\n\n[CONTEXTO]\n{context}\n\n[PERGUNTA]\n{query}"
        return query

# =============================== Ferramentas =================================
class Tools:
    def __init__(self, cfg: AppConfig):
        self.cfg = cfg

    def safe_http_get(self, url:str, timeout=(5,10)):
        try:
            u = urlparse(url)
            if u.scheme not in ("http","https"): return None
            if u.netloc not in self.cfg.SAFE_HOSTS: return None
            r = requests.get(url, timeout=timeout)
            r.raise_for_status()
            return r.text[:10000]
        except Exception:
            return None

    def calc(self, expr:str) -> str:
        if not re.fullmatch(r"[0-9\.\+\-\*\/\(\)\s%]+", expr):
            raise ValueError("Expressão inválida")
        return str(eval(expr))

    def rss_search(self, q:str, n=10):
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

# =============================== Cache leve ==================================
class MemoryCache:
    def __init__(self, ttl_seconds:int):
        self.ttl = ttl_seconds
        self._data = {}  # key -> {ts, value}

    def get(self, key:str):
        try:
            ent = self._data.get(key)
            if ent and (time.time() - ent["ts"] < self.ttl):
                return ent["value"]
        except Exception:
            pass
        return None

    def set(self, key:str, value):
        try:
            self._data[key] = {"ts": time.time(), "value": value}
        except Exception:
            pass

# =============================== News Service ================================
class NewsService:
    def __init__(self, cfg: AppConfig):
        self.cfg = cfg
        self.cache = MemoryCache(cfg.RSS_TTL_SECONDS)

    def _key(self, tema:str, max_items:int) -> str:
        return f"{tema.strip().lower()}::{max_items}"

    def fetch(self, tema: str, max_items: int = None):
        max_items = max_items or self.cfg.RSS_MAX_ITEMS
        key = self._key(tema, max_items)
        cached = self.cache.get(key)
        if cached is not None:
            return cached

        url = (
            "https://news.google.com/rss/search?"
            f"q={quote_plus(tema)}&hl=pt-BR&gl=BR&ceid=BR:pt-419"
        )
        headers = {"User-Agent": "Mozilla/5.0 Chrome/124.0 Safari/537.36"}

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
            log.warning("Falha ao buscar RSS: %s", last_err)
            self.cache.set(key, [])
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
            log.exception("Erro parseando RSS")
            self.cache.set(key, [])
            return []

        self.cache.set(key, items)
        return items

# =============================== Analytics ===================================
class AnalyticsService:
    def __init__(self, cfg: AppConfig, llm: LLMClient):
        self.cfg = cfg
        self.llm = llm

    def build_series(self, articles, dias: int):
        try:
            dias = int(dias)
        except Exception:
            dias = 7
        dias = max(1, min(180, dias))

        today = datetime.now(timezone.utc).date()
        buckets = {(today + timedelta(days=i)).isoformat(): 0 for i in range(-(dias-1), 1)}

        for a in articles:
            try:
                d = a["dt"].astimezone(timezone.utc).date().isoformat()
                if d in buckets:
                    buckets[d] += 1
            except Exception:
                pass

        return [{"date": k, "count": buckets[k]} for k in sorted(buckets.keys())]

    def _basic_analyze(self, series):
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
                "indicadores": ["Contagem diária (RSS)", "Média móvel de 3 dias"],
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
                "validacaoRapida": ["Monitorar hashtags no X/YouTube", "Google Trends 7 vs 30 dias"]
            },
        ]
        return resumo, hipoteses, vals

    def _trend_confidence(self, vals):
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

    def _sentiment(self, items):
        try:
            from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
            an = SentimentIntensityAnalyzer()
            scores = [an.polarity_scores(i["titulo"])["compound"] for i in items]
            return scores
        except Exception:
            return [0.0 for _ in items]

    def summarize(self, tema, series, resumo_base):
        # opcional refino LLM (só se houver chave)
        if not os.getenv("GEMINI_API_KEY"):
            return resumo_base
        try:
            compact = json.dumps(series, ensure_ascii=False)
            prompt = (
                f"Tema: {tema}\n"
                f"Série (lista de objetos com date e count): {compact}\n"
                f"Escreva um parágrafo curto (máx. 3 linhas) resumindo a tendência. "
                f"Seja direto. Rascunho: '{resumo_base}'!"
            )
            # usamos LLMClient.answer para padronizar
            text = self.llm.answer(prompt).strip()
            return text or resumo_base
        except Exception:
            log.exception("Refino LLM falhou")
            return resumo_base

    def analyze(self, tema:str, artigos:list, dias:int):
        series = self.build_series(artigos, dias)
        series = sorted(series, key=lambda p: p["date"])
        resumo_base, hipoteses, vals = self._basic_analyze(series)
        previsao_txt = self.summarize(tema, series, resumo_base)
        slope, pct, last_delta, score, conf_label = self._trend_confidence(vals)

        mu = sum(vals)/max(1,len(vals))
        sd = (sum((x-mu)**2 for x in vals)/max(1,len(vals)))**0.5 if vals else 0.0
        spikes = [series[i]["date"] for i,x in enumerate(vals) if sd>1e-6 and (x-mu)/sd >= 2.0]

        sent_scores = self._sentiment(artigos)
        sent_mean = round(sum(sent_scores)/max(1,len(sent_scores)), 3) if sent_scores else 0.0

        return {
            "series": series,
            "resumo": previsao_txt,
            "hipoteses": hipoteses,
            "trend": {
                "slope": round(slope, 6),
                "pct": round(pct, 2),
                "last_delta": int(last_delta),
                "confidence": conf_label,
                "score": round(float(score), 4)
            },
            "analytics": {
                "sentiment_mean": sent_mean,
                "spikes": spikes
            }
        }

# =============================== Chat Service ================================
class ChatService:
    def __init__(self, cfg: AppConfig, llm: LLMClient, rag: RAGEngine, tools: Tools):
        self.cfg = cfg
        self.llm = llm
        self.rag = rag
        self.tools = tools

    @lru_cache(maxsize=256)
    def _cached_answer(self, norm_q:str, prompt:str, persona:str, cfg_tuple:tuple):
        return call_llm(prompt, persona, {
            "temperature": cfg_tuple[0], "topP": cfg_tuple[1], "maxOutputTokens": cfg_tuple[2]
        })

    def _compose_prompt(self, pergunta:str) -> str:
        return self.rag.compose_with_context(pergunta)

    def answer_sync(self, pergunta:str) -> str:
        # Slash-commands
        if pergunta.startswith("/calc "):
            try:
                return self.tools.calc(pergunta[6:])
            except Exception as e:
                return f"Erro no calc: {e}"
        if pergunta.startswith("/http "):
            txt = self.tools.safe_http_get(pergunta[6:].strip())
            return txt or "URL não permitida ou vazia."
        if pergunta.startswith("/rss "):
            items = self.tools.rss_search(pergunta[5:].strip(), n=8)
            if not items:
                return "Nada encontrado."
            lista = "\n".join([f"- [{i['title']}]({i['link']})" for i in items])
            return f"**RSS** sobre “{pergunta[5:].strip()}”:\n\n{lista}"

        gen = self.cfg.gen_cfg()
        cfg_tuple = (gen["temperature"], gen["topP"], gen["maxOutputTokens"])
        final_prompt = self._compose_prompt(pergunta)
        norm_q = _norm(final_prompt)

        # Draft
        try:
            draft = self._cached_answer(norm_q, final_prompt, self.cfg.BOT_PERSONA, cfg_tuple)
            if not draft:
                draft = "Não consegui gerar resposta agora. Tente reformular a pergunta."
        except Exception as e:
            log.exception("Falha no draft")
            draft = f"Erro na geração: {e}"

        # Crítica
        return self.llm.refine(pergunta, draft)

    def answer_stream(self, q:str):
        """Gera SSE em modo streaming (Ollama nativo; Gemini -> chunk local)."""
        yield "event: start\ndata: {}\n\n"
        try:
            if self.cfg.LLM_PROVIDER == "ollama":
                payload = {
                    "model": self.cfg.OLLAMA_MODEL,
                    "prompt": f"<<SYS>>\n{self.cfg.BOT_PERSONA}\n<</SYS>>\n\n{q}",
                    "stream": True,
                    "options": {"temperature": float(self.cfg.gen_cfg()["temperature"])}
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
                text = self.llm.answer(q) or ""
                for part in [text[i:i+220] for i in range(0, len(text), 220)]:
                    yield f"data: {json.dumps({'delta': part})}\n\n"
                yield "event: end\ndata: {}\n\n"
        except Exception as e:
            yield f"event: error\ndata: {str(e)}\n\n"

# =============================== App Factory =================================
class OrionAIApp:
    """Fábrica que monta Flask e pluga os controllers."""
    def __init__(self):
        self.cfg = AppConfig()
        self.llm = LLMClient(self.cfg)
        self.rag = RAGEngine()
        self.tools = Tools(self.cfg)
        self.news = NewsService(self.cfg)
        self.analytics = AnalyticsService(self.cfg, self.llm)
        self.chat = ChatService(self.cfg, self.llm, self.rag, self.tools)
        self.app = Flask(__name__)
        self._routes()

    # --------------------------- Controllers / Rotas -------------------------
    def _routes(self):
        app = self.app
        cfg = self.cfg
        chat = self.chat
        news = self.news
        analytics = self.analytics

        @app.get("/")
        def index():
            return render_template("index.html")

        @app.post("/responder")
        def responder():
            dados = request.get_json(force=True) or {}
            pergunta = (dados.get("mensagem") or "").strip()
            if not pergunta:
                return jsonify({"resposta": "Manda a pergunta"}), 400
            final = chat.answer_sync(pergunta)
            return jsonify({"resposta": final}), 200

        @app.get("/responder_stream")
        def responder_stream():
            q = (request.args.get("q") or "").strip()
            if not q:
                return Response("event: error\ndata: Falta parâmetro q\n\n", mimetype="text/event-stream")
            return Response(stream_with_context(chat.answer_stream(q)), mimetype="text/event-stream")

        @app.get("/health")
        def health():
            return jsonify({
                "provider": cfg.LLM_PROVIDER,
                "ollama_model": cfg.OLLAMA_MODEL if cfg.LLM_PROVIDER=="ollama" else None,
                "ok": True if (cfg.LLM_PROVIDER=="ollama" or cfg.GEMINI_API_KEY) else False,
                "model": cfg.GEMINI_MODEL if cfg.LLM_PROVIDER=="gemini" else None,
                "api_key_masked": _mask(cfg.GEMINI_API_KEY) if cfg.LLM_PROVIDER=="gemini" else None,
                "gen_cfg": cfg.gen_cfg(),
                "rag": {
                    "embeddings": bool(self.rag.embed_on),
                    "docs": len(self.rag.docs)
                },
                "persona_preview": cfg.BOT_PERSONA[:140] + ("…" if len(cfg.BOT_PERSONA) > 140 else "")
            })

        @app.post("/prever")
        def prever():
            dados = request.get_json(force=True) or {}
            tema = (dados.get("tema") or "").strip()
            dias = dados.get("dias", 7)
            ano_ini = int(dados.get("anos_de", 0) or 0)
            ano_fim = int(dados.get("anos_ate", 0) or 0)

            if not tema:
                return jsonify({"erro": "Informe 'tema' no body JSON."}), 400

            try:
                dias = int(dias)
            except Exception:
                dias = 7
            dias = max(1, min(180, dias))

            artigos = news.fetch(tema, max_items=cfg.RSS_MAX_ITEMS)
            if ano_ini and ano_fim and ano_ini <= ano_fim:
                artigos = [a for a in artigos if ano_ini <= a["dt"].year <= ano_fim]

            result = analytics.analyze(tema, artigos, dias)

            artigos_out = []
            for a in sorted(artigos, key=lambda x: x["dt"], reverse=True)[:12]:
                artigos_out.append({
                    "titulo": a["titulo"],
                    "url": a["url"],
                    "data_iso": a["dt"].astimezone(timezone.utc).isoformat(),
                    "fonte": a["url"].split('/')[2] if '//' in a["url"] else ''
                })

            resp = {
                "previsao": result["resumo"],
                "series": result["series"],
                "trend": result["trend"],
                "artigos": artigos_out,
                "hipoteses": result["hipoteses"],
                "analytics": result["analytics"],
                "meta": {
                    "tema": tema,
                    "dias": dias,
                    "filtrado_por_ano": bool(ano_ini and ano_fim and ano_ini <= ano_fim),
                    "anos_de": ano_ini or None,
                    "anos_ate": ano_fim or None,
                    "series_total": len(result["series"]),
                    "artigos_total": len(artigos_out)
                }
            }

            log.info("[/prever] tema='%s' dias=%s -> pontos=%s artigos=%s trend=%s%% (Δ=%s) sent=%.3f spikes=%s",
                     tema, dias, len(result["series"]), len(artigos_out),
                     resp["trend"]["pct"], resp["trend"]["last_delta"],
                     resp["analytics"]["sentiment_mean"], len(resp["analytics"]["spikes"]))

            return jsonify(resp), 200

    # --------------------------- Run ----------------------------------------
    def run(self):
        self.app.run(host="127.0.0.1", port=self.cfg.PORT, debug=self.cfg.FLASK_DEBUG, use_reloader=False)

# =============================== Main ========================================
if __name__ == "__main__":
    OrionAIApp().run()
