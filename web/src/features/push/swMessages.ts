/**
 * Messages of the service worker to the page (change web-push-notifications, design D8): a tap on a push notification
 * with the window open focuses it and asks to show the session without a reload.
 * Requirement: Переход по тапу — «Приложение открыто».
 */
export const OPEN_SESSION_MESSAGE = 'agent-hub:open-session';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The session id of an open-session message; null for anything else. */
export function openSessionId(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const m = data as { type?: unknown; sessionId?: unknown };
  if (m.type !== OPEN_SESSION_MESSAGE || typeof m.sessionId !== 'string') return null;
  return UUID.test(m.sessionId) ? m.sessionId : null;
}

/** Listens until the returned function is called. */
export function listenSwMessages(onOpen: (sessionId: string) => void): () => void {
  const sw = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker;
  if (!sw) return () => undefined;
  const handler = (e: MessageEvent) => {
    const id = openSessionId(e.data);
    if (id) onOpen(id);
  };
  sw.addEventListener('message', handler);
  return () => sw.removeEventListener('message', handler);
}
