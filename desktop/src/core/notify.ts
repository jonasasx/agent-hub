/**
 * Native notification decision (design D6). Requirement: Нативные уведомления.
 *
 * A notification is the front of the D5 rule on one session after a `session.upsert`: before — not waiting for the
 * user, after — waiting. A session the model has not seen yet (not in the sidebar seed) is a baseline, not a front:
 * its first upsert never notifies, so a session that has been waiting for hours does not pop up after a reseed. Only hub-managed, non-cron sessions. Suppressed when the hub says the
 * session is active in a visible window (`activeVisible`); when the hub does not send the field — when the app window
 * is visible and focused. State from `GET /api/sidebar` never notifies (the caller does not pass it here).
 */
import type { SessionView } from '@agent-hub/shared';
import { needsMe, type RunnerLookup } from './waiting.js';
import { dt } from './i18n.js';

export interface NotificationSpec {
  sessionId: string;
  reason: 'permission' | 'turn_ended';
  title: string;
  body: string;
}

export interface NotifyInput {
  /** The session before the upsert (undefined — it was not in the model: baseline, no notification). */
  prev: SessionView | undefined;
  /** Runners before the upsert (the same as after: an upsert does not change runners). */
  runners: RunnerLookup;
  next: SessionView;
  /** `session.upsert.activeVisible`; undefined — the hub does not send it. */
  activeVisible: boolean | undefined;
  /** The app window is visible and focused (fallback without `activeVisible`). */
  windowVisibleAndFocused: boolean;
}

export function notificationText(s: SessionView, runners: RunnerLookup): Pick<NotificationSpec, 'reason' | 'title' | 'body'> {
  const reason = s.status === 'permission' ? 'permission' : 'turn_ended';
  const title = dt(reason === 'permission' ? 'desktop.notify.permissionTitle' : 'desktop.notify.replyTitle', { title: s.title || dt('desktop.notify.untitled') });
  const runner = runners.get(s.runnerId)?.name ?? s.runnerId;
  const body = `${s.project?.title || dt('desktop.notify.noProject')} · ${runner}`;
  return { reason, title, body };
}

export function decideNotification(input: NotifyInput): NotificationSpec | null {
  const { prev, next, runners } = input;
  if (!next.isHubManaged || next.isCron) return null;
  if (!needsMe(next, runners)) return null;
  // hub-subagents D10: a session another hub session started answers its parent, not the user — only a permission request reaches the user
  if (next.spawnedBy && next.status !== 'permission') return null;
  if (!prev || needsMe(prev, runners)) return null;
  if (input.activeVisible === true) return null;
  if (input.activeVisible === undefined && input.windowVisibleAndFocused) return null;
  return { sessionId: next.id, ...notificationText(next, runners) };
}
