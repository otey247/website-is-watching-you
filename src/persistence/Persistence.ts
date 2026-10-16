/**
 * Local-only persistence.
 *
 * - Behavioral session data is saved ONLY when the player explicitly chooses
 *   "Save and leave". It never leaves the browser.
 * - Settings (volume, reduced motion...) are stored as a per-viewer convenience.
 * Every access is wrapped: private windows and blocked storage simply mean
 * nothing is remembered.
 */
const SAVE_KEY = 'wiwy.session.v1';
const SETTINGS_KEY = 'wiwy.settings.v1';

export interface Settings {
  volume: number;
  muted: boolean;
  reducedMotion: boolean;
  suddenEvents: boolean;
  quality: 'high' | 'low';
  localModel: boolean;
  localModelEndpoint: string;
  localModelName: string;
}

export const DEFAULT_SETTINGS: Settings = {
  volume: 0.8,
  muted: false,
  reducedMotion: false,
  suddenEvents: true,
  quality: 'high',
  localModel: false,
  localModelEndpoint: 'http://localhost:11434',
  localModelName: 'llama3.2',
};

function storage(): Storage | null {
  try {
    const s = window.localStorage;
    const k = '__wiwy_probe';
    s.setItem(k, '1');
    s.removeItem(k);
    return s;
  } catch {
    return null;
  }
}

export const Persistence = {
  available(): boolean {
    return storage() !== null;
  },
  hasSave(): boolean {
    try {
      return !!storage()?.getItem(SAVE_KEY);
    } catch {
      return false;
    }
  },
  save(data: object): boolean {
    try {
      storage()?.setItem(SAVE_KEY, JSON.stringify({ savedAt: Date.now(), data }));
      return true;
    } catch {
      return false;
    }
  },
  load(): object | null {
    try {
      const raw = storage()?.getItem(SAVE_KEY);
      if (!raw) return null;
      return (JSON.parse(raw) as { data: object }).data;
    } catch {
      return null;
    }
  },
  clearSession(): void {
    try {
      storage()?.removeItem(SAVE_KEY);
    } catch {
      /* ignore */
    }
  },
  loadSettings(): Settings {
    try {
      const raw = storage()?.getItem(SETTINGS_KEY);
      return raw ? { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) } : { ...DEFAULT_SETTINGS };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  },
  saveSettings(s: Settings): void {
    try {
      storage()?.setItem(SETTINGS_KEY, JSON.stringify(s));
    } catch {
      /* ignore */
    }
  },
  clearAll(): void {
    try {
      storage()?.removeItem(SAVE_KEY);
      storage()?.removeItem(SETTINGS_KEY);
    } catch {
      /* ignore */
    }
  },
};
