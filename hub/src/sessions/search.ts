// Ctrl+K (design D6 «Поиск», task 3.9): title and project (trigram + tsvector over the title; the project by its title,
// slug and path in the catalogue, M4) and the text of messages (events.tsv, websearch_to_tsquery russian ∪ english), grouped by session,
// ranked by match kind, ts_rank and freshness; the snippet is ts_headline of the best event of each session.
// Requirement: Быстрый поиск Ctrl+K.
import { sql } from 'kysely';
import type { SearchMatch, SearchSnippet } from '@agent-hub/shared';
import type { Db } from '../db/db.js';
import { selectSessions, type SessionRow } from './repo.js';

/** Markers of ts_headline: control characters that never occur in the stored text (search_text is stripped of them). */
const START = '\u0001';
const STOP = '\u0002';
/** A text query matching at least this many events is «common»: newest matching sessions instead of a full rank. */
export const COMMON_HITS = 2000;
const HEADLINE = `StartSel=${START}, StopSel=${STOP}, MaxWords=24, MinWords=10, ShortWord=2, MaxFragments=2, FragmentDelimiter=" … "`;

export interface SearchHit {
  row: SessionRow;
  match: SearchMatch;
  snippet: SearchSnippet | null;
}

/** Plain text and the [start, end) offsets (UTF-16, JS string indices) of the highlighted words. */
export function splitHeadline(h: string): SearchSnippet {
  let text = '';
  const highlights: Array<[number, number]> = [];
  let open = -1;
  for (const ch of h) {
    if (ch === START) open = text.length;
    else if (ch === STOP) {
      if (open >= 0 && text.length > open) highlights.push([open, text.length]);
      open = -1;
    } else text += ch;
  }
  return { text, highlights };
}

export async function searchSessions(db: Db, o: { userId: string; q: string; limit: number; cron: boolean }): Promise<SearchHit[]> {
  const q = o.q.trim().slice(0, 200);
  const visible = o.cron ? sql<boolean>`true` : sql<boolean>`s.source <> 'cron'`;
  const recency = sql`COALESCE(s.last_event_at, s.created_at)`;
  if (!q) {
    const rows = await selectSessions(db).where('s.user_id', '=', o.userId).where(visible).orderBy(recency, 'desc').limit(o.limit).execute();
    return rows.map(row => ({ row, match: 'title' as const, snippet: null }));
  }
  const like = `%${q.replace(/[\\%_]/g, c => `\\${c}`)}%`;

  // 1) Title and directory: ILIKE (trigram GIN index) or the title's words (tsvector, both languages).
  const named = await sql<{ id: string; match: 'title' | 'project' }>`
    WITH tq AS (SELECT websearch_to_tsquery('russian', ${q}) || websearch_to_tsquery('english', ${q}) AS q)
    SELECT s.id,
           CASE WHEN s.title ILIKE ${like}
                  OR (to_tsvector('russian', COALESCE(s.title, '')) || to_tsvector('english', COALESCE(s.title, ''))) @@ tq.q
                THEN 'title' ELSE 'project' END AS match
      FROM sessions s
      LEFT JOIN projects p ON p.id = s.project_id
      CROSS JOIN tq
     WHERE s.user_id = ${o.userId} AND ${visible}
       AND (s.title ILIKE ${like} OR p.title ILIKE ${like} OR p.path ILIKE ${like} OR p.slug ILIKE ${like}
            OR (to_tsvector('russian', COALESCE(s.title, '')) || to_tsvector('english', COALESCE(s.title, ''))) @@ tq.q)
     ORDER BY (s.title ILIKE ${like}) DESC, ${recency} DESC
     LIMIT ${o.limit}`.execute(db);

  // 2) Text of messages. A selective query (few matching events) is ranked over all its matches: best event per
  //    session by ts_rank, sessions by rank and freshness (a month halves the score). A common one (a word in
  //    thousands of messages) would rank hundreds of thousands of rows: the newest sessions that have a match are
  //    taken instead, walking sessions by last_event_at (index) and checking each one's events (index by session).
  const probe = await sql<{ n: string }>`
    SELECT count(*) AS n FROM (
      SELECT 1 FROM events e WHERE e.tsv @@ (websearch_to_tsquery('russian', ${q}) || websearch_to_tsquery('english', ${q})) LIMIT ${COMMON_HITS}
    ) x`.execute(db);
  const common = Number(probe.rows[0]!.n) >= COMMON_HITS;
  const best = common
    ? await sql<{ id: string; file_id: string; generation: number; line_no: string }>`
        WITH tq AS (SELECT websearch_to_tsquery('russian', ${q}) || websearch_to_tsquery('english', ${q}) AS q)
        SELECT s.id, b.file_id, b.generation, b.line_no
          FROM sessions s
          CROSS JOIN tq
          CROSS JOIN LATERAL (
            SELECT e.file_id, e.generation, e.line_no FROM events e
             WHERE e.session_id = s.id AND e.tsv @@ tq.q
               AND NOT EXISTS (SELECT 1 FROM transcript_files f WHERE f.id = e.file_id AND f.superseded_at IS NOT NULL)
             ORDER BY ts_rank(e.tsv, tq.q) DESC, e.line_no DESC
             LIMIT 1
          ) b
         WHERE s.user_id = ${o.userId} AND ${visible}
         ORDER BY s.last_event_at DESC
         LIMIT ${o.limit}`.execute(db)
    : await sql<{ id: string; file_id: string; generation: number; line_no: string }>`
        WITH tq AS (SELECT websearch_to_tsquery('russian', ${q}) || websearch_to_tsquery('english', ${q}) AS q),
        hits AS (
          SELECT e.session_id, e.file_id, e.generation, e.line_no, ts_rank(e.tsv, tq.q) AS r
            FROM events e
            JOIN sessions s ON s.id = e.session_id
            JOIN transcript_files f ON f.id = e.file_id AND f.superseded_at IS NULL
            CROSS JOIN tq
           WHERE e.tsv @@ tq.q AND s.user_id = ${o.userId} AND ${visible}
        ),
        top AS (
          SELECT DISTINCT ON (h.session_id) h.session_id, h.file_id, h.generation, h.line_no, h.r
            FROM hits h ORDER BY h.session_id, h.r DESC, h.line_no DESC
        )
        SELECT t.session_id AS id, t.file_id, t.generation, t.line_no
          FROM top t JOIN sessions s ON s.id = t.session_id
         ORDER BY t.r / (1 + EXTRACT(EPOCH FROM (now() - ${recency})) / 2592000.0) DESC
         LIMIT ${o.limit}`.execute(db);
  // Headlines for the chosen events only (≤ limit).
  const keys = best.rows.map(r => sql`(${r.file_id}::bigint, ${r.generation}::int, ${r.line_no}::bigint)`);
  const heads = keys.length
    ? await sql<{ file_id: string; generation: number; line_no: string; headline: string }>`
        WITH tq AS (SELECT websearch_to_tsquery('russian', ${q}) || websearch_to_tsquery('english', ${q}) AS q)
        SELECT e.file_id, e.generation, e.line_no,
               CASE WHEN position(${START} IN ts_headline('russian', e.search_text, tq.q, ${HEADLINE})) > 0
                    THEN ts_headline('russian', e.search_text, tq.q, ${HEADLINE})
                    ELSE ts_headline('english', e.search_text, tq.q, ${HEADLINE}) END AS headline
          FROM events e CROSS JOIN tq
         WHERE (e.file_id, e.generation, e.line_no) IN (${sql.join(keys)})`.execute(db)
    : { rows: [] };
  const headOf = new Map(heads.rows.map(h => [`${h.file_id}:${h.generation}:${h.line_no}`, h.headline]));
  const text = { rows: best.rows.map(r => ({ id: r.id, headline: headOf.get(`${r.file_id}:${r.generation}:${r.line_no}`) ?? '' })) };

  const order: Array<{ id: string; match: SearchMatch; headline?: string }> = [];
  const seen = new Set<string>();
  for (const r of named.rows.filter(x => x.match === 'title')) if (!seen.has(r.id) && seen.add(r.id)) order.push({ id: r.id, match: 'title' });
  const headlines = new Map(text.rows.map(r => [r.id, r.headline]));
  for (const r of text.rows) if (!seen.has(r.id) && seen.add(r.id)) order.push({ id: r.id, match: 'text', headline: r.headline });
  for (const r of named.rows.filter(x => x.match === 'project')) if (!seen.has(r.id) && seen.add(r.id)) order.push({ id: r.id, match: 'project' });
  const ids = order.slice(0, o.limit);
  if (!ids.length) return [];
  const rows = await selectSessions(db)
    .where(
      's.id',
      'in',
      ids.map(x => x.id),
    )
    .execute();
  const byId = new Map(rows.map(r => [r.id, r]));
  return ids.flatMap(x => {
    const row = byId.get(x.id);
    if (!row) return [];
    // A title match still shows the text fragment when the messages match too.
    const h = x.headline ?? headlines.get(x.id);
    const snippet = h && h.includes(START) ? splitHeadline(h) : null;
    return [{ row, match: x.match, snippet }];
  });
}
