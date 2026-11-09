// projects:reclassify [--dry-run] (design D9 p. 9, task 4.7; single-project-classifier D1): the path touches of every
// session rebuilt from its events in batches of 200 sessions, then the catalog rules (cwd → remote → changed files,
// never the model) re-run for sessions not pinned; prints the distribution by catalog project and the number without
// one. --dry-run writes nothing and reports the current links.
import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import { ProjectCatalog } from './catalogService.js';
import { sql } from 'kysely';
import { CatalogDetection } from './detection.js';
import { PROJECTS_CHANNEL, ProjectService } from './service.js';

export interface ReclassifyReport {
  sessions: number;
  manual: number;
  withProject: number;
  withoutProject: number;
  /** Sessions whose rebuild failed (after the retries of a deadlock); the run goes on. */
  errors: number;
  byProject: Array<{ title: string; sessions: number }>;
}

export async function reclassifyProjects(db: Db, o: { config: Config; dryRun: boolean; batch?: number; concurrency?: number; log?: (s: string) => void }): Promise<ReclassifyReport> {
  const quiet = { info: () => undefined, warn: (x: object, m: string) => o.log?.(`warn: ${m} ${JSON.stringify(x)}`), error: (x: object, m: string) => o.log?.(`error: ${m} ${JSON.stringify(x)}`) };
  const catalog = new ProjectCatalog({ db, log: quiet as never });
  await catalog.load();
  const projects = new ProjectService({ db, catalog, log: quiet as never });
  const detection = new CatalogDetection({ db, config: o.config, projects, changed: async () => undefined, log: quiet });
  const batch = o.batch ?? 200;
  const report: ReclassifyReport = { sessions: 0, manual: 0, withProject: 0, withoutProject: 0, errors: 0, byProject: [] };
  let last = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const rows = await db.selectFrom('sessions').select(['id', 'project_source']).where('id', '>', last).orderBy('id').limit(batch).execute();
    if (!rows.length) break;
    // A few sessions at a time (each in its own transaction under its touch lock).
    let next = 0;
    const worker = async () => {
      while (next < rows.length) {
        const r = rows[next++]!;
        report.sessions++;
        if (r.project_source === 'manual') report.manual++;
        if (o.dryRun) continue;
        try {
          // A deadlock with the running hub is retried inside (withDbRetry); anything else skips the session.
          await projects.rebuild(r.id);
          await detection.evaluate(r.id, undefined, true);
        } catch (err) {
          report.errors++;
          o.log?.(`error: session ${r.id}: ${(err as Error).message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: o.concurrency ?? 4 }, worker));
    last = rows.at(-1)!.id;
    o.log?.(`… ${report.sessions} sessions`);
  }
  const links = await db
    .selectFrom('session_projects as sp')
    .innerJoin('catalog_projects as cp', 'cp.id', 'sp.project_id')
    .select(['cp.name', sql<string>`count(*)`.as('n')])
    .groupBy('cp.name')
    .execute();
  report.byProject = links.map(l => ({ title: l.name, sessions: Number(l.n) })).sort((a, b) => b.sessions - a.sessions || a.title.localeCompare(b.title));
  report.withProject = report.byProject.reduce((n, p) => n + p.sessions, 0);
  report.withoutProject = report.sessions - report.withProject;
  // The running hub sends projects.changed to the windows of these users (LISTEN, as for a token reissue).
  if (!o.dryRun) {
    const users = (await db.selectFrom('users').select('id').execute()).map(u => u.id);
    await sql`SELECT pg_notify(${PROJECTS_CHANNEL}, ${JSON.stringify(users)})`.execute(db);
  }
  return report;
}
