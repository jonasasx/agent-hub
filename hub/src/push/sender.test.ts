import * as webpush from 'web-push';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendNotification = vi.hoisted(() => vi.fn());
vi.mock('web-push', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, sendNotification };
});

import { createWebPushSender, failureStatus, isValidVapid, type Resolver } from './sender.js';

const target = { endpoint: 'https://push.example.com/send/abc', p256dh: 'p', auth: 'a' };
const vapid = { subject: 'mailto:ops@example.com', publicKey: 'pub', privateKey: 'priv' };
const publicHost: Resolver = async () => [{ address: '142.250.74.110', family: 4 }];

describe('failureStatus', () => {
  it('takes the status of the push service, null for anything else', () => {
    expect(failureStatus({ statusCode: 410 })).toBe(410);
    expect(failureStatus({ statusCode: 503 })).toBe(503);
    expect(failureStatus(new Error('ECONNRESET'))).toBeNull();
    expect(failureStatus({ statusCode: '410' })).toBeNull();
    expect(failureStatus(null)).toBeNull();
  });
});

describe('createWebPushSender', () => {
  beforeEach(() => {
    sendNotification.mockReset();
  });

  it('passes the headers, the payload and the VAPID details to web-push', async () => {
    sendNotification.mockResolvedValue({ statusCode: 201 });
    const res = await createWebPushSender(vapid, publicHost).send(target, { v: 1, title: 't' }, { ttl: 3600, urgency: 'high', topic: 'abc' });
    expect(res).toEqual({ ok: true });
    const [sub, body, opts] = sendNotification.mock.calls[0]!;
    expect(sub).toEqual({ endpoint: target.endpoint, keys: { p256dh: 'p', auth: 'a' } });
    expect(JSON.parse(body)).toEqual({ v: 1, title: 't' });
    expect(opts).toMatchObject({ TTL: 3600, urgency: 'high', topic: 'abc', timeout: 10_000, vapidDetails: vapid });
  });

  it.each([404, 410, 503, 403])('reports the status %d without the error object', async status => {
    sendNotification.mockImplementation(async () => {
      throw Object.assign(new Error('push failed'), { statusCode: status, endpoint: target.endpoint, body: 'secret' });
    });
    const res = await createWebPushSender(vapid, publicHost).send(target, {}, { ttl: 60, urgency: 'normal' });
    expect(res).toEqual({ ok: false, status });
  });

  it('reports a network failure as a null status', async () => {
    sendNotification.mockImplementation(async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    });
    expect(await createWebPushSender(vapid, publicHost).send(target, {}, { ttl: 60, urgency: 'normal' })).toEqual({ ok: false, status: null });
  });

  it('pins the checked address into the agent of the request', async () => {
    sendNotification.mockResolvedValue({ statusCode: 201 });
    await createWebPushSender(vapid, publicHost).send(target, {}, { ttl: 60, urgency: 'normal' });
    const opts = sendNotification.mock.calls[0]![2];
    const lookup = opts.agent.options.lookup as (h: string, o: object, cb: (...a: unknown[]) => void) => void;
    const single = vi.fn();
    lookup('push.example.com', {}, single);
    expect(single).toHaveBeenCalledWith(null, '142.250.74.110', 4);
    const all = vi.fn();
    lookup('push.example.com', { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: '142.250.74.110', family: 4 }]);
  });

  it.each([
    ['a private address', [{ address: '10.0.0.3', family: 4 as const }]],
    ['loopback', [{ address: '::1', family: 6 as const }]],
    [
      'one private among public ones',
      [
        { address: '142.250.74.110', family: 4 as const },
        { address: '192.168.0.9', family: 4 as const },
      ],
    ],
    ['no address at all', []],
  ])('does not connect to %s', async (_name, addresses) => {
    const res = await createWebPushSender(vapid, async () => addresses).send(target, {}, { ttl: 60, urgency: 'normal' });
    expect(res).toEqual({ ok: false, status: null, blocked: true });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('a DNS failure is a failure without a status, not a blocked address', async () => {
    const failing: Resolver = async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    };
    const res = await createWebPushSender(vapid, failing).send(target, {}, { ttl: 60, urgency: 'normal' });
    expect(res).toEqual({ ok: false, status: null });
  });
});

describe('isValidVapid', () => {
  const keys = webpush.generateVAPIDKeys();

  it('accepts a pair of keys with a mailto or https subject', () => {
    expect(isValidVapid({ subject: 'mailto:ops@example.com', ...keys })).toBe(true);
    expect(isValidVapid({ subject: 'https://hub.example.com', ...keys })).toBe(true);
  });

  it('rejects garbage, a swapped pair, keys of different pairs and a bad subject', () => {
    const other = webpush.generateVAPIDKeys();
    expect(isValidVapid({ subject: 'mailto:ops@example.com', publicKey: 'pub', privateKey: 'priv' })).toBe(false);
    expect(isValidVapid({ subject: 'mailto:ops@example.com', publicKey: keys.privateKey, privateKey: keys.publicKey })).toBe(false);
    expect(isValidVapid({ subject: 'mailto:ops@example.com', publicKey: keys.publicKey, privateKey: other.privateKey })).toBe(false);
    expect(isValidVapid({ subject: 'ops@example.com', ...keys })).toBe(false);
  });
});
