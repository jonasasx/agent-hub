// claude-subscriptions task 7.2 (Requirement: Протокол хаб↔агент 1.4): 1.4 and 1.3 talk both ways. The 1.3 side is the
// verbatim schema snapshot of shared/src/snapshots/protocol-1.3.ts — what a hub or an agent of 1.3 parses with.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { envelope, parseAgentMessage, PROTOCOL_VERSION } from '@agent-hub/shared';
import * as v13 from '@agent-hub/shared/snapshots/protocol-1.3';
import * as v16 from '@agent-hub/shared/snapshots/protocol-1.6';
import { PUBLIC_URL, agentSend, autoReply, connectFakeAgent, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';

const VAULT = 'C:\\Users\\alice\\vault';

describe('protocol 1.4 ↔ 1.3 compatibility', () => {
  it('a 1.3 hub takes the session.result of a 1.4 agent: usage and failure dropped, the message valid; hello 1.4 is compatible', () => {
    const sessionId = randomUUID();
    const raw = JSON.stringify(
      envelope('session.result', {
        sessionId,
        subtype: 'success',
        isError: true,
        durationMs: 10,
        costUsd: 0,
        errorText: "You've hit your session limit",
        usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 },
        failure: { kind: 'subscription_limit', resetsAt: 1793264400000, limitType: 'five_hour' },
      }),
    );
    // the 1.4 hub keeps the fields
    const now = parseAgentMessage(raw);
    expect(now.ok && now.message.type === 'session.result' && now.message.payload.failure?.kind).toBe('subscription_limit');
    // the 1.3 hub: accepted, the new fields silently gone (z.object is not strict), the turn ends as before
    const old = v13.parseAgentMessage(raw);
    expect(old.ok).toBe(true);
    if (old.ok && old.message.type === 'session.result') {
      expect(old.message.payload).toEqual({ sessionId, subtype: 'success', isError: true, durationMs: 10, costUsd: 0, errorText: "You've hit your session limit" });
    } else throw new Error('not a session.result');
    expect(v13.isCompatibleProtocol(PROTOCOL_VERSION)).toBe(true);
    // a 1.3 agent takes the commands of a 1.4 hub even if one carried a subscription (the hub never sends it there)
    const start = JSON.stringify(
      envelope(
        'session.start',
        { sessionId, cwd: VAULT, permissionMode: 'default', model: 'haiku', prompt: 'hi', promptUuid: randomUUID(), subscription: { id: randomUUID(), token: 'x'.repeat(40) } },
        { id: randomUUID() },
      ),
    );
    const cmd = v13.parseHubMessage(start);
    expect(cmd.ok && cmd.message.type === 'session.start' && 'subscription' in cmd.message.payload).toBe(false);
  });

  describe('a 1.4 hub with agents of 1.3 and 1.4', () => {
    let t: TestHub;
    let cookie: string;
    let old: FakeAgent;
    const oldRaw: string[] = [];

    beforeAll(async () => {
      t = await startTestHub({ env: { SUBSCRIPTION_TOKEN_KEY: Buffer.alloc(32, 9).toString('base64') }, sessions: { idleCheckMs: 0 } });
      const token = await t.addRunner('hp', 'HP');
      cookie = await t.login();
      old = connectFakeAgent(t.wsBase, token, { protocol: '1.3' });
      old.ws.on('message', d => oldRaw.push(d.toString()));
      autoReply(old, type => (type === 'fs.stat' ? { exists: true, isDir: true } : type === 'session.start' ? { models: [] } : {}));
      await old.next('welcome');
    }, 240_000);
    afterAll(async () => t.close());

    const api = (method: 'GET' | 'POST', url: string, payload?: object) =>
      t.hub.app.inject({ method, url, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, ...(payload ? { payload } : {}) });

    it('agent 1.3: with a non-empty registry the commands carry no subscription and parse with the 1.3 schemas; the connection lives', async () => {
      const add = await api('POST', '/api/subscriptions', { name: 'Max', token: `sk-ant-oat01-${'k'.repeat(60)}` });
      expect(add.statusCode).toBe(201);
      const r = await api('POST', '/api/sessions', { runnerId: 'hp', cwd: VAULT, model: 'haiku', prompt: 'hi' });
      expect(r.statusCode, r.body).toBe(201);
      const id = (r.json() as { id: string; subscriptionMode: string }).id;
      expect((r.json() as { subscriptionMode: string }).subscriptionMode).toBe('agent_outdated');
      await waitFor(() => oldRaw.some(m => m.includes('"session.start"')));
      for (const raw of oldRaw) {
        const p = v13.parseHubMessage(raw);
        expect(p.ok, raw.slice(0, 200)).toBe(true);
        expect(raw).not.toContain('"subscription"');
      }
      // the 1.3 agent's result (no usage) is taken and counted with zeros
      agentSend(old, 'session.result', { sessionId: id, subtype: 'success', isError: false, durationMs: 1, costUsd: 0 });
      await waitFor(async () => (await t.tdb.pool.query(`SELECT 1 FROM session_turns WHERE session_id = $1 AND input_tokens = 0`, [id])).rowCount === 1);
      expect(t.hub.agents.isOnline('hp')).toBe(true);
    });
  });
});

// subscription-limits task 5.7 (Requirement: Версионированный протокол лимитов — «Старый агент»): a hub of 1.6 with an
// agent of 1.5 sends it no limits.probe; the subscription shows agent_outdated; sessions under it work as before.
describe('a 1.6 hub with an agent of 1.5', () => {
  let t: TestHub;
  let cookie: string;
  let old: FakeAgent;
  const types: string[] = [];

  beforeAll(async () => {
    t = await startTestHub({ env: { SUBSCRIPTION_TOKEN_KEY: Buffer.alloc(32, 9).toString('base64') }, sessions: { idleCheckMs: 0 } });
    const token = await t.addRunner('hp', 'HP');
    cookie = await t.login();
    old = connectFakeAgent(t.wsBase, token, { protocol: '1.5' });
    old.ws.on('message', d => types.push((JSON.parse(d.toString()) as { type: string }).type));
    autoReply(old, type => (type === 'fs.stat' ? { exists: true, isDir: true } : type === 'session.start' ? { models: [] } : {}));
    await old.next('welcome');
  }, 240_000);
  afterAll(async () => t.close());

  it('no limits.probe, reason agent_outdated, refresh → 409 agent_outdated; a session under the subscription starts with it', async () => {
    const req = (method: 'GET' | 'POST', url: string, payload?: object) =>
      t.hub.app.inject({ method, url, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, ...(payload ? { payload } : {}) });
    const sub = (await req('POST', '/api/subscriptions', { name: 'Max', token: 'sk-ant-oat01-' + 'x'.repeat(40) })).json() as { id: string };
    await t.hub.limits.tick();
    await t.hub.limits.flush();
    expect(types).not.toContain('limits.probe');
    expect((await req('GET', '/api/subscriptions/limits')).json().limits).toMatchObject([{ subscriptionId: sub.id, state: 'unavailable', reason: 'agent_outdated' }]);
    const r = await req('POST', `/api/subscriptions/${sub.id}/limits/refresh`);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: 'agent_outdated' });
    const s = await req('POST', '/api/sessions', { runnerId: 'hp', cwd: VAULT, model: 'haiku', prompt: 'hi', subscriptionId: sub.id });
    expect(s.statusCode, s.body).toBe(201);
    await waitFor(() => types.includes('session.start'));
    expect(old.ws.readyState).toBe(old.ws.OPEN);
  });
});

// mcp-management task 4.5 (Requirement: Совместимость управления MCP с агентом): a hub of 1.7 with an agent of 1.6 —
// every message it gets parses under the 1.6 schema snapshot (no MCP command ever reaches it), MCP routes → 409
// agent_outdated; an agent of 1.7 sends mcp.status — the hub knows the type (no «unknown agent message type»).
describe('protocol 1.7 ↔ 1.6 (MCP management)', () => {
  let t: TestHub;
  let cookie: string;
  let old: FakeAgent;
  let cur: FakeAgent;
  const oldRaw: string[] = [];
  const logs: string[] = [];

  beforeAll(async () => {
    t = await startTestHub({ sessions: { idleCheckMs: 0 }, logStream: { write: l => void logs.push(l) } });
    const tokOld = await t.addRunner('hp', 'HP');
    const tokCur = await t.addRunner('x1', 'X1');
    cookie = await t.login();
    old = connectFakeAgent(t.wsBase, tokOld, { protocol: '1.6' });
    old.ws.on('message', d => oldRaw.push(d.toString()));
    autoReply(old, type => (type === 'fs.stat' ? { exists: true, isDir: true } : type === 'session.start' ? { models: [] } : {}));
    cur = connectFakeAgent(t.wsBase, tokCur, { protocol: '1.7', hostname: 'x1-host' });
    autoReply(cur, type => (type === 'fs.stat' ? { exists: true, isDir: true } : type === 'session.start' ? { models: [] } : {}));
    await old.next('welcome');
    await cur.next('welcome');
  }, 240_000);
  afterAll(async () => t.close());

  const req = (method: 'GET' | 'POST', url: string, payload?: object) =>
    t.hub.app.inject({ method, url, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, ...(payload ? { payload } : {}) });

  it('an agent of 1.6: MCP routes refuse, everything it gets parses under 1.6', async () => {
    const s = await req('POST', '/api/sessions', { runnerId: 'hp', cwd: VAULT, model: 'haiku', prompt: 'hi' });
    expect(s.statusCode, s.body).toBe(201);
    const id = (s.json() as { id: string }).id;
    expect((await req('GET', `/api/sessions/${id}/mcp`)).json()).toMatchObject({ available: false, reason: 'agent_outdated' });
    expect((await req('POST', `/api/sessions/${id}/mcp/actions`, { server: 'x', action: 'reconnect' })).statusCode).toBe(409);
    expect((await req('POST', `/api/sessions/${id}/mcp/auth`, { server: 'x' })).statusCode).toBe(409);
    expect((await req('POST', '/api/runners/hp/mcp/probe', {})).json()).toMatchObject({ error: 'agent_outdated' });
    await waitFor(() => oldRaw.some(r => r.includes('"session.start"')));
    for (const raw of oldRaw) expect(v16.parseHubMessage(raw).ok, raw.slice(0, 120)).toBe(true);
    expect(old.ws.readyState).toBe(old.ws.OPEN);
  });

  it('an agent of 1.7: mcp.status is a known type of the hub', async () => {
    const s = await req('POST', '/api/sessions', { runnerId: 'x1', cwd: VAULT, model: 'haiku', prompt: 'hi' });
    const id = (s.json() as { id: string }).id;
    const sid = (await t.tdb.pool.query(`SELECT claude_session_id FROM sessions WHERE id = $1`, [id])).rows[0].claude_session_id as string;
    agentSend(cur, 'mcp.status', { sessionId: sid, snapshot: { servers: [{ name: 'a', status: 'connected', transport: 'stdio', toolCount: 1 }], observedAt: Date.now() } });
    await waitFor(async () => ((await req('GET', `/api/sessions/${id}/mcp`)).json() as { servers: unknown[] }).servers.length === 1);
    expect(logs.join('\n')).not.toMatch(/unknown agent message type|invalid agent message/);
  });
});
