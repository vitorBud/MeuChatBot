import { useEffect, useRef, useState } from 'react';
import Sidebar from './components/sidebar.jsx';
import './styles/style.css';
import { initPrevisoes } from './components/previsoes.js';


  const STORAGE_KEY = 'threads_v2';
  const CURRENT_KEY = 'threads_current_v2';

  const uid = () => 't_' + Math.random().toString(36).slice(2, 9);
  const nowISO = () => new Date().toISOString();
  const strip = (s) => (s || '').trim();

  const createEmptyThread = () => ({
    title: 'Novo chat',
    messages: [],
    createdAt: nowISO(),
  });

  function App() {
    const [threads, setThreads] = useState({});
    const [currentId, setCurrentId] = useState(null);
    const [activeView, setActiveView] = useState('chat-view');
    const [messageText, setMessageText] = useState('');
    const [isSending, setIsSending] = useState(false);
    const [pvTema, setPvTema] = useState('');
      
    useEffect(() => {initPrevisoes();}, []);


    const chatRef = useRef(null);
    const textareaRef = useRef(null);
    const controllerRef = useRef(null);

    const currentThread = currentId ? threads[currentId] : null;

    // ---------- Carregar estado do localStorage ----------
    useEffect(() => {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        let loaded = raw ? JSON.parse(raw) || {} : {};
        let curr = localStorage.getItem(CURRENT_KEY);
        const ids = Object.keys(loaded);

        if (!curr || !loaded[curr]) curr = ids[0] || null;

        if (!curr) {
          const id = uid();
          loaded[id] = createEmptyThread();
          curr = id;
        }

        setThreads(loaded);
        setCurrentId(curr);
      } catch (err) {
        console.error('[chat] loadState:', err);
        const id = uid();
        const initial = { [id]: createEmptyThread() };
        setThreads(initial);
        setCurrentId(id);
      }
    }, []);

    // ---------- Salvar estado no localStorage ----------
    useEffect(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(threads));
        if (currentId) localStorage.setItem(CURRENT_KEY, currentId);
      } catch (err) {
        console.error('[chat] saveState:', err);
      }
    }, [threads, currentId]);

    // ---------- Scroll automático pro fim ----------
    useEffect(() => {
      if (!chatRef.current) return;
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }, [currentId, threads]);

    // ---------- Helpers ----------
    const autosize = (el) => {
      if (!el) return;
      el.style.height = 'auto';
      const max = 220;
      el.style.height = Math.min(el.scrollHeight, max) + 'px';
    };

    const handleMessageChange = (e) => {
      setMessageText(e.target.value);
      autosize(e.target);
    };

    // ---------- Threads ----------
    const handleNewThread = () => {
      const id = uid();
      setThreads((prev) => ({
        ...prev,
        [id]: createEmptyThread(),
      }));
      setCurrentId(id);
    };

    const handleRenameCurrent = () => {
      if (!currentThread || !currentId) return;
      const novo = window.prompt(
        'Novo título do chat:',
        currentThread.title || 'Meu chat'
      );
      if (!novo || !strip(novo)) return;

      const title = strip(novo);
      setThreads((prev) => ({
        ...prev,
        [currentId]: {
          ...prev[currentId],
          title,
        },
      }));
    };

    const handleDeleteCurrent = () => {
      if (!currentThread || !currentId) return;
      if (
        !window.confirm(
          'Tem certeza que deseja APAGAR este chat? Essa ação não pode ser desfeita.'
        )
      )
        return;

      controllerRef.current?.abort?.();

      setThreads((prev) => {
        const copy = { ...prev };
        delete copy[currentId];
        const ids = Object.keys(copy);
        let nextId;

        if (ids.length > 0) {
          nextId = ids[0];
        } else {
          const id = uid();
          copy[id] = createEmptyThread();
          nextId = id;
        }

        setCurrentId(nextId);
        return copy;
      });
    };

    const handleClearMessages = () => {
      if (!currentThread || !currentId) return;
      if (!window.confirm('Limpar todas as mensagens deste chat?')) return;

      controllerRef.current?.abort?.();

      setThreads((prev) => ({
        ...prev,
        [currentId]: {
          ...prev[currentId],
          messages: [],
        },
      }));
    };

    const handleExportCurrent = () => {
      if (!currentThread) return;

      const lines = [];
      lines.push(
        `# ${
          currentThread.title || 'Chat'
        } — exportado em ${new Date().toLocaleString('pt-BR')}`
      );
      lines.push('');

      for (const m of currentThread.messages) {
        const who = m.role === 'user' ? 'Você' : 'Bot';
        lines.push(`[${who}] ${m.text}`);
      }

      const blob = new Blob([lines.join('\n')], {
        type: 'text/plain;charset=utf-8;',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const name = (currentThread.title || 'chat')
        .toLowerCase()
        .replace(/[^\w\-]+/g, '-');

      a.href = url;
      a.download = `${name}.txt`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    };

    const handleSelectThread = (id) => {
      if (!threads[id]) return;
      setCurrentId(id);
    };

    // ---------- Enviar mensagem / integrar com backend ----------
    const handleChatSubmit = async (event) => {
      if (event) event.preventDefault();
      const txt = strip(messageText);
      if (!txt || !currentId) return;

      const targetThreadId = currentId;
      const userMsg = {
        role: 'user',
        text: 'Você: ' + txt,
        at: nowISO(),
      };

      // grava mensagem do usuário
      setThreads((prev) => {
        const t = prev[targetThreadId];
        if (!t) return prev;
        return {
          ...prev,
          [targetThreadId]: {
            ...t,
            messages: [...t.messages, userMsg],
          },
        };
      });

      // limpa input
      setMessageText('');
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }

      setIsSending(true);

      // cancela requisição anterior (se houver)
      controllerRef.current?.abort?.();
      const controller = new AbortController();
      controllerRef.current = controller;

      try {
        const res = await fetch('http://127.0.0.1:5000/responder', {


          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mensagem: txt }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          throw new Error(
            `HTTP ${res.status}${errText ? `: ${errText}` : ''}`
          );
        }

        const data = await res.json().catch(() => ({
          resposta: 'Sem resposta.',
        }));
        const botTxtRaw = data?.resposta || 'Sem resposta.';
        const botMsg = {
          role: 'bot',
          text: 'Bot: ' + botTxtRaw,
          at: nowISO(),
        };

        setThreads((prev) => {
          const t = prev[targetThreadId];
          if (!t) return prev;
          return {
            ...prev,
            [targetThreadId]: {
              ...t,
              messages: [...t.messages, botMsg],
            },
          };
        });
      } catch (err) {
        if (err?.name === 'AbortError') {
          // requisicao cancelada, ignora
        } else {
          console.error('[chat] responder:', err);
          const fallback = {
            role: 'bot',
            text: 'Bot: Erro ao tentar responder.',
            at: nowISO(),
          };
          setThreads((prev) => {
            const t = prev[targetThreadId];
            if (!t) return prev;
            return {
              ...prev,
              [targetThreadId]: {
                ...t,
                messages: [...t.messages, fallback],
              },
            };
          });
        }
      } finally {
        if (controllerRef.current === controller) {
          controllerRef.current = null;
        }
        setIsSending(false);
      }
    };

    // Enter envia sem Shift
    const handleTextareaKeyDown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleChatSubmit();
      }
    };

    // ---------- Previsões (placeholder por enquanto) ----------
    const handlePrevisoesSubmit = (e) => {
      e.preventDefault();
      console.log('Analisar tema de previsões:', pvTema);
    };

    const handleAbrirPrevisoes = () => {
      setActiveView('previsoes-view');
    };

    // ---------- Render ----------
    return (
      <>
        <Sidebar
          threads={threads}
          currentId={currentId}
          onSelectThread={handleSelectThread}
          onNewChat={handleNewThread}
          onRenameChat={handleRenameCurrent}
          onDeleteChat={handleDeleteCurrent}
          activeView={activeView}
          onChangeView={setActiveView}
        />

        <main className="app">
          {/* Topbar */}
          <header className="topbar" role="banner">
            <div className="path">
              <span className="crumb">OrionAI</span>
              <span className="sep">/</span>
              <strong className="crumb" id="chat-title">
                {currentThread?.title || 'Novo chat'}
              </strong>
            </div>

            <div className="top-actions">

              <button
                id="limpar-chat-2"
                className="icon-btn"
                title="Limpar mensagens"
                type="button"
                onClick={handleClearMessages}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 7h16M9 7V4h6v3m1 0v13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7h10Z" />
                </svg>
              </button>

              <details className="dropdown">
                <summary
                  className="icon-btn"
                  aria-label="Mais opções"
                  title="Mais opções"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" />
                  </svg>
                </summary>

                <div className="menu">
                  <button
                    className="menu-item"
                    type="button"
                    onClick={handleNewThread}
                  >
                    Novo chat
                  </button>
                  <button
                    className="menu-item"
                    type="button"
                    onClick={handleRenameCurrent}
                  >
                    Renomear
                  </button>
                  <button
                    className="menu-item"
                    type="button"
                    onClick={handleDeleteCurrent}
                  >
                    Apagar
                  </button>
                  <div className="menu-sep"></div>
                  <button
                    className="menu-item"
                    type="button"
                    onClick={handleAbrirPrevisoes}
                  >
                    Abrir Previsões (Labs)
                  </button>
                </div>
              </details>
            </div>
          </header>

          {/* View: Chat */}
          <section
            id="chat-view"
            className={`view ${
              activeView === 'chat-view' ? 'active' : ''
            }`}
            aria-live="polite"
          >
            <div
              id="chat"
              className="chat-scroller"
              ref={chatRef}
            >
              {currentThread?.messages.map((msg, index) => (
                <div
                  key={index}
                  className={`mensagem ${
                    msg.role === 'user' ? 'user' : 'bot'
                  }`}
                >
                  {msg.text}
                </div>
              ))}
            </div>

            <form
              id="formulario"
              className="composer"
              autoComplete="off"
              onSubmit={handleChatSubmit}
            >
              <div className="input-wrap">
                <button
                  className="icon-btn"
                  type="button"
                  title="Anexar"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M16.5 6.5v9a4.5 4.5 0 1 1-9 0v-10a3 3 0 1 1 6 0v9a1.5 1.5 0 1 1-3 0V7.5" />
                  </svg>
                </button>

                <textarea
                  id="mensagem"
                  placeholder="Olá, Bem vindo ao Orion"
                  rows={1}
                  ref={textareaRef}
                  value={messageText}
                  onChange={handleMessageChange}
                  onKeyDown={handleTextareaKeyDown}
                ></textarea>

                <button
                  className="icon-btn"
                  type="button"
                  title="Voz"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3zm6-3a6 6 0 0 1-12 0M12 21v-3" />
                  </svg>
                </button>

                <button
                  id="enviar"
                  className="send"
                  type="submit"
                  title="Enviar"
                  disabled={isSending || !strip(messageText)}
                >
                  {isSending ? 'Enviando...' : 'Enviar'}
                </button>
              </div>
              <p className="hint">↵ Enviar • Shift+↵ quebra linha</p>
            </form>
          </section>

          {/* View: Previsões */}
          <section
            id="previsoes-view"
            className={`view ${
              activeView === 'previsoes-view' ? 'active' : ''
            }`}
          >
            <header className="pv-top">
              <h1 className="pv-title">Previsões (experimental)</h1>
              <div className="actions pv-actions">
                <div
                  className="pv-segment"
                  role="group"
                  aria-label="Intervalo"
                >
                  <button
                    className="seg-btn pv-range active"
                    data-days="7"
                    type="button"
                  >
                    7d
                  </button>
                  <button
                    className="seg-btn pv-range"
                    data-days="14"
                    type="button"
                  >
                    14d
                  </button>
                  <button
                    className="seg-btn pv-range"
                    data-days="30"
                    type="button"
                  >
                    30d
                  </button>
                </div>

                <label className="pv-toggle">
                  <input type="checkbox" id="pv-mm" defaultChecked />
                  <span>Média móvel 3d</span>
                </label>

                <button
                  id="pv-export"
                  className="btn soft"
                  title="Exportar CSV"
                  type="button"
                  onClick={() =>
                    console.log('Exportar previsões (TODO)')
                  }
                >
                  Exportar
                </button>
                <button
                  id="pv-limpar"
                  className="btn outline"
                  title="Limpar dashboard"
                  type="button"
                  onClick={() =>
                    console.log('Limpar previsões (TODO)')
                  }
                >
                  Limpar
                </button>
              </div>
            </header>

            <div className="previsoes-layout">
              <div className="pv-panel">
                <div id="pv-log" className="pv-log"></div>

                <div className="pv-history">
                  <div className="pv-history-head">
                    <span>Histórico de temas</span>
                    <button
                      id="pv-clear-history"
                      className="linkish"
                      title="Limpar histórico"
                      type="button"
                      onClick={() =>
                        console.log('Limpar histórico (TODO)')
                      }
                    >
                      limpar
                    </button>
                  </div>
                  <ul id="pv-historico" className="pv-historico"></ul>
                </div>

                <form
                  id="pv-form"
                  className="composer pv-composer"
                  autoComplete="off"
                  onSubmit={handlePrevisoesSubmit}
                >
                  <input
                    id="pv-tema"
                    placeholder="Tema (ex.: IA no Brasil, petróleo, inflação…)"
                    value={pvTema}
                    onChange={(e) => setPvTema(e.target.value)}
                  />
                  <button type="submit" className="btn primary">
                    Analisar
                  </button>
                </form>
              </div>

              <div className="pv-analytics">
                <div className="pv-card">
                  <div className="pv-card-head">
                    <div className="pv-card-title">
                      Volume de notícias por dia
                      <span
                        id="pv-trend"
                        className="pv-trend"
                      ></span>
                    </div>
                    <div className="pv-legend">
                      <span className="dot dot-count"></span>{' '}
                      Matérias/dia
                      <span className="dot dot-ma"></span> MM 3d
                    </div>
                  </div>

                  <div className="pv-stats"></div>
                  <canvas id="pv-canvas"></canvas>
                </div>

                <div className="pv-card pv-articles-card">
                  <div className="pv-card-title">Artigos recentes</div>
                  <div
                    id="pv-articles"
                    className="pv-articles"
                  ></div>
                </div>
              </div>
            </div>
          </section>
        </main>
      </>
    );
  }

  export default App;
