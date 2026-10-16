import type { AreaId, ObjectId } from '../core/layout';

/**
 * Every in-game action that the Observer is allowed to know about.
 * Only actions inside the rendered room are represented. There is no event
 * type for anything outside the experience, by construction.
 */
export const ACTION_TYPES = [
  'session_started',
  'object_inspected',
  'object_picked_up',
  'object_placed',
  'drawer_opened',
  'drawer_closed',
  'lamp_toggled',
  'curtains_toggled',
  'chair_moved',
  'door_opened',
  'door_closed',
  'door_handle_tried',
  'computer_note_opened',
  'computer_answered',
  'object_hesitated',
  'area_glanced',
  'area_avoided',
  'anomaly_witnessed',
  'anomaly_investigated',
  'sound_reacted',
  'prediction_resolved',
  'message_read',
  'player_idle',
  'look_away_test',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export interface CameraSample {
  position: [number, number, number];
  yaw: number;
  pitch: number;
}

/** Room state captured at the moment of an event. */
export interface RoomContext {
  lampOn: boolean;
  doorOpen: boolean;
  drawerOpen: boolean;
  curtainsOpen: boolean;
  chairState: string;
  photoVariant: string;
  phase: string;
}

export type MetaValue = string | number | boolean;

export interface BehavioralEvent {
  /** Monotonic event identifier, unique within a session. */
  id: number;
  type: ActionType;
  target?: ObjectId;
  area?: AreaId;
  /** Session-relative active-play timestamp. */
  timestampMs: number;
  durationMs?: number;
  camera: CameraSample;
  context: RoomContext;
  meta: Record<string, MetaValue>;
  /** Systems that have consumed this event (director anomalies, narrative templates). */
  usedBy: string[];
  /** Convenience flag mirroring usedBy.length > 0 for the director. */
  used: boolean;
  /** Optional id of a room-state snapshot stored with this event. */
  snapshotId?: number;
}

export type EventInput = Omit<BehavioralEvent, 'id' | 'timestampMs' | 'usedBy' | 'used' | 'camera' | 'context'> & {
  camera?: CameraSample;
  context?: Partial<RoomContext>;
};
