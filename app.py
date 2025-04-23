import requests
from flask import Flask, render_template, request, jsonify

app = Flask(__name__)


OPENROUTER_API_KEY = "Insira sua key"


API_URL = "https://openrouter.ai/api/v1/chat/completions"

HEADERS = {
    "Authorization": f"Bearer {OPENROUTER_API_KEY}",
    "Content-Type": "application/json",
}

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/responder", methods=["POST"])
def responder():
    dados = request.get_json()
    pergunta = dados.get("mensagem", "")

    try:
        payload = {
    "model": "mistralai/mistral-7b-instruct",
    "messages": [
        {"role": "system", "content": "Você é um assistente educado e direto. Responda apenas à última pergunta do usuário."},
        {"role": "user", "content": pergunta}
    ]
}



        response = requests.post(API_URL, headers=HEADERS, json=payload)

        if response.status_code == 200:
            resposta = response.json()["choices"][0]["message"]["content"]
        else:
            resposta = f"Erro {response.status_code}: {response.text}"

    except Exception as e:
        resposta = f"Ocorreu um erro: {str(e)}"

    return jsonify({"resposta": resposta})

if __name__ == "__main__":
    app.run(debug=True)
