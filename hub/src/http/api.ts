import type { CatalogDetection } from '../projects/detection.js';
import { createCatalogProject, isNameConflict, linkSessionToProject, updateCatalogProject } from '../projects/catalogWrite.js';
// REST API (design.md D10): sessions, chat history, runners' directories, models, sidebar, layout template.
// Every query is scoped by req.user.id (Requirement: Данные привязаны к пользователю).
import type { FastifyInstance, FastifyReply } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import {
  LAYOUT_BODY_LIMIT,
  projectColorSchema,
  type ColorKey,
  createSessionRequestSchema,
  createUserProjectSchema,
  patchUserProjectSchema,
  userProjectListQuerySchema,
  userProjectParamsSchema,
  forkRequestSchema,
  handoffDraftRequestSchema,
  patchSessionRequestSchema,
  permissionDecisionRequestSchema,
  putLayoutRequestSchema,
  setProjectRequestSchema,
  searchQuerySchema,
  sendMessageRequestSchema,
  statQuerySchema,
  providerSchema,
  extraProviderSchema,
  wakeRequestSchema,
  restartSessionRequestSchema,
  projectSuggestionAnswerSchema,
  resolveSessionRefsSchema,
  type SessionRefView,
  type EventsPage,
  type LayoutResponse,
  type ProjectListItem,
  type ProjectSessionsResponse,
  type SessionView,
  type SearchResponse,
  type PutLayoutResponse,
  type SidebarResponse,
  type SubagentView,
  type SubagentsResponse,
  type UserProjectView,
  pathFitsPlatform,
  platformOfHome,
} from '@agent-hub/shared';
import type { Db } from '../db/db.js';
import type { AgentGateway, CommandError } from '../runners/agentGateway.js';
import { listRunnerViews } from '../runners/repo.js';
import { eventsPage, projectRef, resolveSessionRefs, selectSessions } from '../sessions/repo.js';
import { HttpError, type SessionService } from '../sessions/service.js';
import type { HandoffService } from '../sessions/handoff.js';
import { getSubagent, listHubChildren, listSubagents, runFile, subagentEventsPage } from '../subagents/repo.js';
import { listBackground } from '../subagents/background.js';
import { searchSessions } from '../sessions/search.js';
import { registerFileRoutes, type FsRouteOptions } from './files.js';
import { LOCALE_IDS } from '@agent-hub/shared';
import { render, tr } from '../i18n.js';
import { tx } from '../texts.js';

function parse<T extends z.ZodType>(schema: T, v: unknown): z.infer<T> {
  const r = schema.safeParse(v ?? {});
  if (!r.success) throw new HttpError(400, 'invalid_request', z.prettifyError(r.error));
  return r.data;
}

const cronFlag = z.object({ cron: z.enum(['0', '1']).optional() });
const pageQuery = z.object({
  cron: z.enum(['0', '1']).optional(),
  offset: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const eventsQuery = z.object({ before: z.string().max(500).optional(), limit: z.coerce.number().int().min(1).max(500).default(200) });
const deviceQuery = z.object({ device: z.enum(['desktop', 'phone']) });
const modelsQuerySchema = z.object({ provider: providerSchema.optional() });
const providerParamsSchema = z.object({ id: z.string().min(1), provider: extraProviderSchema });

export function registerApi(
  app: FastifyInstance,
  deps: {
    db: Db;
    agents: AgentGateway;
    sessions: SessionService;
    handoff: HandoffService;
    detection: CatalogDetection;
    /** Tests: limits and timeouts of the file explorer routes. */
    files?: Partial<FsRouteOptions>;
    /** The hub's agent build version («устарела», spec runner-enrollment). */ latestAgent: () => string | null;
  },
): void {
  const { db, sessions, handoff, agents, latestAgent, detection } = deps;

  app.setErrorHandler((err, req, reply: FastifyReply) => {
    if (err instanceof HttpError) {
      const message = err.i18n ? tr(req.locale).text(err.i18n.key, err.i18n.params) : err.message;
      return reply.code(err.status).send({ ...err.details, error: err.code, message });
    }
    if (isNameConflict(err)) {
      return reply.code(409).send({ error: 'name_conflict', message: tr(req.locale).text('hub.api.nameConflict') });
    }
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode === 413) return reply.code(413).send({ error: 'too_large', message: tr(req.locale).text('hub.api.bodyTooLarge') });
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: 'invalid_request', message: e.message });
    req.log.error({ err }, 'request failed');
    return reply.code(500).send({ error: 'internal' });
  });

  const visible = (cron: '0' | '1' | undefined) => (cron === '1' ? sql<boolean>`true` : sql<boolean>`s.source <> 'cron'`);
  // hub-subagents D10: a spawned session lives under its parent («Субагенты»), not in the lists of the sidebar
  const notSpawned = sql<boolean>`s.spawned_by IS NULL`;
  // single-project-classifier: a session without a catalog link is «Без проекта»
  const noCatalogLink = sql<boolean>`NOT EXISTS (SELECT 1 FROM session_projects sp WHERE sp.user_id = s.user_id AND sp.session_id = s.id)`;
  const recency = sql`COALESCE(s.last_event_at, s.created_at)`;

  app.get('/api/runners/:runnerId/directories', async req => {
    const params = parse(z.object({ runnerId: z.string().min(1).max(200) }), req.params);
    const query = parse(z.object({ path: z.string().max(4096).optional(), showHidden: z.enum(['true', 'false']).default('false') }), req.query);
    const owned = await db.selectFrom('runners').select(['id', 'home_dir']).where('id', '=', params.runnerId).where('user_id', '=', req.user!.id).where('state', '=', 'active').executeTakeFirst();
    if (!owned) throw new HttpError(404, 'runner_not_found', 'Runner not found');
    if (query.path && !pathFitsPlatform(query.path, platformOfHome(owned.home_dir))) throw new HttpError(400, 'invalid_path', { key: 'hub.files.invalidPath' });
    const connection = agents.get(params.runnerId);
    if (!connection) throw new HttpError(409, 'runner_offline', 'Runner is offline');
    if (!connection.capabilities.includes('fs.list-dirs')) throw new HttpError(409, 'capability_unavailable', 'Agent does not support directory browsing');
    try {
      return await connection.request('fs.list-dirs', { path: query.path, showHidden: query.showHidden === 'true' }, 8000);
    } catch (error) {
      const e = error as CommandError;
      if (e.code === 'timeout') throw new HttpError(504, 'agent_timeout', 'Agent directory listing timed out');
      if (e.code === 'disconnected') throw new HttpError(409, 'runner_offline', 'Runner disconnected while listing directories');
      if (['invalid_path', 'not_found', 'not_directory', 'permission_denied', 'too_many_entries'].includes(e.code)) throw new HttpError(400, e.code, e.message || 'Cannot list directory');
      throw error;
    }
  });

  registerFileRoutes(app, { db, agents, ...(deps.files ? { options: deps.files } : {}) });

  app.post('/api/sessions/:id/project-suggestion', async req => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const answer = parse(projectSuggestionAnswerSchema, req.body);
    const { created } = await detection.answer(req.user!.id, id, answer);
    if (created) sessions.projectsChanged(req.user!.id);
    return { ok: true };
  });

  // change i18n D4: the interface language of the profile; null — «Как в браузере»
  app.put('/api/preferences/locale', async (req, reply) => {
    const { locale } = parse(z.object({ locale: z.enum(LOCALE_IDS).nullable() }), req.body);
    const userId = req.user!.id;
    await db
      .insertInto('user_preferences')
      .values({ user_id: userId, last_runner_id: null, last_provider: null, locale })
      .onConflict(oc => oc.column('user_id').doUpdateSet({ locale }))
      .execute();
    return reply.code(204).send();
  });

  app.get('/api/preferences/launch', async (req): Promise<{ runnerId: string | null; provider: 'claude' | 'codex' | null }> => {
    const userId = req.user!.id;
    const pref = await db.selectFrom('user_preferences').select(['last_runner_id', 'last_provider']).where('user_id', '=', userId).executeTakeFirst();
    if (!pref?.last_runner_id) return { runnerId: null, provider: pref?.last_provider ?? null };
    const runner = await db.selectFrom('runners').select(['id', 'online']).where('id', '=', pref.last_runner_id).where('user_id', '=', userId).where('state', '=', 'active').executeTakeFirst();
    if (runner?.online) return { runnerId: runner.id, provider: pref.last_provider };
    const first = await db.selectFrom('runners').select('id').where('user_id', '=', userId).where('state', '=', 'active').where('online', '=', true).orderBy('created_at').executeTakeFirst();
    return { runnerId: first?.id ?? null, provider: pref.last_provider };
  });

  // User-owned project catalog; separate from `projects`, which is synchronized from the legacy vault index.
  app.get('/api/catalog/projects', async (req): Promise<UserProjectView[]> => {
    const userId = req.user!.id;
    const { sort, includeArchived } = parse(userProjectListQuerySchema, req.query);
    const [projects, activity] = await Promise.all([
      db
        .selectFrom('catalog_projects')
        .selectAll()
        .where('user_id', '=', userId)
        .where(includeArchived === '1' ? sql<boolean>`true` : sql<boolean>`NOT archived`)
        .execute(),
      db
        .selectFrom('session_projects as sp')
        .innerJoin('sessions as s', 's.id', 'sp.session_id')
        .select(['sp.project_id', sql<Date | null>`max(${recency})`.as('last'), sql<string>`count(*)`.as('n')])
        .where('sp.user_id', '=', userId)
        .where('s.user_id', '=', userId)
        .groupBy('sp.project_id')
        .execute(),
    ]);
    const activityByProject = new Map(activity.map(a => [a.project_id, a.last ? new Date(a.last).toISOString() : null]));
    if (sort === 'name') projects.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    else projects.sort((a, b) => (activityByProject.get(b.id) ?? '').localeCompare(activityByProject.get(a.id) ?? '') || a.name.localeCompare(b.name));
    return projects.map(p => ({
      id: p.id,
      name: p.name,
      colorKey: p.color_key,
      sessionCount: Number(activity.find(a => a.project_id === p.id)?.n ?? 0),
      description: p.description,
      remote: p.remote,
      archived: p.archived,
      lastEventAt: activityByProject.get(p.id) ?? p.last_event_at?.toISOString() ?? null,
      folder: p.folder,
    }));
  });
  app.post('/api/catalog/projects', async (req, reply): Promise<UserProjectView> => {
    const b = parse(createUserProjectSchema, req.body);
    const userId = req.user!.id;
    const p = await createCatalogProject(db, userId, b);
    sessions.projects?.catalogChanged(userId);
    reply.code(201);
    return {
      id: p.id,
      name: p.name,
      colorKey: p.color_key,
      description: p.description,
      remote: p.remote,
      archived: p.archived,
      lastEventAt: null,
      folder: p.folder,
    };
  });
  app.patch('/api/catalog/projects/:id', async (req): Promise<{ ok: true }> => {
    const b = parse(patchUserProjectSchema, req.body);
    const { id } = parse(userProjectParamsSchema, req.params);
    const userId = req.user!.id;
    const updated = await updateCatalogProject(db, userId, id, b);
    if (!updated) throw new HttpError(404, 'not_found', { key: 'hub.api.projectNotFound' });
    sessions.projectsChanged(userId);
    if (b.name || b.folder !== undefined) sessions.projects?.catalogChanged(userId);
    return { ok: true };
  });
  app.delete('/api/catalog/projects/:id', async req => {
    const { id } = parse(userProjectParamsSchema, req.params);
    const linked = await db.transaction().execute(async tx => {
      const own = await tx.selectFrom('catalog_projects').select('id').where('user_id', '=', req.user!.id).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!own) throw new HttpError(404, 'not_found', { key: 'hub.api.projectNotFound' });
      const rows = await tx.selectFrom('session_projects').select('session_id').where('user_id', '=', req.user!.id).where('project_id', '=', id).execute();
      // Cascades remove only bindings and explicit links; sessions and transcript data are independent.
      await tx.deleteFrom('catalog_projects').where('user_id', '=', req.user!.id).where('id', '=', id).execute();
      return rows;
    });
    const finish = () => sessions.projectsChanged(req.user!.id);
    if (sessions.projects)
      sessions.projects.reclassifyDeleted(
        linked.map(row => row.session_id),
        finish,
      );
    else setImmediate(finish);
    return { ok: true };
  });
  app.patch('/api/projects/:id/color', async req => {
    const { id } = parse(userProjectParamsSchema, req.params);
    const { colorKey } = parse(z.object({ colorKey: projectColorSchema }), req.body);
    if (!(await sessions.projects?.catalog.setColor(req.user!.id, id, colorKey))) throw new HttpError(404, 'not_found', { key: 'hub.api.groupNotFound' });
    sessions.projectsChanged(req.user!.id);
    return { ok: true };
  });
  app.get('/api/projects/hidden', async req => {
    return db
      .selectFrom('hidden_project_groups as h')
      .innerJoin('projects as p', 'p.id', 'h.project_id')
      .select(['p.id', 'p.title', 'p.color_key as colorKey', 'p.path'])
      .where('h.user_id', '=', req.user!.id)
      .where('p.user_id', '=', req.user!.id)
      .orderBy('p.title')
      .execute();
  });
  const setHidden = async (req: import('fastify').FastifyRequest, hidden: boolean) => {
    const { id } = parse(userProjectParamsSchema, req.params);
    const userId = req.user!.id;
    const own = await db.selectFrom('projects').select('id').where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
    if (!own) throw new HttpError(404, 'not_found', { key: 'hub.api.groupNotFound' });
    if (hidden)
      await db
        .insertInto('hidden_project_groups')
        .values({ user_id: userId, project_id: id })
        .onConflict(oc => oc.doNothing())
        .execute();
    else await db.deleteFrom('hidden_project_groups').where('user_id', '=', userId).where('project_id', '=', id).execute();
    sessions.projectsChanged(userId);
    return { ok: true };
  };
  app.put('/api/projects/:id/hidden', req => setHidden(req, true));
  app.delete('/api/projects/:id/hidden', req => setHidden(req, false));
  app.delete('/api/projects/:id/group', req => setHidden(req, true));
  app.get('/api/catalog/projects/:id/sessions', async (req): Promise<ProjectSessionsResponse> => {
    const userId = req.user!.id;
    const { id } = parse(userProjectParamsSchema, req.params);
    const q = parse(pageQuery, req.query);
    const project = await db.selectFrom('catalog_projects').select('id').where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
    if (!project) throw new HttpError(404, 'not_found', { key: 'hub.api.projectNotFound' });
    const ids = await db
      .selectFrom('session_projects as sp')
      .innerJoin('sessions as s', 's.id', 'sp.session_id')
      .select('s.id')
      .where('sp.user_id', '=', userId)
      .where('sp.project_id', '=', id)
      .where('s.user_id', '=', userId)
      .where(visible(q.cron))
      .where(notSpawned)
      .orderBy(recency, 'desc')
      .offset(q.offset)
      .limit(q.limit)
      .execute();
    const total = await db
      .selectFrom('session_projects as sp')
      .innerJoin('sessions as s', 's.id', 'sp.session_id')
      .select(sql<string>`count(*)`.as('n'))
      .where('sp.user_id', '=', userId)
      .where('sp.project_id', '=', id)
      .where('s.user_id', '=', userId)
      .where(visible(q.cron))
      .where(notSpawned)
      .executeTakeFirstOrThrow();
    const rows = ids.length
      ? await selectSessions(db)
          .where(
            's.id',
            'in',
            ids.map(r => r.id),
          )
          .orderBy(recency, 'desc')
          .execute()
      : [];
    return { sessions: rows.map(r => sessions.view(r)), total: Number(total.n) };
  });

  // ---------- sidebar ----------

  /** Requirements: Раздел «Сейчас»; Дерево «Проекты». */
  app.get('/api/sidebar', async (req): Promise<SidebarResponse> => {
    const userId = req.user!.id;
    const q = parse(cronFlag, req.query);
    // Requirement: Экран «Машины» — the sidebar runners carry `outdated` too (the web overlays them on /api/runners).
    const runners = await listRunnerViews(db, userId, { latestAgent: latestAgent() });
    const online = new Set(runners.filter(r => r.online).map(r => r.id));
    const nowRows = await selectSessions(db)
      .where('s.user_id', '=', userId)
      .where(visible(q.cron))
      // a spawned session shows here only when it waits for the user (permission): nobody else can answer it
      .where(eb => eb.or([sql<boolean>`s.spawned_by IS NULL`, eb('s.status', '=', 'permission')]))
      // M4a: also a session written outside the hub right now (externalActive).
      .where(eb => eb.or([eb('s.status', 'in', ['permission', 'working']), eb('s.unread', '=', true), sql<boolean>`(NOT s.process_alive AND s.external_seen_at > now() - interval '3 minutes')`]))
      .orderBy(sql`CASE WHEN s.status = 'permission' OR s.unread THEN 0 ELSE 1 END`)
      .orderBy(recency, 'desc')
      .limit(100)
      .execute();
    // «Без проекта» (single-project-classifier): the visible sessions without a catalog link, five freshest; last in the list.
    const unlinked = await db
      .selectFrom('sessions as s')
      .select([
        sql<string>`count(*)`.as('total'),
        sql<string>`count(*) FILTER (WHERE s.status IN ('working', 'waiting', 'permission', 'sleeping'))`.as('live'),
        sql<Date | null>`max(${recency})`.as('last'),
      ])
      .where('s.user_id', '=', userId)
      .where(visible(q.cron))
      .where(notSpawned)
      .where(noCatalogLink)
      .executeTakeFirstOrThrow();
    const unlinkedTop = Number(unlinked.total)
      ? await selectSessions(db).where('s.user_id', '=', userId).where(visible(q.cron)).where(notSpawned).where(noCatalogLink).orderBy(recency, 'desc').limit(5).execute()
      : [];
    const projects: SidebarResponse['projects'] = Number(unlinked.total)
      ? [
          {
            project: projectRef(sessions.projects?.catalog, null),
            live: Number(unlinked.live),
            total: Number(unlinked.total),
            lastActivityAt: unlinked.last ? new Date(unlinked.last).toISOString() : null,
            sessions: unlinkedTop.map(r => sessions.view(r)),
          },
        ]
      : [];
    // Every active catalog project is a group, an empty one too (a project created by hand shows at once, fresh ones first).
    const catalogGroups = (
      await sql<{ id: string; name: string; color_key: string; total: string; live: string; last: Date | null }>`
        SELECT cp.id, cp.name, cp.color_key, count(s.id) AS total,
          count(s.id) FILTER (WHERE s.status IN ('working', 'waiting', 'permission', 'sleeping')) AS live,
          COALESCE(max(${recency}), cp.created_at) AS last
        FROM catalog_projects cp
        LEFT JOIN session_projects sp ON sp.project_id = cp.id AND sp.user_id = cp.user_id
        LEFT JOIN sessions s ON s.id = sp.session_id AND s.user_id = cp.user_id AND ${visible(q.cron)} AND ${notSpawned}
        WHERE cp.user_id = ${userId}
        GROUP BY cp.id, cp.name, cp.color_key, cp.created_at, cp.archived
        HAVING NOT cp.archived OR count(s.id) > 0`.execute(db)
    ).rows;
    const catalogRanked = await sql<{
      project_id: string;
      id: string;
    }>`SELECT project_id,id FROM (SELECT sp.project_id,s.id,row_number() OVER (PARTITION BY sp.project_id ORDER BY ${recency} DESC) n FROM session_projects sp JOIN sessions s ON s.id=sp.session_id AND s.user_id=sp.user_id WHERE sp.user_id=${userId} AND ${visible(q.cron)} AND ${notSpawned}) x WHERE n<=5`.execute(
      db,
    );
    const catalogTop = catalogRanked.rows.length
      ? await selectSessions(db)
          .where(
            's.id',
            'in',
            catalogRanked.rows.map(r => r.id),
          )
          .orderBy(recency, 'desc')
          .execute()
      : [];
    projects.push(
      ...catalogGroups.map(g => ({
        project: { id: g.id, title: g.name, colorKey: g.color_key as ColorKey, path: '' },
        live: Number(g.live),
        total: Number(g.total),
        lastActivityAt: g.last ? new Date(g.last).toISOString() : null,
        sessions: catalogTop.filter(r => catalogRanked.rows.some(x => x.id === r.id && x.project_id === g.id)).map(r => sessions.view(r)),
      })),
    );
    projects.sort((a, b) => (a.project.id === null ? 1 : 0) - (b.project.id === null ? 1 : 0) || (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
    return {
      now: nowRows.filter(r => online.has(r.runner_id)).map(r => sessions.view(r)),
      projects,
      runners,
    };
  });

  /** «ещё N»: sessions of one project (`none` — «Без проекта»). */
  app.get('/api/projects/:id/sessions', async (req): Promise<ProjectSessionsResponse> => {
    const userId = req.user!.id;
    const { id } = req.params as { id: string };
    const q = parse(pageQuery, req.query);
    if (id !== 'none') {
      const catalogOwn = await db.selectFrom('catalog_projects').select('id').where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
      if (!catalogOwn) throw new HttpError(404, 'not_found', { key: 'hub.api.projectNotFound' });
      const ids = await db
        .selectFrom('session_projects as sp')
        .innerJoin('sessions as s', 's.id', 'sp.session_id')
        .select('s.id')
        .where('sp.user_id', '=', userId)
        .where('sp.project_id', '=', id)
        .where('s.user_id', '=', userId)
        .where(visible(q.cron))
        .where(notSpawned)
        .orderBy(recency, 'desc')
        .offset(q.offset)
        .limit(q.limit)
        .execute();
      const total = await db
        .selectFrom('session_projects as sp')
        .innerJoin('sessions as s', 's.id', 'sp.session_id')
        .select(sql<string>`count(*)`.as('n'))
        .where('sp.user_id', '=', userId)
        .where('sp.project_id', '=', id)
        .where('s.user_id', '=', userId)
        .where(visible(q.cron))
        .where(notSpawned)
        .executeTakeFirstOrThrow();
      const rows = ids.length
        ? await selectSessions(db)
            .where(
              's.id',
              'in',
              ids.map(r => r.id),
            )
            .orderBy(recency, 'desc')
            .execute()
        : [];
      return { sessions: rows.map(r => sessions.view(r)), total: Number(total.n) };
    }
    const rows = await selectSessions(db)
      .where('s.user_id', '=', userId)
      .where(visible(q.cron))
      .where(notSpawned)
      .where(noCatalogLink)
      .orderBy(recency, 'desc')
      .offset(q.offset)
      .limit(q.limit)
      .execute();
    const c = await db
      .selectFrom('sessions as s')
      .select(sql<string>`count(*)`.as('n'))
      .where('s.user_id', '=', userId)
      .where(visible(q.cron))
      .where(notSpawned)
      .where(noCatalogLink)
      .executeTakeFirstOrThrow();
    return { sessions: rows.map(r => sessions.view(r)), total: Number(c.n) };
  });

  /** «Перенести в…» (single-project-classifier): the active catalog projects, then «Без проекта». */
  app.get('/api/projects', async (req): Promise<ProjectListItem[]> => {
    const curated = await db.selectFrom('catalog_projects').select(['id', 'name', 'color_key']).where('user_id', '=', req.user!.id).where('archived', '=', false).orderBy('name').execute();
    return [
      ...curated.map((p): ProjectListItem => ({ id: p.id, kind: 'project', title: p.name, path: '', areaPath: null, colorKey: p.color_key as ColorKey, archived: false })),
      { id: 'none', kind: 'none', title: render({ key: 'hub.api.noProject' }, 'en'), i18n: { key: 'hub.api.noProject' }, path: '', areaPath: null, colorKey: 'none', archived: false },
    ];
  });

  /** Move (D10): a catalog project — a manual link; «Без проекта» — the pin without a project, toast `project_pinned`. */
  app.put('/api/sessions/:id/project', async (req): Promise<SessionView> => {
    const userId = req.user!.id;
    const { id } = req.params as { id: string };
    const b = parse(setProjectRequestSchema, req.body);
    const s = await sessions.get(userId, id);
    const projectId = b.projectId === 'none' ? null : b.projectId;
    const catalogProject = projectId
      ? await db.selectFrom('catalog_projects').select('id').where('user_id', '=', userId).where('id', '=', projectId).where('archived', '=', false).executeTakeFirst()
      : null;
    if (catalogProject) {
      await linkSessionToProject(db, userId, s.id, catalogProject.id);
      return sessions.upsert(s.id);
    }
    // A legacy path-group id is not a project any more (single-project-classifier).
    if (projectId) throw new HttpError(422, 'unknown_project', { key: 'hub.api.unknownProject' });
    return pinNoProject(userId, s.id);
  });

  /** «Закрепить» the current project (also «Без проекта»). */
  app.post('/api/sessions/:id/pin', async (req): Promise<SessionView> => {
    const userId = req.user!.id;
    const s = await sessions.get(userId, (req.params as { id: string }).id);
    const catalog = await db.selectFrom('session_projects').select('project_id').where('user_id', '=', userId).where('session_id', '=', s.id).executeTakeFirst();
    if (catalog) {
      await db.updateTable('session_projects').set({ source: 'manual', reason_code: 'selected' }).where('user_id', '=', userId).where('session_id', '=', s.id).execute();
      return sessions.upsert(s.id);
    }
    return pinNoProject(userId, s.id);
  });

  /** «Открепить»: the catalog detection decides again, the label is removed. */
  app.delete('/api/sessions/:id/pin', async (req): Promise<SessionView> => {
    const userId = req.user!.id;
    const s = await sessions.get(userId, (req.params as { id: string }).id);
    const catalog = await db.selectFrom('session_projects').select('source').where('user_id', '=', userId).where('session_id', '=', s.id).executeTakeFirst();
    if (catalog) {
      await db.updateTable('session_projects').set({ source: 'auto', reason_code: 'unpinned' }).where('user_id', '=', userId).where('session_id', '=', s.id).execute();
      return sessions.upsert(s.id);
    }
    if (s.project_source !== 'manual') throw new HttpError(409, 'not_pinned', { key: 'hub.api.notPinned' });
    if (sessions.projects) await sessions.projects.unpin(s.id);
    return sessions.upsert(s.id);
  });

  /** «Без проекта» pinned: the catalog link removed, the detection does not touch the session (`project_source = manual`). */
  async function pinNoProject(userId: string, sessionId: string): Promise<SessionView> {
    const write = () =>
      db.transaction().execute(async tx => {
        await tx.selectFrom('sessions').select('id').where('id', '=', sessionId).where('user_id', '=', userId).forUpdate().executeTakeFirst();
        await tx.deleteFrom('session_projects').where('user_id', '=', userId).where('session_id', '=', sessionId).execute();
        await tx
          .updateTable('sessions')
          .set({ project_id: null, project_source: 'manual', secondary_project_id: null, project_evidence: null })
          .where('id', '=', sessionId)
          .where('user_id', '=', userId)
          .execute();
        await tx
          .insertInto('classification_labels')
          .values({ session_id: sessionId, project_id: null, user_id: userId })
          .onConflict(oc => oc.column('session_id').doUpdateSet({ project_id: null, created_at: sql`now()` }))
          .execute();
      });
    // In the queue of the session's project decisions (a recompute running now does not overwrite the pin).
    await (sessions.projects ? sessions.projects.serialized(sessionId, write) : write());
    const v = await sessions.upsert(sessionId);
    sessions.toast(userId, { type: 'toast', kind: 'project_pinned', sessionId, title: v.title, ...tx('hub.api.toastPinned', { title: v.project.title }) });
    return v;
  }

  /** agent-providers: ?provider=codex: the models of that provider; absent: Claude, as before. */
  app.get('/api/models', async req => {
    const q = parse(modelsQuerySchema, req.query);
    return sessions.listModels(req.user!.id, q.provider ?? 'claude');
  });

  // ---------- providers of a machine (agent-providers D10) ----------

  app.post('/api/runners/:id/providers/:provider/login', async req => {
    const { id, provider } = parse(providerParamsSchema, req.params);
    return sessions.providerLoginStart(req.user!.id, id, provider);
  });

  app.delete('/api/runners/:id/providers/:provider/login/:loginId', async (req, reply) => {
    const { id, provider, loginId } = parse(providerParamsSchema.extend({ loginId: z.string().min(1).max(200) }), req.params);
    await sessions.providerLoginCancel(req.user!.id, id, provider, loginId);
    return reply.code(204).send();
  });

  app.post('/api/runners/:id/providers/:provider/logout', async (req, reply) => {
    const { id, provider } = parse(providerParamsSchema, req.params);
    await sessions.providerLogout(req.user!.id, id, provider);
    return reply.code(204).send();
  });

  /** Ctrl+K. Requirement: Быстрый поиск Ctrl+K */
  app.get('/api/search', async (req): Promise<SearchResponse> => {
    const q = parse(searchQuerySchema, req.query);
    const hits = await searchSessions(db, { userId: req.user!.id, q: q.q, limit: q.limit, cron: q.cron === '1' });
    return { results: hits.map(h => ({ session: sessions.view(h.row), snippet: h.snippet, match: h.match })) };
  });

  // ---------- sessions ----------

  app.get('/api/runners/:id/stat', async req => {
    // Only absolute local paths reach the agent: a UNC path would leak the user's NTLM hash (this GET has no
    // Origin check, a cross-site link can trigger it).
    const { path } = parse(statQuerySchema, req.query);
    return sessions.stat(req.user!.id, (req.params as { id: string }).id, path);
  });

  app.post('/api/sessions', async (req, reply) => {
    const b = parse(createSessionRequestSchema, req.body);
    const userId = req.user!.id;
    // session-folder D3: the hub resolves the folder from the machine's default folder and the project's folder
    const session = await sessions.create(userId, { ...b, ...(b.projectId ? { catalogProjectId: b.projectId } : {}) });
    try {
      await db
        .insertInto('user_preferences')
        .values({ user_id: userId, last_runner_id: b.runnerId, last_provider: b.provider ?? 'claude' })
        .onConflict(oc => oc.column('user_id').doUpdateSet({ last_runner_id: b.runnerId, last_provider: b.provider ?? 'claude' }))
        .execute();
    } catch (err) {
      req.log.warn({ err, userId, runnerId: b.runnerId }, 'launch preferences could not be stored');
    }
    return reply.code(201).send(session);
  });

  /** Change session-links (D4): which UUIDs of the feed are sessions of the user. */
  app.post('/api/sessions/resolve', async (req): Promise<{ sessions: SessionRefView[] }> => {
    const b = parse(resolveSessionRefsSchema, req.body);
    return { sessions: await resolveSessionRefs(db, req.user!.id, b.ids) };
  });

  app.get('/api/sessions/:id', async req => sessions.view(await sessions.get(req.user!.id, (req.params as { id: string }).id)));

  // ---------- fork (D14, M4b) ----------

  /** Full copy or handoff. Requirement (session-fork): Полная копия; Handoff */
  app.post('/api/sessions/:id/fork', async (req, reply) => {
    const userId = req.user!.id;
    const { id } = req.params as { id: string };
    const b = parse(forkRequestSchema, req.body);
    const v = b.mode === 'copy' ? await sessions.forkCopy(userId, id) : await sessions.forkHandoff(userId, id, b);
    return reply.code(201).send(v);
  });

  /** A handoff draft: 202 pending, WS handoff.draft when ready. */
  app.post('/api/sessions/:id/handoff-drafts', async (req, reply) => {
    const b = parse(handoffDraftRequestSchema, req.body);
    const draft = await handoff.create(req.user!.id, (req.params as { id: string }).id, b);
    return reply.code(202).send(draft);
  });

  app.get('/api/handoff-drafts/:id', async req => handoff.get(req.user!.id, (req.params as { id: string }).id));

  app.get('/api/sessions/:id/events', async (req): Promise<EventsPage> => {
    const s = await sessions.get(req.user!.id, (req.params as { id: string }).id);
    const q = parse(eventsQuery, req.query);
    return eventsPage(db, s.id, q.before, q.limit);
  });

  // ---------- subagents (change `subagents`, design S7) ----------

  /** The registry of a session by started_at. Requirement (subagents): Список субагентов и счётчик */
  app.get('/api/sessions/:id/subagents', async (req): Promise<SubagentsResponse> => {
    const s = await sessions.get(req.user!.id, (req.params as { id: string }).id);
    return { subagents: await listSubagents(db, s.id), background: await listBackground(db, s.id), hubSessions: await listHubChildren(db, req.user!.id, s.id) };
  });

  app.get('/api/subagents/:id', async (req): Promise<SubagentView> => {
    const v = await getSubagent(db, req.user!.id, (req.params as { id: string }).id);
    if (!v) throw new HttpError(404, 'not_found', { key: 'hub.api.subagentNotFound' });
    return v;
  });

  /** The transcript of a subagent, page by page from the end. Requirement (subagents): Чат субагента только для чтения */
  app.get('/api/subagents/:id/events', async (req): Promise<EventsPage> => {
    const run = await runFile(db, req.user!.id, (req.params as { id: string }).id);
    if (!run) throw new HttpError(404, 'not_found', { key: 'hub.api.subagentNotFound' });
    const q = parse(eventsQuery, req.query);
    return subagentEventsPage(db, run, q.before, q.limit);
  });

  app.post('/api/sessions/:id/messages', async (req, reply) => {
    const b = parse(sendMessageRequestSchema, req.body);
    return reply.code(202).send({ session: await sessions.sendMessage(req.user!.id, (req.params as { id: string }).id, b) });
  });

  app.post('/api/sessions/:id/wake', async (req, reply) => {
    const b = parse(wakeRequestSchema, req.body);
    return reply.code(202).send({ session: await sessions.wake(req.user!.id, (req.params as { id: string }).id, b.force === true) });
  });

  app.post('/api/sessions/:id/interrupt', async (req, reply) => {
    return reply.code(202).send({ session: await sessions.interrupt(req.user!.id, (req.params as { id: string }).id) });
  });

  /** Stop the process and resume at once with the same settings. Requirement: Перезапуск сессии из меню. */
  app.post('/api/sessions/:id/restart', async (req, reply) => {
    const b = parse(restartSessionRequestSchema, req.body ?? {});
    return reply.code(202).send({ session: await sessions.restart(req.user!.id, (req.params as { id: string }).id, b) });
  });

  app.patch('/api/sessions/:id', async req => {
    const b = parse(patchSessionRequestSchema, req.body);
    return sessions.patch(req.user!.id, (req.params as { id: string }).id, b);
  });

  /** A new title from the whole session; written like a manual rename. Requirement (session-title): Перегенерация названия */
  app.post('/api/sessions/:id/title/regenerate', async req => {
    const userId = req.user!.id;
    const s = await sessions.get(userId, (req.params as { id: string }).id);
    const title = await handoff.suggestTitle(userId, s);
    return sessions.patch(userId, s.id, { title });
  });

  app.post('/api/sessions/:id/permissions/:requestId', async req => {
    const { id, requestId } = req.params as { id: string; requestId: string };
    const b = parse(permissionDecisionRequestSchema, req.body);
    const r = await sessions.resolvePermission(req.user!.id, id, requestId, b.decision, { answers: b.answers, message: b.message });
    return { request: r.request.kind === 'permission' ? r.request.request : null };
  });

  // ---------- layout template (M2.1, D10 «Раскладка»; Requirement: Раскладка нового окна и перезагрузка) ----------
  // The workspace belongs to the window (D11). The hub keeps the last changed workspace of each device class as the
  // template of a new window: last write wins, nothing is broadcast, /api/tabs is gone.

  app.get('/api/layout', async (req): Promise<LayoutResponse> => {
    const { device } = parse(deviceQuery, req.query);
    const row = await db.selectFrom('ui_layouts').selectAll().where('user_id', '=', req.user!.id).where('device_class', '=', device).executeTakeFirst();
    return {
      layout: row?.layout ?? null,
      savedLayout: row?.saved_layout ?? null,
      openedAt: (row?.opened_at as Record<string, string> | null | undefined) ?? null,
      tabKinds: (row?.tab_kinds as Record<string, string> | null | undefined) ?? null,
      updatedAt: row ? row.updated_at.toISOString() : null,
    };
  });

  app.put('/api/layout', { bodyLimit: LAYOUT_BODY_LIMIT }, async (req): Promise<PutLayoutResponse> => {
    const userId = req.user!.id;
    const b = parse(putLayoutRequestSchema, req.body);
    const values = {
      layout: b.layout === null ? null : JSON.stringify(b.layout),
      saved_layout: b.savedLayout === null ? null : JSON.stringify(b.savedLayout),
      opened_at: b.openedAt ? JSON.stringify(b.openedAt) : null,
      tab_kinds: b.tabKinds ? JSON.stringify(b.tabKinds) : null,
      client_ts: b.clientTs ?? null,
      updated_at: new Date(),
    };
    // A snapshot of an older change (by the window's clock) does not overwrite a newer one: a keepalive PUT sent on
    // pagehide may arrive after a later change of another window. Without clientTs on either side the last write wins.
    const row = await db
      .insertInto('ui_layouts')
      .values({ user_id: userId, device_class: b.device, ...values })
      .onConflict(oc =>
        oc
          .columns(['user_id', 'device_class'])
          .doUpdateSet(values)
          .where(eb => eb.or([eb('ui_layouts.client_ts', 'is', null), eb('excluded.client_ts', 'is', null), eb('ui_layouts.client_ts', '<=', eb.ref('excluded.client_ts'))])),
      )
      .returning('updated_at')
      .executeTakeFirst();
    if (row) return { updatedAt: row.updated_at.toISOString(), applied: true };
    const kept = await db.selectFrom('ui_layouts').select('updated_at').where('user_id', '=', userId).where('device_class', '=', b.device).executeTakeFirstOrThrow();
    return { updatedAt: kept.updated_at.toISOString(), applied: false };
  });
}
