import { Audio, AudioListener, PositionalAudio, type Object3D } from 'three';
import type { V3 } from '../core/layout';
import type { Phase } from '../director/phaseMachine';
import { AMBIENT_LAYERS, SOUND_IDS, SUDDEN_SOUNDS, type AmbientLayer, type SoundId } from './sounds';
import { synthesize, synthesizeLayer } from './synth';

const SR = 44100;

/** Base gains for each ambient layer, per phase. Later phases are quieter, not louder. */
const PHASE_MIX: Record<Phase, Record<AmbientLayer, number>> = {
  normalcy: { room_tone: 0.22, traffic: 0.32, fan: 0.16, hum: 0.05 },
  inconsistency: { room_tone: 0.22, traffic: 0.29, fan: 0.16, hum: 0.06 },
  recognition: { room_tone: 0.24, traffic: 0.24, fan: 0.15, hum: 0.07 },
  anticipation: { room_tone: 0.26, traffic: 0.18, fan: 0.14, hum: 0.08 },
  confrontation: { room_tone: 0.3, traffic: 0.1, fan: 0.12, hum: 0.09 },
  resolution: { room_tone: 0.2, traffic: 0.2, fan: 0.12, hum: 0.04 },
};

/**
 * The audio director: positional one-shots from in-world sources, ambient
 * layers, the clock, intentional silence, and a small-room reverb. Audio only
 * starts after the player's first deliberate click (browser autoplay rules).
 */
export class AudioDirector {
  readonly listener: AudioListener;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<SoundId, AudioBuffer>();
  private raw = new Map<SoundId | AmbientLayer, Float32Array>();
  private pool: PositionalAudio[] = [];
  private poolIndex = 0;
  private layers = new Map<AmbientLayer, Audio<GainNode | PannerNode>>();
  private layerGain = new Map<AmbientLayer, number>();
  private phase: Phase = 'normalcy';
  private silenceUntil = 0;
  private silenceLevel = 1;
  private lastSecond = -1;
  private skipTicks = 0;
  started = false;
  volume = 0.8;
  muted = false;
  suddenEvents = true;
  /** Log of played sounds (dev inspector and tests). */
  readonly played: { id: SoundId; at: V3; t: number }[] = [];

  constructor(
    private readonly scene: Object3D,
    camera: Object3D,
    private readonly anchors: { fan: V3; window: V3; clock: V3 },
  ) {
    this.listener = new AudioListener();
    camera.add(this.listener);
    // Synthesize everything up front (plain arrays; no AudioContext needed yet).
    for (const id of SOUND_IDS) this.raw.set(id, synthesize(id, SR));
    for (const l of AMBIENT_LAYERS) this.raw.set(l, synthesizeLayer(l, SR));
  }

  /** Must be called from a user gesture. */
  async start(): Promise<void> {
    if (this.started) return;
    this.ctx = this.listener.context;
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => undefined);
    const ctx = this.ctx;
    for (const id of SOUND_IDS) this.buffers.set(id, this.toBuffer(this.raw.get(id)!));
    // Routing: listener → dry + reverb → master → destination
    const listenerOut = this.listener.getInput();
    listenerOut.disconnect();
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    const dry = ctx.createGain();
    dry.gain.value = 0.9;
    const wet = ctx.createGain();
    wet.gain.value = 0.18;
    const conv = ctx.createConvolver();
    conv.buffer = this.impulse(0.7);
    listenerOut.connect(dry);
    listenerOut.connect(conv);
    conv.connect(wet);
    dry.connect(this.master);
    wet.connect(this.master);
    this.master.connect(ctx.destination);

    for (let i = 0; i < 14; i++) {
      const p = new PositionalAudio(this.listener);
      p.setRefDistance(1.1);
      p.setRolloffFactor(1.3);
      p.setDistanceModel('inverse');
      p.panner.panningModel = 'HRTF';
      this.scene.add(p);
      this.pool.push(p);
    }
    for (const l of AMBIENT_LAYERS) {
      const buf = this.toBuffer(this.raw.get(l)!);
      let a: Audio<GainNode | PannerNode>;
      if (l === 'fan' || l === 'traffic') {
        const p = new PositionalAudio(this.listener);
        p.setRefDistance(l === 'traffic' ? 2.5 : 1.5);
        p.setRolloffFactor(0.6);
        const at = l === 'fan' ? this.anchors.fan : this.anchors.window;
        p.position.set(at[0], at[1], at[2]);
        this.scene.add(p);
        a = p;
      } else a = new Audio(this.listener) as Audio<GainNode | PannerNode>;
      a.setBuffer(buf);
      a.setLoop(true);
      a.setVolume(0);
      a.play();
      this.layers.set(l, a);
      this.layerGain.set(l, 0);
    }
    this.started = true;
  }

  private toBuffer(data: Float32Array): AudioBuffer {
    const b = this.ctx!.createBuffer(1, data.length, SR);
    b.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
    return b;
  }

  private impulse(sec: number): AudioBuffer {
    const ctx = this.ctx!;
    const n = Math.floor(sec * ctx.sampleRate);
    const b = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3.2) * (i < 40 ? i / 40 : 1);
    }
    return b;
  }

  play(id: SoundId, at: V3, gain = 0.5, rate = 1, now = 0): void {
    this.played.push({ id, at, t: now });
    if (this.played.length > 100) this.played.shift();
    if (!this.started) return;
    let g = gain;
    if (!this.suddenEvents && SUDDEN_SOUNDS.includes(id)) g *= 0.3;
    const p = this.pool[this.poolIndex];
    this.poolIndex = (this.poolIndex + 1) % this.pool.length;
    if (p.isPlaying) p.stop();
    p.position.set(at[0], at[1], at[2]);
    p.updateMatrixWorld();
    p.setBuffer(this.buffers.get(id)!);
    p.setVolume(Math.min(1, g));
    p.setPlaybackRate(rate * (0.97 + Math.random() * 0.06));
    p.play();
  }

  setPhase(p: Phase): void {
    this.phase = p;
  }

  /** Intentional silence: ambient layers fall away, then return slowly. */
  silence(ms: number, level: number, now: number): void {
    this.silenceUntil = now + ms;
    this.silenceLevel = level;
  }

  skipClock(ticks: number): void {
    this.skipTicks = ticks;
  }

  setVolume(v: number, muted: boolean): void {
    this.volume = v;
    this.muted = muted;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(muted ? 0 : v, this.ctx.currentTime, 0.05);
  }

  /** Called every frame with session time and the clock's displayed time. */
  update(now: number, dtSec: number, clockMs: number, clockStalled: boolean): void {
    if (!this.started) return;
    // Clock ticks follow the second hand.
    const sec = Math.floor(clockMs / 1000);
    if (sec !== this.lastSecond) {
      this.lastSecond = sec;
      if (this.skipTicks > 0) this.skipTicks--;
      else if (!clockStalled) this.play(sec % 2 ? 'tock' : 'tick', this.anchors.clock, 0.16, 1, now);
    }
    const silent = now < this.silenceUntil;
    for (const l of AMBIENT_LAYERS) {
      let target = PHASE_MIX[this.phase][l];
      if (silent && l !== 'fan') target *= this.silenceLevel;
      const cur = this.layerGain.get(l) ?? 0;
      // Fall quickly into silence, return slowly.
      const rate = target < cur ? 1.2 : 0.35;
      const next = cur + (target - cur) * Math.min(1, dtSec * rate);
      this.layerGain.set(l, next);
      this.layers.get(l)?.setVolume(next);
    }
  }

  suspend(): void {
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend();
  }

  resume(): void {
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  get contextState(): string {
    return this.ctx?.state ?? 'uninitialized';
  }
}
