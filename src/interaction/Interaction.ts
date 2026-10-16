import { Mesh, MeshBasicMaterial, Plane, Raycaster, RingGeometry, Vector2, Vector3, type Intersection, type Object3D } from 'three';
import type { SoundId } from '../audio/sounds';
import { BOOK_IDS, CHAIR, INITIAL_SLOTS, PLACEMENTS, SLOTS, type ObjectId, type V3 } from '../core/layout';
import { springStep } from '../core/math';
import type { GameCore } from '../game/GameCore';
import { resolvePosition } from '../world/collision';
import type { ObjectState } from '../world/objects';
import type { ComputerScreen, ScreenAction } from '../scene/ComputerScreen';
import type { Room } from '../scene/RoomBuilder';
import type { ScenePresenter } from '../scene/ScenePresenter';
import { INSPECT_POSES, type CameraRig } from './CameraRig';

export interface InteractionHooks {
  /** Return true when an ending consumed the door click. */
  onDoorClick(): boolean;
  onScreenAction(a: ScreenAction): void;
  onEscapeIdle(): void;
  locked(): boolean;
  sound(id: SoundId, at: V3, gain?: number): void;
}

type Held = { id: ObjectId; from: ObjectState; since: number; rotX: number; rotY: number; velX: number; velY: number; pos: Vector3 };

const PICKABLE: ObjectId[] = [...BOOK_IDS, 'figurine', 'cup'];
const SLOT_POS = new Map(SLOTS.map((s) => [s.id, new Vector3(...s.position)]));

/**
 * Pointer and touch interaction: raycast targeting, inspection, toggles,
 * chair dragging with inertia and collision, holding/rotating/placing small
 * objects, free look and pinch/wheel zoom. Dragging an object and looking
 * around are disambiguated on pointer-down by what is under the pointer.
 */
export class Interaction {
  private raycaster = new Raycaster();
  readonly pointer = new Vector2(0, 0);
  pointerInside = false;
  private down: { x: number; y: number; t: number; target: ObjectId | null; id: number } | null = null;
  private dragging: 'camera' | 'chair' | 'held' | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;
  hovered: ObjectId | null = null;
  held: Held | null = null;
  private chairDrag: { offset: Vector3; from: ObjectState; target: Vector3; vel: Vector3; swivel: number; swivelVel: number; active: boolean } | null = null;
  private inspectStart = 0;
  private floor = new Plane(new Vector3(0, 1, 0), 0);
  private slotMarker: Mesh;
  private hoverSlot: string | null = null;
  private lastTrailAt = 0;
  private velocity = new Vector2();
  private lastMove = { x: 0, y: 0, t: 0 };
  private tweens: { update: (dt: number) => boolean }[] = [];
  private pickTargets: Object3D[];

  constructor(
    private readonly el: HTMLElement,
    private readonly rig: CameraRig,
    private readonly room: Room,
    private readonly core: GameCore,
    private readonly presenter: ScenePresenter,
    private readonly screen: ComputerScreen,
    private readonly hooks: InteractionHooks,
    private readonly onTrail: (p: [number, number, number], n: [number, number, number], surface: string) => void,
  ) {
    this.pickTargets = [...room.pickables, ...room.occluders];
    this.slotMarker = new Mesh(new RingGeometry(0.035, 0.045, 32), new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.5, depthTest: false }));
    this.slotMarker.rotation.x = -Math.PI / 2;
    this.slotMarker.visible = false;
    this.slotMarker.renderOrder = 10;
    room.scene.add(this.slotMarker);
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
    el.addEventListener('pointerleave', this.onLeave);
    el.addEventListener('pointerenter', this.onEnter);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', this.onContext);
  }

  private onLeave = (): void => {
    this.pointerInside = false;
    this.setHover(null);
  };

  private onEnter = (): void => {
    this.pointerInside = true;
  };

  private onContext = (e: Event): void => e.preventDefault();

  get pointerVelocity(): Vector2 {
    return this.velocity;
  }

  private ndc(e: { clientX: number; clientY: number }): Vector2 {
    const r = this.el.getBoundingClientRect();
    return new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  /** First hit along the pointer ray; occluders block objects behind them. */
  /** Which object a click at this NDC would reach (test hooks). */
  idAt(ndc: Vector2): ObjectId | null {
    return this.pick(ndc).id;
  }

  private pick(ndc: Vector2): { id: ObjectId | null; hit: Intersection | null } {
    this.raycaster.setFromCamera(ndc, this.rig.camera);
    const hits = this.raycaster.intersectObjects(this.pickTargets, false);
    for (const h of hits) {
      if (!h.object.visible) continue;
      if (this.held && isUnder(h.object, this.room.roots[this.held.id]!)) continue;
      const id = (h.object.userData.objectId as ObjectId | undefined) ?? null;
      return { id, hit: h };
    }
    return { id: null, hit: null };
  }

  private setHover(id: ObjectId | null): void {
    if (id === this.hovered) return;
    this.hovered = id;
    this.core.hover(id);
    const interactive = id && PLACEMENTS[id].interaction !== 'none';
    this.el.style.cursor = this.dragging === 'camera' ? 'grabbing' : interactive || this.held ? 'pointer' : 'default';
  }

  private onDown = (e: PointerEvent): void => {
    if (this.hooks.locked()) return;
    this.el.setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      this.down = null;
      this.dragging = null;
      return;
    }
    const ndc = this.ndc(e);
    this.pointer.copy(ndc);
    const { id } = this.pick(ndc);
    this.down = { x: e.clientX, y: e.clientY, t: performance.now(), target: id, id: e.pointerId };
  };

  private onMove = (e: PointerEvent): void => {
    // movementX/Y are 0 for touch in several browsers, so deltas come from the last position.
    const prev = this.pointers.get(e.pointerId);
    const dx = prev ? e.clientX - prev.x : e.movementX || 0;
    const dy = prev ? e.clientY - prev.y : e.movementY || 0;
    if (prev) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const ndc = this.ndc(e);
    const now = performance.now();
    const dtm = Math.max(1, now - this.lastMove.t) / 1000;
    if (dtm < 0.25) this.velocity.set((ndc.x - this.lastMove.x) / dtm, (ndc.y - this.lastMove.y) / dtm);
    else this.velocity.set(0, 0);
    this.lastMove = { x: ndc.x, y: ndc.y, t: now };
    this.pointer.copy(ndc);
    this.core.pointerMoved();
    if (this.hooks.locked()) return;

    // Pinch zoom
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      this.rig.zoom((this.pinchDist - d) * 0.06);
      this.pinchDist = d;
      return;
    }

    if (this.down && !this.dragging) {
      const moved = Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y);
      if (moved > 6) {
        if (this.held && this.down.target === this.held.id) this.dragging = 'held';
        else if (this.down.target === 'chair' && this.rig.mode === 'look') this.beginChairDrag(ndc);
        else this.dragging = 'camera';
        this.el.style.cursor = this.dragging === 'camera' ? 'grabbing' : 'grab';
      }
    }
    if (this.dragging === 'camera') {
      this.rig.rotateBy(dx, dy);
      this.core.cameraMoved();
    } else if (this.dragging === 'held' && this.held) {
      this.held.velY += dx * 0.012;
      this.held.velX += dy * 0.012;
    } else if (this.dragging === 'chair') {
      this.updateChairTarget(ndc);
    }

    // Hover + trail (≈30 Hz)
    if (now - this.lastTrailAt > 33) {
      this.lastTrailAt = now;
      const { id, hit } = this.pick(ndc);
      if (!this.dragging) this.setHover(id);
      if (hit && hit.face) {
        const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
        const oid = hit.object.userData.objectId as string | undefined;
        const surface = (hit.object.userData.surface as string | undefined) ?? (oid ? `obj:${oid}` : hit.object.uuid);
        this.onTrail([hit.point.x, hit.point.y, hit.point.z], [n.x, n.y, n.z], surface);
      }
      if (this.held) this.updateSlotHover(hit);
      if (this.rig.inspecting === 'computer' && hit && hit.object === this.room.parts.screen && hit.uv) this.screen.moveCursor(hit.uv.x, hit.uv.y);
    }
  };

  private onUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    const d = this.down;
    const wasDragging = this.dragging;
    this.down = null;
    this.dragging = null;
    if (wasDragging === 'chair') this.endChairDrag();
    this.el.style.cursor = this.hovered ? 'pointer' : 'default';
    if (!d || d.id !== e.pointerId || wasDragging || this.hooks.locked()) return;
    if (performance.now() - d.t > 700) return; // a long press is not a click
    this.click(this.ndc(e));
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    if (this.hooks.locked()) return;
    this.rig.zoom(Math.sign(e.deltaY) * 2.5);
  };

  /** Click/tap on whatever is under the pointer. Public for keyboard and test use. */
  click(ndc: Vector2): void {
    const { id, hit } = this.pick(ndc);
    const now = this.core.clock.now;

    if (this.held) {
      if (this.hoverSlot) this.placeHeld(this.hoverSlot);
      else if (id !== this.held.id) this.placeHeld(null);
      return;
    }

    if (this.rig.inspecting) {
      if (this.rig.inspecting === 'computer' && hit?.object === this.room.parts.screen && hit.uv) {
        const a = this.screen.click(hit.uv.x, hit.uv.y);
        if (a.kind === 'open') this.core.report('computer_note_opened', 'computer', { meta: { index: a.index, title: this.screen.notes[a.index]?.title ?? '' } });
        this.hooks.onScreenAction(a);
        this.hooks.sound('key_tap', PLACEMENTS.computer.center, 0.2);
        return;
      }
      if (id !== this.rig.inspecting) this.endInspect();
      return;
    }

    if (!id) return;
    const kind = PLACEMENTS[id].interaction;
    if (kind === 'inspect') this.beginInspect(id, now);
    else if (kind === 'toggle') this.toggle(id);
    else if (kind === 'pick') this.pickUp(id);
    else if (kind === 'drag' && id === 'chair') this.nudgeChair();
  }

  // ——— Inspection ———

  private beginInspect(id: ObjectId, now: number): void {
    if (!INSPECT_POSES[id]) return;
    if (this.rig.inspect(id)) {
      this.inspectStart = now;
      if (id === 'note') this.hooks.sound('paper', PLACEMENTS.note.center, 0.25);
    }
  }

  endInspect(): void {
    const id = this.rig.inspecting;
    if (!id) return;
    const duration = this.core.clock.now - this.inspectStart;
    this.rig.exitInspect();
    this.core.report('object_inspected', id, { durationMs: duration });
  }

  // ——— Toggles ———

  private toggle(id: ObjectId): void {
    const w = this.core.world;
    this.core.grab(id);
    const at = PLACEMENTS[id].center;
    switch (id) {
      case 'lamp': {
        const on = !w.get('lamp').on;
        w.apply('lamp', { state: on ? 'on' : 'off', on }, { source: 'player', cause: 'toggle' });
        this.hooks.sound('lamp_click', [-2.1, 1.5, -1.65], 0.55);
        this.core.release(id);
        this.core.report('lamp_toggled', 'lamp', { meta: { on } });
        return;
      }
      case 'drawer_top':
      case 'drawer_bottom': {
        const open = (w.get(id).open ?? 0) < 0.5;
        w.apply(id, { state: open ? 'open' : 'closed', open: open ? 1 : 0 }, { source: 'player', cause: 'toggle' });
        this.hooks.sound(open ? 'drawer_open' : 'drawer_close', at, 0.55);
        this.core.release(id);
        this.core.report(open ? 'drawer_opened' : 'drawer_closed', id);
        return;
      }
      case 'curtains': {
        const open = (w.get('curtains').open ?? 1) < 0.5;
        w.apply('curtains', { state: open ? 'open' : 'closed', open: open ? 1 : 0 }, { source: 'player', cause: 'toggle' });
        this.hooks.sound('curtain', at, 0.45);
        this.core.release(id);
        this.core.report('curtains_toggled', 'curtains', { meta: { open } });
        return;
      }
      case 'door': {
        this.core.release(id);
        this.core.report('door_handle_tried', 'door');
        this.turnHandle();
        if (this.hooks.onDoorClick()) return;
        this.core.grab('door');
        const open = (w.get('door').open ?? 0) < 0.3;
        w.apply('door', { state: open ? 'open' : 'ajar', open: open ? 0.42 : 0.12 }, { source: 'player', cause: 'toggle' });
        this.hooks.sound('door_creak', at, 0.4);
        this.core.release('door');
        this.core.report(open ? 'door_opened' : 'door_closed', 'door');
        return;
      }
    }
    this.core.release(id);
  }

  private turnHandle(): void {
    const w = this.core.world;
    this.hooks.sound('door_handle', [2.45, 1.0, -0.43], 0.4);
    let t = 0;
    this.tweens.push({
      update: (dt) => {
        t += dt;
        const v = t < 0.25 ? t / 0.25 : Math.max(0, 1 - (t - 0.35) / 0.3);
        if (!w.claimOwner('door') || w.claimOwner('door') === 'player') w.apply('door', { handle: Math.min(1, v) }, { source: 'player', cause: 'handle', continuous: true });
        return t < 0.7;
      },
    });
  }

  // ——— Chair ———

  private beginChairDrag(ndc: Vector2): void {
    const hit = this.floorPoint(ndc);
    if (!hit) return;
    this.core.grab('chair');
    const s = this.core.world.get('chair');
    const pos = new Vector3(s.x, 0, s.z);
    this.chairDrag = { offset: pos.clone().sub(hit), from: { ...s }, target: pos.clone(), vel: new Vector3(), swivel: 0, swivelVel: 0, active: true };
    this.dragging = 'chair';
    this.hooks.sound('chair_creak', [pos.x, 0.5, pos.z], 0.25);
  }

  private updateChairTarget(ndc: Vector2): void {
    const hit = this.floorPoint(ndc);
    if (!hit || !this.chairDrag) return;
    this.chairDrag.target.copy(hit).add(this.chairDrag.offset);
  }

  private endChairDrag(): void {
    if (!this.chairDrag) return;
    this.chairDrag.active = false;
  }

  private nudgeChair(): void {
    const w = this.core.world;
    const s = w.get('chair');
    this.core.grab('chair');
    const from = { ...s };
    const start = s.yaw ?? CHAIR.initial.yaw;
    const end = start + 0.35;
    let t = 0;
    this.hooks.sound('chair_creak', [s.x ?? 0, 0.5, s.z ?? 0], 0.35);
    this.tweens.push({
      update: (dt) => {
        t = Math.min(1, t + dt / 0.6);
        const e = 1 - Math.pow(1 - t, 3);
        w.apply('chair', { yaw: start + (end - start) * e }, { source: 'player', cause: 'swivel', continuous: true });
        if (t >= 1) {
          w.apply('chair', { state: 'player_moved' }, { source: 'player', cause: 'swivel', continuous: true });
          const rec = w.commit('chair', from, 'player', 'swivel');
          this.core.release('chair');
          this.core.report('chair_moved', 'chair', { meta: { rotated: true, distance: 0, record: rec.id } });
        }
        return t < 1;
      },
    });
  }

  private floorPoint(ndc: Vector2): Vector3 | null {
    this.raycaster.setFromCamera(ndc, this.rig.camera);
    const p = new Vector3();
    return this.raycaster.ray.intersectPlane(this.floor, p);
  }

  // ——— Held objects ———

  private pickUp(id: ObjectId): void {
    if (!PICKABLE.includes(id)) return;
    const w = this.core.world;
    const s = w.get(id);
    if (s.state === 'held') return;
    this.core.grab(id);
    const from = { ...s };
    const obj = this.room.roots[id]!;
    const pos = obj.getWorldPosition(new Vector3());
    if (obj.parent !== this.room.scene) {
      this.room.scene.attach(obj);
    }
    w.apply(id, { state: 'held' }, { source: 'player', cause: 'pick_up', continuous: true });
    this.presenter.overridden.add(id);
    this.held = { id, from, since: this.core.clock.now, rotX: obj.rotation.x, rotY: obj.rotation.y, velX: 0, velY: 0, pos };
    this.hooks.sound(id === 'cup' ? 'cup_clink' : 'book_lift', [pos.x, pos.y, pos.z], 0.35);
    this.core.report('object_picked_up', id, { meta: { from: from.slot ?? '' } });
  }

  private updateSlotHover(hit: Intersection | null): void {
    if (!this.held) return;
    this.hoverSlot = null;
    if (hit) {
      const allowed = SLOTS.filter((s) => s.surface !== 'drawer_top' && (this.held!.id.startsWith('book') || s.surface !== 'shelf' || this.held!.id === 'figurine' || this.held!.id === 'cup'));
      let best: string | null = null;
      let bd = 0.16;
      for (const s of allowed) {
        const occ = this.core.world.slotOccupant(s.id);
        if (occ && occ !== this.held.id) continue;
        const d = SLOT_POS.get(s.id)!.distanceTo(hit.point);
        if (d < bd) {
          bd = d;
          best = s.id;
        }
      }
      this.hoverSlot = best;
    }
    if (this.hoverSlot) {
      const p = SLOT_POS.get(this.hoverSlot)!;
      this.slotMarker.position.set(p.x, p.y + 0.004, p.z);
      this.slotMarker.visible = true;
    } else this.slotMarker.visible = false;
  }

  /** Place the held object in a slot, or return it where it came from. */
  placeHeld(slot: string | null): void {
    if (!this.held) return;
    const h = this.held;
    const w = this.core.world;
    const home = h.from.slot ?? INITIAL_SLOTS[h.id as keyof typeof INITIAL_SLOTS];
    const target = slot && SLOT_POS.has(slot) ? slot : home;
    const occupied = w.slotOccupant(target);
    const finalSlot = occupied && occupied !== h.id ? h.from.slot! : target;
    const sameAsOrigin = finalSlot === h.from.slot;
    const state = h.id.startsWith('book') ? (finalSlot === INITIAL_SLOTS[h.id as keyof typeof INITIAL_SLOTS] ? 'shelved' : 'moved') : finalSlot === INITIAL_SLOTS[h.id as keyof typeof INITIAL_SLOTS] ? 'shelved' : 'moved';
    this.presenter.overridden.delete(h.id);
    const res = w.apply(h.id, { state, slot: finalSlot, yaw: h.id.startsWith('book') ? 0 : h.from.yaw }, { source: 'player', cause: 'place', continuous: true });
    if (!res.ok) w.apply(h.id, { ...h.from }, { source: 'player', cause: 'place', continuous: true });
    w.commit(h.id, h.from, 'player', 'place');
    this.presenter.placeItem(h.id, w.get(h.id));
    this.core.release(h.id);
    this.slotMarker.visible = false;
    this.hoverSlot = null;
    this.held = null;
    const p = SLOT_POS.get(finalSlot)!;
    this.hooks.sound(h.id === 'cup' ? 'cup_clink' : 'book_place', [p.x, p.y, p.z], 0.4);
    this.core.report('object_inspected', h.id, { durationMs: this.core.clock.now - h.since });
    this.core.report('object_placed', h.id, { meta: { slot: finalSlot, returned: sameAsOrigin } });
  }

  /** Escape: leave whatever mode we're in. */
  escape(): void {
    if (this.held) this.placeHeld(null);
    else if (this.rig.inspecting || this.rig.mode === 'transition') this.endInspect();
    else this.hooks.onEscapeIdle();
  }

  update(dt: number): void {
    this.tweens = this.tweens.filter((t) => t.update(dt));
    const w = this.core.world;
    // Chair follows the pointer with mass, inertia and collision.
    const cd = this.chairDrag;
    if (cd) {
      const s = w.get('chair');
      const pos = new Vector3(s.x, 0, s.z);
      if (cd.active) {
        const toTarget = cd.target.clone().sub(pos);
        cd.vel.addScaledVector(toTarget, 60 * dt).multiplyScalar(Math.exp(-11 * dt));
      } else cd.vel.multiplyScalar(Math.exp(-7 * dt));
      const next = pos.clone().addScaledVector(cd.vel, dt);
      const resolved = resolvePosition({ x: next.x, z: next.z }, CHAIR.radius);
      if (Math.abs(resolved.x - next.x) + Math.abs(resolved.z - next.z) > 1e-4) cd.vel.multiplyScalar(0.4); // contact
      // Swivel slightly with lateral motion: the chair has inertia.
      const lateral = cd.vel.x * Math.cos(s.yaw ?? 0) - cd.vel.z * Math.sin(s.yaw ?? 0);
      [cd.swivel, cd.swivelVel] = springStep(cd.swivel, cd.swivelVel, lateral * 0.12, 30, 8, dt);
      w.apply('chair', { x: resolved.x, z: resolved.z, yaw: (cd.from.yaw ?? 0) + cd.swivel, state: 'player_moved' }, { source: 'player', cause: 'drag', continuous: true });
      this.presenter.placeChair(w.get('chair'));
      if (!cd.active && cd.vel.length() < 0.01 && Math.abs(cd.swivelVel) < 0.01) {
        const dist = Math.hypot((s.x ?? 0) - (cd.from.x ?? 0), (s.z ?? 0) - (cd.from.z ?? 0));
        w.commit('chair', cd.from, 'player', 'drag');
        this.chairDrag = null;
        this.core.release('chair');
        if (dist > 0.03) {
          this.hooks.sound('chair_scrape', [s.x ?? 0, 0.2, s.z ?? 0], Math.min(0.6, 0.2 + dist));
          this.core.report('chair_moved', 'chair', { meta: { distance: Math.round(dist * 100) / 100 } });
        }
      }
    }
    // Held object floats in front of the camera with rotational inertia.
    const h = this.held;
    if (h) {
      const obj = this.room.roots[h.id]!;
      const cam = this.rig.camera;
      const target = new Vector3(0.0, -0.03, -0.56).applyQuaternion(cam.quaternion).add(cam.position);
      obj.position.lerp(target, Math.min(1, dt * 9));
      h.rotY += h.velY * dt * 6;
      h.rotX += h.velX * dt * 6;
      h.velX *= Math.exp(-4 * dt);
      h.velY *= Math.exp(-4 * dt);
      obj.quaternion.copy(cam.quaternion);
      // Books show their front cover; small objects face the viewer.
      obj.rotateY(h.rotY + (h.id.startsWith('book') ? 0.35 : Math.PI / 2));
      obj.rotateX(h.rotX);
      obj.translateY(-0.08);
    }
  }

  dispose(): void {
    this.el.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('pointercancel', this.onUp);
    this.el.removeEventListener('pointerleave', this.onLeave);
    this.el.removeEventListener('pointerenter', this.onEnter);
    this.el.removeEventListener('wheel', this.onWheel);
    this.el.removeEventListener('contextmenu', this.onContext);
    this.slotMarker.removeFromParent();
    this.el.style.cursor = 'default';
  }
}

function isUnder(o: Object3D, root: Object3D): boolean {
  let x: Object3D | null = o;
  while (x) {
    if (x === root) return true;
    x = x.parent;
  }
  return false;
}
