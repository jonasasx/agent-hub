import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { createDb, createPool, type Db } from '../db/db.js';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    /** The migrated template database of the run (globalSetup). */
    templateDb: string;
  }
}

export interface TestDb {
  url: string;
  pool: pg.Pool;
  db: Db;
  drop(): Promise<void>;
}

/** Creates an isolated database for one test file. Migrations are applied unless `migrated: false`. */
export async function createTestDb(opts: { migrated?: boolean } = {}): Promise<TestDb> {
  const adminUrl = inject('databaseUrl');
  const name = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    if (opts.migrated !== false) {
      // A clone of the migrated template (globalSetup): no migrations per file. Clones of one template made at the
      // same moment may collide («source database is being accessed»): retried.
      const tmpl = inject('templateDb');
      for (let i = 0; ; i++) {
        try {
          await admin.query(`CREATE DATABASE ${name} TEMPLATE ${tmpl}`);
          break;
        } catch (err) {
          if (i >= 20 || !/being accessed by other users/.test((err as Error).message)) throw err;
          await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
        }
      }
    } else {
      // UTF8 as on the prod server (postgres:17 image, en_US.utf8); the embedded cluster on Windows defaults to WIN1251.
      // ICU gives case-insensitive ILIKE and lower() for Cyrillic, as on prod.
      await admin.query(`CREATE DATABASE ${name} ENCODING 'UTF8' TEMPLATE template0 LOCALE_PROVIDER icu ICU_LOCALE 'und' LOCALE 'C'`);
    }
  } finally {
    await admin.end();
  }
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  const url = u.toString();
  const pool = createPool(url);
  const db = createDb(pool);
  return {
    url,
    pool,
    db,
    async drop() {
      await db.destroy();
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}
