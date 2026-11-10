// Change `agent-project-tools` (design D2, D4): creating and editing a catalogue project and the manual link of a session,
// shared by the REST routes (/api/catalog/projects, /api/sessions/:id/project) and the agent-hub tools of a session.
// Notifications (catalogChanged, projectsChanged, sessions.upsert) stay with the caller.
import { randomUUID } from 'node:crypto';
import { sql, type Selectable } from 'kysely';
import { allocateProjectColor, type ProjectColorKey } from '@agent-hub/shared';
import type { CatalogProjectsTable, Db } from '../db/db.js';

export type CatalogProjectRow = Selectable<CatalogProjectsTable>;

export interface CatalogProjectInput {
  name: string;
  colorKey?: ProjectColorKey | undefined;
  description?: string | undefined;
  remote?: string | null | undefined;
  folder?: string | null | undefined;
}

export interface CatalogProjectPatch {
  name?: string | undefined;
  colorKey?: ProjectColorKey | undefined;
  description?: string | undefined;
  remote?: string | null | undefined;
  folder?: string | null | undefined;
  archived?: boolean | undefined;
}

/** A unique violation of the active name: the REST answers 409 name_conflict, the tools — `conflict`. */
export function isNameConflict(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string };
  return e.code === '23505' && e.constraint === 'catalog_projects_active_name';
}

/** A new project of the user; the colour is the least used one unless given. Throws the database error on a name conflict. */
export async function createCatalogProject(db: Db, userId: string, b: CatalogProjectInput): Promise<CatalogProjectRow> {
  return db.transaction().execute(async tx => {
    await sql`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`.execute(tx);
    const used = await tx.selectFrom('catalog_projects').select('color_key').where('user_id', '=', userId).where('archived', '=', false).execute();
    const id = randomUUID();
    return tx
      .insertInto('catalog_projects')
      .values({
        id,
        user_id: userId,
        name: b.name,
        color_key:
          b.colorKey ??
          allocateProjectColor(
            used.map(p => p.color_key),
            id,
          ),
        description: b.description ?? '',
        remote: b.remote ?? null,
        folder: b.folder ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}

/**
 * The given fields of the user's project; undefined — the project is not the user's (or archived when `activeOnly`).
 * Throws the database error on a name conflict.
 */
export async function updateCatalogProject(db: Db, userId: string, id: string, patch: CatalogProjectPatch, activeOnly = false): Promise<CatalogProjectRow | undefined> {
  const { colorKey, ...metadata } = patch;
  return db.transaction().execute(async tx => {
    let own = tx.selectFrom('catalog_projects').select('id').where('id', '=', id).where('user_id', '=', userId);
    if (activeOnly) own = own.where('archived', '=', false);
    if (!(await own.forUpdate().executeTakeFirst())) return undefined;
    return tx
      .updateTable('catalog_projects')
      .set({ ...metadata, ...(colorKey ? { color_key: colorKey } : {}), updated_at: sql`now()` })
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}

/** «Перенести в…»: the session goes to the project by hand (source `manual`); the caller refreshes the session view. */
export async function linkSessionToProject(db: Db, userId: string, sessionId: string, projectId: string): Promise<void> {
  await db.transaction().execute(async tx => {
    await tx.selectFrom('sessions').select('id').where('id', '=', sessionId).where('user_id', '=', userId).forUpdate().executeTakeFirst();
    await tx
      .insertInto('session_projects')
      .values({ user_id: userId, session_id: sessionId, project_id: projectId, source: 'manual', confidence: null, reason_code: 'selected' })
      .onConflict(oc => oc.columns(['user_id', 'session_id']).doUpdateSet({ project_id: projectId, source: 'manual', confidence: null, reason_code: 'selected' }))
      .execute();
  });
}
