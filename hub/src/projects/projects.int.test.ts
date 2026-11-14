// M4a (tasks 4.4–4.7, Ivan's «идёт вне хаба») and single-project-classifier: the touches from replicated lines, the catalog
// as the only source of a session's project, the API of moving and pinning, the sidebar, the start step that drops the
// legacy projects, projects:reclassify, a session written outside the hub right now.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ProjectListItem, SessionView, SidebarResponse } from '@agent-hub/shared';
import { FIXTURE_VAULT, PUBLIC_URL, agentSend, connectFakeAgent, connectUi, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';
import { seedFixtureVault } from '../test/legacyCatalog.js';
import * as F from '../test/transcriptFixtures.js';
import { runCli } from '../cliCommands.js';
import { ProjectService, withDbRetry } from './service.js';

const VAULT = 'C:\\Users\\alice\\vault';
const AGENT_HUB = `${VAULT}\\20-personal\\05-pos\\systems\\05-agent-hub`;
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
  let agentHub: string;
  let fleetOps: string;
  let legacy: string;
  let edited: string;
  const got: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const api = (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
    t.hub.app.inject({ method, url, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const view = async (id: string) => (await api('GET', `/api/sessions/${id}`)).json() as SessionView;
  const link = async (id: string) =>
    (await t.tdb.pool.query<{ project_id: string; source: string; reason_code: string }>(`SELECT project_id, source, reason_code FROM session_projects WHERE session_id = $1`, [id])).rows[0] ?? null;
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

  beforeAll(async () => {
    t = await startTestHub({ sessions: { now: () => new Date(clock), idleCheckMs: 0 } });
    const hpToken = await t.addRunner('hp', 'HP');
    const vmToken = await t.addRunner('vm', 'ВМ .3');
    cookie = await t.login();
    await seedFixtureVault(t.tdb.db, t.hub.projects.catalog, FIXTURE_VAULT);
    const user = (await t.tdb.pool.query<{ user_id: string }>(`SELECT user_id FROM runners WHERE id = 'hp'`)).rows[0]!.user_id;
    const project = async (name: string, remote: string | null) =>
      (await t.tdb.pool.query<{ id: string }>(`INSERT INTO catalog_projects(user_id, name, remote) VALUES ($1, $2, $3) RETURNING id`, [user, name, remote])).rows[0]!.id;
    agentHub = await project('agent-hub', null);
    fleetOps = await project('fleet-ops', 'https://git.example.com/development/scanner/fleet-ops.git');
    await t.tdb.pool.query(`UPDATE catalog_projects SET folder = '20-personal/05-pos/systems/05-agent-hub' WHERE id = $1`, [agentHub]);
    legacy = (await t.tdb.pool.query<{ id: string }>(`SELECT id FROM projects WHERE slug = '01-ledger' LIMIT 1`)).rows[0]!.id;
    hp = connectFakeAgent(t.wsBase, hpToken);
    vm = connectFakeAgent(t.wsBase, vmToken, { hostname: 'vault', os: 'Ubuntu 24.04', homeDir: '/home/ubuntu', vaultRoot: '/home/ubuntu/vault' });
    for (const a of [hp, vm]) a.ws.on('message', d => got.push(JSON.parse(d.toString()) as { type: string; payload: Record<string, unknown> }));
    await hp.next('welcome');
    await vm.next('welcome');
    await t.tdb.pool.query(`UPDATE runners SET default_dir = CASE id WHEN 'hp' THEN $1 ELSE '/home/ubuntu/vault' END`, [VAULT]);
  });
  afterAll(async () => {
    await t.close();
  });

  it('edits in a legacy group (01-ledger) give no project and no toast; edits under a catalog binding — the link; a re-sent chunk adds no touches', async () => {
    const ui = connectUi(t.wsBase, cookie);
    await ui.open;
    const sid = randomUUID();
    const o = { sessionId: sid, cwd: VAULT, entrypoint: 'cli' as const };
    const ledgerDir = `${VAULT}\\20-personal\\01-finance\\systems\\01-ledger`;
    const lines = [F.userText(o, 'правки бухгалтерии'), edit(o, `${ledgerDir}\\a.py`), edit(o, `${ledgerDir}\\b.py`)];
    const id = await chunk(hp, sid, `c--x/${sid}.jsonl`, lines);
    expect(await view(id)).toMatchObject({ project: { id: null }, projectSource: 'none' });
    expect((await t.tdb.pool.query(`SELECT project_id, secondary_project_id FROM sessions WHERE id = $1`, [id])).rows[0]).toEqual({ project_id: null, secondary_project_id: null });
    expect(await link(id)).toBeNull();
    const touches = async () => Number((await t.tdb.pool.query(`SELECT count(*) AS n FROM path_touches WHERE session_id = $1`, [id])).rows[0].n);
    expect(await touches()).toBe(2);
    agentSend(hp, 'repl.chunk', { relPath: `c--x/${sid}.jsonl`, kind: 'main', sessionId: sid, generation: 0, fromLine: 0, fromByte: 0, lines: lines.map(l => JSON.stringify(l)), endByte: 300 });
    await new Promise(r => setTimeout(r, 200));
    expect(await touches()).toBe(2);
    // the sidebar: the session is in «Без проекта», no group of the legacy catalogue
    const sb = (await api('GET', '/api/sidebar')).json() as SidebarResponse;
    expect(sb.projects.find(p => p.project.id === null)!.sessions.map(s => s.id)).toContain(id);
    expect(sb.projects.some(p => p.project.id === legacy)).toBe(false);

    const s2 = randomUUID();
    const o2 = { sessionId: s2, cwd: VAULT, entrypoint: 'cli' as const };
    edited = await chunk(hp, s2, `c--x/${s2}.jsonl`, [F.userText(o2, 'правки agent-hub'), edit(o2, `${AGENT_HUB}\\CLAUDE.md`), edit(o2, `${AGENT_HUB}\\README.md`)]);
    await waitFor(async () => (await link(edited)) !== null);
    expect(await link(edited)).toEqual({ project_id: agentHub, source: 'auto', reason_code: 'changed_files' });
    expect(await view(edited)).toMatchObject({ project: { id: agentHub, title: 'agent-hub' } });
    expect((await t.tdb.pool.query(`SELECT project_id FROM sessions WHERE id = $1`, [edited])).rows[0].project_id).toBeNull();
    expect(ui.received.some(m => m.type === 'toast' && m.kind === 'project_auto')).toBe(false);
    ui.ws.close();
  });

  it('Orca worktree with the fleet-ops remote → the catalog project by remote; the vault root on the VM with a token remote — stored without it, no project', async () => {
    const sid = randomUUID();
    const o = { sessionId: sid, cwd: 'C:\\Users\\alice\\orca\\workspaces\\fleet-ops\\fat-agent', entrypoint: 'cli' as const };
    agentSend(hp, 'repl.meta', { sessionId: sid, cwd: o.cwd, gitRemote: 'git@git.example.com:development/scanner/fleet-ops.git', gitBranch: 'master' });
    const id = await chunk(hp, sid, `c--orca/${sid}.jsonl`, [F.userText(o, 'чиним агента'), F.assistantText(o, 'ок')]);
    await waitFor(async () => (await link(id))?.project_id === fleetOps);
    expect(await link(id)).toMatchObject({ source: 'auto', reason_code: 'remote' });
    expect((await view(id)).project.title).toBe('fleet-ops');

    const s2 = randomUUID();
    const o2 = { sessionId: s2, cwd: '/home/ubuntu/vault', entrypoint: 'cli' as const };
    agentSend(vm, 'repl.meta', { sessionId: s2, cwd: o2.cwd, gitRemote: 'https://oauth2:glpat-SECRET@git.example.com/alice/pos.git' });
    const id2 = await chunk(vm, s2, `-home-ubuntu-vault/${s2}.jsonl`, [F.userText(o2, 'что в памяти?'), F.assistantText(o2, 'ничего')]);
    await waitFor(async () => (await t.tdb.pool.query(`SELECT git_remote FROM sessions WHERE id = $1`, [id2])).rows[0].git_remote !== null);
    expect((await t.tdb.pool.query(`SELECT git_remote FROM sessions WHERE id = $1`, [id2])).rows[0].git_remote).toBe('https://git.example.com/alice/pos.git');
    await t.hub.projects.flush();
    expect((await view(id2)).project.id).toBeNull();
    expect(await link(id2)).toBeNull();
  });

  it('move and pin: only the catalogue and «Без проекта»; 422 on a legacy id; the sidebar and «ещё N» from the catalogue; Ctrl+K by the catalog name', async () => {
    await t.tdb.pool.query(`UPDATE catalog_projects SET color_key = 'rose' WHERE id = $1`, [fleetOps]);
    const list = (await api('GET', '/api/projects')).json() as ProjectListItem[];
    expect(list.find(p => p.id === fleetOps)?.colorKey).toBe('rose');
    expect(list.at(-1)).toEqual({ id: 'none', kind: 'none', title: 'No project', i18n: { key: 'hub.api.noProject' }, path: '', areaPath: null, colorKey: 'none', archived: false });
    expect(list.some(p => p.title === 'Vault' || p.title === '03-sms-bridge' || p.id === legacy)).toBe(false);
    expect(list.map(p => p.id)).toEqual(expect.arrayContaining([agentHub, fleetOps]));
    const sid = randomUUID();
    const o = { sessionId: sid, cwd: VAULT, entrypoint: 'cli' as const };
    const id = await chunk(hp, sid, `c--pin/${sid}.jsonl`, [F.userText(o, 'перенос')]);
    const moved = await api('PUT', `/api/sessions/${id}/project`, { projectId: fleetOps });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ project: { id: fleetOps, title: 'fleet-ops' } });
    expect(await link(id)).toEqual({ project_id: fleetOps, source: 'manual', reason_code: 'selected' });
    // edits under the agent-hub binding do not move a manual link
    await chunk(hp, sid, `c--pin/${sid}.jsonl`, [edit(o, `${AGENT_HUB}\\a.md`), edit(o, `${AGENT_HUB}\\b.md`)], 1);
    expect(await link(id)).toMatchObject({ project_id: fleetOps, source: 'manual' });
    expect((await api('DELETE', `/api/sessions/${id}/pin`)).json()).toMatchObject({ project: { id: fleetOps } });
    expect(await link(id)).toEqual({ project_id: fleetOps, source: 'auto', reason_code: 'unpinned' });
    // a legacy group is not a project any more: 422, the session unchanged
    for (const projectId of [legacy, randomUUID()]) {
      const bad = await api('PUT', `/api/sessions/${id}/project`, { projectId });
      expect(bad.statusCode).toBe(422);
      expect(bad.json()).toMatchObject({ error: 'unknown_project' });
    }
    expect(await link(id)).toMatchObject({ project_id: fleetOps });
    expect((await t.tdb.pool.query(`SELECT project_id FROM sessions WHERE id = $1`, [id])).rows[0].project_id).toBeNull();
    // «Без проекта» pinned: no link, manual, the label without a project
    expect((await api('PUT', `/api/sessions/${id}/project`, { projectId: 'none' })).json()).toMatchObject({ project: { id: null, title: 'No project' }, projectSource: 'manual' });
    expect(await link(id)).toBeNull();
    expect((await t.tdb.pool.query(`SELECT project_id FROM classification_labels WHERE session_id = $1`, [id])).rows[0].project_id).toBeNull();
    // unpinned, the catalog decides again: the edits under the agent-hub binding
    expect((await api('DELETE', `/api/sessions/${id}/pin`)).json()).toMatchObject({ project: { id: agentHub }, projectSource: 'none' });
    expect(await link(id)).toMatchObject({ project_id: agentHub, source: 'auto', reason_code: 'changed_files' });
    // a session without signals: unpin «Без проекта», 409 the second time, POST pin pins «Без проекта»
    const s2 = randomUUID();
    const bare = await chunk(hp, s2, `c--pin/${s2}.jsonl`, [F.userText({ sessionId: s2, cwd: VAULT, entrypoint: 'cli' }, 'без сигналов')]);
    await api('PUT', `/api/sessions/${bare}/project`, { projectId: 'none' });
    expect((await api('DELETE', `/api/sessions/${bare}/pin`)).json()).toMatchObject({ project: { id: null }, projectSource: 'none' });
    const twice = await api('DELETE', `/api/sessions/${bare}/pin`);
    expect(twice.statusCode).toBe(409);
    expect(twice.json()).toMatchObject({ error: 'not_pinned' });
    expect((await api('POST', `/api/sessions/${bare}/pin`)).json()).toMatchObject({ project: { id: null }, projectSource: 'manual' });
    // the sidebar: catalog groups, one «agent-hub», «Без проекта»; no legacy group
    const sb = (await api('GET', '/api/sidebar')).json() as SidebarResponse;
    expect(sb.projects.filter(p => p.project.title === 'agent-hub')).toHaveLength(1);
    expect(sb.projects.some(p => p.project.id !== null && ![agentHub, fleetOps].includes(p.project.id))).toBe(false);
    const ah = sb.projects.find(p => p.project.id === agentHub)!;
    expect(ah.total).toBe(2);
    const more = (await api('GET', `/api/projects/${agentHub}/sessions`)).json() as { total: number; sessions: SessionView[] };
    expect(more.sessions.map(s => s.id).sort()).toEqual([edited, id].sort());
    const none = (await api('GET', `/api/projects/none/sessions`)).json() as { total: number; sessions: SessionView[] };
    expect(none.sessions.map(s => s.id)).toContain(bare);
    expect((await api('GET', `/api/projects/${legacy}/sessions`)).statusCode).toBe(404);
    expect((await api('GET', `/api/projects/${randomUUID()}/sessions`)).statusCode).toBe(404);
    // Ctrl+K by the name of the catalog project
    const found = (await api('GET', '/api/search?q=fleet-ops')).json() as { results: Array<{ match: string; session: SessionView }> };
    expect(found.results.some(r => r.match === 'project' && r.session.project.id === fleetOps)).toBe(true);
  });

  it('the start step drops the legacy projects: pinned «Без проекта» and pinned links stay, the unlinked ones are evaluated by the catalog; idempotent', async () => {
    const make = async (key: string, cwd = VAULT) => {
      const sid = randomUUID();
      return chunk(hp, sid, `c--legacy/${sid}.jsonl`, [F.userText({ sessionId: sid, cwd, entrypoint: 'cli' }, key)]);
    };
    // c starts in the agent-hub binding: its link is removed, so after the drop the catalog rule links it again
    const [a, b, c, d, e, f] = [await make('a'), await make('b'), await make('c', AGENT_HUB), await make('d'), await make('e'), await make('f')];
    await t.hub.projects.flush();
    await t.tdb.pool.query(`DELETE FROM session_projects WHERE session_id = $1`, [c]);
    const set = (id: string, projectId: string | null, source: string) =>
      t.tdb.pool.query(`UPDATE sessions SET project_id = $2, secondary_project_id = $2, project_evidence = '{"old":true}', project_source = $3 WHERE id = $1`, [id, projectId, source]);
    await set(a, legacy, 'auto');
    await set(b, legacy, 'inherited');
    await set(c, legacy, 'manual');
    await set(d, null, 'manual');
    await set(e, legacy, 'auto');
    await set(f, legacy, 'manual');
    const user = (await t.tdb.pool.query<{ user_id: string }>(`SELECT user_id FROM sessions WHERE id = $1`, [e])).rows[0]!.user_id;
    for (const [id, source, reason] of [
      [e, 'auto', 'cwd'],
      [f, 'manual', 'selected'],
    ]) {
      await t.tdb.pool.query(`INSERT INTO session_projects(user_id, session_id, project_id, source, reason_code) VALUES ($1, $2, $3, $4, $5)`, [user, id, fleetOps, source, reason]);
    }
    const ui = connectUi(t.wsBase, cookie);
    await ui.open;
    expect((await t.hub.projects.dropLegacy()).sort()).toEqual([a, b, c].sort());
    await t.hub.projects.flush();
    const rows = await t.tdb.pool.query<{ id: string; project_id: string | null; secondary_project_id: string | null; project_evidence: string | null; project_source: string }>(
      `SELECT id, project_id, secondary_project_id, project_evidence, project_source FROM sessions WHERE id = ANY($1)`,
      [[a, b, c, d, e, f]],
    );
    expect(rows.rows.every(r => r.project_id === null && r.secondary_project_id === null)).toBe(true);
    // the pinned «Без проекта» (d) is not touched, the rest lose the legacy evidence
    expect(rows.rows.filter(r => r.id !== d).every(r => r.project_evidence === null)).toBe(true);
    const source = new Map(rows.rows.map(r => [r.id, r.project_source]));
    expect([a, b, c, d, e, f].map(id => source.get(id))).toEqual(['none', 'none', 'none', 'manual', 'none', 'manual']);
    await waitFor(async () => (await link(c)) !== null);
    expect(await link(c)).toEqual({ project_id: agentHub, source: 'auto', reason_code: 'cwd' });
    expect(await link(a)).toBeNull();
    expect(await link(e)).toEqual({ project_id: fleetOps, source: 'auto', reason_code: 'cwd' });
    expect(await link(f)).toEqual({ project_id: fleetOps, source: 'manual', reason_code: 'selected' });
    await waitFor(() => ui.received.some(m => m.type === 'session.upsert'));
    ui.ws.close();
    expect(await t.hub.projects.dropLegacy()).toEqual([]);
    expect(Number((await t.tdb.pool.query(`SELECT count(*) AS n FROM sessions WHERE project_id IS NOT NULL OR project_source IN ('auto', 'inherited')`)).rows[0].n)).toBe(0);
    // the test sessions of this case are left without a project for the next ones
    await t.tdb.pool.query(`DELETE FROM session_projects WHERE session_id = ANY($1)`, [[c, e, f]]);
    await t.tdb.pool.query(`UPDATE sessions SET project_source = 'none' WHERE id = ANY($1)`, [[d, f]]);
  });

  it('projects:reclassify: --dry-run writes nothing; without it the touches and the auto links are rebuilt, manual links untouched, projects.changed', async () => {
    const sid = randomUUID();
    const manual = await chunk(hp, sid, `c--re/${sid}.jsonl`, [F.userText({ sessionId: sid, cwd: VAULT, entrypoint: 'cli' }, 'вручную')]);
    await api('PUT', `/api/sessions/${manual}/project`, { projectId: agentHub });
    // the running hub must not re-create links while the CLI counts them
    await t.hub.projects.flush();
    await t.tdb.pool.query(`DELETE FROM session_projects WHERE source = 'auto'`);
    await t.tdb.pool.query(`DELETE FROM path_touches`);
    const out: string[] = [];
    expect(await runCli(['projects:reclassify', '--dry-run'], t.tdb.db, s => out.push(s), {}, { config: t.config })).toBe(0);
    expect(out.join('\n')).toMatch(/dry run: sessions \d+: with a project 1, without \d+, pinned \d+, errors 0/);
    expect(Number((await t.tdb.pool.query(`SELECT count(*) AS n FROM path_touches`)).rows[0].n)).toBe(0);
    expect(Number((await t.tdb.pool.query(`SELECT count(*) AS n FROM session_projects WHERE source = 'auto'`)).rows[0].n)).toBe(0);
    out.length = 0;
    const ui = connectUi(t.wsBase, cookie);
    await ui.open;
    expect(await runCli(['projects:reclassify'], t.tdb.db, s => out.push(s), {}, { config: t.config })).toBe(0);
    expect(out[out.findIndex(l => l.startsWith('sessions'))]).toMatch(/with a project \d+, without \d+, pinned \d+, errors 0/);
    expect(out.some(l => / agent-hub$/.test(l))).toBe(true);
    // The CLI is another process: NOTIFY → the hub's LISTEN → projects.changed to the windows (no F5).
    await waitFor(() => ui.received.some(m => m.type === 'projects.changed'));
    ui.ws.close();
    expect(await link(edited)).toEqual({ project_id: agentHub, source: 'auto', reason_code: 'changed_files' });
    expect(Number((await t.tdb.pool.query(`SELECT count(*) AS n FROM path_touches WHERE session_id = $1`, [edited])).rows[0].n)).toBe(2);
    expect(await link(manual)).toEqual({ project_id: agentHub, source: 'manual', reason_code: 'selected' });
    expect(Number((await t.tdb.pool.query(`SELECT count(*) AS n FROM sessions WHERE project_id IS NOT NULL`)).rows[0].n)).toBe(0);
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
    const bad = (await t.tdb.pool.query(`SELECT session_id FROM session_projects WHERE source = 'auto' ORDER BY session_id LIMIT 1`)).rows[0].session_id as string;
    const orig = ProjectService.prototype.rebuild;
    const spy = vi.spyOn(ProjectService.prototype, 'rebuild').mockImplementation(function (this: ProjectService, id: string) {
      return id === bad ? Promise.reject(new Error('boom')) : orig.call(this, id);
    });
    try {
      const out: string[] = [];
      expect(await runCli(['projects:reclassify'], t.tdb.db, s => out.push(s), {}, { config: t.config })).toBe(1);
      expect(out.join('\n')).toContain(`error: session ${bad}: boom`);
      expect(out.join('\n')).toMatch(/errors 1/);
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

  it('review M4a p. 7: the rebuild of projects:reclassify waits for the touch lock of the session (a chunk being stored)', async () => {
    const id = edited;
    const c = await t.tdb.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`path_touches:${id}`]);
      let done = false;
      const run = t.hub.projects.rebuild(id).then(() => (done = true));
      await new Promise(r => setTimeout(r, 300));
      expect(done).toBe(false);
      await c.query('COMMIT');
      await run;
      expect(done).toBe(true);
    } finally {
      c.release();
    }
  });

  it('the catalogue reload reads the stored legacy group colors from the DB', async () => {
    const row = (await t.tdb.pool.query(`SELECT id, color_key FROM projects WHERE slug='05-agent-hub' LIMIT 1`)).rows[0];
    await t.tdb.pool.query(`UPDATE projects SET color_key='rose' WHERE id=$1`, [row.id]);
    await t.hub.projects.catalog.load();
    expect(t.hub.projects.catalog.row(row.id)?.colorKey).toBe('rose');
    await t.tdb.pool.query(`UPDATE projects SET color_key=$1 WHERE id=$2`, [row.color_key, row.id]);
    await t.hub.projects.catalog.load();
  });
});
