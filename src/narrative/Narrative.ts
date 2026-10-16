import { Emitter } from '../core/emitter';
import { PLACEMENTS } from '../core/layout';
import type { Rng } from '../core/rng';
import type { BehavioralEvent } from '../telemetry/types';
import type { Telemetry } from '../telemetry/Telemetry';
import type { DialogueModel, DialogueRequest } from './llm';
import { CALLBACK_TYPES, TEMPLATES, callbackSentence, fill } from './templates';
import type { NarrativeContext, NarrativeIntent, ObserverMessage, Template } from './types';
import { validateStatement } from './validator';

export interface CallbackEntry {
  eventId: number;
  notBefore: number;
  delivered: boolean;
}

export interface NarrativeEvents {
  message: ObserverMessage;
}

const CALLBACK_DELAY_MS: [number, number] = [140_000, 320_000];
const MAX_PENDING_CALLBACKS = 6;

/**
 * Narrative system: authored templates backed by validated event history,
 * a delayed-callback queue, and an optional local LLM for variation.
 */
export class Narrative {
  readonly emitter = new Emitter<NarrativeEvents>();
  readonly shown: ObserverMessage[] = [];
  readonly callbacks: CallbackEntry[] = [];
  private shownIds = new Set<string>();
  model: DialogueModel | null = null;
  private pendingVariation: AbortController | null = null;

  constructor(
    private readonly telemetry: Telemetry,
    private readonly rng: Rng,
  ) {
    telemetry.emitter.on('recorded', (e) => this.considerCallback(e));
  }

  /** Remember selected ordinary actions to reference minutes later. */
  private considerCallback(e: BehavioralEvent): void {
    if (!CALLBACK_TYPES.includes(e.type)) return;
    if (e.type === 'object_inspected' && (e.durationMs ?? 0) < 5000) return;
    const pending = this.callbacks.filter((c) => !c.delivered);
    if (pending.length >= MAX_PENDING_CALLBACKS) return;
    if (pending.some((c) => this.telemetry.get(c.eventId)?.type === e.type)) return;
    // Selective memory: not everything is remembered.
    if (!this.rng.chance(0.45)) return;
    this.callbacks.push({ eventId: e.id, notBefore: e.timestampMs + this.rng.range(...CALLBACK_DELAY_MS), delivered: false });
  }

  /** Callbacks whose delay has passed and whose event still exists. */
  dueCallbacks(now: number): CallbackEntry[] {
    return this.callbacks.filter((c) => !c.delivered && now >= c.notBefore && this.telemetry.get(c.eventId));
  }

  get messagesShown(): number {
    return this.shown.length;
  }

  get callbacksDelivered(): number {
    return this.callbacks.filter((c) => c.delivered).length;
  }

  /** All templates whose evidence holds right now, best first. */
  candidates(ctx: NarrativeContext, intents?: NarrativeIntent[]): { template: Template; text: string; refs: number[]; facts: Record<string, string | number> }[] {
    const out: { template: Template; text: string; refs: number[]; facts: Record<string, string | number> }[] = [];
    for (const t of TEMPLATES) {
      if (t.intent === 'callback') continue;
      if (intents && !intents.includes(t.intent)) continue;
      if (!t.phases.includes(ctx.phase)) continue;
      if (t.once && this.shownIds.has(t.id)) continue;
      const recent = this.shown.slice(-3).some((m) => m.templateId === t.id);
      if (recent) continue;
      const ev = t.evidence(ctx);
      if (!ev) continue;
      const text = fill(t.text, ev.facts);
      if (!validateStatement({ text, refs: ev.refs, facts: ev.facts }, this.telemetry).ok) continue;
      out.push({ template: t, text, refs: ev.refs, facts: ev.facts });
    }
    out.sort((a, b) => (b.template.priority ?? 0) - (a.template.priority ?? 0));
    return out;
  }

  /** A valid delayed callback, if any is due. */
  callbackMessage(ctx: NarrativeContext): { entry: CallbackEntry; text: string; refs: number[]; facts: Record<string, string | number> } | null {
    for (const entry of this.dueCallbacks(ctx.now)) {
      const e = this.telemetry.get(entry.eventId)!;
      const ev = callbackSentence(e, ctx);
      if (!ev) {
        entry.delivered = true; // no longer true; drop it
        continue;
      }
      const text = String(ev.facts.sentence);
      if (!validateStatement({ text, refs: ev.refs, facts: ev.facts }, this.telemetry).ok) continue;
      return { entry, text, refs: ev.refs, facts: ev.facts };
    }
    return null;
  }

  /** Commit a message: mark evidence as used and emit it to the computer. */
  deliver(m: Omit<ObserverMessage, 'createdAt' | 'source'> & { source?: ObserverMessage['source'] }, now: number, callback?: CallbackEntry): ObserverMessage {
    const msg: ObserverMessage = { ...m, source: m.source ?? 'template', createdAt: now };
    this.shown.push(msg);
    this.shownIds.add(m.templateId);
    for (const id of m.refs) this.telemetry.markUsed(id, `narrative:${m.templateId}`);
    if (callback) callback.delivered = true;
    this.emitter.emit('message', msg);
    return msg;
  }

  /** Authored ending/system lines that need no behavioral evidence. */
  say(templateId: string, text: string, now: number): ObserverMessage {
    return this.deliver({ templateId, intent: 'ending', text, refs: [], facts: {} }, now);
  }

  /**
   * Optionally vary an authored line with the local model. Resolves to the
   * validated variation, or to the authored text on any failure.
   */
  async vary(authored: { text: string; refs: number[]; facts: Record<string, string | number>; intent: NarrativeIntent }, ctx: NarrativeContext): Promise<{ text: string; refs: number[]; source: 'template' | 'llm' }> {
    if (!this.model) return { text: authored.text, refs: authored.refs, source: 'template' };
    this.pendingVariation?.abort();
    const ctrl = new AbortController();
    this.pendingVariation = ctrl;
    const req: DialogueRequest = {
      phase: ctx.phase,
      intent: authored.intent,
      authored: authored.text,
      facts: authored.facts,
      events: authored.refs
        .map((id) => this.telemetry.get(id))
        .filter((e): e is BehavioralEvent => !!e)
        .map((e) => ({ id: e.id, type: e.type, object: e.target ? PLACEMENTS[e.target].label : undefined, minutesAgo: Math.round((ctx.now - e.timestampMs) / 60_000) })),
      constraints: { maxChars: 80, tone: 'quiet, observant, slightly wrong' },
    };
    const proposal = await this.model.propose(req, ctrl.signal).catch(() => null);
    if (!proposal) return { text: authored.text, refs: authored.refs, source: 'template' };
    // The model may only cite events it was given.
    const allowed = new Set(authored.refs);
    if (proposal.refs.length === 0 || proposal.refs.some((r) => !allowed.has(r))) return { text: authored.text, refs: authored.refs, source: 'template' };
    const v = validateStatement({ text: proposal.text, refs: proposal.refs, facts: authored.facts }, this.telemetry, { strict: true, maxLength: 80 });
    if (!v.ok) return { text: authored.text, refs: authored.refs, source: 'template' };
    return { text: proposal.text, refs: proposal.refs, source: 'llm' };
  }

  snapshot(): object {
    return { shown: this.shown, callbacks: this.callbacks, shownIds: [...this.shownIds] };
  }

  restore(s: object): void {
    const o = s as { shown: ObserverMessage[]; callbacks: CallbackEntry[]; shownIds: string[] };
    this.shown.splice(0, this.shown.length, ...o.shown);
    this.callbacks.splice(0, this.callbacks.length, ...o.callbacks);
    this.shownIds = new Set(o.shownIds);
  }
}
