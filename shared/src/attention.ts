// «Ждёт меня» (change `shared-attention-rule`): when a session waits for the user and when that is worth a notification.
// One rule for the hub (Web Push), the desktop (tray counter, native notifications) and web («Сейчас»).
// Requirements: push-notifications «События, о которых приходит push»; desktop-app «Нативные уведомления».

/** Why a session waits for the user: a permission request (a question, a plan) or an unread answer of a finished turn. */
export type WaitingReason = 'permission' | 'turn_ended';

/** The fields of a SessionView the rule reads. */
export interface AttentionSession {
  status: string;
  unread: boolean;
  subagents?: { working?: number | undefined; hub?: { working: number } | undefined } | undefined;
}

/** Children that keep a session with a finished turn busy: subagents and background tasks, child hub sessions. */
export function workingChildren(s: AttentionSession): number {
  return (s.subagents?.working ?? 0) + (s.subagents?.hub?.working ?? 0);
}

/** The session waits for the user: machine online and a permission request or an unread answer. */
export function waitingReason(s: AttentionSession, runnerOnline: boolean): WaitingReason | null {
  if (!runnerOnline) return null;
  if (s.status === 'permission') return 'permission';
  if (s.status === 'waiting' && s.unread) return 'turn_ended';
  return null;
}

export function waitsForUser(s: AttentionSession, runnerOnline: boolean): boolean {
  return waitingReason(s, runnerOnline) !== null;
}

/**
 * The notification rule: «ждёт меня», except a finished turn while children still work — a monitor event wakes the
 * session for a short status turn, and each such turn would notify. The front comes when the last child ends.
 * A permission request notifies whatever works.
 */
export function notifyReason(s: AttentionSession, runnerOnline: boolean): WaitingReason | null {
  const reason = waitingReason(s, runnerOnline);
  if (reason === 'turn_ended' && workingChildren(s) > 0) return null;
  return reason;
}
