// Journal of messages between sessions (session-peers D6) and the catalog read by the agent-hub tools (D9).
import { sql } from 'kysely';
import type { PeerSession } from '@agent-hub/shared';
import type { Db, PeerMessagesTable } from '../db/db.js';

export type PeerResult = PeerMessagesTable['result'];
/** hub-subagents D3: a message, the task of a spawned session, the hub's report of a child's turn. */
export type PeerJournalKind = 'message' | 'spawn' | 'report';

export interface PeerJournalRow {
  id: string;
  from_session_id: string;
  to_session_id: string;
  text: string;
  in_reply_to: string | null;
  result: PeerResult;
  error_code: string | null;
  created_at: Date;
}

export async function recordPeerMessage(
  db: Db,
  r: {
    id: string;
    userId: string;
    from: string;
    to: string;
    text: string;
    inReplyTo?: string | undefined;
    result: PeerResult;
    errorCode?: string | undefined;
    at: Date;
    kind?: PeerJournalKind | undefined;
  },
): Promise<void> {
  await db
    .insertInto('peer_messages')
    .values({
      id: r.id,
      user_id: r.userId,
      from_session_id: r.from,
      to_session_id: r.to,
      text: r.text,
      in_reply_to: r.inReplyTo ?? null,
      result: r.result,
      error_code: r.errorCode ?? null,
      created_at: r.at,
      ...(r.kind ? { kind: r.kind } : {}),
    })
    .execute();
}

/** Messages that count against the limits: everything the sender got through or failed with, not the refused ones. */
export async function countRecent(db: Db, from: string, to: string | null, since: Date): Promise<{ count: number; oldest: Date | null }> {
  let q = db
    .selectFrom('peer_messages')
    .select([sql<string>`count(*)`.as('n'), sql<Date | null>`min(created_at)`.as('oldest')])
    .where('from_session_id', '=', from)
    .where('created_at', '>', since)
    .where('result', '!=', 'rate_limited');
  if (to) q = q.where('to_session_id', '=', to);
  const r = await q.executeTakeFirstOrThrow();
  return { count: Number(r.n), oldest: r.oldest };
}

export async function listPeerMessages(db: Db, userId: string, sessionId: string, limit: number, before?: Date): Promise<PeerJournalRow[]> {
  let q = db
    .selectFrom('peer_messages')
    .select(['id', 'from_session_id', 'to_session_id', 'text', 'in_reply_to', 'result', 'error_code', 'created_at'])
    .where('user_id', '=', userId)
    .where(eb => eb.or([eb('from_session_id', '=', sessionId), eb('to_session_id', '=', sessionId)]))
    .orderBy('created_at', 'desc')
    .limit(limit);
  if (before) q = q.where('created_at', '<', before);
  return q.execute();
}

export interface PeerCatalogFilter {
  machine?: string | undefined;
  project?: string | undefined;
  status?: PeerSession['status'] | undefined;
  /** sessions-list-query: whitespace-separated words, each must occur in the title (the folder name when untitled). */
  query?: string | undefined;
  /** sessions-list-readonly: also the sessions the hub does not run and the read-only ones (list and get); messaging leaves it off. */
  withReadOnly?: boolean | undefined;
  limit: number;
}

const like = (v: string): string => `%${v.replace(/[\\%_]/g, '\\$&')}%`;

/**
 * Sessions the owner's sessions may see: hub-managed and writable ones, with `withReadOnly` the others too (not cron). `selfId` marks the caller. Newest activity first.
 * `id` is the hub's session id (the one the web shows in its addresses).
 */
export async function peerCatalog(db: Db, userId: string, selfId: string, f: PeerCatalogFilter, single?: string): Promise<PeerSession[]> {
  const last = sql<Date>`greatest(coalesce(s.last_event_at, s.created_at), coalesce(s.last_input_at, s.created_at), coalesce(s.last_turn_end_at, s.created_at))`;
  let q = db
    .selectFrom('sessions as s')
    .innerJoin('runners as r', 'r.id', 's.runner_id')
    .select(['s.id', 's.title', 's.cwd', 's.status', 's.process_alive', 's.is_hub_managed', 's.read_only_reason', 'r.name as machine', last.as('last_activity')])
    .where('s.user_id', '=', userId)
    .where('s.source', '!=', 'cron')
    .orderBy(last, 'desc')
    .limit(f.limit);
  if (!f.withReadOnly) q = q.where('s.is_hub_managed', '=', true).where('s.read_only_reason', 'is', null);
  if (single) q = q.where('s.id', '=', single);
  if (f.machine) q = q.where(sql<boolean>`r.name ILIKE ${like(f.machine)}`);
  if (f.project) q = q.where(sql<boolean>`s.cwd ILIKE ${like(f.project)}`);
  if (f.status) q = q.where('s.status', '=', f.status);
  // Same fallback as the title below: the last segment of the folder.
  const shown = sql<string>`coalesce(nullif(s.title, ''), substring(translate(coalesce(s.cwd, ''), '\\', '/') from '([^/]+)/*$'), '')`;
  for (const word of (f.query ?? '').split(/\s+/).filter(Boolean)) {
    q = q.where(sql<boolean>`${shown} ILIKE ${like(word)}`);
  }
  const rows = await q.execute();
  return rows.map(r => ({
    id: r.id,
    title: r.title || (r.cwd ? (r.cwd.split(/[\\/]/).filter(Boolean).pop() ?? '') : ''),
    machine: r.machine,
    cwd: r.cwd ?? '',
    status: r.status,
    processAlive: r.process_alive,
    lastActivityAt: r.last_activity ? new Date(r.last_activity).toISOString() : null,
    self: r.id === selfId,
    readOnly: !r.is_hub_managed || r.read_only_reason !== null,
  }));
}
