import { Rng } from '../core/rng';
import type { AmbientLayer, SoundId } from './sounds';

/**
 * Procedural sound synthesis. Every sound in the experience is generated here
 * at startup from noise, resonant filters and envelopes, so nothing is
 * streamed or decoded during play.
 */

type Buf = Float32Array;

function biquad(x: Buf, type: 'lp' | 'hp' | 'bp', f: number, q: number, sr: number): Buf {
  const w0 = (2 * Math.PI * f) / sr;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  let b0: number, b1: number, b2: number;
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  if (type === 'lp') {
    b0 = (1 - cos) / 2;
    b1 = 1 - cos;
    b2 = (1 - cos) / 2;
  } else if (type === 'hp') {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
  } else {
    b0 = alpha;
    b1 = 0;
    b2 = -alpha;
  }
  const y = new Float32Array(x.length);
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = (b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    y[i] = yi;
    x2 = x1;
    x1 = xi;
    y2 = y1;
    y1 = yi;
  }
  return y;
}

/** Time-varying bandpass (for creaks and scrapes). */
function sweepBp(x: Buf, f: (t: number) => number, q: number, sr: number): Buf {
  const y = new Float32Array(x.length);
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const w0 = (2 * Math.PI * f(i / sr)) / sr;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    const yi = (alpha * x[i] - alpha * x2 + 2 * cos * y1 - (1 - alpha) * y2) / a0;
    y[i] = yi;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = yi;
  }
  return y;
}

const noise = (n: number, rng: Rng): Buf => {
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) b[i] = rng.next() * 2 - 1;
  return b;
};

const brown = (n: number, rng: Rng): Buf => {
  const b = new Float32Array(n);
  let last = 0;
  for (let i = 0; i < n; i++) {
    last = (last + 0.02 * (rng.next() * 2 - 1)) / 1.02;
    b[i] = last * 3.5;
  }
  return b;
};

const env = (x: Buf, sr: number, attack: number, decay: number, hold = 0): Buf => {
  for (let i = 0; i < x.length; i++) {
    const t = i / sr;
    const a = t < attack ? t / attack : 1;
    const d = t < attack + hold ? 1 : Math.exp(-(t - attack - hold) / decay);
    x[i] *= a * d;
  }
  return x;
};

const mix = (...parts: [Buf, number][]): Buf => {
  const n = Math.max(...parts.map(([b]) => b.length));
  const out = new Float32Array(n);
  for (const [b, g] of parts) for (let i = 0; i < b.length; i++) out[i] += b[i] * g;
  return out;
};

const tone = (n: number, sr: number, freq: number, decay: number, phase = 0): Buf => {
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) b[i] = Math.sin((2 * Math.PI * freq * i) / sr + phase) * Math.exp(-i / sr / decay);
  return b;
};

const offset = (b: Buf, sr: number, sec: number): Buf => {
  const o = Math.floor(sec * sr);
  const out = new Float32Array(b.length + o);
  out.set(b, o);
  return out;
};

const normalize = (b: Buf, peak = 0.9): Buf => {
  let m = 0;
  for (const v of b) m = Math.max(m, Math.abs(v));
  if (m > 0) for (let i = 0; i < b.length; i++) b[i] *= peak / m;
  return b;
};

/** Small-room early reflections baked into a one-shot. */
const roomify = (b: Buf, sr: number, amount = 0.25): Buf => {
  const taps = [0.011, 0.017, 0.023, 0.031, 0.043];
  const out = new Float32Array(b.length + Math.floor(0.06 * sr));
  out.set(b);
  taps.forEach((t, k) => {
    const o = Math.floor(t * sr);
    const g = amount * Math.pow(0.7, k);
    for (let i = 0; i < b.length; i++) out[i + o] += b[i] * g;
  });
  return out;
};

function stickSlip(n: number, sr: number, rng: Rng, rate: number): Buf {
  const b = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    phase += (rate * (0.6 + rng.next() * 0.8)) / sr;
    if (phase >= 1) phase -= 1;
    b[i] = phase < 0.08 ? 1 - phase / 0.08 : 0;
  }
  return b;
}

export function synthesize(id: SoundId, sr: number, seed = 1): Buf {
  const rng = new Rng(seed + id.length * 131);
  const S = (sec: number) => Math.floor(sec * sr);
  switch (id) {
    case 'tick':
      return normalize(mix([env(biquad(noise(S(0.03), rng), 'bp', 3200, 3, sr), sr, 0.0005, 0.004), 1], [tone(S(0.03), sr, 2200, 0.006), 0.4]), 0.5);
    case 'tock':
      return normalize(mix([env(biquad(noise(S(0.035), rng), 'bp', 1900, 3, sr), sr, 0.0005, 0.005), 1], [tone(S(0.035), sr, 1300, 0.008), 0.45]), 0.5);
    case 'drawer_open': {
      const n = S(0.5);
      const slide = env(sweepBp(brown(n, rng), (t) => 500 + 300 * Math.sin(t * 6), 1.8, sr), sr, 0.05, 0.25, 0.15);
      const rattle = env(biquad(stickSlip(n, sr, rng, 38), 'bp', 900, 4, sr), sr, 0.03, 0.2, 0.15);
      return normalize(roomify(mix([slide, 1], [rattle, 0.35]), sr), 0.7);
    }
    case 'drawer_close': {
      const slide = env(sweepBp(brown(S(0.22), rng), () => 600, 1.8, sr), sr, 0.02, 0.08, 0.06);
      const thunk = mix([tone(S(0.15), sr, 110, 0.04), 1], [env(biquad(noise(S(0.05), rng), 'bp', 1400, 2, sr), sr, 0.001, 0.01), 0.5]);
      return normalize(roomify(mix([slide, 0.7], [offset(thunk, sr, 0.17), 1]), sr), 0.8);
    }
    case 'lamp_click': {
      const c = () => env(biquad(noise(S(0.02), rng), 'hp', 2500, 1, sr), sr, 0.0003, 0.002);
      return normalize(mix([c(), 1], [offset(c(), sr, 0.014), 0.7]), 0.6);
    }
    case 'book_lift':
      return normalize(env(biquad(noise(S(0.25), rng), 'bp', 2400, 0.8, sr), sr, 0.03, 0.08, 0.04), 0.35);
    case 'book_place':
      return normalize(roomify(mix([tone(S(0.12), sr, 150, 0.03), 1], [env(biquad(noise(S(0.06), rng), 'lp', 1800, 0.7, sr), sr, 0.001, 0.015), 0.6]), sr), 0.7);
    case 'paper': {
      const n = S(0.35);
      const crackle = noise(n, rng).map((v) => (rng.next() < 0.04 ? v * 3 : v * 0.3));
      return normalize(env(biquad(crackle, 'hp', 3000, 0.7, sr), sr, 0.02, 0.12, 0.08), 0.35);
    }
    case 'chair_scrape':
    case 'scrape': {
      const n = S(id === 'scrape' ? 0.45 : 0.7);
      const ss = stickSlip(n, sr, rng, 70);
      const body = sweepBp(mix([ss, 1], [brown(n, rng), 0.4]), (t) => 520 - t * 160, 6, sr);
      return normalize(roomify(env(body, sr, 0.05, 0.18, n / sr - 0.3), sr, 0.3), 0.7);
    }
    case 'chair_creak':
    case 'door_creak':
    case 'creak': {
      const dur = id === 'door_creak' ? 1.4 : id === 'creak' ? 1.0 : 0.6;
      const n = S(dur);
      const rate = id === 'creak' ? 28 : 45;
      const pulses = stickSlip(n, sr, rng, rate);
      const f0 = id === 'creak' ? 380 : 760;
      const body = sweepBp(pulses, (t) => f0 + Math.sin(t * 3.3) * 120 + t * 90, 9, sr);
      return normalize(roomify(env(body, sr, 0.08, dur * 0.35, dur * 0.45), sr, 0.35), 0.65);
    }
    case 'door_handle': {
      const n = S(0.25);
      const metal = mix([tone(n, sr, 1240, 0.05), 0.6], [tone(n, sr, 2710, 0.03), 0.4], [tone(n, sr, 3930, 0.02), 0.3]);
      const click = env(biquad(noise(S(0.02), rng), 'bp', 3000, 2, sr), sr, 0.0005, 0.004);
      return normalize(mix([metal, 0.7], [click, 1], [offset(click, sr, 0.12), 0.6]), 0.6);
    }
    case 'door_close': {
      const thump = mix([tone(S(0.3), sr, 70, 0.08), 1], [biquad(env(noise(S(0.1), rng), sr, 0.001, 0.03), 'lp', 600, 0.7, sr), 0.6]);
      const latch = env(biquad(noise(S(0.03), rng), 'bp', 2500, 3, sr), sr, 0.0005, 0.005);
      return normalize(roomify(mix([thump, 1], [offset(latch, sr, 0.04), 0.5]), sr, 0.4), 0.85);
    }
    case 'cup_clink': {
      const n = S(0.35);
      return normalize(mix([tone(n, sr, 2110, 0.09), 0.6], [tone(n, sr, 3350, 0.06), 0.4], [tone(n, sr, 5230, 0.03), 0.3]), 0.5);
    }
    case 'curtain':
      return normalize(env(biquad(noise(S(0.7), rng), 'bp', 3200, 0.6, sr), sr, 0.12, 0.2, 0.25), 0.3);
    case 'key_tap':
      return normalize(env(biquad(noise(S(0.02), rng), 'bp', 2200, 2, sr), sr, 0.0005, 0.004), 0.4);
    case 'footstep': {
      const heel = mix([tone(S(0.2), sr, 82, 0.05), 1], [env(biquad(noise(S(0.05), rng), 'lp', 900, 0.8, sr), sr, 0.001, 0.012), 0.7]);
      const board = env(sweepBp(stickSlip(S(0.25), sr, rng, 30), () => 300, 8, sr), sr, 0.01, 0.06);
      return normalize(roomify(mix([heel, 1], [offset(board, sr, 0.03), 0.25]), sr, 0.45), 0.8);
    }
    case 'wood_click':
      return normalize(roomify(mix([tone(S(0.08), sr, 640, 0.02), 1], [env(biquad(noise(S(0.03), rng), 'bp', 1800, 3, sr), sr, 0.0005, 0.004), 0.6]), sr), 0.6);
    case 'knock_soft': {
      const k = () => mix([tone(S(0.12), sr, 160, 0.03), 1], [env(biquad(noise(S(0.03), rng), 'lp', 1200, 0.8, sr), sr, 0.001, 0.008), 0.5]);
      return normalize(roomify(mix([k(), 1], [offset(k(), sr, 0.28), 0.85]), sr, 0.4), 0.7);
    }
    case 'thump':
      return normalize(roomify(mix([tone(S(0.4), sr, 55, 0.12), 1], [biquad(env(noise(S(0.15), rng), sr, 0.002, 0.04), 'lp', 400, 0.7, sr), 0.6]), sr, 0.5), 0.9);
    case 'electrical_tick': {
      const n = S(0.14);
      const c = noise(n, rng).map((v) => (rng.next() < 0.06 ? v : 0));
      return normalize(mix([biquad(c, 'hp', 1500, 0.7, sr), 1], [env(tone(n, sr, 120, 0.05), sr, 0.001, 0.05), 0.3]), 0.45);
    }
    case 'notify':
      return normalize(env(tone(S(0.25), sr, 880, 0.08), sr, 0.01, 0.06), 0.15);
    case 'glass_tap':
      return normalize(mix([tone(S(0.2), sr, 3100, 0.04), 0.6], [tone(S(0.2), sr, 4700, 0.03), 0.4]), 0.4);
  }
}

/** Seamless ambient loops (cross-faded ends). */
export function synthesizeLayer(layer: AmbientLayer, sr: number): Buf {
  const rng = new Rng(layer.length * 977);
  const dur = layer === 'traffic' ? 24 : 10;
  const n = Math.floor(dur * sr);
  let b: Buf;
  switch (layer) {
    case 'room_tone':
      b = biquad(biquad(brown(n, rng), 'lp', 180, 0.7, sr), 'hp', 25, 0.7, sr);
      b = normalize(b, 0.5);
      break;
    case 'traffic': {
      const base = biquad(brown(n, rng), 'lp', 420, 0.7, sr);
      const swell = new Float32Array(n);
      const passes = [3.5, 11.2, 17.8];
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        let s = 0.55 + 0.15 * Math.sin(t * 0.37) + 0.1 * Math.sin(t * 0.91 + 1);
        for (const p of passes) s += 0.7 * Math.exp(-((t - p) ** 2) / 2.2);
        swell[i] = base[i] * s;
      }
      b = normalize(swell, 0.6);
      break;
    }
    case 'fan': {
      const motor = mix([tone(n, sr, 58, 1e9), 0.3], [tone(n, sr, 116, 1e9, 1), 0.08]);
      const air = biquad(noise(n, rng), 'bp', 420, 0.5, sr);
      const chopped = new Float32Array(n);
      for (let i = 0; i < n; i++) chopped[i] = air[i] * (0.65 + 0.35 * Math.sin((2 * Math.PI * 3.5 * i) / sr));
      b = normalize(mix([motor, 1], [chopped, 0.8]), 0.45);
      break;
    }
    case 'hum':
      b = normalize(mix([tone(n, sr, 60, 1e9), 0.6], [tone(n, sr, 120, 1e9, 0.5), 0.25], [tone(n, sr, 180, 1e9, 1.1), 0.12], [biquad(noise(n, rng), 'bp', 120, 2, sr), 0.05]), 0.25);
      break;
  }
  // Crossfade the last 0.5 s into the start for a seamless loop.
  const xf = Math.floor(0.5 * sr);
  for (let i = 0; i < xf; i++) {
    const a = i / xf;
    b[i] = b[i] * a + b[n - xf + i] * (1 - a);
  }
  return b.slice(0, n - xf);
}
