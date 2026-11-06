// The user's project catalogue for a session's instructions (change catalog-db-session-context, D2): non-archived
// catalogue projects of the owner with the binding folder on the session's machine, the session's own project first.
// Requirement (session-project-context): Каталог проектов в контексте сессии.
import { PROJECT_CATALOG_MAX, type ProjectCatalogEntry } from '@agent-hub/shared';
import type { Db } from '../db/db.js';

export async function loadProjectCatalog(db: Db, userId: string, runnerId: string, currentProjectId: string | null): Promise<ProjectCatalogEntry[]> {
  let q = db
    .selectFrom('catalog_projects as p')
    .leftJoin('project_bindings as b', join => join.onRef('b.project_id', '=', 'p.id').on('b.user_id', '=', userId).on('b.runner_id', '=', runnerId))
    .select(['p.id', 'p.name', 'p.description', 'p.remote', 'b.path'])
    .where('p.user_id', '=', userId)
    .where('p.archived', '=', false);
  if (currentProjectId) q = q.orderBy(eb => eb.case().when('p.id', '=', currentProjectId).then(0).else(1).end());
  const rows = await q
    .orderBy(
      eb => eb.ref('p.last_event_at'),
      o => o.desc().nullsLast(),
    )
    .orderBy('p.name')
    .limit(PROJECT_CATALOG_MAX)
    .execute();
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    description: r.description.trim() || null,
    remote: r.remote,
    path: r.path ?? null,
    current: r.id === currentProjectId,
  }));
}
