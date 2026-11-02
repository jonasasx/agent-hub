// The start of the hub process, in the order the schema needs (M4a deploy defect: buildHub loaded the project
// catalogue from `projects` before migrate created it — 42P01, a restart loop). Migrations first, before any other
// query; then buildHub (its start-up loads read the schema); then the runners offline and listen. server.ts runs it in
// production, start.test.ts on an empty database and on a database one migration behind.
import type pg from 'pg';
import type { Config } from './config.js';
import { createDb, createPool, type Db } from './db/db.js';
import { migrate } from './db/migrate.js';
import { createOidcClient } from './auth/oidc.js';
import { buildHub, type Hub, type HubDeps } from './app.js';

export interface StartedHub {
  hub: Hub;
  pool: pg.Pool;
  db: Db;
  /** Migrations applied by this start. */
  applied: string[];
  close(): Promise<void>;
}

/** JSON lines in the hub log format before the Fastify logger exists (pino levels: 30 info). */
function bootLog(config: Config, msg: string): void {
  if (config.LOG_LEVEL === 'silent') return;
  process.stdout.write(`${JSON.stringify({ level: 30, time: Date.now(), part: 'boot', msg })}\n`);
}

export async function startHub(config: Config, deps: Partial<Omit<HubDeps, 'config' | 'db'>> = {}): Promise<StartedHub> {
  const pool = createPool(config.DATABASE_URL);
  const db = createDb(pool);
  try {
    // 1) The schema. A failure stops the start here, with the migration named (and no half-built hub).
    const applied = await migrate(pool, { log: { info: m => bootLog(config, m) } });
    // 2) The hub: its start-up loads (the project catalogue, the LISTEN connection) need the schema.
    const oidc = deps.oidc ?? createOidcClient({ issuer: config.OIDC_GOOGLE_ISSUER, clientId: config.OIDC_GOOGLE_CLIENT_ID, clientSecret: config.OIDC_GOOGLE_CLIENT_SECRET });
    // Change multi-user (M2): the second provider (Keycloak) when its issuer and client are configured.
    const oidcKeycloak =
      deps.oidcKeycloak ??
      (config.keycloakEnabled ? createOidcClient({ issuer: config.OIDC_KEYCLOAK_ISSUER!, clientId: config.OIDC_KEYCLOAK_CLIENT_ID!, clientSecret: config.OIDC_KEYCLOAK_CLIENT_SECRET! }) : undefined);
    const hub = await buildHub({ ...deps, config, db, oidc, ...(oidcKeycloak ? { oidcKeycloak } : {}) });
    // No agent is connected to a freshly started process.
    await db.updateTable('runners').set({ online: false }).where('online', '=', true).execute();
    await hub.app.listen({ host: config.HOST, port: config.PORT });
    return {
      hub,
      pool,
      db,
      applied,
      async close() {
        await hub.close();
        await db
          .updateTable('runners')
          .set({ online: false })
          .where('online', '=', true)
          .execute()
          .catch(() => undefined);
        await pool.end().catch(() => undefined);
      },
    };
  } catch (err) {
    await pool.end().catch(() => undefined);
    throw err;
  }
}
