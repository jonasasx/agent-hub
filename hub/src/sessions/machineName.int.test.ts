// change session-machine-context, D1/D3 (session-machine-context): the hub sends the runner name of the session's machine in
// session.start and session.resume; the name is read at send time, so a rename reaches the next resume; an agent older
// than 1.19 gets no field.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { autoReply, connectFakeAgent, PUBLIC_URL, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';
import { machineNameFor } from './service.js';

describe('machine name in the session context (integration)', () => {
  let t: TestHub;
  let cookie: string;
  let fresh: FakeAgent;
  let old: FakeAgent;
  const commands: Array<{ runner: string; type: string; payload: Record<string, unknown> }> = [];
  const api = (method: 'POST', url: string, payload: unknown) => t.hub.app.inject({ method, url, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, payload: payload as object });
  const reply = (runner: string) => (type: string, payload: Record<string, unknown>) => {
    commands.push({ runner, type, payload });
    return type === 'fs.stat' ? { exists: true, isDir: true } : { models: [] };
  };

  beforeAll(async () => {
    t = await startTestHub();
    const freshToken = await t.addRunner('fresh', 'X1');
    const oldToken = await t.addRunner('old', 'HP');
    cookie = await t.login();
    fresh = connectFakeAgent(t.wsBase, freshToken, { protocol: '1.19' });
    autoReply(fresh, reply('fresh'));
    await fresh.next('welcome');
    old = connectFakeAgent(t.wsBase, oldToken, { protocol: '1.18' });
    autoReply(old, reply('old'));
    await old.next('welcome');
  });
  afterAll(async () => {
    fresh?.ws.close();
    old?.ws.close();
    await t.close();
  });

  it('machineNameFor: the name only for a 1.19 agent, cut to 200 characters', () => {
    expect(machineNameFor({ name: 'X1', protocol_version: '1.19' })).toEqual({ machineName: 'X1' });
    expect(machineNameFor({ name: 'X1', protocol_version: '1.18' })).toEqual({});
    expect(machineNameFor({ name: 'X1', protocol_version: null })).toEqual({});
    expect(machineNameFor({ name: '', protocol_version: '1.19' })).toEqual({});
    expect(machineNameFor(null)).toEqual({});
    expect(machineNameFor({ name: 'x'.repeat(300), protocol_version: '1.20' }).machineName).toHaveLength(200);
  });

  it('session.start and session.resume carry the runner name; a rename reaches the next resume', async () => {
    const launched = await api('POST', '/api/sessions', { runnerId: 'fresh', cwd: 'C:\\work', provider: 'claude', prompt: 'привет', model: 'haiku' });
    expect(launched.statusCode, launched.body).toBe(201);
    const id = launched.json<{ id: string }>().id;
    const start = await waitFor(() => commands.find(c => c.runner === 'fresh' && c.type === 'session.start'));
    expect(start.payload.machineName).toBe('X1');

    await t.tdb.pool.query(`UPDATE runners SET name = 'X1 Carbon' WHERE id = 'fresh'`);
    await t.tdb.pool.query(`UPDATE sessions SET process_alive = false, status = 'sleeping' WHERE id = $1`, [id]);
    expect((await api('POST', `/api/sessions/${id}/wake`, {})).statusCode).toBe(202);
    const resume = await waitFor(() => commands.find(c => c.runner === 'fresh' && c.type === 'session.resume'));
    expect(resume.payload.machineName).toBe('X1 Carbon');
  });

  it('an agent older than 1.19 gets no machineName field', async () => {
    const launched = await api('POST', '/api/sessions', { runnerId: 'old', cwd: 'D:\\srv', provider: 'claude', prompt: 'привет', model: 'haiku' });
    expect(launched.statusCode, launched.body).toBe(201);
    const start = await waitFor(() => commands.find(c => c.runner === 'old' && c.type === 'session.start'));
    expect(start.payload).not.toHaveProperty('machineName');
  });
});
