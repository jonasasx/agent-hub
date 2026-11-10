// agent-project-tools task 2.3 against a real hub, Postgres and scripted agents: WIN (Windows, protocol 1.18), MAC (macOS,
// 1.18), OLD (1.17). Requirements: Список проектов каталога для сессии; Создание проекта из сессии; Правка проекта из сессии;
// Папка проекта из инструмента; Привязка вызывающей сессии к проекту; Совместимость версий агента и хаба.
// The tests of the describe share the hub and run in order.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { envelope, type AgentProjectView, type SessionView } from '@agent-hub/shared';
import { PUBLIC_URL, connectFakeAgent, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';

const WIN_HOME = 'C:\\Users\\bob';
const WIN_BASE = 'C:\\Users\\bob\\vault';
const MAC_HOME = '/Users/polina';

interface Cmd {
  type: string;
  id?: string;
  payload: Record<string, unknown>;
  runner: string;
}
interface Reply {
  ok: boolean;
  result?: Record<string, unknown>;
  code?: string;
  message?: string;
}

describe('agent project tools (integration)', () => {
  let t: TestHub;
  let cookie: string;
  const got: Cmd[] = [];
  const agents = new Map<string, FakeAgent>();
  type S = { id: string; sid: string };

  const api = async (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    t.hub.app.inject({ method, url, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, ...(payload !== undefined ? { payload: payload as object } : {}) });

  function agent(runner: string, token: string, hello: Record<string, unknown>) {
    const a = connectFakeAgent(t.wsBase, token, { hostname: `${runner}-host`, ...hello });
    a.ws.on('message', d => {
      const m = JSON.parse(d.toString()) as Cmd;
      if (!m.id || m.type === 'peers.reply') return;
      got.push({ ...m, runner });
      const ok = (result: unknown) => a.ws.send(JSON.stringify(envelope('cmd.ok', { result }, { re: m.id! })));
      if (m.type === 'fs.stat') return ok({ exists: true, isDir: true });
      if (m.type === 'session.start' || m.type === 'session.resume') return ok({ models: [] });
      ok({});
    });
    agents.set(runner, a);
    return a;
  }

  async function session(runner: string, projectId?: string): Promise<S> {
    const r = await api('POST', '/api/sessions', { runnerId: runner, model: 'haiku', prompt: 'hi', ...(projectId ? { projectId } : {}) });
    expect(r.statusCode, r.body).toBe(201);
    const id = (r.json() as SessionView).id;
    const sid = (await t.tdb.pool.query(`SELECT claude_session_id FROM sessions WHERE id = $1`, [id])).rows[0].claude_session_id as string;
    return { id, sid };
  }

  async function ask(runner: string, sid: string, payload: Record<string, unknown>): Promise<Reply> {
    const a = agents.get(runner)!;
    const id = randomUUID();
    a.ws.send(JSON.stringify(envelope('peers.request', { sessionId: sid, ...payload }, { id })));
    const m = await waitFor(() => a.messages.find(x => x.type === 'peers.reply' && (x as unknown as { re?: string }).re === id), 10_000);
    return m.payload as unknown as Reply;
  }
  const projects = async (runner: string, s: S) => ((await ask(runner, s.sid, { op: 'projects' })).result as { projects: AgentProjectView[] }).projects;
  const row = async (id: string) => (await t.tdb.pool.query(`SELECT * FROM catalog_projects WHERE id = $1`, [id])).rows[0];
  const link = async (sessionId: string) => (await t.tdb.pool.query(`SELECT * FROM session_projects WHERE session_id = $1`, [sessionId])).rows[0];

  let W: S; // WIN
  let M: S; // MAC
  let O: S; // OLD
  let userId: string;
  let foreignId: string;
  let archivedId: string;

  beforeAll(async () => {
    t = await startTestHub({ sessions: { idleCheckMs: 0, initTimeoutMs: 3000 } });
    const tok: Record<string, string> = {};
    for (const [id, name] of [
      ['win', 'WIN'],
      ['mac', 'MAC'],
      ['old', 'OLD'],
    ] as const)
      tok[id] = await t.addRunner(id, name);
    cookie = await t.login();
    agent('win', tok.win!, { protocol: '1.18', homeDir: WIN_HOME, os: 'Windows 11 Pro' });
    agent('mac', tok.mac!, { protocol: '1.18', homeDir: MAC_HOME, os: 'macOS 15', vaultRoot: MAC_HOME });
    agent('old', tok.old!, { protocol: '1.17', homeDir: MAC_HOME, os: 'macOS 15', vaultRoot: MAC_HOME });
    for (const a of agents.values()) await a.next('welcome');
    await t.tdb.pool.query(`UPDATE runners SET default_dir = $1 WHERE id = 'win'`, [WIN_BASE]);
    await t.tdb.pool.query(`UPDATE runners SET default_dir = $1 WHERE id IN ('mac', 'old')`, [MAC_HOME]);
    W = await session('win');
    M = await session('mac');
    O = await session('old');
    userId = (await t.tdb.pool.query(`SELECT user_id FROM sessions WHERE id = $1`, [W.id])).rows[0].user_id as string;
    archivedId = (await t.tdb.pool.query(`INSERT INTO catalog_projects (id, user_id, name, archived) VALUES ($1, $2, 'Старый', true) RETURNING id`, [randomUUID(), userId])).rows[0].id as string;
    const u = await t.tdb.pool.query(`INSERT INTO users (email) VALUES ('other@example.com') RETURNING id`);
    foreignId = (await t.tdb.pool.query(`INSERT INTO catalog_projects (id, user_id, name) VALUES ($1, $2, 'Чужой') RETURNING id`, [randomUUID(), u.rows[0].id])).rows[0].id as string;
  }, 240_000);
  afterAll(async () => {
    await t.close();
  });

  it('project_create: relative folder; the project is in the catalogue and a new session of it starts in the folder', async () => {
    const r = await ask('mac', M.sid, { op: 'project_create', name: 'Personal OS', folder: 'personal-os' });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const p = (r.result as { project: AgentProjectView }).project;
    expect(p).toMatchObject({ name: 'Personal OS', folder: 'personal-os', dir: '/Users/polina/personal-os', description: '', remote: null });
    expect(await row(p.id)).toMatchObject({ user_id: userId, folder: 'personal-os', archived: false });
    const s = await session('mac', p.id);
    const start = got.filter(c => c.runner === 'mac' && c.type === 'session.start').at(-1)!;
    expect(start.payload.cwd).toBe('/Users/polina/personal-os');
    expect((await t.tdb.pool.query(`SELECT cwd FROM sessions WHERE id = $1`, [s.id])).rows[0].cwd).toBe('/Users/polina/personal-os');
  });

  it('projects_list: active projects of the owner with dir on the caller machine; no archived, no foreign', async () => {
    const created = await ask('mac', M.sid, { op: 'project_create', name: 'Разное' });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    const list = await projects('mac', M);
    expect(list.map(p => p.name)).toEqual(['Personal OS', 'Разное']);
    expect(list.find(p => p.name === 'Разное')).toMatchObject({ folder: null, dir: MAC_HOME });
    expect(list.map(p => p.id)).not.toContain(foreignId);
    expect(list.map(p => p.id)).not.toContain(archivedId);
    // the same catalogue seen from the Windows machine: dir by its default folder
    const win = await projects('win', W);
    expect(win.find(p => p.name === 'Personal OS')).toMatchObject({ dir: 'C:\\Users\\bob\\vault\\personal-os' });
  });

  it('project_create: a taken name in another case is conflict, nothing created', async () => {
    const before = (await t.tdb.pool.query(`SELECT count(*)::int AS n FROM catalog_projects WHERE user_id = $1`, [userId])).rows[0].n as number;
    const r = await ask('mac', M.sid, { op: 'project_create', name: 'personal os' });
    expect(r).toMatchObject({ ok: false, code: 'conflict' });
    expect(r.message).toContain('projects_list');
    expect((await t.tdb.pool.query(`SELECT count(*)::int AS n FROM catalog_projects WHERE user_id = $1`, [userId])).rows[0].n).toBe(before);
  });

  it('project_update: only the folder changes; null removes it; foreign, archived and unknown are not_found', async () => {
    const id = (await projects('mac', M)).find(p => p.name === 'Разное')!.id;
    const r = await ask('mac', M.sid, { op: 'project_update', id, folder: 'misc/notes' });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect((r.result as { project: AgentProjectView }).project).toMatchObject({ name: 'Разное', folder: 'misc/notes', dir: '/Users/polina/misc/notes', description: '' });
    const cleared = await ask('mac', M.sid, { op: 'project_update', id, folder: null });
    expect((cleared.result as { project: AgentProjectView }).project).toMatchObject({ folder: null, dir: MAC_HOME });
    for (const other of [foreignId, archivedId, randomUUID()]) {
      const x = await ask('mac', M.sid, { op: 'project_update', id: other, folder: 'x', linkSession: true });
      expect(x).toMatchObject({ ok: false, code: 'not_found' });
    }
    expect(await link(M.id)).toBeUndefined();
    expect(await row(foreignId)).toMatchObject({ folder: null, name: 'Чужой' });
    expect(await row(archivedId)).toMatchObject({ folder: null });
  });

  it('folder: an absolute path inside the default folder becomes relative (Unix, Windows any case and separator, ~)', async () => {
    const mac = await ask('mac', M.sid, { op: 'project_create', name: 'POS', folder: '/Users/polina/personal-os/' });
    expect((mac.result as { project: AgentProjectView }).project).toMatchObject({ folder: 'personal-os' });
    const tilde = await ask('mac', M.sid, { op: 'project_create', name: 'Tilde', folder: '~/repos/app' });
    expect((tilde.result as { project: AgentProjectView }).project).toMatchObject({ folder: 'repos/app' });
    const win = await ask('win', W.sid, { op: 'project_create', name: 'Win', folder: 'c:/users/BOB/Vault\\repos\\agent-hub' });
    expect((win.result as { project: AgentProjectView }).project).toMatchObject({ folder: 'repos/agent-hub', dir: 'C:\\Users\\bob\\vault\\repos\\agent-hub' });
    const same = await ask('win', W.sid, { op: 'project_create', name: 'Base', folder: WIN_BASE });
    expect((same.result as { project: AgentProjectView }).project).toMatchObject({ folder: null });
  });

  it('folder: outside the default folder or with .. is invalid_request naming the default folder, nothing changes', async () => {
    const outside = await ask('win', W.sid, { op: 'project_create', name: 'Outside', folder: 'D:\\work\\repo' });
    expect(outside).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(outside.message).toContain(WIN_BASE);
    const home = await ask('win', W.sid, { op: 'project_create', name: 'Outside', folder: '~/Downloads' });
    expect(home).toMatchObject({ ok: false, code: 'invalid_request' });
    expect((await t.tdb.pool.query(`SELECT count(*)::int AS n FROM catalog_projects WHERE name = 'Outside'`)).rows[0].n).toBe(0);
    const id = (await projects('mac', M)).find(p => p.name === 'Personal OS')!.id;
    const dots = await ask('mac', M.sid, { op: 'project_update', id, folder: '../etc' });
    expect(dots).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(dots.message).toContain(MAC_HOME);
    expect(await row(id)).toMatchObject({ folder: 'personal-os' });
  });

  it('linkSession: the caller goes to the project by hand, its folder does not change', async () => {
    const before = (await t.tdb.pool.query(`SELECT cwd FROM sessions WHERE id = $1`, [M.id])).rows[0].cwd as string;
    const r = await ask('mac', M.sid, { op: 'project_create', name: 'Linked', folder: 'linked', linkSession: true });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const p = (r.result as { project: AgentProjectView }).project;
    expect(await link(M.id)).toMatchObject({ project_id: p.id, source: 'manual', reason_code: 'selected' });
    expect((await t.tdb.pool.query(`SELECT cwd FROM sessions WHERE id = $1`, [M.id])).rows[0].cwd).toBe(before);
    const id = (await projects('mac', M)).find(p => p.name === 'Personal OS')!.id;
    const moved = await ask('mac', M.sid, { op: 'project_update', id, linkSession: true });
    expect(moved.ok, JSON.stringify(moved)).toBe(true);
    expect(await link(M.id)).toMatchObject({ project_id: id, source: 'manual' });
  });

  it('an agent with protocol 1.17 gets unsupported for the new operations, nothing created', async () => {
    for (const payload of [{ op: 'projects' }, { op: 'project_create', name: 'Old' }]) {
      const r = await ask('old', O.sid, payload);
      expect(r).toMatchObject({ ok: false, code: 'unsupported' });
    }
    expect((await t.tdb.pool.query(`SELECT count(*)::int AS n FROM catalog_projects WHERE name = 'Old'`)).rows[0].n).toBe(0);
  });
});
