/** Every one-shot sound the experience can play. All are synthesized at load. */
export const SOUND_IDS = [
  'tick',
  'tock',
  'drawer_open',
  'drawer_close',
  'lamp_click',
  'book_lift',
  'book_place',
  'paper',
  'chair_scrape',
  'chair_creak',
  'door_creak',
  'door_handle',
  'door_close',
  'cup_clink',
  'curtain',
  'key_tap',
  'scrape',
  'footstep',
  'wood_click',
  'creak',
  'knock_soft',
  'thump',
  'electrical_tick',
  'notify',
  'glass_tap',
] as const;
export type SoundId = (typeof SOUND_IDS)[number];

export const AMBIENT_LAYERS = ['room_tone', 'traffic', 'fan', 'hum'] as const;
export type AmbientLayer = (typeof AMBIENT_LAYERS)[number];

/** Sounds that may startle; suppressed or softened when "sudden events" are disabled. */
export const SUDDEN_SOUNDS: SoundId[] = ['thump', 'knock_soft', 'door_close'];
