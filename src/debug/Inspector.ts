import type { App } from '../app/App';
import { ANOMALIES } from '../director/anomalies';
import { PHASE_REQUIREMENTS, PHASES, type Phase } from '../director/phaseMachine';

/**
 * Development inspector (loaded only in dev builds via dynamic import; the
 * production bundle never contains it). Toggle with the backquote key.
 * Shows Observer state, phase progress, eligible anomalies, event history,
 * attention estimates, predictions and narrative progression.
 */
export class Inspector {
  private root: HTMLElement;
  private body: HTMLElement;
  private open: boolean;
  private last = 0;
  private tab: 'observer' | 'director' | 'events' | 'attention' = 'observer';

  constructor(parent: HTMLElement, open: boolean) {
    this.open = open;
    this.root = document.createElement('aside');
    this.root.className = 'wiwy-inspector';
    this.root.setAttribute('aria-label', 'Developer inspector');
    this.root.innerHTML = `
      <style>
        .wiwy-inspector { position: fixed; top: 0; left: 0; bottom: 0; width: min(420px, 100vw); z-index: 50;
          background: #0c0c0d; color: #ededeb; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
          display: flex; flex-direction: column; box-shadow: 8px 0 40px rgba(0,0,0,0.5); }
        .wiwy-inspector[hidden] { display: none; }
        .wiwy-inspector header { display: flex; align-items: center; gap: 6px; padding: 10px 12px; background: #151517; }
        .wiwy-inspector header strong { font: 700 12px var(--font, sans-serif); letter-spacing: .08em; text-transform: uppercase; margin-right: auto; }
        .wiwy-inspector nav { display: flex; gap: 4px; padding: 8px 12px 0; }
        .wiwy-inspector button { appearance: none; border: 0; border-radius: 4px; background: #26262a; color: #ededeb; font: 600 11px ui-monospace, monospace; padding: 6px 8px; cursor: pointer; }
        .wiwy-inspector button[aria-pressed="true"] { background: #ededeb; color: #0c0c0d; }
        .wiwy-inspector .b { overflow: auto; padding: 10px 12px 24px; flex: 1; }
        .wiwy-inspector h4 { margin: 14px 0 6px; font: 700 11px ui-monospace, monospace; color: #9b9b97; text-transform: uppercase; letter-spacing: .08em; }
        .wiwy-inspector table { width: 100%; border-collapse: collapse; }
        .wiwy-inspector td { padding: 2px 4px 2px 0; vertical-align: top; }
        .wiwy-inspector td.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
        .wiwy-inspector .bar { height: 6px; background: #26262a; border-radius: 3px; overflow: hidden; min-width: 90px; }
        .wiwy-inspector .bar i { display: block; height: 100%; background: #ededeb; }
        .wiwy-inspector .dim { color: #8a8a86; }
        .wiwy-inspector .ok { font-weight: 700; }
        .wiwy-inspector select { background: #26262a; color: #ededeb; border: 0; border-radius: 4px; font: 11px ui-monospace, monospace; padding: 5px; max-width: 220px; }
      </style>
      <header><strong>Inspector</strong><button data-i="close">Close</button></header>
      <nav>
        <button data-tab="observer">Observer</button><button data-tab="director">Director</button>
        <button data-tab="events">Events</button><button data-tab="attention">Attention</button>
      </nav>
      <div class="b"></div>`;
    this.body = this.root.querySelector('.b')!;
    this.root.hidden = !open;
    parent.appendChild(this.root);
    this.root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.dataset.i === 'close') this.toggle();
      if (t.dataset.tab) {
        this.tab = t.dataset.tab as typeof this.tab;
        this.last = 0;
      }
    });
    this.root.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  toggle(): void {
    this.open = !this.open;
    this.root.hidden = !this.open;
  }

  update(app: App): void {
    if (!this.open) return;
    const t = performance.now();
    if (t - this.last < 250) return;
    this.last = t;
    const s = app.session;
    if (!s) return;
    this.root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === this.tab)));
    const keepScroll = this.body.scrollTop;
    this.body.innerHTML = this.render(app);
    this.body.scrollTop = keepScroll;
    const sel = this.body.querySelector<HTMLSelectElement>('select[data-force]');
    const btn = this.body.querySelector<HTMLButtonElement>('button[data-force]');
    if (sel && btn) btn.onclick = () => console.info('[inspector] force', sel.value, s.core.forceAnomaly(sel.value, { ignoreRequirements: true, anyPhase: true }));
    this.body.querySelectorAll<HTMLButtonElement>('button[data-phase]').forEach((b) => {
      b.onclick = () => s.core.director.forcePhase(b.dataset.phase as Exclude<Phase, 'resolution'>);
    });
  }

  private render(app: App): string {
    const s = app.session!;
    const c = s.core;
    const d = c.director;
    const now = c.clock.now;
    const head = `<table>
      <tr><td>phase</td><td class="n ok">${d.phase}</td></tr>
      <tr><td>in phase</td><td class="n">${fmt(now - d.phaseEnteredAt(d.phase))}</td></tr>
      <tr><td>session (active)</td><td class="n">${fmt(now)}${c.clock.isPaused ? ' · paused' : ''}</td></tr>
      <tr><td>gateways</td><td class="n">${d.gateways.join(', ') || '—'}</td></tr>
      <tr><td>follower stage</td><td class="n">${d.followerStage}</td></tr>
      <tr><td>entity</td><td class="n">${c.entity.state.node} · ${c.entity.state.objective}</td></tr>
      <tr><td>fps</td><td class="n">${app.fps.toFixed(0)}</td></tr>
    </table>`;
    switch (this.tab) {
      case 'observer':
        return head + this.observer(app);
      case 'director':
        return head + this.director(app);
      case 'events':
        return head + this.events(app);
      case 'attention':
        return head + this.attention(app);
    }
  }

  private observer(app: App): string {
    const c = app.session!.core;
    const o = c.observer;
    const rows = Object.entries(o.state)
      .map(([k, v]) => `<tr><td>${k}</td><td><div class="bar"><i style="width:${Math.round(clamp01(v) * 100)}%"></i></div></td><td class="n">${v.toFixed(2)}</td></tr>`)
      .join('');
    const aff = Object.entries(o.endingAffinity())
      .map(([k, v]) => `<tr><td>${k}</td><td><div class="bar"><i style="width:${Math.round(v * 100)}%"></i></div></td><td class="n">${v.toFixed(2)}</td></tr>`)
      .join('');
    const p = o.profile();
    const pred = o.predictor.current;
    const ranked = pred ? pred.ranked.slice(0, 4).map((r) => `${r.id} ${(r.p * 100).toFixed(0)}%`).join(' · ') : '—';
    const msgs = c.narrative.shown
      .slice(-6)
      .reverse()
      .map((m) => `<tr><td class="dim">${fmt(m.createdAt)}</td><td>${esc(m.text)} <span class="dim">[${m.templateId}${m.refs.length ? ' ← ' + m.refs.join(',') : ''}]</span></td></tr>`)
      .join('');
    return `<h4>Observer state</h4><table>${rows}</table>
      <h4>Ending affinity</h4><table>${aff}</table>
      <h4>Prediction</h4><table>
        <tr><td>current</td><td class="n">${pred?.target ?? 'none'} ${pred ? (pred.confidence * 100).toFixed(0) + '%' : ''}</td></tr>
        <tr><td>ranked</td><td class="n">${ranked}</td></tr>
        <tr><td>accuracy (last 12)</td><td class="n">${(o.predictor.accuracy() * 100).toFixed(0)}%</td></tr>
      </table>
      <h4>Profile</h4><table>
        <tr><td>most inspected</td><td class="n">${p.mostInspected ?? '—'} (${p.mostInspectedCount})</td></tr>
        <tr><td>least visited</td><td class="n">${p.leastVisitedArea ?? '—'}</td></tr>
        <tr><td>light preference</td><td class="n">${p.lightPreference.toFixed(2)}</td></tr>
        <tr><td>avg hesitation</td><td class="n">${p.averageHesitationMs.toFixed(0)} ms</td></tr>
        <tr><td>exploration</td><td class="n">${p.explorationPath.join(' → ') || '—'}</td></tr>
        <tr><td>investigation</td><td class="n">${p.anomalyInvestigation.toFixed(2)}</td></tr>
        <tr><td>repetition</td><td class="n">${p.repetition.toFixed(2)}</td></tr>
        <tr><td>turn bias</td><td class="n">${p.turnBias.toFixed(2)}</td></tr>
        <tr><td>stillness</td><td class="n">${p.stillness.toFixed(2)}</td></tr>
      </table>
      <h4>Narrative (${c.narrative.messagesShown} shown, ${c.narrative.callbacksDelivered} callbacks)</h4><table>${msgs || '<tr><td class="dim">No messages yet.</td></tr>'}</table>`;
  }

  private director(app: App): string {
    const c = app.session!.core;
    const d = c.director;
    const m = d.metrics();
    const next = PHASES[PHASES.indexOf(d.phase) + 1] as keyof typeof PHASE_REQUIREMENTS | undefined;
    const req = next ? PHASE_REQUIREMENTS[next] : null;
    const reqRows = req
      ? Object.entries(req)
          .map(([k, v]) => {
            const have = k === 'minPhaseMs' ? m.now - d.phaseEnteredAt(d.phase) : k === 'witnessedOrInteractions' ? `${m.anomaliesWitnessed} / ${m.interactions}` : (m as unknown as Record<string, number>)[k];
            return `<tr><td>${k}</td><td class="n">${typeof have === 'number' ? (k === 'minPhaseMs' ? fmt(have) : have.toFixed(k === 'tension' ? 2 : 0)) : have}</td><td class="n dim">${Array.isArray(v) ? v.join(' | ') : k === 'minPhaseMs' ? fmt(v as number) : v}</td></tr>`;
          })
          .join('')
      : '';
    // Gate evaluation draws from the shared RNG; preserve its state so inspecting never changes the session.
    const rngState = c.rng.getState();
    const cands = d.candidates(d.ctx(), false).concat(d.candidates(d.ctx(), true));
    c.rng.setState(rngState);
    const rows = cands
      .filter((x) => x.def.phases.includes(d.phase))
      .sort((a, b) => Number(b.report.eligible) - Number(a.report.eligible) || b.report.weight - a.report.weight)
      .map((x) => `<tr><td class="${x.report.eligible ? 'ok' : 'dim'}">${x.report.id}</td><td class="n">${x.report.eligible ? x.report.weight.toFixed(2) : esc(x.report.reason)}</td></tr>`)
      .join('');
    const running = d.executor.running.map((r) => `<tr><td>${r.def.id}</td><td class="n">${r.status}</td></tr>`).join('');
    const decisions = d.decisions
      .slice(-14)
      .reverse()
      .map((x) => `<tr><td class="dim">${fmt(x.t)}</td><td>${x.anomalyId}</td><td class="n">${x.result}</td></tr>`)
      .join('');
    const options = ANOMALIES.map((a) => `<option value="${a.id}">${a.id}</option>`).join('');
    const phases = PHASES.filter((p) => p !== 'resolution')
      .map((p) => `<button data-phase="${p}">${p.slice(0, 5)}</button>`)
      .join(' ');
    return `<h4>Next phase${next ? `: ${next}` : ''}</h4><table>${reqRows || '<tr><td class="dim">Final phase.</td></tr>'}</table>
      <h4>Running</h4><table>${running || '<tr><td class="dim">Nothing running.</td></tr>'}</table>
      <h4>Anomalies in this phase</h4><table>${rows}</table>
      <h4>Recent decisions</h4><table>${decisions}</table>
      <h4>Controls</h4><div style="display:flex;gap:6px;flex-wrap:wrap"><select data-force>${options}</select><button data-force>Force</button></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">${phases}</div>`;
  }

  private events(app: App): string {
    const t = app.session!.core.telemetry;
    const rows = t.recent
      .slice(-40)
      .reverse()
      .map((e) => {
        const meta = Object.entries(e.meta)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ');
        return `<tr><td class="dim">#${e.id} ${fmt(e.timestampMs)}</td><td>${e.type}${e.target ? ' · ' + e.target : ''}${e.area ? ' <span class="dim">@' + e.area + '</span>' : ''}<br/><span class="dim">${esc(meta)}${e.usedBy.length ? ' used by ' + e.usedBy.join(',') : ''}</span></td></tr>`;
      })
      .join('');
    return `<h4>Behavioral events (${t.interactionCount()} interactions)</h4><table>${rows}</table>`;
  }

  private attention(app: App): string {
    const a = app.session!.attention;
    const focus = a.focus()?.id;
    const rows = a
      .all()
      .sort((x, y) => y.score - x.score)
      .map((e) => `<tr><td class="${e.id === focus ? 'ok' : ''}">${e.id}</td><td>${e.visibility}${e.viaMirror ? ' (mirror)' : ''}</td><td><div class="bar"><i style="width:${Math.round(e.score * 100)}%"></i></div></td><td class="n">${e.score.toFixed(2)}</td></tr>`)
      .join('');
    const areas = [...a.areaScores()].map(([k, v]) => `<tr><td>${k}</td><td><div class="bar"><i style="width:${Math.round(v * 100)}%"></i></div></td><td class="n">${v.toFixed(2)}</td></tr>`).join('');
    return `<h4>Objects</h4><table>${rows}</table><h4>Areas</h4><table>${areas}</table>`;
  }
}

function fmt(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
}
