// subscription-limits tasks 5.2–5.5, 5.7 against a real hub, Postgres and scripted agents of 1.6 (HP, X1, ВМ —
// hostname ip-10-0-0-3) and of 1.5. The tests of a describe share the hub and run in order. Fixtures of
// rate_limit_event — design «Итоги спайка» (agent/src/limits/fixtures), already parsed as the agent sends them.
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  envelope,
  subscriptionLimitsResponseSchema,
  type LimitsProbeResult,
  type LimitsSnapshot,
  type SessionView,
  type SubscriptionLimitsResponse,
  type SubscriptionLimitsView,
  type SubscriptionUsageResponse,
  type SubscriptionView,
  type SubscriptionsResponse,
} from '@agent-hub/shared';
import { PUBLIC_URL, agentSend, connectFakeAgent, connectUi, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';

const VAULT = 'C:\\Users\\alice\\vault';
const KEY = randomBytes(32).toString('base64');
const tok = (tail: string) => `sk-ant-oat01-${randomBytes(30).toString('hex')}${tail}`;
const sec = (s: number) => new Date(s * 1000).toISOString();
/** The seven_day reset of the rejected window: always ahead (a fixed epoch from the spike went stale on 2026-10-29). */
const RESET_7D = Math.floor(Date.now() / 1000) + 2 * 86_400;

/** Spike p. 3, setup-token, 429: five_hour 92% allowed_warning, seven_day 100% rejected (as parsed by the agent). */
const REJECTED: LimitsSnapshot = {
  windows: [
    { type: 'five_hour', utilization: 92, resetsAt: sec(1793121000), status: 'allowed_warning', surpassedThreshold: 90 },
    { type: 'seven_day', utilization: 100, resetsAt: sec(RESET_7D), status: 'rejected', surpassedThreshold: 100 },
  ],
  overage: { status: 'rejected', inUse: false, enabled: null, disabledReason: 'out_of_credits' },
};
/** Spike p. 3, interactive login: five_hour 11%, seven_day 34%. */
const ALLOWED: LimitsSnapshot = {
  windows: [
    { type: 'five_hour', utilization: 11, resetsAt: sec(1793124000), status: 'allowed' },
    { type: 'seven_day', utilization: 34, resetsAt: sec(1793671200), status: 'allowed' },
  ],
  overage: { status: 'rejected', inUse: false, enabled: true, disabledReason: 'out_of_credits' },
};
const result = (o: Partial<LimitsProbeResult>): LimitsProbeResult => ({ outcome: 'ok', snapshot: null, resetsAt: null, limitType: null, message: null, durationMs: 900, ...o });

interface Cmd {
  type: string;
  id?: string;
  payload: Record<string, unknown>;
  runner: string;
}
type Answer = { result?: unknown } | { error: { code: string; message: string } } | 'hang';

describe('subscription limits (integration)', () => {
  let t: TestHub;
  let cookie: string;
  let ui: ReturnType<typeof connectUi>;
  /** The limits clock: real time plus a shift the tests move forward. */
  let shift = 0;
  const now = () => new Date(Date.now() + shift);
  const got: Cmd[] = [];
  const seen: string[] = [];
  const logs: string[] = [];
  const tokens: string[] = [];
  const agents = new Map<string, FakeAgent>();
  /** What the next limits.probe gets, by subscription id, else by runner (else no_event). */
  const probeAnswers = new Map<string, Answer[]>();

  const api = async (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown, headers: Record<string, string> = { origin: PUBLIC_URL }) => {
    const r = await t.hub.app.inject({ method, url, cookies: { ah_session: cookie }, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
    seen.push(r.body);
    return r;
  };
  const limits = async () => {
    const r = await api('GET', '/api/subscriptions/limits');
    expect(r.statusCode, r.body).toBe(200);
    return subscriptionLimitsResponseSchema.parse(r.json()) as SubscriptionLimitsResponse;
  };
  const lim = async (id: string) => (await limits()).limits.find(l => l.subscriptionId === id) as SubscriptionLimitsView;
  const add = async (name: string, token = tok(randomBytes(2).toString('hex'))) => {
    tokens.push(token);
    const r = await api('POST', '/api/subscriptions', { name, token });
    expect(r.statusCode, r.body).toBe(201);
    return { view: r.json() as SubscriptionView, token };
  };
  const probes = () => got.filter(m => m.type === 'limits.probe');
  const answer = (runner: string, ...a: Answer[]) => probeAnswers.set(runner, [...(probeAnswers.get(runner) ?? []), ...a]);
  const row = async (id: string) => (await t.tdb.pool.query(`SELECT * FROM subscription_limits WHERE subscription_id = $1`, [id])).rows[0] as Record<string, unknown> | undefined;
  const changes = () => ui.received.filter(m => m.type === 'subscription_limits.changed').length;
  const tick = async () => {
    await t.hub.limits.tick();
    await t.hub.limits.flush();
  };

  function agent(runner: string, token: string, protocol: string, hostname: string) {
    const a = connectFakeAgent(t.wsBase, token, { protocol, hostname, ...(runner === 'vm' ? { homeDir: '/home/ubuntu', os: 'Ubuntu', vaultRoot: '/home/ubuntu/vault' } : {}) });
    a.ws.on('message', d => {
      const m = JSON.parse(d.toString()) as Cmd;
      if (!m.id) return;
      got.push({ ...m, runner });
      const reply = (a2: Answer) => {
        if (a2 === 'hang') return;
        if ('error' in a2) a.ws.send(JSON.stringify(envelope('cmd.error', a2.error, { re: m.id! })));
        else a.ws.send(JSON.stringify(envelope('cmd.ok', a2.result === undefined ? {} : { result: a2.result }, { re: m.id! })));
      };
      if (m.type === 'fs.stat') return reply({ result: { exists: true, isDir: true } });
      if (m.type === 'session.start' || m.type === 'session.resume') return reply({ result: { models: [] } });
      if (m.type === 'limits.probe') {
        const subId = (m.payload.subscription as { id: string }).id;
        return reply(probeAnswers.get(subId)?.shift() ?? probeAnswers.get(runner)?.shift() ?? { result: result({ outcome: 'no_event' }) });
      }
      reply({ result: {} });
    });
    agents.set(runner, a);
    return a;
  }

  beforeAll(async () => {
    t = await startTestHub({
      env: { SUBSCRIPTION_TOKEN_KEY: KEY, LIMITS_PROBE_LAST_HOSTS: 'ip-10-0-0-3' },
      logStream: { write: l => void logs.push(l) },
      sessions: { idleCheckMs: 0, initTimeoutMs: 3000 },
      limitsProbe: { now, timeoutMs: 5000 },
    });
    const tokensOf: Record<string, string> = {};
    for (const [id, name] of [
      ['hp', 'HP'],
      ['x1', 'X1'],
      ['vm', 'ВМ'],
      ['old', 'Старый'],
    ] as const)
      tokensOf[id] = await t.addRunner(id, name);
    cookie = await t.login();
    ui = connectUi(t.wsBase, cookie);
    await ui.open;
    // the VM is answered first by name order (ВМ < … in no locale) — it must still come last: hostname ip-10-0-0-3
    agent('vm', tokensOf.vm!, '1.6', 'ip-10-0-0-3');
    agent('hp', tokensOf.hp!, '1.6', 'HP-Elitebook');
    agent('x1', tokensOf.x1!, '1.6', 'X1-Carbon');
    for (const a of agents.values()) await a.next('welcome');
  }, 240_000);
  afterAll(async () => {
    ui.ws.close();
    await t.close();
  });

  let A: { view: SubscriptionView; token: string };
  let B: { view: SubscriptionView; token: string };

  it('5.5 GET: no subscriptions → []; new ones → unavailable not_polled in registry order; serverTime', async () => {
    expect((await limits()).limits).toEqual([]);
    A = await add('Max личная', tok('AAAA'));
    B = await add('Pro рабочая', tok('BBBB'));
    const l = await limits();
    expect(l.limits.map(x => [x.subscriptionId, x.state, x.reason])).toEqual([
      [A.view.id, 'unavailable', 'not_polled'],
      [B.view.id, 'unavailable', 'not_polled'],
    ]);
    expect(Math.abs(Date.parse(l.serverTime) - now().getTime())).toBeLessThan(5000);
  });

  it('5.2/5.3 a tick probes both on HP (by name, the VM last): ok → snapshot, no_event → quiet; the token and haiku in the command; owner notified', async () => {
    const before = changes();
    answer(A.view.id, { result: result({ outcome: 'ok', snapshot: ALLOWED }) });
    answer(B.view.id, { result: result({ outcome: 'no_event' }) });
    await tick();
    expect(probes().map(p => p.runner)).toEqual(['hp', 'hp']);
    const pA = probes().find(p => (p.payload.subscription as { id: string }).id === A.view.id)!;
    expect(pA.payload).toEqual({ subscription: { id: A.view.id, token: A.token }, model: 'haiku' });
    const a = await lim(A.view.id);
    expect(a).toMatchObject({ state: 'ok', reason: null, quietAt: null, overage: { status: 'rejected', inUse: false, enabled: true } });
    expect(a.windows.map(w => [w.type, w.utilization, w.status, w.source])).toEqual([
      ['five_hour', 11, 'allowed', 'probe'],
      ['seven_day', 34, 'allowed', 'probe'],
    ]);
    expect(a.windows[0]!.resetsAt).toBe(sec(1793124000));
    expect(a.lastProbeAt).not.toBeNull();
    // spec «Проверена без событий»: ok, no windows, quietAt
    const b = await lim(B.view.id);
    expect(b).toMatchObject({ state: 'ok', windows: [], lastOkAt: null });
    expect(b.quietAt).not.toBeNull();
    await waitFor(() => changes() >= before + 2);
  });

  it('5.2 fresh data: the next tick sends nothing', async () => {
    const n = probes().length;
    await tick();
    expect(probes().length).toBe(n);
  });

  let sA: SessionView;

  it('5.4 limits.event of a session under A on X1: windows updated (source session), the owner notified; an older event changes nothing; quiet sets quietAt', async () => {
    const r = await api('POST', '/api/sessions', { runnerId: 'x1', cwd: VAULT, model: 'haiku', prompt: `привет ${randomUUID()}`, subscriptionId: A.view.id });
    expect(r.statusCode, r.body).toBe(201);
    sA = r.json() as SessionView;
    await waitFor(() => got.find(m => m.type === 'session.start' && m.payload.sessionId === sA.id));
    const before = changes();
    const at = now().getTime();
    agentSend(agents.get('x1')!, 'limits.event', {
      sessionId: sA.id,
      snapshot: {
        windows: [
          { type: 'five_hour', utilization: 11, resetsAt: sec(1793124000), status: 'allowed' },
          { type: 'seven_day', utilization: 86, resetsAt: sec(1793671200), status: 'allowed_warning' },
        ],
        overage: null,
      },
      quiet: false,
      observedAt: at - shift, // the agent's clock is real time
    });
    await waitFor(async () => (await lim(A.view.id)).windows.find(w => w.type === 'seven_day')?.utilization === 86);
    const a = await lim(A.view.id);
    expect(a.windows.map(w => [w.type, w.utilization, w.status, w.source])).toEqual([
      ['five_hour', 11, 'allowed', 'session'],
      ['seven_day', 86, 'allowed_warning', 'session'],
    ]);
    await waitFor(() => changes() > before);
    // an event observed before the stored windows: nothing changes
    agentSend(agents.get('x1')!, 'limits.event', {
      sessionId: sA.id,
      snapshot: { windows: [{ type: 'seven_day', utilization: 5, resetsAt: null, status: 'allowed' }], overage: null },
      quiet: false,
      observedAt: at - shift - 60_000,
    });
    agentSend(agents.get('x1')!, 'limits.event', { sessionId: sA.id, snapshot: null, quiet: true, observedAt: at - shift + 1000 });
    await waitFor(async () => (await lim(A.view.id)).quietAt !== null);
    const a2 = await lim(A.view.id);
    expect(a2.windows.find(w => w.type === 'seven_day')!.utilization).toBe(86);
    expect(a2.windows.length).toBe(2);
  });

  it('5.4 an event of a session under the machine login is dropped', async () => {
    const r = await api('POST', '/api/sessions', { runnerId: 'hp', cwd: VAULT, model: 'haiku', prompt: 'x', subscriptionId: null });
    const s = r.json() as SessionView;
    await waitFor(() => got.find(m => m.type === 'session.start' && m.payload.sessionId === s.id));
    const before = await t.tdb.pool.query(`SELECT subscription_id, updated_at FROM subscription_limits ORDER BY subscription_id`);
    agentSend(agents.get('hp')!, 'limits.event', { sessionId: s.id, snapshot: REJECTED, quiet: false, observedAt: Date.now() });
    await new Promise(r2 => setTimeout(r2, 300));
    expect((await t.tdb.pool.query(`SELECT subscription_id, updated_at FROM subscription_limits ORDER BY subscription_id`)).rows).toEqual(before.rows);
  });

  it('5.2 31 min later: A kept fresh by its live session is skipped, B (quiet 31 min ago) is probed', async () => {
    shift += 31 * 60_000;
    agentSend(agents.get('x1')!, 'limits.event', {
      sessionId: sA.id,
      snapshot: { windows: [{ type: 'five_hour', utilization: 12, resetsAt: sec(1793124000), status: 'allowed' }], overage: null },
      quiet: false,
      observedAt: now().getTime() - shift,
    });
    // the hub's clock offset to the agent is ~0: the event lands at real time, i.e. 31 min «ago» — shift the agent clock too
    await waitFor(async () => (await lim(A.view.id)).windows.find(w => w.type === 'five_hour')?.utilization === 12);
    await t.tdb.pool.query(`UPDATE subscription_limits SET last_ok_at = $2 WHERE subscription_id = $1`, [A.view.id, now()]);
    const n = probes().length;
    await tick();
    expect(
      probes()
        .slice(n)
        .map(p => (p.payload.subscription as { id: string }).id),
    ).toEqual([B.view.id]);
  });

  it('5.2 a due subscription with a live session is probed on that machine (X1), not HP', async () => {
    shift += 31 * 60_000;
    const n = probes().length;
    await tick();
    const pa = probes()
      .slice(n)
      .find(p => (p.payload.subscription as { id: string }).id === A.view.id)!;
    expect(pa.runner).toBe('x1');
  });

  it('5.3 limit → snapshot from the answer, limit_resets_at, no chat note, token not rejected; exhausted — no probes until the reset, then queued', async () => {
    shift += 31 * 60_000;
    const notesBefore = Number((await t.tdb.pool.query(`SELECT count(*) AS n FROM session_notes`)).rows[0].n);
    // B is probed on HP (no sessions); A on X1
    answer('hp', { result: result({ outcome: 'limit', snapshot: REJECTED, resetsAt: sec(RESET_7D), limitType: 'seven_day', message: "You've hit your weekly limit" }) });
    await tick();
    const b = await lim(B.view.id);
    expect(b.windows.map(w => [w.type, w.utilization, w.status])).toEqual([
      ['five_hour', 92, 'allowed_warning'],
      ['seven_day', 100, 'rejected'],
    ]);
    const subs = (await api('GET', '/api/subscriptions')).json() as SubscriptionsResponse;
    expect(subs.subscriptions.find(s => s.id === B.view.id)).toMatchObject({ limitResetsAt: sec(RESET_7D), limitKind: 'seven_day', tokenRejected: false });
    expect(Number((await t.tdb.pool.query(`SELECT count(*) AS n FROM session_notes`)).rows[0].n)).toBe(notesBefore);
    // 31 min later: B is exhausted (seven_day rejected until RESET_7D) — no probe of B
    shift += 31 * 60_000;
    let n = probes().length;
    await tick();
    expect(
      probes()
        .slice(n)
        .map(p => (p.payload.subscription as { id: string }).id),
    ).not.toContain(B.view.id);
    // after the reset B is queued again
    shift = RESET_7D * 1000 - Date.now() + 60_000;
    n = probes().length;
    await tick();
    expect(
      probes()
        .slice(n)
        .map(p => (p.payload.subscription as { id: string }).id),
    ).toContain(B.view.id);
  });

  it('5.3 failures: probe_failed and account_unavailable count up, a backoff holds the next tick; success resets the counter', async () => {
    shift += 3 * 60 * 60_000;
    // only B is due at once: A gets an event now
    await t.tdb.pool.query(`UPDATE subscription_limits SET last_ok_at = $2 WHERE subscription_id = $1`, [A.view.id, now()]);
    answer('hp', { error: { code: 'probe_failed', message: 'model haiku-x not found' } });
    await tick();
    expect(await row(B.view.id)).toMatchObject({ probe_outcome: 'failed', probe_error: 'probe_failed', probe_failures: 1 });
    // within the backoff (30 min) nothing is sent even though the data is old
    await t.tdb.pool.query(`UPDATE subscription_limits SET last_ok_at = NULL, last_quiet_at = NULL WHERE subscription_id = $1`, [B.view.id]);
    shift += 10 * 60_000;
    await t.tdb.pool.query(`UPDATE subscription_limits SET last_ok_at = $2 WHERE subscription_id = $1`, [A.view.id, now()]);
    const n = probes().length;
    await tick();
    expect(probes().length).toBe(n);
    expect(await lim(B.view.id)).toMatchObject({ state: 'unavailable', reason: 'probe_failed' });
    shift += 21 * 60_000;
    await t.tdb.pool.query(`UPDATE subscription_limits SET last_ok_at = $2 WHERE subscription_id = $1`, [A.view.id, now()]);
    answer('hp', { result: result({ outcome: 'account_unavailable', message: 'Credit balance too low' }) });
    await tick();
    expect(await row(B.view.id)).toMatchObject({ probe_outcome: 'account_unavailable', probe_error: 'Credit balance too low', probe_failures: 2 });
    expect((await api('GET', '/api/subscriptions')).json().subscriptions.find((s: SubscriptionView) => s.id === B.view.id).tokenRejected).toBe(false);
    shift += 61 * 60_000;
    await t.tdb.pool.query(`UPDATE subscription_limits SET last_ok_at = $2 WHERE subscription_id = $1`, [A.view.id, now()]);
    await tick();
    expect(await row(B.view.id)).toMatchObject({ probe_outcome: 'no_event', probe_failures: 0 });
  });

  it('5.2 a timeout on HP → one retry on the next machine (X1), not a third one', async () => {
    shift += 31 * 60_000;
    await t.tdb.pool.query(`UPDATE subscription_limits SET last_ok_at = $2 WHERE subscription_id = $1`, [A.view.id, now()]);
    answer('hp', 'hang');
    answer('x1', { result: result({ outcome: 'ok', snapshot: ALLOWED }) });
    const n = probes().length;
    await tick();
    expect(
      probes()
        .slice(n)
        .map(p => p.runner),
    ).toEqual(['hp', 'x1']);
    expect(await row(B.view.id)).toMatchObject({ probe_outcome: 'ok', probe_failures: 0 });
  }, 30_000);

  it('5.3 a probe never shows as a session, a turn or usage', async () => {
    const sessions = Number((await t.tdb.pool.query(`SELECT count(*) AS n FROM sessions`)).rows[0].n);
    const turns = Number((await t.tdb.pool.query(`SELECT count(*) AS n FROM session_turns`)).rows[0].n);
    const usage = (await api('GET', '/api/subscriptions/usage')).json() as SubscriptionUsageResponse;
    shift += 31 * 60_000;
    await t.tdb.pool.query(`UPDATE subscription_limits SET last_ok_at = NULL, last_quiet_at = NULL`);
    const n = probes().length;
    await tick();
    expect(probes().length).toBeGreaterThan(n);
    expect(Number((await t.tdb.pool.query(`SELECT count(*) AS n FROM sessions`)).rows[0].n)).toBe(sessions);
    expect(Number((await t.tdb.pool.query(`SELECT count(*) AS n FROM session_turns`)).rows[0].n)).toBe(turns);
    expect(((await api('GET', '/api/subscriptions/usage')).json() as SubscriptionUsageResponse).rows).toEqual(usage.rows);
  });

  it('5.5 refresh: 202 with the view, the probe runs; a second one within 30 s → 429 refresh_too_soon + Retry-After; also for an exhausted subscription', async () => {
    await t.tdb.pool.query(`UPDATE subscriptions SET limit_resets_at = $2 WHERE id = $1`, [B.view.id, new Date(now().getTime() + 3600_000)]);
    const n = probes().length;
    answer('hp', { result: result({ outcome: 'limit', snapshot: REJECTED, resetsAt: sec(RESET_7D), limitType: 'seven_day' }) });
    const r = await api('POST', `/api/subscriptions/${B.view.id}/limits/refresh`);
    expect(r.statusCode, r.body).toBe(202);
    expect((r.json() as { limits: SubscriptionLimitsView }).limits.subscriptionId).toBe(B.view.id);
    expect((r.json() as { limits: SubscriptionLimitsView }).limits.refreshableAt).not.toBeNull();
    await t.hub.limits.flush();
    expect(probes().length).toBe(n + 1);
    const again = await api('POST', `/api/subscriptions/${B.view.id}/limits/refresh`);
    expect(again.statusCode).toBe(429);
    expect(again.json()).toMatchObject({ error: 'refresh_too_soon' });
    expect(Number(again.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(again.headers['retry-after'])).toBeLessThanOrEqual(30);
    expect(probes().length).toBe(n + 1);
    // 31 s later on the limits clock it is allowed again
    shift += 31_000;
    expect((await api('POST', `/api/subscriptions/${B.view.id}/limits/refresh`)).statusCode).toBe(202);
    await t.hub.limits.flush();
  });

  it('5.5 refresh errors: 404 unknown and foreign-looking ids, 403 without Origin, 409 token_rejected; auth_rejected of the current token marks it', async () => {
    expect((await api('POST', `/api/subscriptions/${randomUUID()}/limits/refresh`)).statusCode).toBe(404);
    expect((await api('POST', `/api/subscriptions/not-a-uuid/limits/refresh`)).statusCode).toBe(404);
    expect((await api('POST', `/api/subscriptions/${A.view.id}/limits/refresh`, undefined, {})).statusCode).toBe(403);
    // spec «Отклонённый токен»: 401 of the probe with the current token
    answer(A.view.id, { result: result({ outcome: 'auth_rejected', message: 'Invalid API key' }) });
    expect((await api('POST', `/api/subscriptions/${A.view.id}/limits/refresh`)).statusCode).toBe(202);
    await t.hub.limits.flush();
    expect(((await api('GET', '/api/subscriptions')).json() as SubscriptionsResponse).subscriptions.find(s => s.id === A.view.id)!.tokenRejected).toBe(true);
    expect(await lim(A.view.id)).toMatchObject({ state: 'unavailable', reason: 'token_rejected' });
    shift += 31_000;
    const r = await api('POST', `/api/subscriptions/${A.view.id}/limits/refresh`);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: 'token_rejected' });
    // a rejected token is never probed by the scheduler
    shift += 31 * 60_000;
    const n = probes().length;
    await tick();
    expect(
      probes()
        .slice(n)
        .map(p => (p.payload.subscription as { id: string }).id),
    ).not.toContain(A.view.id);
  });

  it('5.5 replacing the token deletes the snapshot (not_polled) and clears the rejection; a result of the replaced token is dropped', async () => {
    const before = changes();
    A.token = tok('AAA2');
    tokens.push(A.token);
    expect((await api('PUT', `/api/subscriptions/${A.view.id}/token`, { token: A.token })).statusCode).toBe(200);
    expect(await row(A.view.id)).toBeUndefined();
    expect(await lim(A.view.id)).toMatchObject({ state: 'unavailable', reason: 'not_polled', windows: [] });
    await waitFor(() => changes() > before);
    // a probe answered after another replacement: its 401 does not mark the new token, its windows are not stored
    answer('x1', 'hang');
    shift += 31_000;
    expect((await api('POST', `/api/subscriptions/${A.view.id}/limits/refresh`)).statusCode).toBe(202);
    const p = await waitFor(() => probes().find(m => (m.payload.subscription as { token: string }).token === A.token && m.runner === 'x1'));
    const newer = tok('AAA3');
    tokens.push(newer);
    await api('PUT', `/api/subscriptions/${A.view.id}/token`, { token: newer });
    agents.get('x1')!.ws.send(JSON.stringify(envelope('cmd.ok', { result: result({ outcome: 'auth_rejected' }) }, { re: p.id! })));
    await t.hub.limits.flush();
    expect(((await api('GET', '/api/subscriptions')).json() as SubscriptionsResponse).subscriptions.find(s => s.id === A.view.id)!.tokenRejected).toBe(false);
    A.token = newer;
  });

  it('5.5 retiring deletes the snapshot; refresh of a retired one → 409 subscription_retired; GET lists active ones only; bringing back → not_polled', async () => {
    shift += 31 * 60_000;
    await tick();
    expect(await row(B.view.id)).toBeDefined();
    await api('PATCH', `/api/subscriptions/${B.view.id}`, { retired: true });
    expect(await row(B.view.id)).toBeUndefined();
    expect((await limits()).limits.map(l => l.subscriptionId)).toEqual([A.view.id]);
    shift += 31_000;
    const r = await api('POST', `/api/subscriptions/${B.view.id}/limits/refresh`);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: 'subscription_retired' });
    await api('PATCH', `/api/subscriptions/${B.view.id}`, { retired: false });
    expect(await lim(B.view.id)).toMatchObject({ state: 'unavailable', reason: 'not_polled' });
  });

  it('5.7 only an agent of 1.5 online → no command, reason agent_outdated; refresh → 409 agent_outdated; no machine → no_runner, 409 runner_offline', async () => {
    for (const a of agents.values()) a.ws.close();
    await waitFor(() => !t.hub.agents.isOnline('hp') && !t.hub.agents.isOnline('x1') && !t.hub.agents.isOnline('vm'));
    // older than two probe periods: with no machine the reason is shown instead of «данные от»
    shift += 61 * 60_000;
    const n = got.length;
    await tick();
    expect(await lim(A.view.id)).toMatchObject({ state: 'unavailable', reason: 'no_runner' });
    shift += 31_000;
    expect((await api('POST', `/api/subscriptions/${A.view.id}/limits/refresh`)).json()).toMatchObject({ error: 'runner_offline' });
    const old = agent('old', await t.addRunner('old2', 'Старый 2'), '1.5', 'old-host');
    await old.next('welcome');
    await tick();
    expect(got.slice(n).filter(m => m.type === 'limits.probe')).toEqual([]);
    expect(await lim(A.view.id)).toMatchObject({ state: 'unavailable', reason: 'agent_outdated' });
    const r = await api('POST', `/api/subscriptions/${A.view.id}/limits/refresh`);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: 'agent_outdated' });
    old.ws.close();
  });

  it('the token is in no HTTP answer, UI message or hub log line', () => {
    expect(tokens.length).toBeGreaterThan(2);
    const all = [...seen, ...ui.received.map(m => JSON.stringify(m)), ...logs].join('\n');
    for (const tk of tokens) expect(all).not.toContain(tk);
    expect(logs.some(l => l.includes('limits probe done'))).toBe(true);
  });
});

describe('subscription limits: probes off, no token key', () => {
  it('LIMITS_PROBE_ENABLED=false: no probes, not_polled; refresh → 409 probes_disabled', async () => {
    const t = await startTestHub({ env: { SUBSCRIPTION_TOKEN_KEY: KEY, LIMITS_PROBE_ENABLED: 'false' }, sessions: { idleCheckMs: 0 } });
    try {
      const a = connectFakeAgent(t.wsBase, await t.addRunner('hp', 'HP'), { protocol: '1.6' });
      const cmds: string[] = [];
      a.ws.on('message', d => cmds.push((JSON.parse(d.toString()) as { type: string }).type));
      await a.next('welcome');
      const cookie = await t.login();
      const req = (method: 'GET' | 'POST', url: string, payload?: object) =>
        t.hub.app.inject({ method, url, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, ...(payload ? { payload } : {}) });
      const sub = (await req('POST', '/api/subscriptions', { name: 'A', token: tok('zzzz') })).json() as SubscriptionView;
      await t.hub.limits.tick();
      await t.hub.limits.flush();
      expect(cmds).not.toContain('limits.probe');
      expect((await req('GET', '/api/subscriptions/limits')).json().limits).toMatchObject([{ subscriptionId: sub.id, state: 'unavailable', reason: 'not_polled' }]);
      const r = await req('POST', `/api/subscriptions/${sub.id}/limits/refresh`);
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({ error: 'probes_disabled' });
      a.ws.close();
    } finally {
      await t.close();
    }
  }, 120_000);

  it('without SUBSCRIPTION_TOKEN_KEY: GET → limits []; refresh of an existing row → 503 subscriptions_disabled', async () => {
    const t = await startTestHub({ sessions: { idleCheckMs: 0 } });
    try {
      const cookie = await t.login();
      const req = (method: 'GET' | 'POST', url: string) => t.hub.app.inject({ method, url, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL } });
      const uid = (await req('GET', '/api/me')).json().user.id as string;
      const id = (await t.tdb.pool.query(`INSERT INTO subscriptions (user_id, name, token_enc, token_hint, position) VALUES ($1, 'A', decode('00', 'hex'), 'abcd', 0) RETURNING id`, [uid])).rows[0]
        .id as string;
      expect((await req('GET', '/api/subscriptions/limits')).json().limits).toEqual([]);
      const r = await req('POST', `/api/subscriptions/${id}/limits/refresh`);
      expect(r.statusCode).toBe(503);
      expect(r.json()).toMatchObject({ error: 'subscriptions_disabled' });
    } finally {
      await t.close();
    }
  }, 120_000);
});

describe('subscription limits: review B1, A1', () => {
  it('B1: ok with snapshot.windows [] is a quiet check (not not_polled); the second tick sends nothing. A1: a failure after the token was replaced is dropped', async () => {
    let shift = 0;
    const t = await startTestHub({ env: { SUBSCRIPTION_TOKEN_KEY: KEY }, sessions: { idleCheckMs: 0 }, limitsProbe: { now: () => new Date(Date.now() + shift) } });
    try {
      const a = connectFakeAgent(t.wsBase, await t.addRunner('hp', 'HP'), { protocol: '1.6', hostname: 'HP-Elitebook' });
      const cmds: { id: string; type: string; payload: Record<string, unknown> }[] = [];
      let mode: 'empty' | 'hold' = 'empty';
      a.ws.on('message', d => {
        const m = JSON.parse(d.toString()) as { id?: string; type: string; payload: Record<string, unknown> };
        if (!m.id) return;
        cmds.push(m as (typeof cmds)[number]);
        if (m.type !== 'limits.probe') return void a.ws.send(JSON.stringify(envelope('cmd.ok', {}, { re: m.id })));
        if (mode === 'empty') a.ws.send(JSON.stringify(envelope('cmd.ok', { result: result({ outcome: 'ok', snapshot: { windows: [], overage: null } }) }, { re: m.id })));
      });
      await a.next('welcome');
      const cookie = await t.login();
      const req = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
        t.hub.app.inject({ method, url, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, ...(payload ? { payload } : {}) });
      const sub = (await req('POST', '/api/subscriptions', { name: 'C', token: tok('cccc') })).json() as SubscriptionView;
      const probes = () => cmds.filter(m => m.type === 'limits.probe');
      const tick = async () => {
        await t.hub.limits.tick();
        await t.hub.limits.flush();
      };
      const lim = async () => ((await req('GET', '/api/subscriptions/limits')).json() as SubscriptionLimitsResponse).limits[0]!;
      await tick();
      expect(probes().length).toBe(1);
      const v = await lim();
      expect(v).toMatchObject({ state: 'ok', reason: null, windows: [] });
      expect(v.quietAt).not.toBeNull();
      // the scheduler's next passes (30 s, 50 s later) send no probe
      shift += 30_000;
      await tick();
      shift += 20_000;
      await tick();
      expect(probes().length).toBe(1);

      // A1: the probe of the old token fails after a replacement — the new token's row gets no failure
      mode = 'hold';
      expect((await req('POST', `/api/subscriptions/${sub.id}/limits/refresh`)).statusCode).toBe(202);
      const p = await waitFor(() => probes()[1]);
      expect((await req('PUT', `/api/subscriptions/${sub.id}/token`, { token: tok('ccc2') })).statusCode).toBe(200);
      a.ws.send(JSON.stringify(envelope('cmd.error', { code: 'probe_failed', message: 'boom' }, { re: p.id })));
      await t.hub.limits.flush();
      const row = (await t.tdb.pool.query(`SELECT probe_outcome, probe_failures FROM subscription_limits WHERE subscription_id = $1`, [sub.id])).rows[0];
      expect(row).toBeUndefined();
      expect(await lim()).toMatchObject({ state: 'unavailable', reason: 'not_polled' });
      a.ws.close();
    } finally {
      await t.close();
    }
  }, 120_000);
});
