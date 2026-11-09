/**
 * «Ждёт меня» rule of the tray counter (design D5). Requirement: Счётчик ждущих сессий в трее.
 * The rule itself is `waitsForUser` of `@agent-hub/shared` (change `shared-attention-rule`), the same as web «Сейчас».
 */
import { waitsForUser, type RunnerView, type SessionView } from '@agent-hub/shared';

export type RunnerLookup = ReadonlyMap<string, RunnerView>;

/** `offline` when the runner is unknown or not online, otherwise the stored status. */
export function displayStatus(s: SessionView, runners: RunnerLookup): SessionView['status'] | 'offline' {
  const r = runners.get(s.runnerId);
  return !r || !r.online ? 'offline' : s.status;
}

/** Waits for the user: permission or an unread answer, machine online. */
export function needsMe(s: SessionView, runners: RunnerLookup): boolean {
  return waitsForUser(s, runners.get(s.runnerId)?.online === true);
}

/** Number of non-cron sessions that wait for the user (the «Сейчас» rule with `showCron = false`). */
export function waitingCount(sessions: Iterable<SessionView>, runners: RunnerLookup): number {
  let n = 0;
  for (const s of sessions) if (!s.isCron && needsMe(s, runners)) n++;
  return n;
}
