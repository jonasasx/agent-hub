// Spec «runners»: token auth, versioned protocol, replacement, heartbeat — against a real hub and Postgres.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { envelope } from '@agent-hub/shared';
import { connectFakeAgent, helloPayload, startTestHub, waitFor, type TestHub } from '../test/harness.js';
import { getRunner, issueRunnerToken } from './repo.js';
import { UPDATE_RETRY_FAILED_MS, UPDATE_RETRY_INSTALLING_MS, updateOfferHeld } from './agentGateway.js';

describe('/ws/agent (integration)', () => {
  let t: TestHub;
  const logs: string[] = [];
  let hpToken: string;

  beforeAll(async () => {
    t = await startTestHub({
      agentGateway: { heartbeatIntervalMs: 100, heartbeatTimeoutMs: 400, helloTimeoutMs: 1000 },
      logStream: { write: l => void logs.push(l) },
    });
    hpToken = await t.addRunner('hp', 'HP');
  });
  afterAll(async () => t.close());

  it('Неверный токен: closes with 4401, runner stays offline, the token is not logged', async () => {
    const bogus = 'bogus-token-value-0123456789';
    const a = connectFakeAgent(t.wsBase, bogus);
    expect((await a.closed).code).toBe(4401);
    const none = connectFakeAgent(t.wsBase, null);
    expect((await none.closed).code).toBe(4401);
    expect((await getRunner(t.tdb.db, 'hp'))!.online).toBe(false);
    const all = logs.join('\n');
    expect(all).toContain('agent rejected: invalid token');
    expect(all).not.toContain(bogus);
    expect(all).not.toContain(hpToken);
  });

  it('hello → welcome, runner online with machine facts from hello', async () => {
    // A 1.0 agent (M2) and the 1.5 hub talk: minor versions do not break the connection; the hub records 1.0.
    const a = connectFakeAgent(t.wsBase, hpToken, { protocol: '1.0' });
    const welcome = await a.next('welcome');
    expect(welcome.payload).toEqual({ runnerId: 'hp', protocol: '1.19', cursors: [] });
    const r = await waitFor(async () => {
      const row = await getRunner(t.tdb.db, 'hp');
      return row?.online ? row : null;
    });
    expect(r).toMatchObject({
      hostname: 'HP-Elitebook',
      os: 'Windows 11 Pro',
      home_dir: 'C:\\Users\\alice',
      vault_root: 'C:\\Users\\alice\\vault',
      agent_version: '0.1.0',
      sdk_version: '0.3.310',
      claude_version: '2.1.310',
      protocol_version: '1.0',
    });
    expect(t.hub.agents.isOnline('hp')).toBe(true);
    a.ws.close();
    await waitFor(async () => !(await getRunner(t.tdb.db, 'hp'))!.online);
  });

  // Change multi-user, task 4.3: tokens of a disabled runner and of a disabled user's runner are refused.
  it('the token of a disabled runner and of a runner of a disabled user → 4401; enabling the user lets it in again', async () => {
    const token = await t.addRunner('dis', 'DIS');
    await t.tdb.pool.query(`UPDATE users SET status = 'disabled' WHERE email = 'alice@example.com'`);
    try {
      expect((await connectFakeAgent(t.wsBase, token).closed).code).toBe(4401);
    } finally {
      await t.tdb.pool.query(`UPDATE users SET status = 'active' WHERE email = 'alice@example.com'`);
    }
    const ok = connectFakeAgent(t.wsBase, token, { hostname: 'dis-host' });
    await ok.next('welcome');
    ok.ws.close();
    await ok.closed;
    await t.tdb.pool.query(`UPDATE runners SET state = 'disabled' WHERE id = 'dis'`);
    expect((await connectFakeAgent(t.wsBase, token).closed).code).toBe(4401);
  });

  it('Несовместимая версия: 2.0 → 4426, runner marked incompatible', async () => {
    const token = await t.addRunner('x1', 'X1');
    const a = connectFakeAgent(t.wsBase, token, { protocol: '2.0', someNewRequiredThing: { x: 1 } });
    const closed = await a.closed;
    expect(closed.code).toBe(4426);
    expect(closed.reason).toMatch(/incompatible protocol 2\.0/);
    const row = await getRunner(t.tdb.db, 'x1');
    expect(row!.online).toBe(false);
    expect(row!.protocol_version).toBe('2.0');
    const session = await t.login();
    const sidebar = await t.hub.app.inject({ method: 'GET', url: '/api/sidebar', cookies: { ah_session: session } });
    const x1 = (sidebar.json() as { runners: Array<{ id: string; incompatible: boolean }> }).runners.find(r => r.id === 'x1');
    expect(x1!.incompatible).toBe(true);
  });

  it('a first message other than hello, or an invalid hello, closes with 1008', async () => {
    const a = connectFakeAgent(t.wsBase, hpToken, false);
    a.ws.on('open', () => a.ws.send(JSON.stringify(envelope('session.state', { sessionId: 'x', state: 'working', processAlive: true }))));
    expect((await a.closed).code).toBe(1008);
    const b = connectFakeAgent(t.wsBase, hpToken, { hostname: '' });
    expect((await b.closed).code).toBe(1008);
  });

  it('Второе соединение того же раннера: the previous one is closed with 4409', async () => {
    const first = connectFakeAgent(t.wsBase, hpToken);
    await first.next('welcome');
    const second = connectFakeAgent(t.wsBase, hpToken);
    await second.next('welcome');
    expect((await first.closed).code).toBe(4409);
    expect(second.ws.readyState).toBe(WebSocket.OPEN);
    expect((await getRunner(t.tdb.db, 'hp'))!.online).toBe(true);
    second.ws.close();
    await waitFor(async () => !(await getRunner(t.tdb.db, 'hp'))!.online);
  });

  it('Перевыпуск токена: the live connection closes with 4401, the old token is refused, the new one works', async () => {
    const a = connectFakeAgent(t.wsBase, hpToken);
    await a.next('welcome');
    const newToken = await issueRunnerToken(t.tdb.db, 'hp');
    expect((await a.closed).code).toBe(4401);
    const old = connectFakeAgent(t.wsBase, hpToken);
    expect((await old.closed).code).toBe(4401);
    const fresh = connectFakeAgent(t.wsBase, newToken);
    await fresh.next('welcome');
    hpToken = newToken;
    fresh.ws.close();
    await fresh.closed;
  });

  it('heartbeat: an agent that stops answering pings is dropped and marked offline', async () => {
    const ws = new WebSocket(`${t.wsBase}/ws/agent`, { headers: { Authorization: `Bearer ${hpToken}` }, autoPong: false });
    ws.on('open', () => ws.send(JSON.stringify(envelope('hello', helloPayload()))));
    const closed = new Promise<number>(r => ws.on('close', c => r(c)));
    ws.on('error', () => undefined);
    await waitFor(async () => (await getRunner(t.tdb.db, 'hp'))!.online);
    const timeoutsBefore = logs.filter(l => l.includes('agent heartbeat timeout')).length;
    // The cause is asserted by the hub's own event, not by wall-clock time: under a loaded full run
    // the drop can take several heartbeat checks, and a fixed time bound turned flaky.
    expect(await closed).toBe(1006);
    expect(logs.filter(l => l.includes('agent heartbeat timeout')).length).toBe(timeoutsBefore + 1);
    await waitFor(async () => !(await getRunner(t.tdb.db, 'hp'))!.online);
  });

  it('commands resolve on cmd.ok and reject on cmd.error; unknown types are ignored', async () => {
    const a = connectFakeAgent(t.wsBase, hpToken);
    await a.next('welcome');
    a.ws.on('message', d => {
      const m = JSON.parse(d.toString()) as { type: string; id?: string; payload: { path?: string } };
      if (m.type !== 'fs.stat' || !m.id) return;
      if (m.payload.path === 'C:\\missing') a.ws.send(JSON.stringify(envelope('cmd.error', { code: 'ENOENT', message: 'nope' }, { re: m.id })));
      else a.ws.send(JSON.stringify(envelope('cmd.ok', { result: { exists: true, isDir: true } }, { re: m.id })));
    });
    a.ws.send(JSON.stringify(envelope('future.type', { x: 1 })));
    const conn = t.hub.agents.get('hp')!;
    await expect(conn.request('fs.stat', { path: 'C:\\Users' })).resolves.toEqual({ exists: true, isDir: true });
    await expect(conn.request('fs.stat', { path: 'C:\\missing' })).rejects.toMatchObject({ code: 'ENOENT' });
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
    expect(logs.join('\n')).toContain('unknown agent message type ignored');
    a.ws.close();
    await a.closed;
  });

  it('does not log payload values from invalid or unknown secret-bearing MCP messages', async () => {
    const a = connectFakeAgent(t.wsBase, hpToken);
    await a.next('welcome');
    const importValue = 'INVALID_IMPORT_SECRET_2ed1';
    const draftValue = 'INVALID_DRAFT_SECRET_9f3c';
    const unknownValue = 'INVALID_UNKNOWN_MCP_SECRET_71a4';
    const before = logs.length;
    a.ws.send(
      JSON.stringify(
        envelope('mcp.import.preview.result', {
          importId: 'invalid-import-id',
          servers: [],
          secretsCaptured: 1,
          warnings: [],
          secretValues: [{ serverName: 'invalid', location: 'env', key: 'TOKEN', value: importValue }],
        }),
      ),
    );
    a.ws.send(
      JSON.stringify(
        envelope('mcp.draft.request', {
          requestId: randomUUID(),
          sessionId: randomUUID(),
          op: 'add',
          payload: { secrets: [{ name: 'API_TOKEN', value: draftValue }] },
        }),
      ),
    );
    a.ws.send(JSON.stringify(envelope('mcp.future.credentials', { accessToken: unknownValue })));
    await waitFor(() => logs.slice(before).length >= 3);
    const recent = logs.slice(before).join('\n');
    expect(recent).toContain('mcp.import.preview.result');
    expect(recent).toContain('mcp.draft.request');
    expect(recent).toContain('mcp.future.credentials');
    expect(recent).toContain('issuePaths');
    expect(recent).not.toContain(importValue);
    expect(recent).not.toContain(draftValue);
    expect(recent).not.toContain(unknownValue);
    a.ws.close();
    await a.closed;
  });
});

describe('updateOfferHeld (Requirement: Самообновление агента, design M5)', () => {
  const now = Date.parse('2026-10-27T12:00:00Z');
  const at = (ms: number) => new Date(now - ms).toISOString();
  const st = (status: 'sent' | 'waiting' | 'installing' | 'failed', ago: number, error: string | null = null, sha256?: string) => ({
    version: '0.2.0',
    status,
    error,
    at: at(ago),
    ...(sha256 ? { sha256 } : {}),
  });
  it('failed: held for 6 h; sha_mismatch is held only for the same build SHA', () => {
    expect(updateOfferHeld(st('failed', UPDATE_RETRY_FAILED_MS - 1000, 'install_failed: npm'), '0.2.0', 'sha', now)).toBe(true);
    expect(updateOfferHeld(st('failed', UPDATE_RETRY_FAILED_MS, 'install_failed: npm'), '0.2.0', 'sha', now)).toBe(false);
    expect(updateOfferHeld(st('failed', 30 * 24 * 3600_000, 'sha_mismatch: expected a, got b', 'old-sha'), '0.2.0', 'old-sha', now)).toBe(true);
    expect(updateOfferHeld(st('failed', 30 * 24 * 3600_000, 'sha_mismatch: expected a, got b', 'old-sha'), '0.2.0', 'new-sha', now)).toBe(false);
    const oldSha = 'a'.repeat(64);
    const oldState = st('failed', 30 * 24 * 3600_000, `sha_mismatch: expected ${oldSha}, got b`);
    expect(updateOfferHeld(oldState, '0.2.0', oldSha, now)).toBe(true);
    expect(updateOfferHeld(oldState, '0.2.0', 'c'.repeat(64), now)).toBe(false);
  });
  it('installing without a result: held for 1 h, then offered again', () => {
    expect(updateOfferHeld(st('installing', UPDATE_RETRY_INSTALLING_MS - 1000), '0.2.0', 'sha', now)).toBe(true);
    expect(updateOfferHeld(st('installing', UPDATE_RETRY_INSTALLING_MS + 1000), '0.2.0', 'sha', now)).toBe(false);
  });
  it('another build version, no state, sent/waiting: not held', () => {
    expect(updateOfferHeld(st('failed', 0, 'sha_mismatch'), '0.3.0', 'sha', now)).toBe(false);
    expect(updateOfferHeld(null, '0.2.0', 'sha', now)).toBe(false);
    expect(updateOfferHeld(st('sent', 0), '0.2.0', 'sha', now)).toBe(false);
    expect(updateOfferHeld(st('waiting', 0), '0.2.0', 'sha', now)).toBe(false);
  });
});
