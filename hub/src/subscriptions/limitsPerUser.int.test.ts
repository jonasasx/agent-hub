// subscription-limits task 5.6 (Requirement: Изоляция лимитов по пользователям; Выбор машины — «Чужие машины не
// используются»): two users with subscriptions and machines; reads, refresh, notifications, events and the choice of
// a runner never cross. Pattern of perUser.int.test.ts.
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { envelope, type SessionView, type SubscriptionLimitsResponse } from '@agent-hub/shared';
import { PUBLIC_URL, agentSend, connectFakeAgent, connectUi, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';
import { issueRunnerToken } from '../runners/repo.js';

const KEY = randomBytes(32).toString('base64');
const IVAN_TOKEN = `sk-ant-oat01-${randomBytes(30).toString('hex')}IVAN`;
const BOB_TOKEN = `sk-ant-oat01-${randomBytes(30).toString('hex')}KSEN`;
const SNAP = { windows: [{ type: 'five_hour', utilization: 40, resetsAt: '2026-10-27T15:10:00.000Z', status: 'allowed' }], overage: null };

interface Cmd {
  type: string;
  id?: string;
  payload: Record<string, unknown>;
  runner: string;
}

describe('subscription limits per user (integration, 5.6)', () => {
  let t: TestHub;
  let ivan: string;
  let bob: string;
  let ivanSub: string;
  let bobSub: string;
  let ivanMachine: FakeAgent;
  let kMachine: FakeAgent;
  let ivanUi: ReturnType<typeof connectUi>;
  let kUi: ReturnType<typeof connectUi>;
  const got: Cmd[] = [];
  const bodies: string[] = [];

  const api = async (cookie: string, method: 'GET' | 'POST', url: string, payload?: unknown) => {
    const r = await t.hub.app.inject({ method, url, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, ...(payload !== undefined ? { payload: payload as object } : {}) });
    bodies.push(r.body);
    return r;
  };
  const limitsOf = async (cookie: string) => ((await api(cookie, 'GET', '/api/subscriptions/limits')).json() as SubscriptionLimitsResponse).limits;
  const changed = (u: ReturnType<typeof connectUi>) => u.received.filter(m => m.type === 'subscription_limits.changed').length;

  function machine(runner: string, token: string, hostname: string): FakeAgent {
    const a = connectFakeAgent(t.wsBase, token, { protocol: '1.6', hostname, homeDir: '/home/u', os: 'Ubuntu', vaultRoot: null });
    a.ws.on('message', d => {
      const m = JSON.parse(d.toString()) as Cmd;
      if (!m.id) return;
      got.push({ ...m, runner });
      const result =
        m.type === 'fs.stat'
          ? { exists: true, isDir: true }
          : m.type === 'session.start'
            ? { models: [] }
            : m.type === 'limits.probe'
              ? { outcome: 'ok', snapshot: SNAP, resetsAt: null, limitType: null, message: null, durationMs: 1 }
              : {};
      a.ws.send(JSON.stringify(envelope('cmd.ok', { result }, { re: m.id })));
    });
    return a;
  }

  beforeAll(async () => {
    t = await startTestHub({ env: { SUBSCRIPTION_TOKEN_KEY: KEY }, sessions: { idleCheckMs: 0, initTimeoutMs: 3000 } });
    ivan = await t.login();
    ivanMachine = machine('hp', await t.addRunner('hp', 'HP Ивана'), 'hp-host');
    await ivanMachine.next('welcome');
    ivanSub = (await api(ivan, 'POST', '/api/subscriptions', { name: 'Max Ивана', token: IVAN_TOKEN })).json().id as string;
    const inv = await api(ivan, 'POST', '/api/admin/invites', { email: 'bob@example.com', provider: 'google' });
    bob = await t.login({ email: 'bob@example.com' }, { invite: (inv.json().url as string).split('/invite/')[1]! });
    const bobId = (await api(bob, 'GET', '/api/me')).json().user.id as string;
    await t.tdb.pool.query(`INSERT INTO runners (id, user_id, name, hostname) VALUES ('r-bobhp01', $1, 'Ноутбук Кати', 'k-host')`, [bobId]);
    kMachine = machine('r-bobhp01', await issueRunnerToken(t.tdb.db, 'r-bobhp01'), 'k-host');
    await kMachine.next('welcome');
    bobSub = (await api(bob, 'POST', '/api/subscriptions', { name: 'Pro Кати', token: BOB_TOKEN })).json().id as string;
    ivanUi = connectUi(t.wsBase, ivan);
    kUi = connectUi(t.wsBase, bob);
    await Promise.all([ivanUi.open, kUi.open]);
  }, 120_000);
  afterAll(async () => {
    ivanUi.ws.close();
    kUi.ws.close();
    ivanMachine.ws.close();
    kMachine.ws.close();
    await t.close();
  });

  it('GET: each sees only the own subscriptions', async () => {
    expect((await limitsOf(ivan)).map(l => l.subscriptionId)).toEqual([ivanSub]);
    expect((await limitsOf(bob)).map(l => l.subscriptionId)).toEqual([bobSub]);
  });

  it('a tick: each token goes to the owner’s machine only; each owner is notified only of the own', async () => {
    const [i0, k0] = [changed(ivanUi), changed(kUi)];
    await t.hub.limits.tick();
    await t.hub.limits.flush();
    const probes = got.filter(m => m.type === 'limits.probe');
    expect(probes.map(p => [p.runner, (p.payload.subscription as { token: string }).token])).toEqual(
      expect.arrayContaining([
        ['hp', IVAN_TOKEN],
        ['r-bobhp01', BOB_TOKEN],
      ]),
    );
    expect(probes).toHaveLength(2);
    await waitFor(() => changed(ivanUi) > i0 && changed(kUi) > k0);
    expect((await limitsOf(ivan))[0]).toMatchObject({ state: 'ok', windows: [expect.objectContaining({ utilization: 40 })] });
  });

  it('refresh of the other user’s subscription → 404, nothing sent', async () => {
    const n = got.length;
    expect((await api(bob, 'POST', `/api/subscriptions/${ivanSub}/limits/refresh`)).statusCode).toBe(404);
    expect((await api(ivan, 'POST', `/api/subscriptions/${bobSub}/limits/refresh`)).statusCode).toBe(404);
    expect(got.length).toBe(n);
  });

  it('Ivan’s machine offline: his subscription gets no_runner, Bob’s machine never gets his token', async () => {
    ivanMachine.ws.close();
    await waitFor(() => !t.hub.agents.isOnline('hp'));
    const n = got.length;
    const r = await api(ivan, 'POST', `/api/subscriptions/${ivanSub}/limits/refresh`);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: 'runner_offline' });
    await t.tdb.pool.query(`UPDATE subscription_limits SET last_ok_at = now() - interval '3 hours', last_quiet_at = NULL, last_probe_at = now() - interval '3 hours'`); // the probe too: a probe within the period holds the next one (review B1)
    await t.hub.limits.tick();
    await t.hub.limits.flush();
    const sent = got.slice(n).filter(m => m.type === 'limits.probe');
    expect(sent.map(p => (p.payload.subscription as { id: string }).id)).toEqual([bobSub]);
    expect(JSON.stringify(got.filter(m => m.runner === 'r-bobhp01'))).not.toContain(IVAN_TOKEN);
    expect((await limitsOf(ivan))[0]).toMatchObject({ state: 'unavailable', reason: 'no_runner' });
  });

  it('a limits.event naming Bob’s session from another machine is ignored; hers from her machine reaches only her', async () => {
    const r = await api(bob, 'POST', '/api/sessions', { runnerId: 'r-bobhp01', cwd: '/home/u', model: 'haiku', prompt: `привет ${randomUUID()}`, subscriptionId: bobSub });
    expect(r.statusCode, r.body).toBe(201);
    const s = r.json() as SessionView;
    await waitFor(() => got.find(m => m.type === 'session.start' && m.payload.sessionId === s.id));
    const [i0, k0] = [changed(ivanUi), changed(kUi)];
    agentSend(kMachine, 'limits.event', {
      sessionId: s.id,
      snapshot: { windows: [{ type: 'five_hour', utilization: 77, resetsAt: null, status: 'allowed' }], overage: null },
      quiet: false,
      observedAt: Date.now(),
    });
    await waitFor(async () => (await limitsOf(bob))[0]!.windows.find(w => w.type === 'five_hour')?.utilization === 77);
    await waitFor(() => changed(kUi) > k0);
    expect(changed(ivanUi)).toBe(i0);
    expect((await limitsOf(ivan))[0]!.windows.find(w => w.type === 'five_hour')?.utilization).toBe(40);
  });

  it('no answer of one user carries the other’s token or subscription', () => {
    const ivanBodies = bodies.join('\n');
    expect(ivanBodies).not.toContain(IVAN_TOKEN);
    expect(ivanBodies).not.toContain(BOB_TOKEN);
    expect(JSON.stringify(kUi.received)).not.toContain(ivanSub);
    expect(JSON.stringify(ivanUi.received)).not.toContain(bobSub);
  });
});
