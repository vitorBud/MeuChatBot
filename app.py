import os
import requests
from flask import Flask, render_template, request, jsonify

app = Flask(__name__)

GEMINI_API_KEY = "AIzaSyAutnPkvIPJ4acSy3-4ShA-p_LaIWZvjVs" 

MODEL_NAME = "gemini-2.5-flash"
API_URL = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=AIzaSyAutnPkvIPJ4acSy3-4ShA-p_LaIWZvjVs"

HEADERS = {"Content-Type": "application/json"}


BOT_PERSONA = (
    "Você é um agente de conversação futurista e inovador, que mistura a clareza da tecnologia "
    "com a inspiração de um mentor visionário. Sua missão é transformar qualquer dúvida em um "
    "insight criativo: traga ideias novas, conecte diferentes áreas do conhecimento e estimule "
    "o usuário a pensar além do óbvio. Responda de forma encorajadora, usando metáforas quando "
    "couber, como se estivesse mostrando caminhos ocultos para o futuro. "
    "Se o tema for técnico, explique com simplicidade, mas sempre dando um toque criativo."
)

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/responder", methods=["POST"])
def responder():
    dados = request.get_json(force=True)
    pergunta = (dados.get("mensagem") or "").strip()
    if not pergunta:
        return jsonify({"resposta": "Manda a pergunta"})

    payload = {
        "contents": [
            {"role": "user", "parts": [{"text": BOT_PERSONA}]},
            {"role": "user", "parts": [{"text": pergunta}]}
        ],
        "generationConfig": {
            "temperature": 0.7,
            "topP": 0.9,
            "maxOutputTokens": 512
        }
    }

    try:
        resp = requests.post(API_URL, headers=HEADERS, json=payload, timeout=30)
        
        if resp.status_code != 200:
            return jsonify({"resposta": f"Erro {resp.status_code}: {resp.text}"})


        data = resp.json()

        
        pf = data.get("promptFeedback", {})
        if pf.get("blockReason"):
            reason = pf.get("blockReason")
            return jsonify({"resposta": f"Pedido bloqueado pela política ({reason}). Tenta reformular mais neutro"})

        

        texto_parts = []
        for cand in data.get("candidates", []):
            
            if cand.get("finishReason") in ("SAFETY", "RECITATION", "OTHER"):
                sr = cand.get("safetyRatings", [])
                return jsonify({"resposta": f"Resposta bloqueada por segurança ({cand.get('finishReason')}). "
                                            f"Tenta pedir de outro jeito. Detalhes: {sr}"})
            content = cand.get("content", {})
            for part in content.get("parts", []):
                
                if "text" in part and part["text"]:
                    texto_parts.append(part["text"])

        resposta = "\n".join(texto_parts).strip()

        if not resposta:
            
            print("DEBUG GEMINI RAW:", data)
            resposta = "Sem texto na resposta do modelo (pode ter sido bloqueio ou retorno sem 'text'). Tenta reformular"

        return jsonify({"resposta": resposta})

    except Exception as e:
        return jsonify({"resposta": f"Ocorreu um erro: {e}"})
