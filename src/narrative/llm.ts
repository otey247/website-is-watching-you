import type { Phase } from '../director/phaseMachine';
import type { NarrativeIntent } from './types';

/**
 * Optional local language-model adapter.
 *
 * Contract: the model receives a restricted, already-validated summary and may
 * only propose ONE short line plus the ids of the events it relies on. It has
 * no access to world-state commands, timing, physics or phase transitions.
 * Its output is always validated (see validator.ts) and silently replaced by
 * the authored line when invalid, slow or unavailable.
 */
export interface DialogueRequest {
  phase: Phase;
  intent: NarrativeIntent;
  /** The authored line for this intent; the model may only vary it. */
  authored: string;
  /** Facts the line is allowed to state. */
  facts: Record<string, string | number>;
  /** Restricted event summaries: id, type, object label and minutes ago. Nothing else. */
  events: { id: number; type: string; object?: string; minutesAgo: number }[];
  constraints: { maxChars: number; tone: string };
}

export interface DialogueProposal {
  text: string;
  refs: number[];
}

export interface DialogueModel {
  readonly name: string;
  propose(req: DialogueRequest, signal: AbortSignal): Promise<DialogueProposal | null>;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLocalEndpoint(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOCAL_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

export function buildPrompt(req: DialogueRequest): string {
  return [
    'You write single lines for a quiet presence inside a fictional 3D room in a video game.',
    'Rewrite the authored line in the same voice: calm, brief, unsettling, never theatrical.',
    `Maximum ${req.constraints.maxChars} characters. One or two short sentences.`,
    'Only state facts listed below. Do not mention anything outside the room. Do not mention numbers that are not listed.',
    'Never claim access to the player’s real computer, camera, microphone, files, name or location.',
    `Phase: ${req.phase}. Intent: ${req.intent}. Tone: ${req.constraints.tone}.`,
    `Authored line: "${req.authored}"`,
    `Facts: ${JSON.stringify(req.facts)}`,
    `Events: ${JSON.stringify(req.events)}`,
    'Respond with JSON only: {"text": string, "refs": number[]} where refs are ids from Events.',
  ].join('\n');
}

/**
 * Adapter for a model served on this machine with an Ollama-compatible
 * `/api/generate` endpoint. Refuses any non-local endpoint: behavioral data is
 * never sent to an external provider.
 */
export class LocalOllamaAdapter implements DialogueModel {
  readonly name: string;
  constructor(
    private readonly endpoint = 'http://localhost:11434',
    private readonly model = 'llama3.2',
    private readonly timeoutMs = 2500,
  ) {
    if (!isLocalEndpoint(endpoint)) throw new Error('Only local endpoints are allowed');
    this.name = `local:${model}`;
  }

  async propose(req: DialogueRequest, signal: AbortSignal): Promise<DialogueProposal | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    signal.addEventListener('abort', () => ctrl.abort());
    try {
      const res = await fetch(new URL('/api/generate', this.endpoint), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, prompt: buildPrompt(req), stream: false, format: 'json', options: { temperature: 0.7, num_predict: 80 } }),
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { response?: string };
      return parseProposal(body.response ?? '');
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function parseProposal(raw: string): DialogueProposal | null {
  try {
    const j = JSON.parse(raw) as { text?: unknown; refs?: unknown };
    if (typeof j.text !== 'string' || !Array.isArray(j.refs)) return null;
    const refs = j.refs.filter((r): r is number => typeof r === 'number' && Number.isInteger(r));
    return { text: j.text.trim().replace(/^"|"$/g, ''), refs };
  } catch {
    return null;
  }
}
