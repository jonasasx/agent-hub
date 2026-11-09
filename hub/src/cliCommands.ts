// Hub CLI commands (entry point: cli.ts). Needs only DATABASE_URL.
// Change multi-user (spec runner-enrollment «Машины Ивана на том же потоке»): runner:add / runner:token are gone —
// machines are connected by enrollment codes from the UI; the other commands work within one owner (design M3).
import { sql } from 'kysely';
import { parseArgs } from 'node:util';
import type { Db } from './db/db.js';
import { backfillPayloads } from './replication/backfill.js';
import { reclassifySessions } from './replication/reclassify.js';
import { formatReport, googleDriveClient, importDrive, type DriveClient } from './import/drive.js';
import { reclassifyProjects } from './projects/reclassify.js';
import { loadConfig, type Config } from './config.js';
import { backfillSubagents } from './subagents/backfill.js';
import { ProjectCatalog } from './projects/catalogService.js';
import { ProjectService } from './projects/service.js';
import type { ObjectStore } from './storage/objectStore.js';

const USAGE = `Usage:
  cli.js migrate
  cli.js runner:list                runners of every user with their owner (machines are added in the UI: "Connect a machine")
  cli.js runner:set-hostname <id> <hostname>   the machine's hostname before its agent connects (import:drive maps <sid>__<host>.jsonl by it);
                                               unique among the runners of the same owner
  cli.js events:backfill-blobs [--dry-run]   move big tool-result copies of stored events to S3 (D4), idempotent
  cli.js sessions:reclassify [--dry-run]     recompute session sources from main transcripts (D5), idempotent
  cli.js projects:reclassify [--dry-run]     rebuild path signals from events and re-run the catalog rules (D9), pinned sessions untouched
  cli.js subagents:backfill [--session <id>] [--dry-run]
                                               the registry of subagents for history: raw copies in S3,
                                               sessions without them from events; one session at a time, idempotent
  cli.js import:drive [--dry-run] [--folder vault-sessions] [--user <email>]   import session exports from Drive (D16), idempotent;
                                               without --user: the administrator (OIDC_ALLOWED_EMAILS);
                                               needs DRIVE_TOKEN_FILE (read-only token_personal_sessions.json) and S3`;

export async function runCli(
  argv: string[],
  db: Db,
  out: (s: string) => void,
  env: NodeJS.ProcessEnv = process.env,
  deps: { store?: ObjectStore; drive?: DriveClient; config?: Config } = {},
): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'runner:set-hostname': {
      const [id, hostname] = rest;
      if (!id || !hostname) {
        out(USAGE);
        return 2;
      }
      const owner = await db.selectFrom('runners').select('user_id').where('id', '=', id).executeTakeFirst();
      if (!owner) {
        out(`runner ${id} not found`);
        return 1;
      }
      // design M3: hostnames are unique per owner — another user's machine may have the same name.
      const taken = await db
        .selectFrom('runners')
        .select('id')
        .where('user_id', '=', owner.user_id)
        .where(sql<boolean>`lower(hostname) = lower(${hostname})`)
        .where('id', '<>', id)
        .executeTakeFirst();
      if (taken) {
        out(`hostname ${hostname} already belongs to runner ${taken.id}`);
        return 1;
      }
      const r = await db.updateTable('runners').set({ hostname }).where('id', '=', id).executeTakeFirst();
      if (!Number(r.numUpdatedRows)) {
        out(`runner ${id} not found`);
        return 1;
      }
      out(`runner ${id}: hostname ${hostname}`);
      return 0;
    }
    case 'runner:list': {
      const rows = await db
        .selectFrom('runners')
        .innerJoin('users', 'users.id', 'runners.user_id')
        .select([
          'runners.id',
          'runners.name',
          'runners.kind',
          'runners.hostname',
          'runners.online',
          'runners.last_seen_at',
          'runners.agent_version',
          'runners.protocol_version',
          'runners.token_hash',
          'runners.state',
          'users.email',
        ])
        .orderBy('users.email')
        .orderBy('runners.created_at')
        .execute();
      for (const r of rows) {
        out(
          [
            r.id,
            r.name,
            r.email,
            r.state,
            r.kind,
            r.hostname ?? '-',
            r.online ? 'online' : 'offline',
            r.last_seen_at?.toISOString() ?? '-',
            r.agent_version ?? '-',
            r.protocol_version ?? '-',
            r.token_hash ? 'token' : 'no-token',
          ].join('\t'),
        );
      }
      return 0;
    }
    case 'events:backfill-blobs': {
      const { values } = parseArgs({ args: rest, options: { 'dry-run': { type: 'boolean' } } });
      if (!deps.store) {
        out('S3_BUCKET_DATA is required');
        return 2;
      }
      const s = await backfillPayloads(db, deps.store, { dryRun: values['dry-run'] ?? false, log: out });
      out(`${values['dry-run'] ? 'dry run: ' : ''}scanned ${s.scanned}, changed ${s.changed}, blobs uploaded ${s.blobsUploaded}, payload bytes ${s.bytesBefore} -> ${s.bytesAfter}`);
      return 0;
    }
    case 'subagents:backfill': {
      const { values } = parseArgs({ args: rest, options: { 'dry-run': { type: 'boolean' }, session: { type: 'string' } } });
      if (!deps.store) out('warning: S3_BUCKET_DATA is not set: every session is read from the stored events (no hooks, no queue)');
      const r = await backfillSubagents(db, deps.store, { sessionId: values.session, dryRun: values['dry-run'] ?? false, log: out, pauseMs: 50 });
      out(`${values['dry-run'] ? 'dry run: ' : ''}sessions ${r.sessions}, files ${r.files} (from events ${r.fromEvents}), facts ${r.facts}, registry rows ${r.rows}, errors ${r.errors}`);
      return r.errors ? 1 : 0;
    }
    case 'sessions:reclassify': {
      const { values } = parseArgs({ args: rest, options: { 'dry-run': { type: 'boolean' } } });
      const r = await reclassifySessions(db, { dryRun: values['dry-run'] ?? false, log: out });
      out(
        `${values['dry-run'] ? 'dry run: ' : ''}scanned ${r.scanned}, changed ${r.changed}; origin sources: ${Object.entries(r.bySource)
          .map(([k, v]) => `${k} ${v}`)
          .join(', ')}`,
      );
      return 0;
    }
    case 'projects:reclassify': {
      const { values } = parseArgs({ args: rest, options: { 'dry-run': { type: 'boolean' } } });
      const dryRun = values['dry-run'] ?? false;
      const r = await reclassifyProjects(db, {
        config: deps.config ?? loadConfig(env),
        dryRun,
        log: out,
      });
      out(`${dryRun ? 'dry run: ' : ''}sessions ${r.sessions}: with a project ${r.withProject}, without ${r.withoutProject}, pinned ${r.manual}, errors ${r.errors}`);
      for (const p of r.byProject) out(`  ${String(p.sessions).padStart(5)}  ${p.title}`);
      return r.errors ? 1 : 0;
    }
    case 'import:drive': {
      const { values } = parseArgs({ args: rest, options: { 'dry-run': { type: 'boolean' }, folder: { type: 'string' }, user: { type: 'string' } } });
      if (!deps.store) {
        out('S3_BUCKET_DATA is required');
        return 2;
      }
      const tokenFile = env.DRIVE_TOKEN_FILE;
      if (!deps.drive && !tokenFile) {
        out('DRIVE_TOKEN_FILE is required (token_personal_sessions.json, mounted read-only)');
        return 2;
      }
      const drive = deps.drive ?? (await googleDriveClient(tokenFile!));
      // Signals and projects of the imported sessions (D9 p. 5), by the `projects` rows of the database.
      let projects: ProjectService | undefined;
      if (!values['dry-run']) {
        const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined } as never;
        const catalog = new ProjectCatalog({ db, log: quiet });
        await catalog.load();
        projects = new ProjectService({ db, catalog, log: quiet, debounceMs: 0 });
      }
      const dryRun = values['dry-run'] ?? false;
      const r = await importDrive({
        db,
        store: deps.store,
        client: drive,
        folder: values.folder ?? env.DRIVE_FOLDER_NAME ?? 'vault-sessions',
        ...(values.user ? { userEmail: values.user } : {}),
        dryRun,
        log: out,
        ...(projects ? { projects } : {}),
      });
      for (const l of formatReport(r, dryRun)) out(l);
      return r.errors.length ? 1 : 0;
    }
    default:
      out(USAGE);
      return 2;
  }
}
