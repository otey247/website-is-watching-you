import type { Settings } from '../persistence/Persistence';

export interface OverlayCallbacks {
  onEnter(): void;
  onResume(): void;
  onMenuOpen(): void;
  onMenuClose(): void;
  onSave(): void;
  onRestart(): void;
  onReset(): void;
  onExit(): void;
  onReturn(): void;
  onSettings(s: Settings): void;
}

const PRIVACY_HTML = `
  <h2>Privacy</h2>
  <p>This is a work of fiction that happens entirely inside this browser tab.</p>
  <h3>What the room observes</h3>
  <ul>
    <li>Only what you do inside the 3D room: which objects you click, inspect or move, where the in-room camera points, and the pointer position over the room.</li>
    <li>These events live in this tab's memory and are discarded when you close it or reset.</li>
  </ul>
  <h3>What it never touches</h3>
  <ul>
    <li>No webcam, microphone, location, contacts or files. The site never asks for those permissions.</li>
    <li>No browsing history, other tabs, cookies, fingerprinting or analytics. Nothing is sent to a server.</li>
    <li>The "computer" inside the room is part of the story. It cannot see your real computer.</li>
  </ul>
  <h3>Saving</h3>
  <p>Your session is only stored if you choose <strong>Save and leave</strong>, and then only in this browser's local storage. Display settings are remembered locally for convenience. <strong>Reset session data</strong> removes both.</p>
  <h3>Optional local language model</h3>
  <p>Off by default. If you turn it on, a short summary of in-room events (for example "opened the drawer, 3 minutes ago") is sent to a model server running on <em>your own machine</em> (localhost) to vary the wording of messages. Non-local addresses are refused. Every line is checked against what actually happened before it is shown.</p>
`;

/** DOM chrome: entry, hint, menu, settings, privacy, endings. Neutral, high-contrast, solid controls. */
export class Overlay {
  readonly root: HTMLElement;
  private gate: HTMLElement;
  private hint: HTMLElement;
  private fade: HTMLElement;
  private scrim: HTMLElement;
  private panel: HTMLElement;
  private end: HTMLElement;
  private left: HTMLElement;
  private menuBtn: HTMLButtonElement;
  private live: HTMLElement;
  private loading: HTMLElement;
  menuOpen = false;
  private settings: Settings;
  private lastFocus: HTMLElement | null = null;

  constructor(
    parent: HTMLElement,
    private readonly cb: OverlayCallbacks,
    settings: Settings,
    private readonly opts: { hasSave: boolean; canSave: boolean },
  ) {
    this.settings = { ...settings };
    this.root = el('div', 'overlay');
    parent.appendChild(this.root);

    this.gate = el('section', 'gate');
    this.gate.setAttribute('aria-label', 'Start');
    this.gate.innerHTML = `
      <div class="gate-inner">
        <h1 class="wordmark">The Website<br/>Is Watching You</h1>
        <p>An interactive room. Click and drag to look around; click things to use them.<br/>Best with headphones. Everything you do stays in this tab.</p>
        <div class="row">
          <button class="btn primary" data-act="enter">Enter</button>
          ${opts.hasSave ? '<button class="btn" data-act="resume">Resume saved session</button>' : ''}
          <button class="btn text" data-act="privacy">Privacy</button>
          <button class="btn text" data-act="settings">Settings</button>
        </div>
        <div class="loading" aria-live="polite"></div>
      </div>`;
    this.loading = this.gate.querySelector('.loading')!;
    this.root.appendChild(this.gate);

    this.hint = el('div', 'hint');
    this.hint.textContent = 'Take a look around.';
    this.hint.setAttribute('role', 'status');
    this.root.appendChild(this.hint);

    this.menuBtn = document.createElement('button');
    this.menuBtn.className = 'menu-btn';
    this.menuBtn.setAttribute('aria-label', 'Pause menu');
    this.menuBtn.innerHTML = '<svg viewBox="0 0 18 18" fill="currentColor" aria-hidden="true"><rect x="3" y="2" width="4" height="14" rx="1"/><rect x="11" y="2" width="4" height="14" rx="1"/></svg>';
    this.menuBtn.style.display = 'none';
    this.menuBtn.addEventListener('click', () => (this.menuOpen ? this.closeMenu() : this.openMenu()));
    this.root.appendChild(this.menuBtn);

    this.fade = el('div', 'fade');
    this.root.appendChild(this.fade);

    this.scrim = el('div', 'scrim');
    this.scrim.setAttribute('role', 'dialog');
    this.scrim.setAttribute('aria-modal', 'true');
    this.panel = el('div', 'panel');
    this.scrim.appendChild(this.panel);
    this.root.appendChild(this.scrim);

    this.end = el('section', 'end');
    this.end.setAttribute('aria-live', 'polite');
    this.root.appendChild(this.end);

    this.left = el('section', 'left-screen');
    this.left.innerHTML = `<div class="gate-inner"><h1 class="wordmark">You left the room.</h1><p>Nothing is running. Nothing was kept unless you saved.</p><div class="row"><button class="btn primary" data-act="return">Go back in</button></div></div>`;
    this.root.appendChild(this.left);

    this.live = el('div', 'sr-only');
    this.live.setAttribute('aria-live', 'polite');
    this.root.appendChild(this.live);

    this.root.addEventListener('click', (e) => this.onClick(e));
    this.scrim.addEventListener('keydown', (e) => this.trapFocus(e));
  }

  private onClick(e: MouseEvent): void {
    const t = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!t) return;
    const act = t.dataset.act;
    switch (act) {
      case 'enter':
        this.cb.onEnter();
        break;
      case 'resume':
        this.cb.onResume();
        break;
      case 'privacy':
        this.showPanel(PRIVACY_HTML + this.backButton(), true);
        break;
      case 'settings':
        this.showSettings();
        break;
      case 'close':
        this.closeMenu();
        break;
      case 'menu':
        this.renderMenu();
        break;
      case 'save':
        this.cb.onSave();
        break;
      case 'restart':
        this.closeMenu();
        this.cb.onRestart();
        break;
      case 'reset':
        this.closeMenu();
        this.cb.onReset();
        break;
      case 'exit':
        this.closeMenu();
        this.cb.onExit();
        break;
      case 'return':
        this.left.classList.remove('open');
        this.cb.onReturn();
        break;
    }
  }

  private backButton(): string {
    return this.menuBtn.style.display === 'none'
      ? '<div class="back"><button class="btn" data-act="close">Close</button></div>'
      : '<div class="back"><button class="btn" data-act="menu">Back</button></div>';
  }

  setLoading(text: string): void {
    this.loading.textContent = text;
  }

  hideGate(): void {
    this.gate.classList.add('hidden');
    this.gate.inert = true;
    this.gate.setAttribute('aria-hidden', 'true');
    this.menuBtn.style.display = '';
  }

  showGate(): void {
    this.gate.classList.remove('hidden');
    this.gate.inert = false;
    this.gate.removeAttribute('aria-hidden');
    this.menuBtn.style.display = 'none';
  }

  showHint(text = 'Take a look around.'): void {
    this.hint.textContent = text;
    this.hint.classList.add('show');
  }

  hideHint(): void {
    this.hint.classList.remove('show');
  }

  get hintVisible(): boolean {
    return this.hint.classList.contains('show');
  }

  setFade(on: boolean, ms = 1600): void {
    this.fade.style.transitionDuration = `${ms}ms`;
    this.fade.classList.toggle('on', on);
  }

  announce(text: string): void {
    this.live.textContent = text;
  }

  openMenu(): void {
    if (this.menuOpen) return;
    this.menuOpen = true;
    this.lastFocus = document.activeElement as HTMLElement;
    this.renderMenu();
    this.cb.onMenuOpen();
  }

  private renderMenu(): void {
    this.showPanel(`
      <h2>Paused</h2>
      <p>The room waits while this menu is open.</p>
      <div class="stack">
        <button class="btn primary" data-act="close">Resume</button>
        <button class="btn" data-act="settings">Settings</button>
        <button class="btn" data-act="privacy">Privacy</button>
        ${this.opts.canSave ? '<button class="btn" data-act="save">Save and leave</button>' : ''}
        <button class="btn" data-act="restart">Restart</button>
        <button class="btn" data-act="reset">Reset session data</button>
        <button class="btn" data-act="exit">Exit</button>
      </div>`);
  }

  closeMenu(): void {
    this.scrim.classList.remove('open');
    if (this.menuOpen) {
      this.menuOpen = false;
      this.cb.onMenuClose();
      this.lastFocus?.focus?.();
    }
  }

  private showPanel(html: string, scroll = false): void {
    this.panel.innerHTML = html;
    this.scrim.classList.add('open');
    if (scroll) this.panel.scrollTop = 0;
    const first = this.panel.querySelector<HTMLElement>('button, input, select');
    first?.focus();
  }

  /** Replace the values the settings panel shows (after a reset). */
  setSettings(s: Settings): void {
    this.settings = { ...s };
  }

  private showSettings(): void {
    const s = this.settings;
    this.showPanel(`
      <h2>Settings</h2>
      <h3>Sound</h3>
      <div class="field"><label for="vol">Volume</label><input id="vol" type="range" min="0" max="1" step="0.05" value="${s.volume}"/></div>
      <div class="field"><label for="mute">Mute</label><span class="switch"><input id="mute" type="checkbox" ${s.muted ? 'checked' : ''}/><span></span></span></div>
      <h3>Comfort</h3>
      <div class="field"><div><label for="rm">Reduced motion</label><small>Faster camera moves, no sway, fewer moving effects.</small></div><span class="switch"><input id="rm" type="checkbox" ${s.reducedMotion ? 'checked' : ''}/><span></span></span></div>
      <div class="field"><div><label for="sudden">Sudden events</label><small>Off removes abrupt light and sound events.</small></div><span class="switch"><input id="sudden" type="checkbox" ${s.suddenEvents ? 'checked' : ''}/><span></span></span></div>
      <h3>Graphics</h3>
      <div class="field"><div><label for="q">Quality</label><small>Low targets 30 fps on phones.</small></div><select id="q"><option value="high" ${s.quality === 'high' ? 'selected' : ''}>High</option><option value="low" ${s.quality === 'low' ? 'selected' : ''}>Low</option></select></div>
      <h3>Optional local language model</h3>
      <div class="field"><div><label for="llm">Vary messages with a local model</label><small>Sends short in-room event summaries to a model on this machine only. See Privacy.</small></div><span class="switch"><input id="llm" type="checkbox" ${s.localModel ? 'checked' : ''}/><span></span></span></div>
      <div class="field"><label for="llmUrl">Endpoint</label><input id="llmUrl" type="text" value="${s.localModelEndpoint}" spellcheck="false"/></div>
      <div class="field"><label for="llmName">Model</label><input id="llmName" type="text" value="${s.localModelName}" spellcheck="false"/></div>
      ${this.backButton()}`);
    const q = <T extends HTMLElement>(id: string) => this.panel.querySelector<T>(`#${id}`)!;
    const commit = () => {
      this.settings = {
        volume: Number(q<HTMLInputElement>('vol').value),
        muted: q<HTMLInputElement>('mute').checked,
        reducedMotion: q<HTMLInputElement>('rm').checked,
        suddenEvents: q<HTMLInputElement>('sudden').checked,
        quality: q<HTMLSelectElement>('q').value as 'high' | 'low',
        localModel: q<HTMLInputElement>('llm').checked,
        localModelEndpoint: q<HTMLInputElement>('llmUrl').value.trim(),
        localModelName: q<HTMLInputElement>('llmName').value.trim(),
      };
      this.cb.onSettings(this.settings);
    };
    this.panel.querySelectorAll('input, select').forEach((i) => i.addEventListener('change', commit));
    q<HTMLInputElement>('vol').addEventListener('input', commit);
  }

  showEnd(kicker: string, title: string, body: string, onRestart: () => void, onExit: () => void): void {
    this.end.innerHTML = `<div class="end-inner"><div class="kicker">${kicker}</div><h2>${title}</h2><p>${body}</p><div class="row"><button class="btn primary" data-end="restart">Begin again</button><button class="btn" data-end="exit">Exit</button></div></div>`;
    this.end.classList.add('open');
    this.end.querySelector<HTMLButtonElement>('[data-end="restart"]')!.onclick = () => {
      this.end.classList.remove('open');
      onRestart();
    };
    this.end.querySelector<HTMLButtonElement>('[data-end="exit"]')!.onclick = () => {
      this.end.classList.remove('open');
      onExit();
    };
    this.end.querySelector<HTMLButtonElement>('button')?.focus();
  }

  hideEnd(): void {
    this.end.classList.remove('open');
  }

  showLeft(): void {
    this.left.classList.add('open');
    this.menuBtn.style.display = 'none';
  }

  hideMenuButton(hidden: boolean): void {
    this.menuBtn.style.display = hidden ? 'none' : '';
  }

  toast(text: string): void {
    this.announce(text);
    const p = this.panel.querySelector('p');
    if (p && this.scrim.classList.contains('open')) p.textContent = text;
  }

  private trapFocus(e: KeyboardEvent): void {
    if (e.key !== 'Tab') return;
    const f = [...this.panel.querySelectorAll<HTMLElement>('button, input, select')];
    if (!f.length) return;
    const i = f.indexOf(document.activeElement as HTMLElement);
    if (e.shiftKey && i <= 0) {
      f[f.length - 1].focus();
      e.preventDefault();
    } else if (!e.shiftKey && i === f.length - 1) {
      f[0].focus();
      e.preventDefault();
    }
  }
}

function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}
