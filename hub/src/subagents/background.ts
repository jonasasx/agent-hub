// Monitors and background commands of a session (change `background-tasks`, design D5, D6): the expiry of a monitor,
// the list of the API and the sweep that marks expired monitors. The facts are applied in repo.ts (applyFacts).
// Requirement (background-tasks): Конец фоновой задачи; Фоновые задачи в списке рядом с субагентами.
import { sql, type RawBuilder } from 'kysely';
import type { BackgroundTaskStatus, BackgroundTaskView } from '@agent-hub/shared';
import type { Db } from '../db/db.js';

/**
 * A background command without its own `timeout` runs at most this long in Claude Code (30 min), with one — at most
 * BASH_MAX_MS (2 h). A safety net only: the end comes from the task notification, this covers a lost one.
 */
export const BASH_DEFAULT_MS = 30 * 60_000;
export const BASH_MAX_MS = 2 * 60 * 60_000;

/**
 * A monitor that is not persistent runs at most 1 h in Claude Code (`timeout_ms` ≤ 3600000). A monitor whose timeout is
 * not known (the result kept only its text) gets this bound instead of none — the safety net of a lost notification.
 */
export const MONITOR_MAX_MS = 60 * 60_000;

/** The deadline of a task in ms (null — none): a monitor — its timeout or the bound (not persistent), a command — its timeout or the default. */
export function bgTimeoutMs(kind: 'bash' | 'monitor', persistent: boolean, timeoutMs: string | null): number | null {
  if (persistent) return null;
  if (kind === 'monitor') return timeoutMs === null ? MONITOR_MAX_MS : Number(timeoutMs);
  return Math.min(timeoutMs === null ? BASH_DEFAULT_MS : Number(timeoutMs), BASH_MAX_MS);
}

/** The deadline in ms of a row of `alias` (background_tasks) as SQL; NULL — none (the same as bgTimeoutMs). */
function bgTimeoutSql(alias: string): RawBuilder<number | null> {
  const c = (col: string) => sql.ref(`${alias}.${col}`);
  return sql<number | null>`(CASE WHEN ${c('persistent')} THEN NULL WHEN ${c('kind')} = 'monitor' THEN COALESCE(${c('timeout_ms')}, ${sql.lit(MONITOR_MAX_MS)})
    ELSE LEAST(COALESCE(${c('timeout_ms')}, ${sql.lit(BASH_DEFAULT_MS)}), ${sql.lit(BASH_MAX_MS)}) END)`;
}

/** A running task of `alias` (background_tasks) whose deadline has passed: it no longer works (D5; a command — the safety net). */
export function bgExpired(alias: string): RawBuilder<boolean> {
  const c = (col: string) => sql.ref(`${alias}.${col}`);
  return sql<boolean>`(${bgTimeoutSql(alias)} IS NOT NULL AND ${c('started_at')} IS NOT NULL
    AND ${c('started_at')} + ${bgTimeoutSql(alias)} * interval '1 millisecond' <= now())`;
}

/** Shown in the list: started tasks (a call without a result is not). */
export const BG_LIST_LIMIT = 200;

interface BgRow {
  tool_use_id: string;
  session_id: string;
  kind: 'bash' | 'monitor';
  description: string | null;
  command: string | null;
  task_id: string | null;
  state: 'pending' | 'running' | 'completed' | 'failed' | 'stopped' | 'expired';
  started_at: Date | null;
  ended_at: Date | null;
  timeout_ms: string | null;
  persistent: boolean;
  last_event: string | null;
  last_event_at: Date | null;
  expired: boolean;
  /** The session is alive and the task belongs to its current process. */
  current: boolean;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toBackgroundView(r: BgRow): BackgroundTaskView {
  let status: BackgroundTaskStatus = r.state === 'pending' ? 'interrupted' : r.state;
  if (r.state === 'running') status = r.expired ? 'expired' : r.current ? 'running' : 'interrupted';
  // an expired command ends at its deadline too (the sweep writes the same); the list shows «истекает» for monitors only
  const timeout = bgTimeoutMs(r.kind, r.persistent, r.timeout_ms);
  const expiresAt = r.kind === 'monitor' && timeout !== null && r.started_at ? new Date(r.started_at.getTime() + timeout).toISOString() : null;
  const deadline = timeout !== null && r.started_at ? new Date(r.started_at.getTime() + timeout).toISOString() : null;
  return {
    id: r.tool_use_id,
    sessionId: r.session_id,
    kind: r.kind,
    description: r.description,
    command: r.command,
    taskId: r.task_id,
    status,
    startedAt: iso(r.started_at),
    // an expired monitor ends at its timeout (the sweep writes the same)
    endedAt: iso(r.ended_at) ?? (status === 'expired' ? deadline : null),
    expiresAt,
    lastEvent: r.last_event,
    lastEventAt: iso(r.last_event_at),
  };
}

/**
 * GET /api/sessions/:id/subagents → background: the latest started tasks. A task works for its session while the
 * session is alive and the task started in its current process — the same bound as children_working
 * (sessions/repo.ts processStart: 60 s of margin for the runner's clock).
 */
export async function listBackground(db: Db, sessionId: string): Promise<BackgroundTaskView[]> {
  const rows = await db
    .selectFrom('background_tasks as b')
    .innerJoin('sessions as s', 's.id', 'b.session_id')
    .select([
      'b.tool_use_id',
      'b.session_id',
      'b.kind',
      'b.description',
      'b.command',
      'b.task_id',
      'b.state',
      'b.started_at',
      'b.ended_at',
      'b.timeout_ms',
      'b.persistent',
      'b.last_event',
      'b.last_event_at',
      bgExpired('b').as('expired'),
      sql<boolean>`((s.process_alive OR (s.external_seen_at IS NOT NULL AND s.external_seen_at > now() - interval '3 minutes'))
        AND COALESCE(b.started_at, '-infinity') >= (COALESCE(CASE WHEN s.process_alive THEN s.process_started_at ELSE s.external_since END, s.slept_at, '-infinity'::timestamptz) - interval '60 seconds'))`.as(
        'current',
      ),
    ])
    .where('b.session_id', '=', sessionId)
    .where('b.state', '!=', 'pending')
    // a call that failed before it started a task is not a task
    .where('b.task_id', 'is not', null)
    .orderBy(sql`b.started_at DESC NULLS LAST`)
    .limit(BG_LIST_LIMIT)
    .execute();
  return (rows as unknown as BgRow[]).map(toBackgroundView).reverse();
}

/** D5: running monitors past their timeout and background commands past their deadline become `expired`; returns the sessions to send session.upsert for. */
export async function expireMonitors(db: Db): Promise<string[]> {
  const rows = await db
    .updateTable('background_tasks as b')
    .set({ state: 'expired', ended_at: sql`b.started_at + ${bgTimeoutSql('b')} * interval '1 millisecond'` })
    .where('b.state', '=', 'running')
    .where(bgExpired('b'))
    .returning('b.session_id')
    .execute();
  return [...new Set(rows.map(r => r.session_id))];
}
