// provider-parity R3, R5, R6, R10: a pending Codex sign-in lives in the database (taken once, by its machine, before it
// expires), and the hub tells the machines which Codex subscription homes may live.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CODEX_HOMES_SYNC_CAPABILITY } from '@agent-hub/shared';
import { PUBLIC_URL, agentSend, autoReply, connectFakeAgent, connectUi, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';

const KEY = randomBytes(32).toString('base64');
const CODEX_OK = { id: 'codex', version: '0.166.0', login: 'ok', models: [] };
const auth = (n: number) => JSON.stringify({ last_refresh: '2026-11-08T10:00:00Z', n, tokens: { account_id: 'acc-1' } });

interface Cmd {
  type: string;
  id?: string;
  payload: Record<string, unknown>;
}

describe('Codex sign-ins and homes (integration, provider-parity R3/R5/R6/R10)', () => {
  let t: TestHub;
  let cookie: string;
  let hp: FakeAgent;
  let vm: FakeAgent;
  let ui: ReturnType<typeof connectUi>;
  const got: Array<Cmd & { runner: string }> = [];
  let loginN = 0;
  const api = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
    t.hub.app.inject({ method, url, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const syncs = (runner: string) => got.filter(m => m.runner === runner && m.type === 'provider.credentials.sync').map(m => m.payload);
  const loginEvent = (loginId: string) => ui.received.find(m => m.type === 'provider.login' && m.loginId === loginId) as Record<string, unknown> | undefined;
  const pendingRows = async () => (await t.tdb.pool.query(`SELECT login_id FROM codex_subscription_logins ORDER BY login_id`)).rows.map(r => r.login_id as string);

  async function machine(runner: string, token: string): Promise<FakeAgent> {
    const a = connectFakeAgent(t.wsBase, token, { providers: [CODEX_OK], capabilities: [CODEX_HOMES_SYNC_CAPABILITY] });
    a.ws.on('message', d => {
      const m = JSON.parse(d.toString()) as Cmd;
      if (m.id) got.push({ ...m, runner });
    });
    autoReply(a, type => {
      if (type === 'provider.login.start') return { loginId: `login-${++loginN}`, verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234', expiresAt: Date.now() + 900_000 };
      if (type === 'provider.credentials.sync') return { removed: 0, deferred: 0 };
      return {};
    });
    await a.next('welcome');
    return a;
  }

  async function startLogin(runnerId: string, body: Record<string, unknown> = {}): Promise<string> {
    const r = await api('POST', '/api/subscriptions/codex-login', { runnerId, ...body });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().loginId as string;
  }

  beforeAll(async () => {
    t = await startTestHub({ env: { SUBSCRIPTION_TOKEN_KEY: KEY }, sessions: { idleCheckMs: 0 } });
    cookie = await t.login();
    const hpToken = await t.addRunner('hp', 'HP');
    const vmToken = await t.addRunner('vm', 'VM');
    hp = await machine('hp', hpToken);
    vm = await machine('vm', vmToken);
    ui = connectUi(t.wsBase, cookie);
    await ui.open;
  }, 120_000);
  afterAll(async () => {
    ui.ws.close();
    hp.ws.close();
    vm.ws.close();
    await t.close();
  });

  it('R3: a machine with the capability gets the keep-list on connect', async () => {
    await waitFor(() => syncs('hp').length > 0 && syncs('vm').length > 0);
    expect(syncs('hp')[0]).toEqual({ provider: 'codex', keep: [] });
  });

  it('R5: the pending sign-in is in the database, a done after a hub restart still creates the subscription', async () => {
    const loginId = await startLogin('hp', { name: 'Codex рабочий' });
    expect(await pendingRows()).toEqual([loginId]);
    // nothing of the sign-in is kept in memory: the row is all a restarted hub needs
    agentSend(hp, 'provider.login.done', { provider: 'codex', loginId, ok: true, credential: auth(1) });
    const done = await waitFor(() => loginEvent(loginId));
    expect(done).toMatchObject({ ok: true, subscriptionId: expect.any(String) });
    expect(await pendingRows()).toEqual([]);
    const subs = (await api('GET', '/api/subscriptions')).json().subscriptions as Array<{ id: string; name: string; provider: string }>;
    expect(subs.find(s => s.id === done.subscriptionId)).toMatchObject({ name: 'Codex рабочий', provider: 'codex' });
  });

  it('R10: a done from another machine, a second done and an unknown sign-in with a credential create nothing', async () => {
    const before = ((await api('GET', '/api/subscriptions')).json().subscriptions as unknown[]).length;
    const loginId = await startLogin('hp', { name: 'Codex 2' });
    agentSend(vm, 'provider.login.done', { provider: 'codex', loginId, ok: true, credential: auth(2) });
    await waitFor(() => loginEvent(loginId));
    expect(loginEvent(loginId)).toMatchObject({ runnerId: 'vm', ok: false, errorI18n: { key: 'hub.sessions.loginExpired' } });
    expect(await pendingRows()).toEqual([loginId]);
    agentSend(vm, 'provider.login.done', { provider: 'codex', loginId: 'login-unknown', ok: true, credential: auth(3) });
    await waitFor(() => loginEvent('login-unknown'));
    expect(loginEvent('login-unknown')).toMatchObject({ ok: false });
    expect(((await api('GET', '/api/subscriptions')).json().subscriptions as unknown[]).length).toBe(before);
    await t.tdb.pool.query(`DELETE FROM codex_subscription_logins`);
  });

  it('R6: an expired sign-in is not taken and is cleaned on the next start', async () => {
    const loginId = await startLogin('hp', { name: 'Codex старый' });
    await t.tdb.pool.query(`UPDATE codex_subscription_logins SET expires_at = now() - interval '1 minute' WHERE login_id = $1`, [loginId]);
    agentSend(hp, 'provider.login.done', { provider: 'codex', loginId, ok: true, credential: auth(4) });
    await waitFor(() => loginEvent(loginId));
    expect(loginEvent(loginId)).toMatchObject({ ok: false, errorI18n: { key: 'hub.sessions.loginExpired' } });
    expect(((await api('GET', '/api/subscriptions')).json().subscriptions as Array<{ name: string }>).some(s => s.name === 'Codex старый')).toBe(false);
    await t.tdb.pool.query(`UPDATE codex_subscription_logins SET expires_at = now() - interval '1 minute'`);
    const next = await startLogin('hp', { name: 'Codex новый' });
    expect(await pendingRows()).toEqual([next]);
    await t.tdb.pool.query(`DELETE FROM codex_subscription_logins`);
  });

  it('R3: a re-login sends forget with the subscription, a retire drops it from keep on every machine', async () => {
    const subs = (await api('GET', '/api/subscriptions')).json().subscriptions as Array<{ id: string; provider: string; retiredAt: string | null }>;
    const id = subs.find(s => s.provider === 'codex')!.id;
    const loginId = await startLogin('hp', { subscriptionId: id });
    const hpBefore = syncs('hp').length;
    agentSend(hp, 'provider.login.done', { provider: 'codex', loginId, ok: true, credential: auth(5) });
    await waitFor(() => syncs('hp').length > hpBefore && syncs('vm').some(p => Array.isArray(p.forget)));
    expect(syncs('hp').at(-1)).toEqual({ provider: 'codex', keep: [id], forget: [id] });
    expect(syncs('vm').at(-1)).toEqual({ provider: 'codex', keep: [id], forget: [id] });
    const vmBefore = syncs('vm').length;
    const r = await api('PATCH', `/api/subscriptions/${id}`, { retired: true });
    expect(r.statusCode, r.body).toBe(200);
    await waitFor(() => syncs('vm').length > vmBefore);
    expect(syncs('vm').at(-1)).toEqual({ provider: 'codex', keep: [] });
    expect(syncs('hp').at(-1)).toEqual({ provider: 'codex', keep: [] });
  });

  it('R3: a machine without the capability is never sent the sync', async () => {
    const token = await t.addRunner('old', 'Old');
    const old = connectFakeAgent(t.wsBase, token, { providers: [CODEX_OK] });
    old.ws.on('message', d => {
      const m = JSON.parse(d.toString()) as Cmd;
      if (m.id) got.push({ ...m, runner: 'old' });
    });
    autoReply(old, () => ({}));
    await old.next('welcome');
    const subs = (await api('GET', '/api/subscriptions')).json().subscriptions as Array<{ id: string; provider: string }>;
    await api('PATCH', `/api/subscriptions/${subs.find(s => s.provider === 'codex')!.id}`, { retired: false });
    await waitFor(() => syncs('hp').at(-1)?.keep !== undefined && (syncs('hp').at(-1)!.keep as string[]).length === 1);
    expect(syncs('old')).toEqual([]);
    old.ws.close();
  });
});
