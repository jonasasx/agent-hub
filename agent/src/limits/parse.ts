// Tolerant parsing of the SDK's rate_limit_event into a limits snapshot (subscription-limits design L1, task 4.1).
// Requirement: Снимок лимитов подписки. The windows are in `rate_limit_info.unifiedWindows` (not declared in the SDK's
// types, seen on 0.3.310): fractions 0..1 → percent (the scale is chosen per event, review A4), `resetsAt` in seconds → ISO. Without unifiedWindows the top level
// (rateLimitType, utilization, resetsAt, status) is the one window. Nothing here throws on a strange value: an unknown
// status becomes `unknown`, a non-number becomes null.
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { LIMIT_STATUSES, type LimitOverage, type LimitStatus, type LimitWindow, type LimitsSnapshot } from '@agent-hub/shared';
import { resetsAtMs } from '../sessions/failure.js';

/** The protocol's limit on windows of a snapshot. */
const MAX_WINDOWS = 16;
const KEY_MAX = 64;

type Info = Record<string, unknown>;

/** `rate_limit_info` of a rate_limit_event, else null. */
export function rateLimitInfo(m: SDKMessage | { type: string }): Info | null {
  if (m.type !== 'rate_limit_event') return null;
  const info = (m as { rate_limit_info?: unknown }).rate_limit_info;
  return info && typeof info === 'object' && !Array.isArray(info) ? (info as Info) : null;
}

/**
 * A value of the event → percent with one decimal. `percents` is the scale of the whole event (review A4, design L1):
 * false — fractions 0..1 (×100), true — percents already (0..100). Negative, over the scale or not a finite number → null.
 */
export function toPercent(v: unknown, percents = false): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  const p = percents ? (v <= 100 ? v : null) : v <= 1 ? v * 100 : null;
  return p === null ? null : Math.round(p * 10) / 10;
}

const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);

/**
 * The scale of one event (review A4): if any utilization or surpassedThreshold of it (top level or a window) is over 1,
 * the whole event is in percents; else in fractions. Per value it would be ambiguous: 1 is 100% as a fraction and 1% as
 * a percent, and one event never mixes scales.
 */
export function eventInPercents(info: Info): boolean {
  const vals: unknown[] = [info.utilization, info.surpassedThreshold];
  const unified = info.unifiedWindows;
  if (unified && typeof unified === 'object' && !Array.isArray(unified)) {
    for (const w of Object.values(unified as Info)) if (w && typeof w === 'object' && !Array.isArray(w)) vals.push((w as Info).utilization, (w as Info).surpassedThreshold);
  }
  return vals.some(v => num(v) && (v as number) > 1);
}

/** Seconds since epoch (≥ 10¹² — milliseconds already) → ISO; anything else → null. */
export function toIso(v: unknown): string | null {
  const ms = resetsAtMs(typeof v === 'number' ? v : undefined);
  if (ms === undefined) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** A known status as is, a string we do not know → `unknown`, absent → null. */
export function toStatus(v: unknown): LimitStatus | null {
  if (v === undefined || v === null) return null;
  return typeof v === 'string' && (LIMIT_STATUSES as readonly string[]).includes(v) ? (v as LimitStatus) : 'unknown';
}

function window(type: string, w: Info, percents: boolean): LimitWindow {
  const surpassed = toPercent(w.surpassedThreshold, percents);
  return {
    type: type.slice(0, KEY_MAX),
    utilization: toPercent(w.utilization, percents),
    resetsAt: toIso(w.resetsAt),
    status: toStatus(w.status),
    ...(surpassed !== null ? { surpassedThreshold: surpassed } : {}),
  };
}

function overage(info: Info): LimitOverage | null {
  const has = ['overageStatus', 'isUsingOverage', 'overageEnabled', 'overageDisabledReason'].some(k => info[k] !== undefined);
  if (!has) return null;
  const bool = (v: unknown) => (typeof v === 'boolean' ? v : null);
  return {
    status: toStatus(info.overageStatus) ?? 'unknown',
    inUse: bool(info.isUsingOverage),
    enabled: bool(info.overageEnabled),
    disabledReason: typeof info.overageDisabledReason === 'string' ? info.overageDisabledReason.slice(0, KEY_MAX) : null,
  };
}

/** The snapshot of one rate_limit_event's info; windows of unifiedWindows by any key, else the top level. */
export function snapshotFromInfo(info: Info): LimitsSnapshot {
  const windows: LimitWindow[] = [];
  const percents = eventInPercents(info);
  const unified = info.unifiedWindows;
  if (unified && typeof unified === 'object' && !Array.isArray(unified)) {
    for (const [key, w] of Object.entries(unified as Info)) {
      if (!key || windows.length >= MAX_WINDOWS) continue;
      windows.push(window(key, w && typeof w === 'object' && !Array.isArray(w) ? (w as Info) : {}, percents));
    }
  }
  if (!windows.length && typeof info.rateLimitType === 'string' && info.rateLimitType) windows.push(window(info.rateLimitType, info, percents));
  return { windows, overage: overage(info) };
}

/** The snapshot of an SDK message, or null when it is not a rate_limit_event. */
export function parseRateLimitEvent(m: SDKMessage | { type: string }): LimitsSnapshot | null {
  const info = rateLimitInfo(m);
  return info ? snapshotFromInfo(info) : null;
}
