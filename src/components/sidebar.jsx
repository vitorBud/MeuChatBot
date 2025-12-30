// src/components/sidebar.jsx
import { useEffect, useRef, useState } from 'react';
import '../styles/sidebar.css';

const SIDEBAR_KEY = 'sidebarRecolhida';

function Sidebar({
  threads = {},
  currentId,
  onSelectThread,
  onNewChat,
  onRenameChat,
  onDeleteChat,
  activeView,
  onChangeView,
}) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [search, setSearch] = useState('');
  const [theme, setTheme] = useState('light');

  const sidebarRef = useRef(null);
  const toggleRef = useRef(null);

  // ---------- Tema (claro/escuro) ----------
  useEffect(() => {
    try {
      const stored = localStorage.getItem('theme');
      const prefersDark =
        window.matchMedia &&
        window.matchMedia('(prefers-color-scheme: dark)').matches;

      const initial =
        stored === 'dark' || stored === 'light'
          ? stored
          : prefersDark
          ? 'dark'
          : 'light';

      setTheme(initial);
      document.documentElement.setAttribute('data-theme', initial);
    } catch {
      // se der erro, deixa light mesmo
    }
  }, []);

  useEffect(() => {
    try {
      document.documentElement.setAttribute('data-theme', theme);
      localStorage.setItem('theme', theme);
    } catch {
      // ignore
    }
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  // ---------- Estado recolhido / expandido ----------
  useEffect(() => {
    try {
      const saved = localStorage.getItem(SIDEBAR_KEY) === 'true';
      setIsCollapsed(saved);
      applySidebarBodyClass(saved);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, isCollapsed ? 'true' : 'false');
      applySidebarBodyClass(isCollapsed);
    } catch {
      // ignore
    }
  }, [isCollapsed]);

  const applySidebarBodyClass = (collapsed) => {
    if (typeof document === 'undefined') return;
    if (collapsed) {
      document.body.classList.add('sidebar-recolhida');
    } else {
      document.body.classList.remove('sidebar-recolhida');
    }
  };

  const handleToggleSidebar = () => {
    setIsCollapsed((prev) => !prev);
    animateSidebarTransition();
  };

  const animateSidebarTransition = () => {
    const el = sidebarRef.current;
    if (!el) return;
    el.style.animation = 'none';
    // pequeno delay pra reativar animação
    setTimeout(() => {
      el.style.animation =
        'liquidEnter 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94)';
    }, 10);
  };

  // ---------- Atalhos de teclado (Ctrl/Cmd + B) ----------
  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        handleToggleSidebar();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- Fechar ao clicar fora (mobile) ----------
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (
        window.innerWidth > 768 ||
        !sidebarRef.current ||
        !toggleRef.current
      ) {
        return;
      }

      if (isCollapsed) return;

      const sidebarEl = sidebarRef.current;
      const toggleEl = toggleRef.current;

      if (
        !sidebarEl.contains(e.target) &&
        !toggleEl.contains(e.target)
      ) {
        setIsCollapsed(true);
      }
    };

    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [isCollapsed]);

  // ---------- Ripple effect (ondas) ----------
  useEffect(() => {
    if (document.querySelector('#ripple-styles')) return;
    const style = document.createElement('style');
    style.id = 'ripple-styles';
    style.textContent = `
      @keyframes ripple {
        to {
          transform: scale(2.5);
          opacity: 0;
        }
      }

      .glass-button,
      .glass-option,
      .nav-item {
        position: relative;
        overflow: hidden;
      }

      #sidebar.liquid-glass.recolhida .glass-button,
      #sidebar.liquid-glass.recolhida .glass-option {
        transform: none !important;
        box-shadow: none !important;
      }
    `;
    document.head.appendChild(style);
  }, []);

  const createRipple = (event) => {
    if (isCollapsed) return;

    const element = event.currentTarget;
    const rect = element.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const x = event.clientX - rect.left - size / 2;
    const y = event.clientY - rect.top - size / 2;

    const ripple = document.createElement('span');
    ripple.style.cssText = `
      position: absolute;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.4);
      transform: scale(0);
      animation: ripple 0.6s linear;
      pointer-events: none;
      width: ${size}px;
      height: ${size}px;
      left: ${x}px;
      top: ${y}px;
      z-index: 1;
    `;

    element.appendChild(ripple);
    setTimeout(() => ripple.remove(), 600);
  };

  const handleGlassEnter = (event) => {
    if (isCollapsed) return;
    const el = event.currentTarget;
    el.style.transform = 'translateY(-2px) scale(1.02)';
    el.style.boxShadow =
      '0 8px 25px rgba(0, 0, 0, 0.15), inset 0 1px 0 rgba(255, 255, 255, 0.2)';
  };

  const handleGlassLeave = (event) => {
    const el = event.currentTarget;
    el.style.transform = '';
    el.style.boxShadow = '';
  };

  const handleClickWithRipple = (handler) => (event) => {
    createRipple(event);
    if (handler) handler(event);
  };

  // ---------- Lista de threads (chats) ----------
  const entries = Object.entries(threads).sort(
    (a, b) =>
      (b[1].createdAt || '').localeCompare(a[1].createdAt || '')
  );

  const filter = search.trim().toLowerCase();
  const filteredEntries = entries.filter(([id, t]) => {
    const firstUser =
      t.messages.find((m) => m.role === 'user')?.text ||
      t.title ||
      'Novo chat';
    const preview = t.messages.at?.(-1)?.text || '';
    const hay = (firstUser + ' ' + preview + ' ' + (t.title || '')).toLowerCase();
    if (!filter) return true;
    return hay.includes(filter);
  });

  const shownCount = filteredEntries.length;

  return (
    <aside
      id="sidebar"
      className={`liquid-glass ${isCollapsed ? 'recolhida' : ''}`}
      aria-label="Menu lateral OrionAI"
      ref={sidebarRef}
    >
      {/* Overlay interno para efeito de profundidade */}
      <div className="glass-overlay"></div>

      {/* CABEÇALHO FIXO */}
      <header className="sb-header glass-panel">
        <button
          className="sb-toggle glass-button"
          aria-label="Recolher/Expandir"
          onClick={handleToggleSidebar}
          onMouseEnter={handleGlassEnter}
          onMouseLeave={handleGlassLeave}
          ref={toggleRef}
        >
          <span className="toggle-icon">
            {isCollapsed ? '☰' : '←'}
          </span>
        </button>

        <div className="sb-logo">
          <div className="sb-logo-icon glass-accent">
            <span>◎</span>
          </div>
          <div className="sb-logo-text">
            Orion<span className="gradient-text">AI</span>
          </div>
        </div>

        {/* Toggle de tema */}
        <button
          id="theme-toggle"
          className="icon-btn glass-button"
          aria-label="Alternar tema"
          onClick={toggleTheme}
          onMouseEnter={handleGlassEnter}
          onMouseLeave={handleGlassLeave}
        >
          <span className="theme-icon">
            {theme === 'dark' ? '☀️' : '🌙'}
          </span>
        </button>

        <div className="sb-profile-menu">
          <details className="dropdown">
            <summary
              className="icon-btn glass-button"
              aria-label="Abrir menu de perfil"
              onClick={createRipple}
              onMouseEnter={handleGlassEnter}
              onMouseLeave={handleGlassLeave}
            >
              <svg viewBox="0 0 24 24" className="icon">
                <path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0 2c-5 0-9 2.5-9 5v1h18v-1c0-2.5-4-5-9-5Z" />
              </svg>
            </summary>

            <div className="menu glass-panel">
              <div className="menu-section">Conta</div>
              <button
                className="menu-item glass-option"
                type="button"
                onClick={handleClickWithRipple(() =>
                  console.log('Meu perfil (TODO)')
                )}
                onMouseEnter={handleGlassEnter}
                onMouseLeave={handleGlassLeave}
              >
                <svg viewBox="0 0 24 24" className="icon-sm">
                  <path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0 2c-5 0-9 2.5-9 5v1h18v-1c0-2.5-4-5-9-5Z" />
                </svg>
                Meu perfil
              </button>
              <button
                className="menu-item glass-option"
                type="button"
                onClick={handleClickWithRipple(() =>
                  console.log('Preferências (TODO)')
                )}
                onMouseEnter={handleGlassEnter}
                onMouseLeave={handleGlassLeave}
              >
                <svg viewBox="0 0 24 24" className="icon-sm">
                  <path d="M12 1a11 11 0 1 0 0 22 11 11 0 0 0 0-22zm0 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14zm-1-9h2v6h-2v-6z" />
                </svg>
                Preferências
              </button>

              <div className="menu-sep"></div>

              <div className="menu-section">Chats</div>
              <button
                id="novo-chat"
                className="menu-item glass-option"
                type="button"
                onClick={handleClickWithRipple(onNewChat)}
                onMouseEnter={handleGlassEnter}
                onMouseLeave={handleGlassLeave}
              >
                <svg viewBox="0 0 24 24" className="icon-sm">
                  <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
                </svg>
                + Novo chat
              </button>
              <button
                id="renomear-chat"
                className="menu-item glass-option"
                type="button"
                onClick={handleClickWithRipple(onRenameChat)}
                onMouseEnter={handleGlassEnter}
                onMouseLeave={handleGlassLeave}
              >
                <svg viewBox="0 0 24 24" className="icon-sm">
                  <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
                </svg>
                Renomear chat
              </button>
              <button
                id="apagar-chat"
                className="menu-item glass-option danger"
                type="button"
                onClick={handleClickWithRipple(onDeleteChat)}
                onMouseEnter={handleGlassEnter}
                onMouseLeave={handleGlassLeave}
              >
                <svg viewBox="0 0 24 24" className="icon-sm">
                  <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
                </svg>
                Apagar chat
              </button>

              <div className="menu-sep"></div>
            </div>
          </details>
        </div>
      </header>

      {/* ÁREA SCROLLÁVEL DA SIDEBAR */}
      <div className="sb-scroll">
        {/* BUSCA */}
        <section className="sb-search">
          <div className="search-container glass-input">
            <svg viewBox="0 0 24 24" className="search-icon">
              <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
            </svg>
            <input
              id="thread-search"
              type="search"
              placeholder="Buscar chats..."
              className="search-input"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </section>

        {/* LISTA DE CONVERSAS */}
        <section className="sb-chats">
          <div className="sb-chats-head">
            <h3 className="section-title">Seus chats</h3>
            <span
              id="thread-count"
              className="count-badge glass-badge"
            >
              {shownCount} chat{shownCount === 1 ? '' : 's'}
            </span>
          </div>

          <ul id="thread-list" className="sb-chat-list">
            {filteredEntries.map(([id, t]) => {
              const firstUser =
                t.messages.find((m) => m.role === 'user')?.text ||
                t.title ||
                'Novo chat';
              const preview = t.messages.at?.(-1)?.text || '';
              const title =
                (t.title || firstUser || 'Novo chat').slice(0, 40);
              const previewText = (preview || '').slice(0, 60);

              return (
                <li
                  key={id}
                  className={
                    'chat-item glass-option' +
                    (id === currentId ? ' active' : '')
                  }
                  onClick={handleClickWithRipple(() =>
                    onSelectThread && onSelectThread(id)
                  )}
                  onMouseEnter={handleGlassEnter}
                  onMouseLeave={handleGlassLeave}
                >
                  <div className="chat-content">
                    <div className="chat-title">{title}</div>
                    <div className="chat-preview">
                      {previewText ||
                        'Comece uma nova conversa para explorar as funcionalidades...'}
                    </div>
                  </div>
                  <div className="chat-time"> </div>
                </li>
              );
            })}

            {filteredEntries.length === 0 && (
              <li className="chat-item glass-option empty">
                <div className="chat-content">
                  <div className="chat-title">
                    Nenhum chat encontrado
                  </div>
                  <div className="chat-preview">
                    Ajuste o termo da busca ou crie um novo chat.
                  </div>
                </div>
              </li>
            )}
          </ul>
        </section>
      </div>

      {/* RODAPÉ FIXO */}
      <footer className="sb-footer glass-panel">
        {/* NAVEGAÇÃO ENTRE VIEWS */}
        <nav className="sb-view-nav glass-panel">
          <button
            className={
              'nav-item glass-option' +
              (activeView === 'chat-view' ? ' active' : '')
            }
            type="button"
            data-view="chat-view"
            onClick={handleClickWithRipple(() =>
              onChangeView && onChangeView('chat-view')
            )}
            onMouseEnter={handleGlassEnter}
            onMouseLeave={handleGlassLeave}
          >
            <span className="nav-icon">💬</span>
            <span className="nav-text">Conversa</span>
          </button>

          <button
            className={
              'nav-item glass-option' +
              (activeView === 'previsoes-view' ? ' active' : '')
            }
            type="button"
            data-view="previsoes-view"
            onClick={handleClickWithRipple(() =>
              onChangeView && onChangeView('previsoes-view')
            )}
            onMouseEnter={handleGlassEnter}
            onMouseLeave={handleGlassLeave}
          >
            <span className="nav-icon">📈</span>
            <span className="nav-text">Previsões</span>
          </button>
        </nav>

        <div className="sb-version-box">
          <span className="sb-version">OrionAI v1.0</span>
        </div>
      </footer>
    </aside>
  );
}

export default Sidebar;
