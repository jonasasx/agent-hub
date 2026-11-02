// claude-subscriptions tasks 4.4, 5.1–5.6 against a real hub, Postgres and scripted agents (HP — protocol 1.4,
// ВМ — 1.3). The tests of one describe share the hub and run in order: the registry grows as they go.
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionView, SubscriptionUsageResponse, SubscriptionView, SubscriptionsResponse } from '@agent-hub/shared';
import { PUBLIC_URL, agentSend, autoReply, connectFakeAgent, connectUi, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';
import * as F from '../test/transcriptFixtures.js';

const VAULT = 'C:\\Users\\alice\\vault';
const KEY = randomBytes(32).toString('base64');
/** Distinct tokens: each ends with its own 4 characters and has a unique 12-character tail to search for. */
const tok = (tail: string) => `sk-ant-oat01-${randomBytes(30).toString('hex')}${tail}`;

interface Cmd {
  type: string;
  id?: string;
  payload: Record<string, unknown>;
}

describe('subscriptions (integration)', () => {
  let t: TestHub;
  let cookie: string;
  let userId: string;
  let hp: FakeAgent;
  let vm: FakeAgent;
  let ui: ReturnType<typeof connectUi>;
  let ui2: ReturnType<typeof connectUi>;
  /** Every command the agents got, in order. */
  const got: Array<Cmd & { runner: string }> = [];
  /** Every HTTP answer body and every UI WS message: no token may appear in any of them. */
  const seen: string[] = [];
  const tokens: string[] = [];
  /** What the fake HP agent sends before cmd.ok of session.stop (results of the stopping process). */
  const onStop: Array<(p: Record<string, unknown>) => void> = [];
  const acks: Array<Record<string, unknown>> = [];
  /** Sessions whose session.resume the fake HP agent refuses (cmd.error). */
  const failResume = new Set<string>();
  /** QA B1: what the fake HP agent's handoff.generate fails with (cmd.error with `failure`), once per entry. */
  const handoffFails: Array<Record<string, unknown>> = [];
  /** fs.stat of the fake HP agent answers «does not exist» (the project directory is gone). */
  let cwdGone = false;
  /** Every line of the hub's log (pino, level info). */
  const logs: string[] = [];

  const api = async (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown) => {
    const r = await t.hub.app.inject({ method, url, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, ...(payload !== undefined ? { payload: payload as object } : {}) });
    seen.push(r.body);
    return r;
  };
  const list = async () => (await api('GET', '/api/subscriptions')).json() as SubscriptionsResponse;
  const add = async (name: string, token = tok(randomBytes(2).toString('hex'))) => {
    tokens.push(token);
    const r = await api('POST', '/api/subscriptions', { name, token });
    expect(r.statusCode, r.body).toBe(201);
    return { view: r.json() as SubscriptionView, token };
  };
  const cmds = (type: string, sessionId?: string) => got.filter(m => m.type === type && (!sessionId || m.payload.sessionId === sessionId));
  const lastCmd = (type: string, sessionId?: string) => cmds(type, sessionId).at(-1)?.payload;
  const getS = async (id: string) => (await api('GET', `/api/sessions/${id}`)).json() as SessionView;
  const newSession = async (extra: Record<string, unknown> = {}, runnerId = 'hp') => {
    const r = await api('POST', '/api/sessions', { runnerId, cwd: runnerId === 'vm' ? '/home/ubuntu' : VAULT, model: 'haiku', prompt: `привет ${randomUUID()}`, ...extra });
    return r;
  };
  const created = async (extra: Record<string, unknown> = {}) => {
    const r = await newSession(extra);
    expect(r.statusCode, r.body).toBe(201);
    const s = r.json() as SessionView;
    await waitFor(() => lastCmd('session.start', s.id));
    return s;
  };
  /** session.result from HP: the turn ended (the session waits). */
  const result = (sessionId: string, extra: Record<string, unknown> = {}) =>
    agentSend(hp, 'session.result', {
      sessionId,
      subtype: 'success',
      isError: false,
      durationMs: 5,
      costUsd: 0,
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 100, cacheCreationTokens: 7 },
      ...extra,
    });
  const turns = async (sessionId: string) =>
    (await t.tdb.pool.query(`SELECT subscription_id, is_error, failure, input_tokens::int AS i, output_tokens::int AS o FROM session_turns WHERE session_id = $1 ORDER BY id`, [sessionId]))
      .rows as Array<{ subscription_id: string | null; is_error: boolean; failure: string | null; i: number; o: number }>;
  const notes = async (sessionId: string) =>
    (await t.tdb.pool.query(`SELECT kind, text FROM session_notes WHERE session_id = $1 ORDER BY id`, [sessionId])).rows as Array<{ kind: string; text: string }>;
  const waitStatus = (id: string, status: string) => waitFor(async () => (await getS(id)).status === status);

  function agent(runner: string, token: string, protocol: string) {
    const a = connectFakeAgent(t.wsBase, token, { protocol, ...(runner === 'vm' ? { homeDir: '/home/ubuntu', os: 'Ubuntu', vaultRoot: '/home/ubuntu/vault' } : {}) });
    a.ws.on('message', d => {
      const m = JSON.parse(d.toString()) as Cmd;
      if (m.id) got.push({ ...m, runner });
      else if (m.type === 'repl.ack') acks.push(m.payload);
    });
    autoReply(a, (type, p) => {
      if (type === 'fs.stat') return cwdGone ? { exists: false, isDir: false } : { exists: true, isDir: true };
      if (type === 'session.resume' && failResume.has(p.sessionId as string)) throw Object.assign(new Error('spawn failed'), { code: 'spawn_failed' });
      if (type === 'session.start' || type === 'session.resume') return { models: [] };
      if (type === 'session.stop') {
        for (const f of onStop.splice(0)) f(p);
        agentSend(a, 'session.exited', { sessionId: p.sessionId, code: 0, reason: 'stopped' });
      }
      if (type === 'handoff.generate') {
        const f = handoffFails.shift();
        if (f) throw Object.assign(new Error(String(f.message ?? f.kind)), { code: 'generation_failed', failure: f });
        return { text: 'черновик' };
      }
      return {};
    });
    return a;
  }

  beforeAll(async () => {
    t = await startTestHub({ env: { SUBSCRIPTION_TOKEN_KEY: KEY }, logStream: { write: l => void logs.push(l) }, sessions: { idleCheckMs: 0, initTimeoutMs: 3000, deliveryGraceMs: 60_000 } });
    const hpToken = await t.addRunner('hp', 'HP');
    const vmToken = await t.addRunner('vm', 'ВМ');
    await t.addRunner('x1', 'X1');
    cookie = await t.login();
    userId = ((await api('GET', '/api/me')).json() as { user: { id: string } }).user.id;
    hp = agent('hp', hpToken, '1.4');
    vm = agent('vm', vmToken, '1.3');
    await hp.next('welcome');
    await vm.next('welcome');
    ui = connectUi(t.wsBase, cookie);
    ui2 = connectUi(t.wsBase, cookie);
    await Promise.all([ui.open, ui2.open]);
  }, 240_000);
  afterAll(async () => {
    ui.ws.close();
    ui2.ws.close();
    await t.close();
  });

  it('5.2 an empty registry: start and resume payloads exactly as before the change, mode none', async () => {
    expect((await list()).subscriptions).toEqual([]);
    const s = await created();
    expect(Object.keys(lastCmd('session.start', s.id)!).sort()).toEqual(['cwd', 'model', 'permissionMode', 'prompt', 'promptUuid', 'sessionId']);
    expect(s.subscription).toBeNull();
    expect(s.subscriptionMode).toBe('none');
    result(s.id);
    agentSend(hp, 'session.exited', { sessionId: s.id, code: 0, reason: 'stopped' });
    await waitStatus(s.id, 'sleeping');
    expect((await api('POST', `/api/sessions/${s.id}/messages`, { text: 'ещё', clientUuid: randomUUID() })).statusCode).toBe(202);
    const resume = await waitFor(() => lastCmd('session.resume', s.id));
    expect(Object.keys(resume).sort()).toEqual(['cwd', 'model', 'permissionMode', 'prompt', 'promptUuid', 'sessionId']);
    // the turn of the machine login is counted with the usage it had
    expect(await turns(s.id)).toEqual([{ subscription_id: null, is_error: false, failure: null, i: 10, o: 2 }]);
  });

  let A: { view: SubscriptionView; token: string };
  let B: { view: SubscriptionView; token: string };
  let C: { view: SubscriptionView; token: string };

  it('5.1 add: 201 with tokenHint = the last 4 characters, at the end, auto switch off; a second window gets subscriptions.changed', async () => {
    const before = ui2.received.length;
    A = await add('Max личная', tok('AAAA'));
    expect(A.view).toMatchObject({ name: 'Max личная', tokenHint: 'AAAA', position: 0, autoSwitch: false, retired: false, tokenRejected: false, limitResetsAt: null });
    await waitFor(() => ui2.received.slice(before).some(m => m.type === 'subscriptions.changed'));
    B = await add('Pro рабочая', tok('BBBB'));
    expect(B.view.position).toBe(1);
    const l = await list();
    expect(l).toMatchObject({ enabled: true, lastChoiceId: null, defaultId: A.view.id, connectorsHint: true });
    expect(l.subscriptions.map(s => s.name)).toEqual(['Max личная', 'Pro рабочая']);
  });

  it('5.1 409 name_taken (case-insensitive among active ones); 422 bad_token; PUT order with an incomplete list → 422', async () => {
    const r = await api('POST', '/api/subscriptions', { name: 'max ЛИЧНАЯ', token: tok('zzzz') });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: 'name_taken', message: 'Подписка с таким именем уже есть' });
    const bad = await api('POST', '/api/subscriptions', { name: 'X', token: 'short token' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ error: 'bad_token' });
    expect(bad.body).not.toContain('short token');
    expect((await api('PUT', '/api/subscriptions/order', { ids: [A.view.id] })).statusCode).toBe(422);
    expect((await api('PUT', '/api/subscriptions/order', { ids: [A.view.id, A.view.id] })).statusCode).toBe(422);
    expect((await api('PATCH', `/api/subscriptions/${B.view.id}`, { name: 'Max личная' })).statusCode).toBe(409);
    const ok = await api('PUT', '/api/subscriptions/order', { ids: [B.view.id, A.view.id] });
    expect((ok.json() as SubscriptionsResponse).subscriptions.map(s => s.name)).toEqual(['Pro рабочая', 'Max личная']);
    await api('PUT', '/api/subscriptions/order', { ids: [A.view.id, B.view.id] });
  });

  it('4.4 the default subscription: no choice → the first active; the last choice retired → the first active; a retired name may be reused', async () => {
    const subs = t.hub.sessions.subscriptions!;
    expect((await subs.defaultFor(userId))!.id).toBe(A.view.id);
    const tmp = await add('Временная');
    await subs.setLastChoice(userId, tmp.view.id);
    expect((await subs.defaultFor(userId))!.id).toBe(tmp.view.id);
    expect((await api('PATCH', `/api/subscriptions/${tmp.view.id}`, { retired: true })).json()).toMatchObject({ retired: true });
    expect((await subs.defaultFor(userId))!.id).toBe(A.view.id);
    expect((await list()).defaultId).toBe(A.view.id);
    // a retired subscription keeps its name; a new active one may take it
    const again = await add('Временная');
    expect((await api('PATCH', `/api/subscriptions/${tmp.view.id}`, { retired: false })).statusCode).toBe(409);
    await api('PATCH', `/api/subscriptions/${again.view.id}`, { retired: true });
    // agent 1.3 → no subscription; agent 1.4 → the default one, decrypted
    expect(await subs.credFor(userId, { protocol_version: '1.3' })).toBeNull();
    expect(await subs.credFor(userId, { protocol_version: '1.4' })).toMatchObject({ id: A.view.id, name: 'Max личная', token: A.token });
    expect(await subs.credFor(userId, { protocol_version: '1.4' }, null)).toBeNull();
    await t.tdb.pool.query(`UPDATE users SET last_subscription_id = NULL WHERE id = $1`, [userId]);
  });

  it('5.2 start under the chosen subscription: the decrypted token in session.start, the last choice, the head of the tab', async () => {
    const s = await created({ subscriptionId: B.view.id });
    expect(lastCmd('session.start', s.id)!.subscription).toEqual({ id: B.view.id, token: B.token });
    expect(s.subscription).toEqual({ id: B.view.id, name: 'Pro рабочая' });
    expect(s.subscriptionMode).toBe('subscription');
    expect((await list()).lastChoiceId).toBe(B.view.id);
    // without the field: the default one (now B, the last choice); null — the machine login
    const d = await created();
    expect((lastCmd('session.start', d.id)!.subscription as { id: string }).id).toBe(B.view.id);
    const m = await created({ subscriptionId: null });
    expect(lastCmd('session.start', m.id)!.subscription).toBeUndefined();
    expect(m.subscriptionMode).toBe('machine_login');
    expect((await list()).lastChoiceId).toBe(B.view.id);
  });

  it('5.2 resume of a sleeping session goes under the last choice, not under its previous subscription', async () => {
    const s = await created({ subscriptionId: A.view.id });
    result(s.id);
    agentSend(hp, 'session.exited', { sessionId: s.id, code: 0, reason: 'stopped' });
    await waitStatus(s.id, 'sleeping');
    await created({ subscriptionId: B.view.id });
    expect((await api('POST', `/api/sessions/${s.id}/messages`, { text: 'дальше', clientUuid: randomUUID() })).statusCode).toBe(202);
    const r = await waitFor(() => lastCmd('session.resume', s.id));
    expect(r.subscription).toEqual({ id: B.view.id, token: B.token });
    expect((await getS(s.id)).subscription).toEqual({ id: B.view.id, name: 'Pro рабочая' });
    expect((await notes(s.id)).map(n => n.text)).toContain('Поднята через resume · подписка Pro рабочая');
    // resume does not change the last choice
    expect((await list()).lastChoiceId).toBe(B.view.id);
  });

  it('5.2 agent 1.3: no subscription in the command, mode agent_outdated; switching there → 409 agent_outdated', async () => {
    const r = await newSession({ subscriptionId: A.view.id }, 'vm');
    expect(r.statusCode, r.body).toBe(201);
    const s = r.json() as SessionView;
    const start = await waitFor(() => lastCmd('session.start', s.id));
    expect('subscription' in start).toBe(false);
    expect(s.subscriptionMode).toBe('agent_outdated');
    const sw = await api('POST', `/api/sessions/${s.id}/subscription`, { subscriptionId: A.view.id });
    expect(sw.statusCode).toBe(409);
    expect(sw.json()).toMatchObject({ error: 'agent_outdated' });
  });

  it('5.2 a retired subscription in the body → 422 subscription_unavailable, nothing created; an unreadable token → 409 token_unreadable', async () => {
    const gone = await add('Ушедшая');
    await api('PATCH', `/api/subscriptions/${gone.view.id}`, { retired: true });
    const n0 = (await t.tdb.pool.query(`SELECT count(*)::int AS n FROM sessions`)).rows[0].n as number;
    const r = await newSession({ subscriptionId: gone.view.id });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toMatchObject({ error: 'subscription_unavailable', message: 'Подписка недоступна — выберите другую' });
    expect((await newSession({ subscriptionId: randomUUID() })).statusCode).toBe(422);
    const broken = await add('Сломанная');
    await t.tdb.pool.query(`UPDATE subscriptions SET token_enc = decode(repeat('00', 60), 'hex') WHERE id = $1`, [broken.view.id]);
    const u = await newSession({ subscriptionId: broken.view.id });
    expect(u.statusCode).toBe(409);
    expect(u.json()).toEqual({ error: 'token_unreadable', message: 'Токен подписки Сломанная не расшифрован — замените токен' });
    expect((await t.tdb.pool.query(`SELECT count(*)::int AS n FROM sessions`)).rows[0].n).toBe(n0);
    await api('PATCH', `/api/subscriptions/${broken.view.id}`, { retired: true });
  });

  it('5.1 PUT token replaces the whole value (new hint, «отклонён» cleared), the next launch passes the new token', async () => {
    await t.tdb.pool.query(`UPDATE subscriptions SET token_rejected_at = now() WHERE id = $1`, [A.view.id]);
    const fresh = tok('A2A2');
    tokens.push(fresh);
    const r = await api('PUT', `/api/subscriptions/${A.view.id}/token`, { token: fresh });
    expect(r.json()).toMatchObject({ tokenHint: 'A2A2', tokenRejected: false });
    expect(Date.parse((r.json() as SubscriptionView).tokenUpdatedAt)).toBeGreaterThan(Date.parse(A.view.tokenUpdatedAt) - 1);
    A = { view: r.json() as SubscriptionView, token: fresh };
    const s = await created({ subscriptionId: A.view.id });
    expect(lastCmd('session.start', s.id)!.subscription).toEqual({ id: A.view.id, token: fresh });
  });

  it('5.3 switch of a waiting session: stop → resume under the new one; the old process result is counted under the old one', async () => {
    const s = await created({ subscriptionId: A.view.id });
    result(s.id);
    await waitStatus(s.id, 'waiting');
    const mark = got.length;
    // the stopping process ends one more turn before cmd.ok of session.stop (same WebSocket, before the answer)
    onStop.push(p =>
      agentSend(hp, 'session.result', {
        sessionId: p.sessionId,
        subtype: 'success',
        isError: false,
        durationMs: 1,
        costUsd: 0,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      }),
    );
    const r = await api('POST', `/api/sessions/${s.id}/subscription`, { subscriptionId: B.view.id });
    expect(r.statusCode, r.body).toBe(202);
    expect((r.json() as { session: SessionView }).session.subscription).toEqual({ id: B.view.id, name: 'Pro рабочая' });
    const order = got
      .slice(mark)
      .filter(m => m.payload.sessionId === s.id)
      .map(m => m.type);
    expect(order).toEqual(['session.stop', 'session.resume']);
    const resume = lastCmd('session.resume', s.id)!;
    expect(resume.subscription).toEqual({ id: B.view.id, token: B.token });
    expect(resume.prompt).toBeUndefined();
    expect((await turns(s.id)).map(x => x.subscription_id)).toEqual([A.view.id, A.view.id]);
    const sw = (await notes(s.id)).filter(n => n.kind === 'subscription_switch').map(n => JSON.parse(n.text) as { display: string; subscription: unknown });
    expect(sw).toEqual([{ display: 'Подписка: Max личная → Pro рабочая. Первый ход пересчитает контекст без кэша', subscription: { kind: 'switch', subscriptionId: B.view.id } }]);
    // one note of the switch, no «Поднята через resume» beside it
    expect((await notes(s.id)).filter(n => n.kind === 'resume')).toEqual([]);
    expect((await list()).lastChoiceId).toBe(B.view.id);
    result(s.id);
    await waitFor(async () => (await turns(s.id)).length === 3);
    expect((await turns(s.id)).map(x => x.subscription_id)).toEqual([A.view.id, A.view.id, B.view.id]);
  });

  it('5.3 a running turn: 409 turn_in_progress; with interrupt — interrupt → stop → resume, with repeatLast — the last message under a new promptUuid', async () => {
    const prompt = `сделай ${randomUUID()}`;
    const s = await created({ subscriptionId: A.view.id, prompt });
    const busy = await api('POST', `/api/sessions/${s.id}/subscription`, { subscriptionId: B.view.id });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toMatchObject({ error: 'turn_in_progress' });
    const mark = got.length;
    const r = await api('POST', `/api/sessions/${s.id}/subscription`, { subscriptionId: B.view.id, interrupt: true, repeatLast: true });
    expect(r.statusCode, r.body).toBe(202);
    expect(
      got
        .slice(mark)
        .filter(m => m.payload.sessionId === s.id)
        .map(m => m.type),
    ).toEqual(['session.interrupt', 'session.stop', 'session.resume']);
    const resume = lastCmd('session.resume', s.id)!;
    expect(resume).toMatchObject({ prompt, subscription: { id: B.view.id, token: B.token } });
    expect(resume.promptUuid).not.toBe(lastCmd('session.start', s.id)!.promptUuid);
    expect((await notes(s.id)).map(n => n.text)).toContain('Ход прерван');
  });

  it('5.3 a turn waiting for a permission answer is mid-turn: 409 turn_in_progress; with interrupt — interrupt → stop → resume', async () => {
    const s = await created({ subscriptionId: A.view.id });
    agentSend(hp, 'permission.request', { requestId: randomUUID(), sessionId: s.id, toolName: 'Bash', toolUseId: 'toolu_sw', input: { command: 'hostname' }, suggestions: [] });
    await waitStatus(s.id, 'permission');
    const busy = await api('POST', `/api/sessions/${s.id}/subscription`, { subscriptionId: B.view.id });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toMatchObject({ error: 'turn_in_progress' });
    expect(cmds('session.stop', s.id)).toEqual([]);
    const mark = got.length;
    const r = await api('POST', `/api/sessions/${s.id}/subscription`, { subscriptionId: B.view.id, interrupt: true });
    expect(r.statusCode, r.body).toBe(202);
    expect(
      got
        .slice(mark)
        .filter(m => m.payload.sessionId === s.id)
        .map(m => m.type),
    ).toEqual(['session.interrupt', 'session.stop', 'session.resume']);
    expect(lastCmd('session.resume', s.id)!.subscription).toEqual({ id: B.view.id, token: B.token });
  });

  it('5.3 resume under the new subscription fails: no «A → B» note; a launch refused by the agent — the launch failure note after it', async () => {
    // resume() itself throws (the directory is gone): the error answer, no switch note, the row keeps A
    const s = await created({ subscriptionId: A.view.id });
    result(s.id);
    await waitStatus(s.id, 'waiting');
    cwdGone = true;
    const r = await api('POST', `/api/sessions/${s.id}/subscription`, { subscriptionId: B.view.id });
    cwdGone = false;
    expect(r.statusCode, r.body).toBe(423);
    expect(cmds('session.resume', s.id)).toEqual([]);
    expect((await notes(s.id)).filter(n => n.kind === 'subscription_switch')).toEqual([]);
    expect((await getS(s.id)).subscription).toEqual({ id: A.view.id, name: 'Max личная' });
    // the agent refuses the launch (asynchronous): the switch note, then the launch failure note
    const s2 = await created({ subscriptionId: A.view.id });
    result(s2.id);
    await waitStatus(s2.id, 'waiting');
    failResume.add(s2.id);
    expect((await api('POST', `/api/sessions/${s2.id}/subscription`, { subscriptionId: B.view.id })).statusCode).toBe(202);
    await waitFor(async () => (await notes(s2.id)).some(n => n.kind === 'launch_failed'));
    failResume.delete(s2.id);
    const kinds = (await notes(s2.id)).map(n => n.kind).filter(k => k === 'subscription_switch' || k === 'launch_failed');
    expect(kinds).toEqual(['subscription_switch', 'launch_failed']);
  });

  it('5.3 a sleeping session: only the last choice, no command; offline machine → 409 runner_offline; read-only → 423', async () => {
    const s = await created({ subscriptionId: B.view.id });
    agentSend(hp, 'session.exited', { sessionId: s.id, code: 0, reason: 'stopped' });
    await waitStatus(s.id, 'sleeping');
    const mark = got.length;
    const r = await api('POST', `/api/sessions/${s.id}/subscription`, { subscriptionId: A.view.id });
    expect(r.statusCode).toBe(202);
    expect(got.slice(mark).filter(m => m.payload.sessionId === s.id)).toEqual([]);
    expect((await list()).lastChoiceId).toBe(A.view.id);
    expect((await getS(s.id)).subscription).toEqual({ id: B.view.id, name: 'Pro рабочая' });
    const off = (
      await t.tdb.pool.query(
        `INSERT INTO sessions (user_id, runner_id, claude_session_id, cwd, source, status, is_hub_managed) VALUES ($1, 'x1', gen_random_uuid(), 'C:\\w', 'hub', 'sleeping', true) RETURNING id`,
        [userId],
      )
    ).rows[0].id as string;
    const ro = await api('POST', `/api/sessions/${off}/subscription`, { subscriptionId: A.view.id });
    expect(ro.statusCode).toBe(409);
    expect(ro.json()).toMatchObject({ error: 'runner_offline' });
    await t.tdb.pool.query(`UPDATE sessions SET read_only_reason = 'cron' WHERE id = $1`, [s.id]);
    expect((await api('POST', `/api/sessions/${s.id}/subscription`, { subscriptionId: A.view.id })).statusCode).toBe(423);
    await api('PUT', '/api/subscriptions/order', { ids: [A.view.id, B.view.id] });
  });

  it('5.4 three kinds of failure give their notes and marks; alternatives — active, without a limit and a rejected token', async () => {
    C = await add('Team');
    await t.tdb.pool.query(`UPDATE users SET last_subscription_id = $1 WHERE id = $2`, [A.view.id, userId]);
    const resetsAt = Date.now() + 3 * 3600_000;
    // limit of A: C has a rejected token, so the only alternative is B
    await t.tdb.pool.query(`UPDATE subscriptions SET token_rejected_at = now() WHERE id = $1`, [C.view.id]);
    const s1 = await created({ subscriptionId: A.view.id });
    ui.send({ type: 'subscribe', sessionIds: [s1.id] });
    result(s1.id, { isError: true, errorText: "You've hit your session limit", failure: { kind: 'subscription_limit', resetsAt, limitType: 'five_hour', message: "You've hit your session limit" } });
    await waitFor(async () => (await notes(s1.id)).some(n => n.kind === 'subscription_limit'));
    const lim = JSON.parse((await notes(s1.id)).find(n => n.kind === 'subscription_limit')!.text) as { display: string; subscription: Record<string, unknown> };
    expect(lim.display).toMatch(/^Лимит подписки Max личная исчерпан, сброс в \d\d:\d\d$/);
    expect(lim.subscription).toEqual({ kind: 'limit', subscriptionId: A.view.id, resetsAt: new Date(resetsAt).toISOString(), alternatives: [B.view.id] });
    const a = (await list()).subscriptions.find(x => x.id === A.view.id)!;
    expect(a).toMatchObject({ limitResetsAt: new Date(resetsAt).toISOString(), limitKind: 'five_hour' });
    // the note reaches the chat as HubEvent note.subscription
    const page = (await api('GET', `/api/sessions/${s1.id}/events`)).json() as { events: Array<Record<string, unknown>> };
    expect(page.events.find(e => e.subscription)).toMatchObject({ kind: 'note', text: lim.display, subscription: { kind: 'limit', subscriptionId: A.view.id } });
    // no generic «ошибка» note besides it
    expect((await notes(s1.id)).filter(n => n.kind === 'error')).toEqual([]);

    // auth_rejected of B: the mark and the note; A (limit) and C (rejected) are no alternatives
    const s2 = await created({ subscriptionId: B.view.id });
    result(s2.id, { isError: true, failure: { kind: 'auth_rejected', message: 'Failed to authenticate. API Error: 401' } });
    await waitFor(async () => (await notes(s2.id)).some(n => n.kind === 'subscription_auth'));
    const auth = JSON.parse((await notes(s2.id)).find(n => n.kind === 'subscription_auth')!.text) as { display: string; subscription: unknown };
    expect(auth.display).toBe('Подписка Pro рабочая: токен отклонён — выпустите новый `claude setup-token` и замените токен в настройках');
    expect(auth.subscription).toEqual({ kind: 'auth', subscriptionId: B.view.id, alternatives: [] });
    expect((await list()).subscriptions.find(x => x.id === B.view.id)!.tokenRejected).toBe(true);

    // account_unavailable: a plain note
    const s3 = await created({ subscriptionId: A.view.id });
    result(s3.id, { isError: true, failure: { kind: 'account_unavailable', message: 'billing' } });
    await waitFor(async () => (await notes(s3.id)).some(n => n.text.startsWith('Подписка Max личная недоступна')));

    // a turn of an agent 1.3 (no usage) is recorded with zeros
    const s4 = await created({ subscriptionId: A.view.id });
    agentSend(hp, 'session.result', { sessionId: s4.id, subtype: 'success', isError: false, durationMs: 1, costUsd: 0 });
    await waitFor(async () => (await turns(s4.id)).length === 1);
    expect(await turns(s4.id)).toEqual([{ subscription_id: A.view.id, is_error: false, failure: null, i: 0, o: 0 }]);
    // clean marks for the next test
    await t.tdb.pool.query(`UPDATE subscriptions SET token_rejected_at = NULL, limit_resets_at = NULL, limit_kind = NULL WHERE user_id = $1`, [userId]);
  });

  it('5.5 auto switch on three subscriptions: A → B → C with the message repeated, no third switch, the last choice unchanged', async () => {
    for (const x of [A, B, C]) await api('PATCH', `/api/subscriptions/${x.view.id}`, { autoSwitch: true });
    await api('PUT', '/api/subscriptions/order', { ids: [A.view.id, B.view.id, C.view.id] });
    await t.tdb.pool.query(`UPDATE users SET last_subscription_id = $1 WHERE id = $2`, [A.view.id, userId]);
    const prompt = `долгая задача ${randomUUID()}`;
    const s = await created({ prompt });
    const limit = (sub: string) => result(s.id, { isError: true, failure: { kind: 'subscription_limit', resetsAt: Date.now() + 3600_000 }, errorText: sub });
    limit('A');
    const r1 = await waitFor(() => cmds('session.resume', s.id).find(c => (c.payload.subscription as { id: string }).id === B.view.id), 10_000);
    expect(r1.payload).toMatchObject({ prompt, subscription: { id: B.view.id, token: B.token } });
    limit('B');
    const r2 = await waitFor(() => cmds('session.resume', s.id).find(c => (c.payload.subscription as { id: string }).id === C.view.id), 10_000);
    expect(r2.payload.prompt).toBe(prompt);
    limit('C');
    await waitFor(async () => (await notes(s.id)).some(n => n.kind === 'subscription_limit'), 10_000);
    const ns = await notes(s.id);
    expect(ns.filter(n => n.kind === 'subscription_switch').map(n => (JSON.parse(n.text) as { display: string }).display)).toEqual([
      'Автопереключение: Max личная → Pro рабочая',
      'Автопереключение: Pro рабочая → Team',
    ]);
    const lim = JSON.parse(ns.find(n => n.kind === 'subscription_limit')!.text) as { display: string; subscription: { subscriptionId: string; alternatives: string[] } };
    expect(lim.subscription).toMatchObject({ subscriptionId: C.view.id, alternatives: [] });
    expect(cmds('session.resume', s.id)).toHaveLength(2);
    expect((await list()).lastChoiceId).toBe(A.view.id);
    expect((await turns(s.id)).map(x => [x.subscription_id, x.failure])).toEqual([
      [A.view.id, 'subscription_limit'],
      [B.view.id, 'subscription_limit'],
      [C.view.id, 'subscription_limit'],
    ]);
    await t.tdb.pool.query(`UPDATE subscriptions SET limit_resets_at = NULL, limit_kind = NULL WHERE user_id = $1`, [userId]);
  });

  it('5.5 A → B → C, limits without resetsAt: the final note offers none of the subscriptions that failed in this turn', async () => {
    const s = await created({ subscriptionId: A.view.id });
    const limit = () => result(s.id, { isError: true, failure: { kind: 'subscription_limit' } });
    limit();
    await waitFor(() => cmds('session.resume', s.id).find(c => (c.payload.subscription as { id: string }).id === B.view.id), 10_000);
    limit();
    await waitFor(() => cmds('session.resume', s.id).find(c => (c.payload.subscription as { id: string }).id === C.view.id), 10_000);
    limit();
    await waitFor(async () => (await notes(s.id)).some(n => n.kind === 'subscription_limit'), 10_000);
    const lim = JSON.parse((await notes(s.id)).find(n => n.kind === 'subscription_limit')!.text) as { subscription: { subscriptionId: string; alternatives: string[] } };
    // no limit mark without resetsAt, so before the fix A and B came back as alternatives
    expect((await list()).subscriptions.filter(x => [A.view.id, B.view.id].includes(x.id)).map(x => x.limitResetsAt)).toEqual([null, null]);
    expect(lim.subscription).toEqual({ kind: 'limit', subscriptionId: C.view.id, alternatives: [] });
    expect(cmds('session.resume', s.id)).toHaveLength(2);
  });

  it('5.5 a subscription with a rejected token is skipped; without a known last message — the note, no switch', async () => {
    await t.tdb.pool.query(`UPDATE subscriptions SET token_rejected_at = now() WHERE id = $1`, [B.view.id]);
    const s = await created({ subscriptionId: A.view.id });
    result(s.id, { isError: true, failure: { kind: 'subscription_limit' } });
    const r = await waitFor(() => cmds('session.resume', s.id)[0], 10_000);
    expect((r.payload.subscription as { id: string }).id).toBe(C.view.id);
    await t.tdb.pool.query(`UPDATE subscriptions SET token_rejected_at = NULL, limit_resets_at = NULL WHERE user_id = $1`, [userId]);

    // a session the hub never got a message for (started outside the hub, resumed by «Продолжить»)
    const ext = (
      await t.tdb.pool.query(
        `INSERT INTO sessions (user_id, runner_id, claude_session_id, cwd, source, status, is_hub_managed, subscription_id, process_alive) VALUES ($1, 'hp', gen_random_uuid(), $2, 'hub', 'waiting', true, $3, true) RETURNING id, claude_session_id`,
        [userId, VAULT, A.view.id],
      )
    ).rows[0] as { id: string; claude_session_id: string };
    agentSend(hp, 'session.result', { sessionId: ext.claude_session_id, subtype: 'success', isError: true, durationMs: 1, costUsd: 0, failure: { kind: 'subscription_limit' } });
    await waitFor(async () => (await notes(ext.id)).some(n => n.kind === 'subscription_limit'));
    expect(cmds('session.resume', ext.claude_session_id)).toEqual([]);
    expect(cmds('session.stop', ext.claude_session_id)).toEqual([]);
    for (const x of [A, B, C]) await api('PATCH', `/api/subscriptions/${x.view.id}`, { autoSwitch: false });
  });

  it('5.6 usage: 3 turns under A and 2 under B after a switch; «Вход машины»; a retired one with its name; > 366 days → 422', async () => {
    const from = new Date().toISOString();
    const D = await add('Разовая');
    const s = await created({ subscriptionId: A.view.id });
    for (let i = 0; i < 3; i++) result(s.id);
    await waitFor(async () => (await turns(s.id)).length === 3);
    await waitStatus(s.id, 'waiting');
    expect((await api('POST', `/api/sessions/${s.id}/subscription`, { subscriptionId: B.view.id })).statusCode).toBe(202);
    for (let i = 0; i < 2; i++) result(s.id, { usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 1000, cacheCreationTokens: 70 } });
    const m = await created({ subscriptionId: null });
    result(m.id);
    const d = await created({ subscriptionId: D.view.id });
    result(d.id, { isError: true, failure: { kind: 'subscription_limit' } });
    await waitFor(async () => (await turns(s.id)).length === 5 && (await turns(m.id)).length === 1 && (await turns(d.id)).length === 1);
    await api('PATCH', `/api/subscriptions/${D.view.id}`, { retired: true });
    const u = (await api('GET', `/api/subscriptions/usage?from=${encodeURIComponent(from)}&to=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`)).json() as SubscriptionUsageResponse;
    expect(u.rows).toEqual([
      { subscriptionId: A.view.id, name: 'Max личная', turns: 3, inputTokens: 30, outputTokens: 6, cacheReadTokens: 300, cacheCreationTokens: 21, limitHits: 0 },
      { subscriptionId: B.view.id, name: 'Pro рабочая', turns: 2, inputTokens: 200, outputTokens: 40, cacheReadTokens: 2000, cacheCreationTokens: 140, limitHits: 0 },
      { subscriptionId: D.view.id, name: 'Разовая', turns: 1, inputTokens: 10, outputTokens: 2, cacheReadTokens: 100, cacheCreationTokens: 7, limitHits: 1 },
      { subscriptionId: null, name: 'Вход машины', turns: 1, inputTokens: 10, outputTokens: 2, cacheReadTokens: 100, cacheCreationTokens: 7, limitHits: 0 },
    ]);
    const long = await api('GET', `/api/subscriptions/usage?from=2025-01-01T00:00:00Z&to=2026-10-01T00:00:00Z`);
    expect(long.statusCode).toBe(422);
    // the default period: the last 7 days
    const def = (await api('GET', '/api/subscriptions/usage')).json() as SubscriptionUsageResponse;
    expect(Date.parse(def.to) - Date.parse(def.from)).toBe(7 * 86_400_000);
  });

  it('5.2 handoff.generate runs under the default subscription of a 1.4 agent', async () => {
    await t.tdb.pool.query(`UPDATE users SET last_subscription_id = $1 WHERE id = $2`, [B.view.id, userId]);
    await t.tdb.pool.query(`UPDATE runners SET is_utility = (id = 'hp')`);
    const sid = randomUUID();
    const rel = `C--Users-alice-vault/${sid}.jsonl`;
    const o = { sessionId: sid, cwd: VAULT, entrypoint: 'cli' as const };
    const n = acks.length;
    agentSend(hp, 'repl.chunk', {
      relPath: rel,
      kind: 'main',
      sessionId: sid,
      generation: 0,
      fromLine: 0,
      fromByte: 0,
      lines: [F.userText(o, 'цель'), F.assistantText(o, 'ок')].map(l => JSON.stringify(l)),
      endByte: 200,
    });
    await waitFor(() => acks.length > n, 20_000);
    const src = (await t.tdb.pool.query<{ id: string }>(`SELECT id FROM sessions WHERE claude_session_id = $1`, [sid])).rows[0]!.id;
    const mark = got.length;
    expect((await api('POST', `/api/sessions/${src}/handoff-drafts`)).statusCode).toBe(202);
    await t.hub.handoff.flush();
    const gen = got.slice(mark).find(m => m.type === 'handoff.generate')!;
    expect(gen.runner).toBe('hp');
    expect(gen.payload.subscription).toEqual({ id: B.view.id, token: B.token });
  });

  /** A replicated session on HP with a user and an assistant line: a source for handoff drafts. */
  const handoffSource = async () => {
    const sid = randomUUID();
    const o = { sessionId: sid, cwd: VAULT, entrypoint: 'cli' as const };
    const n = acks.length;
    agentSend(hp, 'repl.chunk', {
      relPath: `C--Users-alice-vault/${sid}.jsonl`,
      kind: 'main',
      sessionId: sid,
      generation: 0,
      fromLine: 0,
      fromByte: 0,
      lines: [F.userText(o, 'цель'), F.assistantText(o, 'ок')].map(l => JSON.stringify(l)),
      endByte: 200,
    });
    await waitFor(() => acks.length > n, 20_000);
    return (await t.tdb.pool.query<{ id: string }>(`SELECT id FROM sessions WHERE claude_session_id = $1`, [sid])).rows[0]!.id;
  };
  const draft = async (src: string, body?: Record<string, unknown>) => {
    const mark = got.length;
    const r = await api('POST', `/api/sessions/${src}/handoff-drafts`, body);
    expect(r.statusCode, r.body).toBe(202);
    await t.hub.handoff.flush();
    const row = (await api('GET', `/api/handoff-drafts/${(r.json() as { id: string }).id}`)).json() as { status: string; text: string | null; error: string | null };
    return {
      row,
      gen: got
        .slice(mark)
        .filter(m => m.type === 'handoff.generate')
        .map(m => (m.payload.subscription as { id: string } | undefined)?.id),
    };
  };

  it('QA B1 handoff: a limited default is skipped for the first usable one; the form choice is used as is; a limit or a rejected token says why and marks the subscription', async () => {
    await t.tdb.pool.query(`UPDATE subscriptions SET token_rejected_at = NULL, limit_resets_at = NULL, limit_kind = NULL WHERE user_id = $1`, [userId]);
    await api('PUT', '/api/subscriptions/order', { ids: [A.view.id, B.view.id, C.view.id] });
    await t.tdb.pool.query(`UPDATE users SET last_subscription_id = $1 WHERE id = $2`, [B.view.id, userId]);
    await t.tdb.pool.query(`UPDATE runners SET is_utility = (id = 'hp')`);
    const src = await handoffSource();
    // the default B has an active limit: the first usable one by position (A)
    await t.tdb.pool.query(`UPDATE subscriptions SET limit_resets_at = now() + interval '2 hours' WHERE id = $1`, [B.view.id]);
    let d = await draft(src);
    expect(d.row).toMatchObject({ status: 'ready', text: 'черновик' });
    expect(d.gen).toEqual([A.view.id]);
    // the form's choice: that one, even with a limit
    d = await draft(src, { subscriptionId: B.view.id });
    expect(d.gen).toEqual([B.view.id]);
    // the form's «вход машины»: no subscription
    d = await draft(src, { subscriptionId: null });
    expect(d.gen).toEqual([undefined]);

    // a limit the agent reports: the text with the reset, the mark on the subscription
    await t.tdb.pool.query(`UPDATE subscriptions SET limit_resets_at = NULL WHERE user_id = $1`, [userId]);
    const resetsAt = Date.now() + 3 * 3600_000;
    handoffFails.push({ kind: 'subscription_limit', resetsAt, limitType: 'five_hour', message: "You've hit your session limit" });
    d = await draft(src);
    expect(d.gen).toEqual([B.view.id]);
    expect(d.row.status).toBe('error');
    expect(d.row.error).toMatch(/^Не удалось сгенерировать промпт: лимит подписки Pro рабочая до \d\d:\d\d — выберите другую подписку и повторите$/);
    expect((await list()).subscriptions.find(x => x.id === B.view.id)).toMatchObject({ limitResetsAt: new Date(resetsAt).toISOString(), limitKind: 'five_hour' });
    // the next draft without a choice goes under A (B is limited now)
    d = await draft(src);
    expect(d.gen).toEqual([A.view.id]);

    // a rejected token: the text and the mark
    handoffFails.push({ kind: 'auth_rejected', message: 'Failed to authenticate. API Error: 401' });
    d = await draft(src, { subscriptionId: C.view.id });
    expect(d.row.error).toBe('Не удалось сгенерировать промпт: токен подписки Team отклонён — замените токен');
    expect((await list()).subscriptions.find(x => x.id === C.view.id)!.tokenRejected).toBe(true);
    await t.tdb.pool.query(`UPDATE subscriptions SET token_rejected_at = NULL, limit_resets_at = NULL, limit_kind = NULL WHERE user_id = $1`, [userId]);
  });

  it('QA B2 the QA sequence: garbage token → 401 → the process stops; good token → a message to the same session resumes with it and succeeds, no new mark', async () => {
    const bad = `sk-ant-oat01-${randomBytes(30).toString('hex')}BAD1`;
    const E = await add('Мусорная', bad);
    const s = await created({ subscriptionId: E.view.id });
    const stops = cmds('session.stop', s.id).length;
    result(s.id, { isError: true, failure: { kind: 'auth_rejected', message: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.' } });
    await waitFor(async () => (await notes(s.id)).some(n => n.kind === 'subscription_auth'));
    expect((await list()).subscriptions.find(x => x.id === E.view.id)!.tokenRejected).toBe(true);
    // the process with the bad token is stopped: the next message cannot reach it
    await waitFor(() => cmds('session.stop', s.id).length > stops);
    await waitStatus(s.id, 'sleeping');

    const good = tok('G00D');
    tokens.push(good);
    expect((await api('PUT', `/api/subscriptions/${E.view.id}/token`, { token: good })).json()).toMatchObject({ tokenRejected: false });
    expect((await api('POST', `/api/sessions/${s.id}/messages`, { text: 'ещё раз', clientUuid: randomUUID() })).statusCode).toBe(202);
    const resume = await waitFor(() => lastCmd('session.resume', s.id));
    expect(resume.subscription).toEqual({ id: E.view.id, token: good });
    result(s.id);
    await waitFor(async () => (await turns(s.id)).length === 2);
    expect((await list()).subscriptions.find(x => x.id === E.view.id)!.tokenRejected).toBe(false);
    expect((await notes(s.id)).filter(n => n.kind === 'subscription_auth')).toHaveLength(1);
  });

  it('QA B2 a 401 of a process launched with a since replaced token does not mark the new token; the process stops', async () => {
    const E = (await list()).subscriptions.find(x => x.name === 'Мусорная')!;
    const s = await created({ subscriptionId: E.id });
    result(s.id);
    await waitStatus(s.id, 'waiting');
    const newer = tok('N3W1');
    tokens.push(newer);
    await api('PUT', `/api/subscriptions/${E.id}/token`, { token: newer });
    const stops = cmds('session.stop', s.id).length;
    result(s.id, { isError: true, failure: { kind: 'auth_rejected', message: 'Failed to authenticate. API Error: 401' } });
    await waitFor(async () => (await notes(s.id)).some(n => n.kind === 'error' && n.text.includes('отклонён прежний токен')));
    expect((await notes(s.id)).filter(n => n.kind === 'subscription_auth')).toEqual([]);
    expect((await list()).subscriptions.find(x => x.id === E.id)!.tokenRejected).toBe(false);
    await waitFor(() => cmds('session.stop', s.id).length > stops);
  });

  it('QA B2 a waiting process with a replaced token restarts with the new one before the next message; a success of an older process clears no mark', async () => {
    const E = (await list()).subscriptions.find(x => x.name === 'Мусорная')!;
    await t.tdb.pool.query(`UPDATE users SET last_subscription_id = $1 WHERE id = $2`, [E.id, userId]);
    const s = await created({ subscriptionId: E.id });
    result(s.id);
    await waitStatus(s.id, 'waiting');
    const v2 = tok('V2V2');
    tokens.push(v2);
    await api('PUT', `/api/subscriptions/${E.id}/token`, { token: v2 });
    const mark = got.length;
    expect((await api('POST', `/api/sessions/${s.id}/messages`, { text: 'дальше', clientUuid: randomUUID() })).statusCode).toBe(202);
    await waitFor(() => got.slice(mark).find(m => m.type === 'session.resume' && m.payload.sessionId === s.id));
    expect(
      got
        .slice(mark)
        .filter(m => m.payload.sessionId === s.id)
        .map(m => m.type),
    ).toEqual(['session.stop', 'session.resume']);
    expect(lastCmd('session.resume', s.id)!.subscription).toEqual({ id: E.id, token: v2 });

    // a process launched with v2 succeeds after v3 came and v3 got rejected: the mark of v3 stays
    result(s.id);
    await waitStatus(s.id, 'waiting');
    const v3 = tok('V3V3');
    tokens.push(v3);
    await api('PUT', `/api/subscriptions/${E.id}/token`, { token: v3 });
    await t.tdb.pool.query(`UPDATE subscriptions SET token_rejected_at = now() WHERE id = $1`, [E.id]);
    const n = (await turns(s.id)).length;
    result(s.id);
    await waitFor(async () => (await turns(s.id)).length === n + 1);
    expect((await list()).subscriptions.find(x => x.id === E.id)!.tokenRejected).toBe(true);
    await api('PATCH', `/api/subscriptions/${E.id}`, { retired: true });
  });

  it('QA obs 2 a waiting session with background work («работает в фоне») is busy for a switch: 409 turn_in_progress; with interrupt — stop and resume', async () => {
    const s = await created({ subscriptionId: A.view.id });
    result(s.id);
    await waitStatus(s.id, 'waiting');
    await t.tdb.pool.query(`INSERT INTO background_tasks (session_id, tool_use_id, task_id, state, started_at) VALUES ($1, 'toolu_bg', 'bg1', 'running', now())`, [s.id]);
    expect((await getS(s.id)).subagents?.working).toBe(1);
    const busy = await api('POST', `/api/sessions/${s.id}/subscription`, { subscriptionId: B.view.id });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toMatchObject({ error: 'turn_in_progress' });
    expect(cmds('session.stop', s.id)).toEqual([]);
    const r = await api('POST', `/api/sessions/${s.id}/subscription`, { subscriptionId: B.view.id, interrupt: true });
    expect(r.statusCode, r.body).toBe(202);
    expect(cmds('session.stop', s.id)).toHaveLength(1);
    expect(lastCmd('session.resume', s.id)!.subscription).toEqual({ id: B.view.id, token: B.token });
  });

  it('5.1 no answer, no WS message to a browser and no line of the hub log carried a token (only tokenHint)', async () => {
    await waitFor(() => ui.received.length > 0);
    const all = [...seen, ...ui.received.map(m => JSON.stringify(m)), ...ui2.received.map(m => JSON.stringify(m)), ...logs].join('\n');
    expect(tokens.length).toBeGreaterThan(5);
    // the log was written (requests, launches), it just has no token in it
    expect(logs.length).toBeGreaterThan(10);
    for (const x of tokens) {
      expect(all).not.toContain(x);
      expect(all).not.toContain(x.slice(-12));
    }
    expect(all).toContain('"tokenHint":"AAAA"');
  });
});

describe('subscriptions without SUBSCRIPTION_TOKEN_KEY', () => {
  let t: TestHub;
  let cookie: string;
  beforeAll(async () => {
    t = await startTestHub({ sessions: { idleCheckMs: 0 } });
    cookie = await t.login();
  }, 240_000);
  afterAll(async () => t.close());

  it('the registry answers enabled: false; adding and replacing a token → 503 subscriptions_disabled', async () => {
    const api = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
      t.hub.app.inject({ method, url, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, ...(payload ? { payload } : {}) });
    expect((await api('GET', '/api/subscriptions')).json()).toEqual({
      enabled: false,
      subscriptions: [],
      lastChoiceId: null,
      defaultId: null,
      byProvider: { claude: { lastChoiceId: null, defaultId: null }, codex: { lastChoiceId: null, defaultId: null } },
      connectorsHint: true,
    });
    const r = await api('POST', '/api/subscriptions', { name: 'X', token: tok('zzzz') });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: 'subscriptions_disabled', message: 'Хранение токенов не настроено: задайте SUBSCRIPTION_TOKEN_KEY' });
    expect((await api('PUT', `/api/subscriptions/${randomUUID()}/token`, { token: tok('zzzz') })).statusCode).toBe(503);
    // a cross-site request is refused before anything
    expect(
      (await t.hub.app.inject({ method: 'POST', url: '/api/subscriptions', cookies: { ah_session: cookie }, headers: { origin: 'https://evil.example' }, payload: { name: 'X', token: tok('zzzz') } }))
        .statusCode,
    ).toBe(403);
  });
});
