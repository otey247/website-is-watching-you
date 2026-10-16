/**
 * Authoritative room layout shared by the simulation core and the renderer.
 * Units are meters. The room spans x ∈ [-2.5, 2.5], z ∈ [-2.1, 2.1], y ∈ [0, 2.7].
 * North wall is z = -2.1 (desk + window), south wall z = +2.1 (mirror),
 * west wall x = -2.5 (photograph + bookcase), east wall x = +2.5 (door + clock).
 */

export const ROOM = { minX: -2.5, maxX: 2.5, minZ: -2.1, maxZ: 2.1, height: 2.7 } as const;

export const BOOK_IDS = ['book_0', 'book_1', 'book_2', 'book_3', 'book_4', 'book_5'] as const;
export type BookId = (typeof BOOK_IDS)[number];

export const OBJECT_IDS = [
  'photograph',
  'chair',
  'desk',
  'drawer_top',
  'drawer_bottom',
  'computer',
  'lamp',
  'clock',
  'curtains',
  'door',
  'mirror',
  'bookcase',
  ...BOOK_IDS,
  'figurine',
  'cup',
  'note',
  'table',
  'fan',
] as const;
export type ObjectId = (typeof OBJECT_IDS)[number];

export const AREA_IDS = ['desk', 'window', 'hallway', 'shelf', 'photo_wall', 'mirror', 'table', 'lamp_corner'] as const;
export type AreaId = (typeof AREA_IDS)[number];

export type V3 = readonly [number, number, number];

export interface ObjectPlacement {
  id: ObjectId;
  area: AreaId;
  /** World-space anchor used for attention, audio and prediction. */
  center: V3;
  /** Approximate bounding radius for projected-size and frustum tests. */
  radius: number;
  /** How the player interacts with it. */
  interaction: 'inspect' | 'toggle' | 'drag' | 'pick' | 'none';
  /** Short human label used in narrative text. */
  label: string;
}

export const CAMERA_HOME = { position: [0.15, 1.6, 0.45] as V3, yaw: 0.45, pitch: -0.12 } as const;

/** Chair seat height and footprint. Chair yaw θ faces direction (sin θ, cos θ). */
export const CHAIR = { radius: 0.3, initial: { x: -0.95, z: -1.05, yaw: Math.PI } } as const;

export const PLACEMENTS: Record<ObjectId, ObjectPlacement> = {
  photograph: { id: 'photograph', area: 'photo_wall', center: [-2.46, 1.55, 0.25], radius: 0.3, interaction: 'inspect', label: 'picture' },
  chair: { id: 'chair', area: 'desk', center: [-0.95, 0.55, -1.05], radius: 0.5, interaction: 'drag', label: 'chair' },
  desk: { id: 'desk', area: 'desk', center: [-0.9, 0.6, -1.75], radius: 0.8, interaction: 'none', label: 'desk' },
  drawer_top: { id: 'drawer_top', area: 'desk', center: [-0.42, 0.6, -1.4], radius: 0.2, interaction: 'toggle', label: 'drawer' },
  drawer_bottom: { id: 'drawer_bottom', area: 'desk', center: [-0.42, 0.33, -1.4], radius: 0.2, interaction: 'toggle', label: 'bottom drawer' },
  computer: { id: 'computer', area: 'desk', center: [-1.05, 1.03, -1.88], radius: 0.32, interaction: 'inspect', label: 'computer' },
  lamp: { id: 'lamp', area: 'lamp_corner', center: [-2.1, 1.2, -1.65], radius: 0.45, interaction: 'toggle', label: 'lamp' },
  clock: { id: 'clock', area: 'hallway', center: [2.47, 1.95, 1.05], radius: 0.2, interaction: 'inspect', label: 'clock' },
  curtains: { id: 'curtains', area: 'window', center: [1.2, 1.55, -2.0], radius: 0.8, interaction: 'toggle', label: 'curtains' },
  door: { id: 'door', area: 'hallway', center: [2.48, 1.05, -0.8], radius: 1.0, interaction: 'toggle', label: 'door' },
  mirror: { id: 'mirror', area: 'mirror', center: [-0.7, 1.35, 2.07], radius: 0.6, interaction: 'inspect', label: 'mirror' },
  bookcase: { id: 'bookcase', area: 'shelf', center: [-2.32, 0.95, 1.35], radius: 1.0, interaction: 'none', label: 'bookcase' },
  book_0: { id: 'book_0', area: 'shelf', center: [-2.3, 1.42, 1.0], radius: 0.13, interaction: 'pick', label: 'book' },
  book_1: { id: 'book_1', area: 'shelf', center: [-2.3, 1.42, 1.1], radius: 0.13, interaction: 'pick', label: 'book' },
  book_2: { id: 'book_2', area: 'shelf', center: [-2.3, 1.42, 1.2], radius: 0.13, interaction: 'pick', label: 'book' },
  book_3: { id: 'book_3', area: 'shelf', center: [-2.3, 1.02, 1.5], radius: 0.13, interaction: 'pick', label: 'book' },
  book_4: { id: 'book_4', area: 'shelf', center: [-2.3, 1.02, 1.6], radius: 0.13, interaction: 'pick', label: 'book' },
  book_5: { id: 'book_5', area: 'shelf', center: [-2.3, 0.62, 1.2], radius: 0.13, interaction: 'pick', label: 'book' },
  figurine: { id: 'figurine', area: 'shelf', center: [-2.3, 1.84, 1.55], radius: 0.08, interaction: 'pick', label: 'little bird' },
  cup: { id: 'cup', area: 'table', center: [1.25, 0.67, 1.32], radius: 0.06, interaction: 'pick', label: 'cup' },
  note: { id: 'note', area: 'table', center: [1.45, 0.625, 1.42], radius: 0.1, interaction: 'inspect', label: 'note' },
  table: { id: 'table', area: 'table', center: [1.35, 0.4, 1.35], radius: 0.45, interaction: 'none', label: 'table' },
  fan: { id: 'fan', area: 'desk', center: [0, 2.45, 0], radius: 0.6, interaction: 'none', label: 'fan' },
};

export const AREA_CENTERS: Record<AreaId, V3> = {
  desk: [-0.9, 0.9, -1.6],
  window: [1.2, 1.5, -2.05],
  hallway: [2.5, 1.2, -0.8],
  shelf: [-2.3, 1.0, 1.35],
  photo_wall: [-2.46, 1.55, 0.25],
  mirror: [-0.7, 1.3, 2.07],
  table: [1.35, 0.6, 1.35],
  lamp_corner: [-2.1, 1.1, -1.65],
};

export const INTERACTABLES = (Object.values(PLACEMENTS) as ObjectPlacement[]).filter((p) => p.interaction !== 'none');

/**
 * Shelf slots a book (or the bird, or the cup) can occupy. A slot holds one item.
 * Shelves are on the west wall; items face +x (into the room).
 */
export interface Slot {
  id: string;
  surface: 'shelf' | 'table' | 'desk' | 'drawer_top';
  position: V3;
}

export const SLOTS: Slot[] = [
  // Shelf 3 (y ≈ 1.30)
  { id: 's3_a', surface: 'shelf', position: [-2.3, 1.3, 1.0] },
  { id: 's3_b', surface: 'shelf', position: [-2.3, 1.3, 1.1] },
  { id: 's3_c', surface: 'shelf', position: [-2.3, 1.3, 1.2] },
  { id: 's3_d', surface: 'shelf', position: [-2.3, 1.3, 1.62] },
  // Shelf 2 (y ≈ 0.90)
  { id: 's2_a', surface: 'shelf', position: [-2.3, 0.9, 1.5] },
  { id: 's2_b', surface: 'shelf', position: [-2.3, 0.9, 1.6] },
  { id: 's2_c', surface: 'shelf', position: [-2.3, 0.9, 1.05] },
  // Shelf 1 (y ≈ 0.50)
  { id: 's1_a', surface: 'shelf', position: [-2.3, 0.5, 1.2] },
  { id: 's1_b', surface: 'shelf', position: [-2.3, 0.5, 1.45] },
  // Top shelf (y ≈ 1.70)
  { id: 's4_a', surface: 'shelf', position: [-2.3, 1.7, 1.55] },
  { id: 's4_b', surface: 'shelf', position: [-2.3, 1.7, 1.15] },
  // Furniture tops
  { id: 'table_a', surface: 'table', position: [1.25, 0.62, 1.32] },
  { id: 'table_b', surface: 'table', position: [1.5, 0.62, 1.18] },
  { id: 'desk_a', surface: 'desk', position: [-0.45, 0.75, -1.7] },
  { id: 'drawer_in', surface: 'drawer_top', position: [-0.42, 0.62, -1.62] },
];

export const INITIAL_SLOTS: Record<BookId | 'figurine' | 'cup', string> = {
  book_0: 's3_a',
  book_1: 's3_b',
  book_2: 's3_c',
  book_3: 's2_a',
  book_4: 's2_b',
  book_5: 's1_a',
  figurine: 's4_a',
  cup: 'table_a',
};

/** Axis-aligned floor obstacles for the chair (x/z extents). */
export interface Box2 {
  id: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export const FLOOR_OBSTACLES: Box2[] = [
  { id: 'desk_pedestal', minX: -0.63, maxX: -0.22, minZ: -2.1, maxZ: -1.42 },
  { id: 'desk_leg_left', minX: -1.6, maxX: -1.5, minZ: -2.1, maxZ: -1.42 },
  { id: 'bookcase', minX: -2.5, maxX: -2.14, minZ: 0.83, maxZ: 1.87 },
  { id: 'table', minX: 1.0, maxX: 1.7, minZ: 1.0, maxZ: 1.7 },
  { id: 'lamp', minX: -2.3, maxX: -1.9, minZ: -1.85, maxZ: -1.45 },
  // Keep the door swing clear so the chair can never block it.
  { id: 'door_swing', minX: 1.55, maxX: 2.5, minZ: -1.3, maxZ: -0.3 },
];

/** Nodes of the Observer's simplified navigation graph. */
export const NAV_NODES = {
  hallway_far: [4.2, 1.1, -0.8],
  hallway_door: [2.85, 1.1, -0.8],
  behind_curtain: [1.2, 1.2, -1.95],
  under_desk: [-1.1, 0.35, -1.85],
  lamp_corner: [-2.25, 1.0, -1.9],
  shelf_corner: [-2.25, 1.0, 1.95],
  mirror_side: [-0.1, 1.2, 1.95],
  table_corner: [2.2, 0.8, 1.9],
} as const satisfies Record<string, V3>;
export type NavNodeId = keyof typeof NAV_NODES;

export const NAV_EDGES: [NavNodeId, NavNodeId][] = [
  ['hallway_far', 'hallway_door'],
  ['hallway_door', 'behind_curtain'],
  ['hallway_door', 'table_corner'],
  ['behind_curtain', 'under_desk'],
  ['under_desk', 'lamp_corner'],
  ['lamp_corner', 'shelf_corner'],
  ['shelf_corner', 'mirror_side'],
  ['mirror_side', 'table_corner'],
];
