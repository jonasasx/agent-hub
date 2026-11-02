// Raw transcripts in S3 (design D4 «Сырьё в S3», D7): every accepted chunk adds a zstd segment
// raw/<runner>/<sessionId>/<relPath>/g<gen>/<from>-<to>.jsonl.zst (lines from..to, 0-based, inclusive); a nightly
// merge joins the segments of a file idle for 24 h into …/g<gen>/full.jsonl.zst. Restore concatenates them.
import zlib from 'node:zlib';
import type { ObjectStore } from '../storage/objectStore.js';

if (typeof zlib.zstdCompressSync !== 'function') throw new Error('Node.js with zstd support is required (22.15+)');

const PAD = 9;
const pad = (n: number) => String(n).padStart(PAD, '0');

export function rawPrefix(runnerId: string, claudeSessionId: string, relPath: string, generation: number): string {
  return `raw/${runnerId}/${claudeSessionId}/${relPath}/g${generation}/`;
}

/** The raw copy misses lines (a gap between segments): the file cannot be restored from it. */
export class RawGapError extends Error {}

export function segmentKey(prefix: string, fromLine: number, toLine: number): string {
  return `${prefix}${pad(fromLine)}-${pad(toLine)}.jsonl.zst`;
}

export function fullKey(prefix: string): string {
  return `${prefix}full.jsonl.zst`;
}

export function compress(text: string): Buffer {
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
}

export function decompress(b: Buffer): Buffer {
  return zlib.zstdDecompressSync(b);
}

/** Writes lines from..from+n-1 as one segment. */
export async function writeSegment(store: ObjectStore, prefix: string, fromLine: number, lines: string[]): Promise<string> {
  const key = segmentKey(prefix, fromLine, fromLine + lines.length - 1);
  await store.put(key, compress(lines.map(l => `${l}\n`).join('')), 'application/zstd');
  return key;
}

interface Part {
  key: string;
  from: number;
  to: number;
}

function parts(keys: string[], prefix: string): { full: string | null; segments: Part[] } {
  let full: string | null = null;
  const segments: Part[] = [];
  for (const key of keys) {
    const name = key.slice(prefix.length);
    if (name === 'full.jsonl.zst') full = key;
    const m = /^(\d+)-(\d+)\.jsonl\.zst$/.exec(name);
    if (m) segments.push({ key, from: Number(m[1]), to: Number(m[2]) });
  }
  segments.sort((a, b) => a.from - b.from || a.to - b.to);
  return { full, segments };
}

/**
 * The file content (lines 0..N with '\n') from full + segments. A segment that starts before the end of what is
 * assembled is trimmed, so re-sent chunks cannot duplicate lines.
 */
export async function assemble(store: ObjectStore, prefix: string): Promise<{ content: Buffer; lines: number; segments: Part[]; full: string | null }> {
  // The nightly merge may replace segments by full.jsonl.zst between list and get: then the list is read again.
  for (let attempt = 0; ; attempt++) {
    const r = await assembleOnce(store, prefix);
    if (r || attempt >= 2) {
      if (!r) throw new Error(`raw parts of ${prefix} keep disappearing`);
      return r;
    }
  }
}

async function assembleOnce(store: ObjectStore, prefix: string): Promise<{ content: Buffer; lines: number; segments: Part[]; full: string | null } | null> {
  const { full, segments } = parts(await store.list(prefix), prefix);
  const chunks: Buffer[] = [];
  let lines = 0;
  if (full) {
    const got = await store.get(full);
    if (!got) return null;
    const b = decompress(got);
    chunks.push(b);
    lines = countLines(b);
  }
  for (const s of segments) {
    if (s.to < lines) continue;
    if (s.from > lines) throw new RawGapError(`raw segments of ${prefix} have a gap at line ${lines} (next starts at ${s.from})`);
    const got = await store.get(s.key);
    if (!got) return null;
    let b = decompress(got);
    if (s.from < lines) b = dropLines(b, lines - s.from);
    chunks.push(b);
    lines = s.to + 1;
  }
  return { content: Buffer.concat(chunks), lines, segments, full };
}

/** Joins the segments into full.jsonl.zst and deletes them (nightly merge). Returns the number of merged segments. */
export async function mergeSegments(store: ObjectStore, prefix: string): Promise<number> {
  const a = await assemble(store, prefix);
  if (a.segments.length === 0) return 0;
  await store.put(fullKey(prefix), zlib.zstdCompressSync(a.content), 'application/zstd');
  await store.delete(a.segments.map(s => s.key));
  return a.segments.length;
}

function countLines(b: Buffer): number {
  let n = 0;
  for (let i = b.indexOf(0x0a); i >= 0; i = b.indexOf(0x0a, i + 1)) n++;
  return n;
}

function dropLines(b: Buffer, n: number): Buffer {
  let pos = 0;
  for (let i = 0; i < n; i++) {
    const nl = b.indexOf(0x0a, pos);
    if (nl < 0) return Buffer.alloc(0);
    pos = nl + 1;
  }
  return b.subarray(pos);
}

/** Splits buffers into '\n'-terminated lines (text without '\n'); an unfinished tail waits for the next buffer. */
async function* splitRaw(chunks: AsyncIterable<Buffer>): AsyncGenerator<string> {
  let rest: Buffer = Buffer.alloc(0);
  for await (const c of chunks) {
    const buf = rest.length ? Buffer.concat([rest, c]) : c;
    let start = 0;
    for (let nl = buf.indexOf(0x0a); nl >= 0; nl = buf.indexOf(0x0a, start)) {
      yield buf.subarray(start, nl).toString('utf8');
      start = nl + 1;
    }
    rest = Buffer.from(buf.subarray(start));
  }
}

/**
 * The first `limit` lines of a raw copy, read in order and only as far as needed (review M3c: a live copy is compared
 * with a 40 MB import without assembling it): segments are fetched one by one and dropped after use; a merged
 * full.jsonl.zst is decompressed as a stream. A gap before `limit` throws RawGapError.
 */
export async function* rawLines(store: ObjectStore, prefix: string, limit: number): AsyncGenerator<string> {
  if (limit <= 0) return;
  let lines = 0; // lines yielded so far
  // An object may disappear between list and get (the nightly merge replaces segments by full): the list is read once
  // more and reading goes on from the same line; a second loss or a real gap is a RawGapError.
  for (let relisted = false; ; relisted = true) {
    const { full, segments } = parts(await store.list(prefix), prefix);
    let at = 0; // position in this listing
    let lost: string | null = null;
    if (full) {
      const got = await store.get(full);
      if (!got) lost = full;
      else {
        const z = zlib.createZstdDecompress();
        z.end(got);
        for await (const l of splitRaw(z as AsyncIterable<Buffer>)) {
          if (at++ < lines) continue;
          yield l;
          if (++lines >= limit) {
            z.destroy();
            return;
          }
        }
      }
    }
    if (!lost) {
      for (const s of segments) {
        if (s.to < Math.max(at, lines)) {
          at = Math.max(at, s.to + 1);
          continue;
        }
        if (s.from > Math.max(at, lines)) throw new RawGapError(`raw segments of ${prefix} have a gap at line ${Math.max(at, lines)} (next starts at ${s.from})`);
        const got = await store.get(s.key);
        if (!got) {
          lost = s.key;
          break;
        }
        const skip = Math.max(at, lines) - s.from;
        let b = decompress(got);
        if (skip > 0) b = dropLines(b, skip);
        at = s.from + Math.max(skip, 0);
        for await (const l of splitRaw([b] as unknown as AsyncIterable<Buffer>)) {
          at++;
          yield l;
          if (++lines >= limit) return;
        }
      }
    }
    if (!lost) throw new RawGapError(`raw copy of ${prefix} has ${lines} lines, ${limit} expected`);
    if (relisted) throw new RawGapError(`raw object ${lost} disappeared twice`);
  }
}
