/**
 * Small pieces shared by the row, the card and the chip (docs/prototype.html, «subscription limits»): the level badge
 * (a shape and a glyph, so the level reads without colour) and the bar (`role="progressbar"` with its value; inside a
 * row or the summary button the bar is decorative — the button's name already has the percent, review A7).
 */
import { useSyncExternalStore } from 'react';
import { useStore } from '../../store';
import { activeAllSubs, hasActive } from '../subscriptions/model';
import type { Badge } from './limitsModel';
import { outdatedMachines, rowModel, type RowModel } from './limitsModel';
import type { SubscriptionView } from '../../api/types';

const GLYPH: Record<Badge, string> = { ok: '', warn: '!', crit: '!', full: '×', nodata: '?', quiet: '✓', neutral: '' };

export function LevelBadge({ badge }: { badge: Badge }) {
  return (
    <span className={`lv ${badge}`} aria-hidden="true">
      {GLYPH[badge]}
    </span>
  );
}

/** The bar; `label` — a `progressbar` with that name and value, none — decorative (inside a button that names the percent). */
export function LimitBar({ pct, badge, label, className }: { pct: number; badge: Badge; label?: string; className?: string }) {
  const v = Math.max(0, Math.min(100, Math.round(pct)));
  const a11y = label ? { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': v, 'aria-label': label } : { 'aria-hidden': true as const };
  return (
    <span className={`lbar ${badge}${className ? ` ${className}` : ''}`} data-value={v} {...a11y}>
      <i style={{ width: `${Math.max(2, v)}%` }} />
    </span>
  );
}

export interface LimitRowData {
  sub: SubscriptionView;
  row: RowModel;
}

/**
 * Rows of every active subscription in the registry order; null — no block (empty registry, tokens not kept, or the
 * hub has no limits API).
 */
export function useLimitRows(now: number): LimitRowData[] | null {
  const subs = useStore(s => s.subs);
  const limits = useStore(s => s.limits);
  const runners = useStore(s => s.runners);
  if (!limits || !(hasActive(subs, 'claude') || hasActive(subs, 'codex'))) return null;
  const outdated = outdatedMachines(runners);
  return activeAllSubs(subs).map(sub => ({
    sub,
    row: rowModel(
      sub,
      limits.limits.find(l => l.subscriptionId === sub.id),
      now,
      outdated,
    ),
  }));
}

/**
 * One shared clock for every limits view (review A7): a single 30 s interval while anything shows limits (the block,
 * the chip, the card) plus `visibilitychange`; all of them read the same tick, so the row, the chip and the card never
 * disagree about «now». Exported for tests.
 */
export const LIMITS_TICK_MS = 30_000;
export const limitsClock = (() => {
  let now = Date.now();
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  const tick = () => {
    now = Date.now();
    for (const l of listeners) l();
  };
  const onVisible = () => tick();
  return {
    subscribe(l: () => void): () => void {
      listeners.add(l);
      if (listeners.size === 1) {
        now = Date.now(); // the first view after a pause starts from the current time
        timer = setInterval(tick, LIMITS_TICK_MS);
        document.addEventListener('visibilitychange', onVisible);
      }
      return () => {
        listeners.delete(l);
        if (!listeners.size && timer) {
          clearInterval(timer);
          timer = null;
          document.removeEventListener('visibilitychange', onVisible);
        }
      };
    },
    get: () => now,
    tick,
    get subscribers() {
      return listeners.size;
    },
  };
})();

/** The hub's «now» for relative times and resets: the shared clock shifted by the last `serverTime` (design.md L6). */
export function useHubNow(): number {
  const t = useSyncExternalStore(limitsClock.subscribe, limitsClock.get);
  const skew = useStore(s => s.limitsSkew);
  return t + skew;
}
