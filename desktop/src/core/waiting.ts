/**
 * «Ждёт меня» rule of the tray counter (design D5). Requirement: Счётчик ждущих сессий в трее.
 *
 * Copy of `displayStatus`/`needsMe` and the cron filter of `nowList` from `web/src/features/sessions/status.ts`
 * (desktop cannot import from web, and web is not changed by this change). Keep in sync; follow-up after the merge —
 * move them to `shared/` and import in both places.
 */
import type { RunnerView, SessionView } from '@agent-hub/shared';

export type RunnerLookup = ReadonlyMap<string, RunnerView>;

/** `offline` when the runner is unknown or not online, otherwise the stored status. */
export function displayStatus(s: SessionView, runners: RunnerLookup): SessionView['status'] | 'offline' {
  const r = runners.get(s.runnerId);
  return !r || !r.online ? 'offline' : s.status;
}

/** Waits for the user: permission or an unread answer, machine online. */
export function needsMe(s: SessionView, runners: RunnerLookup): boolean {
  const st = displayStatus(s, runners);
  return st === 'permission' || (st === 'waiting' && s.unread);
}

/** Number of non-cron sessions that wait for the user (the «Сейчас» rule with `showCron = false`). */
export function waitingCount(sessions: Iterable<SessionView>, runners: RunnerLookup): number {
  let n = 0;
  for (const s of sessions) if (!s.isCron && needsMe(s, runners)) n++;
  return n;
}
