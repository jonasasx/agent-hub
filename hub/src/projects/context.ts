// The user's project catalogue for a session's instructions (change catalog-db-session-context, D2): non-archived
// catalogue projects of the owner with their folder on the session's machine (session-folder D5: the machine's default
// folder plus the project's folder), the session's own project first.
// Requirement (session-project-context): Каталог проектов в контексте сессии.
import { PROJECT_CATALOG_MAX, platformOfHome, projectDir, type ProjectCatalogEntry } from '@agent-hub/shared';
import type { Db } from '../db/db.js';

export async function loadProjectCatalog(db: Db, userId: string, runnerId: string, currentProjectId: string | null): Promise<ProjectCatalogEntry[]> {
  const runner = await db.selectFrom('runners').select(['home_dir', 'default_dir']).where('id', '=', runnerId).where('user_id', '=', userId).executeTakeFirst();
  const base = runner?.default_dir ?? runner?.home_dir ?? null;
  const windows = platformOfHome(runner?.home_dir) === 'windows';
  let q = db.selectFrom('catalog_projects as p').select(['p.id', 'p.name', 'p.description', 'p.remote', 'p.folder']).where('p.user_id', '=', userId).where('p.archived', '=', false);
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
    path: base && r.folder ? projectDir(base, r.folder, windows) : null,
    current: r.id === currentProjectId,
  }));
}
