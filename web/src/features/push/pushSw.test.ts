// Test of web/public/push-sw.js (change web-push-notifications, tasks 3.5): the file is plain JS imported by the generated
// sw.js, so it is run here against a fake service worker scope.
import { describe, expect, it, vi } from 'vitest';
import SOURCE from '../../../public/push-sw.js?raw';

const SID = '11111111-2222-4333-8444-555555555555';
const ORIGIN = 'https://hub.example.org';

interface Win {
  url: string;
  focused?: boolean;
  visibilityState?: string;
  focus: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
}

const win = (over: Partial<Win> = {}): Win => ({ url: `${ORIGIN}/`, focus: vi.fn(async () => undefined), postMessage: vi.fn(), ...over });

function load(windows: Win[]) {
  const handlers: Record<string, (e: unknown) => void> = {};
  const showNotification = vi.fn(async (_title: string, _options?: unknown) => undefined);
  const openWindow = vi.fn(async () => null);
  const self = {
    location: { origin: ORIGIN },
    registration: { showNotification },
    clients: { matchAll: vi.fn(async () => windows), openWindow },
    addEventListener: (type: string, h: (e: unknown) => void) => {
      handlers[type] = h;
    },
  };
  new Function('self', SOURCE)(self);
  const run = async (type: string, event: Record<string, unknown>) => {
    let pending: Promise<unknown> = Promise.resolve();
    handlers[type]!({ ...event, waitUntil: (p: Promise<unknown>) => (pending = p) });
    await pending;
  };
  return { showNotification, openWindow, run };
}

const pushEvent = (json: () => unknown) => ({ data: { json } });

describe('push-sw.js: push', () => {
  it('shows the notification from a normal payload with tag, renotify and the session in data', async () => {
    const sw = load([]);
    await sw.run(
      'push',
      pushEvent(() => ({ v: 1, kind: 'session', sessionId: SID, title: 'Релиз ждёт ответа', body: 'HP · Какой тег?', tag: SID, lang: 'ru' })),
    );
    expect(sw.showNotification).toHaveBeenCalledWith('Релиз ждёт ответа', {
      body: 'HP · Какой тег?',
      tag: SID,
      renotify: true,
      icon: '/icons/icon-192.png',
      lang: 'ru',
      data: { sessionId: SID },
    });
  });

  it('a test payload has no session', async () => {
    const sw = load([]);
    await sw.run(
      'push',
      pushEvent(() => ({ v: 1, kind: 'test', title: 'Agent Hub', body: 'Works', tag: 'agent-hub-test', lang: 'en' })),
    );
    expect(sw.showNotification.mock.calls[0]![1]).toMatchObject({ tag: 'agent-hub-test', data: { sessionId: null } });
  });

  it('an empty push still shows the generic notification (iOS revokes subscriptions otherwise)', async () => {
    const sw = load([]);
    await sw.run('push', { data: null });
    expect(sw.showNotification).toHaveBeenCalledWith('Agent Hub', expect.objectContaining({ body: '', renotify: false, data: { sessionId: null } }));
  });

  it('a broken payload shows the generic notification', async () => {
    const sw = load([]);
    await sw.run(
      'push',
      pushEvent(() => {
        throw new SyntaxError('bad json');
      }),
    );
    expect(sw.showNotification).toHaveBeenCalledWith('Agent Hub', expect.objectContaining({ data: { sessionId: null } }));
  });

  it('a payload of wrong types is not trusted', async () => {
    const sw = load([]);
    await sw.run(
      'push',
      pushEvent(() => ({ title: 5, body: {}, tag: 7, sessionId: 9 })),
    );
    expect(sw.showNotification).toHaveBeenCalledWith('Agent Hub', expect.objectContaining({ body: '', renotify: false, data: { sessionId: null } }));
  });
});

describe('push-sw.js: notificationclick', () => {
  const click = (sessionId: string | null) => ({ notification: { close: vi.fn(), data: { sessionId } } });

  it('closes the notification, focuses the open window and asks it to open the session', async () => {
    const w = win({ url: `${ORIGIN}/s/other`, visibilityState: 'visible' });
    const sw = load([w]);
    const e = click(SID);
    await sw.run('notificationclick', e);
    expect(e.notification.close).toHaveBeenCalled();
    expect(w.focus).toHaveBeenCalled();
    expect(w.postMessage).toHaveBeenCalledWith({ type: 'agent-hub:open-session', sessionId: SID });
    expect(sw.openWindow).not.toHaveBeenCalled();
  });

  it('prefers the focused window of the same origin and ignores other origins', async () => {
    const foreign = win({ url: 'https://evil.example.com/' });
    const hidden = win({ visibilityState: 'hidden' });
    const focused = win({ focused: true });
    const sw = load([foreign, hidden, focused]);
    await sw.run('notificationclick', click(SID));
    expect(focused.postMessage).toHaveBeenCalled();
    expect(hidden.postMessage).not.toHaveBeenCalled();
    expect(foreign.postMessage).not.toHaveBeenCalled();
  });

  it('without windows opens /s/<id>', async () => {
    const sw = load([]);
    await sw.run('notificationclick', click(SID));
    expect(sw.openWindow).toHaveBeenCalledWith(`/s/${SID}`);
  });

  it('only other origins are open: opens a new window', async () => {
    const sw = load([win({ url: 'https://evil.example.com/' })]);
    await sw.run('notificationclick', click(SID));
    expect(sw.openWindow).toHaveBeenCalledWith(`/s/${SID}`);
  });

  it('a failing focus falls back to a new window', async () => {
    const w = win({ focus: vi.fn(async () => Promise.reject(new Error('gone'))) });
    const sw = load([w]);
    await sw.run('notificationclick', click(SID));
    expect(w.postMessage).not.toHaveBeenCalled();
    expect(sw.openWindow).toHaveBeenCalledWith(`/s/${SID}`);
  });

  it('a notification without a session (test, broken payload) opens the app root, or just focuses an open window', async () => {
    const closed = load([]);
    await closed.run('notificationclick', click(null));
    expect(closed.openWindow).toHaveBeenCalledWith('/');
    const w = win();
    const open = load([w]);
    await open.run('notificationclick', click(null));
    expect(w.focus).toHaveBeenCalled();
    expect(w.postMessage).not.toHaveBeenCalled();
    expect(open.openWindow).not.toHaveBeenCalled();
  });
});
