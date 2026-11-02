// Monitors and background commands of a session (change `background-tasks`, design D5, D6): the expiry of a monitor,
// the list of the API and the sweep that marks expired monitors. The facts are applied in repo.ts (applyFacts).
// Requirement (background-tasks): Конец фоновой задачи; Фоновые задачи в списке рядом с субагентами.
import { sql, type RawBuilder } from 'kysely';
import type { BackgroundTaskStatus, BackgroundTaskView } from '@agent-hub/shared';
import type { Db } from '../db/db.js';

/** A running monitor of `alias` (background_tasks) whose timeout has passed: it no longer works (D5). */
export function bgExpired(alias: string): RawBuilder<boolean> {
  const c = (col: string) => sql.ref(`${alias}.${col}`);
  return sql<boolean>`(${c('kind')} = 'monitor' AND NOT ${c('persistent')} AND ${c('timeout_ms')} IS NOT NULL AND ${c('started_at')} IS NOT NULL
    AND ${c('started_at')} + ${c('timeout_ms')} * interval '1 millisecond' <= now())`;
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
  const expiresAt = r.kind === 'monitor' && !r.persistent && r.timeout_ms !== null && r.started_at ? new Date(r.started_at.getTime() + Number(r.timeout_ms)).toISOString() : null;
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
    endedAt: iso(r.ended_at) ?? (status === 'expired' ? expiresAt : null),
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
    .orderBy(sql`b.started_at DESC NULLS LAST`)
    .limit(BG_LIST_LIMIT)
    .execute();
  return (rows as unknown as BgRow[]).map(toBackgroundView).reverse();
}

/** D5: running monitors past their timeout become `expired`; returns the sessions to send session.upsert for. */
export async function expireMonitors(db: Db): Promise<string[]> {
  const rows = await db
    .updateTable('background_tasks as b')
    .set({ state: 'expired', ended_at: sql`b.started_at + b.timeout_ms * interval '1 millisecond'` })
    .where('b.state', '=', 'running')
    .where(bgExpired('b'))
    .returning('b.session_id')
    .execute();
  return [...new Set(rows.map(r => r.session_id))];
}
