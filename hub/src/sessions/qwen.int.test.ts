// Change qwen-provider (tasks 3.x): the Qwen provider through the hub against Postgres and scripted agents — a session
// without a subscription, refusals (no Qwen on the machine, the endpoint does not answer), the default model of the own
// machine, resume without a restore, a full copy, the models list, a replicated mirror and a Qwen sub-agent with its report.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { envelope, parsePeerMessage, type SessionView } from '@agent-hub/shared';
import { PUBLIC_URL, agentSend, connectFakeAgent, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';
import { providerOfRelPath } from '../replication/ingest.js';

const VAULT = 'C:\\Users\\alice\\vault';
const QWEN_OK = { id: 'qwen', version: '0.27.4', login: 'ok', models: [{ value: 'qwen3.8-flash-next', displayName: 'qwen3.8-flash-next' }] };

interface Cmd {
  type: string;
  id?: string;
  payload: Record<string, unknown>;
  runner: string;
}

describe('qwen provider (integration)', () => {
  let t: TestHub;
  let cookie: string;
  const got: Cmd[] = [];
  const agents = new Map<string, FakeAgent>();
  const api = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    t.hub.app.inject({ method, url, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const lastCmd = (type: string, sessionId?: string) => [...got].reverse().find(m => m.type === type && (!sessionId || m.payload.sessionId === sessionId))?.payload;
  const row = async (id: string) => (await t.tdb.pool.query(`SELECT * FROM sessions WHERE id = $1`, [id])).rows[0] as Record<string, unknown>;

  function agent(runner: string, token: string, hello: Record<string, unknown>) {
    const a = connectFakeAgent(t.wsBase, token, { hostname: `${runner}-host`, protocol: '1.21', ...hello });
    a.ws.on('message', d => {
      const m = JSON.parse(d.toString()) as Cmd;
      if (!m.id || m.type === 'peers.reply') return;
      got.push({ ...m, runner });
      const ok = (result: unknown) => a.ws.send(JSON.stringify(envelope('cmd.ok', { result }, { re: m.id! })));
      if (m.type === 'fs.stat') return ok({ exists: true, isDir: true });
      if (m.type === 'session.start' || m.type === 'session.resume') return ok({ models: m.payload.provider === 'qwen' ? QWEN_OK.models : [{ value: 'haiku', displayName: 'Haiku' }] });
      if (m.type === 'session.fork') return ok({ newSessionId: randomUUID() });
      ok({});
    });
    agents.set(runner, a);
    return a;
  }

  const result = (runner: string, sid: string, extra: Record<string, unknown> = {}) =>
    agents.get(runner)!.ws.send(JSON.stringify(envelope('session.result', { sessionId: sid, subtype: 'success', isError: false, durationMs: 1, costUsd: 0, ...extra })));

  const tok: Record<string, string> = {};
  beforeAll(async () => {
    t = await startTestHub({ sessions: { idleCheckMs: 0, initTimeoutMs: 3000 }, peers: { pairLimit: 100, senderLimit: 100 } });
    for (const [id, name] of [
      ['gpu', 'GPU'],
      ['plain', 'PLAIN'],
      ['old', 'OLD'],
    ] as const)
      tok[id] = await t.addRunner(id, name);
    cookie = await t.login();
    agent('gpu', tok.gpu!, { providers: [QWEN_OK] });
    agent('plain', tok.plain!, { providers: [] });
    agent('old', tok.old!, { protocol: '1.20' });
    for (const a of agents.values()) await a.next('welcome');
  }, 120_000);
  afterAll(async () => {
    await t.close();
  });

  const base = { runnerId: 'gpu', cwd: VAULT, model: QWEN_OK.models[0]!.value, prompt: 'привет', provider: 'qwen' };
  const create = (extra: Record<string, unknown> = {}) => api('POST', '/api/sessions', { ...base, ...extra });

  it('a Qwen session: provider in the command and the view, no subscription even when one is asked for', async () => {
    const r = await create({ subscriptionId: randomUUID() });
    expect(r.statusCode, r.body).toBe(201);
    const s = r.json() as SessionView;
    expect(s.provider).toBe('qwen');
    await waitFor(() => lastCmd('session.start', s.id));
    const cmd = lastCmd('session.start', s.id)!;
    expect(cmd).toMatchObject({ provider: 'qwen', model: 'qwen3.8-flash-next', prompt: 'привет' });
    expect(cmd).not.toHaveProperty('subscription');
  });

  it('refusals: no Qwen on the machine, an agent below 1.21, the endpoint does not answer', async () => {
    const r1 = await create({ runnerId: 'plain' });
    expect(r1.statusCode).toBe(422);
    expect(r1.json()).toMatchObject({ error: 'provider_unavailable' });
    const r2 = await create({ runnerId: 'old' });
    expect(r2.statusCode).toBe(422);
    expect(r2.json()).toMatchObject({ error: 'provider_unavailable' });
    agentSend(agents.get('gpu')!, 'agent.status', { providers: [{ id: 'qwen', version: '0.27.4', login: 'rejected' }] });
    await waitFor(async () => (await api('GET', '/api/runners')).json().runners.find((r: { id: string }) => r.id === 'gpu')?.providers?.[0]?.login === 'rejected');
    const r3 = await create();
    expect(r3.statusCode).toBe(422);
    expect(r3.json()).toMatchObject({ error: 'provider_login_required' });
    agentSend(agents.get('gpu')!, 'agent.status', { providers: [QWEN_OK] });
    await waitFor(async () => (await api('GET', '/api/runners')).json().runners.find((r: { id: string }) => r.id === 'gpu')?.providers?.[0]?.login === 'ok');
  });

  it('resume of a Qwen session: provider in the command, no transcript restore', async () => {
    const s = (await create({ prompt: 'первое' })).json() as SessionView;
    await waitFor(() => lastCmd('session.start', s.id));
    agentSend(agents.get('gpu')!, 'session.exited', { sessionId: s.id, code: 0, reason: 'stopped' });
    await waitFor(async () => !((await api('GET', `/api/sessions/${s.id}`)).json() as SessionView).processAlive);
    const before = got.length;
    expect((await api('POST', `/api/sessions/${s.id}/messages`, { text: 'второе', clientUuid: randomUUID() })).statusCode).toBe(202);
    await waitFor(() => lastCmd('session.resume', s.id));
    expect(lastCmd('session.resume', s.id)).toMatchObject({ provider: 'qwen', prompt: 'второе' });
    expect(got.slice(before).some(m => m.type === 'file.restore')).toBe(false);
  });

  it('a full copy of a Qwen session is a Qwen session', async () => {
    const s = (await create({ prompt: 'для копии' })).json() as SessionView;
    await waitFor(() => lastCmd('session.start', s.id));
    const r = await api('POST', `/api/sessions/${s.id}/fork`, { mode: 'copy' });
    expect(r.statusCode, r.body).toBe(201);
    expect((r.json() as SessionView).provider).toBe('qwen');
    expect(lastCmd('session.fork')).toMatchObject({ provider: 'qwen', sourceSessionId: s.id });
  });

  it('models of the provider: from the machine report', async () => {
    const r = await api('GET', '/api/models?provider=qwen');
    expect(r.json()).toEqual(QWEN_OK.models);
    const claude = (await api('GET', '/api/models')).json() as Array<{ value: string }>;
    expect(claude.some(m => m.value === 'qwen3.8-flash-next')).toBe(false);
  });

  it('a Qwen mirror seen first by replication is a Qwen session', async () => {
    expect(providerOfRelPath('agent-hub-qwen/x.jsonl')).toBe('qwen');
    expect(providerOfRelPath('agent-hub-qwen\\x.jsonl')).toBe('qwen');
    expect(providerOfRelPath('agent-hub-codex/x.jsonl')).toBe('codex');
    const sid = randomUUID();
    const rel = `agent-hub-qwen/${sid}.jsonl`;
    const line = JSON.stringify({ type: 'system', subtype: 'agent_provider', provider: 'qwen', threadId: 't', cwd: VAULT, sessionId: sid, uuid: randomUUID(), timestamp: new Date().toISOString() });
    agentSend(agents.get('gpu')!, 'repl.chunk', { relPath: rel, kind: 'main', sessionId: sid, generation: 0, fromLine: 0, fromByte: 0, lines: [line], endByte: line.length + 1 });
    await waitFor(() => got.length > 0 && agents.get('gpu')!.messages.some(m => m.type === 'repl.ack' && (m.payload as { relPath?: string }).relPath === rel));
    const r = await t.tdb.db.selectFrom('sessions').select(['provider']).where('claude_session_id', '=', sid).executeTakeFirst();
    expect(r?.provider).toBe('qwen');
  });

  it('a sub-agent with provider qwen: started on the machine, the report goes to the parent', async () => {
    const parent = (await api('POST', '/api/sessions', { runnerId: 'plain', model: 'haiku', prompt: 'hi', permissionMode: 'acceptEdits' })).json() as SessionView;
    const parentSid = (await row(parent.id)).claude_session_id as string;
    result('plain', parentSid);
    await waitFor(async () => (await row(parent.id)).status === 'waiting');
    const a = agents.get('plain')!;
    const id = randomUUID();
    a.ws.send(JSON.stringify(envelope('peers.request', { sessionId: parentSid, op: 'spawn', task: 'посчитай строки', provider: 'qwen', machine: 'gpu' }, { id })));
    const m = await waitFor(() => a.messages.find(x => x.type === 'peers.reply' && (x as unknown as { re?: string }).re === id), 10_000);
    const reply = m.payload as unknown as { ok: boolean; result?: { sessionId: string; provider: string; model: string | null; machine: string } };
    expect(reply.ok, JSON.stringify(reply)).toBe(true);
    expect(reply.result).toMatchObject({ provider: 'qwen', machine: 'GPU', model: 'qwen3.8-flash-next' });
    const childId = reply.result!.sessionId;
    const childSid = (await row(childId)).claude_session_id as string;
    const start = await waitFor(() => got.find(c => c.runner === 'gpu' && c.type === 'session.start' && c.payload.sessionId === childSid));
    expect(start.payload).toMatchObject({ provider: 'qwen' });
    expect(start.payload).not.toHaveProperty('subscription');
    expect((await row(childId)).provider).toBe('qwen');
    result('gpu', childSid, { resultText: 'Строк: 42' });
    const report = await waitFor(() =>
      got
        .filter(c => c.runner === 'plain' && c.type === 'session.send' && c.payload.sessionId === parentSid)
        .map(c => parsePeerMessage(c.payload.text as string))
        .find(x => x && x.envelope.kind === 'report' && x.envelope.from === childId),
    );
    expect(report!.text).toBe('Строк: 42');
  });

  it('the default model of Qwen comes from the own machine only', async () => {
    const parent = (await api('POST', '/api/sessions', { runnerId: 'plain', model: 'haiku', prompt: 'hi', permissionMode: 'acceptEdits' })).json() as SessionView;
    const parentSid = (await row(parent.id)).claude_session_id as string;
    result('plain', parentSid);
    await waitFor(async () => (await row(parent.id)).status === 'waiting');
    const a = agents.get('plain')!;
    const id = randomUUID();
    a.ws.send(JSON.stringify(envelope('peers.request', { sessionId: parentSid, op: 'spawn', task: 'x', provider: 'qwen' }, { id })));
    const m = await waitFor(() => a.messages.find(x => x.type === 'peers.reply' && (x as unknown as { re?: string }).re === id), 10_000);
    expect((m.payload as unknown as { ok: boolean }).ok).toBe(false);
  });
});
