const chat = document.getElementById('chat');
const formulario = document.getElementById('formulario');
const mensagemInput = document.getElementById('mensagem');

function adicionarMensagem(texto, classe) {
  const msg = document.createElement('div');
  msg.classList.add('mensagem', classe);
  msg.textContent = texto;
  chat.appendChild(msg);
  chat.scrollTop = chat.scrollHeight;
}

formulario.addEventListener('submit', async (e) => {
  e.preventDefault();

  const texto = mensagemInput.value.trim();
  if (!texto) return;

  adicionarMensagem("Você: " + texto, "user");
  mensagemInput.value = "";

  try {
    const res = await fetch("/responder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mensagem: texto })
    });

    const data = await res.json();
    adicionarMensagem("Bot: " + data.resposta, "bot");

  } catch (err) {
    adicionarMensagem("Bot: Erro ao tentar responder.", "bot");
  }
});

// Enter envia a mensagem
mensagemInput.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    document.getElementById('enviar').click();
  }

  document.getElementById('limpar-chat').addEventListener('click', () => {
    chat.innerHTML = "";
  });
  
});
