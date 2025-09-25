// ========= ELEMENTOS =========
const chat = document.getElementById('chat');
const formulario = document.getElementById('formulario');
const mensagemInput = document.getElementById('mensagem');
const enviarBtn = document.getElementById('enviar');
const limparBtn = document.getElementById('limpar-chat'); // opcional (pode não existir no layout novo)
const novoChatBtn = document.getElementById('novo-chat');  // botão da sidebar
const chatList = document.querySelector('.chat-list');     // lista da sidebar

// ========= STATE =========
let chats = {};            
let activeChatId = null;

// ========= UTIL =========
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function truncateTitle(text, max = 32) {
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1) + '…' : text || 'Novo chat';
}
function saveState() {
  localStorage.setItem('meuChatbot_state', JSON.stringify({ chats, activeChatId }));
}
function loadState() {
  try {
    const raw = localStorage.getItem('meuChatbot_state');
    if (!raw) return false;
    const data = JSON.parse(raw);
    chats = data.chats || {};
    activeChatId = data.activeChatId || null;
    return true;
  } catch {
    return false;
  }
}

// ========= TYPEWRITER =========
function typeWriterEffect(element, text, speed = 5) {
  let i = 0;
  function typing() {
    if (i < text.length) {
      element.textContent += text.charAt(i++);
      chat.scrollTop = chat.scrollHeight;
      setTimeout(typing, speed);
    }
  }
  typing();
}

// ========= RENDER =========
function renderSidebar() {
  if (!chatList) return;
  chatList.innerHTML = '';
  const ids = Object.keys(chats);

  if (ids.length === 0) return;

  ids.forEach(id => {
    const item = document.createElement('div');
    item.className = 'chat-item' + (id === activeChatId ? ' active' : '');
    item.textContent = chats[id].title || 'Novo chat';
    item.title = chats[id].title || 'Novo chat';
    item.addEventListener('click', () => switchChat(id));
    chatList.appendChild(item);
  });
}

function renderChat() {
  chat.innerHTML = '';
  const current = chats[activeChatId];
  if (!current) return;

  current.messages.forEach(msg => {
    const div = document.createElement('div');
    div.className = `mensagem ${msg.role === 'user' ? 'user' : 'bot'}`;
    // Ao re-render, não fazer typewriter (fica lento). Apenas texto direto.
    div.textContent = msg.text;
    chat.appendChild(div);
  });
  chat.scrollTop = chat.scrollHeight;
}

function updateActiveTitleFromFirstUserMessage(chatObj) {
  const firstUser = chatObj.messages.find(m => m.role === 'user');
  if (firstUser) {
    chatObj.title = truncateTitle(firstUser.text);
  } else {
    chatObj.title = 'Novo chat';
  }
}

// ========= AÇÕES =========
function createChat() {
  const id = uid();
  chats[id] = { id, title: 'Novo chat', messages: [] };
  activeChatId = id;
  saveState();
  renderSidebar();
  renderChat();
}

function switchChat(id) {
  if (!chats[id]) return;
  activeChatId = id;
  saveState();
  renderSidebar();
  renderChat();
}

function addMessage(role, text, withTypewriter = false) {
  const current = chats[activeChatId];
  if (!current) return;

  // Atualiza estado
  current.messages.push({ role, text });
  if (role === 'user') {
    updateActiveTitleFromFirstUserMessage(current);
  }
  saveState();

  // Renderiza só a nova mensagem (mais performático)
  const div = document.createElement('div');
  div.className = `mensagem ${role === 'user' ? 'user' : 'bot'}`;

  if (withTypewriter && role === 'bot') {
    typeWriterEffect(div, text);
  } else {
    div.textContent = text;
  }

  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;

  // Atualiza título na sidebar (pode ter mudado com a 1ª msg do user)
  renderSidebar();
}

// ========= SUBMIT =========
if (formulario) {
  formulario.addEventListener('submit', async (e) => {
    e.preventDefault();

    const texto = (mensagemInput.value || '').trim();
    if (!texto) return;

    addMessage('user', `Você: ${texto}`.replace(/^Você:\s*/i, 'Você: ')); // mantém seu prefixo
    mensagemInput.value = '';

    try {
      const res = await fetch('/responder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mensagem: texto })
      });

      const data = await res.json();
      const botText = `Bot: ${data?.resposta ?? 'Sem resposta.'}`;
      addMessage('bot', botText, true);

    } catch (err) {
      addMessage('bot', 'Bot: Erro ao tentar responder.');
    }
  });
}

// ========= LIMPAR CHAT ATUAL (opcional) =========
if (limparBtn) {
  limparBtn.addEventListener('click', () => {
    const current = chats[activeChatId];
    if (!current) return;
    current.messages = [];
    saveState();
    renderChat();
  });
}

// ========= NOVO CHAT =========
if (novoChatBtn) {
  novoChatBtn.addEventListener('click', () => {
    createChat();
  });
}

// ========= BOOT =========
(function boot() {
  const ok = loadState();
  if (!ok || !activeChatId || !chats[activeChatId]) {
    createChat();
  } else {
    renderSidebar();
    renderChat();
  }
})();
