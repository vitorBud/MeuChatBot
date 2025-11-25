// ===== LIQUID GLASS SIDEBAR MANAGER =====
class LiquidGlassSidebar {
    constructor() {
        this.sidebar = document.getElementById('sidebar');
        this.toggleBtn = document.querySelector('.sb-toggle');
        
        // Verificar se elementos existem
        if (!this.sidebar || !this.toggleBtn) {
            console.error('❌ Elementos da sidebar não encontrados');
            return;
        }
        
        this.isRecolhida = localStorage.getItem('sidebarRecolhida') === 'true';
        
        this.init();
    }

    init() {
        this.applySidebarState();
        this.setupEventListeners();
        this.setupLiquidEffects();
        
        console.log('🧊 LiquidGlassSidebar inicializado');
    }

    setupEventListeners() {
        // Toggle sidebar
        this.toggleBtn.addEventListener('click', () => this.toggleSidebar());
        
        // Teclas de atalho
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
                e.preventDefault();
                this.toggleSidebar();
            }
        });

        // Fechar sidebar ao clicar fora (mobile)
        this.setupClickOutside();

        // Efeitos de hover nos botões de vidro
        this.setupGlassButtonEffects();
    }

    setupClickOutside() {
        document.addEventListener('click', (e) => {
            if (window.innerWidth <= 768 && 
                !this.sidebar.contains(e.target) && 
                !this.toggleBtn.contains(e.target) &&
                !this.sidebar.classList.contains('recolhida')) {
                this.toggleSidebar();
            }
        });
    }

    setupLiquidEffects() {
        // Efeito de onda nos botões
        this.setupRippleEffects();
    }

    setupGlassButtonEffects() {
        const glassButtons = document.querySelectorAll('.glass-button, .glass-option');
        
        glassButtons.forEach(btn => {
            btn.addEventListener('mouseenter', (e) => {
                this.animateButtonHover(e.currentTarget);
            });
            
            btn.addEventListener('mouseleave', (e) => {
                this.animateButtonLeave(e.currentTarget);
            });
        });
    }

    animateButtonHover(button) {
        if (this.isRecolhida) return;
        
        button.style.transform = 'translateY(-2px) scale(1.02)';
        button.style.boxShadow = 
            '0 8px 25px rgba(0, 0, 0, 0.15), ' +
            'inset 0 1px 0 rgba(255, 255, 255, 0.2)';
    }

    animateButtonLeave(button) {
        button.style.transform = '';
        button.style.boxShadow = '';
    }

    setupRippleEffects() {
        const interactiveElements = document.querySelectorAll('.glass-button, .glass-option, .nav-item');
        
        interactiveElements.forEach(element => {
            element.addEventListener('click', (e) => {
                this.createRipple(e, element);
            });
        });
    }

    createRipple(event, element) {
        // Não criar ripple se sidebar recolhida
        if (this.isRecolhida) return;
        
        const ripple = document.createElement('span');
        const rect = element.getBoundingClientRect();
        
        const size = Math.max(rect.width, rect.height);
        const x = event.clientX - rect.left - size / 2;
        const y = event.clientY - rect.top - size / 2;
        
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
        
        element.style.position = 'relative';
        element.style.overflow = 'hidden';
        element.appendChild(ripple);
        
        setTimeout(() => {
            ripple.remove();
        }, 600);
    }

    applySidebarState() {
        if (this.isRecolhida) {
            this.collapseSidebar();
        } else {
            this.expandSidebar();
        }
    }

    collapseSidebar() {
        this.sidebar.classList.add('recolhida');
        document.body.classList.add('sidebar-recolhida');
        this.toggleBtn.innerHTML = '<span class="toggle-icon">☰</span>';
    }

    expandSidebar() {
        this.sidebar.classList.remove('recolhida');
        document.body.classList.remove('sidebar-recolhida');
        this.toggleBtn.innerHTML = '<span class="toggle-icon">←</span>';
    }

    toggleSidebar() {
        this.isRecolhida = !this.isRecolhida;
        
        if (this.isRecolhida) {
            this.collapseSidebar();
        } else {
            this.expandSidebar();
        }
        
        localStorage.setItem('sidebarRecolhida', this.isRecolhida);
        this.animateSidebarTransition();
    }

    animateSidebarTransition() {
        this.sidebar.style.animation = 'none';
        setTimeout(() => {
            this.sidebar.style.animation = 'liquidEnter 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94)';
        }, 10);
    }

    // Métodos públicos para controle externo
    open() {
        this.isRecolhida = false;
        this.expandSidebar();
        localStorage.setItem('sidebarRecolhida', 'false');
    }

    close() {
        this.isRecolhida = true;
        this.collapseSidebar();
        localStorage.setItem('sidebarRecolhida', 'true');
    }
}

// ===== INICIALIZAÇÃO SEGURA =====
document.addEventListener('DOMContentLoaded', () => {
    try {
        window.liquidGlassSidebar = new LiquidGlassSidebar();
    } catch (error) {
        console.error('❌ Erro ao inicializar LiquidGlassSidebar:', error);
    }
});



// ===== GERENCIAR CHAT ATIVO =====
document.addEventListener('DOMContentLoaded', () => {
    const threadList = document.getElementById('thread-list');

    if (!threadList) return;

    threadList.addEventListener('click', (event) => {
        const item = event.target.closest('.chat-item');
        if (!item) return;

        // remover active antigo
        document.querySelectorAll('.chat-item.active').forEach(li => {
            li.classList.remove('active');
        });

        // adicionar active ao clicado
        item.classList.add('active');
    });
});


// Adicionar CSS do ripple se não existir
if (!document.querySelector('#ripple-styles')) {
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
        
        /* Estado recolhido - desativar alguns efeitos */
        #sidebar.liquid-glass.recolhida .glass-button,
        #sidebar.liquid-glass.recolhida .glass-option {
            transform: none !important;
            box-shadow: none !important;
        }
    `;
    document.head.appendChild(style);
}