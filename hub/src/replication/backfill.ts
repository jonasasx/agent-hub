// Backfill of design D4 «Вынос нагрузок» for events stored before structured copies were moved (toolUseResult,
// mcpMeta.structuredContent, wireToolInputs): re-runs extractPayloads on stored payloads over 16 KB, uploads the
// new blobs and rewrites the event. Idempotent: a processed payload yields no blobs and is left as is.
// Requirement: Хранение событий без больших полезных нагрузок.
import { sql } from 'kysely';
import type { Db } from '../db/db.js';
import type { ObjectStore } from '../storage/objectStore.js';
import { INLINE_LIMIT, extractPayloads } from './extract.js';

export interface BackfillStats {
  scanned: number;
  changed: number;
  blobsUploaded: number;
  bytesBefore: number;
  bytesAfter: number;
}

export async function backfillPayloads(db: Db, store: ObjectStore, o: { batch?: number; dryRun?: boolean; log?: (s: string) => void } = {}): Promise<BackfillStats> {
  const batch = o.batch ?? 100;
  const stats: BackfillStats = { scanned: 0, changed: 0, blobsUploaded: 0, bytesBefore: 0, bytesAfter: 0 };
  let cursor: { file_id: string; generation: number; line_no: string } | null = null;
  for (;;) {
    let q = db
      .selectFrom('events')
      .select(['file_id', 'generation', 'line_no', 'payload', 'session_id'])
      .where(sql<boolean>`octet_length(payload::text) > ${INLINE_LIMIT}`)
      .orderBy('file_id')
      .orderBy('generation')
      .orderBy('line_no')
      .limit(batch);
    if (cursor) {
      const c = cursor;
      q = q.where(sql<boolean>`(file_id, generation, line_no) > (${c.file_id}::bigint, ${c.generation}::int, ${c.line_no}::bigint)`);
    }
    const rows = await q.execute();
    if (!rows.length) break;
    for (const r of rows) {
      stats.scanned++;
      const payload = r.payload as Record<string, unknown>;
      const ex = extractPayloads(payload);
      if (!ex.blobs.length) continue;
      const after = JSON.stringify(ex.line);
      stats.changed++;
      stats.bytesBefore += Buffer.byteLength(JSON.stringify(payload), 'utf8');
      stats.bytesAfter += Buffer.byteLength(after, 'utf8');
      if (o.dryRun) continue;
      // Blobs first: an event never references an object that is not in S3.
      const have = new Set(
        (
          await db
            .selectFrom('blobs')
            .select('sha256')
            .where(
              'sha256',
              'in',
              ex.blobs.map(b => b.sha256),
            )
            .execute()
        ).map(x => x.sha256),
      );
      const fresh = ex.blobs.filter(b => !have.has(b.sha256));
      for (const b of fresh) await store.put(`blobs/${b.sha256}`, b.bytes, b.mime);
      stats.blobsUploaded += fresh.length;
      await db.transaction().execute(async tx => {
        if (fresh.length) {
          await tx
            .insertInto('blobs')
            .values(
              [...fresh]
                .sort((x, y) => (x.sha256 < y.sha256 ? -1 : x.sha256 > y.sha256 ? 1 : 0))
                .map(b => ({ sha256: b.sha256, s3_key: `blobs/${b.sha256}`, size: b.bytes.length, mime: b.mime, width: b.width, height: b.height })),
            )
            .onConflict(oc => oc.column('sha256').doNothing())
            .execute();
        }
        // The session's user may read these blobs (GET /api/blobs, D19).
        for (const b of [...ex.blobs].sort((x, y) => (x.sha256 < y.sha256 ? -1 : x.sha256 > y.sha256 ? 1 : 0))) {
          await sql`INSERT INTO blob_owners (sha256, user_id) SELECT ${b.sha256}, s.user_id FROM sessions s WHERE s.id = ${r.session_id} ON CONFLICT DO NOTHING`.execute(tx);
        }
        await tx.updateTable('events').set({ payload: after }).where('file_id', '=', r.file_id).where('generation', '=', r.generation).where('line_no', '=', r.line_no).execute();
      });
    }
    const last = rows[rows.length - 1]!;
    cursor = { file_id: String(last.file_id), generation: last.generation, line_no: String(last.line_no) };
    o.log?.(`scanned ${stats.scanned}, changed ${stats.changed}, blobs ${stats.blobsUploaded}`);
  }
  return stats;
}
