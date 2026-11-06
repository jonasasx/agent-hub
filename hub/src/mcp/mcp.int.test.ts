// mcp-management tasks 4.3, 4.4 against a real hub, Postgres and scripted agents: HP (protocol 1.7), X1 (1.7, goes
// offline), OLD (1.6); NEW (1.8) — the sign-out of mcp-auth-controls (task 3.2). The tests of the describe share the hub and run in order.
// Requirements: Статус MCP сессии; Отметка проблем MCP; Переподключение MCP-сервера; Включение и выключение
// MCP-сервера; Вход в удалённый MCP с любого устройства; Защита потока входа MCP; MCP спящей сессии; MCP машины;
// Совместимость управления MCP с агентом; Секреты в снимке MCP.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { envelope, type McpMachineView, type McpServerSnapshot, type McpSessionView, type McpSnapshot, type SessionView } from '@agent-hub/shared';
import { PUBLIC_URL, agentSend, connectFakeAgent, connectUi, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';
import { render } from '../i18n.js';
import { MCP_AUTH_URL_REFUSED } from './service.js';

/** The Russian texts the hub sends on a `ru` request (the dictionaries hold the same). */
const MCP_TEXTS = {
  agentOutdated: 'Управление MCP требует обновления агента',
  notHubManaged: 'MCP видны только у сессий, запущенных или продолженных хабом',
  stateMismatch: 'Адрес не от этой попытки входа или без кода — вставьте адрес со страницы этой попытки',
} as const;

/** The English text of a hub.mcp key: what the WS events and `lastError` carry next to the key. */
const en = (key: string, params?: Record<string, string | number>) => render({ key: `hub.mcp.${key}`, ...(params ? { params } : {}) }, 'en');

const VAULT = 'C:\\Users\\alice\\vault';
const CB = `${PUBLIC_URL}/mcp/oauth/callback`;
const SECRET_CODE = 'CODE-SECRET-7f3a9c';

interface Cmd {
  type: string;
  id?: string;
  payload: Record<string, unknown>;
  runner: string;
}
type Answer = { result?: unknown } | { error: { code: string; message: string } } | 'hang';

const srv = (name: string, status: McpServerSnapshot['status'], o: Partial<McpServerSnapshot> = {}): McpServerSnapshot => ({ name, status, transport: 'stdio', scope: 'user', toolCount: 0, ...o });
let clock = Date.now();
const snap = (servers: McpServerSnapshot[]): McpSnapshot => ({ servers, observedAt: (clock += 1000) });

describe('MCP management (integration)', () => {
  let t: TestHub;
  let cookie: string;
  let ui: ReturnType<typeof connectUi>;
  let shift = 0;
  const now = () => new Date(Date.now() + shift);
  const got: Cmd[] = [];
  const logs: string[] = [];
  const agents = new Map<string, FakeAgent>();
  const answers = new Map<string, Answer[]>();

  const api = async (method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = { origin: PUBLIC_URL }, withCookie = true) =>
    t.hub.app.inject({ method, url, ...(withCookie ? { cookies: { ah_session: cookie } } : {}), headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const view = async (id: string) => {
    const r = await api('GET', `/api/sessions/${id}/mcp`);
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as McpSessionView;
  };
  const answer = (type: string, ...a: Answer[]) => answers.set(type, [...(answers.get(type) ?? []), ...a]);
  const cmds = (type: string) => got.filter(c => c.type === type);
  const wsOf = (type: string) => ui.received.filter(m => m.type === type);

  function agent(runner: string, token: string, protocol: string) {
    const a = connectFakeAgent(t.wsBase, token, { protocol, hostname: `${runner}-host` });
    a.ws.on('message', d => {
      const m = JSON.parse(d.toString()) as Cmd;
      if (!m.id) return;
      got.push({ ...m, runner });
      const reply = (a2: Answer) => {
        if (a2 === 'hang') return;
        if ('error' in a2) a.ws.send(JSON.stringify(envelope('cmd.error', a2.error, { re: m.id! })));
        else a.ws.send(JSON.stringify(envelope('cmd.ok', a2.result === undefined ? {} : { result: a2.result }, { re: m.id! })));
      };
      const queued = answers.get(m.type)?.shift();
      if (queued) return reply(queued);
      if (m.type === 'fs.stat') return reply({ result: { exists: true, isDir: true } });
      if (m.type === 'session.start' || m.type === 'session.resume') return reply({ result: { models: [] } });
      if (m.type === 'mcp.status.get' || m.type === 'mcp.action' || m.type === 'mcp.auth.callback' || m.type === 'mcp.auth.logout')
        return reply({ result: { snapshot: snap([srv('vw', 'connected')]) } });
      reply({ result: {} });
    });
    agents.set(runner, a);
    return a;
  }

  /** A hub session on `runner` that finished its first turn (waiting, process alive). */
  async function session(runner = 'hp'): Promise<{ id: string; sid: string }> {
    const r = await api('POST', '/api/sessions', { runnerId: runner, cwd: VAULT, model: 'haiku', prompt: 'hi' });
    expect(r.statusCode, r.body).toBe(201);
    const id = (r.json() as SessionView).id;
    const sid = (await t.tdb.pool.query(`SELECT claude_session_id FROM sessions WHERE id = $1`, [id])).rows[0].claude_session_id as string;
    agentSend(agents.get(runner)!, 'session.result', { sessionId: sid, subtype: 'success', isError: false, durationMs: 1, costUsd: 0 });
    await waitFor(async () => (await t.tdb.pool.query(`SELECT status FROM sessions WHERE id = $1`, [id])).rows[0].status === 'waiting');
    return { id, sid };
  }
  const asleep = async (id: string) => {
    await t.tdb.pool.query(`UPDATE sessions SET status = 'sleeping', process_alive = false, slept_at = now() WHERE id = $1`, [id]);
  };

  beforeAll(async () => {
    t = await startTestHub({
      logStream: { write: l => void logs.push(l) },
      sessions: { idleCheckMs: 0, initTimeoutMs: 3000, now },
      mcp: { timeouts: { status: 3000, action: 3000, authStart: 3000, callback: 3000, probe: 3000 }, wakeStatusDelayMs: 20, sweepMs: 0, now },
    });
    const tok: Record<string, string> = {};
    for (const [id, name] of [
      ['hp', 'HP'],
      ['x1', 'X1'],
      ['old', 'OLD'],
      ['new', 'NEW'],
    ] as const)
      tok[id] = await t.addRunner(id, name);
    cookie = await t.login();
    ui = connectUi(t.wsBase, cookie);
    await ui.open;
    agent('hp', tok.hp!, '1.7');
    agent('x1', tok.x1!, '1.7');
    agent('old', tok.old!, '1.6');
    agent('new', tok.new!, '1.8');
    for (const a of agents.values()) await a.next('welcome');
  }, 240_000);
  afterAll(async () => {
    for (const fakeAgent of agents.values()) expect(fakeAgent.protocolErrors).toEqual([]);
    ui.ws.close();
    await t.close();
  });

  let S: { id: string; sid: string };

  it('a snapshot → GET, WS session.mcp, mcpProblems in SessionView, the machine block (user rows); an older one is ignored', async () => {
    S = await session();
    expect((await view(S.id)).reason).toBe('no_snapshot');
    const first = snap([
      srv('vw', 'failed', { error: 'ECONNREFUSED' }),
      srv('notion', 'needs-auth', { transport: 'http', target: 'https://mcp.notion.com/mcp' }),
      srv('proj', 'connected', { scope: 'project' }),
      srv('pw', 'disabled'),
    ]);
    agentSend(agents.get('hp')!, 'mcp.status', { sessionId: S.sid, snapshot: first });
    const v = await waitFor(async () => {
      const x = await view(S.id);
      return x.servers.length === 4 ? x : null;
    });
    expect(v).toMatchObject({ available: true, live: true, observedAt: new Date(first.observedAt).toISOString() });
    expect(v.reason).toBeUndefined();
    expect(v.servers.find(s => s.name === 'notion')).toMatchObject({ canAuth: true, persistence: 'project' });
    const sv = (await api('GET', `/api/sessions/${S.id}`)).json() as SessionView;
    expect(sv.mcpProblems).toBe(2);
    await waitFor(() => wsOf('session.mcp').some(m => m.sessionId === S.id && (m.mcp as McpSessionView).servers.length === 4));
    await waitFor(() => wsOf('session.upsert').some(m => (m.session as SessionView).id === S.id && (m.session as SessionView).mcpProblems === 2));
    await waitFor(() => wsOf('runner.mcp').some(m => m.runnerId === 'hp'));
    const machine = (await api('GET', '/api/runners/hp/mcp')).json() as McpMachineView;
    expect(machine).toMatchObject({ available: true, source: 'session', online: true, probing: false });
    expect(machine.servers.map(s => s.name)).toEqual(['vw', 'notion', 'pw']);
    agentSend(agents.get('hp')!, 'mcp.status', { sessionId: S.sid, snapshot: { servers: [srv('vw', 'connected')], observedAt: first.observedAt - 5000 } });
    await new Promise(r => setTimeout(r, 200));
    expect((await view(S.id)).servers).toHaveLength(4);
  });

  it('reconnect of a live session: 202 with pendingAction, mcp.action to the agent, then the new snapshot; problems go down', async () => {
    answer('mcp.action', {
      result: { snapshot: snap([srv('vw', 'connected', { serverInfo: { name: 'vw', version: '1' } }), srv('notion', 'needs-auth', { transport: 'http' }), srv('pw', 'disabled')]) },
    });
    const r = await api('POST', `/api/sessions/${S.id}/mcp/actions`, { server: 'vw', action: 'reconnect' });
    expect(r.statusCode, r.body).toBe(202);
    expect((r.json() as McpSessionView).servers.find(s => s.name === 'vw')!.pendingAction).toBe('reconnect');
    await waitFor(() => cmds('mcp.action').length === 1);
    expect(cmds('mcp.action')[0]!.payload).toEqual({ sessionId: S.sid, server: 'vw', action: 'reconnect' });
    const v = await waitFor(async () => {
      const x = await view(S.id);
      return x.servers.find(s => s.name === 'vw')?.status === 'connected' && !x.servers.find(s => s.name === 'vw')?.pendingAction ? x : null;
    });
    expect(v.servers).toHaveLength(3);
    expect(((await api('GET', `/api/sessions/${S.id}`)).json() as SessionView).mcpProblems).toBe(1);
  });

  it('a failed action: lastError on the server; an unknown server → 422; a bad body → 400; no Origin → 403', async () => {
    answer('mcp.action', { error: { code: 'mcp_action_failed', message: 'connect ECONNREFUSED 127.0.0.1:9' } });
    expect((await api('POST', `/api/sessions/${S.id}/mcp/actions`, { server: 'vw', action: 'reconnect' })).statusCode).toBe(202);
    const v = await waitFor(async () => {
      const x = await view(S.id);
      return x.servers.find(s => s.name === 'vw')?.lastError ? x : null;
    });
    expect(v.servers.find(s => s.name === 'vw')).toMatchObject({ lastError: 'connect ECONNREFUSED 127.0.0.1:9' });
    expect(v.servers.find(s => s.name === 'vw')!.pendingAction).toBeUndefined();
    expect((await api('POST', `/api/sessions/${S.id}/mcp/actions`, { server: 'nope', action: 'reconnect' })).json()).toMatchObject({ error: 'mcp_unknown_server' });
    expect((await api('POST', `/api/sessions/${S.id}/mcp/actions`, { server: 'vw', action: 'restart' })).statusCode).toBe(400);
    expect((await api('POST', `/api/sessions/${S.id}/mcp/actions`, { server: 'vw', action: 'reconnect' }, {})).statusCode).toBe(403);
  });

  it('a sleeping session: an action wakes it (resume without a prompt, a resume note), then mcp.action', async () => {
    const W = await session();
    agentSend(agents.get('hp')!, 'mcp.status', { sessionId: W.sid, snapshot: snap([srv('pw', 'connected')]) });
    await waitFor(async () => (await view(W.id)).servers.length === 1);
    await asleep(W.id);
    const before = got.length;
    const r = await api('POST', `/api/sessions/${W.id}/mcp/actions`, { server: 'pw', action: 'disable' });
    expect(r.statusCode, r.body).toBe(202);
    const body = r.json() as McpSessionView;
    expect(body.waking).toBe(true);
    expect(body.servers[0]!.pendingAction).toBe('wake');
    await waitFor(() => got.slice(before).some(c => c.type === 'mcp.action'));
    const order = got
      .slice(before)
      .map(c => c.type)
      .filter(x => x === 'session.resume' || x === 'mcp.action');
    expect(order).toEqual(['session.resume', 'mcp.action']);
    expect(got.slice(before).find(c => c.type === 'session.resume')!.payload.prompt).toBeUndefined();
    const notes = (await t.tdb.pool.query(`SELECT text FROM session_notes WHERE session_id = $1 AND kind = 'resume'`, [W.id])).rows;
    expect(notes).toHaveLength(1);
    await waitFor(async () => !(await view(W.id)).waking);
  });

  it('«Переподключить» of a sleeping session: after the wake-up the status is read, no mcp.action', async () => {
    const W = await session();
    agentSend(agents.get('hp')!, 'mcp.status', { sessionId: W.sid, snapshot: snap([srv('vw', 'failed')]) });
    await waitFor(async () => (await view(W.id)).servers.length === 1);
    await asleep(W.id);
    const before = got.length;
    expect((await api('POST', `/api/sessions/${W.id}/mcp/actions`, { server: 'vw', action: 'reconnect' })).statusCode).toBe(202);
    await waitFor(() => got.slice(before).some(c => c.type === 'mcp.status.get'));
    expect(
      got
        .slice(before)
        .map(c => c.type)
        .filter(x => x.startsWith('mcp.') || x === 'session.resume'),
    ).toEqual(['session.resume', 'mcp.status.get']);
    const v = await waitFor(async () => {
      const x = await view(W.id);
      return x.servers[0]?.status === 'connected' && !x.servers[0]?.pendingAction ? x : null;
    });
    expect(v.live).toBe(true);
  });

  it('two actions during one wake-up: one session.resume, both actions after the start', async () => {
    const W = await session();
    agentSend(agents.get('hp')!, 'mcp.status', { sessionId: W.sid, snapshot: snap([srv('a', 'connected'), srv('b', 'connected')]) });
    await waitFor(async () => (await view(W.id)).servers.length === 2);
    await asleep(W.id);
    const before = got.length;
    const both = { result: { snapshot: snap([srv('a', 'disabled'), srv('b', 'disabled')]) } };
    answer('mcp.action', both, both);
    // the process starts only when the test answers: the second action lands during the wake-up
    answer('session.resume', 'hang');
    expect((await api('POST', `/api/sessions/${W.id}/mcp/actions`, { server: 'a', action: 'disable' })).statusCode).toBe(202);
    const resume = await waitFor(() => got.slice(before).find(c => c.type === 'session.resume'));
    const second = await api('POST', `/api/sessions/${W.id}/mcp/actions`, { server: 'b', action: 'disable' });
    expect(second.statusCode, second.body).toBe(202);
    expect((second.json() as McpSessionView).servers.find(x => x.name === 'b')!.pendingAction).toBe('wake');
    expect(got.slice(before).filter(c => c.type === 'mcp.action')).toHaveLength(0);
    agents.get('hp')!.ws.send(JSON.stringify(envelope('cmd.ok', { result: { models: [] } }, { re: resume.id! })));
    await waitFor(() => got.slice(before).filter(c => c.type === 'mcp.action').length === 2);
    const order = got
      .slice(before)
      .map(c => c.type)
      .filter(x => x === 'session.resume' || x === 'mcp.action');
    expect(order).toEqual(['session.resume', 'mcp.action', 'mcp.action']);
    await waitFor(async () => !(await view(W.id)).waking);
  });

  it('«Войти» of a sleeping session: the sign-in starts once the server left pending', async () => {
    const W = await session();
    agentSend(agents.get('hp')!, 'mcp.status', { sessionId: W.sid, snapshot: snap([srv('nt', 'needs-auth', { transport: 'http' })]) });
    await waitFor(async () => (await view(W.id)).servers.length === 1);
    await asleep(W.id);
    answer('mcp.status.get', { result: { snapshot: snap([srv('nt', 'pending', { transport: 'http' })]) } }, { result: { snapshot: snap([srv('nt', 'needs-auth', { transport: 'http' })]) } });
    answer('mcp.auth.start', { result: { authUrl: 'https://p/authorize', redirect: 'hub', state: 'st-wake' } });
    const before = got.length;
    expect((await api('POST', `/api/sessions/${W.id}/mcp/auth`, { server: 'nt' })).statusCode).toBe(202);
    await waitFor(() => got.slice(before).some(c => c.type === 'mcp.auth.start'));
    const order = got
      .slice(before)
      .map(c => c.type)
      .filter(x => x.startsWith('mcp.') || x === 'session.resume');
    expect(order).toEqual(['session.resume', 'mcp.status.get', 'mcp.status.get', 'mcp.auth.start']);
    await waitFor(async () => (await view(W.id)).authFlows.length === 1);
  });

  // fix-cycle 2: the wait for the woken process ends on its exit — one «Вход прерван…», no start, no second failed
  it('«Войти» of a sleeping session: the process exits while the server is pending — one process_exited, no start', async () => {
    const W = await session();
    agentSend(agents.get('hp')!, 'mcp.status', { sessionId: W.sid, snapshot: snap([srv('nx', 'needs-auth', { transport: 'http' })]) });
    await waitFor(async () => (await view(W.id)).servers.length === 1);
    await asleep(W.id);
    const pending = { result: { snapshot: snap([srv('nx', 'pending', { transport: 'http' })]) } };
    answer('mcp.status.get', ...Array<Answer>(200).fill(pending));
    const before = got.length;
    const wsBefore = ui.received.length;
    expect((await api('POST', `/api/sessions/${W.id}/mcp/auth`, { server: 'nx' })).statusCode).toBe(202);
    await waitFor(() => got.slice(before).some(c => c.type === 'mcp.status.get'));
    agentSend(agents.get('hp')!, 'session.exited', { sessionId: W.sid, code: 0, reason: 'stopped' });
    await waitFor(() => ui.received.slice(wsBefore).some(m => m.type === 'mcp.auth' && m.sessionId === W.id && m.result === 'process_exited'));
    await new Promise(r => setTimeout(r, 150));
    answers.delete('mcp.status.get');
    const auths = ui.received.slice(wsBefore).filter(m => m.type === 'mcp.auth' && m.sessionId === W.id);
    expect(auths).toHaveLength(1);
    expect(auths[0]).toMatchObject({ server: 'nx', flow: null, result: 'process_exited', error: en('processExited') });
    expect(got.slice(before).some(c => c.type === 'mcp.auth.start')).toBe(false);
    expect((await view(W.id)).servers[0]?.pendingAction).toBeUndefined();
  });

  it('«Войти» of a sleeping session: the server is not in the new process — mcp_unknown_server at once, no start', async () => {
    const W = await session();
    agentSend(agents.get('hp')!, 'mcp.status', { sessionId: W.sid, snapshot: snap([srv('gone', 'needs-auth', { transport: 'http' })]) });
    await waitFor(async () => (await view(W.id)).servers.length === 1);
    await asleep(W.id);
    answer('mcp.status.get', { result: { snapshot: snap([srv('vw', 'connected')]) } });
    const before = got.length;
    expect((await api('POST', `/api/sessions/${W.id}/mcp/auth`, { server: 'gone' })).statusCode).toBe(202);
    const m = await waitFor(() => wsOf('mcp.auth').find(x => x.sessionId === W.id && x.result === 'failed'));
    expect(m.error).toBe(en('unknownServer', { server: 'gone' }));
    expect(got.slice(before).filter(c => c.type === 'mcp.status.get')).toHaveLength(1);
    expect(got.slice(before).some(c => c.type === 'mcp.auth.start')).toBe(false);
  });

  it('the process exits: rows of servers without an action in flight are dropped from the memory', async () => {
    const W = await session();
    agentSend(agents.get('hp')!, 'mcp.status', { sessionId: W.sid, snapshot: snap([srv('z', 'connected')]) });
    await waitFor(async () => (await view(W.id)).servers.length === 1);
    answer('mcp.action', { error: { code: 'mcp_action_failed', message: 'boom' } });
    await api('POST', `/api/sessions/${W.id}/mcp/actions`, { server: 'z', action: 'reconnect' });
    await waitFor(async () => (await view(W.id)).servers[0]!.lastError === 'boom');
    const states = (t.hub.mcp as unknown as { states: Map<string, unknown> }).states;
    expect(states.has(W.id)).toBe(true);
    agentSend(agents.get('hp')!, 'session.exited', { sessionId: W.sid, code: 0, reason: 'stopped' });
    await waitFor(() => !states.has(W.id));
  });

  it('the machine offline: a sleeping session refuses with the text of «Продолжить»; a live one 409 too', async () => {
    const X = await session('x1');
    await asleep(X.id);
    agents.get('x1')!.ws.close();
    await waitFor(() => !t.hub.agents.isOnline('x1'));
    const r = await api('POST', `/api/sessions/${X.id}/mcp/auth`, { server: 'notion' });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: 'runner_offline', message: 'X1 не в сети' });
  });

  it('an agent of 1.6: the panel says so, actions → 409 agent_outdated, nothing is sent', async () => {
    const O = await session('old');
    const v = await view(O.id);
    expect(v).toMatchObject({ available: false, reason: 'agent_outdated' });
    const before = got.length;
    for (const [url, body] of [
      [`/api/sessions/${O.id}/mcp/actions`, { server: 'x', action: 'reconnect' }],
      [`/api/sessions/${O.id}/mcp/auth`, { server: 'x' }],
      [`/api/sessions/${O.id}/mcp/refresh`, undefined],
    ] as const) {
      const r = await api('POST', url, body ?? {});
      expect(r.statusCode, url).toBe(409);
      expect(r.json()).toMatchObject({ error: 'agent_outdated', message: MCP_TEXTS.agentOutdated });
    }
    expect((await api('POST', '/api/runners/old/mcp/probe', {})).json()).toMatchObject({ error: 'agent_outdated' });
    expect(got.slice(before).filter(c => c.type.startsWith('mcp.'))).toEqual([]);
  });

  it('a session not started or resumed by the hub: not_hub_managed', async () => {
    const N = await session();
    await t.tdb.pool.query(`UPDATE sessions SET is_hub_managed = false WHERE id = $1`, [N.id]);
    expect(await view(N.id)).toMatchObject({ available: false, reason: 'not_hub_managed' });
    expect((await api('POST', `/api/sessions/${N.id}/mcp/actions`, { server: 'x', action: 'reconnect' })).json()).toMatchObject({ error: 'not_hub_managed', message: MCP_TEXTS.notHubManaged });
  });

  it('sign-in through the hub: start → flow in WS and GET; the session does not sleep meanwhile; the return without a login goes to the login; an unknown state → 403; the right one → «Вход выполнен», mcp.auth ok', async () => {
    answer('mcp.auth.start', { result: { authUrl: 'https://mcp.notion.com/authorize?x=1', redirect: 'hub', state: 'st-hub-1' } });
    const r = await api('POST', `/api/sessions/${S.id}/mcp/auth`, { server: 'notion' });
    expect(r.statusCode, r.body).toBe(202);
    await waitFor(() => cmds('mcp.auth.start').some(c => c.payload.server === 'notion'));
    expect(cmds('mcp.auth.start').find(c => c.payload.server === 'notion')!.payload).toEqual({ sessionId: S.sid, server: 'notion', redirectUri: CB });
    const flowMsg = await waitFor(() => wsOf('mcp.auth').find(m => m.sessionId === S.id && m.flow));
    expect(flowMsg.flow).toMatchObject({ server: 'notion', authUrl: 'https://mcp.notion.com/authorize?x=1', redirect: 'hub' });
    expect((await view(S.id)).authFlows).toHaveLength(1);

    // Requirement «Простой во время входа»: 31 min later the session would sleep, but the attempt (10 min) holds it
    await t.tdb.pool.query(
      `UPDATE sessions SET last_turn_end_at = now() - interval '29 minutes', last_input_at = now() - interval '29 minutes', last_event_at = now() - interval '29 minutes' WHERE id = $1`,
      [S.id],
    );
    shift = 2 * 60_000;
    expect(await t.hub.sessions.checkIdle()).toBe(0);
    expect(((await api('GET', `/api/sessions/${S.id}`)).json() as SessionView).status).toBe('waiting');
    shift = 0;

    const noLogin = await api('GET', `/mcp/oauth/callback?code=${SECRET_CODE}&state=st-hub-1`, undefined, {}, false);
    expect(noLogin.statusCode).toBe(302);
    expect(noLogin.headers.location).toBe(`/auth/login?return=${encodeURIComponent(`/mcp/oauth/callback?code=${SECRET_CODE}&state=st-hub-1`)}`);
    const unknown = await api('GET', `/mcp/oauth/callback?code=${SECRET_CODE}&state=nope`, undefined, {});
    expect(unknown.statusCode).toBe(403);
    expect(unknown.body).toContain('Попытка входа не найдена');
    expect(cmds('mcp.auth.callback')).toHaveLength(0);

    answer('mcp.auth.callback', {
      result: { snapshot: snap([srv('vw', 'connected'), srv('notion', 'connected', { transport: 'http', serverInfo: { name: 'notion', version: '2' } }), srv('pw', 'disabled')]) },
    });
    const ok = await api('GET', `/mcp/oauth/callback?code=${SECRET_CODE}&state=st-hub-1`, undefined, {});
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('Вход выполнен');
    expect(ok.body).toContain(`/s/${S.id}?mcp=1`);
    expect(ok.headers['referrer-policy']).toBe('no-referrer');
    expect(cmds('mcp.auth.callback')[0]!.payload).toEqual({ sessionId: S.sid, server: 'notion', callbackUrl: `${CB}?code=${SECRET_CODE}&state=st-hub-1` });
    await waitFor(() => wsOf('mcp.auth').some(m => m.sessionId === S.id && m.result === 'ok'));
    const v = await view(S.id);
    expect(v.authFlows).toEqual([]);
    expect(v.servers.find(s => s.name === 'notion')!.status).toBe('connected');
    expect(((await api('GET', `/api/sessions/${S.id}`)).json() as SessionView).mcpProblems).toBe(0);
    // the same address again (a reload): the result page, the code is not passed a second time
    const again = await api('GET', `/mcp/oauth/callback?code=${SECRET_CODE}&state=st-hub-1`, undefined, {});
    expect(again.statusCode).toBe(200);
    expect(again.body).toContain('Вход выполнен');
    expect(cmds('mcp.auth.callback')).toHaveLength(1);
  });

  it('a repeated GET while the callback is in flight: «Вход выполняется», one mcp.auth.callback; then the result', async () => {
    answer('mcp.auth.start', { result: { authUrl: 'https://p/authorize', redirect: 'hub', state: 'st-dup' } });
    await api('POST', `/api/sessions/${S.id}/mcp/auth`, { server: 'notion' });
    await waitFor(async () => (await view(S.id)).authFlows.length === 1);
    const before = cmds('mcp.auth.callback').length;
    answer('mcp.auth.callback', 'hang');
    const url = `/mcp/oauth/callback?code=${SECRET_CODE}&state=st-dup`;
    const first = api('GET', url, undefined, {});
    await waitFor(() => cmds('mcp.auth.callback').length === before + 1);
    const dup = await api('GET', url, undefined, {});
    expect(dup.statusCode).toBe(200);
    expect(dup.body).toContain('Вход выполняется');
    expect(dup.headers['referrer-policy']).toBe('no-referrer');
    const r1 = await first; // the agent never answers: the hub's timeout
    expect(r1.body).toContain('Вход не выполнен');
    const after = await api('GET', url, undefined, {});
    expect(after.body).toContain('Вход не выполнен');
    expect(cmds('mcp.auth.callback')).toHaveLength(before + 1);
  });

  it('mcp.auth.done ok:false: the panel gets the spec text, not the English of the agent', async () => {
    answer('mcp.auth.start', { result: { authUrl: 'https://p/authorize', redirect: 'localhost', state: 'st-done', callbackPort: 53999 } });
    await api('POST', `/api/sessions/${S.id}/mcp/auth`, { server: 'notion' });
    await waitFor(async () => (await view(S.id)).authFlows.length === 1);
    agentSend(agents.get('hp')!, 'mcp.auth.done', { sessionId: S.sid, server: 'notion', ok: false, error: 'server did not connect after the sign-in' });
    const m = await waitFor(() => wsOf('mcp.auth').find(x => x.sessionId === S.id && x.result === 'failed' && x.error === en('notConnectedAfterSignIn')));
    expect(m.error).toBe('The server did not connect after sign-in');
  });

  it('QA fix 4: the CLI took the localhost callback itself — a connected snapshot ends the attempt with ok', async () => {
    // the server waits for a sign-in (an attempt on a connected one is «Войти заново» — another rule, below)
    agentSend(agents.get('hp')!, 'mcp.status', { sessionId: S.sid, snapshot: snap([srv('notion', 'needs-auth', { transport: 'http' })]) });
    await waitFor(async () => (await view(S.id)).servers.find(x => x.name === 'notion')?.status === 'needs-auth');
    answer('mcp.auth.start', { result: { authUrl: 'https://p/authorize', redirect: 'localhost', state: 'st-local', callbackPort: 8087 } });
    await api('POST', `/api/sessions/${S.id}/mcp/auth`, { server: 'notion' });
    await waitFor(async () => (await view(S.id)).authFlows.length === 1);
    // a pasted address of another attempt: the server keeps the error, the attempt goes on
    answer('mcp.auth.callback', { error: { code: 'mcp_auth_state_mismatch', message: 'state mismatch' } });
    expect((await api('POST', `/api/sessions/${S.id}/mcp/auth/callback`, { server: 'notion', callbackUrl: 'http://localhost:8087/callback?code=x&state=st-local' })).statusCode).toBe(202);
    await waitFor(async () => (await view(S.id)).servers.find(x => x.name === 'notion')?.lastError === en('stateMismatch'));
    const okOf = () => wsOf('mcp.auth').filter(m => m.sessionId === S.id && m.server === 'notion' && m.flow === null && m.result === 'ok').length;
    const before = okOf();
    agentSend(agents.get('hp')!, 'mcp.status', { sessionId: S.sid, snapshot: snap([srv('notion', 'connected', { transport: 'http' })]) });
    await waitFor(() => okOf() === before + 1);
    const v = await view(S.id);
    expect(v.authFlows).toEqual([]);
    expect(v.servers.find(x => x.name === 'notion')!.status).toBe('connected');
    expect(v.servers.find(x => x.name === 'notion')!.lastError).toBeUndefined();
    // the agent's mcp.auth.done after it: no second end
    const emits = wsOf('session.mcp').length;
    agentSend(agents.get('hp')!, 'mcp.auth.done', { sessionId: S.sid, server: 'notion', ok: true });
    await waitFor(() => wsOf('session.mcp').length > emits);
    expect(okOf()).toBe(before + 1);
  });

  it('the provider refused: «Вход не выполнен: access_denied», the address still went to the process', async () => {
    answer('mcp.auth.start', { result: { authUrl: 'https://p/authorize', redirect: 'hub', state: 'st-deny' } });
    await api('POST', `/api/sessions/${S.id}/mcp/auth`, { server: 'notion' });
    await waitFor(async () => (await view(S.id)).authFlows.length === 1);
    answer('mcp.auth.callback', { result: { snapshot: snap([srv('notion', 'needs-auth', { transport: 'http' })]) } });
    const r = await api('GET', `/mcp/oauth/callback?error=access_denied&state=st-deny`, undefined, {});
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Вход не выполнен: access_denied');
    expect(cmds('mcp.auth.callback').at(-1)!.payload.callbackUrl).toBe(`${CB}?error=access_denied&state=st-deny`);
    await waitFor(() => wsOf('mcp.auth').some(m => m.sessionId === S.id && m.result === 'failed' && m.error === 'access_denied'));
  });

  it('the paste fallback: localhost with the issued port and the state only; 404 without an attempt; mcp_auth_unsupported text', async () => {
    expect((await api('POST', `/api/sessions/${S.id}/mcp/auth/callback`, { server: 'notion', callbackUrl: 'http://localhost:53412/callback?code=a&state=s' })).json()).toMatchObject({
      error: 'no_auth_flow',
    });
    answer('mcp.auth.start', { result: { authUrl: 'https://p/authorize', redirect: 'localhost', state: 'st-local', callbackPort: 53412 } });
    await api('POST', `/api/sessions/${S.id}/mcp/auth`, { server: 'notion' });
    const f = await waitFor(async () => (await view(S.id)).authFlows[0]);
    expect(f).toMatchObject({ redirect: 'localhost', callbackPort: 53412 });
    const paste = (u: string) => api('POST', `/api/sessions/${S.id}/mcp/auth/callback`, { server: 'notion', callbackUrl: u });
    expect((await paste('http://evil.example:53412/callback?code=a&state=st-local')).json()).toMatchObject({ error: 'bad_callback_url' });
    expect((await paste('http://localhost:1/callback?code=a&state=st-local')).json()).toMatchObject({ error: 'bad_callback_url' });
    expect((await paste('http://localhost:53412/callback?code=a&state=other')).json()).toMatchObject({ error: 'bad_callback_url', message: MCP_TEXTS.stateMismatch });
    expect((await paste('http://localhost:53412/callback?state=st-local')).json()).toMatchObject({ error: 'bad_callback_url', message: MCP_TEXTS.stateMismatch });
    const before = cmds('mcp.auth.callback').length;
    answer('mcp.auth.callback', { result: { snapshot: snap([srv('vw', 'connected'), srv('notion', 'connected', { transport: 'http' })]) } });
    const r = await paste(`http://127.0.0.1:53412/callback?code=${SECRET_CODE}&state=st-local`);
    expect(r.statusCode, r.body).toBe(202);
    await waitFor(() => cmds('mcp.auth.callback').length === before + 1);
    await waitFor(async () => (await view(S.id)).authFlows.length === 0);

    answer('mcp.auth.start', { error: { code: 'mcp_auth_unsupported', message: 'Server type "stdio" does not support OAuth authentication' } });
    await api('POST', `/api/sessions/${S.id}/mcp/auth`, { server: 'notion' });
    await waitFor(() => wsOf('mcp.auth').some(m => m.result === 'failed' && m.error === en('authUnsupported')));
  });

  it('an unsafe authUrl of the agent: the refusal in Russian, no attempt', async () => {
    answer('mcp.auth.start', { result: { authUrl: 'http://evil.example/authorize', redirect: 'hub', state: 'st-http' } });
    await api('POST', `/api/sessions/${S.id}/mcp/auth`, { server: 'notion' });
    const m = await waitFor(() => wsOf('mcp.auth').find(x => x.sessionId === S.id && x.result === 'failed' && x.error === render(MCP_AUTH_URL_REFUSED, 'en')));
    expect(m.error).toBe('The sign-in address from the agent was refused: https is required (http only for localhost)');
    expect((await view(S.id)).authFlows).toEqual([]);
  });

  it('the process exits during an attempt: mcp.auth process_exited with the spec text', async () => {
    answer('mcp.auth.start', { result: { authUrl: 'https://p/authorize', redirect: 'hub', state: 'st-exit' } });
    await api('POST', `/api/sessions/${S.id}/mcp/auth`, { server: 'notion' });
    await waitFor(async () => (await view(S.id)).authFlows.length === 1);
    agentSend(agents.get('hp')!, 'session.exited', { sessionId: S.sid, code: 0, reason: 'stopped' });
    const m = await waitFor(() => wsOf('mcp.auth').find(x => x.sessionId === S.id && x.result === 'process_exited'));
    expect(m).toMatchObject({ sessionId: S.id, server: 'notion', flow: null, error: en('processExited') });
    expect((await view(S.id)).authFlows).toEqual([]);
    expect((await api('GET', `/mcp/oauth/callback?code=x&state=st-exit`, undefined, {})).statusCode).toBe(403);
  });

  it('«Проверить»: 202 probing, the result in runner.mcp (source probe); again within 30 s → 429 + Retry-After; offline → 409', async () => {
    answer('mcp.machine.probe', { result: { snapshot: snap([srv('krisp', 'connected', { transport: 'http' }), srv('proj', 'failed', { scope: 'project' })]), durationMs: 1800 } });
    const r = await api('POST', '/api/runners/hp/mcp/probe', {});
    expect(r.statusCode, r.body).toBe(202);
    expect((r.json() as McpMachineView).probing).toBe(true);
    const m = await waitFor(async () => {
      const v = (await api('GET', '/api/runners/hp/mcp')).json() as McpMachineView;
      return !v.probing && v.source === 'probe' ? v : null;
    });
    expect(m.servers.map(s => s.name)).toEqual(['krisp']);
    expect(m.probeAt).not.toBeNull();
    expect(m.probeAvailableAt).not.toBeNull();
    await waitFor(() => wsOf('runner.mcp').some(x => x.runnerId === 'hp' && (x.mcp as McpMachineView).source === 'probe'));
    const again = await api('POST', '/api/runners/hp/mcp/probe', {});
    expect(again.statusCode).toBe(429);
    expect(again.json()).toMatchObject({ error: 'probe_too_soon' });
    expect(Number(again.headers['retry-after'])).toBeGreaterThan(0);
    expect((await api('POST', '/api/runners/x1/mcp/probe', {})).json()).toMatchObject({ error: 'runner_offline' });
    expect((await api('GET', '/api/runners/nope/mcp')).statusCode).toBe(404);
  });

  // ---------- mcp-auth-controls (task 3.2) ----------

  const fleet = (status: McpServerSnapshot['status'], o: Partial<McpServerSnapshot> = {}) => srv('fleet', status, { transport: 'http', target: 'https://scanners.example/mcp', oauth: true, ...o });

  it('sign-out on an agent of 1.7: 409 agent_outdated, nothing sent; the view has no authControls', async () => {
    const H = await session('hp');
    agentSend(agents.get('hp')!, 'mcp.status', { sessionId: H.sid, snapshot: snap([fleet('connected')]) });
    await waitFor(async () => (await view(H.id)).servers.length === 1);
    const v = await view(H.id);
    expect(v.authControls).toBe(false);
    expect(v.servers[0]).toMatchObject({ oauth: true, authError: false });
    const before = got.length;
    const r = await api('POST', `/api/sessions/${H.id}/mcp/logout`, { server: 'fleet' });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: 'agent_outdated', message: MCP_TEXTS.agentOutdated });
    expect(got.slice(before).filter(c => c.type.startsWith('mcp.'))).toEqual([]);
    expect(((await api('GET', '/api/runners/hp/mcp')).json() as McpMachineView).authControls).toBe(false);
  });

  it('sign-out on 1.8: 202 «logout» pending, mcp.auth.logout to the agent, an open sign-in of another session of the machine ends, then needs-auth', async () => {
    const A = await session('new');
    const B = await session('new');
    for (const x of [A, B]) agentSend(agents.get('new')!, 'mcp.status', { sessionId: x.sid, snapshot: snap([fleet('connected'), srv('vw', 'connected')]) });
    await waitFor(async () => (await view(A.id)).servers.length === 2 && (await view(B.id)).servers.length === 2);
    const v = await view(A.id);
    expect(v.authControls).toBe(true);
    expect(v.servers.find(s => s.name === 'fleet')).toMatchObject({ oauth: true, canAuth: true });
    expect(((await api('GET', '/api/runners/new/mcp')).json() as McpMachineView).authControls).toBe(true);
    // «Войти заново» in B leaves an attempt open
    answer('mcp.auth.start', { result: { authUrl: 'https://scanners.example/authorize', redirect: 'localhost', state: 'st-new-b', callbackPort: 53412 } });
    expect((await api('POST', `/api/sessions/${B.id}/mcp/auth`, { server: 'fleet' })).statusCode).toBe(202);
    await waitFor(async () => (await view(B.id)).authFlows.length === 1);

    answer('mcp.auth.logout', { result: { snapshot: snap([fleet('needs-auth'), srv('vw', 'connected')]) } });
    const r = await api('POST', `/api/sessions/${A.id}/mcp/logout`, { server: 'fleet' });
    expect(r.statusCode, r.body).toBe(202);
    expect((r.json() as McpSessionView).servers.find(s => s.name === 'fleet')!.pendingAction).toBe('logout');
    await waitFor(() => cmds('mcp.auth.logout').length === 1);
    expect(cmds('mcp.auth.logout')[0]!.payload).toEqual({ sessionId: A.sid, server: 'fleet' });
    const after = await waitFor(async () => {
      const x = await view(A.id);
      const f = x.servers.find(s => s.name === 'fleet');
      return f?.status === 'needs-auth' && !f.pendingAction ? x : null;
    });
    expect(after.servers.find(s => s.name === 'fleet')!.lastError).toBeUndefined();
    expect((await view(B.id)).authFlows).toEqual([]);
    await waitFor(() => wsOf('mcp.auth').some(m => m.sessionId === B.id && m.flow === null && m.result === 'expired'));
  });

  it('«Войти заново» of a connected server: a `connected` snapshot does not end the attempt; after needs-auth it does; mcp.auth.done ends it too', async () => {
    const A = await session('new');
    agentSend(agents.get('new')!, 'mcp.status', { sessionId: A.sid, snapshot: snap([fleet('connected')]) });
    await waitFor(async () => (await view(A.id)).servers.length === 1);
    answer('mcp.auth.start', { result: { authUrl: 'https://scanners.example/authorize', redirect: 'hub', state: 'st-re-1' } });
    expect((await api('POST', `/api/sessions/${A.id}/mcp/auth`, { server: 'fleet' })).statusCode).toBe(202);
    await waitFor(async () => (await view(A.id)).authFlows.length === 1);
    // the process still holds its old connection: the CLI has dropped the token, the sign-in is not done
    agentSend(agents.get('new')!, 'mcp.status', { sessionId: A.sid, snapshot: snap([fleet('connected', { toolCount: 3 })]) });
    await waitFor(async () => (await view(A.id)).servers[0]?.toolCount === 3);
    expect((await view(A.id)).authFlows).toHaveLength(1);
    // the server left `connected`, then connected again (the CLI's own localhost callback): the attempt ends with ok
    agentSend(agents.get('new')!, 'mcp.status', { sessionId: A.sid, snapshot: snap([fleet('needs-auth')]) });
    await waitFor(async () => (await view(A.id)).servers[0]?.status === 'needs-auth');
    expect((await view(A.id)).authFlows).toHaveLength(1);
    agentSend(agents.get('new')!, 'mcp.status', { sessionId: A.sid, snapshot: snap([fleet('connected')]) });
    await waitFor(async () => (await view(A.id)).authFlows.length === 0);
    expect(wsOf('mcp.auth').some(m => m.sessionId === A.id && m.flow === null && m.result === 'ok')).toBe(true);

    // a second attempt on a connected server ends by mcp.auth.done
    answer('mcp.auth.start', { result: { authUrl: 'https://scanners.example/authorize', redirect: 'hub', state: 'st-re-2' } });
    expect((await api('POST', `/api/sessions/${A.id}/mcp/auth`, { server: 'fleet' })).statusCode).toBe(202);
    await waitFor(async () => (await view(A.id)).authFlows.length === 1);
    agentSend(agents.get('new')!, 'mcp.auth.done', { sessionId: A.sid, server: 'fleet', ok: true });
    await waitFor(async () => (await view(A.id)).authFlows.length === 0);
  });

  it('«Войти заново»: a needs-auth snapshot stored while the agent answers mcp.auth.start counts — the next connected one ends the attempt', async () => {
    const A = await session('new');
    agentSend(agents.get('new')!, 'mcp.status', { sessionId: A.sid, snapshot: snap([fleet('connected')]) });
    await waitFor(async () => (await view(A.id)).servers.length === 1);
    answer('mcp.auth.start', 'hang');
    const before = cmds('mcp.auth.start').length;
    expect((await api('POST', `/api/sessions/${A.id}/mcp/auth`, { server: 'fleet' })).statusCode).toBe(202);
    await waitFor(() => cmds('mcp.auth.start').length === before + 1);
    agentSend(agents.get('new')!, 'mcp.status', { sessionId: A.sid, snapshot: snap([fleet('needs-auth')]) });
    await waitFor(async () => (await view(A.id)).servers[0]?.status === 'needs-auth');
    const start = cmds('mcp.auth.start').at(-1)!;
    agents
      .get('new')!
      .ws.send(JSON.stringify(envelope('cmd.ok', { result: { authUrl: 'https://scanners.example/authorize', redirect: 'localhost', state: 'st-race', callbackPort: 53412 } }, { re: start.id! })));
    await waitFor(async () => (await view(A.id)).authFlows.length === 1);
    agentSend(agents.get('new')!, 'mcp.status', { sessionId: A.sid, snapshot: snap([fleet('connected')]) });
    await waitFor(async () => (await view(A.id)).authFlows.length === 0);
  });

  it('sign-out refused by the agent: lastError with the text; stdio → 422; unknown → 422; a bad body → 400; no Origin → 403', async () => {
    const A = await session('new');
    agentSend(agents.get('new')!, 'mcp.status', { sessionId: A.sid, snapshot: snap([fleet('connected'), srv('vw', 'connected')]) });
    await waitFor(async () => (await view(A.id)).servers.length === 2);
    const text = 'Выход из хаба не поддерживается этой версией Claude Code на машине — выполните claude mcp logout fleet в терминале';
    answer('mcp.auth.logout', { error: { code: 'mcp_auth_unsupported', message: text } });
    expect((await api('POST', `/api/sessions/${A.id}/mcp/logout`, { server: 'fleet' })).statusCode).toBe(202);
    const v = await waitFor(async () => {
      const x = await view(A.id);
      return x.servers.find(s => s.name === 'fleet')?.lastError ? x : null;
    });
    expect(v.servers.find(s => s.name === 'fleet')).toMatchObject({ status: 'connected', lastError: en('logoutUnsupported', { server: 'fleet' }) });
    expect((await api('POST', `/api/sessions/${A.id}/mcp/logout`, { server: 'vw' })).json()).toMatchObject({ error: 'mcp_auth_unsupported' });
    expect((await api('POST', `/api/sessions/${A.id}/mcp/logout`, { server: 'nope' })).json()).toMatchObject({ error: 'mcp_unknown_server' });
    expect((await api('POST', `/api/sessions/${A.id}/mcp/logout`, {})).statusCode).toBe(400);
    expect((await api('POST', `/api/sessions/${A.id}/mcp/logout`, { server: 'fleet' }, {})).statusCode).toBe(403);
  });

  it('sign-out of a sleeping session: it wakes up (resume), the status is read until the server left pending, then mcp.auth.logout', async () => {
    const W = await session('new');
    agentSend(agents.get('new')!, 'mcp.status', { sessionId: W.sid, snapshot: snap([fleet('connected')]) });
    await waitFor(async () => (await view(W.id)).servers.length === 1);
    await asleep(W.id);
    const before = got.length;
    answer('mcp.status.get', { result: { snapshot: snap([fleet('pending')]) } }, { result: { snapshot: snap([fleet('connected')]) } });
    answer('mcp.auth.logout', { result: { snapshot: snap([fleet('needs-auth')]) } });
    const r = await api('POST', `/api/sessions/${W.id}/mcp/logout`, { server: 'fleet' });
    expect(r.statusCode, r.body).toBe(202);
    expect((r.json() as McpSessionView).waking).toBe(true);
    await waitFor(() => got.slice(before).some(c => c.type === 'mcp.auth.logout'));
    expect(
      got
        .slice(before)
        .map(c => c.type)
        .filter(x => x.startsWith('mcp.') || x === 'session.resume'),
    ).toEqual(['session.resume', 'mcp.status.get', 'mcp.status.get', 'mcp.auth.logout']);
    await waitFor(async () => {
      const x = await view(W.id);
      return x.servers[0]?.status === 'needs-auth' && !x.servers[0]?.pendingAction && !x.waking;
    });
  });

  it('the code of a callback never reaches the hub log', () => {
    const all = logs.join('\n');
    expect(all).toContain('/mcp/oauth/callback?[redacted]');
    expect(all).not.toContain(SECRET_CODE);
  });
});
