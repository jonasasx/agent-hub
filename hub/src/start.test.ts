// Regression of the M4a deploy (c8620ee): the hub did not start on a database without 014 — buildHub loaded the
// project catalogue from `projects` before migrate() ran (42P01, a restart loop). The start as in production
// (startHub: migrate → buildHub → listen) on an empty database and on a database one migration behind.
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { MIGRATIONS_DIR, migrate } from './db/migrate.js';
import { startHub } from './start.js';
import { createTestDb } from './test/db.js';
import { PUBLIC_URL } from './test/harness.js';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

async function config(url: string) {
  return loadConfig({
    NODE_ENV: 'test',
    PUBLIC_URL,
    HOST: '127.0.0.1',
    PORT: String(await freePort()),
    DATABASE_URL: url,
    COOKIE_SECRET: 'test-cookie-secret-0123456789abcdef0123',
    OIDC_GOOGLE_CLIENT_ID: 'x',
    OIDC_GOOGLE_CLIENT_SECRET: 'y',
    OIDC_ALLOWED_EMAILS: 'alice@example.com',
    WEB_DIST_DIR: '/nonexistent-web-dist',
    LOG_LEVEL: 'silent',
  });
}

const all = async () =>
  (await readdir(MIGRATIONS_DIR))
    .filter(f => /^\d{3}_[\w-]+\.up\.sql$/.test(f))
    .sort()
    .map(f => f.replace(/\.up\.sql$/, ''));

describe('hub start (production order)', () => {
  it('an empty database: every migration applied, /healthz 200, the tables and the catalogue are there', async () => {
    const t = await createTestDb({ migrated: false });
    const c = await config(t.url);
    const started = await startHub(c, { logger: false, ops: { diskCheckMs: 0 } });
    try {
      expect(started.applied).toEqual(await all());
      const res = await fetch(`http://127.0.0.1:${c.PORT}/healthz`);
      expect(res.status).toBe(200);
      const tables = (await t.pool.query<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public'`)).rows.map(r => r.t);
      expect(tables).toEqual(expect.arrayContaining(['sessions', 'events', 'projects', 'path_touches', 'schema_migrations']));
      // the catalogue is loaded at start from `projects` — the query that failed before the migrations; no user yet
      expect(started.hub.projects.catalog.list('00000000-0000-0000-0000-000000000000')).toEqual([]);
    } finally {
      await started.close();
      await t.drop();
    }
  });

  it('a database one migration behind: the hub applies the last one and starts', async () => {
    const t = await createTestDb({ migrated: false });
    const versions = await all();
    const last = versions.at(-1)!;
    const dir = fileURLToPath(new URL(`../../node_modules/.cache/agent-hub-start-migrations-${process.pid}/`, import.meta.url));
    try {
      await mkdir(dir, { recursive: true });
      for (const f of await readdir(MIGRATIONS_DIR)) if (!f.startsWith(last)) await copyFile(`${MIGRATIONS_DIR}/${f}`, `${dir}/${f}`);
      expect(await migrate(t.pool, { dir })).toEqual(versions.slice(0, -1));
      await t.pool.query(`INSERT INTO users (email) VALUES ('alice@example.com')`);
      const c = await config(t.url);
      const started = await startHub(c, { logger: false, ops: { diskCheckMs: 0 } });
      try {
        expect(started.applied).toEqual([last]);
        expect((await fetch(`http://127.0.0.1:${c.PORT}/healthz`)).status).toBe(200);
        // catalog-db-session-context D1: the hub reads no user files, the catalogue of the existing user is not filled at start
        expect(Number((await t.pool.query(`SELECT count(*) AS n FROM projects`)).rows[0].n)).toBe(0);
      } finally {
        await started.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
      await t.drop();
    }
  });

  // Change multi-user, task 1.2: Requirement «Роли и первичный администратор», scenario «Первый старт после обновления».
  it('bootstrap: the existing user of OIDC_ALLOWED_EMAILS becomes admin, runners and sessions untouched; a second start changes nothing', async () => {
    const t = await createTestDb();
    try {
      const uid = (await t.pool.query<{ id: string }>(`INSERT INTO users (email) VALUES ('alice@example.com') RETURNING id`)).rows[0]!.id;
      await t.pool.query(`INSERT INTO runners (id, user_id, name, hostname) VALUES ('hp', $1, 'HP', 'HP-Elitebook')`, [uid]);
      await t.pool.query(`INSERT INTO sessions (user_id, runner_id, claude_session_id, source, status) VALUES ($1, 'hp', gen_random_uuid(), 'terminal', 'closed')`, [uid]);
      const snapshot = async () => ({
        runners: (await t.pool.query(`SELECT id, user_id, name, hostname, state FROM runners ORDER BY id`)).rows,
        sessions: (await t.pool.query(`SELECT id, user_id, runner_id FROM sessions ORDER BY id`)).rows,
        users: (await t.pool.query(`SELECT id, email, role, provider, status FROM users ORDER BY email`)).rows,
      });
      const before = await snapshot();
      for (let i = 0; i < 2; i++) {
        const c = await config(t.url);
        const started = await startHub(c, { logger: false, ops: { diskCheckMs: 0 } });
        await started.close();
        const after = await snapshot();
        expect(after.users).toEqual([{ id: uid, email: 'alice@example.com', role: 'admin', provider: 'google', status: 'active' }]);
        expect(after.runners).toEqual(before.runners);
        expect(after.sessions).toEqual(before.sessions);
      }
      // the second start wrote nothing to users (the conflict update is skipped for an admin)
      const { bootstrapAdmins } = await import('./users/repo.js');
      expect(await bootstrapAdmins(t.db, ['alice@example.com'])).toBe(0);
      expect(await bootstrapAdmins(t.db, ['second-admin@example.com'])).toBe(1);
    } finally {
      await t.drop();
    }
  });
});
