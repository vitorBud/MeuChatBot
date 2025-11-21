# app_oop.py
# OrionAI (POO Edition) — Flask + RAG + RSS + Trend Analytics + FUTURE PREDICTIONS
# Personalidade: direto, pragmático e levemente espirituoso.

import os, sys, json, logging, time, math, statistics, re, requests
from pathlib import Path
from urllib.parse import quote_plus, urlparse
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from functools import lru_cache
import numpy as np
import random
from datetime import datetime, timedelta, timezone


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

# =============================== PREDICTION ENGINE ===========================
class PredictionEngine:
    """Motor de previsões futuras baseado em análise de conteúdo de notícias"""
    
    def __init__(self, llm: LLMClient):
        self.llm = llm
    
    def analyze_news_content(self, tema: str, artigos: list, series: list):
        """Analisa o conteúdo das notícias para prever tendências reais"""
        
        if not artigos:
            return {
                "previsao_texto": "Não há notícias suficientes para análise.",
                "confianca": 0.1,
                "sentimento_medio": 0,
                "temas_detectados": [],
                "total_noticias_analisadas": 0
            }
        
        # Analisa sentimentos e temas das manchetes
        sentimentos = self._analyze_sentiments([a["titulo"] for a in artigos])
        temas_chave = self._extract_key_themes([a["titulo"] for a in artigos])
        
        # Gera previsão baseada no conteúdo
        previsao_texto = self._generate_content_based_prediction(tema, artigos, sentimentos, temas_chave)
        
        # Calcula confiança baseada na qualidade da análise
        confianca = self._calculate_content_confidence(artigos, sentimentos)
        
        return {
            "previsao_texto": previsao_texto,
            "confianca": confianca,
            "sentimento_medio": statistics.mean(sentimentos) if sentimentos else 0,
            "temas_detectados": temas_chave[:5],
            "total_noticias_analisadas": len(artigos)
        }
    
    def _analyze_sentiments(self, titulos: list):
        """Analisa sentimento das manchetes"""
        try:
            from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
            analyzer = SentimentIntensityAnalyzer()
            scores = [analyzer.polarity_scores(titulo)["compound"] for titulo in titulos]
            return scores
        except:
            return [0.0] * len(titulos)
    
    def _extract_key_themes(self, titulos: list):
        """Extrai temas principais das manchetes"""
        # Análise expandida de palavras-chave para diversos temas
        palavras_chave = {
            # Economia/Finanças
            "crescimento": ["cresce", "aumenta", "expande", "alta", "sobe", "crescimento", "avanço", "expansão"],
            "queda": ["cai", "diminui", "baixa", "queda", "reduz", "recua", "encolhe", "retração"],
            "crise": ["crise", "recessão", "colapso", "emergência", "problema", "dificuldade", "instabilidade"],
            "estabilidade": ["estável", "mantém", "consolida", "equilíbrio", "normalidade", "controle"],
            
            # Política/Governo
            "governo": ["governo", "presidente", "ministro", "prefeito", "gestão", "administração", "executivo"],
            "política": ["político", "eleição", "partido", "votação", "legislativo", "congresso", "senado"],
            "medidas": ["medida", "decreto", "lei", "projeto", "programa", "iniciativa", "política pública"],
            
            # Segurança
            "violência": ["violência", "crime", "assalto", "homicídio", "tiroteio", "assassinato", "latrocínio"],
            "segurança": ["segurança", "polícia", "investigação", "prisão", "operacao", "patrulha", "combate"],
            "paz": ["paz", "tranquilidade", "harmonia", "controle", "melhora", "redução", "diminuição"],
            
            # Saúde
            "saúde": ["saúde", "hospital", "médico", "doença", "epidemia", "vacina", "tratamento", "sanitário"],
            "bem-estar": ["bem-estar", "qualidade", "vida", "saudável", "prevenção", "cuidados", "assistência"],
            
            # Educação
            "educação": ["educação", "escola", "universidade", "professor", "ensino", "aprendizado", "educacional"],
            "conhecimento": ["conhecimento", "pesquisa", "ciência", "tecnologia", "inovação", "descoberta"],
            
            # Meio Ambiente
            "meio ambiente": ["meio ambiente", "natureza", "sustentabilidade", "clima", "poluição", "ambiental"],
            "conservação": ["conservação", "preservação", "proteção", "recursos", "ecologia", "biodiversidade"],
            
            # Tecnologia
            "tecnologia": ["tecnologia", "digital", "internet", "aplicativo", "software", "inovação", "digitalização"],
            "progresso": ["progresso", "desenvolvimento", "avanço", "modernização", "futuro", "evolução"],
            
            # Social
            "social": ["social", "comunidade", "população", "sociedade", "público", "coletivo"],
            "desigualdade": ["desigualdade", "pobreza", "fome", "miséria", "exclusão", "vulnerabilidade"]
        }
        
        temas = {}
        for titulo in titulos:
            titulo_lower = titulo.lower()
            for tema, palavras in palavras_chave.items():
                if any(palavra in titulo_lower for palavra in palavras):
                    temas[tema] = temas.get(tema, 0) + 1
        
        return sorted(temas.items(), key=lambda x: x[1], reverse=True)
    
    def _generate_content_based_prediction(self, tema: str, artigos: list, sentimentos: list, temas_chave: list):
        """Gera previsão baseada no conteúdo analisado"""
        
        sentimento_medio = statistics.mean(sentimentos) if sentimentos else 0
        temas_principais = [tema for tema, count in temas_chave[:3]]
        
        # Detecta o tipo de tema automaticamente
        tipo_tema = self._detect_topic_type(tema, temas_principais)
        
        # 🔥 NOVO: Gera previsão de curto E longo prazo
        previsao_curto_prazo = self._generate_short_term_prediction(tema, sentimento_medio, temas_principais, tipo_tema)
        previsao_longo_prazo = self._generate_long_term_prediction(tema, sentimento_medio, temas_principais, tipo_tema, len(artigos))
        
        # Combina ambas as previsões
        previsao_completa = (
            f"{previsao_curto_prazo}\n\n"
            f"**🔮 Perspectiva Anual:** {previsao_longo_prazo}"
        )
        
        return previsao_completa
    
    def _generate_short_term_prediction(self, tema: str, sentimento_medio: float, temas_principais: list, tipo_tema: str):
        """Previsão de curto prazo (semanas/meses)"""
        
        # Mapeamento de tendências por tipo de tema
        trend_templates = {
            "economia": {
                "positivo": ["crescimento econômico", "expansão do mercado", "melhora nos indicadores"],
                "negativo": ["desaceleração econômica", "crise financeira", "queda nos mercados"],
                "neutro": ["estabilidade econômica", "manutenção dos indicadores"]
            },
            "segurança": {
                "positivo": ["melhora na segurança", "redução da criminalidade", "controle da violência"],
                "negativo": ["aumento da criminalidade", "crise de segurança", "piora na violência"],
                "neutro": ["situação estável", "manutenção dos índices"]
            },
            "política": {
                "positivo": ["estabilidade política", "avanços governamentais", "consolidação democrática"],
                "negativo": ["instabilidade política", "crise governamental", "conflitos partidários"],
                "neutro": ["cenário político estável", "continuidade administrativa"]
            },
            "saúde": {
                "positivo": ["melhora na saúde pública", "avanços médicos", "controle de doenças"],
                "negativo": ["piora na saúde", "crise sanitária", "aumento de doenças"],
                "neutro": ["situação sanitária estável", "manutenção dos serviços"]
            },
            "educação": {
                "positivo": ["avanços educacional", "melhora no ensino", "investimentos em educação"],
                "negativo": ["retrocesso educacional", "crise no ensino", "cortes na educação"],
                "neutro": ["estabilidade educacional", "continuidade dos programas"]
            },
            "geral": {
                "positivo": ["melhora na situação", "avanços significativos", "progresso"],
                "negativo": ["piora na situação", "dificuldades crescentes", "retrocesso"],
                "neutro": ["manutenção do cenário", "estabilidade", "continuidade"]
            }
        }
        
        # Determina a direção baseada no sentimento e temas
        if sentimento_medio < -0.2:
            direcao = "negativo"
            intensidade = "significativa" if sentimento_medio < -0.4 else "moderada"
        elif sentimento_medio > 0.2:
            direcao = "positivo" 
            intensidade = "significativa" if sentimento_medio > 0.4 else "moderada"
        else:
            direcao = "neutro"
            intensidade = "estável"
        
        # Seleciona o template correto
        template = trend_templates.get(tipo_tema, trend_templates["geral"])
        tendencia_desc = template[direcao][0]  # Pega a primeira descrição
        
        # Lógica de intensidade
        if direcao == "negativo":
            if intensidade == "significativa":
                nivel_alerta = "🔴 ALTO"
                tom = "preocupante"
            else:
                nivel_alerta = "🟡 MODERADO"
                tom = "cauteloso"
        elif direcao == "positivo":
            if intensidade == "significativa":
                nivel_alerta = "🟢 MUITO POSITIVO"
                tom = "otimista"
            else:
                nivel_alerta = "🟢 POSITIVO" 
                tom = "favorável"
        else:
            nivel_alerta = "🔵 ESTÁVEL"
            tom = "equilibrado"
        
        # Gera a previsão de curto prazo
        previsao = (
            f"📊 **Previsão para '{tema}'**\n\n"
            f"**Tendência (Curto Prazo):** {tendencia_desc}\n"
            f"**Nível:** {nivel_alerta}\n"
            f"**Área:** {tipo_tema.upper()}\n"
            f"**Sentimento:** {sentimento_medio:.2f} ({tom})\n"
        )
        
        return previsao
    
    def _generate_long_term_prediction(self, tema: str, sentimento_medio: float, temas_principais: list, tipo_tema: str, total_noticias: int):
        """Gera previsão para os próximos 1-3 anos de forma dinâmica"""
        
        current_year = datetime.now(timezone.utc).year
        next_year = current_year + 1
        two_years = current_year + 2

        # Base de projeção baseada no sentimento e volume de notícias
        if sentimento_medio < -0.3:
            if total_noticias > 20:
                tendencia = "deterioração significativa"
                anos = f"{current_year}-{next_year}"
                certeza = "alta probabilidade"
            else:
                tendencia = "possível deterioração"
                anos = f"{current_year}-{two_years}"
                certeza = "moderada probabilidade"

        elif sentimento_medio < -0.1:
            tendencia = "estagnação ou leve deterioração"
            anos = f"{current_year}-{next_year}"
            certeza = "moderada probabilidade"

        elif sentimento_medio > 0.3:
            if total_noticias > 20:
                tendencia = "melhora significativa"
                anos = f"{current_year}-{next_year}"
                certeza = "alta probabilidade"
            else:
                tendencia = "progresso gradual"
                anos = f"{current_year}-{two_years}"
                certeza = "moderada probabilidade"

        elif sentimento_medio > 0.1:
            tendencia = "melhora moderada"
            anos = f"{current_year}-{next_year}"
            certeza = "moderada probabilidade"

        else:
            tendencia = "estabilidade com flutuações normais"
            anos = f"{current_year}-{next_year}"
            certeza = "probabilidade equilibrada"

    # (mantém o resto da função igual)

        
        # Contextualizar com o tipo de tema
        if tipo_tema == "economia":
            assunto = "os indicadores econômicos"
            detalhe = "com impacto no PIB, inflação e emprego"
        elif tipo_tema == "segurança":
            assunto = "os índices de criminalidade" 
            detalhe = "afetando a segurança pública"
        elif tipo_tema == "política":
            assunto = "o cenário político"
            detalhe = "influenciando políticas públicas"
        elif tipo_tema == "saúde":
            assunto = "o sistema de saúde"
            detalhe = "com reflexos na qualidade do atendimento"
        elif tipo_tema == "educação":
            assunto = "os indicadores educacionais"
            detalhe = "impactando a qualidade do ensino"
        else:
            assunto = "o cenário atual"
            detalhe = "com base nas tendências identificadas"
        
        return f"Prevejo que {assunto} mostrarão {tendencia} durante {anos}, com {certeza} {detalhe}."
    
    def _detect_topic_type(self, tema: str, temas_principais: list):
        """Detecta automaticamente o tipo de tema baseado no conteúdo"""
        tema_lower = tema.lower()
        
        # Mapeamento de tipos de tema
        topic_patterns = {
            "economia": ["economia", "mercado", "finanças", "dinheiro", "preço", "inflação", "dólar", "bolsa", "empregos", "investimento"],
            "segurança": ["criminalidade", "crime", "violência", "segurança", "assalto", "homicídio", "polícia", "violento", "roubo"],
            "política": ["política", "governo", "presidente", "eleição", "partido", "ministro", "congresso", "senado", "legislativo"],
            "saúde": ["saúde", "hospital", "doença", "médico", "epidemia", "vacina", "tratamento", "médico", "hospitalar"],
            "educação": ["educação", "escola", "universidade", "professor", "ensino", "aluno", "educacional", "aprendizado"],
            "tecnologia": ["tecnologia", "digital", "internet", "aplicativo", "software", "ciência", "inovação", "digital"],
            "meio ambiente": ["meio ambiente", "natureza", "clima", "sustentabilidade", "poluição", "ambiental", "ecologia"],
            "social": ["social", "pobreza", "desigualdade", "comunidade", "população", "sociedade", "comunitário"]
        }
        
        # Verifica o tema principal
        for tipo, palavras in topic_patterns.items():
            if any(palavra in tema_lower for palavra in palavras):
                return tipo
        
        # Se não detectou pelo tema, verifica pelos temas principais das notícias
        temas_str = " ".join(temas_principais).lower()
        for tipo, palavras in topic_patterns.items():
            if any(palavra in temas_str for palavra in palavras):
                return tipo
        
        return "geral"  # Tipo padrão
    
    def _calculate_content_confidence(self, artigos: list, sentimentos: list):
        """Calcula confiança baseada na qualidade da análise de conteúdo"""
        if len(artigos) < 3:
            return 0.3
        
        confianca = 0.5
        
        # Mais notícias = mais confiança
        if len(artigos) >= 15:
            confianca += 0.3
        elif len(artigos) >= 10:
            confianca += 0.2
        elif len(artigos) >= 5:
            confianca += 0.1
        
        # Sentimentos consistentes = mais confiança
        if sentimentos and len(sentimentos) > 1:
            variancia = statistics.variance(sentimentos)
            if variancia < 0.05:
                confianca += 0.2
            elif variancia < 0.1:
                confianca += 0.1
        
        return min(0.95, max(0.1, confianca))

    # 🔥 MÉTODOS PARA PREVISÃO DE VOLUME COM VARIAÇÃO REALISTA
    def generate_future_predictions(self, series, days_ahead=7):
        """Gera previsões para os próximos dias com variação realista"""
        if len(series) < 3:
            return {"previsoes": [], "confianca": 0}
        
        counts = [p["count"] for p in series]
        
        # 🔥 CORREÇÃO: Adicionar variação realista às previsões
        last_value = counts[-1] if counts else 0
        avg_value = sum(counts) / len(counts) if counts else 0
        
        # Criar previsões com base na tendência + variação aleatória
        predictions = []
        last_date = datetime.fromisoformat(series[-1]["date"]).date()
        
        for i in range(days_ahead):
            # Base + tendência + variação aleatória
            base_prediction = max(0, last_value + (avg_value - last_value) * 0.1 * (i + 1))
            random_variation = random.uniform(-0.2, 0.2) * avg_value
            final_prediction = max(0, base_prediction + random_variation)
            
            future_date = (last_date + timedelta(days=i+1)).isoformat()
            predictions.append({
                "date": future_date,
                "count": int(final_prediction),
                "is_prediction": True  # 🔥 Padronizar com o frontend
            })
        
        return {
            "previsoes": predictions,
            "confianca": min(0.8, len(series) / 10),  # Confiança baseada em dados
            "padroes_detectados": self.detect_patterns(series)
        }
    
    def detect_patterns(self, series):
        """Detecta padrões sazonais e cíclicos nos dados"""
        if len(series) < 7:
            return {"sazonalidade": None, "tendencia": "insuficiente"}
        
        counts = [p["count"] for p in series]
        
        # Análise de sazonalidade semanal
        weekly_pattern = self._analyze_weekly_pattern(series)
        
        # Tendência linear
        trend_slope = self._calculate_trend(counts)
        
        return {
            "sazonalidade": weekly_pattern,
            "tendencia": trend_slope,
            "volatilidade": statistics.stdev(counts) if len(counts) > 1 else 0
        }
    
    def _analyze_weekly_pattern(self, series):
        """Analisa padrão semanal (segunda a domingo)"""
        day_pattern = {i: [] for i in range(7)}  # 0=segunda, 6=domingo
        
        for point in series:
            try:
                date = datetime.fromisoformat(point["date"]).date()
                day_of_week = date.weekday()  # 0=segunda, 6=domingo
                day_pattern[day_of_week].append(point["count"])
            except:
                continue
        
        # Calcula médias por dia da semana
        weekly_avg = {}
        for day, values in day_pattern.items():
            if values:
                weekly_avg[day] = sum(values) / len(values)
        
        return weekly_avg
    
    def _calculate_trend(self, counts):
        """Calcula tendência usando regressão linear simples"""
        if len(counts) < 2:
            return 0
        
        x = list(range(len(counts)))
        y = counts
        
        n = len(x)
        sum_x = sum(x)
        sum_y = sum(y)
        sum_xy = sum(x[i] * y[i] for i in range(n))
        sum_xx = sum(x[i] * x[i] for i in range(n))
        
        slope = (n * sum_xy - sum_x * sum_y) / (n * sum_xx - sum_x * sum_x)
        return slope

# =============================== Analytics ===================================

class AnalyticsService:
    def __init__(self, cfg: AppConfig, llm: LLMClient):
        self.cfg = cfg
        self.llm = llm
        self.predictor = PredictionEngine(llm)

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

        # Regressão linear para medir tendência (slope)
        x = list(range(n))
        mean_x = sum(x) / n
        mean_y = sum(vals) / n
        num = sum((x[i] - mean_x) * (vals[i] - mean_y) for i in range(n))
        den = sum((x[i] - mean_x) ** 2 for i in range(n)) or 1
        slope = num / den

        # Em vez de usar o "first", usa a média dos dias anteriores
        last = vals[-1]
        prev = vals[:-1]
        prev_mean = sum(prev) / max(1, len(prev))

        if prev_mean > 0:
            pct = (last - prev_mean) / prev_mean * 100.0
        else:
            # Se não tinha nada antes e agora tem algo, considera alta forte
            pct = 0.0 if last == 0 else 100.0

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

        # 🔮 NOVO: ANÁLISE DE CONTEÚDO PARA PREVISÃO REAL
        analise_conteudo = self.predictor.analyze_news_content(tema, artigos, series)
        
        # Previsões futuras de volume (opcional)
        future_predictions = self.predictor.generate_future_predictions(series, days_ahead=7)

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
            },
            # 🔮 NOVO: DADOS DE PREVISÃO BASEADA EM CONTEÚDO
            "future_predictions": future_predictions,
            "content_analysis": analise_conteudo
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
                "previsao": result["content_analysis"]["previsao_texto"],  # 🔥 USA A NOVA PREVISÃO
                "series": result["series"],
                "trend": result["trend"],
                "artigos": artigos_out,
                "hipoteses": result["hipoteses"],
                "analytics": result["analytics"],
                "future_predictions": result["future_predictions"],
                "content_analysis": result["content_analysis"],  # 🔥 NOVO
                "meta": {
                    "tema": tema,
                    "dias": dias,
                    "filtrado_por_ano": bool(ano_ini and ano_fim and ano_ini <= ano_fim),
                    "anos_de": ano_ini or None,
                    "anos_ate": ano_fim or None,
                    "series_total": len(result["series"]),
                    "artigos_total": len(artigos_out),
                    "previsao_confianca": result["content_analysis"]["confianca"],  # 🔥 CONFIANÇA REAL
                    "dias_previsao": 7
                }
            }

            log.info("[/prever] tema='%s' dias=%s -> pontos=%s artigos=%s trend=%s%% (Δ=%s) sent=%.3f spikes=%s previsao_conf=%.2f",
                     tema, dias, len(result["series"]), len(artigos_out),
                     resp["trend"]["pct"], resp["trend"]["last_delta"],
                     resp["analytics"]["sentiment_mean"], len(resp["analytics"]["spikes"]),
                     resp["future_predictions"]["confianca"])

            return jsonify(resp), 200

    # --------------------------- Run ----------------------------------------
    def run(self):
        self.app.run(host="127.0.0.1", port=self.cfg.PORT, debug=self.cfg.FLASK_DEBUG, use_reloader=False)

# =============================== Main ========================================
if __name__ == "__main__":
    OrionAIApp().run()