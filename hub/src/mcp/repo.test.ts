// Requirement: Статус MCP сессии; Отметка проблем MCP; MCP машины (mcp-management design M6, M8, task 4.1).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { McpServerSnapshot, McpSnapshot } from '@agent-hub/shared';
import { createTestDb, type TestDb } from '../test/db.js';
import { countProblems, persistenceOf, storeMachineServers, storeSessionSnapshot, toMachineMcpView, toSessionMcpView, userServers } from './repo.js';

const srv = (name: string, status: McpServerSnapshot['status'], o: Partial<McpServerSnapshot> = {}): McpServerSnapshot => ({ name, status, transport: 'stdio', toolCount: 0, ...o });
const snap = (at: number, servers: McpServerSnapshot[]): McpSnapshot => ({ servers, observedAt: at });

describe('MCP rules', () => {
  it('problems: failed and needs-auth; disabled, pending, unknown are not', () => {
    expect(countProblems([srv('a', 'failed'), srv('b', 'needs-auth'), srv('c', 'disabled'), srv('d', 'pending'), srv('e', 'unknown'), srv('f', 'connected')])).toBe(2);
  });

  it('the machine keeps user rows only', () => {
    expect(
      userServers([srv('a', 'connected', { scope: 'user' }), srv('b', 'connected', { scope: 'project' }), srv('c', 'connected', { scope: 'local' }), srv('d', 'connected')]).map(s => s.name),
    ).toEqual(['a']);
  });

  it('persistence and canAuth', () => {
    expect(persistenceOf({ scope: 'dynamic', transport: 'stdio' })).toBe('process');
    expect(persistenceOf({ scope: 'sdk', transport: 'sdk' })).toBe('process');
    expect(persistenceOf({ scope: 'user', transport: 'http' })).toBe('project');
    const v = toSessionMcpView(
      {
        is_hub_managed: true,
        process_alive: true,
        mcp_servers: [srv('n', 'needs-auth', { transport: 'http' }), srv('c', 'connected', { transport: 'claudeai-proxy' }), srv('s', 'failed')],
        mcp_observed_at: new Date(5),
      },
      { protocol: '1.7', online: true, states: new Map([['s', { pending: 'reconnect' as const, lastError: 'x' }]]) },
    );
    expect(v.servers.map(s => [s.name, s.canAuth, s.pendingAction ?? null, s.lastError ?? null])).toEqual([
      ['n', true, null, null],
      ['c', false, null, null],
      ['s', false, 'reconnect', 'x'],
    ]);
    expect(v).toMatchObject({ available: true, live: true, observedAt: new Date(5).toISOString(), waking: false, authFlows: [] });
    expect(v.reason).toBeUndefined();
  });

  it('mcp-auth-controls A1/A2/A4: oauth from the snapshot (http/sse only), authError of failed only, authControls from 1.8', () => {
    const rows = [
      srv('fleet', 'connected', { transport: 'http', oauth: true }),
      srv('waf', 'failed', { transport: 'http', error: 'HTTP 403: Forbidden' }),
      srv('old', 'connected', { transport: 'http' }),
      srv('odd', 'connected', { transport: 'stdio', oauth: true }),
      srv('401', 'failed', { transport: 'http', error: 'HTTP 401: Unauthorized' }),
      srv('refused', 'failed', { transport: 'http', error: 'connect ECONNREFUSED 127.0.0.1:4013' }),
      srv('na', 'needs-auth', { transport: 'sse', oauth: true, error: 'Unauthorized' }),
    ];
    const row = { is_hub_managed: true, process_alive: true, mcp_servers: rows, mcp_observed_at: new Date(5) };
    const v18 = toSessionMcpView(row, { protocol: '1.8', online: true });
    expect(v18.authControls).toBe(true);
    expect(v18.servers.map(s => [s.name, s.oauth, s.authError])).toEqual([
      ['fleet', true, false],
      ['waf', false, false],
      ['old', false, false],
      ['odd', false, false],
      ['401', false, true],
      ['refused', false, false],
      ['na', true, false],
    ]);
    expect(toSessionMcpView(row, { protocol: '1.7', online: true }).authControls).toBe(false);
    const machine = (protocol_version: string) =>
      toMachineMcpView(
        { protocol_version, mcp_servers: rows, mcp_observed_at: new Date(5), mcp_probe_at: null },
        { online: true, probing: false, probeAvailableAt: null, probeError: null, now: new Date() },
      );
    expect(machine('1.8')).toMatchObject({ authControls: true });
    expect(machine('1.7')).toMatchObject({ authControls: false });
    expect(machine('1.8').servers.find(s => s.name === 'fleet')).toMatchObject({ oauth: true, authError: false });
  });

  it('reasons: agent_outdated, not_hub_managed, no_snapshot', () => {
    const row = { is_hub_managed: true, process_alive: false, mcp_servers: null, mcp_observed_at: null };
    expect(toSessionMcpView(row, { protocol: '1.6', online: true })).toMatchObject({ available: false, reason: 'agent_outdated', live: false });
    expect(toSessionMcpView({ ...row, is_hub_managed: false }, { protocol: '1.7', online: true })).toMatchObject({ available: false, reason: 'not_hub_managed' });
    expect(toSessionMcpView(row, { protocol: '1.7', online: true })).toMatchObject({ available: true, reason: 'no_snapshot', servers: [] });
    const m = toMachineMcpView(
      { protocol_version: '1.6', mcp_servers: null, mcp_observed_at: null, mcp_probe_at: null },
      { online: true, probing: false, probeAvailableAt: null, probeError: null, now: new Date() },
    );
    expect(m).toMatchObject({ available: false, reason: 'agent_outdated', source: null, servers: [] });
  });
});

describe('MCP snapshots in Postgres', { timeout: 60_000 }, () => {
  let t: TestDb;
  let sid: string;
  beforeAll(async () => {
    t = await createTestDb();
    const uid = (await t.pool.query(`INSERT INTO users (email) VALUES ('r@x.y') RETURNING id`)).rows[0].id as string;
    await t.pool.query(`INSERT INTO runners (id, user_id, name) VALUES ('hp', $1, 'HP')`, [uid]);
    sid = (await t.pool.query(`INSERT INTO sessions (user_id, runner_id, claude_session_id, source, status) VALUES ($1, 'hp', $2, 'hub', 'waiting') RETURNING id`, [uid, randomUUID()])).rows[0]
      .id as string;
  });
  afterAll(async () => t.drop());

  it('an older snapshot does not overwrite a newer one; problems are counted on write', async () => {
    expect(await storeSessionSnapshot(t.db, sid, snap(2000, [srv('a', 'failed'), srv('b', 'needs-auth')]))).toEqual({ problemsChanged: true, becameConnected: [] });
    expect(await storeSessionSnapshot(t.db, sid, snap(1000, [srv('a', 'connected')]))).toBeNull();
    let row = (await t.pool.query(`SELECT mcp_servers, mcp_problems, mcp_observed_at FROM sessions WHERE id = $1`, [sid])).rows[0];
    expect(row.mcp_problems).toBe(2);
    expect(row.mcp_servers.map((s: McpServerSnapshot) => s.status)).toEqual(['failed', 'needs-auth']);
    expect(await storeSessionSnapshot(t.db, sid, snap(3000, [srv('a', 'connected'), srv('b', 'disabled')]))).toEqual({ problemsChanged: true, becameConnected: ['a'] });
    expect(await storeSessionSnapshot(t.db, sid, { ...snap(4000, [srv('a', 'connected'), srv('b', 'disabled')]), projectRoot: 'C:/Users/alice/vault' })).toEqual({
      problemsChanged: false,
      becameConnected: [],
    });
    expect((await t.pool.query(`SELECT mcp_project_root FROM sessions WHERE id = $1`, [sid])).rows[0].mcp_project_root).toBe('C:/Users/alice/vault');
    row = (await t.pool.query(`SELECT mcp_problems FROM sessions WHERE id = $1`, [sid])).rows[0];
    expect(row.mcp_problems).toBe(0);
    expect(await storeSessionSnapshot(t.db, randomUUID(), snap(5000, []))).toBeNull();
  });

  it('the machine: user rows of the newest source; a probe records its time; project rows never reach it', async () => {
    expect(await storeMachineServers(t.db, 'hp', snap(2000, [srv('u', 'connected', { scope: 'user' }), srv('p', 'failed', { scope: 'project' })]), 'session')).toBe(true);
    expect(await storeMachineServers(t.db, 'hp', snap(1500, [srv('u', 'failed', { scope: 'user' })]), 'probe')).toBe(false);
    let r = (await t.pool.query(`SELECT protocol_version, mcp_servers, mcp_observed_at, mcp_probe_at FROM runners WHERE id = 'hp'`)).rows[0];
    expect(r.mcp_servers).toEqual([srv('u', 'connected', { scope: 'user' })]);
    expect(r.mcp_probe_at).toEqual(new Date(1500));
    expect(toMachineMcpView({ ...r, protocol_version: '1.7' }, { online: true, probing: false, probeAvailableAt: null, probeError: null, now: new Date() }).source).toBe('session');
    expect(await storeMachineServers(t.db, 'hp', snap(2500, [srv('u', 'needs-auth', { scope: 'user' })]), 'probe')).toBe(true);
    r = (await t.pool.query(`SELECT mcp_servers, mcp_observed_at, mcp_probe_at FROM runners WHERE id = 'hp'`)).rows[0];
    const v = toMachineMcpView({ ...r, protocol_version: '1.7' }, { online: false, probing: true, probeAvailableAt: new Date(Date.now() + 10_000), probeError: null, now: new Date() });
    expect(v).toMatchObject({ available: true, source: 'probe', probing: true, online: false, probeAt: new Date(2500).toISOString() });
    expect(v.probeAvailableAt).not.toBeNull();
    expect(v.servers.map(s => s.status)).toEqual(['needs-auth']);
  });
});
