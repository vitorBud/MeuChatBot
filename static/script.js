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
      version: 'v2',
      controller: null,   // AbortController p/ request ativa
    };

    const storageKey = 'threads_v2';
    const currentKey = 'threads_current_v2';

    // Helpers
    const uid = () => 't_' + Math.random().toString(36).slice(2, 9);
    const nowISO = () => new Date().toISOString();
    const raf = (fn) => requestAnimationFrame(() => requestAnimationFrame(fn)); // 2x garante layout aplicado

    const scrollToBottom = () => {
      if (!chat) return;
      raf(() => { chat.scrollTop = chat.scrollHeight; });
    };

    const strip = (s) => (s || '').trim();

    // ---------- Storage ----------
    function loadState() {
      try {
        const raw = localStorage.getItem(storageKey);
        state.threads = raw ? (JSON.parse(raw) || {}) : {};
        let curr = localStorage.getItem(currentKey);
        const ids = Object.keys(state.threads);
        if (!curr || !state.threads[curr]) curr = ids[0] || null;

        if (!curr) {
          const id = uid();
          state.threads[id] = { title: 'Novo chat', messages: [], createdAt: nowISO() };
          curr = id;
          saveState();
        }
        state.currentId = curr;
      } catch {
        state.threads = {};
        const id = uid();
        state.threads[id] = { title: 'Novo chat', messages: [], createdAt: nowISO() };
        state.currentId = id;
        saveState();
      }
    }

    function saveState() {
      localStorage.setItem(storageKey, JSON.stringify(state.threads));
      if (state.currentId) localStorage.setItem(currentKey, state.currentId);
    }

    // ---------- Threads ----------
    function setCurrent(id) {
      if (!state.threads[id]) return;
      state.currentId = id;
      saveState();
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
      if (novo && strip(novo)) {
        cur.title = strip(novo);
        saveState();
        renderThreadList();
        renderChat();
      }
    }

    function deleteCurrent() {
      const cur = state.threads[state.currentId];
      if (!cur) return;
      if (!confirm('Tem certeza que deseja APAGAR este chat? Essa ação não pode ser desfeita.')) return;

      // cancela requisição ativa vinculada a este chat
      state.controller?.abort?.();

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

      // cancela requisição ativa deste chat
      state.controller?.abort?.();

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

    // ---------- Render ----------
    function renderThreadList(filter = '') {
      if (!threadList) return;
      threadList.innerHTML = '';
      const entries = Object.entries(state.threads)
        .sort((a, b) => (b[1].createdAt || '').localeCompare(a[1].createdAt || ''));

      let shown = 0;
      const q = strip(filter).toLowerCase();

      for (const [id, t] of entries) {
        const first = t.messages.find(m => m.role === 'user')?.text || t.title || 'Novo chat';
        const preview = t.messages.at(-1)?.text || '';
        const hay = (first + ' ' + preview + ' ' + (t.title || '')).toLowerCase();
        if (q && !hay.includes(q)) continue;

        const li = document.createElement('li');
        if (id === state.currentId) li.classList.add('active');
        li.innerHTML = `
          <div class="title">${(t.title || first).slice(0, 40)}</div>
          <div class="preview">${preview.slice(0, 60)}</div>`;
        li.addEventListener('click', () => setCurrent(id));
        threadList.appendChild(li);
        shown++;
      }
      if (threadCount) threadCount.textContent = `${shown} chat${shown === 1 ? '' : 's'}`;
    }

    function renderChat() {
      if (!chat) return;
      chat.innerHTML = '';
      const cur = state.threads[state.currentId];
      if (!cur) return;
      if (chatTitle) chatTitle.textContent = cur.title || 'Buds Chat';

      for (const msg of cur.messages) {
        addMessage(msg.text, msg.role === 'user' ? 'user' : 'bot', false);
      }
      scrollToBottom();
    }

    // ---------- UI helpers ----------
    function typeWriterEffect(element, text, speed = 8) {
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
      if (effect) typeWriterEffect(msg, text);
      else msg.textContent = text;
      chat.appendChild(msg);
      scrollToBottom();
    }

    // Auto-size do textarea (limite prático)
    function autosize(el) {
      el.style.height = 'auto';
      const max = 220; // px
      el.style.height = Math.min(el.scrollHeight, max) + 'px';
    }
    mensagemInput?.addEventListener('input', () => autosize(mensagemInput));

    // Debounce helper
    function debounce(fn, wait = 200) {
      let t;
      return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), wait);
      };
    }

    // ---------- Enviar mensagem ao backend ----------
    formulario?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const txt = strip(mensagemInput.value);
      if (!txt) return;

      // captura o chat alvo no momento do envio
      const targetThreadId = state.currentId;

      // limpa UI input
      mensagemInput.value = '';
      autosize(mensagemInput);

      // grava mensagem do usuário
      const cur = state.threads[targetThreadId];
      if (!cur) return;
      cur.messages.push({ role: 'user', text: txt, at: nowISO() });
      saveState();

      // render no chat apenas se o usuário continua nesse thread
      if (state.currentId === targetThreadId) {
        addMessage('Você: ' + txt, 'user');
      }

      // feedback de envio
      enviarBtn.disabled = true;

      // cancela requisição anterior (se houver)
      state.controller?.abort?.();
      const controller = new AbortController();
      state.controller = controller;

      // placeholder "pensando…"
      let thinking;
      if (state.currentId === targetThreadId) {
        thinking = document.createElement('div');
        thinking.className = 'mensagem bot';
        thinking.textContent = 'Bot: pensando…';
        chat.appendChild(thinking);
        scrollToBottom();
      }

      try {
        const res = await fetch('/responder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mensagem: txt }),
          signal: controller.signal
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status}${errText ? `: ${errText}` : ''}`);
        }

        const data = await res.json().catch(() => ({ resposta: 'Sem resposta.' }));
        const botTxtRaw = data?.resposta || 'Sem resposta.';
        const botTxt = 'Bot: ' + botTxtRaw;

        // persiste no thread de origem (mesmo que usuário tenha trocado)
        const thread = state.threads[targetThreadId];
        if (thread) {
          thread.messages.push({ role: 'bot', text: botTxt, at: nowISO() });
          saveState();
        }

        // só renderiza se o usuário ainda está no mesmo thread
        if (state.currentId === targetThreadId) {
          thinking?.remove();
          addMessage(botTxt, 'bot', true);
        }

      } catch (err) {
        if (err?.name === 'AbortError') {
          // requisição cancelada — nada a fazer
        } else {
          const fallback = 'Bot: Erro ao tentar responder.';
          const thread = state.threads[targetThreadId];
          if (thread) {
            thread.messages.push({ role: 'bot', text: fallback, at: nowISO() });
            saveState();
          }
          if (state.currentId === targetThreadId) {
            thinking?.remove();
            addMessage(fallback, 'bot');
          }
          console.error('[chat] responder:', err);
        }
      } finally {
        if (state.controller === controller) state.controller = null;
        enviarBtn.disabled = false;
      }
    });

    // Enter envia (sem Shift)
    mensagemInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        enviarBtn.click();
      }
    });

    // ---------- Ações globais ----------
    novoChatBtn?.addEventListener('click', newThread);
    renomearChatBtn?.addEventListener('click', renameCurrent);
    apagarChatBtn?.addEventListener('click', deleteCurrent);
    limparChatBtn?.addEventListener('click', clearMessages);
    limparChatBtnTop?.addEventListener('click', clearMessages);
    exportarChatBtn?.addEventListener('click', exportCurrent);

    // Busca de chats (com debounce)
    threadSearch?.addEventListener('input', debounce((e) => {
      renderThreadList(e.target.value.trim());
    }, 150));

    // Navegação entre views (mantém contrato)
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    chatView?.classList.add('active');
    navItems.forEach(btn => {
      btn.addEventListener('click', () => {
        navItems.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const view = btn.dataset.view;
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById(view)?.classList.add('active');
      });
    });

    // ---------- Atalhos ----------
    window.addEventListener('keydown', (e) => {
      // Ctrl/Cmd + K -> foco na busca
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        threadSearch?.focus();
      }
      // Ctrl/Cmd + N -> novo chat
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        newThread();
      }
    });

    // ---------- Boot ----------
    loadState();
    renderThreadList();
    renderChat();
