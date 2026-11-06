import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startTestHub, PUBLIC_URL, connectFakeAgent, autoReply, type TestHub } from '../test/harness.js';
import { CatalogDetection } from './detection.js';
import { HttpError } from '../sessions/service.js';
import type { ProjectClassifier } from './haiku.js';

describe('catalog detection and suggestion ownership (Postgres)', () => {
  let t: TestHub;
  let cookie: string;
  let owner: string;
  let foreign: string;
  let project: string;
  let foreignProject: string;
  let detection: CatalogDetection;
  const classify = vi.fn<ProjectClassifier['classify']>();
  const post = (id: string, action: 'accept' | 'dismiss' | 'create', inputHash: string, extra: { projectId?: string; name?: string } = {}) =>
    t.hub.app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/project-suggestion`,
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { action, inputHash, ...(action === 'accept' ? { projectId: extra.projectId ?? project } : {}), ...(extra.name ? { name: extra.name } : {}) },
    });
  const session = async (values: { cwd?: string; remote?: string; user?: string; id?: string } = {}) => {
    const id = values.id ?? randomUUID();
    await t.tdb.pool.query(`INSERT INTO sessions(id,user_id,runner_id,claude_session_id,cwd,git_remote,source,status) VALUES($1,$2,$3,$4,$5,$6,'terminal','closed')`, [
      id,
      values.user ?? owner,
      values.user ? 'foreign' : 'hp',
      randomUUID(),
      values.cwd ?? '/vault',
      values.remote ?? null,
    ]);
    return id;
  };
  const suggestion = async (id: string) => (await t.tdb.pool.query(`SELECT * FROM project_suggestions WHERE session_id=$1`, [id])).rows[0];
  const links = async (id: string) => (await t.tdb.pool.query(`SELECT * FROM session_projects WHERE session_id=$1`, [id])).rows;
  beforeAll(async () => {
    t = await startTestHub({ projects: { classifier: { classify } }, env: { PROJECT_CLASSIFIER_ENABLED: 'true' } });
    cookie = await t.login();
    await t.addRunner('hp');
    owner = (await t.tdb.pool.query(`SELECT user_id FROM runners WHERE id='hp'`)).rows[0].user_id;
    foreign = (await t.tdb.pool.query(`INSERT INTO users(email) VALUES('foreign@example.test') RETURNING id`)).rows[0].id;
    await t.tdb.pool.query(`INSERT INTO runners(id,user_id,name) VALUES('foreign',$1,'Foreign')`, [foreign]);
    project = (
      await t.tdb.pool.query(`INSERT INTO catalog_projects(user_id,name,description,remote) VALUES($1,'Amnezia VPN','WireGuard for Alexander','https://example.test/team/vpn.git') RETURNING id`, [
        owner,
      ])
    ).rows[0].id;
    foreignProject = (await t.tdb.pool.query(`INSERT INTO catalog_projects(user_id,name) VALUES($1,'Foreign secret project') RETURNING id`, [foreign])).rows[0].id;
    await t.tdb.pool.query(`INSERT INTO project_bindings(user_id,project_id,runner_id,path) VALUES($1,$2,'hp','/work/vpn')`, [owner, project]);
    detection = new CatalogDetection({ db: t.tdb.db, config: t.config, projects: t.hub.projects, classifier: { classify }, changed: id => t.hub.sessions.upsert(id), log: { info: () => undefined } });
    classify.mockImplementation(async () => ({ projectId: project, confidence: 0.6, reasonCode: 'topic_match', alternatives: [], newProjectName: 'VPN для друзей' }));
  });
  afterAll(async () => t.close());

  it('external VPN session at vault root with two unrelated reads stays without a project until confirmation', async () => {
    const id = await session({ id: '2efa9fb7-1d15-4ae2-9c3e-32614a6ed1b0' });
    const file = (
      await t.tdb.pool.query(`INSERT INTO transcript_files(user_id,session_id,runner_id,claude_session_id,rel_key,rel_path,kind) VALUES($1,$2,'hp',$3,'vpn.jsonl','vpn.jsonl','main') RETURNING id`, [
        owner,
        id,
        randomUUID(),
      ])
    ).rows[0].id;
    for (const [i, payload] of [
      { type: 'user', message: { content: 'VPN-конфиг Amnezia WG для Александра Нинбурга' } },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: '/vault/CLAUDE.md' } },
            { type: 'tool_use', name: 'Read', input: { file_path: '/vault/INDEX.md' } },
          ],
        },
      },
    ].entries())
      await t.tdb.pool.query(`INSERT INTO events(file_id,generation,line_no,session_id,type,ts,payload) VALUES($1,0,$2,$3,$4,now(),$5)`, [file, i + 1, id, payload.type, JSON.stringify(payload)]);
    for (let i = 1; i <= 6; i++) {
      await t.tdb.pool.query(`INSERT INTO events(file_id,generation,line_no,session_id,type,ts,payload) VALUES($1,0,$2,$3,'user',now(),$4)`, [
        file,
        i + 2,
        id,
        JSON.stringify({ type: 'user', message: { content: `extra human ${i}` } }),
      ]);
    }
    t.hub.projects.schedule(id);
    await t.hub.projects.flush();
    expect(await links(id)).toHaveLength(0);
    const pending = await suggestion(id);
    expect(pending).toMatchObject({ project_id: project, state: 'pending', reason_code: 'topic_match' });
    expect(JSON.stringify(pending)).not.toContain('Нинбурга');
    const input = classify.mock.calls.at(-1)![1];
    expect(input).toContain('Amnezia');
    expect(input).not.toContain('Foreign secret');
    expect(input).not.toContain('CLAUDE.md');
    expect(input).toContain('extra human 4');
    expect(input).not.toContain('extra human 5');
    const view = await t.hub.sessions.upsert(id);
    expect(view.catalogProject).toBeUndefined();
    expect(view.project.id).toBeNull();
    expect(view.projectSuggestion).toMatchObject({ options: [{ projectId: project, name: 'Amnezia VPN' }], newProjectName: 'VPN для друзей' });
    expect((await post(id, 'accept', pending.input_hash)).statusCode).toBe(200);
    expect((await post(id, 'accept', pending.input_hash)).statusCode).toBe(200);
    expect(await links(id)).toEqual([expect.objectContaining({ project_id: project, source: 'manual' })]);
    expect((await suggestion(id)).state).toBe('accepted');
    const calls = classify.mock.calls.length;
    await detection.evaluate(id);
    expect(classify.mock.calls.length).toBe(calls);
  });

  it('evaluates the first message of a new hub launch without assigning the model candidate', async () => {
    const token = await t.addRunner('launch');
    const agent = connectFakeAgent(t.wsBase, token);
    autoReply(agent, type => (type === 'fs.stat' ? { exists: true, isDir: true } : {}));
    await agent.next('welcome');
    try {
      const launched = await t.hub.app.inject({
        method: 'POST',
        url: '/api/sessions',
        cookies: { ah_session: cookie },
        headers: { origin: PUBLIC_URL },
        payload: { runnerId: 'launch', cwd: 'C:\\vault', model: 'haiku', prompt: 'Configure Amnezia VPN' },
      });
      expect(launched.statusCode).toBe(201);
      const id = launched.json<{ id: string }>().id;
      await t.hub.projects.flush();
      expect(await links(id)).toHaveLength(0);
      expect((await suggestion(id)).project_id).toBe(project);
    } finally {
      agent.ws.close();
    }
  });

  it('uses exact cwd and remote before Haiku; pins win and sidebar lists one catalog group', async () => {
    const calls = classify.mock.calls.length;
    const id = await session({ cwd: '/work/vpn' });
    await detection.evaluate(id, 'hello');
    expect(await links(id)).toEqual([expect.objectContaining({ source: 'auto', reason_code: 'cwd' })]);
    const remote = await session({ remote: 'git@example.test:team/vpn.git' });
    await detection.evaluate(remote, 'hello');
    expect(await links(remote)).toEqual([expect.objectContaining({ source: 'auto', reason_code: 'remote' })]);
    expect(classify.mock.calls.length).toBe(calls);
    const next = (await t.tdb.pool.query(`INSERT INTO catalog_projects(user_id,name,remote) VALUES($1,'Other owned project','https://example.test/team/other.git') RETURNING id`, [owner])).rows[0].id;
    await t.tdb.pool.query(`UPDATE sessions SET git_remote='https://example.test/team/other.git' WHERE id=$1`, [remote]);
    await detection.evaluate(remote);
    expect(await links(remote)).toEqual([expect.objectContaining({ source: 'auto', project_id: next })]);
    await t.tdb.pool.query(`UPDATE session_projects SET source='manual' WHERE session_id=$1`, [remote]);
    await t.tdb.pool.query(`UPDATE sessions SET git_remote='https://example.test/team/vpn.git' WHERE id=$1`, [remote]);
    await detection.evaluate(remote);
    expect(await links(remote)).toEqual([expect.objectContaining({ source: 'manual', project_id: next })]);
    expect(classify.mock.calls.length).toBe(calls);
    const sidebar = await t.hub.app.inject({ method: 'GET', url: '/api/sidebar', cookies: { ah_session: cookie } });
    expect(sidebar.statusCode).toBe(200);
    const legacy = (await t.tdb.pool.query(`INSERT INTO projects(user_id,kind,path,slug,title,color_key,origin) VALUES($1,'repo','legacy-vpn','legacy','Legacy','none','repos') RETURNING id`, [owner]))
      .rows[0].id;
    await t.tdb.pool.query(`UPDATE sessions SET project_id=$2,project_source='auto' WHERE id=$1`, [id, legacy]);
    const visible = (await t.hub.app.inject({ method: 'GET', url: '/api/sidebar', cookies: { ah_session: cookie } })).json();
    expect(JSON.stringify(visible)).not.toContain('Legacy');
    const groups = visible.projects as Array<{ sessions: Array<{ id: string }> }>;
    expect(groups.flatMap(group => group.sessions).filter(row => row.id === id)).toHaveLength(1);
  });

  it('supports dismissal, none, low confidence, foreign ids, stale and owner checks', async () => {
    const id = await session();
    await detection.evaluate(id, 'VPN password=never-send-this');
    expect(classify.mock.calls.at(-1)![1]).not.toContain('never-send-this');
    let pending = await suggestion(id);
    expect((await post(id, 'dismiss', '0'.repeat(64))).statusCode).toBe(409);
    expect((await post(id, 'dismiss', pending.input_hash)).statusCode).toBe(200);
    expect((await post(id, 'dismiss', pending.input_hash)).statusCode).toBe(200);
    const calls = classify.mock.calls.length;
    await detection.evaluate(id, 'VPN password=never-send-this');
    expect(classify.mock.calls.length).toBe(calls);
    expect(await links(id)).toHaveLength(0);
    const other = await session({ user: foreign });
    await t.tdb.pool.query(`INSERT INTO project_suggestions(user_id,session_id,project_id,confidence,reason_code,input_hash,messages_hash) VALUES($1,$2,$3,.8,'topic_match',$4,$4)`, [
      foreign,
      other,
      foreignProject,
      'a'.repeat(64),
    ]);
    expect((await post(other, 'accept', 'a'.repeat(64))).statusCode).toBe(404);
    for (const result of [
      { projectId: null, confidence: 0.9, reasonCode: 'no_project' as const, alternatives: [], newProjectName: null },
      { projectId: foreignProject, confidence: 1, reasonCode: 'topic_match' as const, alternatives: [foreignProject], newProjectName: null },
    ]) {
      classify.mockResolvedValueOnce(result);
      const none = await session();
      await detection.evaluate(none, 'Unrelated question');
      pending = await suggestion(none);
      expect(pending.project_id).toBeNull();
      expect(pending.options).toEqual([]);
      expect(await links(none)).toHaveLength(0);
      expect((await t.hub.sessions.upsert(none)).projectSuggestion).toMatchObject({ options: [], newProjectName: null });
    }
    // a foreign project id cannot be accepted even with the right hash
    const own = await session();
    await detection.evaluate(own, 'VPN again');
    expect((await post(own, 'accept', (await suggestion(own)).input_hash, { projectId: foreignProject })).statusCode).toBe(409);
    await expect(
      t.tdb.pool.query(`INSERT INTO project_suggestions(user_id,session_id,project_id,confidence,reason_code,input_hash,messages_hash) VALUES($1,$2,$3,.5,'topic_match','x','x')`, [
        owner,
        id,
        foreignProject,
      ]),
    ).rejects.toThrow();
  });

  it('reassesses unlinked sessions after catalog changes; pinned and legacy sessions remain intact', async () => {
    const id = await session();
    await detection.evaluate(id, 'VPN task');
    const pinned = await session({ cwd: '/work/vpn' });
    await detection.evaluate(pinned, 'pinned');
    await t.tdb.pool.query(`UPDATE session_projects SET source='explicit' WHERE session_id=$1`, [pinned]);
    // Replay first text as an existing main transcript, as CLI replication does.
    const f = (
      await t.tdb.pool.query(`INSERT INTO transcript_files(user_id,session_id,runner_id,claude_session_id,rel_key,rel_path,kind) VALUES($1,$2,'hp',$3,$4,$4,'main') RETURNING id`, [
        owner,
        id,
        randomUUID(),
        `${id}.jsonl`,
      ])
    ).rows[0].id;
    await t.tdb.pool.query(`INSERT INTO events(file_id,generation,line_no,session_id,type,ts,payload) VALUES($1,0,1,$2,'user',now(),$3)`, [
      f,
      id,
      JSON.stringify({ type: 'user', message: { content: 'VPN task' } }),
    ]);
    const renamed = await t.hub.app.inject({
      method: 'PATCH',
      url: `/api/catalog/projects/${project}`,
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { name: 'Renamed VPN' },
    });
    expect(renamed.statusCode).toBe(200);
    await t.hub.projects.flush();
    expect(await links(id)).toHaveLength(0);
    expect((await suggestion(id)).state).toBe('pending');
    expect((await t.hub.sessions.upsert(id)).projectSuggestion?.options[0]?.name).toBe('Renamed VPN');
    expect(await links(pinned)).toEqual([expect.objectContaining({ source: 'explicit' })]);
  });
  it('classifies edit calls outside vault, persists limits, and contains timeouts and network failures', async () => {
    const id = await session();
    const file = (
      await t.tdb.pool.query(`INSERT INTO transcript_files(user_id,session_id,runner_id,claude_session_id,rel_key,rel_path,kind) VALUES($1,$2,'hp',$3,$4,$4,'main') RETURNING id`, [
        owner,
        id,
        randomUUID(),
        `${id}.jsonl`,
      ])
    ).rows[0].id;
    await t.tdb.pool.query(`INSERT INTO events(file_id,generation,line_no,session_id,type,ts,payload) VALUES($1,0,1,$2,'assistant',now(),$3)`, [
      file,
      id,
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/work/vpn/config' } }] } }),
    ]);
    const calls = classify.mock.calls.length;
    await detection.evaluate(id, 'edit');
    expect(await links(id)).toEqual([expect.objectContaining({ source: 'auto', reason_code: 'changed_files' })]);
    expect(classify.mock.calls.length).toBe(calls);
    const limited = new CatalogDetection({
      db: t.tdb.db,
      config: { ...t.config, PROJECT_CLASSIFIER_MAX_CALLS_PER_SESSION: 1 },
      projects: t.hub.projects,
      classifier: { classify },
      changed: async () => undefined,
      log: { info: () => undefined },
    });
    const overBudget = await session();
    await t.tdb.pool.query(`INSERT INTO project_classifier_usage(user_id,session_id) VALUES($1,$2)`, [owner, overBudget]);
    await limited.evaluate(overBudget, 'VPN');
    expect(classify.mock.calls.length).toBe(calls);
    expect(await links(overBudget)).toHaveLength(0);
    const failed = await session();
    classify.mockRejectedValueOnce(new Error('runner_offline'));
    await detection.evaluate(failed, 'VPN retry');
    expect(classify.mock.calls.length).toBe(calls + 1);
    expect(await suggestion(failed)).toBeUndefined();
    const timeout = new CatalogDetection({
      db: t.tdb.db,
      config: { ...t.config, PROJECT_CLASSIFIER_TIMEOUT_MS: 20 },
      projects: t.hub.projects,
      classifier: { classify: () => new Promise(() => undefined) },
      changed: async () => undefined,
      log: { info: () => undefined },
    });
    const slow = await session();
    await timeout.evaluate(slow, 'VPN slow');
    expect(await suggestion(slow)).toBeUndefined();
    expect(await links(slow)).toHaveLength(0);
    const daily = new CatalogDetection({
      db: t.tdb.db,
      config: { ...t.config, PROJECT_CLASSIFIER_DAILY_LIMIT_PER_USER: 1 },
      projects: t.hub.projects,
      classifier: { classify },
      changed: async () => undefined,
      log: { info: () => undefined },
    });
    const before = classify.mock.calls.length;
    await daily.evaluate(await session(), 'VPN daily');
    expect(classify.mock.calls.length).toBe(before);
  });
  it('auto-assigns confident answers and creates the proposed project from the card', async () => {
    classify.mockResolvedValueOnce({ projectId: project, confidence: 0.85, reasonCode: 'topic_match', alternatives: [], newProjectName: null });
    const sure = await session();
    await detection.evaluate(sure, 'Add a WireGuard peer');
    expect(await links(sure)).toEqual([expect.objectContaining({ project_id: project, source: 'auto', reason_code: 'classifier' })]);
    expect(await suggestion(sure)).toBeUndefined();
    classify.mockResolvedValueOnce({ projectId: null, confidence: 0.3, reasonCode: 'no_project', alternatives: [project], newProjectName: 'Домашний роутер' });
    const fresh = await session();
    await detection.evaluate(fresh, 'Configure the home router');
    const card = (await t.hub.sessions.upsert(fresh)).projectSuggestion!;
    expect(card).toMatchObject({ options: [{ projectId: project }], newProjectName: 'Домашний роутер' });
    const taken = (await t.tdb.pool.query(`SELECT name FROM catalog_projects WHERE id=$1`, [project])).rows[0].name;
    expect((await post(fresh, 'create', card.inputHash, { name: taken })).statusCode).toBe(409);
    const created = await post(fresh, 'create', card.inputHash, { name: 'Домашний роутер' });
    expect(created.statusCode).toBe(200);
    const row = (await t.tdb.pool.query(`SELECT id, color_key FROM catalog_projects WHERE user_id=$1 AND name='Домашний роутер'`, [owner])).rows[0];
    expect(row.color_key).toBeTruthy();
    expect(await links(fresh)).toEqual([expect.objectContaining({ project_id: row.id, source: 'manual', reason_code: 'confirmed' })]);
    expect((await suggestion(fresh)).state).toBe('accepted');
  });
  it('skips cron, spawned and old replicated sessions and refunds attempts when no machine is online', async () => {
    const before = classify.mock.calls.length;
    const cron = await session();
    await t.tdb.pool.query(`UPDATE sessions SET source='cron' WHERE id=$1`, [cron]);
    const old = await session();
    await t.tdb.pool.query(`UPDATE sessions SET first_event_at=now() - interval '3 days' WHERE id=$1`, [old]);
    const parent = await session();
    const child = await session();
    await t.tdb.pool.query(`UPDATE sessions SET spawned_by=$2 WHERE id=$1`, [child, parent]);
    for (const id of [cron, old, child]) await detection.evaluate(id, 'VPN history');
    expect(classify.mock.calls.length).toBe(before);
    for (const id of [cron, old, child]) expect(await suggestion(id)).toBeUndefined();
    const offline = new CatalogDetection({
      db: t.tdb.db,
      config: t.config,
      projects: t.hub.projects,
      classifier: { classify: async () => Promise.reject(new HttpError(409, 'runner_offline')) },
      changed: async () => undefined,
      log: { info: () => undefined },
    });
    const waiting = await session();
    for (let i = 0; i < 4; i++) await offline.evaluate(waiting, 'VPN offline');
    const usage = await t.tdb.pool.query(`SELECT count(*)::int n FROM project_classifier_usage WHERE session_id=$1`, [waiting]);
    expect(usage.rows[0].n).toBe(0);
    await detection.evaluate(waiting, 'VPN offline');
    expect(classify.mock.calls.length).toBe(before + 1);
    expect(await suggestion(waiting)).toMatchObject({ state: 'pending' });
  });

  it('drops a stale rule link when its binding is gone and lets the classifier decide', async () => {
    const stale = (await t.tdb.pool.query(`INSERT INTO catalog_projects(user_id,name) VALUES($1,'Stale binding project') RETURNING id`, [owner])).rows[0].id;
    await t.tdb.pool.query(`INSERT INTO project_bindings(user_id,project_id,runner_id,path) VALUES($1,$2,'hp','/work/stale')`, [owner, stale]);
    const id = await session({ cwd: '/work/stale' });
    await detection.evaluate(id, 'hello');
    expect(await links(id)).toEqual([expect.objectContaining({ source: 'auto', reason_code: 'cwd' })]);
    await t.tdb.pool.query(`DELETE FROM project_bindings WHERE project_id=$1`, [stale]);
    await detection.evaluate(id, undefined, true);
    expect(await links(id)).toHaveLength(0);
    expect(await suggestion(id)).toBeUndefined();
    const before = classify.mock.calls.length;
    await detection.evaluate(id, 'VPN task');
    expect(classify.mock.calls.length).toBe(before + 1);
    expect(await suggestion(id)).toMatchObject({ state: 'pending' });
  });
});
