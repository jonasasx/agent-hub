// Sessions, chat items and their views (design.md D6, D10).
import { sql, type Selectable } from 'kysely';
import type {
  ColorKey,
  HubEvent,
  I18nText,
  PermissionView,
  ProjectKind,
  ProjectRef,
  SessionView,
  SubscriptionMode,
  SubscriptionNote,
  UiPermissionMode,
  PermissionKind,
  ProjectSuggestionView,
  QuestionView,
} from '@agent-hub/shared';
import { supportsSubscriptions } from '../subscriptions/repo.js';
import { render } from '../i18n.js';
import { tx } from '../texts.js';
import { evidenceI18nOf, evidenceOf } from '../projects/service.js';
import type { Db, PermissionRequestsTable, SessionsTable } from '../db/db.js';
import { effectiveIdleTimeoutMin, sleepsAt, type SleepInput } from './status.js';
import { sideFileRefs } from '../replication/sideLinks.js';
import { bgExpired } from '../subagents/background.js';

export type SessionRow = Selectable<SessionsTable> & {
  permission_since: Date | null;
  /** Latest event of the session's subagents and background commands (selectSessions). */
  children_activity_at?: Date | null;
  /** Subagents «running» and background commands running since the process last went to sleep (selectSessions). */
  children_working?: string | number | null;
  /** Change `background-tasks`: started monitors and background commands of the session (selectSessions). */
  background_total?: string | number | null;
  fork_title: string | null;
  /** hub-subagents D7: the title of spawned_by and the child hub sessions (all; alive in working/permission). */
  spawned_by_title?: string | null;
  hub_children_total?: string | number | null;
  hub_children_working?: string | number | null;
  /** Change `subagents`: registry rows of the session and the running/idle ones among them. */
  subagents_total?: string | number | null;
  subagents_running?: string | number | null;
  /** The tool of the oldest open permission request (S10.3). */
  pending_tool?: string | null;
  /** claude-subscriptions: the name of sessions.subscription_id, the user's active subscriptions, the agent's protocol. */
  subscription_name?: string | null;
  active_subscriptions?: string | number | null;
  runner_protocol?: string | null;
  catalog_project_color?: ColorKey | null;
  hidden_project?: boolean;
  catalog_project_id?: string | null;
  catalog_project_name?: string | null;
  catalog_project_source?: 'explicit' | 'auto' | 'manual' | null;
  catalog_project_reason?: string | null;
  project_suggestion?: ProjectSuggestionView | null;
};

/**
 * SessionView.subscriptionMode (claude-subscriptions P8): `none` — no active subscription (or no key: everything runs
 * under the machine login as before); `agent_outdated` — the agent is older than 1.4; `machine_login` — the live process
 * runs under the machine login; `subscription` — the process (or the next one, resume) runs under a subscription.
 */
export function subscriptionModeOf(r: SessionRow, enabled: boolean): SubscriptionMode {
  if (!enabled || Number(r.active_subscriptions ?? 0) === 0) return 'none';
  if (!supportsSubscriptions(r.runner_protocol)) return 'agent_outdated';
  if (r.process_alive && !r.subscription_id) return 'machine_login';
  return 'subscription';
}

export interface TimeoutDefaults {
  idle: number;
  permission: number;
}

/** «Без проекта» (D9): project_id NULL, not a row of the catalogue. */
export const NO_PROJECT: ProjectRef = { id: null, title: 'No project', colorKey: 'none', path: '', i18n: { key: 'hub.api.noProject' } };

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** What a view needs from the catalogue (projects/catalogService.ts). */
export interface ProjectLookup {
  row(id: string | null): { id: string; kind: ProjectKind; path: string; title: string; colorKey: ColorKey; archived: boolean; slug: string } | null;
}

export function projectRef(lookup: ProjectLookup | undefined, id: string | null): ProjectRef {
  const p = lookup?.row(id);
  if (!p) return NO_PROJECT;
  const path = p.kind === 'builtin' && p.slug === 'vault' ? '00-meta · 40-automation · .claude' : p.path;
  return { id: p.id, title: p.title, colorKey: p.colorKey, path, kind: p.kind, ...(p.archived ? { archived: true } : {}) };
}

/** Same window as replication's EXTERNAL_ACTIVE_MS (3 min). */
const EXTERNAL_WINDOW_MS = 3 * 60_000;

export function isExternalActive(r: Pick<SessionRow, 'process_alive' | 'external_seen_at'>, now: number): boolean {
  return !r.process_alive && !!r.external_seen_at && now - r.external_seen_at.getTime() < EXTERNAL_WINDOW_MS;
}

/** Input of the sleep rule for a session row: the same for the scheduler and the UI countdown. */
export function sleepInputOf(r: SessionRow): SleepInput {
  const activity = Math.max(r.last_event_at?.getTime() ?? 0, r.children_activity_at ? new Date(r.children_activity_at).getTime() : 0);
  return {
    status: r.status,
    processAlive: r.process_alive,
    idleTimeoutMin: r.idle_timeout_min,
    lastTurnEndAt: r.last_turn_end_at,
    lastInputAt: r.last_input_at,
    permissionSince: r.permission_since,
    lastActivityAt: activity ? new Date(activity) : null,
    workingChildren: Number(r.children_working ?? 0),
  };
}

/** When the session falls asleep (status.ts sleepsAt over sleepInputOf). */
export function sessionSleepsAt(r: SessionRow, defaults: TimeoutDefaults): Date | null {
  return sleepsAt(sleepInputOf(r), defaults);
}

export function toSessionView(r: SessionRow, defaults: TimeoutDefaults, projects?: ProjectLookup, now: number = Date.now(), subscriptionsEnabled = false): SessionView {
  const external = isExternalActive(r, now);
  const sleeps = sessionSleepsAt(r, defaults);
  const catalogProject = r.catalog_project_id && r.catalog_project_name ? { id: r.catalog_project_id, name: r.catalog_project_name } : null;
  return {
    id: r.id,
    title: r.title,
    provider: r.provider,
    runnerId: r.runner_id,
    cwd: r.cwd,
    status: r.status,
    unread: r.unread,
    processAlive: r.process_alive,
    source: r.source,
    isHubManaged: r.is_hub_managed,
    isCron: r.source === 'cron',
    originSource: r.origin_source ?? r.source,
    remoteControl: r.remote_control,
    isDriveImport: r.is_drive_import,
    readOnlyReason: r.read_only_reason,
    project: catalogProject
      ? { id: catalogProject.id, title: catalogProject.name, colorKey: r.catalog_project_color ?? 'none', path: '' }
      : projectRef(projects, r.hidden_project ? null : r.project_id),
    ...(catalogProject ? { catalogProject, catalogProjectSource: r.catalog_project_source, catalogProjectReason: r.catalog_project_reason } : {}),
    ...(r.project_suggestion ? { projectSuggestion: r.project_suggestion } : {}),
    projectSource: r.project_source,
    projectEvidence: evidenceOf(r.project_source, r.project_evidence),
    ...(evidenceI18nOf(r.project_source, r.project_evidence) ? { projectEvidenceI18n: evidenceI18nOf(r.project_source, r.project_evidence)! } : {}),
    secondaryProject: r.secondary_project_id ? projectRef(projects, r.secondary_project_id) : null,
    forkOf: r.fork_of ? { id: r.fork_of, title: r.fork_title ?? '' } : null,
    spawnedBy: r.spawned_by ? { id: r.spawned_by, title: r.spawned_by_title ?? '' } : null,
    permissionMode: r.permission_mode as UiPermissionMode,
    model: r.model,
    idleTimeoutMin: r.idle_timeout_min,
    effectiveIdleTimeoutMin: r.status === 'working' ? (r.idle_timeout_min ?? defaults.idle) : effectiveIdleTimeoutMin(r.status, r.idle_timeout_min, defaults),
    sleepsAt: iso(sleeps),
    lastInputAt: iso(r.last_input_at),
    lastTurnEndAt: iso(r.last_turn_end_at),
    sleptAt: iso(r.slept_at),
    lastEventAt: iso(r.last_event_at),
    lastExternalWriteAt: iso(r.last_external_write_at),
    externalActive: external,
    externalSince: external ? iso(r.external_since ?? r.external_seen_at) : null,
    // the running ones count only while the session is alive (S3: else they are «прерван»)
    subagents: {
      total: Number(r.subagents_total ?? 0),
      running: r.process_alive || external ? Number(r.subagents_running ?? 0) : 0,
      // the same count as the sleep rule (sleepInputOf): working children of the live process
      working: r.process_alive || external ? Number(r.children_working ?? 0) : 0,
      background: Number(r.background_total ?? 0),
      // hub-subagents D7: not in the sleep rule — the report of a child resumes the parent
      hub: { total: Number(r.hub_children_total ?? 0), working: Number(r.hub_children_working ?? 0) },
    },
    pendingPermission: r.pending_tool ? { toolName: r.pending_tool } : null,
    subscription: r.subscription_id ? { id: r.subscription_id, name: r.subscription_name ?? '' } : null,
    subscriptionMode: subscriptionModeOf(r, subscriptionsEnabled),
    // mcp-management M8: failed + needs-auth of the last MCP snapshot (the mark in the head and the sidebar)
    mcpProblems: r.mcp_problems ?? 0,
    createdAt: r.created_at.toISOString(),
  };
}

/** Start of the session's current process (see children_working): 60 s earlier for clock skew; unknown — the last sleep. */
const processStart = sql`(COALESCE(CASE WHEN s.process_alive THEN s.process_started_at ELSE s.external_since END, s.slept_at, '-infinity'::timestamptz) - interval '60 seconds')`;

/**
 * A child hub session (hub-subagents) that works: live process in a turn or at a permission request, with an event
 * within the stall guard (120 min: a child silent for longer does not hold the parent). It counts as a working child
 * of its parent — the parent shows «работает в фоне» and does not fall asleep (D7: was outside the sleep rule).
 */
const hubChildAlive = sql`(c.process_alive AND c.status IN ('working', 'permission') AND COALESCE(c.last_event_at, c.created_at) >= now() - interval '120 minutes')`;

/** Base select of session rows with the computed columns of SessionRow. */
export function selectSessions(db: Db) {
  return db
    .selectFrom('sessions as s')
    .selectAll('s')
    .select([
      sql<Date | null>`(SELECT min(p.created_at) FROM permission_requests p WHERE p.session_id = s.id AND p.resolved_at IS NULL)`.as('permission_since'),
      sql<string | null>`(SELECT f.title FROM sessions f WHERE f.id = s.fork_of)`.as('fork_title'),
      sql<string | null>`(SELECT f.title FROM sessions f WHERE f.id = s.spawned_by)`.as('spawned_by_title'),
      sql<string>`(SELECT count(*) FROM sessions c WHERE c.spawned_by = s.id)`.as('hub_children_total'),
      sql<string>`(SELECT count(*) FROM sessions c WHERE c.spawned_by = s.id AND ${hubChildAlive})`.as('hub_children_working'),
      // change `subagents` (design S7): two counts by the index (session_id, started_at)
      sql<string>`(SELECT count(*) FROM subagent_runs r WHERE r.session_id = s.id)`.as('subagents_total'),
      sql<string>`(SELECT count(*) FROM subagent_runs r WHERE r.session_id = s.id AND r.state = 'running')`.as('subagents_running'),
      // sleep (fix «засыпание убивает субагентов»): activity and work of the session's children. Children whose last
      // event is before the start of the current process (hub process: process_started_at; a session working outside
      // the hub: external_since) belong to a process that is gone and do not work. 60 s of margin: their times are the
      // runner's clock, the start is the hub's.
      sql<Date | null>`GREATEST(
        (SELECT max(COALESCE(r.last_event_at, r.state_at, r.started_at)) FROM subagent_runs r WHERE r.session_id = s.id),
        (SELECT max(GREATEST(b.started_at, b.ended_at, b.last_event_at)) FROM background_tasks b WHERE b.session_id = s.id AND b.state != 'pending'),
        (SELECT max(c.last_event_at) FROM sessions c WHERE c.spawned_by = s.id AND ${hubChildAlive}))`.as('children_activity_at'),
      sql<string>`(
        (SELECT count(*) FROM subagent_runs r WHERE r.session_id = s.id AND r.state = 'running'
           AND COALESCE(r.last_event_at, r.state_at, r.started_at, '-infinity') >= ${processStart})
        + (SELECT count(*) FROM background_tasks b WHERE b.session_id = s.id AND b.state = 'running' AND NOT ${bgExpired('b')}
           AND COALESCE(b.started_at, '-infinity') >= ${processStart})
        + (SELECT count(*) FROM sessions c WHERE c.spawned_by = s.id AND ${hubChildAlive}))`.as('children_working'),
      // change `background-tasks`: monitors and background commands shown in the list (started ones)
      sql<string>`(SELECT count(*) FROM background_tasks b WHERE b.session_id = s.id AND b.state != 'pending')`.as('background_total'),
      sql<boolean>`EXISTS (SELECT 1 FROM hidden_project_groups h WHERE h.user_id=s.user_id AND h.project_id=s.project_id)`.as('hidden_project'),
      sql<ColorKey | null>`(SELECT cp.color_key FROM session_projects sp JOIN catalog_projects cp ON cp.id=sp.project_id AND cp.user_id=sp.user_id WHERE sp.session_id=s.id AND sp.user_id=s.user_id)`.as(
        'catalog_project_color',
      ),
      sql<string | null>`(SELECT p.tool_name FROM permission_requests p WHERE p.session_id = s.id AND p.resolved_at IS NULL ORDER BY p.created_at LIMIT 1)`.as('pending_tool'),
      // claude-subscriptions (P8): the head of the tab
      sql<string | null>`(SELECT sub.name FROM subscriptions sub WHERE sub.id = s.subscription_id)`.as('subscription_name'),
      sql<string>`(SELECT count(*) FROM subscriptions sub WHERE sub.user_id = s.user_id AND sub.retired_at IS NULL)`.as('active_subscriptions'),
      sql<string | null>`(SELECT r.protocol_version FROM runners r WHERE r.id = s.runner_id)`.as('runner_protocol'),
      sql<'explicit' | 'auto' | 'manual' | null>`(SELECT sp.source FROM session_projects sp WHERE sp.session_id=s.id AND sp.user_id=s.user_id)`.as('catalog_project_source'),
      sql<string | null>`(SELECT sp.reason_code FROM session_projects sp WHERE sp.session_id=s.id AND sp.user_id=s.user_id)`.as('catalog_project_reason'),
      // the card: options in the classifier's order, only active projects of the owner; nothing to offer — no card
      sql<ProjectSuggestionView | null>`(SELECT json_build_object(
          'inputHash', ps.input_hash,
          'newProjectName', ps.new_project_name,
          'options', COALESCE((SELECT json_agg(json_build_object('projectId', p.id, 'name', p.name, 'colorKey', p.color_key) ORDER BY o.n)
            FROM unnest(ps.options) WITH ORDINALITY o(id, n) JOIN catalog_projects p ON p.id = o.id AND p.user_id = ps.user_id AND NOT p.archived), '[]'::json))
        FROM project_suggestions ps
        WHERE ps.user_id = s.user_id AND ps.session_id = s.id AND ps.state = 'pending' AND s.project_source <> 'manual'
          AND NOT EXISTS (SELECT 1 FROM session_projects sp WHERE sp.session_id = s.id AND sp.user_id = s.user_id))`.as('project_suggestion'),
      sql<
        string | null
      >`(SELECT cp.id FROM session_projects sp JOIN catalog_projects cp ON cp.id = sp.project_id AND cp.user_id = sp.user_id WHERE sp.session_id = s.id AND sp.user_id = s.user_id)`.as(
        'catalog_project_id',
      ),
      sql<
        string | null
      >`(SELECT cp.name FROM session_projects sp JOIN catalog_projects cp ON cp.id = sp.project_id AND cp.user_id = sp.user_id WHERE sp.session_id = s.id AND sp.user_id = s.user_id)`.as(
        'catalog_project_name',
      ),
    ]);
}

export async function getSession(db: Db, id: string, userId?: string): Promise<SessionRow | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  let q = selectSessions(db).where('s.id', '=', id);
  if (userId) q = q.where('s.user_id', '=', userId);
  return q.executeTakeFirst();
}

/** The stored columns of a session, without the computed ones of selectSessions (no correlated subqueries). */
export type SessionBase = Selectable<SessionsTable>;

/**
 * The hot path of the agent's stream (session.partial, chunks, states): one indexed row by (runner, Claude session),
 * none of the ~10 subqueries of SessionView. The full row (selectSessions) is read only to build a SessionView.
 */
export async function findSessionByClaudeId(db: Db, runnerId: string, claudeSessionId: string): Promise<SessionBase | undefined> {
  return db.selectFrom('sessions').selectAll().where('runner_id', '=', runnerId).where('claude_session_id', '=', claudeSessionId).executeTakeFirst();
}

export async function findByClaudeId(db: Db, runnerId: string, claudeSessionId: string): Promise<SessionRow | undefined> {
  return selectSessions(db).where('s.runner_id', '=', runnerId).where('s.claude_session_id', '=', claudeSessionId).executeTakeFirst();
}

/** M4b: what the card asks, by the tool (older agents do not send the kind). */
export function permissionKind(toolName: string): PermissionKind {
  if (toolName === 'AskUserQuestion') return 'question';
  if (toolName === 'ExitPlanMode') return 'plan';
  return 'tool';
}

/** The questions of AskUserQuestion input, only the fields the card shows; malformed entries dropped. */
export function questionsOf(input: unknown): QuestionView[] {
  const qs = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(qs)) return [];
  return qs.flatMap((q: Record<string, unknown>) => {
    if (!q || typeof q.question !== 'string' || !Array.isArray(q.options)) return [];
    const options = (q.options as Array<Record<string, unknown>>)
      .filter(o => o && typeof o.label === 'string')
      .map(o => ({ label: String(o.label), description: typeof o.description === 'string' ? o.description : '', ...(typeof o.preview === 'string' ? { preview: o.preview } : {}) }));
    return [{ question: q.question, header: typeof q.header === 'string' ? q.header : '', options, multiSelect: q.multiSelect === true }];
  });
}

export function toPermissionView(p: Selectable<PermissionRequestsTable>): PermissionView {
  const input = (p.input ?? {}) as Record<string, unknown>;
  const kind = permissionKind(p.tool_name);
  return {
    requestId: p.request_id,
    sessionId: p.session_id,
    toolName: p.tool_name,
    toolUseId: p.tool_use_id,
    input,
    createdAt: p.created_at.toISOString(),
    resolvedAt: iso(p.resolved_at),
    decision: p.decision,
    message: p.message,
    kind,
    ...(kind === 'question' ? { questions: questionsOf(input), answers: (p.answers as Record<string, string> | null) ?? null } : {}),
    ...(kind === 'plan' ? { plan: typeof input.plan === 'string' ? input.plan : '' } : {}),
  };
}

export function permissionEvent(p: Selectable<PermissionRequestsTable>): HubEvent {
  return { kind: 'permission', id: `p:${p.request_id}`, ts: p.created_at.toISOString(), request: toPermissionView(p) };
}

/**
 * A note of the chat. Change i18n D6: a keyed text is stored as `{display, i18n}` (display — English, for older clients and logs),
 * the client renders `i18n` in its language. A plain string with `i18n` does the same; a plain string alone is stored as it is
 * (JSON kinds — image, undelivered, subscription_* — carry `i18n` inside their own JSON).
 */
export async function addNote(db: Db, sessionId: string, kind: string, text: string | I18nText, i18n?: I18nText): Promise<HubEvent> {
  const key = typeof text === 'string' ? i18n : text;
  const display = typeof text === 'string' ? text : render(text, 'en');
  const stored = key ? JSON.stringify({ display, i18n: key }) : display;
  const n = await db.insertInto('session_notes').values({ session_id: sessionId, kind, text: stored }).returning(['id', 'ts']).executeTakeFirstOrThrow();
  return noteEvent(`n:${n.id}`, n.ts.toISOString(), kind, stored);
}

/** `{display, i18n}` of a keyed note; null for a plain text. */
function keyedNote(text: string): { display: string; i18n: I18nText } | null {
  if (!text.startsWith('{')) return null;
  try {
    const u = JSON.parse(text) as { display?: unknown; i18n?: { key?: unknown } };
    return typeof u.display === 'string' && typeof u.i18n?.key === 'string' ? { display: u.display, i18n: u.i18n as I18nText } : null;
  } catch {
    return null;
  }
}

/** A stored note as a chat item; `kind = image` keeps {path, sha256, mime, size, width, height} as JSON (D19). */
export function noteEvent(id: string, ts: string, kind: string, text: string): HubEvent {
  if (kind === 'image') {
    try {
      const i = JSON.parse(text) as { path: string; sha256: string; mime: string; size: number; width?: number; height?: number };
      const blob = { $blob: i.sha256, size: i.size, mime: i.mime, ...(i.width ? { width: i.width } : {}), ...(i.height ? { height: i.height } : {}) };
      return { kind: 'note', id, ts, ...tx('hub.note.image', { path: i.path }), image: { path: i.path, blob } };
    } catch {
      // fall through: shown as text
    }
  }
  // claude-subscriptions (P6): a limit, a rejected token, a switch — `display` stays the text for older clients
  if ((kind === 'subscription_limit' || kind === 'subscription_auth' || kind === 'subscription_switch') && text.startsWith('{')) {
    try {
      const u = JSON.parse(text) as { display: string; subscription: SubscriptionNote; i18n?: I18nText };
      return { kind: 'note', id, ts, text: u.display, ...(u.i18n ? { i18n: u.i18n } : {}), subscription: u.subscription };
    } catch {
      // fall through: shown as text
    }
  }
  if (kind === 'undelivered' && text.startsWith('{')) {
    try {
      const u = JSON.parse(text) as { display: string; undelivered: NonNullable<Extract<HubEvent, { kind: 'note' }>['undelivered']>; i18n?: I18nText };
      return { kind: 'note', id, ts, text: u.display, ...(u.i18n ? { i18n: u.i18n } : {}), undelivered: u.undelivered };
    } catch {
      // fall through: shown as text
    }
  }
  const keyed = keyedNote(text);
  if (keyed) return { kind: 'note', id, ts, text: keyed.display, i18n: keyed.i18n };
  return { kind: 'note', id, ts, text };
}

/** Cursor of the chat history: position (ts, kind order, seq) of the oldest returned item. */
interface Cursor {
  t: string;
  k: number;
  s: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

export function decodeCursor(v: string | undefined): Cursor | null {
  if (!v) return null;
  try {
    const c = JSON.parse(Buffer.from(v, 'base64url').toString('utf8')) as Cursor;
    if (typeof c.t !== 'string' || typeof c.k !== 'number' || typeof c.s !== 'string' || Number.isNaN(Date.parse(c.t)) || !/^\d+$/.test(c.s)) return null;
    return c;
  } catch {
    return null;
  }
}

interface HistoryRow {
  kind: 'line' | 'note' | 'permission';
  ts: Date;
  k: number;
  seq: string;
  id: string;
  data: unknown;
}

/**
 * Chat history of a session, newest page first, items oldest-first inside the page: transcript lines,
 * hub notes and permission requests merged by time. Requirement: Обмен сообщениями.
 */
export async function eventsPage(db: Db, sessionId: string, before: string | undefined, limit: number): Promise<{ events: HubEvent[]; before: string | null }> {
  const c = decodeCursor(before);
  const cursorCond = c ? sql`WHERE (x.ts, x.k, x.seq) < (${c.t}::timestamptz, ${c.k}::int, ${c.s}::bigint)` : sql``;
  const rows = await sql<HistoryRow>`
    SELECT * FROM (
      SELECT 'line' AS kind, e.ts, 0 AS k, e.line_no AS seq,
             'l:' || e.file_id || ':' || e.generation || ':' || e.line_no AS id, e.payload AS data
        FROM events e JOIN transcript_files tf ON tf.id = e.file_id AND tf.kind = 'main' AND tf.superseded_at IS NULL WHERE e.session_id = ${sessionId}
      UNION ALL
      SELECT 'note', n.ts, 1, n.id, 'n:' || n.id, jsonb_build_object('text', n.text, 'kind', n.kind)
        FROM session_notes n WHERE n.session_id = ${sessionId}
      UNION ALL
      SELECT 'permission', p.created_at, 2, 0, 'p:' || p.request_id, to_jsonb(p)
        FROM permission_requests p WHERE p.session_id = ${sessionId}
    ) x ${cursorCond}
    ORDER BY x.ts DESC, x.k DESC, x.seq DESC
    LIMIT ${limit + 1}`.execute(db);
  const list = rows.rows;
  const more = list.length > limit;
  const page = list.slice(0, limit).reverse();
  const events = page.map((r): HubEvent => {
    const ts = new Date(r.ts).toISOString();
    if (r.kind === 'line') {
      const sideFiles = sideFileRefs(sessionId, r.data);
      return { kind: 'line', id: r.id, ts, line: r.data as Record<string, unknown>, ...(sideFiles ? { sideFiles } : {}) };
    }
    if (r.kind === 'note') {
      const n = r.data as { text: string; kind: string };
      return noteEvent(r.id, ts, n.kind, n.text);
    }
    const p = r.data as Record<string, unknown>;
    return permissionEvent({
      request_id: p.request_id as string,
      session_id: p.session_id as string,
      tool_name: p.tool_name as string,
      tool_use_id: p.tool_use_id as string,
      input: p.input,
      suggestions: p.suggestions,
      created_at: new Date(p.created_at as string),
      resolved_at: p.resolved_at ? new Date(p.resolved_at as string) : null,
      decision: p.decision as PermissionView['decision'],
      scope: p.scope as 'once' | 'session' | null,
      message: (p.message as string | null) ?? null,
      answers: p.answers ?? null,
    });
  });
  const oldest = page[0];
  return { events, before: more && oldest ? encodeCursor({ t: new Date(oldest.ts).toISOString(), k: Number(oldest.k), s: String(oldest.seq) }) : null };
}

/** Cursors of the transcript files of a runner's sessions (welcome.cursors). */
export async function cursorsForRunner(db: Db, runnerId: string) {
  // Not the files of import:drive (drive-import/…, never on the machine) and not superseded imports.
  const rows = await db
    .selectFrom('transcript_files as f')
    .select(['f.rel_path', 'f.generation', 'f.acked_line', 'f.acked_byte'])
    .where('f.runner_id', '=', runnerId)
    .where('f.superseded_at', 'is', null)
    .where('f.rel_key', 'not like', 'drive-import/%')
    .execute();
  return rows.map(r => ({ relPath: r.rel_path, generation: r.generation, ackedLine: Number(r.acked_line), ackedByte: Number(r.acked_byte) }));
}
