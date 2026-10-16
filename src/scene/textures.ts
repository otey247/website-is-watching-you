import { CanvasTexture, ClampToEdgeWrapping, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, SRGBColorSpace, type Texture } from 'three';
import { Rng } from '../core/rng';

/**
 * Procedural textures. Everything is generated once at load: no texture is
 * created during play, so anomalies never wait on texture uploads.
 */

export function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

export function toTexture(c: HTMLCanvasElement, opts: { repeat?: [number, number]; srgb?: boolean; anisotropy?: number } = {}): CanvasTexture {
  const t = new CanvasTexture(c);
  if (opts.srgb !== false) t.colorSpace = SRGBColorSpace;
  if (opts.repeat) {
    t.wrapS = t.wrapT = RepeatWrapping;
    t.repeat.set(...opts.repeat);
  } else {
    t.wrapS = t.wrapT = ClampToEdgeWrapping;
  }
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.anisotropy = opts.anisotropy ?? 8;
  return t;
}

/** Value noise for organic variation. */
function makeNoise(seed: number) {
  const rng = new Rng(seed);
  const perm = new Float32Array(512);
  for (let i = 0; i < 512; i++) perm[i] = rng.next();
  const v = (x: number, y: number) => perm[((x & 255) + ((y & 255) * 31)) & 511];
  return (x: number, y: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const w = yf * yf * (3 - 2 * yf);
    const a = v(xi, yi);
    const b = v(xi + 1, yi);
    const c = v(xi, yi + 1);
    const d = v(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * w + (a - b - c + d) * u * w;
  };
}

function fbm(n: (x: number, y: number) => number, x: number, y: number, oct = 4): number {
  let s = 0;
  let a = 0.5;
  let f = 1;
  for (let i = 0; i < oct; i++) {
    s += a * n(x * f, y * f);
    f *= 2;
    a *= 0.5;
  }
  return s;
}

/** Wood with long grain, rings and pores. Returns color and roughness canvases. */
export function woodTextures(
  seed: number,
  base: [number, number, number],
  opts: { w?: number; h?: number; planks?: number; grain?: number } = {},
): { map: Texture; rough: Texture } {
  const w = opts.w ?? 512;
  const h = opts.h ?? 512;
  const [c, ctx] = canvas(w, h);
  const [rc, rctx] = canvas(w, h);
  const img = ctx.createImageData(w, h);
  const rimg = rctx.createImageData(w, h);
  const n = makeNoise(seed);
  const rng = new Rng(seed + 7);
  const planks = opts.planks ?? 1;
  const grain = opts.grain ?? 1;
  const plankOffsets = Array.from({ length: planks }, () => rng.range(-0.08, 0.08));
  const plankPhase = Array.from({ length: planks }, () => rng.range(0, 100));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const pi = Math.min(planks - 1, Math.floor((x / w) * planks));
      const px = (x / w) * planks - pi;
      const yy = y / h + plankPhase[pi];
      const ring = Math.sin((fbm(n, px * 3, yy * 0.6 + pi * 9) * 18 + px * 4) * grain * 3.1);
      const fine = fbm(n, px * 60, yy * 4, 3);
      const pores = n(x * 0.9, y * 0.12) > 0.82 ? -0.08 : 0;
      let k = 0.82 + ring * 0.07 + (fine - 0.5) * 0.22 + pores + plankOffsets[pi];
      // plank seams
      if (planks > 1 && (px < 0.006 || px > 0.994)) k *= 0.55;
      const i = (y * w + x) * 4;
      img.data[i] = Math.min(255, base[0] * k);
      img.data[i + 1] = Math.min(255, base[1] * k);
      img.data[i + 2] = Math.min(255, base[2] * k);
      img.data[i + 3] = 255;
      const r = 150 + (fine - 0.5) * 70 - ring * 12 + (pores ? 40 : 0);
      rimg.data[i] = rimg.data[i + 1] = rimg.data[i + 2] = r;
      rimg.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  rctx.putImageData(rimg, 0, 0);
  return { map: toTexture(c), rough: toTexture(rc, { srgb: false }) };
}

/** Painted wall with subtle roller texture and a few marks. */
export function wallTexture(seed: number, base: [number, number, number]): { map: Texture; rough: Texture } {
  const s = 512;
  const [c, ctx] = canvas(s, s);
  const [rc, rctx] = canvas(s, s);
  const img = ctx.createImageData(s, s);
  const rimg = rctx.createImageData(s, s);
  const n = makeNoise(seed);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const v = fbm(n, x / 40, y / 40, 4);
      const stipple = n(x * 1.7, y * 1.7) * 0.05;
      const k = 0.93 + (v - 0.5) * 0.1 + stipple;
      const i = (y * s + x) * 4;
      img.data[i] = base[0] * k;
      img.data[i + 1] = base[1] * k;
      img.data[i + 2] = base[2] * k;
      img.data[i + 3] = 255;
      rimg.data[i] = rimg.data[i + 1] = rimg.data[i + 2] = 210 + (v - 0.5) * 40;
      rimg.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  rctx.putImageData(rimg, 0, 0);
  return { map: toTexture(c, { repeat: [2, 1] }), rough: toTexture(rc, { srgb: false, repeat: [2, 1] }) };
}

/**
 * Baked ambient occlusion for a wall: darker toward the floor, ceiling and
 * corners. Applied as aoMap on uv channel 0.
 */
export function wallAO(): Texture {
  const w = 256;
  const h = 128;
  const [c, ctx] = canvas(w, h);
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / (w - 1);
      const v = y / (h - 1);
      const edgeX = Math.min(u, 1 - u) * 5.0; // corners
      const floor = (1 - v) * 3.2; // canvas y=0 is top -> ceiling; v→1 floor
      const ceil = v * 6.5;
      const ao = Math.min(1, 0.55 + 0.45 * Math.min(1, edgeX)) * Math.min(1, 0.62 + 0.38 * Math.min(1, floor)) * Math.min(1, 0.75 + 0.25 * Math.min(1, ceil));
      const i = (y * w + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = ao * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(c, { srgb: false });
}

/** Radial soft blob used for baked contact shadows. */
export function blobShadow(): Texture {
  const s = 128;
  const [c, ctx] = canvas(s, s);
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(0,0,0,0.75)');
  g.addColorStop(0.45, 'rgba(0,0,0,0.42)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  return toTexture(c, { srgb: false });
}

export function fabricTexture(seed: number, base: [number, number, number], weave = 3): { map: Texture; rough: Texture } {
  const s = 256;
  const [c, ctx] = canvas(s, s);
  const img = ctx.createImageData(s, s);
  const n = makeNoise(seed);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const wv = (Math.sin(x * weave) * Math.sin(y * weave) + 1) * 0.03;
      const slub = (fbm(n, x / 12, y / 90) - 0.5) * 0.12;
      const k = 0.9 + wv + slub;
      const i = (y * s + x) * 4;
      img.data[i] = base[0] * k;
      img.data[i + 1] = base[1] * k;
      img.data[i + 2] = base[2] * k;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const map = toTexture(c, { repeat: [3, 3] });
  const [rc, rctx] = canvas(4, 4);
  rctx.fillStyle = '#ececec';
  rctx.fillRect(0, 0, 4, 4);
  return { map, rough: toTexture(rc, { srgb: false }) };
}

export function rugTexture(): Texture {
  const s = 512;
  const [c, ctx] = canvas(s, s);
  ctx.fillStyle = '#6d2f2a';
  ctx.fillRect(0, 0, s, s);
  ctx.strokeStyle = '#c9a77a';
  ctx.lineWidth = 10;
  ctx.strokeRect(26, 26, s - 52, s - 52);
  ctx.strokeStyle = '#2f3a4a';
  ctx.lineWidth = 18;
  ctx.strokeRect(56, 56, s - 112, s - 112);
  ctx.fillStyle = '#8a4a3a';
  for (let i = 0; i < 6; i++) {
    ctx.save();
    ctx.translate(s / 2, s / 2);
    ctx.rotate((i / 6) * Math.PI * 2);
    ctx.beginPath();
    ctx.ellipse(0, 90, 28, 70, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.fillStyle = '#c9a77a';
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, 40, 0, Math.PI * 2);
  ctx.fill();
  const img = ctx.getImageData(0, 0, s, s);
  const rng = new Rng(77);
  for (let i = 0; i < img.data.length; i += 4) {
    const k = 0.82 + rng.next() * 0.22;
    img.data[i] *= k;
    img.data[i + 1] *= k;
    img.data[i + 2] *= k;
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(c);
}

export function bookSpine(seed: number, color: string, title: string): Texture {
  const [c, ctx] = canvas(64, 256);
  const rng = new Rng(seed);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 64, 256);
  const img = ctx.getImageData(0, 0, 64, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const k = 0.85 + rng.next() * 0.2;
    img.data[i] *= k;
    img.data[i + 1] *= k;
    img.data[i + 2] *= k;
  }
  ctx.putImageData(img, 0, 0);
  ctx.fillStyle = 'rgba(230,210,160,0.85)';
  ctx.fillRect(0, 22, 64, 4);
  ctx.fillRect(0, 230, 64, 4);
  ctx.save();
  ctx.translate(38, 128);
  ctx.rotate(-Math.PI / 2);
  ctx.font = '600 17px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.fillText(title, 0, 0);
  ctx.restore();
  return toTexture(c);
}

export function clockFace(): Texture {
  const s = 512;
  const [c, ctx] = canvas(s, s);
  ctx.fillStyle = '#efe9dc';
  ctx.fillRect(0, 0, s, s);
  const g = ctx.createRadialGradient(s / 2, s / 2, 60, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(90,70,40,0.25)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  ctx.translate(s / 2, s / 2);
  ctx.fillStyle = '#1d1b18';
  for (let i = 0; i < 60; i++) {
    ctx.save();
    ctx.rotate((i / 60) * Math.PI * 2);
    const major = i % 5 === 0;
    ctx.fillRect(-(major ? 5 : 2), -230, major ? 10 : 4, major ? 34 : 14);
    ctx.restore();
  }
  ctx.font = '600 54px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let h = 1; h <= 12; h++) {
    const a = (h / 12) * Math.PI * 2;
    ctx.fillText(String(h), Math.sin(a) * 160, -Math.cos(a) * 160);
  }
  ctx.font = '400 20px Georgia, serif';
  ctx.fillStyle = '#5b5345';
  ctx.fillText('HALDEN & SONS', 0, 70);
  return toTexture(c);
}

export function noteTexture(): Texture {
  const [c, ctx] = canvas(512, 640);
  ctx.fillStyle = '#f3eedf';
  ctx.fillRect(0, 0, 512, 640);
  ctx.strokeStyle = 'rgba(80,120,180,0.25)';
  ctx.lineWidth = 2;
  for (let y = 120; y < 640; y += 44) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(512, y);
    ctx.stroke();
  }
  ctx.fillStyle = '#26324a';
  ctx.font = 'italic 34px "Segoe Print", "Bradley Hand", "Comic Sans MS", cursive';
  const lines = ['Back by six.', 'Fed the cat (she says', 'she wasn’t fed).', 'Don’t move the chair,', 'the floor scratches.', '— M'];
  lines.forEach((l, i) => ctx.fillText(l, 36, 108 + i * 44, 450));
  const rng = new Rng(9);
  const img = ctx.getImageData(0, 0, 512, 640);
  for (let i = 0; i < img.data.length; i += 4) {
    const k = 0.95 + rng.next() * 0.06;
    img.data[i] *= k;
    img.data[i + 1] *= k;
    img.data[i + 2] *= k;
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(c);
}

/** Night-ish city/garden backdrop seen through the window. */
export function outsideTexture(): Texture {
  const [c, ctx] = canvas(1024, 512);
  const sky = ctx.createLinearGradient(0, 0, 0, 512);
  sky.addColorStop(0, '#9fb8cf');
  sky.addColorStop(0.55, '#d9dfd9');
  sky.addColorStop(1, '#e9dcc0');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 1024, 512);
  const rng = new Rng(4);
  // Distant buildings
  ctx.fillStyle = 'rgba(120,130,140,0.55)';
  let x = 0;
  while (x < 1024) {
    const w = rng.range(50, 120);
    const h = rng.range(80, 210);
    ctx.fillRect(x, 330 - h, w, h + 200);
    x += w + rng.range(4, 20);
  }
  // Trees
  ctx.filter = 'blur(3px)';
  for (let i = 0; i < 26; i++) {
    ctx.fillStyle = `rgba(${50 + rng.int(0, 30)},${80 + rng.int(0, 30)},${55 + rng.int(0, 20)},0.95)`;
    ctx.beginPath();
    ctx.ellipse(rng.range(0, 1024), rng.range(330, 400), rng.range(40, 90), rng.range(50, 110), 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.filter = 'none';
  ctx.fillStyle = '#6b7259';
  ctx.fillRect(0, 410, 1024, 102);
  return toTexture(c);
}

export function paperTexture(color = '#f4f0e6'): Texture {
  const [c, ctx] = canvas(64, 64);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 64, 64);
  return toTexture(c);
}
