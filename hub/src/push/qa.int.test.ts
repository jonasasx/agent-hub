// Change web-push-notifications, QA: scenarios of the spec that the other push tests do not pin down — the private VAPID key
// never leaves the hub, a warning without key values for a partial set, the 30 s window for the end of a turn, the cascade
// on user deletion.
import { randomUUID } from 'node:crypto';
import * as webpush from 'web-push';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PUSH_THROTTLE_MS } from '@agent-hub/shared';
import { PUBLIC_URL, agentSend, autoReply, connectFakeAgent, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';
import type { PushSendOptions, PushSendResult, PushSender, PushTarget } from './sender.js';

const ENDPOINT = 'https://push.example.com/send/qa-0001';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

class FakeSender implements PushSender {
  sent: { target: PushTarget; payload: Record<string, unknown>; opts: PushSendOptions }[] = [];
  async send(target: PushTarget, payload: unknown, opts: PushSendOptions): Promise<PushSendResult> {
    this.sent.push({ target, payload: payload as Record<string, unknown>, opts });
    return { ok: true };
  }
}

describe('push QA: the private key and the log', () => {
  const keys = webpush.generateVAPIDKeys();

  it('the private key is in no response of the API, the public one is only in /api/me', async () => {
    const t = await startTestHub({ env: { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: 'mailto:ops@example.com' } });
    try {
      const cookie = await t.login();
      const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
        t.hub.app.inject({ method, url, headers: { origin: PUBLIC_URL }, cookies: { ah_session: cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
      const bodies = [
        (await call('GET', '/api/me')).body,
        (await call('GET', '/api/push/subscriptions')).body,
        (await call('POST', '/api/push/subscriptions', { endpoint: 'http://10.0.0.5/x', keys: { p256dh: 'a', auth: 'b' } })).body,
        (await call('POST', '/api/push/test', { endpointHash: 'f'.repeat(64) })).body,
      ];
      for (const b of bodies) expect(b).not.toContain(keys.privateKey);
      expect(bodies[0]).toContain(keys.publicKey);
    } finally {
      await t.close();
    }
  });

  it.each([
    ['public without private', (k: webpush.VapidKeys) => ({ VAPID_PUBLIC_KEY: k.publicKey, VAPID_SUBJECT: 'mailto:ops@example.com' })],
    ['private without public', (k: webpush.VapidKeys) => ({ VAPID_PRIVATE_KEY: k.privateKey, VAPID_SUBJECT: 'mailto:ops@example.com' })],
  ])('a partial set (%s): a warning in the log without the values, push is off', async (_name, mk) => {
    const lines: string[] = [];
    const t = await startTestHub({
      env: mk(keys),
      logStream: {
        write: l => {
          lines.push(l);
        },
      },
    });
    try {
      const cookie = await t.login();
      const me = await t.hub.app.inject({ method: 'GET', url: '/api/me', cookies: { ah_session: cookie } });
      expect(me.json().vapidPublicKey).toBeNull();
      const log = lines.join('');
      expect(log).toContain('incomplete VAPID configuration');
      expect(log).not.toContain(keys.privateKey);
      expect(log).not.toContain(keys.publicKey);
    } finally {
      await t.close();
    }
  });
});

describe('push QA: the window of 30 s for the end of a turn, the cascade', () => {
  let t: TestHub;
  let agent: FakeAgent;
  let cookie: string;
  let userId: string;
  const clock = { now: Date.now() };
  const sender = new FakeSender();
  const q = (text: string, values: unknown[] = []) => t.tdb.pool.query(text, values);

  beforeAll(async () => {
    t = await startTestHub({ env: { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', VAPID_SUBJECT: 'mailto:ops@example.com' }, push: { sender, now: () => clock.now } });
    const token = await t.addRunner('x1', 'X1');
    agent = connectFakeAgent(t.wsBase, token);
    autoReply(agent, () => ({}));
    await agent.next('welcome');
    cookie = await t.login();
    userId = ((await t.hub.app.inject({ method: 'GET', url: '/api/me', cookies: { ah_session: cookie } })).json() as { user: { id: string } }).user.id;
    const sub = await t.hub.app.inject({
      method: 'POST',
      url: '/api/push/subscriptions',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { endpoint: ENDPOINT, keys: { p256dh: 'p256dh-key', auth: 'auth-key' } },
    });
    expect(sub.statusCode).toBe(201);
  });
  afterAll(async () => {
    await t.close();
  });

  it('a second end of a turn within 30 s of the first push is dropped, not delayed; later it is sent', async () => {
    const cid = randomUUID();
    const row = await q(
      `INSERT INTO sessions (user_id, runner_id, claude_session_id, source, status, title, cwd, is_hub_managed, process_alive) VALUES ($1, 'x1', $2, 'hub', 'working', 'Релиз', '/home/a', true, true) RETURNING id`,
      [userId, cid],
    );
    const id = row.rows[0].id as string;
    const result = (text: string) => agentSend(agent, 'session.result', { sessionId: cid, subtype: 'success', isError: false, durationMs: 1, costUsd: 0, resultText: text });
    const resume = async () => {
      await q(`UPDATE sessions SET status = 'working', unread = false WHERE id = $1`, [id]);
      await t.hub.sessions.upsert(id);
    };
    const before = sender.sent.length;
    result('первый ответ');
    await waitFor(() => sender.sent.length > before);
    await resume();
    clock.now += PUSH_THROTTLE_MS - 1000;
    result('второй ответ');
    await waitFor(async () => (await q(`SELECT status FROM sessions WHERE id = $1`, [id])).rows[0].status === 'waiting');
    await sleep(250);
    expect(sender.sent.length).toBe(before + 1);
    await resume();
    clock.now += PUSH_THROTTLE_MS + 1000;
    result('третий ответ');
    await waitFor(() => sender.sent.length > before + 1);
    expect(sender.sent[before + 1]!.payload.body).toBe('X1 · третий ответ');
  });

  it('subscriptions are deleted together with the user', async () => {
    const other = (await q(`INSERT INTO users (email) VALUES ('gone@example.com') RETURNING id`)).rows[0].id as string;
    await q(`INSERT INTO push_subscriptions (user_id, endpoint, endpoint_hash, p256dh, auth, device_label) VALUES ($1, 'https://push.example.com/gone', 'h', 'p', 'a', 'Chrome')`, [other]);
    expect((await q(`SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1`, [other])).rows[0].n).toBe(1);
    await q(`DELETE FROM users WHERE id = $1`, [other]);
    expect((await q(`SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1`, [other])).rows[0].n).toBe(0);
    expect((await q(`SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1`, [userId])).rows[0].n).toBe(1);
  });
});
