// Tests of the push client logic (change web-push-notifications, tasks 3.2): support detection, status, enable/disable,
// restore on start under a changed VAPID key, release on sign-out.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockFetch } from '../../test/factories';
import { VAPID, VAPID_OTHER, installPushBrowser, makeSub, removePushBrowser } from '../../test/pushBrowser';
import { PUSH_INTENT_KEY, disablePush, enablePush, endpointHash, pushStatus, pushSupport, releasePush, syncPush, urlBase64ToBytes, type PushEnv } from './pushClient';

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const APP = `${CHROME} Electron/33.0.0`;
const env = (over: Partial<PushEnv> = {}): PushEnv => ({ userAgent: CHROME, maxTouchPoints: 0, standalone: false, hasServiceWorker: true, hasPushManager: true, hasNotification: true, ...over });

describe('pushSupport', () => {
  it('a plain browser with all APIs is ok', () => {
    expect(pushSupport(env())).toBe('ok');
  });
  it('iOS outside the Home Screen asks to install, an installed PWA is ok', () => {
    expect(pushSupport(env({ userAgent: IPHONE }))).toBe('ios_install');
    expect(pushSupport(env({ userAgent: IPHONE, standalone: true }))).toBe('ok');
  });
  it('iPadOS posing as a Mac (touch points) counts as iOS', () => {
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
    expect(pushSupport(env({ userAgent: mac, maxTouchPoints: 5 }))).toBe('ios_install');
    expect(pushSupport(env({ userAgent: mac, maxTouchPoints: 0 }))).toBe('ok');
  });
  it('the Electron app never subscribes', () => {
    expect(pushSupport(env({ userAgent: APP }))).toBe('desktop_app');
  });
  it('missing APIs mean unsupported', () => {
    expect(pushSupport(env({ hasPushManager: false }))).toBe('unsupported');
    expect(pushSupport(env({ hasServiceWorker: false }))).toBe('unsupported');
    expect(pushSupport(env({ hasNotification: false }))).toBe('unsupported');
  });
});

describe('helpers', () => {
  it('endpointHash is sha256 hex', async () => {
    expect(await endpointHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('urlBase64ToBytes decodes base64url', () => {
    expect(Array.from(urlBase64ToBytes('_-8'))).toEqual([255, 239]);
  });
});

describe('push client on a fake browser', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    removePushBrowser();
    localStorage.clear();
  });

  it('status: not configured on the server wins over everything', async () => {
    installPushBrowser();
    expect((await pushStatus(null, [])).status).toBe('not_configured');
  });

  it('status: denied permission, no subscription (off), subscription known to the hub (on) or not (off)', async () => {
    const b = installPushBrowser({ permission: 'denied' });
    expect((await pushStatus(VAPID, [])).status).toBe('denied');
    b.permission = 'granted';
    expect((await pushStatus(VAPID, [])).status).toBe('off');
    b.sub = makeSub('https://push.example.org/a', VAPID);
    const hash = await endpointHash('https://push.example.org/a');
    expect(await pushStatus(VAPID, [hash])).toEqual({ status: 'on', hash });
    expect((await pushStatus(VAPID, ['0'.repeat(64)])).status).toBe('off');
  });

  it('enablePush: permission first, then subscribe, then POST; remembers the intent', async () => {
    const b = installPushBrowser();
    const calls = mockFetch({ 'POST /api/push/subscriptions': () => ({ status: 201, body: {} }) });
    expect(await enablePush(VAPID, 'u1')).toBe('enabled');
    expect(b.requestPermission).toHaveBeenCalledTimes(1);
    expect(b.requestPermission.mock.invocationCallOrder[0]!).toBeLessThan(b.subscribe.mock.invocationCallOrder[0]!);
    expect(b.subscribe.mock.calls[0]![0]).toMatchObject({ userVisibleOnly: true });
    expect(calls[0]!.body).toEqual({ endpoint: 'https://push.example.org/new', keys: { p256dh: 'p256', auth: 'auth' } });
    expect(localStorage.getItem(PUSH_INTENT_KEY)).toBe('u1');
  });

  it('enablePush: a refused permission creates nothing', async () => {
    const b = installPushBrowser({ grant: false });
    const calls = mockFetch({});
    expect(await enablePush(VAPID, 'u1')).toBe('denied');
    expect(b.subscribe).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(localStorage.getItem(PUSH_INTENT_KEY)).toBeNull();
  });

  it('enablePush: if the hub refuses, the browser subscription is dropped and the error surfaces', async () => {
    const b = installPushBrowser();
    mockFetch({ 'POST /api/push/subscriptions': () => ({ status: 503, body: { error: 'push_not_configured' } }) });
    await expect(enablePush(VAPID, 'u1')).rejects.toMatchObject({ status: 503 });
    expect(b.sub!.unsubscribe).toHaveBeenCalled();
    expect(localStorage.getItem(PUSH_INTENT_KEY)).toBeNull();
  });

  it('disablePush: DELETE by hash, unsubscribe, clear the intent; a hub error does not stop it', async () => {
    const b = installPushBrowser({ permission: 'granted', sub: makeSub('https://push.example.org/a', VAPID) });
    localStorage.setItem(PUSH_INTENT_KEY, 'u1');
    const sub = b.sub!;
    const calls = mockFetch({ 'DELETE /api/push/subscriptions': () => ({ status: 502, body: {} }) });
    await disablePush();
    expect(calls[0]!.url).toBe(`/api/push/subscriptions?endpointHash=${await endpointHash('https://push.example.org/a')}`);
    expect(sub.unsubscribe).toHaveBeenCalled();
    expect(localStorage.getItem(PUSH_INTENT_KEY)).toBeNull();
  });

  it('syncPush: no intent or no permission does nothing', async () => {
    const b = installPushBrowser({ permission: 'granted' });
    const calls = mockFetch({});
    await syncPush({ vapidPublicKey: VAPID, userId: 'u1' });
    expect(b.subscribe).not.toHaveBeenCalled();
    localStorage.setItem(PUSH_INTENT_KEY, 'u1');
    b.permission = 'default';
    await syncPush({ vapidPublicKey: VAPID, userId: 'u1' });
    expect(b.subscribe).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('syncPush: a lost subscription is made again without a dialog', async () => {
    const b = installPushBrowser({ permission: 'granted' });
    localStorage.setItem(PUSH_INTENT_KEY, 'u1');
    const calls = mockFetch({ 'POST /api/push/subscriptions': () => ({ status: 201, body: {} }) });
    await syncPush({ vapidPublicKey: VAPID, userId: 'u1' });
    expect(b.requestPermission).not.toHaveBeenCalled();
    expect(b.subscribe).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });

  it('syncPush: the same key only refreshes the hub record', async () => {
    const b = installPushBrowser({ permission: 'granted', sub: makeSub('https://push.example.org/a', VAPID) });
    localStorage.setItem(PUSH_INTENT_KEY, 'u1');
    const calls = mockFetch({ 'POST /api/push/subscriptions': () => ({ status: 200, body: {} }) });
    await syncPush({ vapidPublicKey: VAPID, userId: 'u1' });
    expect(b.subscribe).not.toHaveBeenCalled();
    expect(b.sub!.unsubscribe).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it('syncPush: a subscription made under another VAPID key is replaced', async () => {
    const b = installPushBrowser({ permission: 'granted', sub: makeSub('https://push.example.org/old', VAPID_OTHER) });
    localStorage.setItem(PUSH_INTENT_KEY, 'u1');
    const old = b.sub!;
    const calls = mockFetch({ 'POST /api/push/subscriptions': () => ({ status: 201, body: {} }) });
    await syncPush({ vapidPublicKey: VAPID, userId: 'u1' });
    expect(old.unsubscribe).toHaveBeenCalled();
    expect(b.subscribe).toHaveBeenCalledTimes(1);
    expect(calls[0]!.body).toMatchObject({ endpoint: 'https://push.example.org/new' });
  });

  it('syncPush: an intent of another user is not restored for this one; the stale browser subscription is dropped locally', async () => {
    const b = installPushBrowser({ permission: 'granted', sub: makeSub('https://push.example.org/a', VAPID) });
    const old = b.sub!;
    localStorage.setItem(PUSH_INTENT_KEY, 'u1');
    const calls = mockFetch({});
    await syncPush({ vapidPublicKey: VAPID, userId: 'u2' });
    expect(calls).toHaveLength(0);
    expect(b.subscribe).not.toHaveBeenCalled();
    expect(old.unsubscribe).toHaveBeenCalled();
    expect(localStorage.getItem(PUSH_INTENT_KEY)).toBeNull();
  });

  it('syncPush: an old intent without a user (legacy value) is not restored either', async () => {
    const b = installPushBrowser({ permission: 'granted' });
    localStorage.setItem(PUSH_INTENT_KEY, '1');
    const calls = mockFetch({});
    await syncPush({ vapidPublicKey: VAPID, userId: 'u2' });
    expect(calls).toHaveLength(0);
    expect(b.subscribe).not.toHaveBeenCalled();
  });

  it('syncPush: errors are silent', async () => {
    installPushBrowser({ permission: 'granted' });
    localStorage.setItem(PUSH_INTENT_KEY, 'u1');
    mockFetch({ 'POST /api/push/subscriptions': () => ({ status: 500, body: {} }) });
    await expect(syncPush({ vapidPublicKey: VAPID, userId: 'u1' })).resolves.toBeUndefined();
  });

  it('releasePush: gives up after the timeout when the hub hangs', async () => {
    const b = installPushBrowser({ permission: 'granted', sub: makeSub('https://push.example.org/a', VAPID) });
    localStorage.setItem(PUSH_INTENT_KEY, 'u1');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => undefined)),
    );
    const started = Date.now();
    await releasePush(50);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(b.getSubscription).toHaveBeenCalled();
  });

  it('releasePush: without intent and permission it does not touch anything', async () => {
    const b = installPushBrowser();
    const calls = mockFetch({});
    await releasePush(50);
    expect(b.getSubscription).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});
