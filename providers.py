# providers.py
import os, requests, json, time

def call_gemini(prompt: str, system: str, gen_cfg: dict):
    base = os.getenv("GEMINI_API_BASE", "https://generativelanguage.googleapis.com")
    model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
    url = f"{base}/v1beta/models/{model}:generateContent"
    headers = {"Content-Type":"application/json","x-goog-api-key": os.getenv("GEMINI_API_KEY","")}
    body = {
        "systemInstruction": {"role":"system","parts":[{"text": system}]},
        "contents":[{"role":"user","parts":[{"text": prompt}]}],
        "generationConfig": gen_cfg,
    }
    r = requests.post(url, headers=headers, json=body, timeout=(5,30))
    r.raise_for_status()
    data = r.json()
    out=[]
    for c in data.get("candidates",[]):
        for p in (c.get("content",{}).get("parts") or []):
            t=p.get("text")
            if t: out.append(t)
    return "\n".join(out).strip()

def call_ollama(prompt: str, system: str, gen_cfg: dict):
    # Requer: ollama rodando localmente (gratis). Ex.: `ollama serve`
    # e um modelo leve: `ollama pull phi4` (ou llama3.2:3b, qwen2.5:3b…)
    model = os.getenv("OLLAMA_MODEL", "phi4")
    temperature = float(gen_cfg.get("temperature", 0.5))
    payload = {
        "model": model,
        "prompt": f"<<SYS>>\n{system}\n<</SYS>>\n\n{prompt}",
        "options": {"temperature": temperature},
        "stream": False
    }
    r = requests.post("http://127.0.0.1:11434/api/generate", json=payload, timeout=(10,120))
    r.raise_for_status()
    data = r.json()
    return (data.get("response") or "").strip()

def call_llm(prompt: str, system: str, gen_cfg: dict):
    prov = os.getenv("LLM_PROVIDER", "gemini").lower()
    if prov == "ollama":
        return call_ollama(prompt, system, gen_cfg)
    return call_gemini(prompt, system, gen_cfg)
