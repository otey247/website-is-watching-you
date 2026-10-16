import { CAMERA_HOME, PLACEMENTS, type ObjectId, type V3 } from '../core/layout';
import type { EndingId } from '../director/phaseMachine';
import type { GameCore } from '../game/GameCore';
import type { CameraRig } from '../interaction/CameraRig';
import { ENDING_LINES } from '../narrative/templates';
import type { ComputerScreen, ScreenAction } from '../scene/ComputerScreen';
import type { SoundId } from '../audio/sounds';
import type { BehavioralEvent } from '../telemetry/types';
import type { WorldSnapshot } from '../world/WorldState';

/** What an ending needs from the running app. */
export interface EndingHost {
  core: GameCore;
  rig: CameraRig;
  screen: ComputerScreen;
  lock(on: boolean): void;
  fade(on: boolean, ms?: number): void;
  showHint(text?: string): void;
  hideHint(): void;
  sound(id: SoundId, at: V3, gain?: number): void;
  /** Make the figure visible in the main view standing at a point (reversal only). */
  showFigureAt(p: V3 | null): void;
  showEnd(ending: EndingId, title: string, body: string): void;
  /** The room as it was when the session began. */
  initialWorld: WorldSnapshot;
}

type Timer = { at: number; fn: () => void };

const REVERSAL_IDLE_MS = 15_000;
const ACK_WAIT_MS = 90_000;

/**
 * The three endings. Each one is only reachable through its gateway, which
 * the Director opens from the player's behavioral profile; every attempt is
 * validated by the phase machine's BEGIN_ENDING guard.
 */
export class Endings {
  active: EndingId | null = null;
  finished = false;
  private asked = false;
  private timers: Timer[] = [];
  private lampToggles = 0;
  private ackStage: 'none' | 'answered' | 'light' | 'again' | 'done' = 'none';
  private hitStreak = 0;
  private unsub: (() => void)[] = [];

  constructor(private readonly h: EndingHost) {
    const t = h.core.telemetry;
    this.unsub.push(
      t.emitter.on('recorded', (e) => this.onEvent(e)),
    );
  }

  dispose(): void {
    for (const u of this.unsub) u();
    this.timers = [];
  }

  private get now(): number {
    return this.h.core.clock.now;
  }

  private get gateways(): EndingId[] {
    return this.h.core.director.gateways;
  }

  private after(ms: number, fn: () => void): void {
    this.timers.push({ at: this.now + ms, fn });
  }

  /** Called every frame (session time only advances while unpaused). */
  update(): void {
    const due = this.timers.filter((t) => t.at <= this.now);
    if (due.length) {
      this.timers = this.timers.filter((t) => t.at > this.now);
      for (const t of due) t.fn();
    }
    if (this.active) return;

    // Acknowledgment: the question appears when the player sits with the computer.
    if (!this.asked && this.gateways.includes('acknowledgment') && this.h.rig.inspecting === 'computer' && this.h.rig.mode === 'inspect') {
      this.asked = true;
      this.h.screen.ask(ENDING_LINES.ask);
      this.h.sound('notify', PLACEMENTS.computer.center, 0.25);
    }
    if (this.asked && !this.gateways.includes('acknowledgment') && this.h.screen.mode === 'question') {
      // The gateway closed again (affinity shifted); withdraw the question.
      this.asked = false;
      this.h.screen.showDesktop();
    }

    // Reversal: the room takes over when the player stops, or moves exactly as predicted.
    if (this.gateways.includes('reversal')) {
      const idle = this.h.core.director.playerIdleMs >= REVERSAL_IDLE_MS;
      if ((idle || this.hitStreak >= 3) && this.h.rig.mode === 'look') this.tryReversal();
    }
  }

  private onEvent(e: BehavioralEvent): void {
    if (e.type === 'prediction_resolved') {
      this.hitStreak = e.meta.outcome === 'hit' ? this.hitStreak + 1 : 0;
    }
    if (e.type === 'lamp_toggled' && this.active === 'acknowledgment') this.onAckLamp();
  }

  // ——— Acknowledgment ———

  onScreenAction(a: ScreenAction): void {
    if (a.kind !== 'answer' || this.active) return;
    if (!this.h.core.requestEnding('acknowledgment')) return;
    this.active = 'acknowledgment';
    this.ackStage = 'answered';
    const n = this.h.core.narrative;
    const line = a.value === 'yes' ? ENDING_LINES.yes : ENDING_LINES.no;
    this.h.core.telemetry.record({ type: 'computer_answered', target: 'computer', area: 'desk', meta: { answer: a.value } });
    this.h.core.telemetry.record({ type: 'ending_started', target: 'computer', area: 'desk', meta: { ending: 'acknowledgment' } });
    this.h.screen.showDesktop();
    n.say('ending_answer', line, this.now);
    this.after(3200, () => {
      this.ackStage = 'light';
      n.say('ending_light', this.h.core.world.get('lamp').on ? ENDING_LINES.requestLight : ENDING_LINES.requestLight.replace('off', 'on'), this.now);
      this.h.sound('notify', PLACEMENTS.computer.center, 0.2);
      this.after(ACK_WAIT_MS, () => this.ackThanks());
    });
  }

  private onAckLamp(): void {
    if (this.ackStage === 'light') {
      this.ackStage = 'again';
      this.after(1400, () => this.h.core.narrative.say('ending_again', ENDING_LINES.requestAgain, this.now));
    } else if (this.ackStage === 'again') {
      this.lampToggles++;
      this.after(1600, () => this.ackThanks());
    }
  }

  private ackThanks(): void {
    if (this.ackStage === 'done') return;
    this.ackStage = 'done';
    this.h.core.narrative.say('ending_thanks', ENDING_LINES.thanks, this.now);
    this.after(4200, () => {
      this.h.screen.setDark(true);
      this.h.sound('electrical_tick', PLACEMENTS.computer.center, 0.3);
    });
    this.after(6500, () => {
      this.h.lock(true);
      this.h.fade(true, 2400);
    });
    this.after(9500, () => this.finish('acknowledgment'));
  }

  // ——— Refusal ———

  /** Returns true when the door click was consumed by the refusal ending. */
  onDoorClick(): boolean {
    if (this.active || !this.gateways.includes('refusal')) return false;
    if (!this.h.core.requestEnding('refusal')) return false;
    this.active = 'refusal';
    const { core, rig } = this.h;
    core.telemetry.record({ type: 'ending_started', target: 'door', area: 'hallway', meta: { ending: 'refusal' } });
    this.h.lock(true);
    this.h.hideHint();
    core.world.apply('door', { state: 'open', open: 1 }, { source: 'ending', cause: 'refusal' });
    this.h.sound('door_creak', PLACEMENTS.door.center, 0.5);
    rig.scripted([1.7, 1.6, -0.82], [3.6, 1.5, -0.84], 52, 2.6);
    this.after(2800, () => {
      rig.scripted([3.05, 1.6, -0.84], [4.6, 1.45, -0.86], 50, 3.2);
      this.h.sound('footstep', [2.9, 0.05, -0.84], 0.35);
      this.after(900, () => this.h.sound('footstep', [3.2, 0.05, -0.84], 0.3));
      this.after(1800, () => this.h.sound('footstep', [3.5, 0.05, -0.84], 0.25));
    });
    this.after(5200, () => this.h.fade(true, 1800));
    this.after(8200, () => {
      // The same room again. Almost.
      const initial = structuredClone(this.h.initialWorld);
      for (const entry of initial.objects) {
        if (entry[0] === 'photograph') entry[1] = { ...entry[1], state: 'removed', mode: 'removed' };
      }
      core.world.restore(initial);
      rig.resetHome();
      this.h.screen.showDesktop();
      this.h.fade(false, 2400);
      this.h.lock(false);
      this.after(2600, () => this.h.showHint('Take a look around.'));
    });
    this.after(8200 + 18_000, () => this.finish('refusal'));
    return true;
  }

  // ——— Reversal ———

  private tryReversal(): void {
    if (!this.h.core.requestEnding('reversal')) return;
    this.active = 'reversal';
    const { core, rig } = this.h;
    core.telemetry.record({ type: 'ending_started', meta: { ending: 'reversal' } });
    this.h.lock(true);
    this.h.hideHint();
    core.narrative.say('ending_reversal', ENDING_LINES.reversal, this.now);
    this.h.sound('notify', PLACEMENTS.computer.center, 0.25);

    // Replay the player's own most recent actions, in order, from where they happened.
    const actions = core.telemetry
      .query({ type: ['lamp_toggled', 'drawer_opened', 'drawer_closed', 'curtains_toggled', 'door_handle_tried', 'object_picked_up', 'object_placed', 'chair_moved', 'computer_note_opened'] })
      .slice(-7);
    let t = 2600;
    for (const e of actions) {
      const id = e.target as ObjectId | undefined;
      this.after(t, () => this.replay(e.type, id));
      t += 1300;
    }
    // Then the view moves to where it was always watched from, and turns to face where the player stood.
    this.after(t + 400, () => {
      this.h.showFigureAt([CAMERA_HOME.position[0], 0.85, CAMERA_HOME.position[2]]);
      rig.scripted([-1.05, 1.22, -1.55], [CAMERA_HOME.position[0], 1.3, CAMERA_HOME.position[2]], 50, 4.2);
    });
    this.after(t + 5200, () => core.narrative.say('ending_reversal_final', ENDING_LINES.reversalFinal, this.now));
    this.after(t + 8200, () => this.h.fade(true, 2600));
    this.after(t + 11_200, () => this.finish('reversal'));
  }

  private replay(type: BehavioralEvent['type'], id: ObjectId | undefined): void {
    const w = this.h.core.world;
    const at = id ? PLACEMENTS[id].center : PLACEMENTS.computer.center;
    const opts = { source: 'ending' as const, cause: 'reversal_replay' };
    switch (type) {
      case 'lamp_toggled': {
        const on = !w.get('lamp').on;
        w.apply('lamp', { state: on ? 'on' : 'off', on }, opts);
        this.h.sound('lamp_click', at, 0.5);
        break;
      }
      case 'drawer_opened':
      case 'drawer_closed':
        if (id === 'drawer_top' || id === 'drawer_bottom') {
          const open = type === 'drawer_opened';
          w.apply(id, { state: open ? 'open' : 'closed', open: open ? 1 : 0 }, opts);
          this.h.sound(open ? 'drawer_open' : 'drawer_close', at, 0.5);
        }
        break;
      case 'curtains_toggled': {
        const open = (w.get('curtains').open ?? 1) < 0.5;
        w.apply('curtains', { state: open ? 'open' : 'closed', open: open ? 1 : 0 }, opts);
        this.h.sound('curtain', at, 0.45);
        break;
      }
      case 'door_handle_tried':
        this.h.sound('door_handle', at, 0.45);
        break;
      case 'object_picked_up':
      case 'object_placed':
        this.h.sound(id === 'cup' ? 'cup_clink' : 'book_place', at, 0.4);
        break;
      case 'chair_moved':
        this.h.sound('chair_scrape', at, 0.4);
        break;
      case 'computer_note_opened':
        this.h.sound('key_tap', at, 0.3);
        break;
      default:
        break;
    }
  }

  // ——— Shared ———

  private finish(ending: EndingId): void {
    if (this.finished) return;
    this.finished = true;
    const p = this.h.core.observer.profile();
    const events = this.h.core.telemetry.interactionCount();
    const minutes = Math.max(1, Math.round(this.h.core.observer.activeTimeMs / 60_000));
    const copy: Record<EndingId, string> = {
      acknowledgment: 'You looked back.',
      refusal: 'You left. The room stayed.',
      reversal: 'It learned how you move.',
    };
    const detail = [
      `${minutes} minute${minutes === 1 ? '' : 's'} in the room, ${events} things touched.`,
      p.mostInspected ? `You kept returning to the ${PLACEMENTS[p.mostInspected].label.toLowerCase()}.` : '',
      'Everything it knew came from inside the room, and it is gone when you close this tab.',
    ]
      .filter(Boolean)
      .join(' ');
    this.h.showEnd(ending, copy[ending], detail);
  }
}
