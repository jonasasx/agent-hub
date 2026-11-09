// change catalog-db-session-context, D2 (session-project-context): the user's catalogue goes to the agent in
// session.start and session.resume — non-archived projects, the binding folder of the session's machine, the session's
// project marked current; an agent older than 1.15 gets no field.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProjectCatalogEntry } from '@agent-hub/shared';
import { autoReply, connectFakeAgent, PUBLIC_URL, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';
import { loadProjectCatalog } from './context.js';

describe('project catalogue in the session context (integration)', () => {
  let t: TestHub;
  let cookie: string;
  let fresh: FakeAgent;
  let old: FakeAgent;
  const commands: Array<{ runner: string; type: string; payload: Record<string, unknown> }> = [];
  const api = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown) =>
    t.hub.app.inject({ method, url, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const reply = (runner: string) => (type: string, payload: Record<string, unknown>) => {
    commands.push({ runner, type, payload });
    return type === 'fs.stat' ? { exists: true, isDir: true } : { models: [] };
  };
  const create = async (body: Record<string, unknown>) => (await api('POST', '/api/catalog/projects', body)).json<{ id: string }>().id;
  let current: string;
  let other: string;
  let archived: string;

  beforeAll(async () => {
    t = await startTestHub();
    const freshToken = await t.addRunner('fresh', 'Fresh');
    const oldToken = await t.addRunner('old', 'Old');
    cookie = await t.login();
    fresh = connectFakeAgent(t.wsBase, freshToken, { protocol: '1.15' });
    autoReply(fresh, reply('fresh'));
    await fresh.next('welcome');
    old = connectFakeAgent(t.wsBase, oldToken, { protocol: '1.14' });
    autoReply(old, reply('old'));
    await old.next('welcome');
    current = await create({ name: 'Current', description: 'текущий\nпроект', remote: 'https://example.test/current.git', folder: 'current' });
    other = await create({ name: 'Other' });
    archived = await create({ name: 'Archived' });
    await t.tdb.pool.query(`UPDATE runners SET default_dir = CASE id WHEN 'fresh' THEN 'C:\\work' ELSE 'D:\\srv' END`);
    expect((await api('PATCH', `/api/catalog/projects/${archived}`, { archived: true })).statusCode).toBe(200);
  });
  afterAll(async () => {
    fresh?.ws.close();
    old?.ws.close();
    await t.close();
  });

  it('loadProjectCatalog: archived excluded, the folder under the default folder of the given machine, the current project first', async () => {
    const userId = (await t.tdb.pool.query<{ id: string }>(`SELECT id FROM users ORDER BY created_at LIMIT 1`)).rows[0]!.id;
    const list = await loadProjectCatalog(t.tdb.db, userId, 'fresh', other);
    expect(list.map(p => p.id)).toEqual([other, current]);
    expect(list[0]).toEqual({ id: other, name: 'Other', description: null, remote: null, path: null, current: true });
    expect(list[1]).toMatchObject({ id: current, path: 'C:\\work\\current', current: false, remote: 'https://example.test/current.git' });
    expect((await loadProjectCatalog(t.tdb.db, userId, 'old', null)).find(p => p.id === current)?.path).toBe('D:\\srv\\current');
    expect(await loadProjectCatalog(t.tdb.db, '00000000-0000-0000-0000-000000000000', 'fresh', null)).toEqual([]);
  });

  it('session.start and session.resume carry the catalogue to a 1.15 agent with the session project marked current', async () => {
    const launched = await api('POST', '/api/sessions', { runnerId: 'fresh', cwd: 'C:\\work', provider: 'claude', projectId: current, prompt: 'привет', model: 'haiku' });
    expect(launched.statusCode, launched.body).toBe(201);
    const id = launched.json<{ id: string }>().id;
    const start = await waitFor(() => commands.find(c => c.runner === 'fresh' && c.type === 'session.start'));
    const catalog = start.payload.projectCatalog as ProjectCatalogEntry[];
    expect(catalog.map(p => [p.name, p.current])).toEqual([
      ['Current', true],
      ['Other', false],
    ]);
    expect(catalog[0]).toMatchObject({ path: 'C:\\work\\current', description: 'текущий\nпроект' });
    expect(catalog.some(p => p.id === archived)).toBe(false);

    await t.tdb.pool.query(`UPDATE sessions SET process_alive = false, status = 'sleeping' WHERE id = $1`, [id]);
    expect((await api('POST', `/api/sessions/${id}/wake`, {})).statusCode).toBe(202);
    const resume = await waitFor(() => commands.find(c => c.runner === 'fresh' && c.type === 'session.resume'));
    expect((resume.payload.projectCatalog as ProjectCatalogEntry[]).map(p => [p.name, p.current])).toEqual([
      ['Current', true],
      ['Other', false],
    ]);
  });

  it('an agent older than 1.15 gets no projectCatalog field', async () => {
    const launched = await api('POST', '/api/sessions', { runnerId: 'old', cwd: 'D:\\srv', provider: 'claude', projectId: current, prompt: 'привет', model: 'haiku' });
    expect(launched.statusCode, launched.body).toBe(201);
    const start = await waitFor(() => commands.find(c => c.runner === 'old' && c.type === 'session.start'));
    expect(start.payload).toMatchObject({ projectId: current });
    expect(start.payload).not.toHaveProperty('projectCatalog');
  });
});
