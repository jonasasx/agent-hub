/**
 * Badges of the rail icons (Requirement «Счётчики на значках»): sessions — how many are active, machines — a red dot when
 * one is offline, subscriptions — the highest percent with a warning style once a window crosses the threshold. The
 * text is also the tail of the icon's tooltip.
 */
import { usableRunner, useStore } from '../../store';
import { runnerIndex, nowList } from '../sessions/status';
import { agentMark } from '../machines/runnerInfo';
import { effectivePct, fmtPct, topWindow, windowLevel } from '../limits/limitsModel';
import { windowText } from '../limits/limitTexts';
import { useHubNow, useLimitRows } from '../limits/parts';
import type { WinId } from './dock';

export interface Badge {
  kind: 'count' | 'dot' | 'warn';
  text: string;
  tip: string;
}

export type Badges = Partial<Record<WinId, Badge>>;

export function useBadges(): Badges {
  const sessions = useStore(s => s.sessions);
  const runners = useStore(s => s.runners);
  const showCron = useStore(s => s.showCron);
  const limits = useStore(s => s.limits);
  const now = useHubNow();
  const rows = useLimitRows(now);
  const out: Badges = {};
  const live = nowList(Object.values(sessions), runnerIndex(runners), showCron).length;
  if (live > 0) out.sessions = { kind: 'count', text: String(live), tip: `${live} активны` };
  const usable = runners.filter(usableRunner);
  const off = usable.filter(r => !r.online).map(r => r.name);
  if (off.length) out.machines = { kind: 'dot', text: '', tip: `${off.join(', ')} не в сети` };
  else {
    const upd = usable.filter(r => agentMark(r) === 'updating').map(r => r.name);
    if (upd.length) out.machines = { kind: 'dot', text: '', tip: `${upd.join(', ')} обновляется` };
  }
  if (rows && limits) {
    let best: { pct: number; type: string } | null = null;
    for (const { sub } of rows) {
      const lim = limits.limits.find(l => l.subscriptionId === sub.id);
      const w = lim ? topWindow(lim, now) : null;
      const pct = w ? effectivePct(w) : null;
      if (w && pct != null && windowLevel(w) !== 'ok' && (!best || pct > best.pct)) best = { pct, type: w.type };
    }
    if (best) out.subs = { kind: 'warn', text: fmtPct(best.pct), tip: `${windowText(best.type).short} — ${fmtPct(best.pct)}%` };
  }
  return out;
}
