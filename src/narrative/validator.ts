import { PLACEMENTS } from '../core/layout';
import type { Telemetry } from '../telemetry/Telemetry';

/**
 * Claims the Observer may never make, whatever produced the text. The fiction
 * stays inside the rendered room: no real devices, accounts, files or identity.
 */
const FORBIDDEN = [
  /\bweb ?cam/i,
  /\bcamera\b/i,
  /\bmicrophone|\bmic\b/i,
  /\byour (real )?(computer|device|phone|laptop|files?|browser|tabs?|history|location|address|name|password|account)/i,
  /\b(ip address|gps|location|fingerprint|cookies?|tracking|hacked|virus|malware|infected|security (warning|alert))\b/i,
  /\b(download|install|permission|allow access)\b/i,
  /\bhttps?:\/\//i,
  /\b(your name is|i know who you are|where you live)\b/i,
  /\b(you feel|you are afraid|you're afraid|you are anxious|your personality|diagnos)/i,
];

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  once: 1, twice: 2, third: 3, second: 2, fourth: 4, fifth: 5,
};

const OBJECT_WORDS = new Set(
  Object.values(PLACEMENTS)
    .flatMap((p) => p.label.split(' '))
    .concat(['photograph', 'photo', 'drawer', 'light', 'curtain', 'hallway', 'bird', 'books']),
);

export interface ValidationResult {
  ok: boolean;
  reasons: string[];
}

export interface Candidate {
  text: string;
  refs: number[];
  facts: Record<string, string | number>;
}

/**
 * Validate an Observer statement against the recorded session.
 * Used for authored templates (defense in depth) and mandatory for any text
 * proposed by an optional language model.
 */
export function validateStatement(c: Candidate, telemetry: Telemetry, opts: { strict?: boolean; maxLength?: number } = {}): ValidationResult {
  const reasons: string[] = [];
  const text = c.text.trim();
  const maxLength = opts.maxLength ?? 90;
  if (!text) reasons.push('empty');
  if (text.length > maxLength) reasons.push('too long');
  if (text.split(/(?<=[.!?])\s+/).length > 2) reasons.push('too many sentences');
  for (const re of FORBIDDEN) if (re.test(text)) reasons.push(`forbidden claim: ${re.source}`);

  // Every reference must be a real recorded event.
  const events = c.refs.map((id) => telemetry.get(id));
  if (c.refs.length === 0 && opts.strict) reasons.push('no supporting events');
  if (events.some((e) => !e)) reasons.push('references unknown event');

  if (opts.strict) {
    // Objects mentioned must be targets/areas of the referenced events.
    const allowed = new Set<string>();
    for (const e of events) {
      if (!e) continue;
      if (e.target) for (const w of PLACEMENTS[e.target].label.split(' ')) allowed.add(w);
      if (e.target?.startsWith('book')) allowed.add('book');
      if (e.target === 'photograph') ['picture', 'photograph', 'photo'].forEach((w) => allowed.add(w));
      if (e.target === 'lamp') allowed.add('light');
      if (e.target === 'curtains') allowed.add('curtain');
      if (e.area === 'hallway' || e.target === 'door') ['door', 'hallway'].forEach((w) => allowed.add(w));
      if (e.target === 'figurine') allowed.add('bird');
    }
    const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
    for (const w of words) {
      const base = w.replace(/s$/, '');
      if ((OBJECT_WORDS.has(w) || OBJECT_WORDS.has(base)) && !allowed.has(w) && !allowed.has(base)) {
        reasons.push(`mentions ${w} without evidence`);
      }
    }
    // Numeric claims must match a supplied fact.
    const factNumbers = new Set(Object.values(c.facts).filter((v): v is number => typeof v === 'number'));
    factNumbers.add(c.refs.length);
    for (const w of words) {
      const n = NUMBER_WORDS[w];
      if (n !== undefined && !factNumbers.has(n) && !(w === 'second' && /\bseconds?\b/.test(text))) reasons.push(`unsupported count ${w}`);
    }
    for (const d of text.match(/\d+/g) ?? []) if (!factNumbers.has(Number(d))) reasons.push(`unsupported number ${d}`);
  }
  return { ok: reasons.length === 0, reasons };
}
