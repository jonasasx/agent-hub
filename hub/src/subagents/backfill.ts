// subagents:backfill (change `subagents`, design S4): the registry for history taken in before the change — the
// files of each session (main first) read from the raw copy in S3 through rawLines(), the same scanLines and upsert
// as the live intake, one session per transaction, lines in batches of 500. Sessions without a raw copy (Drive import before M3c): from the
// stored events (no hooks and no queue). Idempotent: a second run changes nothing.
import { sql } from 'kysely';
import type { Db } from '../db/db.js';
import { rawLines, rawPrefix } from '../replication/raw.js';
import type { ObjectStore } from '../storage/objectStore.js';
import { lockSessionTouches, withDbRetry } from '../projects/service.js';
import { scanLines } from './extract.js';
import { applyFacts, applyHeldMeta, lockRegistry } from './repo.js';

/** Lines of a file scanned and applied at a time. */
const BATCH = 500;

function parseLine(l: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(l) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface BackfillReport {
  sessions: number;
  files: number;
  facts: number;
  /** registry rows after the run (in a dry run: rows the run would have) */
  rows: number;
  fromEvents: number;
  errors: number;
}

class DryRun extends Error {}

export async function backfillSubagents(
  db: Db,
  store: ObjectStore | undefined,
  o: { sessionId?: string | undefined; dryRun: boolean; log?: (s: string) => void; pauseMs?: number },
): Promise<BackfillReport> {
  const report: BackfillReport = { sessions: 0, files: 0, facts: 0, rows: 0, fromEvents: 0, errors: 0 };
  // sessions with subagent transcripts or with a call of Agent/Task in their events
  const sessions = o.sessionId
    ? await db.selectFrom('sessions').select(['id', 'user_id', 'runner_id', 'claude_session_id']).where('id', '=', o.sessionId).execute()
    : await db
        .selectFrom('sessions as s')
        .select(['s.id', 's.user_id', 's.runner_id', 's.claude_session_id'])
        .where(eb =>
          eb.or([
            eb.exists(eb.selectFrom('transcript_files as f').select('f.id').whereRef('f.session_id', '=', 's.id').where('f.kind', '=', 'subagent')),
            eb.exists(
              eb
                .selectFrom('events as e')
                .select('e.file_id')
                .whereRef('e.session_id', '=', 's.id')
                .where('e.type', '=', 'assistant')
                .where(sql<boolean>`e.payload @? '$.message.content[*] ? (@.type == "tool_use" && (@.name == "Agent" || @.name == "Task"))'`),
            ),
          ]),
        )
        .orderBy('s.id')
        .execute();
  for (const s of sessions) {
    try {
      const files = await db
        .selectFrom('transcript_files')
        .select(['id', 'kind', 'agent_id', 'rel_key', 'rel_path', 'generation', 'acked_line'])
        .where('session_id', '=', s.id)
        .where('superseded_at', 'is', null)
        .orderBy(sql`kind = 'main'`, 'desc')
        .orderBy('id')
        .execute();
      // One transaction per session (a dry run rolls it back), retried on a deadlock. Locks in the order of the live
      // intake (review `subagents` p. 1): the touches of the session, then its registry, then the rows of files.
      const one = { files: 0, facts: 0, rows: 0, fromEvents: 0 };
      await withDbRetry(() =>
        db
          .transaction()
          .execute(async tx => {
            Object.assign(one, { files: 0, facts: 0, rows: 0, fromEvents: 0 });
            await lockSessionTouches(tx, s.id);
            await lockRegistry(tx, s.id);
            for (const f of files) {
              const ctx = {
                kind: f.kind,
                agentIdOfFile:
                  f.kind === 'subagent'
                    ? (
                        f.agent_id ??
                        f.rel_path
                          .split('/')
                          .pop()!
                          .replace(/\.jsonl$/i, '')
                      ).replace(/^agent-/, '')
                    : null,
              };
              // lines in batches of BATCH (review p. 4): a file of thousands of lines is never held whole
              const apply = async (batch: Array<{ lineNo: number; obj: Record<string, unknown> | null }>) => {
                const facts = scanLines(ctx, batch);
                one.facts += facts.length;
                if (facts.length) await applyFacts(tx, { userId: s.user_id, sessionId: s.id, fileId: f.id }, facts);
              };
              let fromRaw = false;
              if (store && Number(f.acked_line) > 0) {
                try {
                  let i = 0;
                  let batch: Array<{ lineNo: number; obj: Record<string, unknown> | null }> = [];
                  for await (const l of rawLines(store, rawPrefix(s.runner_id, s.claude_session_id, f.rel_key, f.generation), Number(f.acked_line))) {
                    batch.push({ lineNo: i++, obj: parseLine(l) });
                    if (batch.length >= BATCH) {
                      await apply(batch);
                      batch = [];
                    }
                  }
                  await apply(batch);
                  fromRaw = i > 0;
                } catch {
                  fromRaw = false; // facts of the lines read are applied again from the events: idempotent
                }
              }
              if (!fromRaw) {
                one.fromEvents++;
                for (let after = -1; ;) {
                  const ev = await tx.selectFrom('events').select(['line_no', 'payload']).where('file_id', '=', f.id).where('line_no', '>', String(after)).orderBy('line_no').limit(BATCH).execute();
                  if (!ev.length) break;
                  await apply(ev.map(e => ({ lineNo: Number(e.line_no), obj: e.payload as Record<string, unknown> })));
                  after = Number(ev.at(-1)!.line_no);
                }
              }
              one.files++;
            }
            // meta.json after the transcripts (QA subagents): the held ones and those stored on the rows, by the meta rule
            // (a call in a transcript keeps its type, description and parent; a row without one takes them from meta)
            await applyHeldMeta(tx, { userId: s.user_id, sessionId: s.id, runnerId: s.runner_id, claudeSessionId: s.claude_session_id });
            const n = await tx
              .selectFrom('subagent_runs')
              .select(eb => eb.fn.countAll<string>().as('n'))
              .where('session_id', '=', s.id)
              .executeTakeFirstOrThrow();
            one.rows = Number(n.n);
            if (o.dryRun) throw new DryRun();
          })
          .catch((err: unknown) => {
            if (!(err instanceof DryRun)) throw err;
          }),
      );
      report.files += one.files;
      report.facts += one.facts;
      report.rows += one.rows;
      report.fromEvents += one.fromEvents;
      report.sessions++;
      o.log?.(`${o.dryRun ? 'dry run: ' : ''}session ${s.id}: ${files.length} files`);
    } catch (err) {
      report.errors++;
      o.log?.(`error: session ${s.id}: ${(err as Error).message}`);
    }
    if (o.pauseMs) await new Promise(r => setTimeout(r, o.pauseMs));
  }
  return report;
}
