import { Rng } from '../core/rng';
import { canvas, toTexture } from './textures';
import type { Texture } from 'three';

/**
 * Paints the family photograph and its curated garden variants.
 * All variants share the same garden plate (same seed), so the only
 * difference between two variants is the people, exactly as on film.
 */

interface Person {
  id: 'mother' | 'child' | 'father';
  x: number;
  height: number;
  coat: string;
  hair: string;
  skin: string;
  /** -1 looks left, 1 looks right, 0 looks at the camera. */
  face: number;
  depth: number;
}

const BASE: Person[] = [
  { id: 'mother', x: 0.34, height: 0.5, coat: '#3e4b3a', hair: '#4a3324', skin: '#d8b49a', face: 1, depth: 0 },
  { id: 'child', x: 0.5, height: 0.33, coat: '#8e3b31', hair: '#5a3d26', skin: '#e1bea2', face: 1, depth: 0 },
  { id: 'father', x: 0.65, height: 0.55, coat: '#55565a', hair: '#2b2622', skin: '#d0a58a', face: -1, depth: 0 },
];

export type GardenComposition = 'original' | 'shifted' | 'removed' | 'empty';

function composition(kind: GardenComposition, gaze: boolean): Person[] {
  let people = BASE.map((p) => ({ ...p }));
  if (kind === 'shifted') {
    // The child now stands apart, further back near the hedge.
    const c = people.find((p) => p.id === 'child')!;
    c.x = 0.17;
    c.depth = 0.06;
    c.height = 0.29;
    c.face = 1;
  }
  if (kind === 'removed') people = people.filter((p) => p.id !== 'child');
  if (kind === 'empty') people = [];
  if (gaze) {
    const f = people.find((p) => p.id === 'father');
    if (f) f.face = 0;
  }
  return people;
}

function paintGarden(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const rng = new Rng(1987);
  const sky = ctx.createLinearGradient(0, 0, 0, h * 0.45);
  sky.addColorStop(0, '#b9c4c4');
  sky.addColorStop(1, '#e6e1cf');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  // Distant trees
  ctx.filter = 'blur(4px)';
  for (let i = 0; i < 18; i++) {
    ctx.fillStyle = `rgb(${70 + rng.int(0, 25)},${88 + rng.int(0, 25)},${62 + rng.int(0, 15)})`;
    ctx.beginPath();
    ctx.ellipse(rng.range(-20, w + 20), rng.range(h * 0.18, h * 0.34), rng.range(40, 90), rng.range(40, 80), 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.filter = 'blur(1.5px)';
  // Hedge
  ctx.fillStyle = '#4c5f3f';
  ctx.fillRect(0, h * 0.33, w, h * 0.17);
  for (let i = 0; i < 160; i++) {
    ctx.fillStyle = `rgba(${40 + rng.int(0, 40)},${60 + rng.int(0, 40)},${35 + rng.int(0, 20)},0.8)`;
    ctx.beginPath();
    ctx.arc(rng.range(0, w), rng.range(h * 0.31, h * 0.5), rng.range(4, 12), 0, Math.PI * 2);
    ctx.fill();
  }
  // Lawn
  const lawn = ctx.createLinearGradient(0, h * 0.48, 0, h);
  lawn.addColorStop(0, '#7a8a58');
  lawn.addColorStop(1, '#5b6a3e');
  ctx.fillStyle = lawn;
  ctx.fillRect(0, h * 0.48, w, h * 0.52);
  // Path
  ctx.fillStyle = '#b9ad94';
  ctx.beginPath();
  ctx.moveTo(w * 0.43, h * 0.5);
  ctx.lineTo(w * 0.55, h * 0.5);
  ctx.lineTo(w * 0.78, h);
  ctx.lineTo(w * 0.2, h);
  ctx.closePath();
  ctx.fill();
  // Flowers
  ctx.filter = 'none';
  for (let i = 0; i < 90; i++) {
    const x = rng.chance(0.5) ? rng.range(0, w * 0.22) : rng.range(w * 0.8, w);
    ctx.fillStyle = rng.pick(['#d9c6a0', '#c98a7b', '#e8e0d0', '#b46a6a']);
    ctx.fillRect(x, rng.range(h * 0.52, h * 0.95), 3, 3);
  }
  // Garden chair at right, for scale
  ctx.fillStyle = '#d9d2c2';
  const cx = w * 0.85;
  const cy = h * 0.6;
  // Backrest slats and rear legs
  ctx.fillRect(cx, cy - h * 0.1, w * 0.008, h * 0.17);
  ctx.fillRect(cx + w * 0.045, cy - h * 0.1, w * 0.008, h * 0.17);
  for (let i = 0; i < 3; i++) ctx.fillRect(cx, cy - h * (0.095 - i * 0.03), w * 0.053, h * 0.009);
  // Seat, seen slightly from above
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + w * 0.053, cy);
  ctx.lineTo(cx + w * 0.072, cy + h * 0.022);
  ctx.lineTo(cx + w * 0.016, cy + h * 0.022);
  ctx.closePath();
  ctx.fill();
  // Front legs
  ctx.fillRect(cx + w * 0.016, cy + h * 0.02, w * 0.007, h * 0.07);
  ctx.fillRect(cx + w * 0.066, cy + h * 0.02, w * 0.007, h * 0.07);
}

function paintPerson(ctx: CanvasRenderingContext2D, p: Person, w: number, h: number): void {
  const groundY = h * (0.86 - p.depth);
  const H = p.height * h;
  const x = p.x * w;
  const shoulder = H * 0.27;
  const headR = H * 0.085;
  ctx.save();
  ctx.filter = 'blur(0.6px)';
  // Shadow on the lawn
  ctx.fillStyle = 'rgba(30,35,20,0.35)';
  ctx.beginPath();
  ctx.ellipse(x + H * 0.08, groundY, H * 0.16, H * 0.03, 0, 0, Math.PI * 2);
  ctx.fill();
  // Legs
  ctx.fillStyle = p.id === 'child' ? '#3a3f52' : '#2b2c33';
  ctx.fillRect(x - H * 0.07, groundY - H * 0.42, H * 0.06, H * 0.42);
  ctx.fillRect(x + H * 0.01, groundY - H * 0.42, H * 0.06, H * 0.42);
  // Coat / body
  ctx.fillStyle = p.coat;
  ctx.beginPath();
  ctx.moveTo(x - shoulder / 2, groundY - H * 0.8);
  ctx.quadraticCurveTo(x, groundY - H * 0.84, x + shoulder / 2, groundY - H * 0.8);
  ctx.lineTo(x + shoulder * 0.58, groundY - H * 0.36);
  ctx.lineTo(x - shoulder * 0.58, groundY - H * 0.36);
  ctx.closePath();
  ctx.fill();
  // Arms
  ctx.fillRect(x - shoulder * 0.62, groundY - H * 0.78, H * 0.05, H * 0.36);
  ctx.fillRect(x + shoulder * 0.62 - H * 0.05, groundY - H * 0.78, H * 0.05, H * 0.36);
  ctx.fillStyle = p.skin;
  ctx.beginPath();
  ctx.arc(x - shoulder * 0.6, groundY - H * 0.41, H * 0.025, 0, Math.PI * 2);
  ctx.arc(x + shoulder * 0.6, groundY - H * 0.41, H * 0.025, 0, Math.PI * 2);
  ctx.fill();
  // Neck + head
  const hy = groundY - H * 0.9;
  ctx.fillRect(x - H * 0.02, hy, H * 0.04, H * 0.07);
  ctx.beginPath();
  ctx.ellipse(x + p.face * headR * 0.15, hy, headR * 0.86, headR, 0, 0, Math.PI * 2);
  ctx.fill();
  // Hair
  ctx.fillStyle = p.hair;
  ctx.beginPath();
  if (p.face === 0) {
    ctx.ellipse(x, hy - headR * 0.45, headR * 0.92, headR * 0.6, 0, Math.PI, 0);
  } else {
    ctx.ellipse(x - p.face * headR * 0.3, hy - headR * 0.3, headR * 0.9, headR * 0.75, 0, Math.PI * 0.9, Math.PI * 2.1);
  }
  ctx.fill();
  if (p.id === 'mother') ctx.fillRect(x - headR * 0.95 - p.face * headR * 0.2, hy - headR * 0.4, headR * 0.5, headR * 1.6);
  // Face
  ctx.fillStyle = 'rgba(40,25,20,0.85)';
  if (p.face === 0) {
    // Looking at the viewer: both eyes, centered, slightly too dark.
    ctx.fillStyle = 'rgba(15,10,8,0.95)';
    ctx.beginPath();
    ctx.arc(x - headR * 0.33, hy - headR * 0.05, headR * 0.12, 0, Math.PI * 2);
    ctx.arc(x + headR * 0.33, hy - headR * 0.05, headR * 0.12, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(60,30,28,0.6)';
    ctx.fillRect(x - headR * 0.22, hy + headR * 0.42, headR * 0.44, headR * 0.06);
  } else {
    const fx = x + p.face * headR * 0.45;
    ctx.beginPath();
    ctx.arc(fx, hy - headR * 0.05, headR * 0.09, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(60,30,28,0.5)';
    ctx.fillRect(fx - headR * 0.12, hy + headR * 0.42, headR * 0.24, headR * 0.05);
  }
  ctx.restore();
}

/** Film look: warm fade, lifted blacks, vignette, grain. */
function filmGrade(ctx: CanvasRenderingContext2D, w: number, h: number, seed: number): void {
  const img = ctx.getImageData(0, 0, w, h);
  const rng = new Rng(seed);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let r = d[i] / 255;
      let g = d[i + 1] / 255;
      let b = d[i + 2] / 255;
      const lum = 0.3 * r + 0.59 * g + 0.11 * b;
      r = lum + (r - lum) * 0.72;
      g = lum + (g - lum) * 0.72;
      b = lum + (b - lum) * 0.72;
      r = 0.08 + r * 0.86 + 0.04;
      g = 0.07 + g * 0.84 + 0.02;
      b = 0.05 + b * 0.76;
      const vx = x / w - 0.5;
      const vy = y / h - 0.5;
      const v = 1 - Math.min(1, (vx * vx + vy * vy) * 1.6);
      const grain = (rng.next() - 0.5) * 0.06;
      d[i] = Math.max(0, Math.min(255, (r * v + grain) * 255));
      d[i + 1] = Math.max(0, Math.min(255, (g * v + grain) * 255));
      d[i + 2] = Math.max(0, Math.min(255, (b * v + grain) * 255));
    }
  }
  ctx.putImageData(img, 0, 0);
}

export type GardenKey = 'original' | 'shifted' | 'removed' | 'empty' | 'gazing_original' | 'gazing_shifted' | 'gazing_removed';

/** Pre-render every garden variant at load. */
export function paintGardenVariants(): Record<GardenKey, Texture> {
  const w = 640;
  const h = 480;
  const out = {} as Record<GardenKey, Texture>;
  const keys: [GardenKey, GardenComposition, boolean][] = [
    ['original', 'original', false],
    ['shifted', 'shifted', false],
    ['removed', 'removed', false],
    ['empty', 'empty', false],
    ['gazing_original', 'original', true],
    ['gazing_shifted', 'shifted', true],
    ['gazing_removed', 'removed', true],
  ];
  for (const [key, comp, gaze] of keys) {
    const [c, ctx] = canvas(w, h);
    paintGarden(ctx, w, h);
    for (const p of composition(comp, gaze).sort((a, b) => b.depth - a.depth)) paintPerson(ctx, p, w, h);
    filmGrade(ctx, w, h, 31);
    out[key] = toTexture(c);
  }
  return out;
}
