// ===== LIQUID GLASS SIDEBAR MANAGER =====
class LiquidGlassSidebar {
    constructor() {
        this.sidebar = document.getElementById('sidebar');
        this.toggleBtn = document.querySelector('.sb-toggle');
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
        this.toggleBtn.addEventListener('click', () => this.toggleSidebar());
        
        // Teclas de atalho
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
                e.preventDefault();
                this.toggleSidebar();
            }
        });

        // Efeitos de hover nos botões de vidro
        this.setupGlassButtonEffects();
    }

    setupLiquidEffects() {
        // Efeito de onda nos botões
        this.setupRippleEffects();
        
        // Efeito de brilho interativo
        this.setupInteractiveGlow();
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
        const ripple = document.createElement('span');
        const rect = element.getBoundingClientRect();
        
        const size = Math.max(rect.width, rect.height);
        const x = event.clientX - rect.left - size / 2;
        const y = event.clientY - rect.top - size / 2;
        
        ripple.style.cssText = `
            position: absolute;
            border-radius: 50%;
            background: rgba(255, 255, 255, 0.3);
            transform: scale(0);
            animation: ripple 0.6s linear;
            pointer-events: none;
            width: ${size}px;
            height: ${size}px;
            left: ${x}px;
            top: ${y}px;
        `;
        
        element.style.position = 'relative';
        element.style.overflow = 'hidden';
        element.appendChild(ripple);
        
        setTimeout(() => {
            ripple.remove();
        }, 600);
    }

    setupInteractiveGlow() {
        this.sidebar.addEventListener('mousemove', (e) => {
            this.updateGlassGlow(e);
        });
        
        this.sidebar.addEventListener('mouseleave', () => {
            this.resetGlassGlow();
        });
    }

    updateGlassGlow(event) {
        const rect = this.sidebar.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        
        const glowIntensity = Math.min(0.2, (y / rect.height) * 0.3);
        
        this.sidebar.style.setProperty('--glass-glow', 
            `0 0 80px rgba(255, 255, 255, ${glowIntensity})`);
    }

    resetGlassGlow() {
        this.sidebar.style.setProperty('--glass-glow', 
            '0 0 80px rgba(255, 255, 255, 0.1)');
    }

    applySidebarState() {
        if (this.isRecolhida) {
            this.sidebar.classList.add('recolhida');
            document.body.classList.add('sidebar-recolhida');
            this.toggleBtn.innerHTML = '<span class="toggle-icon">☰</span>';
        } else {
            this.sidebar.classList.remove('recolhida');
            document.body.classList.remove('sidebar-recolhida');
            this.toggleBtn.innerHTML = '<span class="toggle-icon">←</span>';
        }
    }

    toggleSidebar() {
        this.isRecolhida = !this.isRecolhida;
        
        if (this.isRecolhida) {
            this.sidebar.classList.add('recolhida');
            document.body.classList.add('sidebar-recolhida');
            this.toggleBtn.innerHTML = '<span class="toggle-icon">☰</span>';
        } else {
            this.sidebar.classList.remove('recolhida');
            document.body.classList.remove('sidebar-recolhida');
            this.toggleBtn.innerHTML = '<span class="toggle-icon">←</span>';
        }
        
        localStorage.setItem('sidebarRecolhida', this.isRecolhida);
        
        // Efeito de transição líquida
        this.animateSidebarTransition();
    }

    animateSidebarTransition() {
        this.sidebar.style.animation = 'none';
        setTimeout(() => {
            this.sidebar.style.animation = 'liquidEnter 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94)';
        }, 10);
    }
}

// ===== INICIALIZAÇÃO =====
document.addEventListener('DOMContentLoaded', () => {
    window.liquidGlassSidebar = new LiquidGlassSidebar();
});

// Adicionar estilo de ripple dinamicamente
const style = document.createElement('style');
style.textContent = `
    @keyframes ripple {
        to {
            transform: scale(2.5);
            opacity: 0;
        }
    }
`;
document.head.appendChild(style);