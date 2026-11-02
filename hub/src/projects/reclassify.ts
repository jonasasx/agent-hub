// projects:reclassify [--dry-run] (design D9 p. 9, task 4.7): the path touches of every session rebuilt from its events
// in batches of 200 sessions, the project decided afresh (pinned sessions untouched, no toasts); prints the
// distribution by project and the number without a project. --dry-run writes nothing.
import type { Db } from '../db/db.js';
import { ProjectCatalog } from './catalogService.js';
import { sql } from 'kysely';
import { PROJECTS_CHANNEL, ProjectService } from './service.js';

export interface ReclassifyReport {
  sessions: number;
  manual: number;
  withProject: number;
  withoutProject: number;
  /** Sessions whose rebuild failed (after the retries of a deadlock); the run goes on. */
  errors: number;
  byProject: Array<{ title: string; path: string; sessions: number }>;
}

export async function reclassifyProjects(
  db: Db,
  o: { vaultDir: string | null; legacyFile: string | null; vaultRemotes: string[]; dryRun: boolean; fresh?: boolean; batch?: number; concurrency?: number; log?: (s: string) => void },
): Promise<ReclassifyReport> {
  const quiet = { info: () => undefined, warn: (x: object, m: string) => o.log?.(`warn: ${m} ${JSON.stringify(x)}`), error: (x: object, m: string) => o.log?.(`error: ${m} ${JSON.stringify(x)}`) };
  const catalog = new ProjectCatalog({ db, log: quiet as never, vaultDir: o.vaultDir, legacyFile: o.legacyFile, vaultRemotes: o.vaultRemotes, readOnly: o.dryRun });
  await catalog.start(0);
  const projects = new ProjectService({ db, catalog, log: quiet as never });
  const batch = o.batch ?? 200;
  const report: ReclassifyReport = { sessions: 0, manual: 0, withProject: 0, withoutProject: 0, errors: 0, byProject: [] };
  const counts = new Map<string, number>();
  let last = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const rows = await db.selectFrom('sessions').select(['id', 'project_source', 'project_id']).where('id', '>', last).orderBy('id').limit(batch).execute();
    if (!rows.length) break;
    // A few sessions at a time (each in its own transaction under its touch lock).
    let next = 0;
    const worker = async () => {
      while (next < rows.length) {
        const r = rows[next++]!;
        report.sessions++;
        let projectId: string | null;
        if (r.project_source === 'manual') {
          report.manual++;
          projectId = r.project_id;
        } else {
          try {
            // A deadlock with the running hub is retried inside (withDbRetry); anything else skips the session.
            const d = await projects.rebuild(r.id, o.dryRun, o.fresh ?? false);
            projectId = d?.projectId ?? null;
          } catch (err) {
            report.errors++;
            o.log?.(`error: session ${r.id}: ${(err as Error).message}`);
            continue;
          }
        }
        if (projectId) {
          report.withProject++;
          counts.set(projectId, (counts.get(projectId) ?? 0) + 1);
        } else report.withoutProject++;
      }
    };
    await Promise.all(Array.from({ length: o.concurrency ?? 4 }, worker));
    last = rows.at(-1)!.id;
    o.log?.(`… ${report.sessions} sessions`);
  }
  report.byProject = [...counts.entries()]
    .map(([id, n]) => ({ title: catalog.row(id)?.title ?? id, path: catalog.row(id)?.path ?? '', sessions: n }))
    .sort((a, b) => b.sessions - a.sessions || a.title.localeCompare(b.title));
  catalog.stop();
  // The running hub sends projects.changed to the windows of these users (LISTEN, as for a token reissue).
  if (!o.dryRun) {
    const users = (await db.selectFrom('users').select('id').execute()).map(u => u.id);
    await sql`SELECT pg_notify(${PROJECTS_CHANNEL}, ${JSON.stringify(users)})`.execute(db);
  }
  return report;
}
