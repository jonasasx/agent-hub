/**
 * The body of the «Подписки» window: every subscription is a header (a ring with the worst window when collapsed, the
 * name, «● сейчас») and, expanded, a row per window with a bar, the percent and the reset time. Collapsed by default;
 * the expanded ones are kept on the device (docs/prototypes/tool-windows.html subsBody). Levels are the shared ones of
 * limitsModel (80 / 95), not the prototype's 90.
 */
import { useState } from 'react';
import type { LimitWindowView } from '../../api/types';
import { useStore } from '../../store';
import { t as tNow, useT } from '../../i18n';
import { IconChev } from '../toolwindows/icons';
import { clock } from '../subscriptions/model';
import { LimitRing, type RingTone } from './LimitRing';
import { effectivePct, fmtPct, isReset, windowLevel } from './limitsModel';
import { windowText } from './limitTexts';
import { useHubNow, useLimitRows } from './parts';

const KEY = 'ah-subs-expanded.v1';
/** The key of the first build: read once, then removed. */
const OLD_KEY = 'subsExpanded';

export function loadExpanded(): string[] {
  try {
    let raw = localStorage.getItem(KEY);
    const old = localStorage.getItem(OLD_KEY);
    if (old !== null) {
      if (raw === null) {
        raw = old;
        localStorage.setItem(KEY, old);
      }
      localStorage.removeItem(OLD_KEY);
    }
    const v = JSON.parse(raw ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

const toneOf = (w: Pick<LimitWindowView, 'utilization' | 'status'>): RingTone => {
  const level = windowLevel(w);
  return level === 'warn' ? 'warn' : level === 'crit' || level === 'full' ? 'bad' : 'ok';
};

/**
 * The ring of a collapsed subscription is built from the windows the rows show: those with a percent that have not reset,
 * the largest percent first, the earlier reset on a tie. When all of them have reset, a ring of 0% with the first window.
 * (`topWindow` also drops windows observed before the latest quiet check, so for the used subscription it gave no ring.)
 */
function ringOf(wins: LimitWindowView[], date: Date, now: number): { pct: number; tone: RingTone; tip: string } {
  const live = wins.filter(w => !isReset(w, now));
  const at = (w: LimitWindowView) => (w.resetsAt ? Date.parse(w.resetsAt) : Number.POSITIVE_INFINITY);
  const order = (a: LimitWindowView, b: LimitWindowView) => {
    const d = effectivePct(b)! - effectivePct(a)!;
    if (d !== 0) return d;
    // no `Infinity - Infinity`: a window without a reset time goes last
    if (at(a) < at(b)) return -1;
    if (at(a) > at(b)) return 1;
    return 0;
  };
  const top = [...live].sort(order)[0];
  if (!top) return { pct: 0, tone: 'ok', tip: tNow('limits.window.resetTip', { window: windowText(wins[0]!.type).short }) };
  const pct = effectivePct(top)!;
  return {
    pct,
    tone: toneOf(top),
    tip: tNow('limits.window.tip', { window: windowText(top.type).short, pct: fmtPct(pct), reset: top.resetsAt ? clock(top.resetsAt, date) : tNow('limits.window.resetUnknown') }),
  };
}

export function SubscriptionsWindow() {
  const t = useT();
  const now = useHubNow();
  const rows = useLimitRows(now);
  const limits = useStore(s => s.limits);
  const subs = useStore(s => s.subs);
  const [open, setOpen] = useState<string[]>(loadExpanded);
  if (!rows || !rows.length) return <p className="hint">{t('limits.window.none')}</p>;
  const current = subs?.defaultId ?? subs?.lastChoiceId ?? null;
  const toggle = (id: string) => {
    const next = open.includes(id) ? open.filter(x => x !== id) : [...open, id];
    setOpen(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // private mode: the choice lasts until the page is closed
    }
  };
  const date = new Date(now);
  return (
    <div className="tw-subs">
      {rows.map(({ sub }) => {
        const lim = limits?.limits.find(l => l.subscriptionId === sub.id);
        const expanded = open.includes(sub.id);
        const wins = (lim?.state === 'ok' ? lim.windows : []).filter(w => effectivePct(w) != null);
        const ring = !expanded && wins.length ? <LimitRing {...ringOf(wins, date, now)} /> : null;
        return (
          <div key={sub.id} className={`tw-sub${expanded ? '' : ' col'}`}>
            <button type="button" className="tw-sh" aria-expanded={expanded} onClick={() => toggle(sub.id)}>
              <span className="tw-chev" aria-hidden="true">
                {IconChev}
              </span>
              {ring}
              <span className="tw-sn">{sub.name}</span>
              {current === sub.id && <span className="tw-chip">{t('limits.window.current')}</span>}
            </button>
            {expanded &&
              (wins.length ? (
                wins.map(w => {
                  // a reset window says the same as the ring: 0%, no colour, dimmed, no reset time
                  const gone = isReset(w, now);
                  const pct = gone ? 0 : effectivePct(w)!;
                  const tone = gone ? 'ok' : toneOf(w);
                  const cls = tone === 'ok' ? '' : tone;
                  return (
                    <div key={w.type} className={`tw-lim${gone ? ' reset' : ''}`}>
                      <span className="tw-ln">{windowText(w.type).short}</span>
                      <div className="tw-bar">
                        <i className={cls} style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
                      </div>
                      <span className={`tw-pc ${cls}`}>{fmtPct(pct)}%</span>
                      <span className="tw-rs">{w.resetsAt && !gone ? clock(w.resetsAt, date) : ''}</span>
                    </div>
                  );
                })
              ) : (
                <div className="tw-lim tw-nodata">{t('limits.window.noData')}</div>
              ))}
          </div>
        );
      })}
    </div>
  );
}
