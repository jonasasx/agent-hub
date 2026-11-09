import * as webpush from 'web-push';
// Change web-push-notifications (task 4.5): the API of Web Push subscriptions and the public key in /api/me.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PUSH_MAX_DEVICES, type PushDeviceView, type PushSubscriptionsResponse } from '@agent-hub/shared';
import { PUBLIC_URL, startTestHub, type TestHub } from '../test/harness.js';
import type { PushSendResult, PushSender } from '../push/sender.js';
import { endpointHash } from '../push/repo.js';

const VAPID = { VAPID_PUBLIC_KEY: 'BPublicKeyForTests', VAPID_PRIVATE_KEY: 'priv', VAPID_SUBJECT: 'mailto:ops@example.com' };
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/device-aaaa';
const keys = { p256dh: 'p256dh-secret-key', auth: 'auth-secret-key' };
const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

class FakeSender implements PushSender {
  calls: string[] = [];
  results = new Map<string, PushSendResult>();
  async send(target: { endpoint: string }): Promise<PushSendResult> {
    this.calls.push(target.endpoint);
    return this.results.get(target.endpoint) ?? { ok: true };
  }
}

describe('push API (integration)', () => {
  let t: TestHub;
  let ivan: string;
  let bob: string;
  const sender = new FakeSender();
  let clock = Date.now();

  const call = (cookie: string | null, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown, ua?: string) =>
    t.hub.app.inject({
      method,
      url,
      headers: { origin: PUBLIC_URL, ...(ua ? { 'user-agent': ua } : {}) },
      ...(cookie ? { cookies: { ah_session: cookie } } : {}),
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
  const subscribe = (cookie: string, endpoint: string, ua?: string) => call(cookie, 'POST', '/api/push/subscriptions', { endpoint, keys }, ua);
  const list = async (cookie: string) => (await call(cookie, 'GET', '/api/push/subscriptions')).json() as PushSubscriptionsResponse;

  beforeAll(async () => {
    t = await startTestHub({ env: VAPID, push: { sender, now: () => clock } });
    ivan = await t.login();
    const inv = await t.hub.app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      headers: { origin: PUBLIC_URL },
      cookies: { ah_session: ivan },
      payload: { email: 'bob@example.com', provider: 'google' },
    });
    bob = await t.login({ email: 'bob@example.com' }, { invite: (inv.json().url as string).split('/invite/')[1]! });
  });
  afterAll(async () => {
    await t.close();
  });

  it('needs a session', async () => {
    expect((await call(null, 'GET', '/api/push/subscriptions')).statusCode).toBe(401);
    expect((await call(null, 'POST', '/api/push/subscriptions', { endpoint: ENDPOINT, keys })).statusCode).toBe(401);
    expect((await call(null, 'POST', '/api/push/test', { endpointHash: endpointHash(ENDPOINT) })).statusCode).toBe(401);
  });

  it('subscribe, list, subscribe again, remove: the whole cycle', async () => {
    expect(await list(ivan)).toEqual({ configured: true, devices: [] });
    const created = await subscribe(ivan, ENDPOINT, CHROME_WIN);
    expect(created.statusCode).toBe(201);
    const device = created.json() as PushDeviceView;
    expect(device).toMatchObject({ label: 'Chrome · Windows', endpointHash: endpointHash(ENDPOINT), lastSuccessAt: null, lastFailureAt: null, failureCount: 0 });
    // the same endpoint again is an update: 200, the same id
    const again = await subscribe(ivan, ENDPOINT, CHROME_WIN);
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(device.id);
    const l = await list(ivan);
    expect(l.devices).toHaveLength(1);
    // the answers never carry the endpoint or the keys
    const raw = JSON.stringify([created.json(), l]);
    expect(raw).not.toContain(ENDPOINT);
    expect(raw).not.toContain('secret-key');
    expect(Object.keys(l.devices[0]!).sort()).toEqual(['createdAt', 'endpointHash', 'failureCount', 'id', 'label', 'lastFailureAt', 'lastSuccessAt']);
    // the keys are stored as given
    const row = (await t.tdb.pool.query(`SELECT p256dh, auth FROM push_subscriptions WHERE id = $1`, [device.id])).rows[0];
    expect(row).toEqual({ p256dh: keys.p256dh, auth: keys.auth });
    const del = await call(ivan, 'DELETE', `/api/push/subscriptions/${device.id}`);
    expect(del.statusCode).toBe(204);
    expect((await list(ivan)).devices).toEqual([]);
    expect((await call(ivan, 'DELETE', `/api/push/subscriptions/${device.id}`)).statusCode).toBe(404);
  });

  it('a device of another user: 404 on remove and on test, the list is private', async () => {
    const mine = (await subscribe(ivan, `${ENDPOINT}-mine`)).json() as PushDeviceView;
    expect((await list(bob)).devices).toEqual([]);
    const del = await call(bob, 'DELETE', `/api/push/subscriptions/${mine.id}`);
    expect(del.statusCode).toBe(404);
    expect(del.json().error).toBe('subscription_not_found');
    expect((await call(bob, 'POST', '/api/push/test', { endpointHash: mine.endpointHash })).statusCode).toBe(404);
    expect((await call(bob, 'DELETE', `/api/push/subscriptions?endpointHash=${mine.endpointHash}`)).statusCode).toBe(204);
    expect((await list(ivan)).devices).toHaveLength(1);
    expect(sender.calls).toEqual([]);
    await call(ivan, 'DELETE', `/api/push/subscriptions/${mine.id}`);
  });

  it('a browser endpoint taken by another account moves to the user who subscribes now', async () => {
    const first = (await subscribe(ivan, `${ENDPOINT}-shared`)).json() as PushDeviceView;
    const second = await subscribe(bob, `${ENDPOINT}-shared`);
    expect(second.statusCode).toBe(201);
    expect((await list(ivan)).devices).toEqual([]);
    const l = await list(bob);
    expect(l.devices).toHaveLength(1);
    expect(l.devices[0]!.endpointHash).toBe(first.endpointHash);
    expect(await t.tdb.pool.query(`SELECT 1 FROM push_subscriptions WHERE endpoint = $1`, [`${ENDPOINT}-shared`]).then(r => r.rowCount)).toBe(1);
    await call(bob, 'DELETE', `/api/push/subscriptions?endpointHash=${first.endpointHash}`);
  });

  it('an unsafe or malformed subscription is 422', async () => {
    const bad: unknown[] = [
      { endpoint: 'http://push.example.com/x', keys },
      { endpoint: 'https://localhost/x', keys },
      { endpoint: 'https://127.0.0.1/x', keys },
      { endpoint: 'https://10.0.0.5/x', keys },
      { endpoint: 'https://user:pass@push.example.com/x', keys },
      { endpoint: 'not a url', keys },
      { endpoint: ENDPOINT },
      { endpoint: ENDPOINT, keys: { p256dh: '', auth: 'a' } },
      { endpoint: `https://push.example.com/${'a'.repeat(3000)}`, keys },
      {},
    ];
    for (const body of bad) {
      const r = await call(ivan, 'POST', '/api/push/subscriptions', body);
      expect(r.statusCode, JSON.stringify(body).slice(0, 80)).toBe(422);
      expect(r.json().error).toBe('invalid_subscription');
    }
    expect((await list(ivan)).devices).toEqual([]);
  });

  it('the 21st device is 422, a repeated endpoint of a full list still updates', async () => {
    for (let i = 0; i < PUSH_MAX_DEVICES; i++) expect((await subscribe(ivan, `https://push.example.com/send/limit-${i}`)).statusCode).toBe(201);
    const over = await subscribe(ivan, 'https://push.example.com/send/limit-over');
    expect(over.statusCode).toBe(422);
    expect(over.json().error).toBe('too_many_devices');
    expect((await subscribe(ivan, 'https://push.example.com/send/limit-0')).statusCode).toBe(200);
    expect((await list(ivan)).devices).toHaveLength(PUSH_MAX_DEVICES);
    await t.tdb.pool.query(`DELETE FROM push_subscriptions`);
  });

  it('taking over an endpoint obeys the limit of the new owner, and a taken-over device starts as a new one', async () => {
    const taken = `${ENDPOINT}-taken`;
    const first = (await subscribe(ivan, taken)).json() as PushDeviceView;
    await t.tdb.pool.query(`UPDATE push_subscriptions SET created_at = now() - interval '30 days', last_success_at = now() WHERE id = $1`, [first.id]);
    for (let i = 0; i < PUSH_MAX_DEVICES; i++) expect((await subscribe(bob, `https://push.example.com/send/bob-${i}`)).statusCode).toBe(201);
    const refused = await subscribe(bob, taken);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toBe('too_many_devices');
    expect((await list(ivan)).devices.map(d => d.id)).toEqual([first.id]);
    await call(bob, 'DELETE', `/api/push/subscriptions?endpointHash=${endpointHash('https://push.example.com/send/bob-0')}`);
    const moved = await subscribe(bob, taken);
    expect(moved.statusCode).toBe(201);
    expect(new Date(moved.json().createdAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(moved.json().lastSuccessAt).toBeNull();
    expect((await list(ivan)).devices).toEqual([]);
    await t.tdb.pool.query(`DELETE FROM push_subscriptions`);
  });

  it('parallel subscriptions of one user never get past the limit', async () => {
    const results = await Promise.all(Array.from({ length: PUSH_MAX_DEVICES + 8 }, (_v, i) => subscribe(ivan, `https://push.example.com/send/race-${i}`)));
    expect(results.filter(r => r.statusCode === 201)).toHaveLength(PUSH_MAX_DEVICES);
    expect(results.filter(r => r.statusCode === 422)).toHaveLength(8);
    expect((await list(ivan)).devices).toHaveLength(PUSH_MAX_DEVICES);
    await t.tdb.pool.query(`DELETE FROM push_subscriptions`);
  });

  it('two users subscribing the same brand-new endpoint at once: no 500, the endpoint belongs to one of them', async () => {
    const shared = `${ENDPOINT}-both`;
    const [a, b] = await Promise.all([subscribe(ivan, shared), subscribe(bob, shared)]);
    expect([a.statusCode, b.statusCode].every(c => c === 201)).toBe(true);
    expect((await t.tdb.pool.query(`SELECT count(*)::int AS n FROM push_subscriptions WHERE endpoint = $1`, [shared])).rows[0].n).toBe(1);
    await t.tdb.pool.query(`DELETE FROM push_subscriptions`);
  });

  it('remove by endpoint hash is idempotent and tolerates garbage', async () => {
    const d = (await subscribe(ivan, `${ENDPOINT}-hash`)).json() as PushDeviceView;
    expect((await call(ivan, 'DELETE', `/api/push/subscriptions?endpointHash=${d.endpointHash}`)).statusCode).toBe(204);
    expect((await list(ivan)).devices).toEqual([]);
    expect((await call(ivan, 'DELETE', `/api/push/subscriptions?endpointHash=${d.endpointHash}`)).statusCode).toBe(204);
    expect((await call(ivan, 'DELETE', '/api/push/subscriptions?endpointHash=zzz')).statusCode).toBe(204);
    expect((await call(ivan, 'DELETE', '/api/push/subscriptions')).statusCode).toBe(204);
    expect((await call(ivan, 'DELETE', '/api/push/subscriptions/not-a-uuid')).statusCode).toBe(404);
  });

  it('the test push: 204, then 410 removes the device, 502 keeps it, the 6th in a minute is 429', async () => {
    const d = (await subscribe(ivan, `${ENDPOINT}-test`)).json() as PushDeviceView;
    const body = { endpointHash: d.endpointHash };
    expect((await call(ivan, 'POST', '/api/push/test', body)).statusCode).toBe(204);
    expect(sender.calls).toEqual([`${ENDPOINT}-test`]);
    expect((await list(ivan)).devices[0]!.lastSuccessAt).not.toBeNull();
    sender.results.set(`${ENDPOINT}-test`, { ok: false, status: 503 });
    const failed = await call(ivan, 'POST', '/api/push/test', body);
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error).toBe('push_failed');
    expect((await list(ivan)).devices[0]!.failureCount).toBe(1);
    sender.results.set(`${ENDPOINT}-test`, { ok: false, status: 410 });
    const gone = await call(ivan, 'POST', '/api/push/test', body);
    expect(gone.statusCode).toBe(410);
    expect(gone.json().error).toBe('subscription_gone');
    expect((await list(ivan)).devices).toEqual([]);
    expect((await call(ivan, 'POST', '/api/push/test', body)).statusCode).toBe(404);
    // 4 requests so far: one more fits, then the limit of five a minute
    expect((await call(ivan, 'POST', '/api/push/test', { endpointHash: 'a'.repeat(64) })).statusCode).toBe(404);
    const limited = await call(ivan, 'POST', '/api/push/test', body);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toBe('rate_limited');
    // the limit is per user: Bob is not affected
    expect((await call(bob, 'POST', '/api/push/test', body)).statusCode).toBe(404);
    // and it opens again after a minute
    clock += 61_000;
    expect((await call(ivan, 'POST', '/api/push/test', body)).statusCode).toBe(404);
  });

  it('the test push does not tell an internal address from any other failure: 502, and the device is dropped quietly', async () => {
    const d = (await subscribe(ivan, `${ENDPOINT}-internal`)).json() as PushDeviceView;
    sender.results.set(`${ENDPOINT}-internal`, { ok: false, status: null, blocked: true });
    const res = await call(ivan, 'POST', '/api/push/test', { endpointHash: d.endpointHash });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('push_failed');
    expect((await list(ivan)).devices).toEqual([]);
    clock += 61_000;
  });

  it('a body that is not a hash is 404', async () => {
    expect((await call(ivan, 'POST', '/api/push/test', {})).statusCode).toBe(404);
    expect((await call(ivan, 'POST', '/api/push/test', { endpointHash: 'short' })).statusCode).toBe(404);
  });

  it('/api/me carries the public key', async () => {
    const me = await call(ivan, 'GET', '/api/me');
    expect(me.json().vapidPublicKey).toBe('BPublicKeyForTests');
    expect(JSON.stringify(me.json())).not.toContain('priv');
  });

  it('error texts follow the language of the user', async () => {
    const r = await t.hub.app.inject({
      method: 'POST',
      url: '/api/push/subscriptions',
      headers: { origin: PUBLIC_URL, 'x-agent-hub-locale': 'en' },
      cookies: { ah_session: ivan },
      payload: { endpoint: 'http://insecure.example.com', keys },
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().message).toBe('The push subscription is invalid');
  });
});

describe.each([
  ['no keys at all', {}],
  ['only the public key', { VAPID_PUBLIC_KEY: 'pub' }],
  ['no subject', { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' }],
  ['a subject that is not mailto/https', { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', VAPID_SUBJECT: 'ops@example.com' }],
])('push API without a complete VAPID configuration: %s', (_name, env) => {
  let t: TestHub;
  let cookie: string;

  beforeAll(async () => {
    t = await startTestHub({ env });
    cookie = await t.login();
  });
  afterAll(async () => {
    await t.close();
  });

  const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    t.hub.app.inject({ method, url, headers: { origin: PUBLIC_URL }, cookies: { ah_session: cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

  it('says it is not configured and offers no key', async () => {
    expect((await call('GET', '/api/me')).json().vapidPublicKey).toBeNull();
    expect((await call('GET', '/api/push/subscriptions')).json()).toEqual({ configured: false, devices: [] });
    const sub = await call('POST', '/api/push/subscriptions', { endpoint: ENDPOINT, keys });
    expect(sub.statusCode).toBe(503);
    expect(sub.json().error).toBe('push_not_configured');
    const test = await call('POST', '/api/push/test', { endpointHash: endpointHash(ENDPOINT) });
    expect(test.statusCode).toBe(503);
    expect((await t.tdb.pool.query(`SELECT count(*)::int AS n FROM push_subscriptions`)).rows[0].n).toBe(0);
  });
});

describe('push API with real VAPID keys', () => {
  const keys = webpush.generateVAPIDKeys();
  const other = webpush.generateVAPIDKeys();

  it('a valid set turns push on', async () => {
    const t = await startTestHub({ env: { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: 'mailto:ops@example.com' } });
    try {
      const cookie = await t.login();
      const me = await t.hub.app.inject({ method: 'GET', url: '/api/me', cookies: { ah_session: cookie } });
      expect(me.json().vapidPublicKey).toBe(keys.publicKey);
      const list = await t.hub.app.inject({ method: 'GET', url: '/api/push/subscriptions', cookies: { ah_session: cookie } });
      expect(list.json().configured).toBe(true);
    } finally {
      await t.close();
    }
  });

  it.each([
    ['keys that are not keys', { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', VAPID_SUBJECT: 'mailto:ops@example.com' }],
    ['a private key of another pair', { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: other.privateKey, VAPID_SUBJECT: 'mailto:ops@example.com' }],
  ])('%s: the hub starts with push off', async (_name, env) => {
    const t = await startTestHub({ env });
    try {
      const cookie = await t.login();
      const me = await t.hub.app.inject({ method: 'GET', url: '/api/me', cookies: { ah_session: cookie } });
      expect(me.json().vapidPublicKey).toBeNull();
      const sub = await t.hub.app.inject({
        method: 'POST',
        url: '/api/push/subscriptions',
        headers: { origin: PUBLIC_URL },
        cookies: { ah_session: cookie },
        payload: { endpoint: ENDPOINT, keys },
      });
      expect(sub.statusCode).toBe(503);
    } finally {
      await t.close();
    }
  });
});
