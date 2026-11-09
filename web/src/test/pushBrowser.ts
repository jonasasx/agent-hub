// A fake push-capable browser for tests (change web-push-notifications): service worker registration, PushManager,
// Notification. `installPushBrowser` stubs the globals, `removePushBrowser` puts them back.
import { vi } from 'vitest';
import { urlBase64ToBytes } from '../features/push/pushClient';

export interface FakeSub {
  endpoint: string;
  options: { applicationServerKey: ArrayBuffer | null };
  toJSON: () => { endpoint: string; keys: { p256dh: string; auth: string } };
  unsubscribe: ReturnType<typeof vi.fn>;
}

export interface PushBrowser {
  sub: FakeSub | null;
  permission: NotificationPermission;
  requestPermission: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  getSubscription: ReturnType<typeof vi.fn>;
  messageListeners: Array<(e: { data: unknown }) => void>;
}

export const makeSub = (endpoint: string, key: string | null): FakeSub => ({
  endpoint,
  options: { applicationServerKey: key ? urlBase64ToBytes(key).buffer : null },
  toJSON: () => ({ endpoint, keys: { p256dh: 'p256', auth: 'auth' } }),
  unsubscribe: vi.fn(async () => true),
});

export function installPushBrowser(over: { permission?: NotificationPermission; sub?: FakeSub | null; grant?: boolean } = {}): PushBrowser {
  const b: PushBrowser = {
    sub: over.sub ?? null,
    permission: over.permission ?? 'default',
    requestPermission: vi.fn(),
    subscribe: vi.fn(),
    getSubscription: vi.fn(),
    messageListeners: [],
  };
  b.requestPermission.mockImplementation(async () => {
    b.permission = over.grant === false ? 'denied' : 'granted';
    return b.permission;
  });
  b.getSubscription.mockImplementation(async () => b.sub);
  b.subscribe.mockImplementation(async (o: { applicationServerKey: Uint8Array<ArrayBuffer> }) => {
    const s = makeSub('https://push.example.org/new', null);
    s.options.applicationServerKey = o.applicationServerKey.buffer;
    b.sub = s;
    return s;
  });
  const reg = { pushManager: { getSubscription: b.getSubscription, subscribe: b.subscribe } };
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      ready: Promise.resolve(reg),
      addEventListener: (_type: string, h: (e: { data: unknown }) => void) => b.messageListeners.push(h),
      removeEventListener: (_type: string, h: (e: { data: unknown }) => void) => {
        b.messageListeners = b.messageListeners.filter(x => x !== h);
      },
    },
  });
  vi.stubGlobal('PushManager', class {});
  const note = { requestPermission: b.requestPermission };
  Object.defineProperty(note, 'permission', { get: () => b.permission });
  vi.stubGlobal('Notification', note);
  return b;
}

export function removePushBrowser(): void {
  Reflect.deleteProperty(navigator, 'serviceWorker');
  vi.unstubAllGlobals();
}

// 65 bytes of a P-256 point in base64url (the content is not checked, only decoded)
export const VAPID = 'BAUQ-' + 'A'.repeat(82);
export const VAPID_OTHER = 'BAUQ-' + 'B'.repeat(82);
