/**
 * Pure model of the limits UI (change subscription-limits, design.md L7, task 6.3).
 * Requirements: Строка подписки; Пороги и индикация не только цветом; Состояния «нет данных»; Устаревшие данные и
 * сброшенные окна; Метка лимита в шапке вкладки; Блок «Лимиты» в левой панели (сводка); Время сброса.
 * Levels are counted here only: the hub sends windows and states, never levels.
 */
import { clock, protocolAtLeast } from '../subscriptions/model';
import { LIMITS_PROTOCOL, type LimitWindowView, type LimitsReason, type SubscriptionLimitsView, type RunnerView, type SubscriptionView } from '../../api/types';
import { reasonText, windowText } from './limitTexts';

export const LIMIT_WARN = 80;
export const LIMIT_CRIT = 95;
/** The block becomes one summary row from this many active subscriptions (Ivan, 2026-10-27). */
export const LIMITS_COLLAPSE_PHONE = 3;
export const LIMITS_COLLAPSE_DESKTOP = 4;

export const collapseFrom = (device: 'phone' | 'desktop') => (device === 'phone' ? LIMITS_COLLAPSE_PHONE : LIMITS_COLLAPSE_DESKTOP);

export type Level = 'ok' | 'warn' | 'crit' | 'full';
/** The badge of a row: a level, or a state without a level. */
export type Badge = Level | 'nodata' | 'quiet' | 'neutral';

/** Short words next to the percent in the row; long ones in the card. */
export const LEVEL_WORD: Record<Level, string> = { ok: 'норма', warn: 'близко', crit: 'почти', full: 'исчерпано' };
export const LEVEL_LONG: Record<Level, string> = { ok: 'норма', warn: 'близко к лимиту', crit: 'почти исчерпано', full: 'исчерпано' };

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

/** The percent a window counts with: no percent but a warning — 80, a rejection — 100; nothing known — null. */
export function effectivePct(w: Pick<LimitWindowView, 'utilization' | 'status'>): number | null {
  if (w.utilization != null && Number.isFinite(w.utilization)) return w.utilization;
  if (w.status === 'rejected') return 100;
  if (w.status === 'allowed_warning') return LIMIT_WARN;
  return null;
}

export function windowLevel(w: Pick<LimitWindowView, 'utilization' | 'status'>): Level | null {
  const pct = effectivePct(w);
  if (pct == null) return null;
  if (w.status === 'rejected' || pct >= 100) return 'full';
  if (pct >= LIMIT_CRIT) return 'crit';
  if (pct >= LIMIT_WARN || w.status === 'allowed_warning') return 'warn';
  return 'ok';
}

/** The reset time has come and no newer data yet: «окно сброшено в HH:MM, данные обновятся». */
export function isReset(w: Pick<LimitWindowView, 'resetsAt'>, now: number): boolean {
  const t = ms(w.resetsAt);
  return Number.isFinite(t) && t <= now;
}

/**
 * The window was observed before the latest quiet check: a successful turn without an event came later. Such a turn
 * only says «the turn passed, the limit is not exhausted» — the service sends events not on every turn — so the window
 * keeps its level only when `heldOverQuiet`.
 */
export function beforeQuiet(w: Pick<LimitWindowView, 'observedAt'>, lim: Pick<SubscriptionLimitsView, 'quietAt'>): boolean {
  const q = ms(lim.quietAt);
  const o = ms(w.observedAt);
  return Number.isFinite(q) && Number.isFinite(o) && o < q;
}

/**
 * A window observed before the latest quiet check that still sets the level (fix 2026-10-29, replaces review A3): its
 * last known value is at or above the warning threshold, it is not a rejection (the successful turn disproves it) and
 * its reset has not come. A window below the threshold or a rejection observed before the check sets no level.
 */
export function heldOverQuiet(w: LimitWindowView, lim: Pick<SubscriptionLimitsView, 'quietAt'>, now: number): boolean {
  if (!beforeQuiet(w, lim) || isReset(w, now) || w.status === 'rejected') return false;
  const level = windowLevel(w);
  return level !== null && level !== 'ok';
}

/**
 * The window of the row: the highest percent, then the earlier reset. Windows that reset, have neither a percent nor
 * a status, were observed before the latest quiet check and are not `heldOverQuiet`, or belong to stale/unavailable
 * data are not candidates.
 */
export function topWindow(lim: SubscriptionLimitsView, now: number): LimitWindowView | null {
  if (lim.state !== 'ok') return null;
  const c = lim.windows.filter(w => !isReset(w, now) && (!beforeQuiet(w, lim) || heldOverQuiet(w, lim, now)) && windowLevel(w) !== null);
  const reset = (w: LimitWindowView) => {
    const t = ms(w.resetsAt);
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  };
  c.sort((a, b) => effectivePct(b)! - effectivePct(a)! || reset(a) - reset(b));
  return c[0] ?? null;
}

/** The subscription's limit while it has not reset (the fact of a rejected turn, `limit_resets_at`). */
export function limitedUntil(sub: Pick<SubscriptionView, 'limitResetsAt'>, now: number): string | null {
  const t = ms(sub.limitResetsAt);
  return Number.isFinite(t) && t > now ? sub.limitResetsAt : null;
}

/** «через 2 ч 10 мин», «через 3 дн 4 ч», «через 5 мин». */
export function relIn(iso: string, now: number): string {
  const m = Math.max(1, Math.round((ms(iso) - now) / 60_000));
  if (m < 60) return `через ${m} мин`;
  if (m < 1440) return `через ${Math.floor(m / 60)} ч${m % 60 ? ` ${m % 60} мин` : ''}`;
  const h = Math.round(m / 60);
  return `через ${Math.floor(h / 24)} дн${h % 24 ? ` ${h % 24} ч` : ''}`;
}

const at = (iso: string, now: number) => clock(iso, new Date(now));

/** Online machines whose agent is older than the limits protocol: «обновите агента на HP». */
export function outdatedMachines(runners: RunnerView[]): string[] {
  return runners.filter(r => r.kind === 'machine' && r.online && !protocolAtLeast(r.protocolVersion, LIMITS_PROTOCOL)).map(r => r.name);
}

export type RowKind = 'win' | 'full' | 'stale' | 'quiet' | 'reset' | 'nodata';

export interface RowModel {
  kind: RowKind;
  badge: Badge;
  /** The bar's value; null — no bar. */
  pct: number | null;
  window: LimitWindowView | null;
  /** Level word before the window text («близко», «почти»); null — none. */
  word: string | null;
  /** The right side of the row without the word: «5 ч · 82% · 18:40», «исчерпана до 13:06», «нет данных: …» (no machine names). */
  text: string;
  /** The percent inside `text` to set in bold; null — none. */
  boldPct: string | null;
  /** The head chip: «82% · 5 ч», «100% · 7 дн», «ниже порога»; null — the badge alone. */
  chip: string | null;
  /** For the accessible name: window, percent, level in words, reset. */
  aria: string;
  reason: LimitsReason | null;
}

/** One view-model for the row, the summary and the chip. */
export function rowModel(sub: SubscriptionView, lim: SubscriptionLimitsView | undefined, now: number, outdated: string[] = []): RowModel {
  const nodata = (reason: LimitsReason | null): RowModel => {
    // the row shows the short form; the machine names go to the accessible name and the card (QA 8.1)
    const t = `нет данных: ${reasonText(reason)}`;
    return { kind: 'nodata', badge: 'nodata', pct: null, window: null, word: null, text: t, boldPct: null, chip: null, aria: `нет данных: ${reasonText(reason, outdated)}`, reason };
  };
  // the rejected token outranks everything (Requirement: Состояния «нет данных»)
  if (sub.tokenRejected || lim?.reason === 'token_rejected') return nodata('token_rejected');
  const until = limitedUntil(sub, now);
  if (until) {
    const kind = sub.limitKind ?? lim?.windows.find(w => w.status === 'rejected')?.type ?? null;
    const text = `исчерпана до ${at(until, now)}`;
    return {
      kind: 'full',
      badge: 'full',
      pct: 100,
      window: null,
      word: null,
      text,
      boldPct: null,
      chip: kind ? `100% · ${windowText(kind).short}` : '100%',
      aria: `исчерпано до ${at(until, now)}`,
      reason: null,
    };
  }
  if (!lim) return nodata('not_polled');
  if (lim.state === 'unavailable') return nodata(lim.reason ?? 'not_polled');
  if (lim.state === 'stale') {
    const pcts = lim.windows.map(w => w.utilization).filter((x): x is number => x != null);
    const pct = pcts.length ? Math.max(...pcts) : null;
    const since = lim.lastOkAt ?? lim.staleAt;
    const text = since ? `данные от ${at(since, now)}` : 'данные устарели';
    return { kind: 'stale', badge: 'neutral', pct, window: null, word: null, text, boldPct: null, chip: text, aria: pct != null ? `${pct}%, ${text}` : text, reason: null };
  }
  const w = topWindow(lim, now);
  if (w) {
    const level = windowLevel(w)!;
    const pct = effectivePct(w)!;
    const name = windowText(w.type);
    const pctText = w.utilization != null ? `${fmtPct(w.utilization)}%` : level === 'full' ? 'исчерпано' : '≥80%';
    const reset = w.resetsAt ? at(w.resetsAt, now) : null;
    // a window held over a quiet check: the time of the data instead of the reset (the reset stays in aria and the card)
    const data = beforeQuiet(w, lim) ? `данные от ${at(w.observedAt, now)}` : null;
    const text = [name.short, pctText, data ?? reset].filter(Boolean).join(' · ');
    const word = level === 'warn' || level === 'crit' ? LEVEL_WORD[level] : null;
    return {
      kind: 'win',
      badge: level,
      pct,
      window: w,
      word,
      text,
      boldPct: pctText,
      chip: `${pctText} · ${name.short}`,
      aria: [name.name, pctText, LEVEL_LONG[level], reset ? `сброс ${reset}` : null, data].filter(Boolean).join(', '),
      reason: null,
    };
  }
  if (lim.quietAt) {
    const t = at(lim.quietAt, now);
    return {
      kind: 'quiet',
      badge: 'quiet',
      pct: null,
      window: null,
      word: null,
      text: `ниже порога · проверено ${t}`,
      boldPct: null,
      chip: 'ниже порога',
      aria: `ниже порога предупреждения, проверено в ${t}`,
      reason: null,
    };
  }
  const resets = lim.windows.filter(x => isReset(x, now)).map(x => ms(x.resetsAt));
  if (resets.length) {
    const t = at(new Date(Math.max(...resets)).toISOString(), now);
    const text = `окно сброшено в ${t}`;
    return { kind: 'reset', badge: 'neutral', pct: null, window: null, word: null, text, boldPct: null, chip: text, aria: `${text}, данные обновятся`, reason: null };
  }
  return nodata('not_polled');
}

/** «82», «82.5»: one decimal at most, no trailing zero. */
export const fmtPct = (n: number) => String(Math.round(n * 10) / 10);

const RANK: Record<Badge, number> = { full: 5, crit: 4, warn: 3, ok: 2, quiet: 1, neutral: 0, nodata: 0 };

/** The subscription of the summary: the highest level, then the highest percent; the registry order breaks ties. */
export function worst<T extends { row: RowModel }>(rows: T[]): T | null {
  let best: T | null = null;
  for (const r of rows) {
    if (!best || RANK[r.row.badge] > RANK[best.row.badge] || (RANK[r.row.badge] === RANK[best.row.badge] && (r.row.pct ?? -1) > (best.row.pct ?? -1))) best = r;
  }
  return best;
}

/** Seconds until «Обновить» is allowed again; 0 — now. */
export function refreshLeft(lim: Pick<SubscriptionLimitsView, 'refreshableAt'> | undefined, now: number): number {
  const t = ms(lim?.refreshableAt);
  return Number.isFinite(t) && t > now ? Math.ceil((t - now) / 1000) : 0;
}

/** The card's line about where the data came from. */
export const SOURCE_LABEL: Record<LimitWindowView['source'], string> = { session: 'ход сессии', probe: 'пробный ход' };

/** The newest window's source, for «Данные в HH:MM · ход сессии». */
export function lastSource(lim: SubscriptionLimitsView): LimitWindowView['source'] | null {
  let best: LimitWindowView | null = null;
  for (const w of lim.windows) if (!best || ms(w.observedAt) > ms(best.observedAt)) best = w;
  return best?.source ?? null;
}
