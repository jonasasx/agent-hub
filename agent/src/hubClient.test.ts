// Task 1.11: the real agent client against a real hub (in-process) and Postgres.
import os from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getRunner, issueRunnerToken } from '../../hub/src/runners/repo.js';
import { startTestHub, waitFor, type TestHub } from '../../hub/src/test/harness.js';
import { HubClient } from './hubClient.js';
import { createLogger } from './log.js';
import { buildHello } from './machine.js';

describe('agent ↔ hub (integration)', () => {
  let t: TestHub;
  let token: string;
  const lines: string[] = [];
  const clients: HubClient[] = [];

  const makeClient = (tok: string) => {
    const log = createLogger({ level: 'debug', redact: [], write: l => lines.push(l) });
    const c = new HubClient({
      url: `${t.wsBase}/ws/agent`,
      token: tok,
      log,
      hello: () => buildHello({ vaultRoot: 'C:\\Users\\alice\\vault' }),
      backoff: { minMs: 50, maxMs: 300 },
    });
    clients.push(c);
    return c;
  };

  beforeAll(async () => {
    t = await startTestHub();
    token = await t.addRunner('hp', 'HP');
  });
  afterAll(async () => {
    await Promise.all(clients.map(c => c.stop()));
    await t.close();
  });

  it('connects, sends hello and the hub records this machine', async () => {
    const c = makeClient(token);
    const welcome = new Promise(r => c.once('welcome', r));
    c.start();
    expect(await welcome).toMatchObject({ runnerId: 'hp', protocol: '1.19', capabilities: expect.arrayContaining(['fs.list-dirs', 'fs.browse']) });
    const row = await waitFor(async () => {
      const r = await getRunner(t.tdb.db, 'hp');
      return r?.online ? r : null;
    });
    expect(row.hostname).toBe(os.hostname());
    expect(row.home_dir).toBe(os.homedir());
    expect(row.vault_root).toBe('C:\\Users\\alice\\vault');
    expect(row.sdk_version).toBe('0.3.310');
    expect(c.state).toBe('open');
  });

  it('reconnects after the hub drops the connection', async () => {
    const c = clients[0]!;
    const again = new Promise(r => c.once('welcome', r));
    t.hub.agents.get('hp')!.ws.terminate();
    await again;
    await waitFor(async () => (await getRunner(t.tdb.db, 'hp'))?.online);
    expect(lines.some(l => l.includes('reconnect scheduled'))).toBe(true);
  });

  it('answers commands it does not implement with cmd.error, so the hub does not hang', async () => {
    const conn = t.hub.agents.get('hp')!;
    await expect(conn.request('fs.stat', { path: 'C:\\' }, 3000)).rejects.toMatchObject({ code: 'not_implemented' });
  });

  it('a rejected token is logged without its value and retried', async () => {
    const newToken = await issueRunnerToken(t.tdb.db, 'hp'); // revokes the token the first client holds
    const c = clients[0]!;
    await waitFor(() => lines.some(l => l.includes('hub rejected the agent token')));
    expect(c.state).toBe('connecting');
    expect(lines.join('\n')).not.toContain(token);
    await c.stop();

    const fresh = makeClient(newToken);
    const welcome = new Promise(r => fresh.once('welcome', r));
    fresh.start();
    await welcome;
    expect(lines.join('\n')).not.toContain(newToken);
  });

  it('stop() closes the socket and the hub marks the runner offline', async () => {
    const c = clients.at(-1)!;
    await c.stop();
    expect(c.state).toBe('stopped');
    await waitFor(async () => !(await getRunner(t.tdb.db, 'hp'))!.online);
  });
});
