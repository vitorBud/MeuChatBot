// =========================
// BudIA – Core (Chat + Sidebar)
// =========================

// ---------- Seletores ----------
const chat = document.getElementById('chat');
const formulario = document.getElementById('formulario');
const mensagemInput = document.getElementById('mensagem');
const enviarBtn = document.getElementById('enviar');

const novoChatBtn = document.getElementById('novo-chat');
const renomearChatBtn = document.getElementById('renomear-chat');
const apagarChatBtn = document.getElementById('apagar-chat');
const limparChatBtn = document.getElementById('limpar-chat');
const limparChatBtnTop = document.getElementById('limpar-chat-2');
const exportarChatBtn = document.getElementById('exportar-chat');

const threadSearch = document.getElementById('thread-search');
const threadList = document.getElementById('thread-list');
const threadCount = document.getElementById('thread-count');
const chatTitle = document.getElementById('chat-title');

const navItems = document.querySelectorAll('.nav-item');

// Views
const chatView = document.getElementById('chat-view');
const previsoesView = document.getElementById('previsoes-view');

// ---------- Estado / Threads ----------
const state = {
  threads: {},        // {id: {title, messages:[{role,text,at}], createdAt}}
  currentId: null,
  version: 'v2'
};

const storageKey = 'threads_v2';

const uid = () => 't_' + Math.random().toString(36).slice(2, 9);
const nowISO = () => new Date().toISOString();

function loadState() {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      state.threads = parsed || {};
      const ids = Object.keys(state.threads);
      state.currentId = ids[0] || null;
    } else {
      const id = uid();
      state.threads[id] = { title: 'Novo chat', messages: [], createdAt: nowISO() };
      state.currentId = id;
      saveState();
    }
  } catch {
    state.threads = {};
  }
}

function saveState() {
  localStorage.setItem(storageKey, JSON.stringify(state.threads));
}

function setCurrent(id) {
  state.currentId = id;
  renderThreadList();
  renderChat();
}

function newThread() {
  const id = uid();
  state.threads[id] = { title: 'Novo chat', messages: [], createdAt: nowISO() };
  saveState();
  setCurrent(id);
}

function renameCurrent() {
  const cur = state.threads[state.currentId];
  if (!cur) return;
  const novo = prompt('Novo título do chat:', cur.title || 'Meu chat');
  if (novo && novo.trim()) {
    cur.title = novo.trim();
    saveState();
    renderThreadList();
    renderChat();
  }
}

function deleteCurrent() {
  const cur = state.threads[state.currentId];
  if (!cur) return;
  if (!confirm('Tem certeza que deseja APAGAR este chat? Essa ação não pode ser desfeita.')) return;
  delete state.threads[state.currentId];
  const firstId = Object.keys(state.threads)[0];
  if (firstId) {
    state.currentId = firstId;
  } else {
    const id = uid();
    state.threads[id] = { title: 'Novo chat', messages: [], createdAt: nowISO() };
    state.currentId = id;
  }
  saveState();
  renderThreadList();
  renderChat();
}

function clearMessages() {
  const cur = state.threads[state.currentId];
  if (!cur) return;
  if (!confirm('Limpar todas as mensagens deste chat?')) return;
  cur.messages = [];
  saveState();
  renderChat();
}

function exportCurrent() {
  const cur = state.threads[state.currentId];
  if (!cur) return;
  const lines = [];
  lines.push(`# ${cur.title || 'Chat'} — exportado em ${new Date().toLocaleString('pt-BR')}`);
  lines.push('');
  for (const m of cur.messages) {
    const who = m.role === 'user' ? 'Você' : 'Bot';
    lines.push(`[${who}] ${m.text}`);
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const name = (cur.title || 'chat').toLowerCase().replace(/[^\w\-]+/g, '-');
  a.href = url; a.download = `${name}.txt`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function renderThreadList(filter = '') {
  threadList.innerHTML = '';
  const entries = Object.entries(state.threads)
    .sort((a, b) => (b[1].createdAt || '').localeCompare(a[1].createdAt || ''));

  let shown = 0;
  for (const [id, t] of entries) {
    const first = t.messages.find(m => m.role === 'user')?.text || t.title || 'Novo chat';
    const preview = t.messages.at(-1)?.text || '';
    const hay = (first + ' ' + preview + ' ' + (t.title || '')).toLowerCase();
    if (filter && !hay.includes(filter.toLowerCase())) continue;

    const li = document.createElement('li');
    if (id === state.currentId) li.classList.add('active');
    li.innerHTML = `
      <div class="title">${(t.title || first).slice(0, 40)}</div>
      <div class="preview">${preview.slice(0, 60)}</div>`;
    li.addEventListener('click', () => setCurrent(id));
    threadList.appendChild(li);
    shown++;
  }
  threadCount.textContent = `${shown} chat${shown === 1 ? '' : 's'}`;
}

function renderChat() {
  chat.innerHTML = '';
  const cur = state.threads[state.currentId];
  if (!cur) return;
  chatTitle.textContent = cur.title || 'Buds Chat';
  for (const msg of cur.messages) {
    addMessage(msg.text, msg.role === 'user' ? 'user' : 'bot', false);
  }
  chat.scrollTop = chat.scrollHeight;
}

// ---------- UI helpers ----------
function typeWriterEffect(element, text, speed = 2) {
  let i = 0;
  (function typing() {
    if (i < text.length) {
      element.textContent += text.charAt(i++);
      setTimeout(typing, speed);
    }
  })();
}
function addMessage(text, cls, effect = false) {
  const msg = document.createElement('div');
  msg.classList.add('mensagem', cls);
  if (effect) typeWriterEffect(msg, text); else msg.textContent = text;
  chat.appendChild(msg);
  chat.scrollTop = chat.scrollHeight;
}

// Auto-size do textarea
function autosize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 220) + 'px';
}
mensagemInput.addEventListener('input', () => autosize(mensagemInput));

// ---------- Enviar mensagem ao backend ----------
formulario.addEventListener('submit', async (e) => {
  e.preventDefault();
  const txt = mensagemInput.value.trim();
  if (!txt) return;
  mensagemInput.value = "";
  autosize(mensagemInput);

  const cur = state.threads[state.currentId];
  cur.messages.push({ role: 'user', text: txt, at: nowISO() });
  saveState();
  addMessage("Você: " + txt, "user");

  // feedback de envio
  enviarBtn.disabled = true;
  const loadingText = "Bot: pensando…";
  const thinking = document.createElement('div');
  thinking.className = 'mensagem bot';
  thinking.textContent = loadingText;
  chat.appendChild(thinking);
  chat.scrollTop = chat.scrollHeight;

  try {
    const res = await fetch("/responder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mensagem: txt })
    });
    const data = await res.json().catch(() => ({ resposta: 'Sem resposta.' }));
    thinking.remove();
    const botTxt = "Bot: " + (data.resposta || "Sem resposta.");
    cur.messages.push({ role: 'bot', text: botTxt, at: nowISO() });
    saveState();
    addMessage(botTxt, "bot", true);
  } catch (err) {
    thinking.remove();
    const botTxt = "Bot: Erro ao tentar responder.";
    cur.messages.push({ role: 'bot', text: botTxt, at: nowISO() });
    saveState();
    addMessage(botTxt, "bot");
  } finally {
    enviarBtn.disabled = false;
  }
});

// Enter envia (sem Shift)
mensagemInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    enviarBtn.click();
  }
});

// Ações globais
novoChatBtn?.addEventListener('click', newThread);
renomearChatBtn?.addEventListener('click', renameCurrent);
apagarChatBtn?.addEventListener('click', deleteCurrent);
limparChatBtn?.addEventListener('click', clearMessages);
limparChatBtnTop?.addEventListener('click', clearMessages);
exportarChatBtn?.addEventListener('click', exportCurrent);

// Busca de chats
threadSearch?.addEventListener('input', (e) => {
  renderThreadList(e.target.value.trim());
});

// Navegação entre views
document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
chatView.classList.add('active');
navItems.forEach(btn => {
  btn.addEventListener('click', () => {
    navItems.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const view = btn.dataset.view;
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(view).classList.add('active');
  });
});

// ---------- Boot ----------
loadState();
renderThreadList();
renderChat();
