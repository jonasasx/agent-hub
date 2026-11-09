// mcp-hub-only tasks 2.2–2.6: import v2 decisions, auto-import on hello, machine overrides and importState.
// Scenarios — openspec/changes/mcp-hub-only/specs/mcp-registry/spec.md and specs/machine-mcp-onboarding/spec.md.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MCP_IMPORT_V2_CAPABILITY, MCP_REGISTRY_CAPABILITIES, type McpImportPreviewResponse } from '@agent-hub/shared';
import { agentSend, autoReply, connectFakeAgent, PUBLIC_URL, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';
import { upsertUser } from '../auth/sessions.js';
import { addRunner, issueRunnerToken } from '../runners/repo.js';

type Entry = Record<string, unknown>;
type Scan = { servers: Entry[]; secretValues?: Entry[] } | null;

const V2 = [...MCP_REGISTRY_CAPABILITIES, MCP_IMPORT_V2_CAPABILITY];

describe('MCP import v2 and machine overrides (integration)', () => {
  let t: TestHub;
  let cookie: string;
  let userId: string;
  let projectId: string;
  const agents: FakeAgent[] = [];
  const scans = new Map<string, (payload: Record<string, unknown>) => Scan>();
  const previewRequests: Array<{ machineId: string; payload: Record<string, unknown> }> = [];

  const api = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    t.hub.app.inject({ method, url, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, ...(payload !== undefined ? { payload: payload as object } : {}) });

  /** A machine whose agent answers `mcp.import.preview` with what `scans` holds for it; null — no answer. */
  async function machine(id: string, capabilities: readonly string[], state: 'done' | 'auto-pending' = 'done') {
    const token = await t.addRunner(id);
    await t.tdb.pool.query(`UPDATE runners SET mcp_import_state = $2 WHERE id = $1`, [id, state]);
    const agent = connectFakeAgent(t.wsBase, token, { capabilities: [...capabilities] });
    agents.push(agent);
    autoReply(agent, (type, payload) => {
      if (type !== 'mcp.import.preview') return type === 'fs.stat' ? { exists: true, isDir: true } : {};
      previewRequests.push({ machineId: id, payload });
      const scan = scans.get(id)?.(payload);
      if (scan) agentSend(agent, 'mcp.import.preview.result', { importId: randomUUID(), secretsCaptured: scan.secretValues?.length ?? 0, warnings: [], ...scan });
      return {};
    });
    await agent.next('welcome');
    return agent;
  }

  const entry = (machineId: string, name: string, extra: Entry = {}): Entry => ({
    id: randomUUID(),
    name,
    enabled: true,
    transport: 'stdio',
    mode: 'per-session',
    command: 'node',
    args: [`${name}.js`],
    machineScope: { allMachines: false, machineIds: [machineId] },
    projectIds: [],
    revision: 1,
    source: 'user',
    ...extra,
  });

  async function preview(machineId: string, scan: Scan) {
    scans.set(machineId, () => scan);
    const response = await api('POST', '/api/mcp/registry/import/preview', { machineId });
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as McpImportPreviewResponse;
  }

  const commit = (view: McpImportPreviewResponse, serverIds: string[]) =>
    api('POST', '/api/mcp/registry/import/commit', { importId: view.importId, revision: view.revision, serverIds, userConfirmed: true });

  async function createServer(name: string, extra: Entry = {}) {
    const created = await api('POST', '/api/mcp/registry', {
      server: {
        id: randomUUID(),
        name,
        enabled: true,
        transport: 'stdio',
        mode: 'per-session',
        command: 'node',
        args: [`${name}.js`],
        machineScope: { allMachines: true, machineIds: [] },
        projectIds: [],
        ...extra,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    return (created.json() as { id: string }).id;
  }

  const serverRow = async (id: string) =>
    (await t.tdb.pool.query<{ config: Record<string, unknown>; revision: string }>(`SELECT config, revision FROM mcp_registry_servers WHERE id = $1`, [id])).rows[0]!;

  const lastSync = (agent: FakeAgent, predicate: (servers: Entry[]) => boolean) =>
    waitFor(
      () =>
        agent.messages
          .filter(m => m.type === 'mcp.registry.sync')
          .reverse()
          .find(m => predicate((m.payload.servers ?? []) as Entry[])) ?? null,
    );

  beforeAll(async () => {
    t = await startTestHub({ env: { SUBSCRIPTION_TOKEN_KEY: Buffer.alloc(32, 23).toString('base64') }, mcpRegistry: { importTimeoutMs: 1500, validationTimeoutMs: 1000 } });
    cookie = await t.login();
    userId = (await t.tdb.pool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, ['alice@example.com'])).rows[0]!.id;
    projectId = (await t.tdb.pool.query<{ id: string }>(`INSERT INTO catalog_projects(user_id, name) VALUES ($1, $2) RETURNING id`, [userId, 'import_project'])).rows[0]!.id;
  }, 120_000);

  afterAll(async () => {
    for (const agent of agents) {
      expect(agent.protocolErrors).toEqual([]);
      agent.ws.close();
    }
    await t?.close();
  });

  it('imports a new server with encrypted secrets, masks them and shows the claude.ai notice', async () => {
    await machine('imp-new', V2);
    const value = 'MCP_IMPORT_V2_SECRET_51ab';
    const server = entry('imp-new', 'imp_new_probe', { transport: 'http', mode: 'remote', command: undefined, args: undefined, url: 'https://mcp.example.test/mcp' });
    const view = await preview('imp-new', {
      servers: [server],
      secretValues: [
        { serverName: 'imp_new_probe', entryId: server.id, location: 'url', key: 'api_key', value },
        { serverName: 'imp_new_probe', entryId: server.id, location: 'header', key: 'Authorization', value: `Bearer ${value}` },
      ],
    });
    expect(JSON.stringify(view)).not.toContain(value);
    expect(view.notices).toEqual(['claude-ai-connectors']);
    expect(view.servers).toEqual([
      expect.objectContaining({ id: server.id, decision: 'new', selected: true, selectable: true, secrets: [expect.objectContaining({ masked: true }), expect.objectContaining({ masked: true })] }),
    ]);

    const empty = await commit(view, []);
    expect(empty.statusCode).toBe(400);
    const committed = await commit(view, [String(server.id)]);
    expect(committed.statusCode, committed.body).toBe(200);
    expect(committed.json()).toMatchObject({ imported: 1, servers: [{ name: 'imp_new_probe', decision: 'new' }] });
    const serverId = (committed.json() as { servers: Array<{ serverId: string }> }).servers[0]!.serverId;
    const row = await serverRow(serverId);
    expect(row.config).toMatchObject({ mode: 'remote', machineScope: { allMachines: false, machineIds: ['imp-new'] }, projectIds: [] });
    const secrets = (
      await t.tdb.pool.query<{ server_id: string; import_id: string | null; ciphertext: Buffer }>(`SELECT server_id, import_id, ciphertext FROM mcp_secrets WHERE server_id = $1`, [serverId])
    ).rows;
    expect(secrets).toHaveLength(2);
    expect(secrets.every(secret => secret.import_id === null && !secret.ciphertext.includes(Buffer.from(value)))).toBe(true);
    const again = await commit(view, [String(server.id)]);
    expect(again.statusCode).toBe(409);
  });

  it('imports a server whose local config has empty sensitive values, dropping them with a warning', async () => {
    await machine('imp-empty', V2);
    const stdio = entry('imp-empty', 'imp_empty_banana', { env: { GEMINI_API_KEY: { kind: 'literal', value: '' }, MODE: { kind: 'literal', value: 'fast' } } });
    const remote = entry('imp-empty', 'imp_empty_remote', {
      transport: 'http',
      mode: 'remote',
      command: undefined,
      args: undefined,
      url: 'https://mcp.example.test/mcp?token=&region=eu',
      headers: { Authorization: { kind: 'literal', value: '' } },
    });
    const view = await preview('imp-empty', { servers: [stdio, remote] });
    expect(view.servers.map(server => server.name)).toEqual(['imp_empty_banana', 'imp_empty_remote']);
    expect(view.warnings).toEqual(expect.arrayContaining(['imp_empty_banana: empty GEMINI_API_KEY not imported', 'imp_empty_remote: empty Authorization, token not imported']));
    const committed = await commit(view, [String(stdio.id), String(remote.id)]);
    expect(committed.statusCode, committed.body).toBe(200);
    const ids = (committed.json() as { servers: Array<{ name: string; serverId: string }> }).servers;
    const banana = await serverRow(ids.find(server => server.name === 'imp_empty_banana')!.serverId);
    expect(banana.config).toMatchObject({ env: { MODE: { kind: 'literal', value: 'fast' } } });
    expect(banana.config.env).not.toHaveProperty('GEMINI_API_KEY');
    const remoteRow = await serverRow(ids.find(server => server.name === 'imp_empty_remote')!.serverId);
    expect(remoteRow.config.url).toBe('https://mcp.example.test/mcp?region=eu');
    expect(remoteRow.config.headers ?? {}).toEqual({});
  });

  it('decides add-machine, machine-config and unchanged against the registry and applies them', async () => {
    const agent = await machine('imp-dec', V2);
    const sameId = await createServer('imp_same', { machineScope: { allMachines: false, machineIds: ['imp-other'] } });
    const diffId = await createServer('imp_diff');
    await createServer('imp_kept');
    const same = entry('imp-dec', 'imp_same');
    const diff = entry('imp-dec', 'imp_diff', { args: ['changed.js'] });
    const kept = entry('imp-dec', 'imp_kept');
    const fresh = entry('imp-dec', 'imp_fresh');
    const skipped = entry('imp-dec', 'imp_skipped');
    const view = await preview('imp-dec', { servers: [same, diff, kept, fresh, skipped] });
    const byName = new Map(view.servers.map(server => [server.name, server]));
    expect(byName.get('imp_same')).toMatchObject({ decision: 'add-machine', selected: true });
    expect(byName.get('imp_diff')).toMatchObject({ decision: 'machine-config', selected: true });
    expect(byName.get('imp_kept')).toMatchObject({ decision: 'unchanged', selected: false, selectable: false });
    expect(byName.get('imp_fresh')).toMatchObject({ decision: 'new', selected: true });

    const diffBefore = await serverRow(diffId);
    const committed = await commit(view, [String(same.id), String(diff.id), String(fresh.id)]);
    expect(committed.statusCode, committed.body).toBe(200);
    expect(committed.json()).toMatchObject({ imported: 3 });
    expect((await serverRow(sameId)).config).toMatchObject({ machineScope: { allMachines: false, machineIds: ['imp-other', 'imp-dec'] } });
    expect((await serverRow(diffId)).config.args).toEqual(diffBefore.config.args);
    const override = (await t.tdb.pool.query<{ config: Record<string, unknown> }>(`SELECT config FROM mcp_registry_machine_overrides WHERE server_id = $1 AND runner_id = $2`, [diffId, 'imp-dec']))
      .rows[0];
    expect(override?.config).toMatchObject({ args: ['changed.js'] });
    expect((await t.tdb.pool.query(`SELECT 1 FROM mcp_registry_servers WHERE user_id = $1 AND name = 'imp_skipped'`, [userId])).rowCount).toBe(0);
    const sync = await lastSync(agent, servers => servers.some(server => server.id === diffId && JSON.stringify(server.args) === JSON.stringify(['changed.js'])));
    expect(sync.payload.servers).toEqual(expect.arrayContaining([expect.objectContaining({ id: sameId }), expect.objectContaining({ name: 'imp_fresh' })]));
    const audit = await t.tdb.pool.query<{ details: { servers: unknown[] } }>(
      `SELECT details FROM mcp_registry_audit WHERE user_id = $1 AND action = 'import.commit' ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    expect(audit.rows[0]?.details.servers).toHaveLength(3);

    const reimport = await preview('imp-dec', { servers: [entry('imp-dec', 'imp_same'), entry('imp-dec', 'imp_diff', { args: ['changed.js'] }), entry('imp-dec', 'imp_later')] });
    expect(reimport.servers.map(server => [server.name, server.decision, server.selected])).toEqual([
      ['imp_same', 'unchanged', false],
      ['imp_diff', 'unchanged', false],
      ['imp_later', 'new', true],
    ]);
  });

  it('marks same-name project entries as conflicts, skips unbound paths and binds a project server', async () => {
    await machine('imp-proj', V2);
    // session-folder: the project root on the machine is its default folder plus the project's folder
    await t.tdb.pool.query(`UPDATE runners SET home_dir = $1, default_dir = $2 WHERE id = 'imp-proj'`, ['C:\\Users\\imp', 'C:\\work']);
    await t.tdb.pool.query(`UPDATE catalog_projects SET folder = 'import' WHERE id = $1`, [projectId]);
    const root = 'C:\\work\\import';
    const base = entry('imp-proj', 'imp_dup');
    const clash = entry('imp-proj', 'imp_dup', { args: ['other.js'], source: 'project', origin: `${root}\\.mcp.json`, projectId });
    const unbound = entry('imp-proj', 'imp_unbound', { source: 'local', origin: 'C:/elsewhere', warnings: ['unbound-path'] });
    const bound = entry('imp-proj', 'imp_bound', { source: 'project', origin: `${root}\\.mcp.json`, projectId });
    const view = await preview('imp-proj', { servers: [base, clash, unbound, bound] });
    expect(previewRequests.filter(request => request.machineId === 'imp-proj').at(-1)?.payload).toMatchObject({ projectRoot: 'C:\\work', projectRoots: [{ projectId, path: root }] });
    const byId = new Map(view.servers.map(server => [server.id, server]));
    expect(byId.get(String(base.id))).toMatchObject({ decision: 'new', selected: true });
    expect(byId.get(String(clash.id))).toMatchObject({ decision: 'conflict', selectable: false, selected: false, warnings: ['project-conflict'] });
    expect(byId.get(String(unbound.id))).toMatchObject({ decision: 'new', selectable: true, selected: false, warnings: ['unbound-path'] });
    expect(byId.get(String(bound.id))).toMatchObject({ decision: 'new', projectId, selected: true });

    const committed = await commit(view, [String(base.id), String(clash.id), String(bound.id)]);
    expect(committed.statusCode, committed.body).toBe(200);
    expect(committed.json()).toMatchObject({ imported: 2 });
    const rows = (
      await t.tdb.pool.query<{ name: string; config: { projectIds: string[]; args: string[] } }>(
        `SELECT name, config FROM mcp_registry_servers WHERE user_id = $1 AND name IN ('imp_dup', 'imp_bound')`,
        [userId],
      )
    ).rows;
    expect(Object.fromEntries(rows.map(row => [row.name, row.config.projectIds]))).toEqual({ imp_dup: [], imp_bound: [projectId] });
    expect(rows.find(row => row.name === 'imp_dup')?.config.args).toEqual(['imp_dup.js']);
  });

  it('returns a typed timeout, refuses an agent without import v2 and rejects a foreign machine', async () => {
    await machine('imp-silent', V2);
    scans.set('imp-silent', () => null);
    const timeout = await api('POST', '/api/mcp/registry/import/preview', { machineId: 'imp-silent' });
    expect(timeout.statusCode).toBe(504);
    expect(timeout.json()).toMatchObject({ error: 'timeout' });

    await machine('imp-old', MCP_REGISTRY_CAPABILITIES);
    const outdated = await api('POST', '/api/mcp/registry/import/preview', { machineId: 'imp-old' });
    expect(outdated.statusCode).toBe(409);
    expect(outdated.json()).toMatchObject({ error: 'agent_outdated' });
  });

  it('auto-imports an auto-pending machine on hello and reports imported and skipped servers', async () => {
    scans.set('imp-auto', () => ({ servers: [entry('imp-auto', 'imp_auto_a'), entry('imp-auto', 'imp_auto_b', { source: 'local', warnings: ['unbound-path'] })] }));
    const agent = await machine('imp-auto', V2, 'auto-pending');
    const runner = await waitFor(async () => {
      const row = (await t.tdb.pool.query<{ mcp_import_state: string; mcp_import_report: unknown }>(`SELECT mcp_import_state, mcp_import_report FROM runners WHERE id = 'imp-auto'`)).rows[0];
      return row?.mcp_import_state === 'done' ? row : null;
    }, 10_000);
    expect(runner.mcp_import_report).toEqual({ imported: ['imp_auto_a'], skipped: ['imp_auto_b'] });
    const audit = await t.tdb.pool.query<{ actor: string; details: unknown }>(`SELECT actor, details FROM mcp_registry_audit WHERE user_id = $1 AND action = 'import.auto'`, [userId]);
    expect(audit.rows).toContainEqual({ actor: 'imp-auto', details: { imported: ['imp_auto_a'], skipped: ['imp_auto_b'] } });
    const sync = await lastSync(agent, servers => servers.some(server => server.name === 'imp_auto_a'));
    expect(sync.payload.registryEnabled).toBe(true);
    const status = await api('GET', '/api/mcp/registry/status');
    expect((status.json() as { agents: Entry[] }).agents).toContainEqual(
      expect.objectContaining({ machineId: 'imp-auto', registryEnabled: true, importState: 'done', importReport: { imported: ['imp_auto_a'], skipped: ['imp_auto_b'] } }),
    );
  });

  it('keeps a machine auto-pending and off the registry when the auto-import times out', async () => {
    scans.set('imp-auto-slow', () => null);
    const agent = await machine('imp-auto-slow', V2, 'auto-pending');
    await waitFor(async () => (await t.tdb.pool.query(`SELECT 1 FROM mcp_registry_audit WHERE actor = 'imp-auto-slow' AND action = 'import.auto.failed'`)).rowCount, 10_000);
    const row = (
      await t.tdb.pool.query<{ mcp_import_state: string; details: unknown }>(
        `SELECT r.mcp_import_state, a.details FROM runners r JOIN mcp_registry_audit a ON a.actor = r.id WHERE r.id = 'imp-auto-slow' AND a.action = 'import.auto.failed'`,
      )
    ).rows[0];
    expect(row).toEqual({ mcp_import_state: 'auto-pending', details: { code: 'timeout' } });
    const sync = await agent.next('mcp.registry.sync');
    expect(sync.payload).toMatchObject({ registryEnabled: false, servers: [] });
    const status = await api('GET', '/api/mcp/registry/status');
    expect((status.json() as { agents: Entry[] }).agents).toContainEqual(expect.objectContaining({ machineId: 'imp-auto-slow', registryEnabled: false, importState: 'auto-pending' }));
  });

  it('disables a server on one machine, keeps it on another and cuts project servers for an agent without import v2', async () => {
    const one = await machine('ovr-one', V2);
    const two = await machine('ovr-two', MCP_REGISTRY_CAPABILITIES);
    const serverId = await createServer('ovr_shared');
    const projectServerId = await createServer('ovr_project', { projectIds: [projectId] });
    await lastSync(one, servers => servers.some(server => server.id === projectServerId));
    await lastSync(two, servers => servers.some(server => server.id === serverId));
    expect(two.messages.some(m => m.type === 'mcp.registry.sync' && ((m.payload.servers ?? []) as Entry[]).some(server => server.id === projectServerId))).toBe(false);

    const revision = Number((await serverRow(serverId)).revision);
    const disabled = await api('PUT', `/api/mcp/registry/servers/${serverId}/machines/ovr-one`, { revision, enabled: false });
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect(disabled.json()).toMatchObject({
      serverId,
      revision: revision + 1,
      machines: expect.arrayContaining([
        { machineId: 'ovr-one', enabled: false, customConfig: false },
        { machineId: 'ovr-two', enabled: true, customConfig: false },
      ]),
    });
    await lastSync(one, servers => servers.some(server => server.id === projectServerId) && !servers.some(server => server.id === serverId));
    await lastSync(two, servers => servers.some(server => server.id === serverId));
    const listed = await api('GET', '/api/mcp/registry');
    const view = (listed.json() as { servers: Array<{ id: string; machines?: Entry[] }> }).servers.find(server => server.id === serverId);
    expect(view?.machines).toEqual(expect.arrayContaining([{ machineId: 'ovr-one', enabled: false, customConfig: false }]));

    const stale = await api('PUT', `/api/mcp/registry/servers/${serverId}/machines/ovr-one`, { revision, enabled: true });
    expect(stale.statusCode).toBe(409);
    const enabled = await api('PUT', `/api/mcp/registry/servers/${serverId}/machines/ovr-one`, { revision: revision + 1, enabled: true });
    expect(enabled.statusCode, enabled.body).toBe(200);
    expect((await t.tdb.pool.query(`SELECT 1 FROM mcp_registry_machine_overrides WHERE server_id = $1`, [serverId])).rowCount).toBe(0);
    await lastSync(one, servers => servers.some(server => server.id === serverId));
  });

  it('forbids an override on another user machine and audits it', async () => {
    const serverId = await createServer('ovr_foreign');
    const stranger = await upsertUser(t.tdb.db, 'stranger@example.test');
    await addRunner(t.tdb.db, { id: 'ovr-stranger', userId: stranger.id, name: 'STRANGER', os: null });
    await issueRunnerToken(t.tdb.db, 'ovr-stranger');
    await t.tdb.pool.query(`UPDATE runners SET state = 'active' WHERE id = 'ovr-stranger'`);
    const revision = Number((await serverRow(serverId)).revision);
    const forbidden = await api('PUT', `/api/mcp/registry/servers/${serverId}/machines/ovr-stranger`, { revision, enabled: false });
    expect(forbidden.statusCode).toBe(403);
    const audit = await t.tdb.pool.query<{ server_id: string; details: unknown }>(`SELECT server_id, details FROM mcp_registry_audit WHERE user_id = $1 AND action = 'machine.override.forbidden'`, [
      userId,
    ]);
    expect(audit.rows).toContainEqual({ server_id: serverId, details: { machineId: 'ovr-stranger' } });
    expect((await t.tdb.pool.query(`SELECT 1 FROM mcp_registry_machine_overrides WHERE server_id = $1`, [serverId])).rowCount).toBe(0);
    expect(Number((await serverRow(serverId)).revision)).toBe(revision);
  });

  it('delivers a machine-config secret only to its machine and resets the machine config', async () => {
    const one = await machine('sec-one', V2);
    const two = await machine('sec-two', V2);
    const serverId = await createServer('sec_probe');
    const value = 'MCP_OVERRIDE_SECRET_9d02';
    const local = entry('sec-one', 'sec_probe', { args: ['local.js'] });
    const view = await preview('sec-one', { servers: [local], secretValues: [{ serverName: 'sec_probe', entryId: local.id, location: 'env', key: 'API_KEY', value }] });
    expect(view.servers[0]).toMatchObject({ decision: 'machine-config', selected: true });
    const committed = await commit(view, [String(local.id)]);
    expect(committed.statusCode, committed.body).toBe(200);
    const delivered = await waitFor(() => one.messages.find(m => m.type === 'mcp.secrets.deliver' && m.payload.serverId === serverId) ?? null);
    expect(delivered.payload.secrets).toEqual([expect.objectContaining({ name: 'env:API_KEY', value })]);
    await lastSync(two, servers => servers.some(server => server.id === serverId && JSON.stringify(server.args) === JSON.stringify(['sec_probe.js'])));
    expect(two.messages.some(m => m.type === 'mcp.secrets.deliver' && JSON.stringify(m.payload).includes(value))).toBe(false);
    const stored = (await t.tdb.pool.query<{ machine_id: string | null }>(`SELECT machine_id FROM mcp_secrets WHERE server_id = $1`, [serverId])).rows;
    expect(stored).toEqual([{ machine_id: 'sec-one' }]);

    const revision = Number((await serverRow(serverId)).revision);
    const reset = await api('PUT', `/api/mcp/registry/servers/${serverId}/machines/sec-one`, { revision, resetConfig: true });
    expect(reset.statusCode, reset.body).toBe(200);
    expect(reset.json()).toMatchObject({ machines: expect.arrayContaining([{ machineId: 'sec-one', enabled: true, customConfig: false }]) });
    expect((await t.tdb.pool.query(`SELECT 1 FROM mcp_secrets WHERE server_id = $1`, [serverId])).rowCount).toBe(0);
    await lastSync(one, servers => servers.some(server => server.id === serverId && JSON.stringify(server.args) === JSON.stringify(['sec_probe.js'])));
  });
});
