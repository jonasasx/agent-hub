// Codex limits (change provider-parity, design D5): account/rateLimits/read → the snapshot the hub already knows
// (LimitsSnapshot). The windows keep the Claude names where the duration matches: five_hour, seven_day.
import type { LimitsSnapshot, LimitWindow } from '@agent-hub/shared';

interface Window {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}
interface Bucket {
  primary: Window | null;
  secondary: Window | null;
}
export interface RateLimitsResponse {
  rateLimits?: Bucket | null;
}

function typeOf(mins: number | null, fallback: string): string {
  if (mins === 300) return 'five_hour';
  if (mins === 10080) return 'seven_day';
  return fallback;
}

function windowOf(w: Window | null | undefined, fallback: string): LimitWindow | null {
  if (!w || typeof w.usedPercent !== 'number') return null;
  const used = Math.min(100, Math.max(0, w.usedPercent));
  return {
    type: typeOf(w.windowDurationMins, fallback),
    utilization: used,
    resetsAt: typeof w.resetsAt === 'number' ? new Date(w.resetsAt * 1000).toISOString() : null,
    status: used >= 100 ? 'rejected' : used >= 80 ? 'allowed_warning' : 'allowed',
  };
}

/** null — the service reported no window (an account without limits). */
export function snapshotOfRateLimits(r: RateLimitsResponse): LimitsSnapshot | null {
  const windows = [windowOf(r.rateLimits?.primary, 'primary'), windowOf(r.rateLimits?.secondary, 'secondary')].filter((w): w is LimitWindow => !!w);
  return windows.length ? { windows, overage: null } : null;
}
