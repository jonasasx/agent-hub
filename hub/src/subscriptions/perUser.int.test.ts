// Change multi-user, task 3.5 (Requirement: Подписки Claude на пользователя): the registry of subscriptions and the
// last choice belong to the user. Scenario «Реестр у нового пользователя»: an invited colleague without subscriptions
// gets no field «Подписка» and her session runs under the Claude login of her machine; Ivan's subscriptions are not
// hers to see, choose or be notified about.
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionView, SubscriptionUsageResponse, SubscriptionsResponse } from '@agent-hub/shared';
import { PUBLIC_URL, autoReply, connectFakeAgent, connectUi, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';
import { issueRunnerToken } from '../runners/repo.js';

const KEY = randomBytes(32).toString('base64');
const IVAN_TOKEN = `sk-ant-oat01-${randomBytes(30).toString('hex')}IVAN`;

interface Cmd {
  type: string;
  id?: string;
  payload: Record<string, unknown>;
}

describe('subscriptions per user (integration, multi-user 3.5)', () => {
  let t: TestHub;
  let ivan: string;
  let bob: string;
  let bobId: string;
  let ivanSub: string;
  const agents: FakeAgent[] = [];
  const got: Array<Cmd & { runner: string }> = [];

  const api = (cookie: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    t.hub.app.inject({ method, url, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const startCmd = (sessionId: string) => got.find(m => m.type === 'session.start' && m.payload.sessionId === sessionId)?.payload;

  function machine(runner: string, token: string): FakeAgent {
    const a = connectFakeAgent(t.wsBase, token, { homeDir: '/home/ubuntu', os: 'Ubuntu', vaultRoot: null });
    a.ws.on('message', d => {
      const m = JSON.parse(d.toString()) as Cmd;
      if (m.id) got.push({ ...m, runner });
    });
    autoReply(a, type => {
      if (type === 'fs.stat') return { exists: true, isDir: true };
      if (type === 'session.start') return { models: runner === 'r-bobhp01' ? [{ value: 'bob-model', displayName: 'Bob model' }] : [] };
      return {};
    });
    agents.push(a);
    return a;
  }

  beforeAll(async () => {
    t = await startTestHub({ env: { SUBSCRIPTION_TOKEN_KEY: KEY }, sessions: { idleCheckMs: 0, initTimeoutMs: 3000 } });
    ivan = await t.login();
    // Ivan: his machine and a subscription chosen last
    const ivanMachine = machine('hp', await t.addRunner('hp', 'HP Ивана'));
    await ivanMachine.next('welcome');
    const added = await api(ivan, 'POST', '/api/subscriptions', { name: 'Max Ивана', token: IVAN_TOKEN });
    expect(added.statusCode, added.body).toBe(201);
    ivanSub = added.json().id as string;
    const ivanId = (await api(ivan, 'GET', '/api/me')).json().user.id as string;
    await t.hub.sessions.subscriptions!.setLastChoice(ivanId, ivanSub);
    // Bob: invited, her own machine (protocol of this build, so subscriptions would be possible there)
    const inv = await api(ivan, 'POST', '/api/admin/invites', { email: 'bob@example.com', provider: 'google' });
    bob = await t.login({ email: 'bob@example.com' }, { invite: (inv.json().url as string).split('/invite/')[1]! });
    bobId = (await api(bob, 'GET', '/api/me')).json().user.id as string;
    await t.tdb.pool.query(`INSERT INTO runners (id, user_id, name, hostname) VALUES ('r-bobhp01', $1, 'Ноутбук Кати', 'k-host')`, [bobId]);
    const kMachine = machine('r-bobhp01', await issueRunnerToken(t.tdb.db, 'r-bobhp01'));
    await kMachine.next('welcome');
  }, 120_000);
  afterAll(async () => {
    for (const a of agents) a.ws.close();
    await t.close();
  });

  it("Реестр у нового пользователя: an empty registry of her own — no field, no default, Ivan's subscription not in it", async () => {
    const r = await api(bob, 'GET', '/api/subscriptions');
    expect(r.statusCode).toBe(200);
    const l = r.json() as SubscriptionsResponse;
    // `enabled` is the hub's key, not someone's registry; the web hides the field while `subscriptions` is empty
    expect(l).toMatchObject({ enabled: true, subscriptions: [], lastChoiceId: null, defaultId: null });
    expect(r.body).not.toContain(ivanSub);
    expect(r.body).not.toContain('Max Ивана');
    const usage = (await api(bob, 'GET', '/api/subscriptions/usage')).json() as SubscriptionUsageResponse;
    expect(usage.rows.filter(x => x.subscriptionId !== null)).toEqual([]);
    // the check is not vacuous: Ivan sees his own
    expect(((await api(ivan, 'GET', '/api/subscriptions')).json() as SubscriptionsResponse).defaultId).toBe(ivanSub);
  });

  it('Реестр у нового пользователя: her session runs under the Claude login of her machine (no subscription in session.start)', async () => {
    const r = await api(bob, 'POST', '/api/sessions', { runnerId: 'r-bobhp01', cwd: '/home/ubuntu', model: 'haiku', prompt: `привет ${randomUUID()}` });
    expect(r.statusCode, r.body).toBe(201);
    const s = r.json() as SessionView;
    const start = await waitFor(() => startCmd(s.id));
    expect(start).not.toHaveProperty('subscription');
    expect(JSON.stringify(start)).not.toContain(IVAN_TOKEN);
    expect(s.subscription).toBeNull();
    expect(s.subscriptionMode).toBe('none');
    // Ivan's session on his machine does run under his subscription (the same hub, the same protocol)
    const own = await api(ivan, 'POST', '/api/sessions', { runnerId: 'hp', cwd: '/home/ubuntu', model: 'haiku', prompt: `привет ${randomUUID()}` });
    expect(own.statusCode, own.body).toBe(201);
    const ownStart = await waitFor(() => startCmd((own.json() as SessionView).id));
    expect(ownStart.subscription).toEqual({ id: ivanSub, token: IVAN_TOKEN });
  });

  it("provider-parity R8: the models reported by her machine are hers, not in Ivan's list", async () => {
    const r = await api(bob, 'POST', '/api/sessions', { runnerId: 'r-bobhp01', cwd: '/home/ubuntu', model: 'haiku', prompt: `models ${randomUUID()}` });
    expect(r.statusCode, r.body).toBe(201);
    await waitFor(async () => (await api(bob, 'GET', '/api/models')).body.includes('bob-model'));
    expect((await api(ivan, 'GET', '/api/models')).body).not.toContain('bob-model');
  });

  it("she cannot launch or switch under Ivan's subscription: 422 subscription_unavailable, nothing sent", async () => {
    const before = got.length;
    const r = await api(bob, 'POST', '/api/sessions', { runnerId: 'r-bobhp01', cwd: '/home/ubuntu', model: 'haiku', prompt: 'x', subscriptionId: ivanSub });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe('subscription_unavailable');
    expect(got.slice(before).filter(m => m.type === 'session.start')).toEqual([]);
    expect((await t.hub.sessions.subscriptions!.credFor(bobId, { protocol_version: '1.5' })) ?? null).toBeNull();
    await expect(t.hub.sessions.subscriptions!.credFor(bobId, { protocol_version: '1.5' }, ivanSub)).rejects.toMatchObject({ status: 422, code: 'subscription_unavailable' });
  });

  it("subscriptions.changed of Ivan's registry reaches his clients only", async () => {
    const kUi = connectUi(t.wsBase, bob);
    const iUi = connectUi(t.wsBase, ivan);
    await Promise.all([kUi.open, iUi.open]);
    const r = await api(ivan, 'POST', '/api/subscriptions', { name: 'Pro Ивана', token: `sk-ant-oat01-${randomBytes(30).toString('hex')}PRO1` });
    expect(r.statusCode).toBe(201);
    await waitFor(() => iUi.received.some(m => m.type === 'subscriptions.changed'));
    await new Promise(res => setTimeout(res, 300));
    expect(kUi.received.some(m => m.type === 'subscriptions.changed')).toBe(false);
    kUi.ws.close();
    iUi.ws.close();
  });
});
