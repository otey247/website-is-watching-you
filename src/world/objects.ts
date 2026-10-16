import { BOOK_IDS, CHAIR, INITIAL_SLOTS, type BookId, type ObjectId } from '../core/layout';

/**
 * Explicit valid-state definitions for every mutable object.
 * The mutation engine rejects any state not listed here: the Observer and the
 * Director can only move the room between authored, believable configurations.
 */
export const PHOTO_VARIANTS = [
  'original', // three people standing in a garden
  'shifted', // one person stands somewhere else
  'removed', // only two people remain
  'gazing', // one person looks directly toward the viewer
  'room_now', // a photograph of this room (captured from the fictional scene)
  'room_past', // an earlier arrangement the player created
  'room_figure', // the current room with one additional indistinct figure
  'empty', // the garden, nobody in it
] as const;
export type PhotoVariant = (typeof PHOTO_VARIANTS)[number];

export const CHAIR_STATES = [
  'original',
  'rotated_slight',
  'crept',
  'closer_desk',
  'facing_wall',
  'facing_player_prev',
  'facing_player_now',
  'player_moved',
] as const;
export type ChairState = (typeof CHAIR_STATES)[number];

export interface ObjectState {
  state: string;
  x?: number;
  z?: number;
  yaw?: number;
  open?: number;
  on?: boolean;
  slot?: string;
  offsetMs?: number;
  tilt?: number;
  handle?: number;
  mode?: string;
  contents?: string[];
  /** Capture/snapshot id backing a photograph variant. */
  captureId?: number;
}

export interface MutableDefinition {
  id: ObjectId;
  states: readonly string[];
  initial: ObjectState;
  /** Extra numeric constraints validated on every mutation. */
  ranges?: Partial<Record<keyof ObjectState, [number, number]>>;
}

const bookDef = (id: BookId): MutableDefinition => ({
  id,
  states: ['shelved', 'moved', 'held', 'in_drawer', 'ajar', 'returned_facing'],
  initial: { state: 'shelved', slot: INITIAL_SLOTS[id], tilt: 0, yaw: 0 },
  ranges: { tilt: [0, 0.6] },
});

export const MUTABLE_DEFINITIONS: Partial<Record<ObjectId, MutableDefinition>> = {
  photograph: {
    id: 'photograph',
    states: PHOTO_VARIANTS,
    initial: { state: 'original', tilt: 0 },
    ranges: { tilt: [-0.12, 0.12] },
  },
  chair: {
    id: 'chair',
    states: CHAIR_STATES,
    initial: { state: 'original', x: CHAIR.initial.x, z: CHAIR.initial.z, yaw: CHAIR.initial.yaw },
  },
  clock: {
    id: 'clock',
    states: ['normal', 'lost_seconds', 'stalled'],
    initial: { state: 'normal', offsetMs: 0 },
    ranges: { offsetMs: [-120000, 0] },
  },
  lamp: { id: 'lamp', states: ['on', 'off'], initial: { state: 'off', on: false } },
  drawer_top: {
    id: 'drawer_top',
    states: ['closed', 'open', 'ajar'],
    initial: { state: 'closed', open: 0, contents: ['photo_old', 'pen', 'keys'] },
    ranges: { open: [0, 1] },
  },
  drawer_bottom: {
    id: 'drawer_bottom',
    states: ['closed', 'open', 'ajar'],
    initial: { state: 'closed', open: 0, contents: ['letters'] },
    ranges: { open: [0, 1] },
  },
  door: {
    id: 'door',
    states: ['closed', 'ajar', 'open', 'wide'],
    initial: { state: 'ajar', open: 0.12, handle: 0 },
    ranges: { open: [0, 1], handle: [0, 1] },
  },
  curtains: { id: 'curtains', states: ['open', 'closed'], initial: { state: 'open', open: 1 }, ranges: { open: [0, 1] } },
  mirror: {
    id: 'mirror',
    states: ['normal', 'lag', 'past_chair', 'distort', 'presence'],
    initial: { state: 'normal' },
  },
  figurine: {
    id: 'figurine',
    states: ['shelved', 'moved', 'held', 'facing_camera'],
    initial: { state: 'shelved', slot: INITIAL_SLOTS.figurine, yaw: Math.PI / 2 + 0.6 },
  },
  cup: { id: 'cup', states: ['shelved', 'moved', 'held'], initial: { state: 'shelved', slot: INITIAL_SLOTS.cup, yaw: 0.4 } },
  computer: {
    id: 'computer',
    states: ['desktop', 'message', 'surveillance', 'question', 'dark'],
    initial: { state: 'desktop' },
  },
  ...Object.fromEntries(BOOK_IDS.map((b) => [b, bookDef(b)])),
};

export function isValidState(id: ObjectId, state: string): boolean {
  const def = MUTABLE_DEFINITIONS[id];
  return !!def && def.states.includes(state);
}
