// Re-review of M3c: the live copy is compared with a Drive import without assembling it — only the segments of the
// overlapping lines are read (a 40 MB import and a 500-line chunk: one segment); a merged full copy is decompressed
// as a stream; a raw copy with a gap makes the import superseded and the live file starts from line 0.
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryStore } from '../storage/objectStore.js';
import { createTestDb, type TestDb } from '../test/db.js';
import type { AgentGateway } from '../runners/agentGateway.js';
import type { UiGateway } from '../ui/uiGateway.js';
import { Replication } from './ingest.js';
import { mergeSegments, rawLines, rawPrefix } from './raw.js';

/** Counts the raw objects read. */
class CountingStore extends MemoryStore {
  reads: string[] = [];
  override get(key: string): Promise<Buffer | null> {
    if (key.startsWith('raw/')) this.reads.push(key);
    return super.get(key);
  }
}

const VAULT = 'C:\\Users\\alice\\vault';
const PAD = 'x'.repeat(10_000);
const line = (sid: string, n: number) =>
  JSON.stringify({
    type: 'user',
    uuid: `u${n}`,
    sessionId: sid,
    cwd: VAULT,
    entrypoint: 'cli',
    timestamp: new Date(1_700_000_000_000 + n * 1000).toISOString(),
    message: { role: 'user', content: `строка ${n} ${PAD}` },
  });
const bytes = (ls: string[]) => ls.reduce((a, l) => a + Buffer.byteLength(l) + 1, 0);

describe('taking a Drive import over (Postgres)', () => {
  let t: TestDb;
  const store = new CountingStore();
  let repl: Replication;
  const files = async (sid: string) =>
    (await t.pool.query(`SELECT rel_path, acked_line, superseded_at IS NOT NULL AS superseded FROM transcript_files WHERE claude_session_id = $1 ORDER BY id`, [sid])).rows;

  /** An import of `n` lines in chunks of 500 (one raw segment each, ~5 MB). */
  async function imported(n: number): Promise<{ sid: string; lines: string[] }> {
    const sid = randomUUID();
    const lines = Array.from({ length: n }, (_, i) => line(sid, i));
    for (let from = 0; from < n; from += 500) {
      const part = lines.slice(from, from + 500);
      await repl.onChunk(
        'hp',
        {
          relPath: `drive-import/${sid}.jsonl`,
          kind: 'main',
          sessionId: sid,
          generation: 0,
          fromLine: from,
          fromByte: bytes(lines.slice(0, from)),
          lines: part,
          endByte: bytes(lines.slice(0, from + part.length)),
        },
        { driveImport: true },
      );
    }
    return { sid, lines };
  }

  beforeAll(async () => {
    t = await createTestDb();
    const uid = (await t.pool.query<{ id: string }>(`INSERT INTO users (email) VALUES ('alice@example.com') RETURNING id`)).rows[0]!.id;
    await t.pool.query(`INSERT INTO runners (id, user_id, name, hostname, home_dir) VALUES ('hp', $1, 'HP', 'HP-Elitebook', 'C:\\Users\\alice')`, [uid]);
    repl = new Replication({
      db: t.db,
      store,
      agents: { get: () => undefined } as unknown as AgentGateway,
      ui: { sendToSubscribers: () => undefined } as unknown as UiGateway,
      log: { warn: () => undefined, info: () => undefined, error: () => undefined } as unknown as FastifyBaseLogger,
      hooks: { upsert: async () => undefined, userLines: async () => undefined },
    });
  }, 120_000);
  afterAll(async () => t.drop());

  it('a 40 MB import and a 500-line live chunk: one segment is read, the import moves to the live key', { timeout: 120_000 }, async () => {
    const { sid, lines } = await imported(4000); // 8 segments × ~5 MB
    expect(bytes(lines)).toBeGreaterThan(40_000_000);
    const prefix = rawPrefix('hp', sid, `drive-import/${sid}.jsonl`, 0);
    expect([...store.objects.keys()].filter(k => k.startsWith(prefix))).toHaveLength(8);
    store.reads = [];
    const live = `c--users-alice-vault/${sid}.jsonl`;
    await repl.onChunk('hp', { relPath: live, kind: 'main', sessionId: sid, generation: 0, fromLine: 0, fromByte: 0, lines: lines.slice(0, 500), endByte: bytes(lines.slice(0, 500)) });
    // compared: the first segment only; then copied to the live key (each segment read once by the copy)
    const compared = store.reads.slice(0, store.reads.length - 8);
    expect(compared).toEqual([`${prefix}000000000-000000499.jsonl.zst`]);
    expect(await files(sid)).toEqual([{ rel_path: live, acked_line: '4000', superseded: false }]);
    expect([...store.objects.keys()].some(k => k.startsWith(prefix))).toBe(false);
  });

  it('a merged full copy is read as a stream until the overlap ends', { timeout: 120_000 }, async () => {
    const { sid, lines } = await imported(1000);
    const prefix = rawPrefix('hp', sid, `drive-import/${sid}.jsonl`, 0);
    expect(await mergeSegments(store, prefix)).toBe(2);
    store.reads = [];
    const live = `c--users-alice-vault/${sid}.jsonl`;
    const more = line(sid, 1000);
    // the live file is longer: everything exported plus one line written later
    await repl.onChunk('hp', {
      relPath: live,
      kind: 'main',
      sessionId: sid,
      generation: 0,
      fromLine: 0,
      fromByte: 0,
      lines: [...lines.slice(0, 499), lines[499]!].concat(lines.slice(500)).concat([more]),
      endByte: bytes([...lines, more]),
    });
    expect(store.reads[0]).toBe(`${prefix}full.jsonl.zst`);
    expect(await files(sid)).toEqual([{ rel_path: live, acked_line: '1001', superseded: false }]);
    expect(Number((await t.pool.query(`SELECT count(*) AS n FROM events WHERE session_id = (SELECT id FROM sessions WHERE claude_session_id = $1)`, [sid])).rows[0].n)).toBe(1001);
  });

  it('rawLines: an object lost to the nightly merge is found again in a second listing; a second loss is a gap', async () => {
    const { sid, lines } = await imported(1000);
    const prefix = rawPrefix('hp', sid, `drive-import/${sid}.jsonl`, 0);
    const seg2 = `${prefix}000000500-000000999.jsonl.zst`;
    let merged = false;
    const racing = Object.create(store) as MemoryStore;
    racing.get = async (k: string) => {
      if (k === seg2 && !merged) {
        merged = true;
        await mergeSegments(store, prefix); // full.jsonl.zst replaces both segments meanwhile
        return null;
      }
      return store.get(k);
    };
    racing.list = (p: string) => store.list(p);
    const got: string[] = [];
    for await (const l of rawLines(racing, prefix, 1000)) got.push(l);
    expect(got).toEqual(lines);
    const losing = Object.create(store) as MemoryStore;
    losing.get = async () => null;
    losing.list = (p: string) => store.list(p);
    await expect(async () => {
      for await (const l of rawLines(losing, prefix, 10)) void l;
    }).rejects.toThrow(/disappeared twice/);
  });

  it('copies of an attempt that did not commit are removed before the live file writes under its key', { timeout: 120_000 }, async () => {
    const { sid } = await imported(600);
    const live = `c--users-alice-vault/${sid}.jsonl`;
    const livePrefix = rawPrefix('hp', sid, live, 0);
    // left over by a failed attempt: a copied import segment under the live key
    store.objects.set(`${livePrefix}000000000-000000499.jsonl.zst`, store.objects.get(`${rawPrefix('hp', sid, `drive-import/${sid}.jsonl`, 0)}000000000-000000499.jsonl.zst`)!);
    // the live file is another file: the import is superseded, the live row is fresh
    const other = Array.from({ length: 10 }, (_, i) => JSON.stringify({ type: 'user', uuid: `o${i}`, sessionId: sid, message: { role: 'user', content: `другое ${i}` } }));
    await repl.onChunk('hp', { relPath: live, kind: 'main', sessionId: sid, generation: 0, fromLine: 0, fromByte: 0, lines: other, endByte: bytes(other) });
    expect([...store.objects.keys()].filter(k => k.startsWith(livePrefix))).toEqual([`${livePrefix}000000000-000000009.jsonl.zst`]);
    const { assemble } = await import('./raw.js');
    expect((await assemble(store, livePrefix)).content.toString('utf8').trim().split('\n')).toEqual(other);
  });

  it('a raw copy with a gap: the import is superseded once, the live file starts from line 0 (no endless retry)', { timeout: 120_000 }, async () => {
    const { sid, lines } = await imported(1000);
    const prefix = rawPrefix('hp', sid, `drive-import/${sid}.jsonl`, 0);
    store.objects.delete(`${prefix}000000000-000000499.jsonl.zst`);
    const live = `c--users-alice-vault/${sid}.jsonl`;
    await repl.onChunk('hp', { relPath: live, kind: 'main', sessionId: sid, generation: 0, fromLine: 0, fromByte: 0, lines: lines.slice(0, 500), endByte: bytes(lines.slice(0, 500)) });
    expect(await files(sid)).toEqual([
      { rel_path: `drive-import/${sid}.jsonl`, acked_line: '1000', superseded: true },
      { rel_path: live, acked_line: '500', superseded: false },
    ]);
    // the next chunk continues the live row
    await repl.onChunk('hp', {
      relPath: live,
      kind: 'main',
      sessionId: sid,
      generation: 0,
      fromLine: 500,
      fromByte: bytes(lines.slice(0, 500)),
      lines: lines.slice(500, 600),
      endByte: bytes(lines.slice(0, 600)),
    });
    expect((await files(sid))[1]).toMatchObject({ acked_line: '600' });
  });
});
