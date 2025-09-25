import os
import sys
import json
import logging
import requests
from flask import Flask, render_template, request, jsonify

logging.basicConfig(level=logging.INFO, stream=sys.stdout)

app = Flask(__name__)



MODEL_NAME = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")


if not GEMINI_API_KEY:
    logging.warning("GEMINI_API_KEY não encontrada no ambiente. Defina antes de rodar.")

API_URL = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
HEADERS = {
    "Content-Type": "application/json",
    "x-goog-api-key": "GEMINI-API-KEY" #coloque sua chave aqui...
}


BOT_PERSONA = (
    "Você é um agente de conversação futurista e inovador, com clareza técnica e visão prática. "
    "Explique com simplicidade, encoraje e traga analogias quando fizer sentido. "
    "Pense criativamente, mas mantenha o pé no chão."
)

def _first_text_from_response(data: dict) -> str:
    """Tenta extrair o primeiro texto útil de diferentes formatos de resposta do Gemini."""



    for cand in data.get("candidates", []):
        content = cand.get("content", {}) or {}
        parts = content.get("parts", []) or []
        for p in parts:
            
            t = p.get("text")
            if t:
                return t.strip()
            
    return ""

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/responder", methods=["POST"])
def responder():
    dados = request.get_json(force=True) or {}
    pergunta = (dados.get("mensagem") or "").strip()
    if not pergunta:
        return jsonify({"resposta": "Manda a pergunta"})

    payload = {
        

        "systemInstruction": {
            "role": "system",
            "parts": [{"text": BOT_PERSONA}]
        },
        "contents": [
            {
                "role": "user",
                "parts": [{"text": pergunta}]
            }
        ],
        "generationConfig": {
            "temperature": 0.7,
            "topP": 0.9,
            "maxOutputTokens": 2048
        }
        
    }

    try:
        resp = requests.post(API_URL, headers=HEADERS, json=payload, timeout=30)
        if resp.status_code != 200:
           

            return jsonify({"resposta": f"Erro {resp.status_code}: {resp.text}"})

        data = resp.json()

        
        pf = data.get("promptFeedback") or {}
        if pf.get("blockReason"):
            reason = pf.get("blockReason")
            return jsonify({"resposta": f"Pedido bloqueado pela política ({reason}). Tenta reformular mais neutro."})

    
        resposta = _first_text_from_response(data)

        if not resposta:
            

            logging.warning("Sem texto na resposta. Payload retornado:\n%s", json.dumps(data, ensure_ascii=False, indent=2))
            return jsonify({"resposta": "Tenta reformular ou verifique os logs do servidor para detalhes."})

        return jsonify({"resposta": resposta})

    except Exception as e:
        logging.exception("Erro ao chamar Gemini")
        return jsonify({"resposta": f"Ocorreu um erro: {e}"})


if __name__ == "__main__":
    app.run(debug=True)
