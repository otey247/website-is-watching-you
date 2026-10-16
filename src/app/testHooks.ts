import { Vector2 } from 'three';
import type { ObjectId } from '../core/layout';
import type { EndingId, Phase } from '../director/phaseMachine';
import type { ActionType } from '../telemetry/types';
import type { App } from './App';

/**
 * Deterministic test-mode controls, installed only with `?test` (or in dev).
 * They drive the same code paths the player does: clicks go through the
 * interaction system, anomalies through the Director's gates, endings through
 * the phase machine. Nothing here edits world state directly.
 */
export function installTestHooks(app: App): void {
  const s = () => {
    if (!app.session) throw new Error('no session');
    return app.session;
  };
  const hooks = {
    app,
    ready: () => app.ready,
    entered: () => app.entered,
    enter: () => app.enter(null),
    simulate: (ms: number) => app.simulate(ms),
    lookAt: (id: ObjectId) => app.lookAtObject(id),
    look: (yaw: number, pitch: number) => {
      app.rig.yaw = yaw;
      app.rig.pitch = pitch;
      app.rig.lookAtPoint([app.rig.camera.position.x - Math.sin(yaw) * Math.cos(pitch), app.rig.camera.position.y + Math.sin(pitch), app.rig.camera.position.z - Math.cos(yaw) * Math.cos(pitch)], true);
    },
    ndcOf: (id: ObjectId) => app.ndcOf(id),
    /** Click an object through the interaction system (it must be on screen). */
    click: (id: ObjectId) => {
      const n = app.ndcOf(id);
      s().interaction.click(new Vector2(n.x, n.y));
    },
    clickNdc: (x: number, y: number) => s().interaction.click(new Vector2(x, y)),
    escape: () => s().interaction.escape(),
    placeHeld: (slot: string | null) => s().interaction.placeHeld(slot),
    answer: (value: 'yes' | 'no') => s().endings.onScreenAction({ kind: 'answer', value }),
    force: (id: string, anyPhase = true) => s().core.forceAnomaly(id, { ignoreRequirements: true, anyPhase }),
    forceGated: (id: string) => s().core.forceAnomaly(id),
    forcePhase: (p: Exclude<Phase, 'resolution'>) => s().core.director.forcePhase(p),
    openGateways: (e: EndingId[]) => s().core.director.testOpenGateways(e),
    setFollowerStage: (n: number) => s().core.director.setFollowerStage(n),
    setHidden: (h: boolean) => app.setHidden(h),
    openMenu: () => app.overlay.openMenu(),
    closeMenu: () => app.overlay.closeMenu(),
    state: () => {
      const c = s().core;
      return {
        phase: c.phase,
        now: c.clock.now,
        paused: c.clock.isPaused,
        gateways: [...c.director.gateways],
        ending: c.director.ending,
        endingActive: s().endings.active,
        endingFinished: s().endings.finished,
        interactions: c.telemetry.interactionCount(),
        followerStage: c.director.followerStage,
        hintVisible: app.overlay.hintVisible,
        messages: c.narrative.shown.map((m) => ({ text: m.text, templateId: m.templateId, refs: m.refs, createdAt: m.createdAt })),
        screenMode: s().screen.mode,
        screenNotes: s().screen.notes.map((n) => n.title),
        inspecting: app.rig.inspecting,
        rigMode: app.rig.mode,
        held: s().interaction.held?.id ?? null,
        audio: app.audio.contextState,
        fps: app.fps,
        trailMarks: app.trail.count,
        locked: app.inputLocked,
        decisions: c.director.decisions.slice(-30),
      };
    },
    world: (id: ObjectId) => structuredClone(s().core.world.get(id)),
    history: (id: ObjectId) => structuredClone(s().core.world.historyOf(id)),
    events: (type?: ActionType) => s().core.telemetry.query(type ? { type } : {}).map((e) => ({ ...e })),
    visibility: (id: ObjectId) => s().attention.get(id)?.visibility ?? 'offscreen',
    prediction: () => {
      const p = s().core.observer.predictor.current;
      return p ? { target: p.target, confidence: p.confidence } : null;
    },
  };
  (window as unknown as { __wiwy: typeof hooks }).__wiwy = hooks;
}
