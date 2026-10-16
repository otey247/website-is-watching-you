import {
  ACESFilmicToneMapping,
  Box3,
  Frustum,
  Matrix4,
  PCFShadowMap,
  Raycaster,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Mesh,
  type Object3D,
  type ShaderMaterial,
} from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { AttentionEstimator, type AttentionTarget } from '../attention/AttentionEstimator';
import { AudioDirector } from '../audio/AudioDirector';
import type { SoundId } from '../audio/sounds';
import { BOOK_IDS, INTERACTABLES, OBJECT_IDS, PLACEMENTS, type ObjectId, type V3 } from '../core/layout';
import { clamp, damp } from '../core/math';
import { seedFromString } from '../core/rng';
import type { EndingId, Phase } from '../director/phaseMachine';
import type { EffectName, VisibilityOracle } from '../director/types';
import { Endings } from '../endings/Endings';
import { GameCore } from '../game/GameCore';
import { CameraRig } from '../interaction/CameraRig';
import { Interaction } from '../interaction/Interaction';
import { LocalOllamaAdapter, isLocalEndpoint } from '../narrative/llm';
import type { ObserverMessage } from '../narrative/types';
import type { PredictionCandidate } from '../observer/Predictor';
import { DEFAULT_SETTINGS, Persistence, type Settings } from '../persistence/Persistence';
import { CaptureService } from '../scene/CaptureService';
import { ComputerScreen } from '../scene/ComputerScreen';
import { PhotoFrame } from '../scene/PhotoFrame';
import { paintGardenVariants, type GardenKey } from '../scene/photoPainter';
import { PostFX } from '../scene/PostFX';
import { buildRoom, LAYER_FIGURE, type Room } from '../scene/RoomBuilder';
import { ScenePresenter } from '../scene/ScenePresenter';
import { TrailRenderer } from '../scene/TrailRenderer';
import type { BehavioralEvent } from '../telemetry/types';
import { Overlay } from '../ui/Overlay';
import type { WorldSnapshot } from '../world/WorldState';
import type { Texture } from 'three';

export interface AppOptions {
  seed: number | null;
  /** Deterministic test mode: fixed seed, exposed hooks, preserved drawing buffer. */
  test: boolean;
  timeScale: number;
  inspector: boolean;
}

/** Visual grade per phase. The room never announces a phase; it just feels slightly different. */
const PHASE_GRADE: Record<Phase, { temp: number; sat: number; contrast: number; vignette: number; grain: number; shadow: number }> = {
  normalcy: { temp: 0.35, sat: 1.0, contrast: 1.0, vignette: 0.22, grain: 0.018, shadow: 0 },
  inconsistency: { temp: 0.25, sat: 0.96, contrast: 1.02, vignette: 0.26, grain: 0.02, shadow: 0.04 },
  recognition: { temp: 0.1, sat: 0.9, contrast: 1.05, vignette: 0.3, grain: 0.024, shadow: 0.1 },
  anticipation: { temp: -0.05, sat: 0.84, contrast: 1.08, vignette: 0.36, grain: 0.028, shadow: 0.16 },
  confrontation: { temp: -0.2, sat: 0.76, contrast: 1.12, vignette: 0.44, grain: 0.034, shadow: 0.24 },
  resolution: { temp: -0.1, sat: 0.8, contrast: 1.06, vignette: 0.4, grain: 0.03, shadow: 0.18 },
};

const MOVABLE: ObjectId[] = ['chair', ...BOOK_IDS, 'figurine', 'cup'];
const ATTENTION_HZ_MS = 100;
/** Fictional local time the room starts at (16:12), advanced by active session time. */
const FICTIONAL_START_MS = (16 * 3600 + 12 * 60) * 1000;

const SOUND_FOR_EVENT: Partial<Record<BehavioralEvent['type'], SoundId>> = {
  drawer_opened: 'drawer_open',
  drawer_closed: 'drawer_close',
  lamp_toggled: 'lamp_click',
  curtains_toggled: 'curtain',
  chair_moved: 'chair_scrape',
  door_handle_tried: 'door_handle',
  door_opened: 'door_creak',
  object_picked_up: 'book_lift',
  object_placed: 'book_place',
  computer_note_opened: 'key_tap',
};

/** Everything that belongs to one play-through. Rebuilt on restart/resume. */
class Session {
  readonly core: GameCore;
  readonly attention: AttentionEstimator;
  readonly presenter: ScenePresenter;
  readonly interaction: Interaction;
  readonly endings: Endings;
  readonly screen: ComputerScreen;
  readonly initialWorld: WorldSnapshot;
  readonly unsub: (() => void)[] = [];
  lastSample = 0;
  lastPrediction = 0;
  stalledClockMs: number | null = null;

  constructor(app: App, seed: number, save: object | null) {
    const room = app.room;
    this.screen = new ComputerScreen();
    (room.parts.screen as Mesh).material = this.screen.material;
    this.attention = new AttentionEstimator(app.rig.camera, app.attentionTargets, room.occluders, {
      center: new Vector3(...PLACEMENTS.mirror.center),
      normal: new Vector3(0, 0, -1),
      halfWidth: 0.31,
      halfHeight: 0.51,
    });
    const att = this.attention;
    const oracle: VisibilityOracle = {
      visibility: (id) => att.get(id)?.visibility ?? 'offscreen',
      isUnseen: (id) => att.isUnseen(id),
      unseenForMs: (id, now) => att.unseenForMs(id, now),
      score: (id) => att.get(id)?.score ?? 0,
      isPointVisible: (p) => app.isPointVisible(p),
      focus: () => att.focus()?.id ?? null,
    };
    this.core = new GameCore(seed, {
      vis: oracle,
      camera: () => app.rig.sample(),
      capture: (kind) => app.capture(kind),
    });
    this.core.clock.timeScale = app.opts.timeScale;
    if (save) this.core.restore(save);
    this.initialWorld = save ? (save as { world: WorldSnapshot }).world : this.core.world.snapshot();
    this.core.clock.pause('gate');

    this.presenter = new ScenePresenter(room, this.core.world, app.photo, app.gardens, app.captures);
    this.presenter.setVisibilityCheck((id) => !att.isUnseen(id));

    this.endings = new Endings({
      core: this.core,
      rig: app.rig,
      screen: this.screen,
      lock: (on) => (app.locked = on),
      fade: (on, ms) => app.overlay.setFade(on, ms),
      showHint: (t) => app.overlay.showHint(t),
      hideHint: () => app.overlay.hideHint(),
      sound: (id, at, gain) => this.core.playSound(id, at, gain ?? 0.5, 1, false),
      showFigureAt: (p) => app.showFigureAt(p),
      showEnd: (e, title, body) => app.showEnd(e, title, body),
      initialWorld: this.initialWorld,
    });

    this.interaction = new Interaction(
      app.renderer.domElement,
      app.rig,
      room,
      this.core,
      this.presenter,
      this.screen,
      {
        onDoorClick: () => this.endings.onDoorClick(),
        onScreenAction: (a) => this.endings.onScreenAction(a),
        onEscapeIdle: () => app.overlay.openMenu(),
        locked: () => app.inputLocked,
        sound: (id, at, gain) => this.core.playSound(id, at, gain ?? 0.5, 1, false),
      },
      (p, n, surface) => {
        const pt = this.core.trail({ p: [p[0], p[1], p[2]], n: [n[0], n[1], n[2]], surface });
        if (pt) app.trail.add(p, n, 0, this.core.clock.now / 1000, Math.random());
      },
    );

    const e = this.core.emitter;
    this.unsub.push(
      e.on('sound', (s) => app.audio.play(s.id, s.at, s.gain, s.rate, this.core.clock.now)),
      e.on('effect', (f) => app.effect(f.name, f.params)),
      e.on('followerMarks', ({ marks }) => {
        for (const m of marks) app.trail.add([m.p[0], m.p[1], m.p[2]], [m.n[0], m.n[1], m.n[2]], 1, this.core.clock.now / 1000, Math.random());
      }),
      e.on('phase', ({ to }) => app.onPhase(to)),
      e.on('instructionDismissed', () => app.overlay.hideHint()),
      this.core.narrative.emitter.on('message', (m) => app.onMessage(m)),
    );
    // A restored session shows its earlier messages on the computer.
    for (const m of this.core.narrative.shown) this.screen.addObserverMessage(m.text);
    app.onPhase(this.core.phase);
  }

  dispose(): void {
    for (const u of this.unsub) u();
    this.interaction.dispose();
    this.endings.dispose();
    this.screen.texture.dispose();
  }
}

/**
 * The browser shell: renderer, room, camera, audio, post-processing and DOM
 * chrome, wired to one GameCore session at a time.
 */
export class App {
  readonly renderer: WebGLRenderer;
  room!: Room;
  readonly rig: CameraRig;
  photo!: PhotoFrame;
  gardens!: Record<GardenKey, Texture>;
  captures!: CaptureService;
  audio!: AudioDirector;
  trail!: TrailRenderer;
  postfx!: PostFX;
  overlay: Overlay;
  attentionTargets: AttentionTarget[] = [];
  session: Session | null = null;
  settings: Settings;
  locked = false;
  entered = false;
  ready = false;
  fps = 60;

  private lastFrame = 0;
  private time = 0;
  private frameTimes: number[] = [];
  private pixelRatio = 1;
  private maxPixelRatio = 1.75;
  private lastResolutionChange = 0;
  private frustum = new Frustum();
  private projScreen = new Matrix4();
  private raycaster = new Raycaster();
  private tmpBox = new Box3();
  private baseLights = { sun: 0, window: 0, hemi: 0 };
  private gradeTarget = PHASE_GRADE.normalcy;
  private fx = {
    mirrorLagUntil: 0,
    mirrorLagDelay: 0,
    lastMirrorRender: -Infinity,
    pastChair: null as null | { until: number; x: number; z: number; yaw: number },
    presenceUntil: 0,
    distortUntil: 0,
    shadowPass: null as null | { start: number; ms: number },
    lightShift: null as null | { start: number; ms: number },
    surveillanceUntil: 0,
    lastFeed: 0,
    gradePulseUntil: 0,
    endingFigure: null as V3 | null,
  };
  private inspector: { update(app: App): void; toggle(): void } | null = null;
  private keyLook = { x: 0, y: 0 };
  private readonly isMobile = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

  constructor(
    private readonly parent: HTMLElement,
    readonly opts: AppOptions,
  ) {
    this.settings = Persistence.loadSettings();
    this.renderer = new WebGLRenderer({ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: opts.test, stencil: false });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.renderer.domElement.setAttribute('aria-label', 'An ordinary room. Drag to look around, click objects to use them.');
    this.renderer.domElement.tabIndex = 0;
    parent.appendChild(this.renderer.domElement);
    this.rig = new CameraRig(innerWidth / innerHeight);
    this.maxPixelRatio = this.isMobile ? 1.25 : 1.75;

    this.overlay = new Overlay(
      document.body,
      {
        onEnter: () => void this.enter(null),
        onResume: () => void this.enter(Persistence.load()),
        onMenuOpen: () => this.session?.core.clock.pause('menu'),
        onMenuClose: () => this.session?.core.clock.resume('menu'),
        onSave: () => this.saveAndLeave(),
        onRestart: () => this.restart(),
        onReset: () => this.resetAll(),
        onExit: () => this.exit(),
        onReturn: () => void this.enter(Persistence.hasSave() ? Persistence.load() : null),
        onSettings: (s) => this.applySettings(s),
      },
      this.settings,
      { hasSave: Persistence.hasSave() && !opts.test, canSave: Persistence.available() },
    );
  }

  get inputLocked(): boolean {
    return this.locked || this.overlay.menuOpen || !this.entered;
  }

  /** Build the room (procedural textures and audio take a moment), then wait at the gate. */
  async boot(): Promise<void> {
    this.setEnterEnabled(false);
    this.overlay.setLoading('Preparing the room…');
    await nextFrame();
    RectAreaLightUniformsLib.init();
    const high = this.settings.quality === 'high';
    this.room = buildRoom({ shadows: true, dust: high && !this.isMobile });
    const room = this.room;
    this.renderer.shadowMap.enabled = true;
    this.baseLights = { sun: room.lights.sun.intensity, window: room.lights.window.intensity, hemi: room.lights.hemi.intensity };
    await nextFrame();
    this.gardens = paintGardenVariants();
    this.photo = new PhotoFrame(room.parts.photo.plane, this.gardens.original);
    const figure = room.parts.figure;
    figure.visible = false;
    this.captures = new CaptureService(this.renderer, room.scene, [room.parts.photo.group], figure);
    this.trail = new TrailRenderer();
    room.scene.add(this.trail.mesh);
    room.scene.add(this.rig.camera);
    this.audio = new AudioDirector(room.scene, this.rig.camera, { fan: [0, 2.4, 0], window: [0.6, 1.5, -2.05], clock: PLACEMENTS.clock.center });
    this.buildAttentionTargets();
    this.patchMirror();
    this.postfx = new PostFX(this.renderer, room.scene, this.rig.camera, high ? 'high' : 'low');
    this.onResize();
    addEventListener('resize', () => this.onResize());
    document.addEventListener('visibilitychange', () => this.onVisibility());
    addEventListener('keydown', (e) => this.onKey(e));
    addEventListener('keyup', (e) => this.onKeyUp(e));
    // A fresh session renders behind the gate so the room is already there when it lifts.
    this.session = new Session(this, this.newSeed(), null);
    this.applySettings(this.settings, true);
    this.renderer.setAnimationLoop((t) => this.frame(t));
    if (import.meta.env.DEV) {
      const { Inspector } = await import('../debug/Inspector');
      this.inspector = new Inspector(document.body, this.opts.inspector);
    }
    this.ready = true;
    this.overlay.setLoading('');
    this.setEnterEnabled(true);
  }

  private newSeed(): number {
    if (this.opts.seed !== null) return this.opts.seed;
    return seedFromString(`${Date.now()}:${Math.random()}`);
  }

  private setEnterEnabled(on: boolean): void {
    document.querySelectorAll<HTMLButtonElement>('[data-act="enter"], [data-act="resume"]').forEach((b) => (b.disabled = !on));
  }

  // ——— Session lifecycle ———

  async enter(save: object | null): Promise<void> {
    if (!this.ready) return;
    // Audio can only start from a user gesture, which this is.
    await this.audio.start().catch(() => undefined);
    this.audio.resume();
    if (save || !this.session || this.session.core.telemetry.interactionCount() > 0 || this.session.core.clock.now > 0) {
      const seed = save ? ((save as { seed?: number }).seed ?? this.newSeed()) : this.newSeed();
      this.replaceSession(seed, save);
    }
    this.overlay.hideGate();
    this.overlay.hideEnd();
    this.overlay.hideMenuButton(false);
    this.overlay.setFade(false, 1200);
    this.entered = true;
    this.locked = false;
    if (!save) this.overlay.showHint('Take a look around.');
    this.session!.core.clock.resume('gate');
    if (!document.hidden) this.session!.core.clock.resume('hidden');
    this.renderer.domElement.focus({ preventScroll: true });
  }

  private replaceSession(seed: number, save: object | null): void {
    this.session?.dispose();
    this.trail.clear();
    this.showFigureAt(null);
    this.rig.resetHome();
    this.locked = false;
    this.session = new Session(this, seed, save);
    this.applySettings(this.settings, true);
  }

  restart(): void {
    this.overlay.hideEnd();
    this.overlay.setFade(true, 600);
    setTimeout(() => {
      this.replaceSession(this.newSeed(), null);
      this.session!.core.clock.resume('gate');
      this.overlay.setFade(false, 1600);
      this.overlay.showHint('Take a look around.');
    }, 650);
  }

  private resetAll(): void {
    this.applySettings({ ...DEFAULT_SETTINGS }, true);
    this.overlay.setSettings(this.settings);
    Persistence.clearAll();
    this.restart();
    this.overlay.announce('Session data and settings were cleared.');
  }

  private saveAndLeave(): void {
    const s = this.session;
    if (!s) return;
    const ok = Persistence.save({ ...s.core.snapshot() });
    if (!ok) {
      this.overlay.toast('This browser is not allowing local storage, so the session could not be saved.');
      return;
    }
    this.overlay.closeMenu();
    this.leave();
  }

  private exit(): void {
    this.leave();
  }

  private leave(): void {
    this.entered = false;
    this.session?.core.clock.pause('gate');
    this.audio.suspend();
    this.overlay.hideHint();
    this.overlay.hideEnd();
    this.overlay.showLeft();
  }

  showEnd(ending: EndingId, title: string, body: string): void {
    const names: Record<EndingId, string> = { acknowledgment: 'Acknowledgment', refusal: 'Refusal', reversal: 'Reversal' };
    this.locked = true;
    this.overlay.hideHint();
    this.overlay.showEnd(`Ending · ${names[ending]}`, title, body, () => this.restart(), () => this.exit());
  }

  // ——— Settings ———

  applySettings(s: Settings, initial = false): void {
    const prevQuality = this.settings.quality;
    this.settings = { ...s };
    if (!initial) Persistence.saveSettings(this.settings);
    const reduced = s.reducedMotion || matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.audio?.setVolume(s.volume, s.muted);
    if (this.audio) this.audio.suddenEvents = s.suddenEvents;
    this.rig.reducedMotion = reduced;
    const core = this.session?.core;
    if (core) {
      core.settings.suddenEvents = s.suddenEvents;
      core.settings.reducedMotion = reduced;
      let model = null;
      if (s.localModel && isLocalEndpoint(s.localModelEndpoint)) {
        try {
          model = new LocalOllamaAdapter(s.localModelEndpoint, s.localModelName || 'llama3.2');
        } catch {
          model = null;
        }
      }
      core.narrative.model = model;
    }
    if (this.postfx && prevQuality !== s.quality) {
      this.postfx = new PostFX(this.renderer, this.room.scene, this.rig.camera, s.quality);
      this.onResize();
    }
    if (this.room) this.room.parts.dust.visible = s.quality === 'high';
  }

  // ——— Ports used by the core ———

  capture(kind: 'now' | 'figure' | 'snapshot'): number {
    const fig = this.room.parts.figure;
    const was = fig.visible;
    fig.visible = true;
    const id = this.captures.capture(kind, this.rig.camera.position);
    fig.visible = was;
    return id;
  }

  /** Is a world point inside the view frustum and not hidden behind room geometry? */
  isPointVisible(p: V3): boolean {
    const cam = this.rig.camera;
    cam.updateMatrixWorld();
    this.projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);
    const v = new Vector3(p[0], p[1], p[2]);
    if (!this.frustum.containsPoint(v)) return false;
    const origin = cam.getWorldPosition(new Vector3());
    const dir = v.clone().sub(origin);
    const dist = dir.length();
    this.raycaster.set(origin, dir.normalize());
    this.raycaster.far = dist;
    const hit = this.raycaster.intersectObjects(this.room.occluders, true).find((h) => h.object.visible);
    return !hit || hit.distance > dist - 0.08;
  }

  private buildAttentionTargets(): void {
    const room = this.room;
    this.attentionTargets = [];
    for (const id of OBJECT_IDS) {
      const root = room.roots[id];
      const pl = PLACEMENTS[id];
      if (!root || !pl) continue;
      const meshes: Object3D[] = [];
      root.traverse((o) => {
        if ((o as Mesh).isMesh) meshes.push(o);
      });
      this.attentionTargets.push({ id, area: pl.area, center: new Vector3(...pl.center), radius: pl.radius, meshes });
    }
  }

  private updateMovableCenters(): void {
    for (const t of this.attentionTargets) {
      if (!MOVABLE.includes(t.id)) continue;
      const root = this.room.roots[t.id];
      if (!root) continue;
      this.tmpBox.setFromObject(root);
      if (!this.tmpBox.isEmpty()) this.tmpBox.getCenter(t.center);
    }
  }

  // ——— Mirror ———

  /**
   * The mirror is a real planar reflection. Its render hook is wrapped so the
   * reflection can lag behind, show the chair where it used to be, or include
   * the figure, which lives on a layer only the mirror and captures can see.
   */
  private patchMirror(): void {
    const mirror = this.room.parts.mirror;
    mirror.getReflectionCamera(this.rig.camera).layers.enable(LAYER_FIGURE);
    const original = mirror.onBeforeRender;
    const chair = this.room.parts.chair;
    mirror.onBeforeRender = (...args: Parameters<typeof original>) => {
      const now = this.session?.core.clock.now ?? 0;
      if (now < this.fx.mirrorLagUntil && now - this.fx.lastMirrorRender < this.fx.mirrorLagDelay) return;
      this.fx.lastMirrorRender = now;
      const past = this.fx.pastChair && now < this.fx.pastChair.until ? this.fx.pastChair : null;
      const savedPos = chair.position.clone();
      const savedRot = chair.rotation.y;
      if (past) {
        chair.position.set(past.x, 0, past.z);
        chair.rotation.y = past.yaw;
        chair.updateMatrixWorld(true);
      }
      original.apply(mirror, args);
      if (past) {
        chair.position.copy(savedPos);
        chair.rotation.y = savedRot;
        chair.updateMatrixWorld(true);
      }
    };
  }

  showFigureAt(p: V3 | null): void {
    const fig = this.room.parts.figure;
    this.fx.endingFigure = p;
    if (p) {
      fig.position.set(p[0], p[1], p[2]);
      fig.visible = true;
      this.rig.camera.layers.enable(LAYER_FIGURE);
    } else {
      fig.visible = false;
      this.rig.camera.layers.disable(LAYER_FIGURE);
    }
  }

  // ——— Core events ———

  onPhase(p: Phase): void {
    this.gradeTarget = PHASE_GRADE[p];
    this.audio?.setPhase(p);
  }

  onMessage(m: ObserverMessage): void {
    const s = this.session;
    if (!s) return;
    const show = (text: string) => {
      s.screen.addObserverMessage(text);
      this.overlay.announce(`A new note appeared on the computer: ${text}`);
      s.core.playSound('notify', PLACEMENTS.computer.center, 0.18, 1, false);
    };
    if (!s.core.narrative.model || m.intent === 'ending') return show(m.text);
    void s.core.narrative
      .vary({ text: m.text, refs: m.refs, facts: m.facts, intent: m.intent }, s.core.director.ctx().narrativeCtx())
      .then((r) => show(r.text))
      .catch(() => show(m.text));
  }

  effect(name: EffectName, params: Record<string, unknown>): void {
    const s = this.session;
    if (!s) return;
    const now = s.core.clock.now;
    const num = (k: string, d: number) => (typeof params[k] === 'number' ? (params[k] as number) : d);
    const reduced = this.rig.reducedMotion;
    switch (name) {
      case 'mirror_lag':
        this.fx.mirrorLagUntil = now + num('ms', 1600);
        this.fx.mirrorLagDelay = num('delayMs', 380);
        break;
      case 'mirror_past_chair':
        this.fx.pastChair = { until: now + num('ms', 1800), x: num('x', 0), z: num('z', 0), yaw: num('yaw', 0) };
        break;
      case 'mirror_presence':
        this.fx.presenceUntil = now + num('ms', 700);
        break;
      case 'mirror_distort':
        if (!reduced) this.fx.distortUntil = now + num('ms', 2500);
        break;
      case 'silence':
        this.audio.silence(num('ms', 9000), num('level', 0.12), now);
        break;
      case 'flicker':
        // Reduced motion: no strobing, only a brief dip.
        s.presenter.flickerFor(reduced ? 0 : num('ms', 900));
        break;
      case 'cursor_nudge':
        s.screen.nudgeCursor(num('px', 1));
        break;
      case 'shadow_pass':
        this.fx.shadowPass = { start: now, ms: num('ms', 2400) };
        break;
      case 'light_shift':
        this.fx.lightShift = { start: now, ms: num('ms', 40_000) };
        break;
      case 'clock_skip':
        this.audio.skipClock(num('ticks', 2));
        break;
      case 'surveillance':
        this.fx.surveillanceUntil = now + num('ms', 30_000);
        (s.screen.material as ShaderMaterial).uniforms.uFeed.value = this.captures.feedTarget.texture;
        break;
      case 'replay_sounds': {
        const ids = Array.isArray(params.events) ? (params.events as number[]) : [];
        let delay = 0;
        for (const id of ids.slice(-5)) {
          const e = s.core.telemetry.get(id);
          const snd = e && SOUND_FOR_EVENT[e.type];
          if (!e || !snd) continue;
          const at = e.target ? PLACEMENTS[e.target].center : PLACEMENTS.computer.center;
          const fire = now + delay;
          const check = () => {
            if (this.session !== s) return;
            if (s.core.clock.now >= fire) s.core.playSound(snd, at, 0.32, 0.96, true);
            else requestAnimationFrame(check);
          };
          check();
          delay += 950;
        }
        break;
      }
      case 'entity_move':
        if (s.core.rng.chance(0.3)) s.core.playSound('creak', 'entity', 0.07, 0.9 + s.core.rng.next() * 0.2, false);
        break;
      case 'grade_pulse':
        if (!reduced) this.fx.gradePulseUntil = now + num('ms', 600);
        break;
      case 'follower_stage':
        break;
    }
  }

  // ——— Frame ———

  private frame(tMs: number): void {
    const realDt = this.lastFrame ? Math.min(100, tMs - this.lastFrame) : 16;
    this.lastFrame = tMs;
    const dt = realDt / 1000;
    this.time += dt;
    this.trackPerformance(realDt, tMs);
    const s = this.session;
    if (!s) return;
    const core = s.core;

    // Keyboard look.
    if (this.keyLook.x || this.keyLook.y) this.rig.rotateBy(this.keyLook.x * realDt * 0.6, this.keyLook.y * realDt * 0.6);

    core.tick(realDt);
    const now = core.clock.now;
    if (!core.clock.isPaused) {
      if (now - s.lastSample >= ATTENTION_HZ_MS) {
        const dtMs = Math.min(500, now - s.lastSample);
        s.lastSample = now;
        this.updateMovableCenters();
        const pointer = s.interaction.pointerInside ? s.interaction.pointer : null;
        s.attention.sample(pointer, now, dtMs);
        core.sampleAttention(s.attention.areaScores(), dtMs, this.rig.yaw);
      }
      if (now - s.lastPrediction >= ATTENTION_HZ_MS) {
        s.lastPrediction = now;
        const v = s.interaction.pointerVelocity;
        core.updatePrediction(s.interaction.pointerInside ? { x: s.interaction.pointer.x, y: s.interaction.pointer.y } : null, { x: v.x, y: v.y }, this.predictionCandidates(s));
      }
      s.interaction.update(dt);
      s.endings.update();
    }

    this.rig.update(dt, this.time);

    // Fictional clock; a stalled clock stops its hands where they are.
    const clockState = core.world.get('clock').state;
    let clockMs = FICTIONAL_START_MS + now;
    if (clockState === 'stalled') clockMs = s.stalledClockMs ??= clockMs;
    else s.stalledClockMs = null;
    s.screen.setMinutes(Math.floor((FICTIONAL_START_MS + now) / 60_000) % 1440);
    s.presenter.update(dt, this.time, clockMs);
    this.updateEffects(s, dt, now);
    this.audio.update(now, dt, clockMs + (core.world.get('clock').offsetMs ?? 0), clockState === 'stalled');
    s.screen.update();
    (s.screen.material as ShaderMaterial).uniforms.uTime.value = this.time;
    this.postfx.setInspection(this.rig.inspecting ? this.rig.camera.position.distanceTo(new Vector3(...PLACEMENTS[this.rig.inspecting].center)) : null);
    this.postfx.render(dt, this.time);
    this.inspector?.update(this);
  }

  private predictionCandidates(s: Session): PredictionCandidate[] {
    const cam = this.rig.camera;
    const out: PredictionCandidate[] = [];
    const v = new Vector3();
    for (const p of INTERACTABLES) {
      const est = s.attention.get(p.id);
      const t = this.attentionTargets.find((x) => x.id === p.id);
      v.copy(t ? t.center : new Vector3(...p.center)).project(cam);
      const onScreen = v.z < 1 && Math.abs(v.x) <= 1.15 && Math.abs(v.y) <= 1.15 && est?.inFrustum;
      out.push({ id: p.id, ndc: onScreen ? { x: v.x, y: v.y } : null, centerAngle: est?.centerAngle ?? Math.PI, dwellMs: est?.dwellMs ?? 0 });
    }
    return out;
  }

  private updateEffects(s: Session, dt: number, now: number): void {
    const room = this.room;
    const fx = this.fx;
    // Mirror uniforms.
    const mu = (room.parts.mirror.material as ShaderMaterial).uniforms;
    mu.uTime.value = this.time;
    mu.uDistort.value = damp(mu.uDistort.value, now < fx.distortUntil ? 1 : 0, 3, dt);

    // Figure: momentarily present behind the player, in the mirror only.
    const fig = room.parts.figure;
    if (!fx.endingFigure) {
      if (now < fx.presenceUntil) {
        const cam = this.rig.camera;
        const back = new Vector3();
        cam.getWorldDirection(back).setY(0).normalize().multiplyScalar(-1.05);
        fig.position.set(cam.position.x + back.x, 0.85, cam.position.z + back.z);
        fig.visible = true;
      } else fig.visible = false;
    }

    // Shadow passing through the window light.
    const sp = fx.shadowPass;
    const caster = room.parts.shadowCaster;
    if (sp) {
      const k = (now - sp.start) / sp.ms;
      if (k >= 1) {
        fx.shadowPass = null;
        caster.visible = false;
      } else {
        caster.visible = true;
        caster.position.set(-1.7 + k * 2.6, 1.0, -1.72);
      }
    }

    // Light: curtains gate the sun; a slow light shift dims it like a passing cloud.
    let shift = 1;
    if (fx.lightShift) {
      const k = (now - fx.lightShift.start) / fx.lightShift.ms;
      if (k >= 1) fx.lightShift = null;
      else shift = 1 - Math.sin(k * Math.PI) * 0.45;
    }
    const open = s.presenter.curtainOpen;
    const sun = 0.18 + 0.82 * clamp(open, 0, 1);
    room.lights.sun.intensity = this.baseLights.sun * sun * shift;
    room.lights.window.intensity = this.baseLights.window * (0.3 + 0.7 * open) * shift;
    room.lights.hemi.intensity = this.baseLights.hemi * (0.55 + 0.45 * open) * (0.8 + 0.2 * shift);
    const dust = room.parts.dust.material as ShaderMaterial;
    if (dust.uniforms?.uTime) {
      dust.uniforms.uTime.value = this.time;
      dust.uniforms.uIntensity.value = open * shift;
    }

    // Surveillance feed on the monitor.
    const su = (s.screen.material as ShaderMaterial).uniforms;
    const feedOn = now < fx.surveillanceUntil;
    su.uFeedMix.value = damp(su.uFeedMix.value, feedOn ? 1 : 0, 2.5, dt);
    if (su.uFeedMix.value > 0.01 && this.time - fx.lastFeed > 0.12) {
      fx.lastFeed = this.time;
      this.captures.renderFeed(this.rig.camera.position);
    }

    // Grade eases toward the phase's look.
    const g = this.gradeTarget;
    const u = (k: Parameters<PostFX['uniform']>[0]) => this.postfx.uniform(k);
    const rate = 0.25;
    u('uTemp').value = damp(u('uTemp').value, g.temp, rate, dt);
    u('uSat').value = damp(u('uSat').value, g.sat, rate, dt);
    u('uContrast').value = damp(u('uContrast').value, g.contrast, rate, dt);
    u('uVignette').value = damp(u('uVignette').value, g.vignette, rate, dt);
    u('uGrain').value = damp(u('uGrain').value, this.rig.reducedMotion ? g.grain * 0.4 : g.grain, rate, dt);
    u('uShadow').value = damp(u('uShadow').value, g.shadow, rate, dt);
    u('uDistort').value = damp(u('uDistort').value, now < fx.gradePulseUntil ? 1 : 0, 6, dt);
  }

  private trackPerformance(realDt: number, tMs: number): void {
    this.frameTimes.push(realDt);
    if (this.frameTimes.length > 90) this.frameTimes.shift();
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.fps = 1000 / Math.max(1, avg);
    // Adaptive resolution: hold the frame budget (60 fps desktop, 30 fps mobile).
    if (this.opts.test || this.frameTimes.length < 90 || tMs - this.lastResolutionChange < 2500 || document.hidden) return;
    const budget = this.isMobile ? 33.4 : 16.9;
    let next = this.pixelRatio;
    if (avg > budget * 1.15) next = Math.max(0.6, this.pixelRatio - 0.15);
    else if (avg < budget * 0.7) next = Math.min(this.maxPixelRatio, Math.min(devicePixelRatio || 1, this.pixelRatio + 0.1));
    if (Math.abs(next - this.pixelRatio) > 0.01) {
      this.pixelRatio = next;
      this.lastResolutionChange = tMs;
      this.applySize();
    }
  }

  private onResize(): void {
    this.pixelRatio = this.opts.test ? 1 : Math.min(devicePixelRatio || 1, this.maxPixelRatio);
    this.applySize();
  }

  private applySize(): void {
    const w = this.parent.clientWidth || innerWidth;
    const h = this.parent.clientHeight || innerHeight;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, false);
    this.rig.setAspect(w / h);
    this.postfx?.setSize(w, h);
    this.postfx?.composer.setPixelRatio(this.pixelRatio);
    const dust = this.room?.parts.dust.material as ShaderMaterial | undefined;
    if (dust?.uniforms?.uPixelRatio) dust.uniforms.uPixelRatio.value = this.pixelRatio;
  }

  private onVisibility(): void {
    const core = this.session?.core;
    if (!core) return;
    if (document.hidden) {
      core.clock.pause('hidden');
      this.audio.suspend();
    } else {
      core.clock.resume('hidden');
      if (this.entered) this.audio.resume();
    }
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === '`' && this.inspector) {
      this.inspector.toggle();
      return;
    }
    if (!this.entered) return;
    if (e.key === 'Escape') {
      if (this.overlay.menuOpen) this.overlay.closeMenu();
      else this.session?.interaction.escape();
      e.preventDefault();
      return;
    }
    if (this.inputLocked || (e.target as HTMLElement)?.closest?.('.panel, .end')) return;
    const k = e.key;
    if (k === 'ArrowLeft') this.keyLook.x = -1;
    else if (k === 'ArrowRight') this.keyLook.x = 1;
    else if (k === 'ArrowUp') this.keyLook.y = -1;
    else if (k === 'ArrowDown') this.keyLook.y = 1;
    else if (k === 'Enter' || k === ' ') {
      // Keyboard players use the centre of the view as their pointer.
      this.session?.interaction.click(new Vector2(0, 0));
      e.preventDefault();
    } else return;
    if (k.startsWith('Arrow')) e.preventDefault();
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') this.keyLook.x = 0;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') this.keyLook.y = 0;
  }

  /**
   * Deterministic test mode: advance the simulation by `ms` of session time in
   * fixed 100 ms steps (attention, prediction and endings included) without
   * waiting in real time. Rendering continues normally between calls.
   */
  simulate(ms: number): void {
    const s = this.session;
    if (!s) return;
    const steps = Math.ceil(ms / 100);
    for (let i = 0; i < steps; i++) {
      if (this.session !== s) return;
      s.core.tick(100 / s.core.clock.timeScale);
      const now = s.core.clock.now;
      if (s.core.clock.isPaused) continue;
      this.rig.update(0.1, this.time);
      this.updateMovableCenters();
      s.lastSample = now;
      s.lastPrediction = now;
      const pointer = s.interaction.pointerInside ? s.interaction.pointer : null;
      s.attention.sample(pointer, now, 100);
      s.core.sampleAttention(s.attention.areaScores(), 100, this.rig.yaw);
      const v = s.interaction.pointerVelocity;
      s.core.updatePrediction(pointer ? { x: pointer.x, y: pointer.y } : null, { x: v.x, y: v.y }, this.predictionCandidates(s));
      s.interaction.update(0.1);
      s.endings.update();
      s.presenter.update(0.1, this.time, FICTIONAL_START_MS + now);
    }
  }

  /** Same path as a real visibilitychange, for tests (document.hidden cannot be faked). */
  setHidden(hidden: boolean): void {
    const core = this.session?.core;
    if (!core) return;
    if (hidden) {
      core.clock.pause('hidden');
      this.audio.suspend();
    } else {
      core.clock.resume('hidden');
      if (this.entered) this.audio.resume();
    }
  }

  /** Point the camera at an object (test hooks). */
  lookAtObject(id: ObjectId): void {
    const t = this.attentionTargets.find((x) => x.id === id);
    const c = t ? t.center : new Vector3(...PLACEMENTS[id].center);
    this.rig.lookAtPoint([c.x, c.y, c.z], true);
  }

  /** NDC of an object's centre in the current view (test hooks). */
  ndcOf(id: ObjectId): { x: number; y: number } {
    const t = this.attentionTargets.find((x) => x.id === id);
    const v = (t ? t.center.clone() : new Vector3(...PLACEMENTS[id].center)).project(this.rig.camera);
    // The centre of a compound object (two curtain panels, an open door) can fall
    // on something else. Search outward for a point that actually reaches it.
    const probe = new Vector2();
    for (let r = 0; r <= 0.8; r += 0.02) {
      const steps = r === 0 ? 1 : 16;
      for (let k = 0; k < steps; k++) {
        const a = (k / steps) * Math.PI * 2;
        probe.set(v.x + Math.cos(a) * r, v.y + Math.sin(a) * r);
        if (Math.abs(probe.x) < 0.98 && Math.abs(probe.y) < 0.98 && this.session?.interaction.idAt(probe) === id) return { x: probe.x, y: probe.y };
      }
    }
    return { x: v.x, y: v.y };
  }
}

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}
