import { Vector3, type Object3D, type Texture } from 'three';
import { BOOK_IDS, CHAIR, SLOTS, type BookId, type ObjectId } from '../core/layout';
import { springStep } from '../core/math';
import type { ObjectState } from '../world/objects';
import type { WorldState } from '../world/WorldState';
import type { CaptureService } from './CaptureService';
import type { GardenKey } from './photoPainter';
import type { PhotoFrame } from './PhotoFrame';
import type { Room } from './RoomBuilder';

interface Spring {
  pos: number;
  vel: number;
}

const SLOT_BY_ID = new Map(SLOTS.map((s) => [s.id, s]));
const DRAWER_TRAVEL = 0.33;
const DOOR_SWING = 1.9;

/**
 * Applies world state to the rendered room. The world state is authoritative;
 * the presenter only adds physical motion (springs with mass and damping) so
 * drawers, doors and curtains move believably, never teleport.
 */
export class ScenePresenter {
  private springs = new Map<string, Spring>();
  /** Objects currently held/dragged by the player; their transforms are driven by interaction. */
  readonly overridden = new Set<ObjectId>();
  private lampLevel = 0;
  private lampTarget = 0;
  private flicker = 0;
  curtainOpen = 1;
  sunScale = 1;
  private visibleCheck: (id: ObjectId) => boolean = () => true;

  constructor(
    private readonly room: Room,
    private readonly world: WorldState,
    private readonly photo: PhotoFrame,
    private readonly gardens: Record<GardenKey, Texture>,
    private readonly captures: CaptureService,
  ) {
    world.emitter.on('changed', ({ objectId, state }) => this.onChange(objectId, state));
    for (const id of world.ids()) this.onChange(id, world.get(id), true);
  }

  /** The presenter swaps photographs instantly only when the frame is unseen. */
  setVisibilityCheck(fn: (id: ObjectId) => boolean): void {
    this.visibleCheck = fn;
  }

  private spring(key: string, initial: number): Spring {
    let s = this.springs.get(key);
    if (!s) this.springs.set(key, (s = { pos: initial, vel: 0 }));
    return s;
  }

  private onChange(id: ObjectId, s: Readonly<ObjectState>, initial = false): void {
    const p = this.room.parts;
    switch (id) {
      case 'chair':
        if (!this.overridden.has('chair')) this.placeChair(s);
        break;
      case 'lamp':
        this.lampTarget = s.on ? 1 : 0;
        if (initial) this.lampLevel = this.lampTarget;
        break;
      case 'photograph':
        this.updatePhoto(s, initial);
        p.photo.group.rotation.y = Math.PI / 2 + (s.tilt ?? 0);
        break;
      case 'figurine':
      case 'cup':
        if (!this.overridden.has(id)) this.placeItem(id, s);
        break;
      default:
        if ((BOOK_IDS as readonly string[]).includes(id) && !this.overridden.has(id)) this.placeItem(id, s);
    }
    if (initial) {
      if (id === 'drawer_top' || id === 'drawer_bottom') this.spring(id, s.open ?? 0).pos = s.open ?? 0;
      if (id === 'door') this.spring('door', s.open ?? 0).pos = s.open ?? 0;
      if (id === 'curtains') this.spring('curtains', s.open ?? 1).pos = s.open ?? 1;
    }
  }

  placeChair(s: Readonly<ObjectState>): void {
    const c = this.room.parts.chair;
    c.position.set(s.x ?? CHAIR.initial.x, 0, s.z ?? CHAIR.initial.z);
    c.rotation.y = s.yaw ?? CHAIR.initial.yaw;
  }

  /** World transform of a slot (books stand on shelves, lie flat elsewhere). */
  placeItem(id: ObjectId, s: Readonly<ObjectState>): void {
    const obj = this.room.roots[id];
    if (!obj || !s.slot || s.state === 'held') return;
    const slot = SLOT_BY_ID.get(s.slot);
    if (!slot) return;
    const isBook = (BOOK_IDS as readonly string[]).includes(id);
    if (slot.surface === 'drawer_top') {
      // Lives inside the drawer and travels with it.
      const drawer = this.room.parts.drawers.drawer_top.children[0];
      drawer.add(obj);
      obj.position.set(0, 0.03, 0.02);
      obj.rotation.set(isBook ? -Math.PI / 2 : 0, 0, 0);
      if (isBook) obj.rotation.set(0, Math.PI / 2, Math.PI / 2);
      return;
    }
    if (obj.parent !== this.room.scene) this.room.scene.add(obj);
    obj.position.set(slot.position[0], slot.position[1], slot.position[2]);
    if (isBook) {
      if (slot.surface === 'shelf') obj.rotation.set(0, s.yaw ?? 0, 0);
      else {
        obj.rotation.set(0, s.yaw ?? 0.3, Math.PI / 2);
        obj.position.y += 0.022;
      }
      this.room.parts.bookCovers[id as BookId].rotation.y = s.tilt ?? 0;
    } else {
      obj.rotation.set(0, s.yaw ?? 0, 0);
    }
  }

  private updatePhoto(s: Readonly<ObjectState>, initial: boolean): void {
    const instant = initial || !this.visibleCheck('photograph');
    const state = s.state;
    if (state.startsWith('room_') && s.captureId !== undefined) {
      const tex = this.captures.texture(s.captureId);
      if (tex) this.photo.show(`cap:${s.captureId}`, tex, true, instant);
      this.captures.pin([s.captureId]);
      return;
    }
    this.captures.pin([]);
    let key: GardenKey;
    if (state === 'gazing') key = (`gazing_${s.mode === 'shifted' || s.mode === 'removed' ? s.mode : 'original'}`) as GardenKey;
    else key = (['original', 'shifted', 'removed', 'empty'].includes(state) ? state : 'original') as GardenKey;
    this.photo.show(key, this.gardens[key], false, instant);
  }

  /** Lamp flicker effect: brief, irregular dips. */
  flickerFor(ms: number): void {
    this.flicker = ms / 1000;
  }

  update(dt: number, time: number, clockMs: number): void {
    const p = this.room.parts;
    const w = this.world;
    // Drawers and door on springs.
    for (const id of ['drawer_top', 'drawer_bottom'] as const) {
      const target = w.get(id).open ?? 0;
      const s = this.spring(id, target);
      [s.pos, s.vel] = springStep(s.pos, s.vel, target, 140, 22, dt);
      p.drawers[id].position.z = Math.max(0, s.pos) * DRAWER_TRAVEL;
    }
    const door = w.get('door');
    const ds = this.spring('door', door.open ?? 0);
    [ds.pos, ds.vel] = springStep(ds.pos, ds.vel, door.open ?? 0, 30, 9, dt);
    p.doorPivot.rotation.y = -ds.pos * DOOR_SWING;
    const hs = this.spring('handle', door.handle ?? 0);
    [hs.pos, hs.vel] = springStep(hs.pos, hs.vel, door.handle ?? 0, 260, 26, dt);
    p.doorHandle.rotation.x = -hs.pos * 0.75;

    // Curtains
    const cs = this.spring('curtains', w.get('curtains').open ?? 1);
    [cs.pos, cs.vel] = springStep(cs.pos, cs.vel, w.get('curtains').open ?? 1, 18, 8, dt);
    this.curtainOpen = cs.pos;
    const scale = 1 - cs.pos * 0.62;
    p.curtains.left.scale.x = scale;
    p.curtains.right.scale.x = scale;
    const sh = p.curtains.material.userData.shader as { uniforms: { uTime: { value: number } } } | undefined;
    if (sh) sh.uniforms.uTime.value = time;

    // Lamp with a filament warm-up / cool-down and optional flicker.
    const rate = this.lampTarget > this.lampLevel ? 14 : 9;
    this.lampLevel += (this.lampTarget - this.lampLevel) * Math.min(1, dt * rate);
    let level = this.lampLevel;
    if (this.flicker > 0) {
      this.flicker -= dt;
      const f = Math.sin(time * 61) * Math.sin(time * 23.7);
      level *= f > 0.2 ? 0.15 : 1;
    }
    p.lamp.light.intensity = level * 3.2;
    p.lamp.shadeMat.emissiveIntensity = level * 0.75;
    p.lamp.bulbMat.emissiveIntensity = level * 4;

    // Fan
    p.fanRotor.rotation.y -= dt * 2.2;

    // Clock hands from the fictional time plus the clock's own (possibly wrong) offset.
    const clock = w.get('clock');
    const t = (clockMs + (clock.offsetMs ?? 0)) / 1000;
    const sec = Math.floor(t) % 60;
    p.clockHands.second.rotation.z = -(sec / 60) * Math.PI * 2;
    p.clockHands.minute.rotation.z = -((t / 60) % 60) / 60 * Math.PI * 2;
    p.clockHands.hour.rotation.z = -((t / 3600) % 12) / 12 * Math.PI * 2;

    this.photo.update(dt);
  }

  /** Current world position of an object's root (for held objects, attention, etc.). */
  worldPosition(id: ObjectId, out = new Vector3()): Vector3 {
    const o: Object3D | undefined = this.room.roots[id];
    if (!o) return out.set(0, 0, 0);
    return o.getWorldPosition(out);
  }
}
