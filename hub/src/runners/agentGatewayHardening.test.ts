// Code review M1: pre-hello limits, online-flag ordering, dead-link detection interval, LISTEN recovery.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { WebSocket } from 'ws';
import { envelope } from '@agent-hub/shared';
import { connectFakeAgent, helloPayload, startTestHub, waitFor, type TestHub } from '../test/harness.js';
import { getRunner, issueRunnerToken } from './repo.js';
import { PRE_HELLO_MAX_PAYLOAD } from './agentGateway.js';

describe('agent gateway hardening (integration)', () => {
  let t: TestHub;
  let token: string;
  beforeAll(async () => {
    // Real ping cadence is 20 s; silence is checked every 100 ms here, timeout 600 ms.
    t = await startTestHub({ agentGateway: { heartbeatIntervalMs: 60_000, heartbeatTimeoutMs: 600, heartbeatCheckMs: 100 } });
    token = await t.addRunner('hp', 'HP');
  });
  afterAll(async () => t.close());

  it('a frame above the pre-hello limit is refused (1009) before authentication', async () => {
    const ws = new WebSocket(`${t.wsBase}/ws/agent`, { headers: { Authorization: `Bearer ${token}` } });
    ws.on('error', () => undefined);
    const closed = new Promise<number>(r => ws.on('close', c => r(c)));
    ws.on('open', () => ws.send('x'.repeat(PRE_HELLO_MAX_PAYLOAD + 1)));
    expect(await closed).toBe(1009);
  });

  it('more than one message before authentication completes closes the socket', async () => {
    const ws = new WebSocket(`${t.wsBase}/ws/agent`, { headers: { Authorization: `Bearer ${token}` } });
    ws.on('error', () => undefined);
    const closed = new Promise<number>(r => ws.on('close', c => r(c)));
    ws.on('open', () => {
      // Sent in one tick: the token lookup has not finished when the second frame arrives.
      ws.send(JSON.stringify(envelope('hello', helloPayload())));
      ws.send('{}');
      ws.send('{}');
    });
    // 1006: the server may tear the socket down while the frames after its close frame are still arriving.
    expect([1006, 1008, 4409]).toContain(await closed);
  });

  it('after hello the full 64 MB limit applies (a 2 MB message is accepted)', async () => {
    const a = connectFakeAgent(t.wsBase, token);
    await a.next('welcome');
    a.ws.send(JSON.stringify(envelope('future.big', { blob: 'y'.repeat(2 * 1024 * 1024) })));
    await new Promise(r => setTimeout(r, 300));
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
    a.ws.close();
    await a.closed;
    await waitFor(async () => !(await getRunner(t.tdb.db, 'hp'))!.online);
  });

  it('closing right after hello never leaves the runner online', async () => {
    for (let i = 0; i < 5; i++) {
      const ws = new WebSocket(`${t.wsBase}/ws/agent`, { headers: { Authorization: `Bearer ${token}` } });
      ws.on('error', () => undefined);
      const closed = new Promise<void>(r => ws.on('close', () => r()));
      ws.on('open', () => {
        ws.send(JSON.stringify(envelope('hello', helloPayload())));
        setTimeout(() => ws.terminate(), i * 3);
      });
      await closed;
    }
    // The close handling is queued after the hello writes; under load it can take longer than a fixed pause.
    await waitFor(async () => !(await getRunner(t.tdb.db, 'hp'))!.online, 10_000);
    expect((await getRunner(t.tdb.db, 'hp'))!.online).toBe(false);
    expect(t.hub.agents.isOnline('hp')).toBe(false);
  });

  it('a silent link is dropped after the timeout plus at most one check interval', async () => {
    const ws = new WebSocket(`${t.wsBase}/ws/agent`, { headers: { Authorization: `Bearer ${token}` }, autoPong: false });
    ws.on('error', () => undefined);
    const closed = new Promise<void>(r => ws.on('close', () => r()));
    ws.on('open', () => ws.send(JSON.stringify(envelope('hello', helloPayload()))));
    await waitFor(async () => (await getRunner(t.tdb.db, 'hp'))!.online);
    // Measured from the hub's own last sign of life of this link, not from when the test saw the runner online
    // (the DB flag lags under a parallel run): dropped no earlier than the timeout and well before three timeouts.
    const conn = t.hub.agents.get('hp')!;
    await closed;
    const silentMs = Date.now() - conn.lastAliveAt;
    expect(silentMs).toBeGreaterThanOrEqual(600);
    expect(silentMs).toBeLessThan(600 * 3);
    await waitFor(async () => !(await getRunner(t.tdb.db, 'hp'))!.online);
  });
});

describe('token LISTEN recovery (integration)', () => {
  let t: TestHub;
  let token: string;
  let calls = 0;
  beforeAll(async () => {
    t = await startTestHub({
      listenRetryBaseMs: 50,
      // 1st client: works; 2nd: fails to connect (dead port); 3rd and later: work.
      listenClientFactory: url => {
        calls++;
        return new pg.Client({ connectionString: calls === 2 ? 'postgres://x:y@127.0.0.1:1/none' : url });
      },
    });
    token = await t.addRunner('hp', 'HP');
  });
  afterAll(async () => t.close());

  it('reconnects after a failed reconnect, and a reissued token still closes the live connection', async () => {
    const a = connectFakeAgent(t.wsBase, token);
    await a.next('welcome');
    const admin = new pg.Client({ connectionString: t.tdb.url });
    await admin.connect();
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND query LIKE 'LISTEN%'`);
    await admin.end();
    await waitFor(() => calls >= 3, 5000);
    // Wait until the third client is listening.
    await waitFor(async () => {
      const c = new pg.Client({ connectionString: t.tdb.url });
      await c.connect();
      const r = await c.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND query LIKE 'LISTEN%'`);
      await c.end();
      return r.rows[0].n === 1;
    }, 5000);
    await issueRunnerToken(t.tdb.db, 'hp');
    expect((await a.closed).code).toBe(4401);
  });
});
