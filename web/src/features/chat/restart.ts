/**
 * «Перезапустить сессию» (change session-restart, design D1): POST /api/sessions/:id/restart stops the process and
 * resumes it with the same transcript and settings. A turn or background work in progress asks first: the item opens
 * the confirmation at once, and the hub's 409 turn_in_progress (a turn started after the menu opened) opens it too.
 * Requirement: Перезапуск сессии из меню.
 */
import { ApiError, api } from '../../api/client';
import type { SessionView } from '../../api/types';
import { useStore } from '../../store';
import { t } from '../../i18n';

const get = () => useStore.getState();

/** The hub's busyForSwitch: a turn, or a waiting session whose subagents or background commands still work. */
export function restartNeedsConfirm(s: Pick<SessionView, 'status' | 'subagents'>): boolean {
  return s.status === 'working' || s.status === 'permission' || (s.status === 'waiting' && (s.subagents?.working ?? 0) > 0);
}

function restartError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'runner_offline') return t('chat.restart.offline');
    if (err.code === 'read_only' || err.status === 423) return t('chat.restart.readOnly');
    if (err.serverMessage) return err.serverMessage;
  }
  return t('subscriptions.error.hubSilent');
}

/** Sessions with a restart request in flight: a second click must not restart the freshly resumed process again. */
const inFlight = new Set<string>();

export async function restartSession(sid: string, opts: { interrupt?: boolean } = {}): Promise<void> {
  if (inFlight.has(sid)) return;
  inFlight.add(sid);
  try {
    const r = await api.restartSession(sid, opts.interrupt ? { interrupt: true } : {});
    if (r?.session) get().upsertSessions([r.session]);
    useStore.setState({ pendingRestart: null });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      useStore.setState({ pendingRestart: null });
      return;
    }
    if (err instanceof ApiError && err.code === 'turn_in_progress' && !opts.interrupt) {
      useStore.setState({ pendingRestart: { sessionId: sid } });
      return;
    }
    useStore.setState({ pendingRestart: null });
    get().pushToast({ title: t('chat.restart.failed'), text: restartError(err), color: 'var(--bad)' });
  } finally {
    inFlight.delete(sid);
  }
}

/** The menu item: a busy session asks first, an idle or sleeping one restarts at once. */
export function requestRestart(s: SessionView): void {
  if (restartNeedsConfirm(s)) useStore.setState({ pendingRestart: { sessionId: s.id } });
  else void restartSession(s.id);
}

export async function confirmRestart(): Promise<void> {
  const p = get().pendingRestart;
  if (!p) return;
  await restartSession(p.sessionId, { interrupt: true });
}

export function cancelRestart(): void {
  useStore.setState({ pendingRestart: null });
}
