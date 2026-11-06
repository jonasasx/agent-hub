import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { autoReply, connectFakeAgent, connectUi, NO_AUTO_REPLY, PUBLIC_URL, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';

describe('projects-catalog HTTP (integration)', () => {
  let t: TestHub;
  let cookie: string;
  let foreignRunner: string;
  let agent: FakeAgent;
  let pickerAgent: FakeAgent;
  let vmToken: string;
  let holdPickerReply = false;
  const logs: string[] = [];
  const commands: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const api = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    t.hub.app.inject({ method, url, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  beforeAll(async () => {
    t = await startTestHub({ logStream: { write: line => logs.push(line) } });
    const token = await t.addRunner('hp', 'HP');
    vmToken = await t.addRunner('vm', 'VM');
    await t.addRunner('idle', 'Idle');
    await t.tdb.pool.query(`UPDATE runners SET online=true WHERE id='vm'`);
    cookie = await t.login();
    // A 1.12 agent remains connected but does not negotiate the directory-picker capability.
    agent = connectFakeAgent(t.wsBase, token, { protocol: '1.12' });
    autoReply(agent, (type, payload) => {
      commands.push({ type, payload });
      return type === 'fs.stat' ? { exists: true, isDir: true } : { models: [] };
    });
    await agent.next('welcome');
    pickerAgent = connectFakeAgent(t.wsBase, vmToken, { protocol: '1.13', capabilities: ['fs.list-dirs'] });
    autoReply(pickerAgent, (type, payload) =>
      type === 'fs.list-dirs' ? (holdPickerReply ? NO_AUTO_REPLY : { path: payload.path ?? '/home/test', parent: '/', directories: [{ name: 'workspace', path: '/home/test/workspace' }] }) : {},
    );
    await pickerAgent.next('welcome');
    const owner = await t.tdb.pool.query<{ id: string }>(`INSERT INTO users(email) VALUES ('other@example.test') RETURNING id`);
    await t.tdb.pool.query(`INSERT INTO runners(id,user_id,name) VALUES ('other-machine',$1,'Other')`, [owner.rows[0]!.id]);
    foreignRunner = 'other-machine';
  });
  afterAll(async () => {
    agent?.ws.close();
    pickerAgent?.ws.close();
    await t.close();
  });

  it('persists colors, handles concurrent normalized conflicts, and deletes only links', async () => {
    const created = (await api('POST', '/api/catalog/projects', { name: 'Color retention', colorKey: 'rose' })).json<{ id: string; colorKey: string }>();
    expect(created.colorKey).toBe('rose');
    const peer = (await api('POST', '/api/catalog/projects', { name: 'Color peer' })).json<{ id: string }>();
    const list = () => api('GET', '/api/catalog/projects?sort=name');
    expect((await list()).json<Array<{ id: string; colorKey: string }>>().find(p => p.id === created.id)?.colorKey).toBe('rose');
    expect((await api('PATCH', `/api/catalog/projects/${created.id}`, { colorKey: 'invalid' })).statusCode).toBe(400);
    expect((await api('PATCH', `/api/catalog/projects/${created.id}`, { name: '  COLOR PEER  ' })).statusCode).toBe(409);
    const conflicts = await Promise.all([api('POST', '/api/catalog/projects', { name: 'Concurrent E' }), api('POST', '/api/catalog/projects', { name: ' concurrent e ' })]);
    expect(conflicts.map(r => r.statusCode).sort()).toEqual([201, 409]);
    const unicode = (await api('POST', '/api/catalog/projects', { name: 'Caf\u00e9 E' })).json<{ id: string }>();
    expect((await api('POST', '/api/catalog/projects', { name: 'Cafe\u0301 E' })).statusCode).toBe(409);
    await api('DELETE', `/api/catalog/projects/${unicode.id}`);
    await api('DELETE', `/api/catalog/projects/${peer.id}`);
    expect((await list()).json<Array<{ id: string; colorKey: string }>>().find(p => p.id === created.id)?.colorKey).toBe('rose');
    expect((await api('PUT', `/api/catalog/projects/${created.id}/bindings/hp`, { path: 'C:\\work\\colors' })).statusCode).toBe(200);
    expect((await api('DELETE', `/api/catalog/projects/${created.id}/bindings/${foreignRunner}`)).statusCode).toBe(404);
    expect((await api('DELETE', `/api/catalog/projects/${created.id}/bindings/hp`)).statusCode).toBe(200);
    await api('PUT', `/api/catalog/projects/${created.id}/bindings/hp`, { path: 'C:\\work\\colors' });
    const launched = await api('POST', '/api/sessions', { runnerId: 'hp', cwd: 'C:\\work', provider: 'claude', projectId: created.id, prompt: 'Keep this session', model: 'haiku' });
    expect(launched.statusCode).toBe(201);
    const sid = launched.json<{ id: string }>().id;
    const ui = connectUi(t.wsBase, cookie);
    await ui.open;
    expect((await api('PATCH', `/api/catalog/projects/${created.id}`, { colorKey: 'lime' })).statusCode).toBe(200);
    await waitFor(() => ui.received.some(message => message.type === 'projects.changed'));
    ui.ws.close();
    expect((await api('GET', `/api/sessions/${sid}`)).json()).toMatchObject({ project: { colorKey: 'lime' } });
    const file = (
      await t.tdb.pool.query(
        `INSERT INTO transcript_files(user_id,session_id,runner_id,claude_session_id,rel_key,rel_path,kind) SELECT user_id,id,runner_id,claude_session_id,'e/retained.jsonl','e/retained.jsonl','main' FROM sessions WHERE id=$1 RETURNING id`,
        [sid],
      )
    ).rows[0].id;
    await t.tdb.pool.query(`INSERT INTO events(file_id,generation,line_no,session_id,type,ts,payload) VALUES ($1,0,0,$2,'user',now(),'{"type":"user","message":{"content":"Retained transcript"}}')`, [
      file,
      sid,
    ]);
    const counts = async () =>
      (await t.tdb.pool.query(`SELECT (SELECT count(*) FROM sessions) sessions, (SELECT count(*) FROM events) events, (SELECT count(*) FROM transcript_files) transcripts`)).rows[0];
    const before = await counts();
    const [edited, deleted] = await Promise.all([api('PATCH', `/api/catalog/projects/${created.id}`, { description: 'Concurrent edit' }), api('DELETE', `/api/catalog/projects/${created.id}`)]);
    expect([200, 404]).toContain(edited.statusCode);
    expect(deleted.statusCode).toBe(200);
    await t.hub.projects.flush();
    expect((await api('GET', `/api/sessions/${sid}`)).json()).toMatchObject({ project: { id: null } });
    expect(await counts()).toEqual(before);
    expect((await api('GET', `/api/sessions/${sid}`)).statusCode).toBe(200);
    await t.hub.projects.flush();
    const legacy = (await t.tdb.pool.query(`SELECT id, user_id FROM projects ORDER BY id LIMIT 1`)).rows[0];
    await t.tdb.pool.query(`UPDATE sessions SET project_id=$1 WHERE id=$2`, [legacy.id, sid]);
    expect((await api('DELETE', `/api/projects/${legacy.id}/group`)).statusCode).toBe(200);
    expect((await api('GET', `/api/sessions/${sid}`)).json()).toMatchObject({ project: { id: null } });
    const sidebar = (await api('GET', '/api/sidebar')).json<{ projects: Array<{ project: { id: string | null }; sessions: Array<{ id: string }> }> }>();
    expect(sidebar.projects.some(p => p.project.id === legacy.id)).toBe(false);
    expect(sidebar.projects.find(p => p.project.id === null)?.sessions.some(s => s.id === sid)).toBe(true);
    expect((await t.tdb.pool.query(`SELECT 1 FROM projects WHERE id=$1`, [legacy.id])).rowCount).toBe(1);
    expect((await api('GET', '/api/projects/hidden')).json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: legacy.id })]));
    expect((await api('DELETE', `/api/projects/${legacy.id}/hidden`)).statusCode).toBe(200);
    expect((await api('GET', `/api/sessions/${sid}`)).json()).toMatchObject({ project: { id: legacy.id } });
    expect((await api('PUT', `/api/projects/${legacy.id}/hidden`)).statusCode).toBe(200);
    await api('DELETE', `/api/projects/${legacy.id}/hidden`);
    expect((await api('PATCH', `/api/projects/${legacy.id}/color`, { colorKey: 'rose' })).statusCode).toBe(200);
    await t.hub.projects.catalog.reload(true);
    expect(t.hub.projects.catalog.row(legacy.id)?.colorKey).toBe('rose');
    expect((await t.tdb.pool.query(`SELECT 1 FROM session_projects WHERE project_id=$1`, [created.id])).rowCount).toBe(0);
    expect((await t.tdb.pool.query(`SELECT 1 FROM project_bindings WHERE project_id=$1`, [created.id])).rowCount).toBe(0);
    expect((await api('DELETE', `/api/catalog/projects/${created.id}`)).statusCode).toBe(404);
    // Keep other existing tests independent of the active catalog.
    await t.tdb.pool.query(`DELETE FROM catalog_projects WHERE name IN ('Concurrent E','concurrent e')`);
  });

  it('allocates distinct stable colors in consecutive POSTs and sidebar reloads; atomic edits roll back', async () => {
    const first = (await api('POST', '/api/catalog/projects', { name: 'Palette first' })).json<{ id: string; colorKey: string }>();
    const second = (await api('POST', '/api/catalog/projects', { name: 'Palette second' })).json<{ id: string; colorKey: string }>();
    expect(first.colorKey).not.toBe(second.colorKey);
    const third = (await api('POST', '/api/catalog/projects', { name: 'Palette third' })).json<{ id: string; colorKey: string }>();
    for (const p of [first, second]) {
      const sid = (
        await t.tdb.pool.query(
          `INSERT INTO sessions(user_id,runner_id,claude_session_id,source,status) SELECT user_id,'hp',gen_random_uuid(),'hub','closed' FROM catalog_projects WHERE id=$1 RETURNING id`,
          [p.id],
        )
      ).rows[0].id;
      await t.tdb.pool.query(`INSERT INTO session_projects(user_id,session_id,project_id) SELECT user_id,$2,id FROM catalog_projects WHERE id=$1`, [p.id, sid]);
    }
    const colors = async () =>
      (await api('GET', '/api/sidebar'))
        .json<{ projects: Array<{ project: { id: string; colorKey: string } }> }>()
        .projects.filter(p => [first.id, second.id].includes(p.project.id))
        .map(p => [p.project.id, p.project.colorKey])
        .sort();
    expect(await colors()).toEqual(
      [
        [first.id, first.colorKey],
        [second.id, second.colorKey],
      ].sort(),
    );
    await api('DELETE', `/api/catalog/projects/${third.id}`);
    expect(await colors()).toEqual(
      [
        [first.id, first.colorKey],
        [second.id, second.colorKey],
      ].sort(),
    );
    expect((await api('PATCH', `/api/catalog/projects/${first.id}`, { name: 'Must roll back', bindings: [{ runnerId: foreignRunner, path: '/secret' }] })).statusCode).toBe(404);
    expect((await t.tdb.pool.query(`SELECT name FROM catalog_projects WHERE id=$1`, [first.id])).rows[0].name).toBe('Palette first');
    await api('DELETE', `/api/catalog/projects/${first.id}`);
    await api('DELETE', `/api/catalog/projects/${second.id}`);
    await t.hub.projects.flush();
  });

  it('returns deletion before quiet reclassification and restores the stored path group with one notification', async () => {
    await t.hub.projects.flush();
    const project = (await api('POST', '/api/catalog/projects', { name: 'Background fallback' })).json<{ id: string }>();
    const legacy = (await t.tdb.pool.query(`SELECT id,path FROM projects ORDER BY id LIMIT 1`)).rows[0];
    const sid = (
      await t.tdb.pool.query(
        `INSERT INTO sessions(user_id,runner_id,claude_session_id,source,status) SELECT user_id,'hp',gen_random_uuid(),'hub','closed' FROM catalog_projects WHERE id=$1 RETURNING id`,
        [project.id],
      )
    ).rows[0].id;
    const file = (
      await t.tdb.pool.query(
        `INSERT INTO transcript_files(user_id,session_id,runner_id,claude_session_id,rel_key,rel_path,kind) SELECT user_id,id,runner_id,claude_session_id,'e/background.jsonl','e/background.jsonl','main' FROM sessions WHERE id=$1 RETURNING id`,
        [sid],
      )
    ).rows[0].id;
    await t.tdb.pool.query(`INSERT INTO path_touches(session_id,file_id,line_no,op,path_norm,project_id) VALUES ($1,$2,0,'cwd',$3,$4)`, [sid, file, legacy.path, legacy.id]);
    await t.tdb.pool.query(`INSERT INTO session_projects(user_id,session_id,project_id) SELECT user_id,$2,id FROM catalog_projects WHERE id=$1`, [project.id, sid]);
    const original = t.hub.projects.recompute.bind(t.hub.projects);
    let release!: () => void;
    const barrier = new Promise<void>(resolve => {
      release = resolve;
    });
    const recompute = vi.spyOn(t.hub.projects, 'recompute').mockImplementation(async (id, options) => {
      await barrier;
      return original(id, options);
    });
    const ui = connectUi(t.wsBase, cookie);
    await ui.open;
    try {
      expect((await api('DELETE', `/api/catalog/projects/${project.id}`)).statusCode).toBe(200);
      await waitFor(() => recompute.mock.calls.length === 1);
      expect(recompute.mock.calls[0]).toEqual([sid, { fresh: true, quiet: true, skipStart: true }]);
      expect(ui.received.filter(message => message.type === 'projects.changed')).toHaveLength(0);
      release();
      await t.hub.projects.flush();
      await waitFor(() => ui.received.some(message => message.type === 'projects.changed'));
      expect(ui.received.filter(message => message.type === 'projects.changed')).toHaveLength(1);
      expect(ui.received.filter(message => message.type === 'session.upsert')).toHaveLength(0);
      expect((await api('GET', `/api/sessions/${sid}`)).json()).toMatchObject({ project: { id: legacy.id } });
    } finally {
      release();
      recompute.mockRestore();
      ui.ws.close();
    }
  });

  it('lists directories through the owning negotiated agent and rejects old, foreign, offline, and invalid requests', async () => {
    expect((await api('GET', '/api/runners/hp/directories')).statusCode).toBe(409); // 1.11 agent has no negotiated capability
    expect((await api('GET', `/api/runners/${foreignRunner}/directories`)).statusCode).toBe(404);
    expect((await api('GET', '/api/runners/vm/directories?showHidden=true')).json()).toEqual({ path: '/home/test', parent: '/', directories: [{ name: 'workspace', path: '/home/test/workspace' }] });
    expect((await api('GET', '/api/runners/vm/directories?showHidden=maybe')).statusCode).toBe(400);
    expect((await api('GET', '/api/runners/idle/directories')).statusCode).toBe(409);
  });

  it('rejects unsafe directory paths before contacting the agent and blocks cross-site browse requests', async () => {
    const count = pickerAgent.messages.filter(message => message.type === 'fs.list-dirs').length;
    for (const unsafe of ['\\\\attacker\\share', '\\\\?\\C:\\Users', '\\\\.\\pipe\\x', 'relative\\path', 'C:\\bad\0path']) {
      expect((await api('GET', `/api/runners/vm/directories?path=${encodeURIComponent(unsafe)}`)).statusCode).toBe(400);
    }
    expect(pickerAgent.messages.filter(message => message.type === 'fs.list-dirs')).toHaveLength(count);
    expect(
      (await t.hub.app.inject({ method: 'GET', url: '/api/runners/vm/directories?path=%2Fhome%2Ftest', cookies: { ah_session: cookie }, headers: { 'sec-fetch-site': 'cross-site' } })).statusCode,
    ).toBe(403);
    expect(
      (await t.hub.app.inject({ method: 'GET', url: '/api/runners/vm/directories', cookies: { ah_session: cookie }, headers: { 'sec-fetch-site': 'same-site', origin: PUBLIC_URL } })).statusCode,
    ).toBe(403);
    expect(
      (await t.hub.app.inject({ method: 'GET', url: '/api/runners/vm/directories', cookies: { ah_session: cookie }, headers: { 'sec-fetch-site': 'same-origin', origin: PUBLIC_URL } })).statusCode,
    ).toBe(200);
    expect(
      (await t.hub.app.inject({ method: 'GET', url: '/api/runners/vm/directories?path=%2Fhome%2Ftest', cookies: { ah_session: cookie }, headers: { origin: 'https://attacker.invalid' } })).statusCode,
    ).toBe(403);
  });

  it('returns 409 when the agent connection is replaced during a directory request', async () => {
    const before = pickerAgent.messages.filter(message => message.type === 'fs.list-dirs').length;
    holdPickerReply = true;
    const pending = api('GET', '/api/runners/vm/directories');
    const deadline = Date.now() + 5000;
    while (pickerAgent.messages.filter(message => message.type === 'fs.list-dirs').length === before && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(pickerAgent.messages.filter(message => message.type === 'fs.list-dirs')).toHaveLength(before + 1);
    pickerAgent.ws.terminate();
    expect((await pending).statusCode).toBe(409);
    pickerAgent = connectFakeAgent(t.wsBase, vmToken, { protocol: '1.13', capabilities: ['fs.list-dirs'] });
    holdPickerReply = false;
    autoReply(pickerAgent, (type, payload) => (type === 'fs.list-dirs' ? { path: payload.path ?? '/home/test', parent: '/', directories: [{ name: 'workspace', path: '/home/test/workspace' }] } : {}));
    await pickerAgent.next('welcome');
  });

  it('creates, lists, sorts, binds and archives only a user-owned project', async () => {
    expect((await api('POST', '/api/catalog/projects', { name: 'Relative', runnerId: 'hp', path: 'relative/path' })).statusCode).toBe(400);
    expect((await api('GET', '/api/catalog/projects?sort=unknown')).statusCode).toBe(400);
    const created = await api('POST', '/api/catalog/projects', { name: 'Zeta', description: 'notes', remote: 'https://example.test/zeta.git' });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: string }>().id;
    expect(created.json()).toMatchObject({ id, name: 'Zeta', description: 'notes', remote: 'https://example.test/zeta.git', bindings: [] });
    type Sidebar = { projects: Array<{ project: { id: string | null; title: string }; total: number; sessions: unknown[] }> };
    const group = async () => (await api('GET', '/api/sidebar')).json<Sidebar>().projects.find(p => p.project.id === id);
    // a project without sessions is a group at once, so a project created by hand is visible
    expect(await group()).toMatchObject({ project: { title: 'Zeta' }, total: 0, sessions: [] });
    expect((await api('PUT', `/api/catalog/projects/${id}/bindings/hp`, { path: 'relative/path' })).statusCode).toBe(400);
    expect((await api('PUT', `/api/catalog/projects/${id}/bindings/hp`, { path: 'C:\\work\\zeta' })).statusCode).toBe(200);
    expect((await api('PUT', `/api/catalog/projects/${id}/bindings/vm`, { path: '/home/ubuntu/zeta' })).statusCode).toBe(200);
    expect((await api('GET', '/api/catalog/projects?sort=name')).json()).toEqual([
      expect.objectContaining({
        id,
        name: 'Zeta',
        bindings: expect.arrayContaining([
          { runnerId: 'hp', path: 'C:\\work\\zeta' },
          { runnerId: 'vm', path: '/home/ubuntu/zeta' },
        ]),
      }),
    ]);
    expect((await api('GET', `/api/catalog/projects/not-a-uuid/resolve?runnerId=hp`)).statusCode).toBe(400);
    expect((await api('GET', `/api/catalog/projects/${id}/resolve?runnerId=`)).statusCode).toBe(400);
    expect((await api('PATCH', '/api/catalog/projects/not-a-uuid', { archived: true })).statusCode).toBe(400);
    expect((await api('PATCH', `/api/catalog/projects/${id}`, { archived: true })).statusCode).toBe(200);
    expect((await api('GET', '/api/catalog/projects')).json()).toEqual([]);
    expect(await group()).toBeUndefined();
  });

  it("rejects a binding to another user's runner and reports an offline owned runner as unavailable", async () => {
    const created = await api('POST', '/api/catalog/projects', { name: 'Alpha' });
    const id = created.json<{ id: string }>().id;
    expect((await api('PUT', `/api/catalog/projects/${id}/bindings/${foreignRunner}`, { path: '/secret' })).statusCode).toBe(404);
    expect((await api('PUT', `/api/catalog/projects/${id}/bindings/hp`, { path: 'C:\\work\\alpha' })).statusCode).toBe(200);
    await t.tdb.pool.query(`UPDATE runners SET online=false WHERE id='hp'`);
    expect((await api('GET', `/api/catalog/projects/${id}/resolve?runnerId=hp`)).json()).toEqual({ status: 'unavailable' });
    expect((await api('PATCH', `/api/catalog/projects/8af5f350-6251-492a-8888-16f8a3bb67af`, { archived: true })).statusCode).toBe(404);
  });

  it('keeps linked sessions available in history after archiving a project', async () => {
    await t.tdb.pool.query(`UPDATE runners SET online=true WHERE id='hp'`);
    const created = await api('POST', '/api/catalog/projects', { name: 'History' });
    const id = created.json<{ id: string }>().id;
    await api('PUT', `/api/catalog/projects/${id}/bindings/hp`, { path: 'C:\\work\\history' });
    const launched = await api('POST', '/api/sessions', { runnerId: 'hp', cwd: 'C:\\wrong', model: 'haiku', prompt: 'history', projectId: id });
    expect(launched.statusCode).toBe(201);
    const sessionId = launched.json<{ id: string }>().id;
    expect((await api('PATCH', `/api/catalog/projects/${id}`, { archived: true })).statusCode).toBe(200);
    expect((await api('GET', '/api/catalog/projects')).json<Array<{ id: string }>>().some(project => project.id === id)).toBe(false);
    expect((await api('GET', `/api/catalog/projects/${id}/sessions`)).json()).toMatchObject({ total: 1, sessions: [expect.objectContaining({ id: sessionId })] });
  });

  it('uses the selected runner binding as the launch cwd, links the session and rejects an unbound launch', async () => {
    await t.tdb.pool.query(`UPDATE runners SET online=true WHERE id='hp'`);
    const created = await api('POST', '/api/catalog/projects', { name: 'Launch me' });
    const id = created.json<{ id: string }>().id;
    const noBinding = await api('POST', '/api/sessions', { runnerId: 'hp', cwd: 'C:\\wrong', model: 'haiku', prompt: 'hello', projectId: id });
    expect(noBinding.statusCode).toBe(422);
    expect(noBinding.json()).toMatchObject({ error: 'needs_binding' });
    await api('PUT', `/api/catalog/projects/${id}/bindings/hp`, { path: 'C:\\work\\launch-me' });
    const launched = await api('POST', '/api/sessions', { runnerId: 'hp', cwd: 'C:\\wrong', model: 'haiku', prompt: 'hello', projectId: id });
    expect(launched.statusCode).toBe(201);
    expect(commands.find(c => c.type === 'fs.stat' && c.payload.path === 'C:\\work\\launch-me')?.payload).toMatchObject({ path: 'C:\\work\\launch-me' });
    expect(launched.json()).toMatchObject({ cwd: 'C:\\work\\launch-me', project: { id, title: 'Launch me' }, catalogProject: { id, name: 'Launch me' } });
    expect((await t.tdb.pool.query(`SELECT project_id,source FROM session_projects WHERE session_id=$1`, [launched.json<{ id: string }>().id])).rows[0]).toEqual({
      project_id: id,
      source: 'explicit',
    });
    expect(
      (await t.tdb.pool.query(`SELECT last_runner_id,last_provider FROM user_preferences WHERE user_id=(SELECT user_id FROM sessions WHERE id=$1)`, [launched.json<{ id: string }>().id])).rows[0],
    ).toEqual({ last_runner_id: 'hp', last_provider: 'claude' });
    await t.tdb.pool.query(`UPDATE runners SET online=false WHERE id='hp'`);
    expect((await api('GET', '/api/preferences/launch')).json()).toEqual({ runnerId: 'vm', provider: 'claude' });
    const sidebar = (await api('GET', '/api/sidebar')).json<{ projects: Array<{ project: { id: string; title: string }; sessions: Array<{ id: string }> }> }>();
    expect(sidebar.projects.find(p => p.project.id === id)).toMatchObject({ project: { title: 'Launch me' }, sessions: [{ id: launched.json<{ id: string }>().id }] });
    const recent = (await api('GET', '/api/catalog/projects?sort=recent')).json<Array<{ name: string; lastEventAt: string | null }>>();
    expect(recent[0]).toMatchObject({ name: 'Launch me' });
    expect(recent[0]!.lastEventAt).not.toBeNull();
  });

  it('does not start a session if the project link cannot be committed before launch', async () => {
    await t.tdb.pool.query(`UPDATE runners SET online=true WHERE id='hp'`);
    const created = await api('POST', '/api/catalog/projects', { name: 'Atomic link' });
    const id = created.json<{ id: string }>().id;
    await api('PUT', `/api/catalog/projects/${id}/bindings/hp`, { path: 'C:\\work\\atomic-link' });
    const starts = commands.filter(c => c.type === 'session.start').length;
    const sessions = await t.tdb.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM sessions WHERE user_id=(SELECT id FROM users WHERE email=$1)`, ['jonasasx@gmail.com']);
    await t.tdb.pool.query(`CREATE FUNCTION reject_catalog_link() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected project link failure'; END $$`);
    await t.tdb.pool.query(`CREATE TRIGGER reject_catalog_link BEFORE INSERT ON session_projects FOR EACH ROW EXECUTE FUNCTION reject_catalog_link()`);
    try {
      const result = await api('POST', '/api/sessions', { runnerId: 'hp', cwd: 'C:\\wrong', model: 'haiku', prompt: 'must not launch', projectId: id });
      expect(result.statusCode).toBe(500);
      expect(commands.filter(c => c.type === 'session.start')).toHaveLength(starts);
      const after = await t.tdb.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM sessions WHERE user_id=(SELECT id FROM users WHERE email=$1)`, ['jonasasx@gmail.com']);
      expect(after.rows[0]!.n).toBe(sessions.rows[0]!.n);
    } finally {
      await t.tdb.pool.query(`DROP TRIGGER reject_catalog_link ON session_projects`);
      await t.tdb.pool.query(`DROP FUNCTION reject_catalog_link()`);
    }
  });

  it('keeps a successful launch successful when launch preferences cannot be stored and logs the failure', async () => {
    await t.tdb.pool.query(`UPDATE runners SET online=true WHERE id='hp'`);
    const created = await api('POST', '/api/catalog/projects', { name: 'Preference failure' });
    const id = created.json<{ id: string }>().id;
    await api('PUT', `/api/catalog/projects/${id}/bindings/hp`, { path: 'C:\\work\\preference-failure' });
    const starts = commands.filter(c => c.type === 'session.start').length;
    const user = await t.tdb.pool.query<{ id: string }>(`SELECT id FROM users WHERE email=$1`, ['jonasasx@gmail.com']);
    await t.tdb.pool.query(`DELETE FROM user_preferences WHERE user_id=$1`, [user.rows[0]!.id]);
    await t.tdb.pool.query(`CREATE FUNCTION reject_launch_preference() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected preference failure'; END $$`);
    await t.tdb.pool.query(`CREATE TRIGGER reject_launch_preference BEFORE INSERT OR UPDATE ON user_preferences FOR EACH ROW EXECUTE FUNCTION reject_launch_preference()`);
    try {
      const result = await api('POST', '/api/sessions', { runnerId: 'hp', cwd: 'C:\\wrong', model: 'haiku', prompt: 'launch succeeds', projectId: id });
      expect(result.statusCode).toBe(201);
      expect(result.json()).toMatchObject({ cwd: 'C:\\work\\preference-failure', catalogProject: { id, name: 'Preference failure' } });
      expect(commands.filter(c => c.type === 'session.start')).toHaveLength(starts + 1);
      expect(logs.some(line => line.includes('launch preferences could not be stored'))).toBe(true);
    } finally {
      await t.tdb.pool.query(`DROP TRIGGER reject_launch_preference ON user_preferences`);
      await t.tdb.pool.query(`DROP FUNCTION reject_launch_preference()`);
    }
  });
});
