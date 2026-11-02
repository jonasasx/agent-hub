import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { MIGRATIONS_DIR, migrate, migrationChecksum } from './migrate.js';
import { createTestDb, type TestDb } from '../test/db.js';

// Each test creates databases and runs every migration: slow under a parallel full run on Windows.
describe('migrations (Postgres)', { timeout: 90_000 }, () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb({ migrated: false });
  });
  afterAll(async () => t.drop());

  it('036_projects_catalog creates reversible user-owned tables without changing the legacy projects table', async () => {
    const t7 = await createTestDb({ migrated: false });
    try {
      await migrate(t7.pool);
      const before = await t7.pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('projects','catalog_projects','project_bindings','session_projects','user_preferences') ORDER BY table_name`,
      );
      expect(before.rows.map(r => r.table_name)).toEqual(['catalog_projects', 'project_bindings', 'projects', 'session_projects', 'user_preferences']);
      await t7.pool.query(await readFile(`${MIGRATIONS_DIR}/036_projects_catalog.down.sql`, 'utf8'));
      const after = await t7.pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('projects','catalog_projects','project_bindings','session_projects','user_preferences') ORDER BY table_name`,
      );
      expect(after.rows.map(r => r.table_name)).toEqual(['projects']);
      await t7.pool.query(await readFile(`${MIGRATIONS_DIR}/036_projects_catalog.up.sql`, 'utf8'));
      expect((await t7.pool.query(`SELECT 1 FROM catalog_projects LIMIT 1`)).rowCount).toBe(0);
    } finally {
      await t7.drop();
    }
  });

  it('apply once, then are a no-op on the second run', async () => {
    const first = await migrate(t.pool);
    expect(first).toEqual([
      '001_init',
      '002_sessions',
      '003_events_session_uuid',
      '004_window_workspace',
      '005_layout_client_ts',
      '006_replication',
      '007_raw_backfill_origin',
      '008_source_human',
      '009_blob_owners',
      '010_search',
      '011_ops_import',
      '012_drive_import_flag',
      '013_transcript_superseded',
      '014_projects',
      '015_permission_answers',
      '016_handoff_pending',
      '017_subagent_runs',
      '018_subagent_result_unlinked',
      '019_background_tasks',
      '020_subagent_meta_priority',
      '021_process_started_at',
      '022_subscriptions',
      '023_multi_user',
      '024_subscription_token_at',
      '025_runner_root',
      '026_subscription_limits',
      '027_mcp_status',
      '028_mcp_project_root',
      '029_background_monitors',
      '030_peer_messages',
      '031_session_provider',
      '032_subscription_provider',
      '033_subscription_name_per_provider',
      '034_session_spawn',
      '035_report_queued',
      '036_projects_catalog',
      '037_mcp_registry',
      '038_mcp_oauth_status',
      '039_mcp_registry_machine_toggle',
    ]);
    const second = await migrate(t.pool);
    expect(second).toEqual([]);
    const tables = await t.pool.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`);
    expect(tables.rows.map(r => r.table_name)).toEqual([
      'alert_state',
      'auth_sessions',
      'background_tasks',
      'blob_owners',
      'blobs',
      'catalog_projects',
      'classification_labels',
      'enroll_codes',
      'events',
      'handoff_drafts',
      'import_runs',
      'invites',
      'mcp_gateway_statuses',
      'mcp_oauth_statuses',
      'mcp_oauth_tokens',
      'mcp_registry_audit',
      'mcp_registry_drafts',
      'mcp_registry_imports',
      'mcp_registry_meta',
      'mcp_registry_overrides',
      'mcp_registry_servers',
      'mcp_registry_session_updates',
      'mcp_secrets',
      'path_touches',
      'peer_messages',
      'pending_agent_meta',
      'permission_requests',
      'project_bindings',
      'projects',
      'runners',
      'schema_migrations',
      'security_events',
      'session_notes',
      'session_projects',
      'session_turns',
      'sessions',
      'subagent_runs',
      'subscription_limits',
      'subscriptions',
      'telegram_link_codes',
      'telegram_links',
      'transcript_files',
      'ui_layouts',
      'uploads',
      'user_preferences',
      'users',
    ]);
  });

  it('037-039 MCP registry migrations can be rolled down and up', async () => {
    const t37 = await createTestDb({ migrated: true });
    try {
      const before = await t37.pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name='mcp_registry_servers'`);
      expect(before.rowCount).toBe(1);
      await t37.pool.query(await readFile(`${MIGRATIONS_DIR}/039_mcp_registry_machine_toggle.down.sql`, 'utf8'));
      await t37.pool.query(await readFile(`${MIGRATIONS_DIR}/038_mcp_oauth_status.down.sql`, 'utf8'));
      await t37.pool.query(await readFile(`${MIGRATIONS_DIR}/037_mcp_registry.down.sql`, 'utf8'));
      expect((await t37.pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name='mcp_registry_servers'`)).rowCount).toBe(0);
      expect((await t37.pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name='mcp_registry_session_updates'`)).rowCount).toBe(0);
      await t37.pool.query(await readFile(`${MIGRATIONS_DIR}/037_mcp_registry.up.sql`, 'utf8'));
      await t37.pool.query(await readFile(`${MIGRATIONS_DIR}/038_mcp_oauth_status.up.sql`, 'utf8'));
      await t37.pool.query(await readFile(`${MIGRATIONS_DIR}/039_mcp_registry_machine_toggle.up.sql`, 'utf8'));
      expect((await t37.pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name='mcp_oauth_statuses'`)).rowCount).toBe(1);
      const enabled = await t37.pool.query<{ column_default: string; is_nullable: string }>(
        `SELECT column_default, is_nullable FROM information_schema.columns WHERE table_name='runners' AND column_name='mcp_registry_enabled'`,
      );
      expect(enabled.rows[0]).toMatchObject({ column_default: 'false', is_nullable: 'NO' });
      const cols = await t37.pool.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name='mcp_secrets' ORDER BY column_name`);
      expect(cols.rows.map(x => x.column_name)).toEqual(['ciphertext', 'created_at', 'draft_id', 'id', 'import_id', 'name', 'server_id', 'updated_at', 'user_id']);
    } finally {
      await t37.drop();
    }
  });

  it('004_window_workspace: up drops open_tabs and ui_layouts.version, adds opened_at; down restores the 002 schema', async () => {
    const t3 = await createTestDb({ migrated: false });
    const cols = async () =>
      (await t3.pool.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'ui_layouts' ORDER BY column_name`)).rows.map(r => r.column_name);
    const hasTabs = async () => (await t3.pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'open_tabs'`)).rowCount === 1;
    try {
      await migrate(t3.pool);
      expect(await cols()).toEqual(['client_ts', 'device_class', 'layout', 'opened_at', 'saved_layout', 'tab_kinds', 'updated_at', 'user_id']);
      // 017 added tab_kinds to ui_layouts: down first, then back to the 002 schema
      await t3.pool.query(await readFile(`${MIGRATIONS_DIR}/018_subagent_result_unlinked.down.sql`, 'utf8'));
      await t3.pool.query(await readFile(`${MIGRATIONS_DIR}/017_subagent_runs.down.sql`, 'utf8'));
      await t3.pool.query(await readFile(`${MIGRATIONS_DIR}/005_layout_client_ts.down.sql`, 'utf8'));
      expect(await cols()).toEqual(['device_class', 'layout', 'opened_at', 'saved_layout', 'updated_at', 'user_id']);
      expect(await hasTabs()).toBe(false);
      const u = await t3.pool.query<{ id: string }>(`INSERT INTO users (email) VALUES ('m@x.y') RETURNING id`);
      await t3.pool.query(`INSERT INTO ui_layouts (user_id, device_class, layout, opened_at) VALUES ($1, 'desktop', '{"seq":1}', '{}')`, [u.rows[0]!.id]);
      await t3.pool.query(await readFile(`${MIGRATIONS_DIR}/004_window_workspace.down.sql`, 'utf8'));
      expect(await cols()).toEqual(['device_class', 'layout', 'saved_layout', 'updated_at', 'user_id', 'version']);
      expect(await hasTabs()).toBe(true);
      expect((await t3.pool.query(`SELECT version, layout FROM ui_layouts`)).rows[0]).toEqual({ version: 0, layout: { seq: 1 } });
      await t3.pool.query(await readFile(`${MIGRATIONS_DIR}/004_window_workspace.up.sql`, 'utf8'));
      expect(await hasTabs()).toBe(false);
      expect((await t3.pool.query(`SELECT layout FROM ui_layouts`)).rows[0]).toEqual({ layout: { seq: 1 } });
    } finally {
      await t3.drop();
    }
  });

  it('006_replication on a copy of an M2 database keeps every event and moves the M2 cursor to a case-insensitive key', async () => {
    const t4 = await createTestDb({ migrated: false });
    const dir = fileURLToPath(new URL(`../../../node_modules/.cache/agent-hub-m2-migrations-${process.pid}/`, import.meta.url));
    try {
      await mkdir(dir, { recursive: true });
      for (const f of await readdir(MIGRATIONS_DIR)) if (/^00[1-5]_/.test(f)) await copyFile(`${MIGRATIONS_DIR}/${f}`, `${dir}/${f}`);
      expect(await migrate(t4.pool, { dir })).toHaveLength(5);
      const q = (text: string, values: unknown[] = []) => t4.pool.query(text, values);
      const uid = (await q(`INSERT INTO users (email) VALUES ('m2@x.y') RETURNING id`)).rows[0].id as string;
      await q(`INSERT INTO runners (id, user_id, name, home_dir) VALUES ('hp', $1, 'HP', 'C:\\Users\\alice')`, [uid]);
      const sid = '6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7';
      await q(`INSERT INTO sessions (id, user_id, runner_id, claude_session_id, source, status) VALUES ($1, $2, 'hp', $1, 'remote_control', 'closed')`, [sid, uid]);
      const fid = (
        await q(`INSERT INTO transcript_files (user_id, session_id, rel_path, kind, acked_line, acked_byte) VALUES ($1, $2, $3, 'main', 3, 300) RETURNING id`, [
          uid,
          sid,
          `C--Users-alice-vault/${sid}.jsonl`,
        ])
      ).rows[0].id as string;
      for (let i = 0; i < 3; i++) {
        const payload = i === 1 ? { type: 'assistant', message: { content: [{ type: 'text', text: 'перезапустил deployments' }] } } : { type: 'user', message: { content: `вопрос ${i}` } };
        await q(`INSERT INTO events (file_id, generation, line_no, session_id, type, ts, payload) VALUES ($1, 0, $2, $3, $4, now(), $5)`, [fid, i, sid, payload.type, JSON.stringify(payload)]);
      }
      expect(await migrate(t4.pool)).toEqual([
        '006_replication',
        '007_raw_backfill_origin',
        '008_source_human',
        '009_blob_owners',
        '010_search',
        '011_ops_import',
        '012_drive_import_flag',
        '013_transcript_superseded',
        '014_projects',
        '015_permission_answers',
        '016_handoff_pending',
        '017_subagent_runs',
        '018_subagent_result_unlinked',
        '019_background_tasks',
        '020_subagent_meta_priority',
        '021_process_started_at',
        '022_subscriptions',
        '023_multi_user',
        '024_subscription_token_at',
        '025_runner_root',
        '026_subscription_limits',
        '027_mcp_status',
        '028_mcp_project_root',
        '029_background_monitors',
        '030_peer_messages',
        '031_session_provider',
        '032_subscription_provider',
        '033_subscription_name_per_provider',
        '034_session_spawn',
        '035_report_queued',
        '036_projects_catalog',
        '037_mcp_registry',
        '038_mcp_oauth_status',
        '039_mcp_registry_machine_toggle',
      ]);
      expect((await q(`SELECT count(*)::int AS n FROM events`)).rows[0].n).toBe(3);
      expect((await q(`SELECT rel_key, runner_id, claude_session_id, acked_line::int AS l FROM transcript_files`)).rows[0]).toEqual({
        rel_key: `c--users-alice-vault/${sid}.jsonl`,
        runner_id: 'hp',
        claude_session_id: sid,
        l: 0, // 007: an M2 cursor without raw segments starts again from 0 so the raw copy in S3 becomes complete
      });
      expect((await q(`SELECT source, remote_control, origin_source FROM sessions`)).rows[0]).toEqual({ source: 'terminal', remote_control: true, origin_source: 'terminal' });
      expect((await q(`SELECT count(*)::int AS n FROM events WHERE tsv @@ websearch_to_tsquery('russian', 'перезапустил')`)).rows[0].n).toBe(1);
      expect((await q(`SELECT count(*)::int AS n FROM events WHERE tsv @@ websearch_to_tsquery('english', 'deployment')`)).rows[0].n).toBe(1);
      // Down and up again (009 depends on the tables of 006: it goes down first).
      await q(await readFile(`${MIGRATIONS_DIR}/009_blob_owners.down.sql`, 'utf8'));
      await q(await readFile(`${MIGRATIONS_DIR}/006_replication.down.sql`, 'utf8'));
      expect((await q(`SELECT source FROM sessions`)).rows[0]).toEqual({ source: 'remote_control' });
      await q(await readFile(`${MIGRATIONS_DIR}/006_replication.up.sql`, 'utf8'));
      await q(await readFile(`${MIGRATIONS_DIR}/009_blob_owners.up.sql`, 'utf8'));
      expect((await q(`SELECT count(*)::int AS n FROM events`)).rows[0].n).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await t4.drop();
    }
  });

  it('014_projects on a copy with a token in a session remote: up strips it; down and up again', async () => {
    const t5 = await createTestDb({ migrated: false });
    const dir = fileURLToPath(new URL(`../../../node_modules/.cache/agent-hub-m3-migrations-${process.pid}/`, import.meta.url));
    try {
      await mkdir(dir, { recursive: true });
      for (const f of await readdir(MIGRATIONS_DIR)) if (/^0(0\d|1[0-3])_/.test(f)) await copyFile(`${MIGRATIONS_DIR}/${f}`, `${dir}/${f}`);
      expect(await migrate(t5.pool, { dir })).toHaveLength(13);
      const q = (text: string, values: unknown[] = []) => t5.pool.query(text, values);
      const uid = (await q(`INSERT INTO users (email) VALUES ('m3@x.y') RETURNING id`)).rows[0].id as string;
      await q(`INSERT INTO runners (id, user_id, name) VALUES ('vm', $1, 'ВМ')`, [uid]);
      await q(
        `INSERT INTO sessions (user_id, runner_id, claude_session_id, source, status, git_remote) VALUES ($1, 'vm', gen_random_uuid(), 'terminal', 'closed', 'https://oauth2:glpat-SECRET@git.example.com/alice/pos.git'), ($1, 'vm', gen_random_uuid(), 'terminal', 'closed', 'git@git.example.com:a/b.git'), ($1, 'vm', gen_random_uuid(), 'terminal', 'closed', 'https://u:p@ss@git.example.com/c/d.git')`,
        [uid],
      );
      expect(await migrate(t5.pool)).toEqual([
        '014_projects',
        '015_permission_answers',
        '016_handoff_pending',
        '017_subagent_runs',
        '018_subagent_result_unlinked',
        '019_background_tasks',
        '020_subagent_meta_priority',
        '021_process_started_at',
        '022_subscriptions',
        '023_multi_user',
        '024_subscription_token_at',
        '025_runner_root',
        '026_subscription_limits',
        '027_mcp_status',
        '028_mcp_project_root',
        '029_background_monitors',
        '030_peer_messages',
        '031_session_provider',
        '032_subscription_provider',
        '033_subscription_name_per_provider',
        '034_session_spawn',
        '035_report_queued',
        '036_projects_catalog',
        '037_mcp_registry',
        '038_mcp_oauth_status',
        '039_mcp_registry_machine_toggle',
      ]);
      expect((await q(`SELECT git_remote FROM sessions ORDER BY git_remote`)).rows.map(r => r.git_remote)).toEqual([
        'git@git.example.com:a/b.git',
        'https://git.example.com/alice/pos.git',
        'https://git.example.com/c/d.git',
      ]);
      await q(await readFile(`${MIGRATIONS_DIR}/014_projects.down.sql`, 'utf8'));
      expect((await q(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'projects'`)).rows[0].n).toBe(0);
      await q(await readFile(`${MIGRATIONS_DIR}/014_projects.up.sql`, 'utf8'));
      expect((await q(`SELECT count(*)::int AS n FROM sessions`)).rows[0].n).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await t5.drop();
    }
  });

  it('checksums: recorded on apply, filled at start for versions without one; a changed applied file stops the start', async () => {
    const t6 = await createTestDb({ migrated: false });
    const dir = fileURLToPath(new URL(`../../../node_modules/.cache/agent-hub-sum-migrations-${process.pid}/`, import.meta.url));
    try {
      await migrate(t6.pool);
      const sums = await t6.pool.query<{ version: string; checksum: string | null }>(`SELECT version, checksum FROM schema_migrations ORDER BY version`);
      expect(sums.rows.every(r => /^[0-9a-f]{64}$/.test(r.checksum ?? ''))).toBe(true);
      const init = await readFile(`${MIGRATIONS_DIR}/001_init.up.sql`, 'utf8');
      expect(sums.rows[0]!.checksum).toBe(migrationChecksum(init));
      expect(migrationChecksum(init.replace(/\n/g, '\r\n'))).toBe(migrationChecksum(init)); // a Windows checkout
      // a database migrated before the column existed: filled at start
      await t6.pool.query(`UPDATE schema_migrations SET checksum = NULL WHERE version = '002_sessions'`);
      expect(await migrate(t6.pool)).toEqual([]);
      expect((await t6.pool.query(`SELECT checksum FROM schema_migrations WHERE version = '002_sessions'`)).rows[0].checksum).toBe(
        migrationChecksum(await readFile(`${MIGRATIONS_DIR}/002_sessions.up.sql`, 'utf8')),
      );
      // an applied file edited afterwards
      await mkdir(dir, { recursive: true });
      for (const f of await readdir(MIGRATIONS_DIR)) await copyFile(`${MIGRATIONS_DIR}/${f}`, `${dir}/${f}`);
      await writeFile(`${dir}/014_projects.up.sql`, `${await readFile(`${dir}/014_projects.up.sql`, 'utf8')}\n-- edited\n`);
      await writeFile(`${dir}/015_next.up.sql`, 'CREATE TABLE never_created (x int);');
      await expect(migrate(t6.pool, { dir })).rejects.toThrow(/Applied migrations were changed after they were applied: 014_projects\.up\.sql/);
      expect((await t6.pool.query(`SELECT to_regclass('never_created') AS r`)).rows[0].r).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
      await t6.drop();
    }
  });

  it('serialize concurrent runs under the advisory lock', async () => {
    const t2 = await createTestDb({ migrated: false });
    try {
      const results = await Promise.all([migrate(t2.pool), migrate(t2.pool), migrate(t2.pool)]);
      expect(results.flat().filter(v => v === '001_init')).toHaveLength(1);
    } finally {
      await t2.drop();
    }
  });

  it('033_subscription_name_per_provider: the same name in Claude and Codex, not twice in one provider', async () => {
    const t7 = await createTestDb({ migrated: false });
    const q = (s: string, p: unknown[] = []) => t7.pool.query(s, p);
    try {
      await migrate(t7.pool);
      const uid = (await q(`INSERT INTO users (email) VALUES ('n@x.y') RETURNING id`)).rows[0].id as string;
      const sub = (name: string, provider: string) =>
        q(`INSERT INTO subscriptions (user_id, name, provider, token_enc, token_hint, position) VALUES ($1, $2, $3, decode('00', 'hex'), 'abcd', 0)`, [uid, name, provider]);
      await sub('jonasasx', 'claude');
      await sub('jonasasx', 'codex');
      await expect(sub('JONASASX', 'codex')).rejects.toThrow(/subscriptions_active_name/);
      await expect(sub('Jonasasx', 'claude')).rejects.toThrow(/subscriptions_active_name/);
    } finally {
      await t7.drop();
    }
  });

  it('022_subscriptions: up → down → up; unique active name; ON DELETE SET NULL of the last choice and of sessions', async () => {
    const t6 = await createTestDb({ migrated: false });
    const q = (s: string, p: unknown[] = []) => t6.pool.query(s, p);
    try {
      await migrate(t6.pool);
      const down = await readFile(`${MIGRATIONS_DIR}/022_subscriptions.down.sql`, 'utf8');
      const up = await readFile(`${MIGRATIONS_DIR}/022_subscriptions.up.sql`, 'utf8');
      // 033, 032 and 026 depend on subscriptions: rolled back first, as a real rollback would
      await q(await readFile(`${MIGRATIONS_DIR}/033_subscription_name_per_provider.down.sql`, 'utf8'));
      await q(await readFile(`${MIGRATIONS_DIR}/032_subscription_provider.down.sql`, 'utf8'));
      await q(await readFile(`${MIGRATIONS_DIR}/026_subscription_limits.down.sql`, 'utf8'));
      await q(down);
      expect((await q(`SELECT 1 FROM information_schema.tables WHERE table_name IN ('subscriptions', 'session_turns')`)).rowCount).toBe(0);
      expect((await q(`SELECT 1 FROM information_schema.columns WHERE column_name IN ('last_subscription_id', 'subscription_id')`)).rowCount).toBe(0);
      await q(up);
      const uid = (await q(`INSERT INTO users (email) VALUES ('s@x.y') RETURNING id`)).rows[0].id as string;
      const sub = async (name: string, retired = false) =>
        (
          await q(`INSERT INTO subscriptions (user_id, name, token_enc, token_hint, position, retired_at) VALUES ($1, $2, decode('00', 'hex'), 'abcd', 0, $3::timestamptz) RETURNING id`, [
            uid,
            name,
            retired ? new Date() : null,
          ])
        ).rows[0].id as string;
      const a = await sub('Max личная');
      // the same name among active ones, case-insensitive → unique violation; a retired one with that name is allowed
      await expect(sub('max ЛИЧНАЯ')).rejects.toThrow(/subscriptions_active_name/);
      await sub('Max личная', true);
      await expect(sub('')).rejects.toThrow(/check/);
      await expect(sub('x'.repeat(61))).rejects.toThrow(/check/);
      await q(`INSERT INTO runners (id, user_id, name) VALUES ('hp', $1, 'HP')`, [uid]);
      const sid = (
        await q(`INSERT INTO sessions (user_id, runner_id, claude_session_id, source, status, subscription_id) VALUES ($1, 'hp', gen_random_uuid(), 'hub', 'waiting', $2) RETURNING id`, [uid, a])
      ).rows[0].id as string;
      await q(`UPDATE users SET last_subscription_id = $1 WHERE id = $2`, [a, uid]);
      await q(`INSERT INTO session_turns (user_id, session_id, runner_id, subscription_id, ended_at, is_error, failure) VALUES ($1, $2, 'hp', $3, now(), true, 'subscription_limit')`, [uid, sid, a]);
      await expect(q(`INSERT INTO session_turns (user_id, session_id, runner_id, ended_at, is_error, failure) VALUES ($1, $2, 'hp', now(), true, 'other')`, [uid, sid])).rejects.toThrow(/check/);
      await q(`DELETE FROM subscriptions WHERE id = $1`, [a]);
      expect((await q(`SELECT last_subscription_id FROM users WHERE id = $1`, [uid])).rows[0].last_subscription_id).toBeNull();
      expect((await q(`SELECT subscription_id FROM sessions WHERE id = $1`, [sid])).rows[0].subscription_id).toBeNull();
      expect((await q(`SELECT subscription_id, failure FROM session_turns`)).rows).toEqual([{ subscription_id: null, failure: 'subscription_limit' }]);
    } finally {
      await t6.drop();
    }
  });

  it('026_subscription_limits (review A6): a row belongs to the owner of its subscription (composite FK); down drops the key, up again', async () => {
    const t7 = await createTestDb({ migrated: false });
    const q = (s: string, p: unknown[] = []) => t7.pool.query(s, p);
    const has = async (table: string, constraint: string) => (await q(`SELECT 1 FROM pg_constraint WHERE conname = $1 AND conrelid = $2::regclass`, [constraint, table])).rowCount;
    try {
      await migrate(t7.pool);
      const down = await readFile(`${MIGRATIONS_DIR}/026_subscription_limits.down.sql`, 'utf8');
      const up = await readFile(`${MIGRATIONS_DIR}/026_subscription_limits.up.sql`, 'utf8');
      await q(down);
      expect((await q(`SELECT 1 FROM information_schema.tables WHERE table_name = 'subscription_limits'`)).rowCount).toBe(0);
      expect(await has('subscriptions', 'subscriptions_id_user_key')).toBe(0);
      await q(up);
      expect(await has('subscriptions', 'subscriptions_id_user_key')).toBe(1);
      expect(await has('subscription_limits', 'subscription_limits_owner_fkey')).toBe(1);
      const user = async (email: string) => (await q(`INSERT INTO users (email) VALUES ($1) RETURNING id`, [email])).rows[0].id as string;
      const a = await user('a@x.y');
      const b = await user('b@x.y');
      const sub = (await q(`INSERT INTO subscriptions (user_id, name, token_enc, token_hint, position) VALUES ($1, 'Max', decode('00', 'hex'), 'abcd', 0) RETURNING id, token_updated_at`, [a]))
        .rows[0] as { id: string; token_updated_at: Date };
      // another user's id with A's subscription → FK violation
      await expect(q(`INSERT INTO subscription_limits (subscription_id, user_id, token_at) VALUES ($1, $2, now())`, [sub.id, b])).rejects.toThrow(/subscription_limits_owner_fkey/);
      await q(`INSERT INTO subscription_limits (subscription_id, user_id, token_at) VALUES ($1, $2, $3)`, [sub.id, a, sub.token_updated_at]);
      await q(`DELETE FROM subscriptions WHERE id = $1`, [sub.id]);
      expect((await q(`SELECT count(*)::int AS n FROM subscription_limits`)).rows[0].n).toBe(0);
      // down again leaves the schema as after 025, up again applies cleanly
      await q(down);
      await q(up);
    } finally {
      await t7.drop();
    }
  });

  it('enforce runner kind and id format', async () => {
    const u = await t.pool.query<{ id: string }>(`INSERT INTO users (email) VALUES ('a@b.c') RETURNING id`);
    const uid = u.rows[0]!.id;
    await expect(t.pool.query(`INSERT INTO runners (id, user_id, name, kind) VALUES ('x1', $1, 'X1', 'vm')`, [uid])).rejects.toThrow(/check/);
    await expect(t.pool.query(`INSERT INTO runners (id, user_id, name) VALUES ('Bad Id', $1, 'X')`, [uid])).rejects.toThrow(/check/);
    await t.pool.query(`INSERT INTO runners (id, user_id, name) VALUES ('hp', $1, 'HP')`, [uid]);
  });

  // Change multi-user, task 1.1 (design M1).
  it('023_multi_user: up → down → up on a single-user database; hostname unique per owner, names unique per owner', async () => {
    const t6 = await createTestDb({ migrated: false });
    const q = (text: string, values: unknown[] = []) => t6.pool.query(text, values);
    try {
      await migrate(t6.pool);
      // A production-like copy before 023: down, then data of the single-user era, then up again.
      await q(await readFile(`${MIGRATIONS_DIR}/023_multi_user.down.sql`, 'utf8'));
      const ivan = (await q(`INSERT INTO users (email) VALUES ('jonasasx@gmail.com') RETURNING id`)).rows[0].id;
      await q(`INSERT INTO runners (id, user_id, name, hostname) VALUES ('hp', $1, 'HP', 'HP-Elitebook'), ('vm', $1, 'VM', 'ip-10-0-0-3')`, [ivan]);
      await q(`DELETE FROM schema_migrations WHERE version = '023_multi_user'`);
      expect(await migrate(t6.pool)).toEqual(['023_multi_user']);
      const u = (await q(`SELECT role, provider, status, subject FROM users`)).rows[0];
      expect(u).toEqual({ role: 'user', provider: 'google', status: 'active', subject: null });
      expect((await q(`SELECT id, state, token_hash_next FROM runners ORDER BY id`)).rows).toEqual([
        { id: 'hp', state: 'active', token_hash_next: null },
        { id: 'vm', state: 'active', token_hash_next: null },
      ]);
      // Scenario «Одинаковый каталог у двух пользователей»: the same hostname at two owners is allowed …
      const bob = (await q(`INSERT INTO users (email, provider) VALUES ('bob@example.com', 'google') RETURNING id`)).rows[0].id;
      await q(`INSERT INTO runners (id, user_id, name, hostname) VALUES ('r-aaaaaaaaaa', $1, 'HP', 'HP-Elitebook')`, [bob]);
      // … a second runner of one owner with the same hostname or the same name is not
      await expect(q(`INSERT INTO runners (id, user_id, name, hostname) VALUES ('r-bbbbbbbbbb', $1, 'Other', 'HP-Elitebook')`, [ivan])).rejects.toThrow(/runners_user_hostname_key/);
      await expect(q(`INSERT INTO runners (id, user_id, name) VALUES ('r-cccccccccc', $1, 'HP')`, [ivan])).rejects.toThrow(/runners_user_name_key/);
      await expect(q(`UPDATE users SET role = 'owner'`)).rejects.toThrow(/users_role_check/);
      // down fails while two owners share a hostname (documented); after removing one it restores the 001 schema
      await q(`DELETE FROM runners WHERE id = 'r-aaaaaaaaaa'`);
      await q(await readFile(`${MIGRATIONS_DIR}/023_multi_user.down.sql`, 'utf8'));
      await expect(q(`INSERT INTO runners (id, user_id, name, hostname) VALUES ('r-dddddddddd', $1, 'X', 'HP-Elitebook')`, [bob])).rejects.toThrow(/runners_hostname_key/);
      await q(await readFile(`${MIGRATIONS_DIR}/023_multi_user.up.sql`, 'utf8'));
      expect(Number((await q(`SELECT count(*) AS n FROM runners`)).rows[0].n)).toBe(2);
    } finally {
      await t6.drop();
    }
  });
  // subscription-limits task 3.1 (design L4).
  it('026_subscription_limits: up → down → up; down leaves the schema of 025; cascade on the subscription and the user', async () => {
    const t7 = await createTestDb({ migrated: false });
    const q = (s: string, p: unknown[] = []) => t7.pool.query(s, p);
    const schema = async () => (await q(`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, column_name`)).rows;
    try {
      await migrate(t7.pool);
      const withLimits = await schema();
      const down = await readFile(`${MIGRATIONS_DIR}/026_subscription_limits.down.sql`, 'utf8');
      const up = await readFile(`${MIGRATIONS_DIR}/026_subscription_limits.up.sql`, 'utf8');
      await q(down);
      const after = await schema();
      expect(after).toEqual(withLimits.filter(r => r.table_name !== 'subscription_limits'));
      expect((await q(`SELECT 1 FROM pg_indexes WHERE indexname = 'subscription_limits_user'`)).rowCount).toBe(0);
      await q(up);
      expect(await schema()).toEqual(withLimits);
      const uid = (await q(`INSERT INTO users (email) VALUES ('l@x.y') RETURNING id`)).rows[0].id as string;
      const sub = async (name: string) =>
        (await q(`INSERT INTO subscriptions (user_id, name, token_enc, token_hint, position) VALUES ($1, $2, decode('00', 'hex'), 'abcd', 0) RETURNING id`, [uid, name])).rows[0].id as string;
      const a = await sub('A');
      const b = await sub('B');
      await q(
        `INSERT INTO subscription_limits (subscription_id, user_id, token_at, windows, probe_outcome) VALUES ($1, $2, now(), '[{"type":"five_hour","utilization":92}]', 'ok'), ($3, $2, now(), '[]', NULL)`,
        [a, uid, b],
      );
      const row = (await q(`SELECT windows, probe_failures, last_ok_at FROM subscription_limits WHERE subscription_id = $1`, [a])).rows[0];
      expect(row).toEqual({ windows: [{ type: 'five_hour', utilization: 92 }], probe_failures: 0, last_ok_at: null });
      await expect(q(`UPDATE subscription_limits SET probe_outcome = 'maybe'`)).rejects.toThrow(/check/);
      await expect(q(`UPDATE subscription_limits SET probe_error = $1`, ['x'.repeat(201)])).rejects.toThrow(/check/);
      await expect(q(`INSERT INTO subscription_limits (subscription_id, user_id, token_at) VALUES ($1, $2, now())`, [a, uid])).rejects.toThrow(/subscription_limits_pkey/);
      await q(`DELETE FROM subscriptions WHERE id = $1`, [a]);
      expect(Number((await q(`SELECT count(*) AS n FROM subscription_limits`)).rows[0].n)).toBe(1);
      await q(`DELETE FROM subscriptions WHERE id = $1`, [b]);
      await q(`DELETE FROM users WHERE id = $1`, [uid]);
      expect(Number((await q(`SELECT count(*) AS n FROM subscription_limits`)).rows[0].n)).toBe(0);
    } finally {
      await t7.drop();
    }
  });
  // mcp-management task 3.1 (design M6).
  it('027_mcp_status: up → down → up; down leaves the schema of 026; defaults and jsonb', async () => {
    const t8 = await createTestDb({ migrated: false });
    const q = (s: string, p: unknown[] = []) => t8.pool.query(s, p);
    const schema = async () =>
      (await q(`SELECT table_name, column_name, data_type, column_default, is_nullable FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, column_name`)).rows;
    try {
      await migrate(t8.pool);
      const withMcp = await schema();
      const of027 = (r: Record<string, unknown>) => String(r.column_name).startsWith('mcp_') && r.column_name !== 'mcp_project_root' && r.column_name !== 'mcp_registry_enabled';
      const added = withMcp.filter(of027);
      expect(added.map(r => `${r.table_name}.${r.column_name}:${r.data_type}`)).toEqual([
        'runners.mcp_observed_at:timestamp with time zone',
        'runners.mcp_probe_at:timestamp with time zone',
        'runners.mcp_servers:jsonb',
        'sessions.mcp_observed_at:timestamp with time zone',
        'sessions.mcp_problems:smallint',
        'sessions.mcp_servers:jsonb',
      ]);
      const down = await readFile(`${MIGRATIONS_DIR}/027_mcp_status.down.sql`, 'utf8');
      const up = await readFile(`${MIGRATIONS_DIR}/027_mcp_status.up.sql`, 'utf8');
      await q(down);
      expect(await schema()).toEqual(withMcp.filter(r => !of027(r)));
      await q(up);
      expect(await schema()).toEqual(withMcp);
      const uid = (await q(`INSERT INTO users (email) VALUES ('m@x.y') RETURNING id`)).rows[0].id as string;
      await q(`INSERT INTO runners (id, user_id, name) VALUES ('mcp-r', $1, 'R')`, [uid]);
      const sid = (await q(`INSERT INTO sessions (user_id, runner_id, claude_session_id, source, status) VALUES ($1, 'mcp-r', gen_random_uuid(), 'hub', 'waiting') RETURNING id`, [uid])).rows[0]
        .id as string;
      expect((await q(`SELECT mcp_servers, mcp_observed_at, mcp_problems FROM sessions WHERE id = $1`, [sid])).rows[0]).toEqual({ mcp_servers: null, mcp_observed_at: null, mcp_problems: 0 });
      await q(`UPDATE sessions SET mcp_servers = $2, mcp_problems = 1, mcp_observed_at = now() WHERE id = $1`, [
        sid,
        JSON.stringify([{ name: 'n', status: 'failed', transport: 'stdio', toolCount: 0 }]),
      ]);
      expect((await q(`SELECT mcp_servers->0->>'status' AS st FROM sessions WHERE id = $1`, [sid])).rows[0].st).toBe('failed');
    } finally {
      await t8.drop();
    }
  });
  // mcp-management QA fix 3: the project of a disable.
  it('028_mcp_project_root: up → down → up; a nullable text column of sessions', async () => {
    const t9 = await createTestDb({ migrated: false });
    const q = (s: string) => t9.pool.query(s);
    const col = async () => (await q(`SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'sessions' AND column_name = 'mcp_project_root'`)).rows;
    try {
      await migrate(t9.pool);
      expect(await col()).toEqual([{ data_type: 'text', is_nullable: 'YES' }]);
      await q(await readFile(`${MIGRATIONS_DIR}/028_mcp_project_root.down.sql`, 'utf8'));
      expect(await col()).toEqual([]);
      await q(await readFile(`${MIGRATIONS_DIR}/028_mcp_project_root.up.sql`, 'utf8'));
      expect(await col()).toHaveLength(1);
    } finally {
      await t9.drop();
    }
  });
});
