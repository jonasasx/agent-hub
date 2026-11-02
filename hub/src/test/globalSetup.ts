// Starts one Postgres 17 for the whole test run and hands its admin URL to tests via inject('databaseUrl').
// Order: TEST_DATABASE_URL (a superuser URL) → Docker container postgres:17 → embedded-postgres 17 (no Docker).
// TEST_PG=docker|embedded forces the backend.
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createPool } from '../db/db.js';
import { migrate, MIGRATIONS_DIR } from '../db/migrate.js';
// Type-only re-export pulls in the ProvidedContext.databaseUrl augmentation declared in db.ts.
export type { TestDb } from './db.js';

const run = promisify(execFile);

interface Shared {
  url: string;
  /** A database with every migration applied: test files clone it (CREATE DATABASE … TEMPLATE). */
  template: string;
  containerId: string | null;
  embedded: { stop(): Promise<void> } | null;
  refs: number;
  ready: Promise<void>;
}

const KEY = Symbol.for('agent-hub.test-postgres');
const g = globalThis as unknown as { [KEY]?: Shared };
const SERVER_FLAGS = ['default_toast_compression=lz4', 'fsync=off', 'synchronous_commit=off', 'max_connections=300'];

async function docker(args: string[], timeoutMs = 120_000): Promise<string> {
  const { stdout } = await run('docker', args, { timeout: timeoutMs, windowsHide: true });
  return stdout.trim();
}

async function dockerAvailable(): Promise<boolean> {
  try {
    await docker(['info', '--format', '{{.ServerVersion}}'], 10_000);
    return true;
  } catch {
    return false;
  }
}

async function waitReady(url: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    const c = new pg.Client({ connectionString: url });
    try {
      await c.connect();
      await c.query('SELECT 1');
      await c.end();
      return;
    } catch (err) {
      lastErr = err;
      await c.end().catch(() => undefined);
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw new Error(`Postgres did not become ready: ${(lastErr as Error)?.message}`);
}

/** Runs pg_ctl without pipes: the postmaster inherits stdio handles, so waiting for pipe close would hang. */
function pgCtl(bin: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: 'ignore', windowsHide: true });
    const t = setTimeout(() => {
      p.kill();
      reject(new Error(`pg_ctl ${args.at(-1)} timed out`));
    }, timeoutMs);
    p.on('error', e => (clearTimeout(t), reject(e)));
    p.on('exit', code => (clearTimeout(t), code === 0 ? resolve() : reject(new Error(`pg_ctl ${args.at(-1)} exited with ${code}`))));
  });
}

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

async function startDocker(shared: Shared): Promise<void> {
  const id = await docker(
    [
      'run',
      '-d',
      '--rm',
      '-e',
      'POSTGRES_USER=test',
      '-e',
      'POSTGRES_PASSWORD=test',
      '-e',
      'POSTGRES_DB=postgres',
      '-p',
      '127.0.0.1::5432',
      '--label',
      'agent-hub-test=1',
      'postgres:17',
      ...SERVER_FLAGS.flatMap(f => ['-c', f]),
    ],
    600_000,
  );
  shared.containerId = id;
  const port = (await docker(['port', id, '5432/tcp'])).split('\n')[0]!.split(':').pop();
  shared.url = `postgres://test:test@127.0.0.1:${port}/postgres`;
  await waitReady(shared.url);
}

/**
 * embedded-postgres registers async-exit-hook on import. Its 'beforeExit' handler calls process.exit(0),
 * which overrides the process.exitCode = 1 vitest sets for failed tests: a red run exited with 0.
 * The hook only stops servers started through EmbeddedPostgres.start(); ours is run by pg_ctl and
 * stopped in teardown, so all of the hook's process listeners are removed right after the import.
 */
async function importEmbeddedPostgres(): Promise<typeof import('embedded-postgres').default> {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  // The same CommonJS instance embedded-postgres imported: resolved from its own package directory
  // (import.meta.resolve is unavailable when vite's module runner loads this file for the agent project).
  const epPackage = fileURLToPath(new URL('../../../node_modules/embedded-postgres/package.json', import.meta.url));
  const exitHook = createRequire(epPackage)('async-exit-hook') as {
    hookedEvents(): string[];
    unhookEvent(event: string): void;
  };
  // A repeated run in watch mode finds nothing hooked. scripts/check-exit.mjs proves the removal works.
  for (const e of exitHook.hookedEvents()) exitHook.unhookEvent(e);
  return EmbeddedPostgres;
}

async function startEmbedded(shared: Shared): Promise<void> {
  // The cluster is initialised once (initdb takes ~1.5 min on Windows) and reused by later runs:
  // every test file works in its own database, so state does not leak between runs.
  // The server is started with pg_ctl, which drops administrator rights on Windows
  // (postgres.exe refuses to run elevated, and agent shells are often elevated).
  const EmbeddedPostgres = await importEmbeddedPostgres();
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const bins = (await import(`@embedded-postgres/${platform}-${process.arch}`)) as { pg_ctl: string };
  const port = await freePort();
  const dir = fileURLToPath(new URL('../../../node_modules/.cache/agent-hub-test-pg/cluster', import.meta.url));
  if (!existsSync(`${dir}/PG_VERSION`)) {
    await rm(dir, { recursive: true, force: true });
    const init = new EmbeddedPostgres({ databaseDir: dir, port, user: 'test', password: 'test', persistent: true, onLog: () => undefined });
    await init.initialise();
  }
  // A crashed earlier run may have left the server up.
  await pgCtl(bins.pg_ctl, ['-D', dir, '-m', 'immediate', '-w', 'stop'], 60_000).catch(() => undefined);
  const opts = [`-p ${port}`, '-c listen_addresses=127.0.0.1', ...SERVER_FLAGS.map(f => `-c ${f}`)].join(' ');
  await pgCtl(bins.pg_ctl, ['-D', dir, '-o', opts, '-l', `${dir}.log`, '-w', '-t', '60', 'start'], 90_000);
  shared.embedded = {
    async stop() {
      await pgCtl(bins.pg_ctl, ['-D', dir, '-m', 'fast', '-w', 'stop'], 60_000).catch(() => undefined);
    },
  };
  shared.url = `postgres://test:test@127.0.0.1:${port}/postgres`;
  await waitReady(shared.url);
  // Databases of an interrupted earlier run.
  const c = new pg.Client({ connectionString: shared.url });
  await c.connect();
  const stale = await c.query<{ datname: string }>(`SELECT datname FROM pg_database WHERE datname ~ '^t_[0-9a-f]{12}$'`);
  for (const r of stale.rows) await c.query(`DROP DATABASE IF EXISTS ${r.datname} WITH (FORCE)`);
  await c.end();
}

/**
 * The migrated template, once per run: named by the checksum of the migrations, so a reused embedded cluster keeps it
 * while they do not change; templates of other migration sets are dropped. Created under the encoding of the test
 * databases (UTF8, ICU) — clones inherit it.
 */
async function prepareTemplate(shared: Shared): Promise<void> {
  const h = createHash('sha256');
  for (const f of (await readdir(MIGRATIONS_DIR)).filter(x => x.endsWith('.up.sql')).sort()) h.update(f).update(await readFile(`${MIGRATIONS_DIR}/${f}`, 'utf8'));
  const name = `tmpl_${h.digest('hex').slice(0, 16)}`;
  const c = new pg.Client({ connectionString: shared.url });
  await c.connect();
  try {
    const old = await c.query<{ datname: string }>(`SELECT datname FROM pg_database WHERE datname ~ '^tmpl_[0-9a-f]{16}$' AND datname <> $1`, [name]);
    for (const r of old.rows) {
      await c.query(`ALTER DATABASE ${r.datname} IS_TEMPLATE false`).catch(() => undefined);
      await c.query(`DROP DATABASE IF EXISTS ${r.datname} WITH (FORCE)`);
    }
    const ready = await c.query(`SELECT 1 FROM pg_database WHERE datname = $1 AND datistemplate`, [name]);
    if (!ready.rowCount) {
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.query(`CREATE DATABASE ${name} ENCODING 'UTF8' TEMPLATE template0 LOCALE_PROVIDER icu ICU_LOCALE 'und' LOCALE 'C'`);
      const u = new URL(shared.url);
      u.pathname = `/${name}`;
      const pool = createPool(u.toString());
      try {
        await migrate(pool);
      } finally {
        await pool.end();
      }
      await c.query(`ALTER DATABASE ${name} IS_TEMPLATE true`);
    }
  } finally {
    await c.end();
  }
  shared.template = name;
}

async function start(shared: Shared): Promise<void> {
  const mode = process.env.TEST_PG;
  if (mode === 'embedded') return startEmbedded(shared);
  if (mode === 'docker' || (await dockerAvailable())) return startDocker(shared);
  return startEmbedded(shared);
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  let shared = g[KEY];
  if (!shared) {
    const fromEnv = process.env.TEST_DATABASE_URL;
    shared = { url: fromEnv ?? '', template: '', containerId: null, embedded: null, refs: 0, ready: Promise.resolve() };
    const s = shared;
    shared.ready = (fromEnv ? waitReady(fromEnv) : start(shared)).then(() => prepareTemplate(s));
    g[KEY] = shared;
  }
  shared.refs++;
  try {
    await shared.ready;
  } catch (err) {
    // Plain message: vitest fails to print stack traces from global setup modules.
    throw new Error(`Test Postgres failed to start: ${(err as Error).message}`, { cause: err });
  }
  project.provide('databaseUrl', shared.url);
  project.provide('templateDb', shared.template);

  return async () => {
    const s = g[KEY]!;
    s.refs--;
    if (s.refs === 0) {
      if (s.containerId) await docker(['rm', '-f', s.containerId], 60_000).catch(() => undefined);
      if (s.embedded) await s.embedded.stop().catch(() => undefined);
      delete g[KEY];
    }
  };
}
