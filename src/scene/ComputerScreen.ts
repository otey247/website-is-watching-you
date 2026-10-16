import { CanvasTexture, LinearFilter, SRGBColorSpace, ShaderMaterial, Texture } from 'three';
import { canvas } from './textures';

export interface Note {
  title: string;
  body: string[];
  date: string;
  observer?: boolean;
}

export type ScreenAction = { kind: 'open'; index: number } | { kind: 'answer'; value: 'yes' | 'no' } | { kind: 'none' };

const W = 1024;
const H = 640;

const ORDINARY_NOTES: Note[] = [
  { title: 'groceries', date: 'Tue', body: ['oat milk', 'lemons (3)', 'coffee — the dark one', 'bin bags', 'something for Sunday?'] },
  { title: 'radiator', date: 'Mon', body: ['Called the landlord again.', 'He says it "just needs bleeding".', 'It knocks at night. Not every night.'] },
  { title: 'call back', date: 'Sun', body: ['Mum — about the photos from the garden.', 'She wants the one with all three of us.', 'Find the frame.'] },
  { title: 'reading list', date: 'Fri', body: ['Interiors (finish it)', 'A Quiet House', 'return Night Garden to M.'] },
];

/**
 * The fictional computer inside the room. Rendered to a canvas texture and
 * redrawn only when something changes. It is a communication channel inside
 * the fiction; it never imitates the player's real operating system or
 * browser, and never shows system-style warnings.
 */
export class ComputerScreen {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  readonly texture: CanvasTexture;
  readonly material: ShaderMaterial;
  notes: Note[] = ORDINARY_NOTES.map((n) => ({ ...n, body: [...n.body] }));
  selected = 0;
  cursor = { x: 640, y: 380 };
  mode: 'desktop' | 'question' | 'dark' = 'desktop';
  question: string | null = null;
  answered: 'yes' | 'no' | null = null;
  fictionalMinutes = 16 * 60 + 12;
  private dirty = true;
  private wallpaper: HTMLCanvasElement;
  private buttons: { x: number; y: number; w: number; h: number; action: ScreenAction }[] = [];
  private caretOn = true;

  constructor() {
    [this.canvas, this.ctx] = canvas(W, H);
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.minFilter = LinearFilter;
    this.texture.generateMipmaps = false;
    this.wallpaper = makeWallpaper();
    this.material = new ShaderMaterial({
      uniforms: {
        uScreen: { value: this.texture },
        uFeed: { value: null as Texture | null },
        uFeedMix: { value: 0 },
        uOn: { value: 1 },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uScreen;
        uniform sampler2D uFeed;
        uniform float uFeedMix;
        uniform float uOn;
        uniform float uTime;
        varying vec2 vUv;
        void main() {
          vec3 c = texture2D(uScreen, vUv).rgb;
          if (uFeedMix > 0.0) {
            vec3 f = texture2D(uFeed, vUv).rgb;
            float l = dot(f, vec3(0.299, 0.587, 0.114));
            f = vec3(l * 0.92, l, l * 0.95);
            f *= 0.92 + 0.08 * sin(vUv.y * 420.0 + uTime * 4.0);
            c = mix(c, f, uFeedMix);
          }
          // LCD: slight falloff at the edges, faint pixel grid.
          vec2 e = abs(vUv - 0.5) * 2.0;
          float vig = 1.0 - 0.18 * pow(max(e.x, e.y), 3.0);
          float grid = 0.97 + 0.03 * step(0.5, fract(vUv.x * 1024.0 / 2.0));
          gl_FragColor = vec4(c * vig * grid * uOn * 0.62, 1.0);
          #include <colorspace_fragment>
        }`,
      toneMapped: false,
    });
    this.render();
  }

  get latestObserverNote(): Note | undefined {
    for (let i = this.notes.length - 1; i >= 0; i--) if (this.notes[i].observer) return this.notes[i];
    return undefined;
  }

  /** A new note appears at the top of the list, already open. */
  addObserverMessage(text: string): void {
    this.notes.unshift({ title: 'untitled', date: 'now', body: [text], observer: true });
    this.selected = 0;
    this.mode = 'desktop';
    this.dirty = true;
  }

  ask(question: string): void {
    this.question = question;
    this.answered = null;
    this.mode = 'question';
    this.dirty = true;
  }

  /** Leave the question/dark screen and show the notes desktop again. */
  showDesktop(): void {
    this.mode = 'desktop';
    this.question = null;
    this.dirty = true;
  }

  setDark(dark: boolean): void {
    this.mode = dark ? 'dark' : 'desktop';
    this.dirty = true;
  }

  moveCursor(u: number, v: number): void {
    const x = Math.round(u * W);
    const y = Math.round((1 - v) * H);
    if (x !== this.cursor.x || y !== this.cursor.y) {
      this.cursor = { x, y };
      this.dirty = true;
    }
  }

  /** One pixel, without input. */
  nudgeCursor(px = 1): void {
    this.cursor.x += px;
    this.dirty = true;
  }

  setMinutes(m: number): void {
    const v = Math.floor(m);
    if (v !== this.fictionalMinutes) {
      this.fictionalMinutes = v;
      this.dirty = true;
    }
  }

  blink(on: boolean): void {
    if (on !== this.caretOn) {
      this.caretOn = on;
      if (this.notes[this.selected]?.observer || this.mode === 'question') this.dirty = true;
    }
  }

  click(u: number, v: number): ScreenAction {
    const x = u * W;
    const y = (1 - v) * H;
    for (const b of this.buttons) {
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
        if (b.action.kind === 'open') {
          this.selected = b.action.index;
          this.dirty = true;
        }
        if (b.action.kind === 'answer') {
          this.answered = b.action.value;
          this.dirty = true;
        }
        return b.action;
      }
    }
    return { kind: 'none' };
  }

  /** Position (u, v) of an on-screen button, for tests and accessibility. */
  buttonUv(kind: 'yes' | 'no' | number): { u: number; v: number } | null {
    for (const b of this.buttons) {
      const a = b.action;
      if ((a.kind === 'answer' && a.value === kind) || (a.kind === 'open' && a.index === kind)) {
        return { u: (b.x + b.w / 2) / W, v: 1 - (b.y + b.h / 2) / H };
      }
    }
    return null;
  }

  update(): void {
    if (this.dirty) this.render();
  }

  private render(): void {
    this.dirty = false;
    const c = this.ctx;
    this.buttons = [];
    if (this.mode === 'dark') {
      c.fillStyle = '#020203';
      c.fillRect(0, 0, W, H);
      this.texture.needsUpdate = true;
      return;
    }
    c.drawImage(this.wallpaper, 0, 0);
    // Top bar
    c.fillStyle = 'rgba(18,20,24,0.82)';
    c.fillRect(0, 0, W, 30);
    c.fillStyle = '#e8e8e8';
    c.font = '600 15px "Helvetica Neue", Arial, sans-serif';
    c.fillText('Notes', 16, 20);
    c.font = '400 15px "Helvetica Neue", Arial, sans-serif';
    c.fillText('File    Edit    View', 80, 20);
    const h = Math.floor(this.fictionalMinutes / 60) % 24;
    const m = this.fictionalMinutes % 60;
    const time = `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
    c.textAlign = 'right';
    c.fillText(time, W - 16, 20);
    c.textAlign = 'left';

    // Notes window
    const wx = 110;
    const wy = 70;
    const ww = 800;
    const wh = 500;
    c.fillStyle = 'rgba(0,0,0,0.35)';
    c.fillRect(wx + 6, wy + 8, ww, wh);
    c.fillStyle = '#f6f5f2';
    c.fillRect(wx, wy, ww, wh);
    c.fillStyle = '#e4e2dc';
    c.fillRect(wx, wy, ww, 34);
    c.fillStyle = '#3a3a3a';
    c.font = '600 15px "Helvetica Neue", Arial, sans-serif';
    c.fillText('Notes', wx + 16, wy + 22);
    for (const [i, col] of ['#c5c2bb', '#c5c2bb', '#c5c2bb'].entries()) {
      c.fillStyle = col;
      c.beginPath();
      c.arc(wx + ww - 20 - i * 22, wy + 17, 6, 0, Math.PI * 2);
      c.fill();
    }
    // Sidebar
    const sw = 250;
    c.fillStyle = '#ecebe7';
    c.fillRect(wx, wy + 34, sw, wh - 34);
    this.notes.slice(0, 9).forEach((n, i) => {
      const y = wy + 44 + i * 50;
      if (i === this.selected) {
        c.fillStyle = '#1f1f1f';
        c.fillRect(wx + 8, y, sw - 16, 44);
      }
      c.fillStyle = i === this.selected ? '#ffffff' : '#1f1f1f';
      c.font = '600 16px "Helvetica Neue", Arial, sans-serif';
      c.fillText(n.title, wx + 20, y + 20);
      c.fillStyle = i === this.selected ? '#cfcfcf' : '#6a6a6a';
      c.font = '400 13px "Helvetica Neue", Arial, sans-serif';
      c.fillText(`${n.date}  ${n.body[0].slice(0, 22)}`, wx + 20, y + 37);
      this.buttons.push({ x: wx + 8, y, w: sw - 16, h: 44, action: { kind: 'open', index: i } });
    });
    // Content
    const cx = wx + sw + 34;
    const note = this.notes[this.selected];
    if (this.mode === 'question' && this.question) {
      c.fillStyle = '#111';
      c.font = '500 34px Georgia, serif';
      c.fillText(this.question, cx, wy + 120);
      const by = wy + 190;
      const yes = { x: cx, y: by, w: 140, h: 52 };
      const no = { x: cx + 160, y: by, w: 140, h: 52 };
      for (const [b, label, val] of [[yes, 'Yes', 'yes'], [no, 'No', 'no']] as const) {
        const chosen = this.answered === val;
        c.fillStyle = chosen ? '#5a5a5a' : '#141414';
        c.fillRect(b.x, b.y, b.w, b.h);
        c.fillStyle = '#ffffff';
        c.font = '600 20px "Helvetica Neue", Arial, sans-serif';
        c.textAlign = 'center';
        c.fillText(label, b.x + b.w / 2, b.y + 33);
        c.textAlign = 'left';
        this.buttons.push({ ...b, action: { kind: 'answer', value: val } });
      }
      if (this.answered) {
        c.fillStyle = '#666';
        c.font = '400 16px "Helvetica Neue", Arial, sans-serif';
        c.fillText(this.answered === 'yes' ? 'yes' : 'no', cx, by + 92);
      }
    } else if (note) {
      c.fillStyle = '#8a8a8a';
      c.font = '400 13px "Helvetica Neue", Arial, sans-serif';
      c.fillText(note.date === 'now' ? 'Today' : note.date, cx, wy + 66);
      c.fillStyle = '#141414';
      c.font = note.observer ? '400 26px Georgia, serif' : '600 24px "Helvetica Neue", Arial, sans-serif';
      if (!note.observer) c.fillText(note.title, cx, wy + 104);
      c.font = note.observer ? '400 26px Georgia, serif' : '400 18px "Helvetica Neue", Arial, sans-serif';
      let y = note.observer ? wy + 120 : wy + 146;
      let lastX = cx;
      for (const line of note.body) {
        for (const wrapped of wrap(c, line, ww - sw - 70)) {
          c.fillText(wrapped, cx, y);
          lastX = cx + c.measureText(wrapped).width;
          y += note.observer ? 38 : 30;
        }
      }
      if (note.observer && this.caretOn) {
        c.fillStyle = '#141414';
        c.fillRect(lastX + 4, y - (note.observer ? 38 : 30) - 22, 2, 28);
      }
    }
    // Fictional cursor (inside the fictional screen only).
    drawCursor(c, this.cursor.x, this.cursor.y);
    this.texture.needsUpdate = true;
  }
}

function wrap(c: CanvasRenderingContext2D, text: string, max: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (c.measureText(t).width > max && line) {
      lines.push(line);
      line = w;
    } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}

function drawCursor(c: CanvasRenderingContext2D, x: number, y: number): void {
  c.save();
  c.translate(x, y);
  c.beginPath();
  c.moveTo(0, 0);
  c.lineTo(0, 22);
  c.lineTo(6, 17);
  c.lineTo(10, 26);
  c.lineTo(14, 24);
  c.lineTo(10, 15);
  c.lineTo(17, 15);
  c.closePath();
  c.fillStyle = '#ffffff';
  c.fill();
  c.strokeStyle = '#000000';
  c.lineWidth = 1.5;
  c.stroke();
  c.restore();
}

function makeWallpaper(): HTMLCanvasElement {
  const [c, ctx] = canvas(W, H);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#41566a');
  g.addColorStop(0.6, '#8a98a0');
  g.addColorStop(1, '#5d6650');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(40,52,44,0.85)';
  ctx.beginPath();
  ctx.moveTo(0, H * 0.72);
  for (let x = 0; x <= W; x += 32) ctx.lineTo(x, H * 0.68 - Math.sin(x * 0.006) * 40 - Math.sin(x * 0.021) * 12);
  ctx.lineTo(W, H);
  ctx.lineTo(0, H);
  ctx.fill();
  return c;
}
