/**
 * Showing native notifications (design D6). Requirement: Нативные уведомления. The decision is `core/notify.ts`;
 * here — Electron `Notification`, one per session (a new one replaces the previous), click → window on `/s/<id>`.
 * Windows shows toasts only for an app with AppUserModelId and a Start menu shortcut (the installed build).
 */
import { Notification } from 'electron';
import type { NotificationSpec } from '../core/notify.js';
import { log } from './files.js';

/**
 * How long a shown notification is kept referenced. A toast that timed out moves to the Action Center and can still be
 * clicked there; if the Notification object were garbage-collected, that click would be lost (A4 of the review).
 */
export const NOTIFICATION_KEEP_MS = 10 * 60_000;

export class Notifier {
  private readonly bySession = new Map<string, { n: Notification; timer: NodeJS.Timeout }>();

  constructor(private readonly onClick: (sessionId: string) => void) {}

  show(spec: NotificationSpec): void {
    if (!Notification.isSupported()) return;
    this.drop(spec.sessionId, true);
    const n = new Notification({ title: spec.title, body: spec.body, silent: false });
    n.on('click', () => {
      this.onClick(spec.sessionId);
      if (this.bySession.get(spec.sessionId)?.n === n) this.drop(spec.sessionId, false);
    });
    // Not released on 'close' (fires when the toast leaves the screen, the entry stays in the Action Center).
    const timer = setTimeout(() => {
      if (this.bySession.get(spec.sessionId)?.n === n) this.bySession.delete(spec.sessionId);
    }, NOTIFICATION_KEEP_MS);
    this.bySession.set(spec.sessionId, { n, timer });
    n.show();
    log(`notification ${spec.reason} ${spec.sessionId}`);
  }

  /** Forgets the notification of a session; `close` also removes it from the screen (replaced by a newer one). */
  private drop(sessionId: string, close: boolean): void {
    const e = this.bySession.get(sessionId);
    if (!e) return;
    clearTimeout(e.timer);
    this.bySession.delete(sessionId);
    if (close) e.n.close();
  }

  /** A plain message (hotkey conflict). */
  info(title: string, body: string): void {
    if (!Notification.isSupported()) return;
    new Notification({ title, body, silent: true }).show();
  }
}
