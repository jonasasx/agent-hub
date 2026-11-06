/** Update feed on the hub (design D15). Requirement: Автообновление. */
import { dt } from './i18n.js';

export const UPDATE_FIRST_CHECK_MS = 30_000;
export const UPDATE_INTERVAL_MS = 6 * 60 * 60_000;

/** `<PUBLIC_URL>/api/desktop/updates/` — generic provider base of electron-updater (`latest.yml` is resolved from it). */
export function updateFeedUrl(hubUrl: string): string {
  return `${hubUrl.replace(/\/+$/, '')}/api/desktop/updates/`;
}

/** Headers electron-updater sends: it has its own HTTP stack and does not see the window's cookies. */
export function updateRequestHeaders(cookie: string | null, userAgent: string): Record<string, string> {
  const h: Record<string, string> = { 'User-Agent': userAgent };
  if (cookie) h.Cookie = `ah_session=${cookie}`;
  return h;
}

/** Text of the manual check result. */
export function manualCheckMessage(r: { kind: 'latest'; version: string } | { kind: 'available'; version: string } | { kind: 'error'; message: string }): string {
  switch (r.kind) {
    case 'latest':
      return dt('desktop.updates.latest', { version: r.version });
    case 'available':
      return dt('desktop.updates.available', { version: r.version });
    case 'error':
      return dt('desktop.updates.failed', { message: r.message });
  }
}

/** Short, user-facing text of an updater error (401 means the session is gone). */
export function updateErrorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/\b401\b/.test(msg)) return dt('desktop.updates.errSignIn');
  if (/\b404\b/.test(msg)) return dt('desktop.updates.errNoFeed');
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION/i.test(msg)) return dt('desktop.updates.errOffline');
  return msg.split('\n')[0]?.slice(0, 200) ?? dt('desktop.updates.errUnknown');
}

export type UpdateCheckResult = { kind: 'latest'; version: string } | { kind: 'available'; version: string } | { kind: 'error'; message: string } | { kind: 'skipped' };

/** One check at a time: a call while one runs gets the running one's result instead of starting another. */
export class SingleFlight<T> {
  private running: Promise<T> | null = null;

  run(fn: () => Promise<T>): Promise<T> {
    if (this.running) return this.running;
    const p = fn().finally(() => {
      if (this.running === p) this.running = null;
    });
    this.running = p;
    return p;
  }
}
