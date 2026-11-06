// M4a (tasks 4.4–4.7, Ivan's «идёт вне хаба»): signals from replicated lines, decisions with the toast, the API of
// moving and pinning, the sidebar by projects, projects:reclassify, a session written outside the hub right now.
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ProjectListItem, SessionView, SidebarResponse } from '@agent-hub/shared';
import { FIXTURE_MAPPING, FIXTURE_VAULT, PUBLIC_URL, agentSend, connectFakeAgent, connectUi, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';
import * as F from '../test/transcriptFixtures.js';
import { runCli } from '../cliCommands.js';
import { ProjectService, withDbRetry } from './service.js';

const VAULT = 'C:\\Users\\alice\\vault';
const edit = (o: F.LineOpts, path: string) => ({
  ...F.assistantText(o, ''),
  message: {
    id: `msg_${randomUUID()}`,
    role: 'assistant',
    content: [{ type: 'tool_use', id: `toolu_${randomUUID().slice(0, 8)}`, name: 'Edit', input: { file_path: path, old_string: 'a', new_string: 'b' } }],
  },
});

describe('projects (integration)', () => {
  let t: TestHub;
  let cookie: string;
  let hp: FakeAgent;
  let vm: FakeAgent;
  let clock = Date.now();
  const got: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const api = (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
    t.hub.app.inject({ method, url, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const view = async (id: string) => (await api('GET', `/api/sessions/${id}`)).json() as SessionView;
  async function chunk(agent: FakeAgent, sid: string, rel: string, lines: unknown[], from = 0) {
    const n = got.filter(m => m.type === 'repl.ack' && m.payload.relPath === rel).length;
    agentSend(agent, 'repl.chunk', {
      relPath: rel,
      kind: 'main',
      sessionId: sid,
      generation: 0,
      fromLine: from,
      fromByte: from * 100,
      lines: lines.map(l => JSON.stringify(l)),
      endByte: (from + lines.length) * 100,
    });
    // a chunk also writes S3, the registry and the touches: 5 s is not enough in a loaded full run
    await waitFor(() => got.filter(m => m.type === 'repl.ack' && m.payload.relPath === rel).length > n, 20_000);
    await t.hub.projects.flush();
    return (await t.tdb.pool.query<{ id: string }>(`SELECT id FROM sessions WHERE claude_session_id = $1`, [sid])).rows[0]!.id;
  }

  // A copy of the fixture vault: the last test changes its INDEX.md.
  const vaultDir = mkdtempSync(join(tmpdir(), 'agenthub-int-vault-'));
  cpSync(FIXTURE_VAULT, vaultDir, { recursive: true });

  beforeAll(async () => {
    t = await startTestHub({ env: { VAULT_DIR: vaultDir, LEGACY_PATHS_FILE: FIXTURE_MAPPING }, sessions: { now: () => new Date(clock), idleCheckMs: 0 } });
    const hpToken = await t.addRunner('hp', 'HP');
    const vmToken = await t.addRunner('vm', 'ВМ .3');
    cookie = await t.login();
    hp = connectFakeAgent(t.wsBase, hpToken);
    vm = connectFakeAgent(t.wsBase, vmToken, { hostname: 'vault', os: 'Ubuntu 24.04', homeDir: '/home/ubuntu', vaultRoot: '/home/ubuntu/vault' });
    for (const a of [hp, vm]) a.ws.on('message', d => got.push(JSON.parse(d.toString()) as { type: string; payload: Record<string, unknown> }));
    await hp.next('welcome');
    await vm.next('welcome');
  });
  afterAll(async () => {
    await t.close();
    rmSync(vaultDir, { recursive: true, force: true });
  });

  it('a session in the vault root with 2 edits in 05-agent-hub: the project, the evidence and the toast; a re-sent chunk adds no touches', async () => {
    const ui = connectUi(t.wsBase, cookie);
    await ui.open;
    const sid = randomUUID();
    const o = { sessionId: sid, cwd: VAULT, entrypoint: 'cli' as const };
    const lines = [
      F.userText(o, 'правки agent-hub'),
      edit(o, `${VAULT}\\20-personal\\05-pos\\systems\\05-agent-hub\\CLAUDE.md`),
      edit(o, `${VAULT}\\20-personal\\05-pos\\systems\\05-agent-hub\\README.md`),
    ];
    const id = await chunk(hp, sid, `c--x/${sid}.jsonl`, lines);
    expect(await view(id)).toMatchObject({
      project: { title: '05-agent-hub', colorKey: expect.any(String), kind: 'system', path: '20-personal/05-pos/systems/05-agent-hub' },
      projectSource: 'auto',
      projectEvidence: '2 правки в 05-agent-hub',
    });
    await waitFor(() => ui.received.some(m => m.type === 'toast' && m.kind === 'project_auto'));
    expect(ui.received.find(m => m.type === 'toast')).toMatchObject({ kind: 'project_auto', sessionId: id, text: 'Проект определён: правки agent-hub → 05-agent-hub' });
    const touches = async () => Number((await t.tdb.pool.query(`SELECT count(*) AS n FROM path_touches WHERE session_id = $1`, [id])).rows[0].n);
    expect(await touches()).toBe(2);
    agentSend(hp, 'repl.chunk', { relPath: `c--x/${sid}.jsonl`, kind: 'main', sessionId: sid, generation: 0, fromLine: 0, fromByte: 0, lines: lines.map(l => JSON.stringify(l)), endByte: 300 });
    await new Promise(r => setTimeout(r, 200));
    expect(await touches()).toBe(2);
    ui.ws.close();
  });

  it('Orca worktree with the scanner-fleet remote → 02-scanner-fleet «git remote …»; the vault root on the VM with a token remote — stored without it, no project', async () => {
    const sid = randomUUID();
    const o = { sessionId: sid, cwd: 'C:\\Users\\alice\\orca\\workspaces\\scanner-fleet\\fat-agent', entrypoint: 'cli' as const };
    agentSend(hp, 'repl.meta', { sessionId: sid, cwd: o.cwd, gitRemote: 'git@git.example.com:development/scanner/scanner-fleet.git', gitBranch: 'master' });
    const id = await chunk(hp, sid, `c--orca/${sid}.jsonl`, [F.userText(o, 'чиним агента'), F.assistantText(o, 'ок')]);
    await waitFor(async () => (await view(id)).project.title === '02-scanner-fleet');
    expect((await view(id)).projectEvidence).toBe('git remote development/scanner/scanner-fleet');

    const s2 = randomUUID();
    const o2 = { sessionId: s2, cwd: '/home/ubuntu/vault', entrypoint: 'cli' as const };
    agentSend(vm, 'repl.meta', { sessionId: s2, cwd: o2.cwd, gitRemote: 'https://oauth2:glpat-SECRET@git.example.com/alice/pos.git' });
    const id2 = await chunk(vm, s2, `-home-ubuntu-vault/${s2}.jsonl`, [F.userText(o2, 'что в памяти?'), F.assistantText(o2, 'ничего')]);
    await waitFor(async () => (await t.tdb.pool.query(`SELECT git_remote FROM sessions WHERE id = $1`, [id2])).rows[0].git_remote !== null);
    expect((await t.tdb.pool.query(`SELECT git_remote FROM sessions WHERE id = $1`, [id2])).rows[0].git_remote).toBe('https://git.example.com/alice/pos.git');
    await t.hub.projects.flush();
    expect((await view(id2)).project.id).toBeNull();
  });

  it('an imported session of an unknown machine with old-structure paths: 04-systems/16-scanner-fleet → 02-scanner-fleet', async () => {
    const uid = (await t.tdb.pool.query(`SELECT user_id FROM runners WHERE id = 'hp'`)).rows[0].user_id;
    await t.tdb.pool.query(`INSERT INTO runners (id, user_id, name) VALUES ('unknown-old-laptop', $1, 'old-laptop (машина неизвестна)')`, [uid]);
    const sid = randomUUID();
    const o = { sessionId: sid, cwd: 'C:\\Users\\old\\vault', entrypoint: 'cli' as const, ts: '2026-09-20T10:00:00.000Z' };
    const lines = [F.userText(o, 'правлю карточку флота'), edit(o, 'C:\\Users\\old\\vault\\04-systems\\16-scanner-fleet\\CLAUDE.md')].map(l => JSON.stringify(l));
    await t.hub.sessions.replication!.onChunk(
      'unknown-old-laptop',
      { relPath: `drive-import/${sid}.jsonl`, kind: 'main', sessionId: sid, generation: 0, fromLine: 0, fromByte: 0, lines, endByte: 500 },
      { driveImport: true, readOnly: 'unknown_runner' },
    );
    await t.hub.projects.flush();
    const id = (await t.tdb.pool.query(`SELECT id FROM sessions WHERE claude_session_id = $1`, [sid])).rows[0].id;
    expect(await view(id)).toMatchObject({ project: { title: '02-scanner-fleet' }, projectEvidence: '1 правка в 02-scanner-fleet' });
    expect((await t.tdb.pool.query(`SELECT path_norm FROM path_touches WHERE session_id = $1`, [id])).rows.map(r => r.path_norm)).toEqual(['10-work/01-scanner/repos/scanner-fleet/CLAUDE.md']);
  });

  it('move = pin: holds after 5 edits in 01-ledger; unpin gives the classifier decision; pin; 422 unknown_project; the catalogue and the sidebar', async () => {
    const list = (await api('GET', '/api/projects')).json() as ProjectListItem[];
    expect(list.at(-1)).toEqual({ id: 'none', kind: 'none', title: 'Без проекта', path: '', areaPath: null, colorKey: 'none', archived: false });
    const bridge = list.find(p => p.title === '03-mm-sms-bridge')!;
    expect(list.find(p => p.title === 'Vault')).toMatchObject({ kind: 'builtin', path: '00-meta · 40-automation · .claude' });
    const sid = randomUUID();
    const o = { sessionId: sid, cwd: VAULT, entrypoint: 'cli' as const };
    const id = await chunk(hp, sid, `c--pin/${sid}.jsonl`, [F.userText(o, 'перенос')]);
    const ui = connectUi(t.wsBase, cookie);
    await ui.open;
    const moved = await api('PUT', `/api/sessions/${id}/project`, { projectId: bridge.id });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ project: { title: '03-mm-sms-bridge' }, projectSource: 'manual', projectEvidence: 'закреплено вручную' });
    await waitFor(() => ui.received.some(m => m.type === 'toast' && m.kind === 'project_pinned'));
    const ledger = Array.from({ length: 5 }, (_, i) => edit(o, `${VAULT}\\20-personal\\01-finance\\systems\\01-ledger\\f${i}.py`));
    await chunk(hp, sid, `c--pin/${sid}.jsonl`, ledger, 1);
    expect(await view(id)).toMatchObject({ project: { title: '03-mm-sms-bridge' }, projectSource: 'manual' });
    expect((await t.tdb.pool.query(`SELECT project_id FROM classification_labels WHERE session_id = $1`, [id])).rows[0].project_id).toBe(bridge.id);
    const un = await api('DELETE', `/api/sessions/${id}/pin`);
    expect(un.json()).toMatchObject({ project: { title: '01-ledger' }, projectSource: 'auto', projectEvidence: '5 правок в 01-ledger' });
    expect((await t.tdb.pool.query(`SELECT count(*)::int AS n FROM classification_labels WHERE session_id = $1`, [id])).rows[0].n).toBe(0);
    const twice = await api('DELETE', `/api/sessions/${id}/pin`);
    expect(twice.statusCode).toBe(409);
    expect(twice.json()).toMatchObject({ error: 'not_pinned' });
    expect((await api('POST', `/api/sessions/${id}/pin`)).json()).toMatchObject({ project: { title: '01-ledger' }, projectSource: 'manual' });
    const bad = await api('PUT', `/api/sessions/${id}/project`, { projectId: randomUUID() });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ error: 'unknown_project' });
    expect((await api('PUT', `/api/sessions/${id}/project`, { projectId: 'none' })).json()).toMatchObject({ project: { id: null, title: 'Без проекта' }, projectSource: 'manual' });
    // the sidebar: projects with sessions, «Без проекта» last; «ещё N» of a project
    const sb = (await api('GET', '/api/sidebar')).json() as SidebarResponse;
    expect(sb.projects.at(-1)!.project.id).toBeNull();
    const ah = sb.projects.find(p => p.project.title === '05-agent-hub')!;
    expect(ah).toMatchObject({ total: 1, project: { colorKey: expect.any(String) } });
    const more = (await api('GET', `/api/projects/${ah.project.id}/sessions`)).json() as { total: number; sessions: SessionView[] };
    expect(more.total).toBe(1);
    expect((await api('GET', `/api/projects/${randomUUID()}/sessions`)).statusCode).toBe(404);
    // Ctrl+K by the project's name
    const found = (await api('GET', '/api/search?q=scanner-fleet')).json() as { results: Array<{ match: string; session: SessionView }> };
    expect(found.results.some(r => r.match === 'project' && r.session.project.title === '02-scanner-fleet')).toBe(true);
    ui.ws.close();
  });

  it('projects:reclassify: --dry-run writes nothing, without it the touches and projects are rebuilt, pinned untouched', async () => {
    await t.tdb.pool.query(`UPDATE sessions SET project_id = NULL, project_source = 'none', project_evidence = NULL WHERE project_source = 'auto'`);
    await t.tdb.pool.query(`DELETE FROM path_touches`);
    const env = { VAULT_DIR: FIXTURE_VAULT, LEGACY_PATHS_FILE: FIXTURE_MAPPING };
    const out: string[] = [];
    expect(await runCli(['projects:reclassify', '--dry-run'], t.tdb.db, s => out.push(s), env)).toBe(0);
    expect(out.join('\n')).toMatch(/dry run: sessions \d+: with a project 3, without \d+, pinned 1/);
    expect(out.join('\n')).toContain('05-agent-hub');
    const freshOut: string[] = [];
    expect(await runCli(['projects:reclassify', '--dry-run', '--fresh'], t.tdb.db, x => freshOut.push(x), env)).toBe(0);
    expect(freshOut.join('\n')).toMatch(/dry run: fresh: sessions \d+/);
    expect(Number((await t.tdb.pool.query(`SELECT count(*) AS n FROM path_touches`)).rows[0].n)).toBe(0);
    expect(Number((await t.tdb.pool.query(`SELECT count(*) AS n FROM sessions WHERE project_source = 'auto'`)).rows[0].n)).toBe(0);
    out.length = 0;
    const ui = connectUi(t.wsBase, cookie);
    await ui.open;
    expect(await runCli(['projects:reclassify'], t.tdb.db, s => out.push(s), env)).toBe(0);
    expect(out[out.findIndex(l => l.startsWith('sessions'))]).toMatch(/with a project 3, without \d+, pinned 1, errors 0/);
    // The CLI is another process: NOTIFY → the hub's LISTEN → projects.changed to the windows (no F5).
    await waitFor(() => ui.received.some(m => m.type === 'projects.changed'));
    ui.ws.close();
    const rows = (await t.tdb.pool.query(`SELECT p.title, s.project_source FROM sessions s LEFT JOIN projects p ON p.id = s.project_id WHERE s.project_source <> 'none' ORDER BY p.title NULLS LAST`))
      .rows;
    expect(rows).toEqual([
      { title: '02-scanner-fleet', project_source: 'auto' },
      { title: '02-scanner-fleet', project_source: 'auto' },
      { title: '05-agent-hub', project_source: 'auto' },
      { title: null, project_source: 'manual' },
    ]);
  });

  it('a session written outside the hub right now: externalActive, in «Сейчас»; after 3 minutes of silence — not, with session.upsert', async () => {
    const ui = connectUi(t.wsBase, cookie);
    await ui.open;
    const sid = randomUUID();
    const o = { sessionId: sid, cwd: VAULT, entrypoint: 'cli' as const, ts: new Date(clock).toISOString() };
    const id = await chunk(hp, sid, `c--ext/${sid}.jsonl`, [F.userText(o, 'в терминале'), F.assistantText(o, 'работаю')]);
    const v = await view(id);
    expect(v).toMatchObject({ status: 'closed', externalActive: true });
    expect(v.externalSince).toBe(new Date(clock).toISOString());
    expect(((await api('GET', '/api/sidebar')).json() as SidebarResponse).now.some(s => s.id === id)).toBe(true);
    expect(await t.hub.sessions.checkExternal()).toContain(id);
    clock += 4 * 60_000;
    const mine = () => ui.received.filter(m => m.type === 'session.upsert' && (m as unknown as { session: SessionView }).session.id === id) as unknown as Array<{ session: SessionView }>;
    expect(await t.hub.sessions.checkExternal()).toContain(id);
    const off = await waitFor(() => mine().find(m => m.session.externalActive === false));
    expect(off.session).toMatchObject({ id, externalActive: false, externalSince: null });
    expect(await t.hub.sessions.checkExternal()).not.toContain(id); // no more upserts while it stays silent
    // History (the first replication of an old transcript): lines 2 h old by the hub's clock are not activity.
    const old = randomUUID();
    const oo = { sessionId: old, cwd: VAULT, entrypoint: 'cli' as const, ts: new Date(Date.now() - 2 * 3600_000).toISOString() };
    const oldId = await chunk(hp, old, `c--old/${old}.jsonl`, [F.userText(oo, 'давно'), F.assistantText(oo, 'было')]);
    expect(await view(oldId)).toMatchObject({ externalActive: false, externalSince: null });
    // QA M4a: only the subagents write (the main transcript is quiet) — the session is running outside the hub too
    const multi = randomUUID();
    const mo = { sessionId: multi, cwd: VAULT, entrypoint: 'cli' as const, ts: new Date(clock - 2 * 3600_000).toISOString() };
    const multiId = await chunk(hp, multi, `c--multi/${multi}.jsonl`, [F.userText(mo, 'мультиагент'), F.assistantText(mo, 'запускаю')]);
    expect(await view(multiId)).toMatchObject({ externalActive: false });
    const so = { ...mo, ts: new Date(clock).toISOString() };
    const subRel = `c--multi/${multi}/subagents/agent-s1.jsonl`;
    const acks = got.filter(m => m.type === 'repl.ack' && m.payload.relPath === subRel).length;
    agentSend(hp, 'repl.chunk', {
      relPath: subRel,
      kind: 'subagent',
      agentId: 's1',
      sessionId: multi,
      generation: 0,
      fromLine: 0,
      fromByte: 0,
      lines: [JSON.stringify({ ...F.userText(so, 'задача'), isSidechain: true }), JSON.stringify({ ...F.assistantText(so, 'делаю'), isSidechain: true })],
      endByte: 200,
    });
    await waitFor(() => got.filter(m => m.type === 'repl.ack' && m.payload.relPath === subRel).length > acks);
    expect(await view(multiId)).toMatchObject({ externalActive: true });
    expect((await t.tdb.pool.query(`SELECT last_external_write_at FROM sessions WHERE id = $1`, [multiId])).rows[0].last_external_write_at.toISOString()).toBe(new Date(clock).toISOString());
    // A machine whose clock is 10 min behind (hello.clockMs): its fresh line is live; an hour-old one is not.
    const lagToken = await t.addRunner('lag', 'Отстающие часы');
    const lag = connectFakeAgent(t.wsBase, lagToken, { clockMs: Date.now() - 10 * 60_000 });
    lag.ws.on('message', d => got.push(JSON.parse(d.toString()) as { type: string; payload: Record<string, unknown> }));
    await lag.next('welcome');
    const live = randomUUID();
    const lo = { sessionId: live, cwd: VAULT, entrypoint: 'cli' as const, ts: new Date(clock - 10 * 60_000).toISOString() }; // the hub's clock of this test is `clock`
    expect(await view(await chunk(lag, live, `c--lag/${live}.jsonl`, [F.userText(lo, 'сейчас'), F.assistantText(lo, 'да')]))).toMatchObject({ externalActive: true });
    const hist = randomUUID();
    const ho = { sessionId: hist, cwd: VAULT, entrypoint: 'cli' as const, ts: new Date(clock - 70 * 60_000).toISOString() };
    expect(await view(await chunk(lag, hist, `c--lag/${hist}.jsonl`, [F.userText(ho, 'давно'), F.assistantText(ho, 'было')]))).toMatchObject({ externalActive: false });
    ui.ws.close();
  });

  it('review M4a p. A: one failing session does not stop projects:reclassify (errors, exit 1); deadlocks are retried', async () => {
    const bad = (await t.tdb.pool.query(`SELECT id FROM sessions WHERE project_source = 'auto' ORDER BY id LIMIT 1`)).rows[0].id as string;
    const orig = ProjectService.prototype.rebuild;
    const spy = vi.spyOn(ProjectService.prototype, 'rebuild').mockImplementation(function (this: ProjectService, id: string, dry: boolean) {
      return id === bad ? Promise.reject(new Error('boom')) : orig.call(this, id, dry);
    });
    try {
      const out: string[] = [];
      expect(await runCli(['projects:reclassify', '--dry-run'], t.tdb.db, s => out.push(s), { VAULT_DIR: FIXTURE_VAULT, LEGACY_PATHS_FILE: FIXTURE_MAPPING })).toBe(1);
      expect(out.join('\n')).toContain(`error: session ${bad}: boom`);
      expect(out.join('\n')).toMatch(/with a project 2, without \d+, pinned 1, errors 1/);
    } finally {
      spy.mockRestore();
    }
    let calls = 0;
    const deadlock = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    expect(await withDbRetry(async () => (++calls < 3 ? Promise.reject(deadlock) : 'ok'))).toBe('ok');
    expect(calls).toBe(3);
    calls = 0;
    await expect(withDbRetry(async () => (++calls, Promise.reject(Object.assign(new Error('x'), { code: '23505' }))))).rejects.toThrow('x');
    expect(calls).toBe(1);
  });

  it('prod sample M4a p. 4: the live result equals the rebuild (hysteresis on both paths)', async () => {
    const sid = randomUUID();
    const o = { sessionId: sid, cwd: VAULT, entrypoint: 'cli' as const };
    const rel = `c--hyst/${sid}.jsonl`;
    const ah = (i: number) => edit(o, `${VAULT}\\20-personal\\05-pos\\systems\\05-agent-hub\\h${i}.md`);
    const ledger = (i: number) => edit(o, `${VAULT}\\20-personal\\01-finance\\systems\\01-ledger\\l${i}.py`);
    // first 05-agent-hub (6), then 01-ledger grows to 9: from scratch 01-ledger would win (60%), live keeps 05-agent-hub (9 < 12)
    const id = await chunk(hp, sid, rel, [F.userText(o, 'два проекта'), ah(1), ah(2)]);
    expect((await view(id)).project.title).toBe('05-agent-hub');
    await chunk(hp, sid, rel, [ledger(1), ledger(2), ledger(3)], 3);
    expect((await view(id)).project.title).toBe('05-agent-hub');
    const title = (d: { projectId: string | null } | null) => (d?.projectId ? t.hub.projects.catalog.row(d.projectId)!.title : null);
    expect(title(await t.hub.projects.rebuild(id, true))).toBe('05-agent-hub');
    // --fresh: from scratch, 01-ledger (9 of 15)
    expect(title(await t.hub.projects.rebuild(id, true, true))).toBe('01-ledger');
    expect(title(await t.hub.projects.rebuild(id, false))).toBe('05-agent-hub');
    expect((await view(id)).project.title).toBe('05-agent-hub');
  });

  it('review M4a p. 7: the rebuild of projects:reclassify waits for the touch lock of the session (a chunk being stored)', async () => {
    const id = (await t.tdb.pool.query(`SELECT id FROM sessions WHERE project_source = 'auto' ORDER BY id LIMIT 1`)).rows[0].id as string;
    const c = await t.tdb.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`path_touches:${id}`]);
      let done = false;
      const run = t.hub.projects.rebuild(id, false).then(() => (done = true));
      await new Promise(r => setTimeout(r, 300));
      expect(done).toBe(false);
      await c.query('COMMIT');
      await run;
      expect(done).toBe(true);
    } finally {
      c.release();
    }
  });

  it('catalog refresh preserves stored legacy group colors', async () => {
    const row = (await t.tdb.pool.query(`SELECT id, color_key FROM projects WHERE slug='05-agent-hub' LIMIT 1`)).rows[0];
    await t.tdb.pool.query(`UPDATE projects SET color_key='rose' WHERE id=$1`, [row.id]);
    await t.hub.projects.catalog.reload(true);
    expect(t.hub.projects.catalog.row(row.id)?.colorKey).toBe('rose');
    await t.hub.projects.catalog.reload(true);
    expect((await t.tdb.pool.query(`SELECT color_key FROM projects WHERE id=$1`, [row.id])).rows[0].color_key).toBe('rose');
    await t.tdb.pool.query(`UPDATE projects SET color_key=$1 WHERE id=$2`, [row.color_key, row.id]);
    await t.hub.projects.catalog.reload(true);
  });

  it('review M4a p. 9: a project removed from INDEX.md — one projects.changed, no session.upsert per session; its session decided again', async () => {
    const ui = connectUi(t.wsBase, cookie);
    await ui.open;
    const ah = (
      await t.tdb.pool.query(`SELECT s.id FROM sessions s JOIN projects p ON p.id = s.project_id WHERE p.slug = '05-agent-hub' AND s.project_source = 'auto' AND s.title = 'правки agent-hub'`)
    ).rows.map(r => r.id as string);
    expect(ah).toHaveLength(1);
    const index = readFileSync(join(vaultDir, 'INDEX.md'), 'utf8');
    writeFileSync(
      join(vaultDir, 'INDEX.md'),
      index
        .split('\n')
        .filter(l => !l.startsWith('- [`05-agent-hub`]'))
        .join('\n'),
    );
    expect(await t.hub.projects.catalog.reload(true)).toBe(true);
    await waitFor(() => ui.received.some(m => m.type === 'projects.changed'));
    await new Promise(r => setTimeout(r, 200));
    expect(ui.received.filter(m => m.type === 'projects.changed')).toHaveLength(1);
    expect(ui.received.filter(m => m.type === 'session.upsert')).toHaveLength(0);
    expect(await view(ah[0]!)).toMatchObject({ project: { title: 'Personal OS', kind: 'area' }, projectSource: 'auto' });
    ui.ws.close();
  });
});
