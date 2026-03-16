// Thin shell web component — renders a loading screen immediately,
// then lazy-loads the heavy game engine (planck.js + all game logic).
// This keeps the initial bundle tiny and avoids FOUC.
//
// Attributes:
//   color-mode="dark|light"  — explicit theme override (default: follows prefers-color-scheme)
//   width="800"              — explicit display width; height derived from 8:5 aspect ratio
//   height="300"             — explicit display height; width derived from 8:5 aspect ratio
//   (neither w/h)            — fills container width, capped at 640px
//   collapsed                — starts as a toggle button; game loads on first expand
//
// Collapsed mode — two named slots for open/close button content:
//   <radar-runner collapsed>
//     <span slot="open"><svg>...</svg> Play a game</span>
//     <span slot="close">Hide game</span>
//   </radar-runner>
//
//   Both slots have default fallbacks if not provided.
//   If only default slot children are given (no slot attr), they go into the open slot.
//
// Styling the toggle button from outside:
//   CSS custom properties:
//     --rr-toggle-bg, --rr-toggle-color, --rr-toggle-border,
//     --rr-toggle-font, --rr-toggle-radius, --rr-toggle-padding
//   ::part(toggle) — for full CSS access to the button

const ASPECT = 8 / 5; // 1280×800 native → 8:5
const NATIVE_W = 1280;
const NATIVE_H = 800;
const DEFAULT_MAX_W = 640;

const DEFAULT_OPEN_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="vertical-align:-2px" aria-hidden="true"><path d="M4 2l8 6-8 6V2z" fill="currentColor"/></svg>`;
const DEFAULT_CLOSE_ICON = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="vertical-align:-2px" aria-hidden="true"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

const SHELL_STYLES = `
:host {
  display: block;
  contain: layout style;
}
.wrapper {
  position: relative;
}
.inner {
  position: relative;
  transform-origin: top left;
}
.ui-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.ui-overlay > * {
  pointer-events: auto;
}
.loader {
  border-radius: 2px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  font-family: "Noto Sans", ui-sans-serif, system-ui, sans-serif;
  transition: opacity 0.3s ease-out;
}
.loader.fade-out {
  opacity: 0;
  pointer-events: none;
}
.loader-text {
  font-size: 14px;
  font-weight: 400;
}
.spinner {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 3px solid transparent;
  border-top-color: #fd5200;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
.game-container {
  display: none;
  position: absolute;
  inset: 0;
}
.game-container.ready {
  display: block;
}

/* ── Toggle button (collapsed mode) ── */
.toggle-btn {
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--rr-toggle-bg, rgba(253, 82, 0, 0.08));
  color: var(--rr-toggle-color, #fd5200);
  border: var(--rr-toggle-border, 1px solid rgba(253, 82, 0, 0.2));
  font: var(--rr-toggle-font, 500 14px "Noto Sans", ui-sans-serif, system-ui, sans-serif);
  border-radius: var(--rr-toggle-radius, 6px);
  padding: var(--rr-toggle-padding, 8px 20px);
  transition: opacity 0.15s, background 0.15s;
}
.toggle-btn:hover {
  opacity: 0.85;
}
.toggle-btn ::slotted(*) {
  vertical-align: middle;
}
.game-area {
  overflow: hidden;
  transition: max-height 0.35s ease, opacity 0.3s ease, margin-top 0.3s ease;
}
.game-area.expanded {
  margin-top: var(--rr-game-gap, 8px);
}
.game-area.collapsed {
  margin-top: 0;
  max-height: 0;
  opacity: 0;
  pointer-events: none;
}
.game-area.expanded {
  opacity: 1;
  pointer-events: auto;
}
`;

class RadarRunnerShell extends HTMLElement {
  static observedAttributes = ['color-mode', 'width', 'height', 'collapsed'];

  private wrapper!: HTMLDivElement;
  private inner!: HTMLDivElement;
  private loaderEl!: HTMLDivElement;
  private gameContainer!: HTMLDivElement;
  private uiOverlay!: HTMLDivElement;
  private gameArea!: HTMLDivElement;
  private toggleBtn!: HTMLButtonElement;
  private openSlot!: HTMLSlotElement;
  private closeSlot!: HTMLSlotElement;
  private openFallback!: HTMLSpanElement;
  private closeFallback!: HTMLSpanElement;
  private gameInstance: { destroy(): void; setDark(dark: boolean): void } | null = null;
  private _mediaQuery: MediaQueryList | null = null;
  private _resizeObserver: ResizeObserver | null = null;
  private _onMediaChange = () => this.syncTheme();
  private _gameLoaded = false;
  private _expanded = false;

  connectedCallback() {
    const shadow = this.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = SHELL_STYLES;
    shadow.appendChild(style);

    // ── Toggle button with two named slots ──
    this.toggleBtn = document.createElement('button');
    this.toggleBtn.className = 'toggle-btn';
    this.toggleBtn.setAttribute('part', 'toggle');
    this.toggleBtn.addEventListener('click', () => this.toggle());

    // "open" slot — shown when collapsed (default: play icon + label)
    this.openSlot = document.createElement('slot');
    this.openSlot.name = 'open';
    this.openFallback = document.createElement('span');
    this.openFallback.innerHTML = `${DEFAULT_OPEN_ICON} Play while you wait`;
    this.openSlot.appendChild(this.openFallback);

    // "close" slot — shown when expanded (default: × icon + label)
    this.closeSlot = document.createElement('slot');
    this.closeSlot.name = 'close';
    this.closeFallback = document.createElement('span');
    this.closeFallback.innerHTML = `${DEFAULT_CLOSE_ICON} Close game`;
    this.closeSlot.appendChild(this.closeFallback);

    // Default slot → maps to open slot (convenience for simple usage)
    const defaultSlot = document.createElement('slot');
    const hasDefaultContent = () =>
      defaultSlot.assignedNodes({ flatten: false })
        .some(n => n.nodeType === Node.ELEMENT_NODE ||
                   (n.nodeType === Node.TEXT_NODE && n.textContent!.trim() !== ''));
    defaultSlot.addEventListener('slotchange', () => {
      if (hasDefaultContent()) {
        this.openSlot.style.display = 'none';
        defaultSlot.style.display = '';
      } else {
        this.openSlot.style.display = '';
        defaultSlot.style.display = 'none';
      }
    });
    defaultSlot.style.display = 'none';

    this.toggleBtn.appendChild(this.openSlot);
    this.toggleBtn.appendChild(defaultSlot);
    this.toggleBtn.appendChild(this.closeSlot);

    // Initial visibility
    this.closeSlot.style.display = 'none';

    shadow.appendChild(this.toggleBtn);

    // ── Game area ──
    this.gameArea = document.createElement('div');
    this.gameArea.className = 'game-area';

    this.wrapper = document.createElement('div');
    this.wrapper.className = 'wrapper';

    this.inner = document.createElement('div');
    this.inner.className = 'inner';

    this.loaderEl = document.createElement('div');
    this.loaderEl.className = 'loader';

    const spinner = document.createElement('div');
    spinner.className = 'spinner';
    const text = document.createElement('div');
    text.className = 'loader-text';
    text.textContent = 'Loading game\u2026';
    this.loaderEl.appendChild(spinner);
    this.loaderEl.appendChild(text);

    this.gameContainer = document.createElement('div');
    this.gameContainer.className = 'game-container';

    // UI overlay sits outside .inner (not CSS-scaled) so buttons render at real size
    this.uiOverlay = document.createElement('div');
    this.uiOverlay.className = 'ui-overlay';

    this.inner.appendChild(this.loaderEl);
    this.inner.appendChild(this.gameContainer);
    this.wrapper.appendChild(this.inner);
    this.wrapper.appendChild(this.uiOverlay);
    this.gameArea.appendChild(this.wrapper);
    shadow.appendChild(this.gameArea);

    // OS theme changes
    this._mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    this._mediaQuery.addEventListener('change', this._onMediaChange);

    // Container resize
    this._resizeObserver = new ResizeObserver(() => this.updateSize());
    this._resizeObserver.observe(this);

    this.syncTheme();
    this.updateSize();

    if (!this.hasAttribute('collapsed')) {
      this._expanded = true;
      this.toggleBtn.style.display = 'none';
      this.gameArea.classList.add('expanded');
      this.loadGame();
    } else {
      this.gameArea.classList.add('collapsed');
    }
  }

  disconnectedCallback() {
    this._mediaQuery?.removeEventListener('change', this._onMediaChange);
    this._resizeObserver?.disconnect();
    this.gameInstance?.destroy();
    this.gameInstance = null;
  }

  attributeChangedCallback(name: string) {
    switch (name) {
      case 'color-mode':
        this.syncTheme();
        break;
      case 'width':
      case 'height':
        this.updateSize();
        break;
      case 'collapsed':
        if (!this.hasAttribute('collapsed') && !this._expanded) this.expand();
        break;
    }
  }

  // ── Public API ──

  toggle() {
    if (this._expanded) this.collapse();
    else this.expand();
  }

  expand() {
    this._expanded = true;
    // Show close slot, hide open slot + default slot
    this.openSlot.style.display = 'none';
    const defaultSlot = this.toggleBtn.querySelector('slot:not([name])') as HTMLSlotElement;
    if (defaultSlot) defaultSlot.style.display = 'none';
    this.closeSlot.style.display = '';
    this.gameArea.classList.remove('collapsed');
    this.gameArea.style.maxHeight = `${this.wrapper.offsetHeight}px`;
    this.gameArea.classList.add('expanded');
    if (!this._gameLoaded) this.loadGame();
  }

  collapse() {
    this._expanded = false;
    // Show open slot (or default slot), hide close slot
    this.closeSlot.style.display = 'none';
    const defaultSlot = this.toggleBtn.querySelector('slot:not([name])') as HTMLSlotElement;
    const hasDefaultContent = defaultSlot && defaultSlot.assignedNodes({ flatten: false })
      .some(n => n.nodeType === Node.ELEMENT_NODE ||
                 (n.nodeType === Node.TEXT_NODE && n.textContent!.trim() !== ''));
    if (hasDefaultContent) {
      defaultSlot.style.display = '';
      this.openSlot.style.display = 'none';
    } else {
      this.openSlot.style.display = '';
      if (defaultSlot) defaultSlot.style.display = 'none';
    }
    this.gameArea.style.maxHeight = `${this.wrapper.offsetHeight}px`;
    void this.gameArea.offsetHeight;
    this.gameArea.classList.remove('expanded');
    this.gameArea.classList.add('collapsed');
  }

  // ── Theme ──

  private get isDark(): boolean {
    const mode = this.getAttribute('color-mode');
    if (mode === 'dark') return true;
    if (mode === 'light') return false;
    return !!this._mediaQuery?.matches;
  }

  private syncTheme() {
    this.applyLoaderTheme();
    this.gameInstance?.setDark(this.isDark);
  }

  private applyLoaderTheme() {
    if (!this.loaderEl) return;
    const dark = this.isDark;
    this.loaderEl.style.background = dark ? '#292929' : '#ebf1e5';
    const textEl = this.loaderEl.querySelector('.loader-text') as HTMLElement;
    if (textEl) textEl.style.color = dark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.4)';
  }

  // ── Sizing ──

  private updateSize() {
    if (!this.wrapper) return;

    let displayW: number;
    let displayH: number;

    const attrW = this.getAttribute('width');
    const attrH = this.getAttribute('height');

    if (attrW) {
      displayW = parseFloat(attrW);
      displayH = displayW / ASPECT;
    } else if (attrH) {
      displayH = parseFloat(attrH);
      displayW = displayH * ASPECT;
    } else {
      const containerW = this.clientWidth || DEFAULT_MAX_W;
      displayW = Math.min(containerW, DEFAULT_MAX_W);
      displayH = displayW / ASPECT;
    }

    const scale = displayW / NATIVE_W;

    this.wrapper.style.width = `${displayW}px`;
    this.wrapper.style.height = `${displayH}px`;
    this.inner.style.width = `${NATIVE_W}px`;
    this.inner.style.height = `${NATIVE_H}px`;
    this.inner.style.transform = `scale(${scale})`;

    this.loaderEl.style.width = `${NATIVE_W}px`;
    this.loaderEl.style.height = `${NATIVE_H}px`;

    if (this._expanded) {
      this.gameArea.style.maxHeight = `${displayH}px`;
    }
  }

  // ── Game loading ──

  private async loadGame() {
    this._gameLoaded = true;
    const { createGame } = await import('./radar-runner-game');

    this.gameInstance = createGame(this.gameContainer, this.isDark, this.uiOverlay);

    this.loaderEl.classList.add('fade-out');
    setTimeout(() => {
      this.loaderEl.style.display = 'none';
      this.gameContainer.classList.add('ready');
    }, 300);
  }
}

customElements.define('radar-runner', RadarRunnerShell);

export { RadarRunnerShell };
