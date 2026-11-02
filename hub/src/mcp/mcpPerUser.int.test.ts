// mcp-management task 4.5 (Requirement: Права на MCP; Защита потока входа MCP — «Чужой пользователь открыл адрес
// возврата»): Ivan (the admin) and Bob, each with a machine (agent 1.7) and a session; reads, actions, sign-in,
// the callback, the machine block and its probe, WS events never cross. Pattern of limitsPerUser.int.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { envelope, type McpSessionView, type SessionView } from '@agent-hub/shared';
import { PUBLIC_URL, agentSend, connectFakeAgent, connectUi, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';
import { issueRunnerToken } from '../runners/repo.js';

const VAULT = 'C:\\Users\\alice\\vault';

interface Cmd {
  type: string;
  id?: string;
  payload: Record<string, unknown>;
  runner: string;
}

describe('MCP per user (integration, 4.5)', () => {
  let t: TestHub;
  let ivan: string;
  let bob: string;
  let ivanUi: ReturnType<typeof connectUi>;
  let kUi: ReturnType<typeof connectUi>;
  const got: Cmd[] = [];
  const agents = new Map<string, FakeAgent>();
  let I: { id: string; sid: string };
  let K: { id: string; sid: string };

  const api = (cookie: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    t.hub.app.inject({ method, url, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, ...(payload !== undefined ? { payload: payload as object } : {}) });

  function machine(runner: string, token: string, hostname: string): FakeAgent {
    const a = connectFakeAgent(t.wsBase, token, { protocol: '1.7', hostname, homeDir: 'C:\\Users\\u', os: 'Windows 11 Pro' });
    a.ws.on('message', d => {
      const m = JSON.parse(d.toString()) as Cmd;
      if (!m.id) return;
      got.push({ ...m, runner });
      const snapshot = { servers: [{ name: 'notion', status: 'needs-auth', transport: 'http', scope: 'user', toolCount: 0 }], observedAt: Date.now() };
      const result =
        m.type === 'fs.stat'
          ? { exists: true, isDir: true }
          : m.type === 'session.start'
            ? { models: [] }
            : m.type === 'mcp.auth.start'
              ? { authUrl: 'https://p/authorize', redirect: 'hub', state: `st-${runner}` }
              : m.type.startsWith('mcp.')
                ? { snapshot, durationMs: 1 }
                : {};
      a.ws.send(JSON.stringify(envelope('cmd.ok', { result }, { re: m.id })));
    });
    agents.set(runner, a);
    return a;
  }

  async function session(cookie: string, runner: string): Promise<{ id: string; sid: string }> {
    const r = await api(cookie, 'POST', '/api/sessions', { runnerId: runner, cwd: VAULT, model: 'haiku', prompt: 'hi' });
    expect(r.statusCode, r.body).toBe(201);
    const id = (r.json() as SessionView).id;
    const sid = (await t.tdb.pool.query(`SELECT claude_session_id FROM sessions WHERE id = $1`, [id])).rows[0].claude_session_id as string;
    agentSend(agents.get(runner)!, 'session.result', { sessionId: sid, subtype: 'success', isError: false, durationMs: 1, costUsd: 0 });
    agentSend(agents.get(runner)!, 'mcp.status', {
      sessionId: sid,
      snapshot: { servers: [{ name: 'notion', status: 'needs-auth', transport: 'http', scope: 'user', toolCount: 0 }], observedAt: Date.now() },
    });
    await waitFor(async () => ((await api(cookie, 'GET', `/api/sessions/${id}/mcp`)).json() as McpSessionView).servers?.length === 1);
    return { id, sid };
  }

  beforeAll(async () => {
    t = await startTestHub({ sessions: { idleCheckMs: 0, initTimeoutMs: 3000 } });
    ivan = await t.login();
    machine('hp', await t.addRunner('hp', 'HP Ивана'), 'hp-host');
    const inv = await api(ivan, 'POST', '/api/admin/invites', { email: 'bob@example.com', provider: 'google' });
    bob = await t.login({ email: 'bob@example.com' }, { invite: (inv.json().url as string).split('/invite/')[1]! });
    const bobId = (await api(bob, 'GET', '/api/me')).json().user.id as string;
    await t.tdb.pool.query(`INSERT INTO runners (id, user_id, name, hostname) VALUES ('r-bobhp01', $1, 'Ноутбук Кати', 'k-host')`, [bobId]);
    machine('r-bobhp01', await issueRunnerToken(t.tdb.db, 'r-bobhp01'), 'k-host');
    for (const a of agents.values()) await a.next('welcome');
    ivanUi = connectUi(t.wsBase, ivan);
    kUi = connectUi(t.wsBase, bob);
    await Promise.all([ivanUi.open, kUi.open]);
    I = await session(ivan, 'hp');
    K = await session(bob, 'r-bobhp01');
  }, 240_000);
  afterAll(async () => {
    for (const fakeAgent of agents.values()) expect(fakeAgent.protocolErrors).toEqual([]);
    ivanUi.ws.close();
    kUi.ws.close();
    await t.close();
  });

  it('another user — the admin too — gets 404 on every MCP route of a session and a machine, nothing reaches an agent', async () => {
    const before = got.length;
    for (const [who, other, s, runner] of [
      [bob, 'Борис → Иван', I, 'hp'],
      [ivan, 'админ Иван → Борис', K, 'r-bobhp01'],
    ] as const) {
      const calls: Array<[string, string, unknown?]> = [
        ['GET', `/api/sessions/${s.id}/mcp`],
        ['POST', `/api/sessions/${s.id}/mcp/refresh`, {}],
        ['POST', `/api/sessions/${s.id}/mcp/actions`, { server: 'notion', action: 'reconnect' }],
        ['POST', `/api/sessions/${s.id}/mcp/auth`, { server: 'notion' }],
        ['POST', `/api/sessions/${s.id}/mcp/auth/callback`, { server: 'notion', callbackUrl: 'http://localhost:1/callback?code=a&state=b' }],
        // mcp-auth-controls task 3.2: «Выйти» of another user's session
        ['POST', `/api/sessions/${s.id}/mcp/logout`, { server: 'notion' }],
        ['GET', `/api/runners/${runner}/mcp`],
        ['POST', `/api/runners/${runner}/mcp/probe`, {}],
      ];
      for (const [m, url, body] of calls) {
        const r = await api(who, m as 'GET' | 'POST', url, body);
        expect(r.statusCode, `${other}: ${m} ${url}`).toBe(404);
      }
    }
    await new Promise(r => setTimeout(r, 200));
    expect(got.slice(before).filter(c => c.type.startsWith('mcp.'))).toEqual([]);
  });

  it('WS session.mcp, mcp.auth and runner.mcp go to the owner only', async () => {
    const r = await api(ivan, 'POST', `/api/sessions/${I.id}/mcp/auth`, { server: 'notion' });
    expect(r.statusCode, r.body).toBe(202);
    await waitFor(() => ivanUi.received.some(m => m.type === 'mcp.auth' && m.sessionId === I.id && m.flow));
    await waitFor(() => ivanUi.received.some(m => m.type === 'runner.mcp' && m.runnerId === 'hp'));
    const kSees = kUi.received.filter(m => (m.type === 'session.mcp' || m.type === 'mcp.auth') && m.sessionId === I.id);
    expect(kSees).toEqual([]);
    expect(kUi.received.filter(m => m.type === 'runner.mcp' && m.runnerId === 'hp')).toEqual([]);
    expect(ivanUi.received.filter(m => (m.type === 'session.mcp' || m.type === 'mcp.auth') && m.sessionId === K.id)).toEqual([]);
  });

  it('Bob opens the return address with the state of Ivan’s attempt: 403, no code to the agent, Ivan’s attempt waits', async () => {
    const before = got.filter(c => c.type === 'mcp.auth.callback').length;
    const r = await t.hub.app.inject({ method: 'GET', url: '/mcp/oauth/callback?code=stolen&state=st-hp', cookies: { ah_session: bob } });
    expect(r.statusCode).toBe(403);
    expect(r.body).toContain('Попытка входа не найдена');
    expect(got.filter(c => c.type === 'mcp.auth.callback').length).toBe(before);
    expect(((await api(ivan, 'GET', `/api/sessions/${I.id}/mcp`)).json() as McpSessionView).authFlows).toHaveLength(1);
    // and Ivan's own return works
    const ok = await t.hub.app.inject({ method: 'GET', url: '/mcp/oauth/callback?code=c&state=st-hp', cookies: { ah_session: ivan } });
    expect(ok.statusCode).toBe(200);
    expect(got.filter(c => c.type === 'mcp.auth.callback' && c.runner === 'hp')).toHaveLength(1);
  });
});
