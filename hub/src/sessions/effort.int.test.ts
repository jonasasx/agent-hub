// change session-effort: the levels come from the agent's model list, the session keeps its level, a live session gets
// session.set_effort, an agent older than 1.22 gets nothing and the answer says effortPending.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { autoReply, connectFakeAgent, PUBLIC_URL, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';

describe('session effort (integration)', () => {
  let t: TestHub;
  let cookie: string;
  let fresh: FakeAgent;
  let old: FakeAgent;
  const commands: Array<{ runner: string; type: string; payload: Record<string, unknown> }> = [];
  const api = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
    t.hub.app.inject({ method, url, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const reply = (runner: string) => (type: string, payload: Record<string, unknown>) => {
    commands.push({ runner, type, payload });
    if (type === 'fs.stat') return { exists: true, isDir: true };
    const models = [
      { value: 'opus', displayName: 'Opus', efforts: ['low', 'medium', 'high', 'max'] },
      { value: 'haiku', displayName: 'Haiku' },
    ];
    return type === 'session.start' || type === 'session.resume' ? { models } : {};
  };
  const last = (runner: string, type: string) => [...commands].reverse().find(c => c.runner === runner && c.type === type)?.payload;

  beforeAll(async () => {
    t = await startTestHub();
    const freshToken = await t.addRunner('fresh', 'X1');
    const oldToken = await t.addRunner('old', 'HP');
    cookie = await t.login();
    fresh = connectFakeAgent(t.wsBase, freshToken, { protocol: '1.22' });
    autoReply(fresh, reply('fresh'));
    await fresh.next('welcome');
    old = connectFakeAgent(t.wsBase, oldToken, { protocol: '1.21' });
    autoReply(old, reply('old'));
    await old.next('welcome');
  });
  afterAll(async () => {
    fresh?.ws.close();
    old?.ws.close();
    await t.close();
  });

  const launch = async (runnerId: string, extra: Record<string, unknown> = {}) => {
    const r = await api('POST', '/api/sessions', { runnerId, cwd: 'C:\\work', provider: 'claude', prompt: 'привет', model: 'opus', ...extra });
    return { r, id: r.json<{ id: string }>().id };
  };

  it('the model list reaches /api/models with efforts; a model without levels has none', async () => {
    const first = await launch('fresh');
    expect(first.r.statusCode, first.r.body).toBe(201);
    await waitFor(async () => (await api('GET', '/api/models')).json<Array<{ value: string; efforts?: string[] }>>().some(m => m.value === 'opus' && m.efforts));
    const models = (await api('GET', '/api/models')).json<Array<{ value: string; efforts?: string[] }>>();
    expect(models.find(m => m.value === 'opus')?.efforts).toEqual(['low', 'medium', 'high', 'max']);
    expect(models.find(m => m.value === 'haiku')?.efforts).toBeUndefined();
  });

  it('launch with a level: stored and sent in session.start; a level the model lacks, or a model without levels → 400', async () => {
    const ok = await launch('fresh', { effort: 'high' });
    expect(ok.r.statusCode, ok.r.body).toBe(201);
    expect(ok.r.json()).toMatchObject({ effort: 'high' });
    const start = await waitFor(() => commands.filter(c => c.runner === 'fresh' && c.type === 'session.start').find(c => c.payload.effort === 'high'));
    expect(start.payload.effort).toBe('high');
    expect((await launch('fresh', { effort: 'xhigh' })).r.statusCode).toBe(400);
    expect((await launch('fresh', { model: 'haiku', effort: 'low' })).r.statusCode).toBe(400);
  });

  it('PATCH effort on a live session → session.set_effort, saved; null returns the default; a bad level → 400', async () => {
    const s = await launch('fresh');
    await waitFor(() => last('fresh', 'session.start'));
    const r = await api('PATCH', `/api/sessions/${s.id}`, { effort: 'low' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ effort: 'low' });
    expect(r.json().effortPending).toBeUndefined();
    expect(last('fresh', 'session.set_effort')).toEqual({ sessionId: s.id, effort: 'low' });
    const reset = await api('PATCH', `/api/sessions/${s.id}`, { effort: null });
    expect(reset.json()).toMatchObject({ effort: null });
    expect(last('fresh', 'session.set_effort')).toEqual({ sessionId: s.id, effort: null });
    expect((await api('PATCH', `/api/sessions/${s.id}`, { effort: 'xhigh' })).statusCode).toBe(400);
  });

  it('a model change that drops the level resets it', async () => {
    const s = await launch('fresh', { effort: 'max' });
    expect(s.r.statusCode, s.r.body).toBe(201);
    const r = await api('PATCH', `/api/sessions/${s.id}`, { model: 'haiku' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ model: 'haiku', effort: null });
  });

  it('a sleeping session keeps the level and session.resume carries it', async () => {
    const s = await launch('fresh', { effort: 'medium' });
    await t.tdb.pool.query(`UPDATE sessions SET process_alive = false, status = 'sleeping' WHERE id = $1`, [s.id]);
    expect((await api('POST', `/api/sessions/${s.id}/wake`, {})).statusCode).toBe(202);
    const resume = await waitFor(() => commands.find(c => c.runner === 'fresh' && c.type === 'session.resume' && c.payload.sessionId === s.id));
    expect(resume.payload.effort).toBe('medium');
  });

  it('an agent older than 1.22: nothing is sent, the level is saved, effortPending', async () => {
    const s = await launch('old');
    expect(s.r.statusCode, s.r.body).toBe(201);
    await waitFor(() => last('old', 'session.start'));
    const r = await api('PATCH', `/api/sessions/${s.id}`, { effort: 'high' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ effort: 'high', effortPending: true });
    expect(last('old', 'session.set_effort')).toBeUndefined();
    expect(last('old', 'session.start')?.effort).toBeUndefined();
  });

  it('an agent older than 1.22 reports no levels: the level is not validated against its list, it stays pending', async () => {
    const r = await launch('old', { model: 'haiku', effort: 'low' });
    expect(r.r.statusCode, r.r.body).toBe(201);
    expect(r.r.json()).toMatchObject({ effort: 'low' });
  });
});
