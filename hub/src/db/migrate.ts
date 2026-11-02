import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

/** Lock id for pg_advisory_lock: concurrent hub starts apply migrations one at a time. */
const MIGRATION_LOCK_ID = 7_236_051_947_100_001n;

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

/** sha256 of a migration file; line endings and a BOM do not count (a Windows checkout gives the same sum). */
export function migrationChecksum(text: string): string {
  return createHash('sha256')
    .update(text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'))
    .digest('hex');
}

export interface MigrationLogger {
  info(msg: string): void;
}

/**
 * Applies pending `NNN_name.up.sql` files in order, each in its own transaction,
 * under a session-level advisory lock. Safe to run repeatedly and concurrently.
 * The checksum of every applied file is kept in schema_migrations (filled at start for versions applied before it was
 * recorded); a file changed after it was applied stops the start with an error naming it.
 * Returns the versions applied by this call.
 */
export async function migrate(pool: pg.Pool, opts: { dir?: string; log?: MigrationLogger } = {}): Promise<string[]> {
  const dir = opts.dir ?? MIGRATIONS_DIR;
  const files = (await readdir(dir)).filter(f => /^\d{3}_[\w-]+\.up\.sql$/.test(f)).sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID.toString()]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version     text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )`);
    await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text');
    const done = new Map((await client.query<{ version: string; checksum: string | null }>('SELECT version, checksum FROM schema_migrations')).rows.map(r => [r.version, r.checksum]));
    const texts = new Map<string, string>();
    for (const file of files) texts.set(file, await readFile(`${dir}/${file}`, 'utf8'));
    const changed: string[] = [];
    for (const file of files) {
      const version = file.replace(/\.up\.sql$/, '');
      if (!done.has(version)) continue;
      const sum = migrationChecksum(texts.get(file)!);
      const had = done.get(version);
      if (had === null || had === undefined) await client.query('UPDATE schema_migrations SET checksum = $2 WHERE version = $1 AND checksum IS NULL', [version, sum]);
      else if (had !== sum) changed.push(`${file} (applied ${had.slice(0, 12)}…, file ${sum.slice(0, 12)}…)`);
    }
    if (changed.length) {
      throw new Error(
        `Applied migrations were changed after they were applied: ${changed.join(', ')}. The database was not touched. ` +
          'Restore the files as they were and put the change into a new migration; if the file was changed on purpose and ' +
          `its effect is already in the database: UPDATE schema_migrations SET checksum = NULL WHERE version = '<version>'.`,
      );
    }
    for (const file of files) {
      const version = file.replace(/\.up\.sql$/, '');
      if (done.has(version)) continue;
      const sql = texts.get(file)!;
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [version, migrationChecksum(sql)]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
      applied.push(version);
      opts.log?.info(`migration applied: ${version}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID.toString()]).catch(() => undefined);
    client.release();
  }
  return applied;
}
