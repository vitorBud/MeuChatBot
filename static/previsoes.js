// ---------- Seletores ----------
const chat = document.getElementById('chat');
const formulario = document.getElementById('formulario');
const mensagemInput = document.getElementById('mensagem');
const enviarBtn = document.getElementById('enviar');
const limparBtn = document.getElementById('limpar-chat');

const novoChatBtn = document.getElementById('novo-chat');
const threadList = document.getElementById('thread-list');
const navItems = document.querySelectorAll('.nav-item');

const chatView = document.getElementById('chat-view');
const previsoesView = document.getElementById('previsoes-view');

const pvForm = document.getElementById('pv-form');
const pvTema = document.getElementById('pv-tema');
const pvLog = document.getElementById('pv-log');
const pvCanvas = document.getElementById('pv-canvas');
const pvArticles = document.getElementById('pv-articles');

// NOVOS elementos da sidebar de Previsões
const pvLimparBtn = document.getElementById('pv-limpar');
const pvNovoBtn = document.getElementById('pv-novo');
const pvHistorico = document.getElementById('pv-historico');

let pvChart = null;

// ---------- Estado / Threads ----------
const state = {
    threads: {},        // {id: {title, messages:[{role,text}], createdAt}}
    currentId: null
};

function uid() { return 't_' + Math.random().toString(36).slice(2, 9); }
function nowISO() { return new Date().toISOString(); }

function loadState() {
    try {
        const raw = localStorage.getItem('threads_v1');
        if (raw) {
            state.threads = JSON.parse(raw);
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
function saveState() { localStorage.setItem('threads_v1', JSON.stringify(state.threads)); }

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

function renderThreadList() {
    threadList.innerHTML = '';
    const entries = Object.entries(state.threads)
        .sort((a, b) => (b[1].createdAt || '').localeCompare(a[1].createdAt || ''));
    for (const [id, t] of entries) {
        const li = document.createElement('li');
        if (id === state.currentId) li.classList.add('active');
        const first = t.messages.find(m => m.role === 'user')?.text || t.title || 'Novo chat';
        const preview = t.messages.at(-1)?.text || '';
        li.innerHTML = `<div class="title">${first.slice(0, 40)}</div><div class="preview">${preview.slice(0, 60)}</div>`;
        li.addEventListener('click', () => setCurrent(id));
        threadList.appendChild(li);
    }
}

function renderChat() {
    chat.innerHTML = '';
    const cur = state.threads[state.currentId];
    if (!cur) return;
    for (const msg of cur.messages) {
        addMessage(msg.text, msg.role === 'user' ? 'user' : 'bot', false);
    }
    chat.scrollTop = chat.scrollHeight;
}

// ---------- UI helpers ----------
function typeWriterEffect(element, text, speed = 5) {
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

// ---------- Enviar mensagem ao backend ----------
formulario.addEventListener('submit', async (e) => {
    e.preventDefault();
    const txt = mensagemInput.value.trim();
    if (!txt) return;
    mensagemInput.value = "";

    const cur = state.threads[state.currentId];
    cur.messages.push({ role: 'user', text: txt, at: nowISO() });
    saveState();
    addMessage("Você: " + txt, "user");

    try {
        const res = await fetch("/responder", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mensagem: txt })
        });
        const data = await res.json();
        const botTxt = "Bot: " + (data.resposta || "Sem resposta.");
        cur.messages.push({ role: 'bot', text: botTxt, at: nowISO() });
        saveState();
        addMessage(botTxt, "bot", true);
    } catch (err) {
        const botTxt = "Bot: Erro ao tentar responder.";
        cur.messages.push({ role: 'bot', text: botTxt, at: nowISO() });
        saveState();
        addMessage(botTxt, "bot");
    }
});

// Enter envia (sem Shift)
mensagemInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        enviarBtn.click();
    }
});

// Limpar chat atual
limparBtn.addEventListener('click', () => {
    const cur = state.threads[state.currentId];
    if (!cur) return;
    cur.messages = [];
    saveState();
    renderChat();
});

// Novo chat
novoChatBtn.addEventListener('click', newThread);

// Navegação entre views
navItems.forEach(btn => {
    btn.addEventListener('click', () => {
        navItems.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const view = btn.dataset.view;
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById(view).classList.add('active');
    });
});

// ---------- Previsões: estado local ----------
const pvState = {
    history: [] // [{id, tema, at}]
};

function pvLoadHistory() {
    try {
        const raw = localStorage.getItem('pv_history_v1');
        pvState.history = raw ? JSON.parse(raw) : [];
    } catch {
        pvState.history = [];
    }
}
function pvSaveHistory() {
    localStorage.setItem('pv_history_v1', JSON.stringify(pvState.history));
}
function pvAddHistory(tema) {
    const id = 'p_' + Math.random().toString(36).slice(2, 9);
    // evita duplicatas consecutivas do mesmo tema
    if (pvState.history[0]?.tema?.toLowerCase() === tema.toLowerCase()) return;
    pvState.history.unshift({ id, tema, at: nowISO() });
    // limita tamanho
    if (pvState.history.length > 30) pvState.history.length = 30;
    pvSaveHistory();
    renderPVHistory();
}
function renderPVHistory() {
    if (!pvHistorico) return;
    pvHistorico.innerHTML = '';
    pvState.history.forEach(item => {
        const li = document.createElement('li');
        const date = new Date(item.at).toLocaleString('pt-BR');
        li.innerHTML = `
      <div class="pv-h-item-title">${item.tema}</div>
      <div class="pv-h-item-date">${date}</div>
    `;
        li.addEventListener('click', () => {
            pvTema.value = item.tema;
            pvTema.focus();
        });
        pvHistorico.appendChild(li);
    });
}

// ---------- Previsões helpers ----------
function pvAdd(text, role = 'bot') {
    const div = document.createElement('div');
    div.classList.add('mensagem', role === 'user' ? 'user' : 'bot');
    div.textContent = text;
    pvLog.appendChild(div);
    pvLog.scrollTop = pvLog.scrollHeight;
}

function renderChart(series) {
    const labels = series.map(p => p.date);
    const data = series.map(p => p.count);
    if (pvChart) { pvChart.destroy(); }
    pvChart = new Chart(pvCanvas.getContext('2d'), {
        type: 'line',
        data: {
            labels,
            datasets: [{ label: 'Matérias/dia', data, tension: 0.3 }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            scales: {
                x: { ticks: { autoSkip: true, maxTicksLimit: 7 } },
                y: { beginAtZero: true, suggestedMax: Math.max(3, Math.max(0, ...data) + 1) }
            }
        }
    });
}

function pvClear() {
    pvLog.innerHTML = '';
    pvArticles.innerHTML = '';
    if (pvChart) { pvChart.destroy(); pvChart = null; }
}

// Botões da Previsões
pvLimparBtn?.addEventListener('click', pvClear);
pvNovoBtn?.addEventListener('click', () => {
    pvClear();
    pvTema.value = '';
    pvTema.focus();
});

// Submit da Previsões
pvForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const tema = pvTema.value.trim();
    if (!tema) return;
    pvTema.value = "";
    pvAdd("Você: " + tema, 'user');
    pvAdd("Bot: coletando manchetes e montando série...", 'bot');

    try {
        const res = await fetch('/prever', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tema })
        });
        const data = await res.json();
        if (data.erro) { pvAdd("Bot: " + data.erro, 'bot'); return; }

        pvAddHistory(tema);

        pvAdd("Bot: " + (data.previsao || "Sem resumo."), 'bot');
        renderChart(data.series || []);

        // lista de artigos
        pvArticles.innerHTML = (data.artigos || []).map(a => {
            const d = a.data_iso ? new Date(a.data_iso).toLocaleString('pt-BR') : '';
            const fonte = a.fonte ? ` — ${a.fonte}` : '';
            return `<div>• <a href="${a.url}" target="_blank" rel="noopener">${a.titulo || 'sem título'}</a> <span style="color:#8aa0bf">${fonte} ${d ? '· ' + d : ''}</span></div>`;
        }).join('');
    } catch (err) {
        pvAdd("Bot: erro ao consultar /prever", 'bot');
    }
});

// ---------- Boot ----------
loadState();
renderThreadList();
renderChat();

pvLoadHistory();
renderPVHistory();
