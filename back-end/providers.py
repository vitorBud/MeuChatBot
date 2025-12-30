#!/usr/bin/env python3
"""
OrionAI — Enhanced LLM Providers Module
- Robust error handling with retry mechanisms
- Comprehensive logging and monitoring
- Connection pooling and performance optimizations
- Support for multiple API providers
- Advanced configuration management
"""

import os
import requests
import json
import time
import logging
from typing import Optional, Dict, Any
from urllib.parse import urljoin
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
import random
from dotenv import load_dotenv
load_dotenv()



# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("orionai.providers")

# Global session with connection pooling and retry strategy
_session = None

def get_session() -> requests.Session:
    """Get or create a session with connection pooling and retry strategy."""
    global _session
    if _session is None:
        _session = requests.Session()
        
        # Retry strategy for transient failures
        retry_strategy = Retry(
            total=3,
            status_forcelist=[429, 500, 502, 503, 504],
            allowed_methods=["HEAD", "GET", "POST", "PUT", "DELETE", "OPTIONS", "TRACE"],
            backoff_factor=1
        )

        
        # Mount adapters for HTTP and HTTPS
        adapter = HTTPAdapter(max_retries=retry_strategy, pool_connections=10, pool_maxsize=20)
        _session.mount("http://", adapter)
        _session.mount("https://", adapter)
        
        # Common headers
        _session.headers.update({
            "User-Agent": "OrionAI/1.0",
            "Accept": "application/json",
            "Accept-Encoding": "gzip, deflate"
        })
    
    return _session

class LLMConfig:
    """Configuration manager for LLM providers."""
    
    @staticmethod
    def get_provider() -> str:
        return os.getenv("LLM_PROVIDER", "gemini").lower()
    
    @staticmethod
    def get_gemini_config() -> Dict[str, Any]:
        return {
            "base_url": os.getenv("GEMINI_API_BASE", "https://generativelanguage.googleapis.com"),
            "model": os.getenv("GEMINI_MODEL", "gemini-2.5-flash"),
            "api_key": os.getenv("GEMINI_API_KEY", "").strip(),
            "timeout": (5, 30)
        }
    
    @staticmethod
    def get_ollama_config() -> Dict[str, Any]:
        return {
            "base_url": os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434"),
            "model": os.getenv("OLLAMA_MODEL", "phi4"),
            "timeout": (10, 120)
        }
    
    @staticmethod
    def validate_config() -> bool:
        """Validate that required environment variables are set."""
        provider = LLMConfig.get_provider()
        
        if provider == "gemini":
            config = LLMConfig.get_gemini_config()
            if not config["api_key"]:
                logger.error("GEMINI_API_KEY is required but not set")
                return False
                
        elif provider == "ollama":
            config = LLMConfig.get_ollama_config()
            # Test Ollama connection
            try:
                session = get_session()
                response = session.get(f"{config['base_url']}/api/tags", timeout=5)
                if response.status_code != 200:
                    logger.error(f"Ollama server not responding: {response.status_code}")
                    return False
            except Exception as e:
                logger.error(f"Ollama server connection failed: {e}")
                return False
                
        else:
            logger.error(f"Unsupported LLM provider: {provider}")
            return False
            
        logger.info(f"LLM provider configured: {provider}")
        return True

class RateLimiter:
    """Simple rate limiting to avoid API quota issues."""
    
    def __init__(self, calls_per_minute: int = 60):
        self.calls_per_minute = calls_per_minute
        self.calls = []
    
    def wait_if_needed(self):
        """Wait if we're approaching the rate limit."""
        now = time.time()
        one_minute_ago = now - 60
        
        # Remove calls older than 1 minute
        self.calls = [call_time for call_time in self.calls if call_time > one_minute_ago]
        
        if len(self.calls) >= self.calls_per_minute:
            sleep_time = 60 - (now - self.calls[0])
            if sleep_time > 0:
                logger.warning(f"Rate limit approaching, sleeping for {sleep_time:.2f}s")
                time.sleep(sleep_time)
        
        self.calls.append(now)

# Global rate limiters
_gemini_limiter = RateLimiter(calls_per_minute=50)  # Gemini free tier limit
_ollama_limiter = RateLimiter(calls_per_minute=1000)  # Ollama is local, be generous

def call_gemini(prompt: str, system: str, gen_cfg: dict) -> str:
    """
    Enhanced Gemini API caller with robust error handling and monitoring.
    
    Args:
        prompt: User prompt/message
        system: System instructions/persona
        gen_cfg: Generation configuration (temperature, top_p, etc.)
    
    Returns:
        Generated text response
    
    Raises:
        Exception: If API call fails after retries
    """
    _gemini_limiter.wait_if_needed()
    
    config = LLMConfig.get_gemini_config()
    url = f"{config['base_url']}/v1beta/models/{config['model']}:generateContent"
    
    headers = {
        "Content-Type": "application/json",
        "x-goog-api-key": config["api_key"]
    }
    
    body = {
        "systemInstruction": {
            "role": "system",
            "parts": [{"text": system}]
        },
        "contents": [{
            "role": "user", 
            "parts": [{"text": prompt}]
        }],
        "generationConfig": {
            **gen_cfg,
            "stopSequences": ["</response>", "<|endoftext|>"]
        },
        "safetySettings": [
            {
                "category": "HARM_CATEGORY_HARASSMENT",
                "threshold": "BLOCK_MEDIUM_AND_ABOVE"
            },
            {
                "category": "HARM_CATEGORY_HATE_SPEECH", 
                "threshold": "BLOCK_MEDIUM_AND_ABOVE"
            }
        ]
    }
    
    session = get_session()
    start_time = time.time()
    
    try:
        logger.info(f"Calling Gemini API with {len(prompt)} chars prompt")
        
        response = session.post(
            url, 
            headers=headers, 
            json=body, 
            timeout=config["timeout"]
        )
        response.raise_for_status()
        
        data = response.json()
        elapsed = time.time() - start_time
        
        # Enhanced response parsing
        out = []
        for candidate in data.get("candidates", []):
            if "content" in candidate and "parts" in candidate["content"]:
                for part in candidate["content"]["parts"]:
                    text = part.get("text", "").strip()
                    if text:
                        out.append(text)
        
        result = "\n".join(out).strip()
        
        # Log usage metrics
        prompt_tokens = data.get("usageMetadata", {}).get("promptTokenCount", 0)
        candidates_tokens = data.get("usageMetadata", {}).get("candidatesTokenCount", 0)
        
        logger.info(
            f"Gemini response: {len(result)} chars, "
            f"{prompt_tokens} prompt tokens, "
            f"{candidates_tokens} output tokens, "
            f"{elapsed:.2f}s elapsed"
        )
        
        if not result:
            logger.warning("Gemini returned empty response")
            return "Desculpe, não consegui gerar uma resposta. Tente reformular sua pergunta."
        
        return result
        
    except requests.exceptions.Timeout:
        logger.error("Gemini API timeout")
        raise Exception("Tempo limite excedido ao acessar o Gemini. Tente novamente.")
        
    except requests.exceptions.RequestException as e:
        logger.error(f"Gemini API request failed: {e}")
        
        # Provide user-friendly error messages
        if e.response is not None:
            status_code = e.response.status_code
            if status_code == 429:
                raise Exception("Limite de taxa excedido. Aguarde um momento antes de tentar novamente.")
            elif status_code == 401:
                raise Exception("Chave de API inválida. Verifique suas configurações.")
            elif status_code >= 500:
                raise Exception("Serviço temporariamente indisponível. Tente novamente em alguns instantes.")
        
        raise Exception(f"Erro de comunicação com o Gemini: {str(e)}")
        
    except (KeyError, ValueError) as e:
        logger.error(f"Gemini response parsing failed: {e}")
        raise Exception("Erro ao processar resposta do Gemini.")

def call_ollama(prompt: str, system: str, gen_cfg: dict) -> str:
    """
    Enhanced Ollama API caller with better error handling and monitoring.
    
    Args:
        prompt: User prompt/message  
        system: System instructions/persona
        gen_cfg: Generation configuration
    
    Returns:
        Generated text response
    
    Raises:
        Exception: If API call fails
    """
    _ollama_limiter.wait_if_needed()
    
    config = LLMConfig.get_ollama_config()
    url = f"{config['base_url']}/api/generate"
    
    # Enhanced prompt formatting for better model performance
    formatted_prompt = f"<|system|>\n{system}\n<|end|>\n<|user|>\n{prompt}\n<|end|>\n<|assistant|>\n"
    
    payload = {
        "model": config["model"],
        "prompt": formatted_prompt,
        "options": {
            "temperature": float(gen_cfg.get("temperature", 0.5)),
            "top_p": float(gen_cfg.get("topP", 0.9)),
            "top_k": int(gen_cfg.get("topK", 40)),
            "num_predict": int(gen_cfg.get("maxOutputTokens", 700)),
            "stop": ["</response>", "<|end|>", "\n\n\n"]
        },
        "stream": False,
        "raw": True  # Bypass some Ollama templating for more control
    }
    
    session = get_session()
    start_time = time.time()
    
    try:
        logger.info(f"Calling Ollama API with model {config['model']}")
        
        response = session.post(
            url,
            json=payload,
            timeout=config["timeout"]
        )
        response.raise_for_status()
        
        data = response.json()
        elapsed = time.time() - start_time
        
        result = (data.get("response") or "").strip()
        
        # Log performance metrics
        eval_count = data.get("eval_count", 0)
        total_duration = data.get("total_duration", 0) / 1e9  # Convert to seconds
        
        logger.info(
            f"Ollama response: {len(result)} chars, "
            f"{eval_count} tokens evaluated, "
            f"{total_duration:.2f}s inference, "
            f"{elapsed:.2f}s total"
        )
        
        if not result:
            logger.warning("Ollama returned empty response")
            return "Não consegui gerar uma resposta. O modelo pode estar sobrecarregado."
        
        return result
        
    except requests.exceptions.ConnectionError:
        logger.error("Ollama server not reachable")
        raise Exception("Servidor Ollama não está respondendo. Verifique se o Ollama está rodando.")
        
    except requests.exceptions.Timeout:
        logger.error("Ollama API timeout")
        raise Exception("Tempo limite excedido. O modelo pode estar processando uma solicitação muito longa.")
        
    except requests.exceptions.RequestException as e:
        logger.error(f"Ollama API request failed: {e}")
        
        if e.response is not None:
            status_code = e.response.status_code
            if status_code == 404:
                raise Exception(f"Modelo '{config['model']}' não encontrado. Execute: ollama pull {config['model']}")
        
        raise Exception(f"Erro de comunicação com o Ollama: {str(e)}")

def call_llm(prompt: str, system: str, gen_cfg: dict) -> str:
    """
    Unified LLM caller with comprehensive error handling and fallback.
    
    Args:
        prompt: User prompt/message
        system: System instructions/persona  
        gen_cfg: Generation configuration
    
    Returns:
        Generated text response
    
    Raises:
        Exception: If all providers fail
    """
    if not prompt or not prompt.strip():
        raise ValueError("Prompt cannot be empty")
    
    provider = LLMConfig.get_provider()
    max_retries = 2
    
    for attempt in range(max_retries + 1):
        try:
            logger.info(f"LLM call attempt {attempt + 1} with provider: {provider}")
            
            if provider == "ollama":
                return call_ollama(prompt, system, gen_cfg)
            else:  # Default to Gemini
                return call_gemini(prompt, system, gen_cfg)
                
        except Exception as e:
            logger.warning(f"Attempt {attempt + 1} failed: {e}")
            
            if attempt < max_retries:
                # Exponential backoff
                wait_time = (2 ** attempt) + (random.random() * 0.1)
                logger.info(f"Retrying in {wait_time:.2f}s...")
                time.sleep(wait_time)
            else:
                logger.error(f"All {max_retries + 1} attempts failed")
                raise
    
    # This should never be reached, but just in case
    raise Exception("Falha inesperada ao chamar o provedor de LLM")

# Health check function
def health_check() -> Dict[str, Any]:
    """Check the health status of configured LLM provider."""
    provider = LLMConfig.get_provider()
    status = {
        "provider": provider,
        "status": "unknown",
        "timestamp": time.time(),
        "details": {}
    }
    
    try:
        if provider == "gemini":
            config = LLMConfig.get_gemini_config()
            if not config["api_key"]:
                status.update({"status": "error", "details": {"error": "API key missing"}})
            else:
                status.update({"status": "configured", "details": {"model": config["model"]}})
                
        elif provider == "ollama":
            config = LLMConfig.get_ollama_config()
            session = get_session()
            response = session.get(f"{config['base_url']}/api/tags", timeout=5)
            if response.status_code == 200:
                models = response.json().get("models", [])
                status.update({
                    "status": "healthy", 
                    "details": {
                        "model": config["model"],
                        "available_models": [m["name"] for m in models]
                    }
                })
            else:
                status.update({"status": "error", "details": {"error": "Ollama not responding"}})
                
    except Exception as e:
        status.update({"status": "error", "details": {"error": str(e)}})
    
    return status

# Initialize configuration validation on import
if LLMConfig.validate_config():
    logger.info("LLM providers module initialized successfully")
else:
    logger.warning("LLM providers module initialized with configuration issues")