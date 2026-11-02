// Reading transcript lines for replication (design D4): complete lines only, bounded chunks, oversized lines
// replaced by a marker. The replicator (replicator.ts) decides what to send.
import { open } from 'node:fs/promises';
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

export const CHUNK_MAX_LINES = 500;
export const CHUNK_MAX_BYTES = 4 * 1024 * 1024;
/** Line rules shared with the hub's Drive import (a longer line becomes a marker; the largest seen is 1.4 MB). */
export { LINE_HARD_LIMIT, SKIPPED_LINE_TYPE } from '@agent-hub/shared';
import { LINE_HARD_LIMIT, SKIPPED_LINE_TYPE } from '@agent-hub/shared';

/**
 * Reads complete lines from `from`: at most CHUNK_MAX_LINES lines / CHUNK_MAX_BYTES, but a single longer
 * line is returned alone. A line longer than LINE_HARD_LIMIT is replaced by a marker line (so the file does
 * not stall) once its end is on disk. An unfinished last line waits. Returns null if nothing is complete.
 */
export async function readLines(path: string, from: number, size: number, hardLimit = LINE_HARD_LIMIT): Promise<{ lines: string[]; endByte: number; skipped?: number } | null> {
  const fh = await open(path, 'r');
  try {
    let want = Math.min(size - from, CHUNK_MAX_BYTES);
    for (;;) {
      const buf = Buffer.alloc(want);
      const { bytesRead } = await fh.read(buf, 0, want, from);
      const data = buf.subarray(0, bytesRead);
      const lastNl = data.lastIndexOf(0x0a);
      if (lastNl < 0) {
        if (want >= hardLimit) return skipLongLine(fh, from, size);
        // One line longer than the window: grow the window up to the hard limit.
        if (from + want >= size) return null;
        want = Math.min(size - from, want * 2, hardLimit);
        continue;
      }
      const firstNl = data.indexOf(0x0a);
      if (firstNl > hardLimit) {
        return { lines: [JSON.stringify({ type: SKIPPED_LINE_TYPE, bytes: firstNl })], endByte: from + firstNl + 1, skipped: firstNl };
      }
      const lines: string[] = [];
      let start = 0;
      let end = 0;
      while (start <= lastNl && lines.length < CHUNK_MAX_LINES) {
        const nl = data.indexOf(0x0a, start);
        lines.push(data.subarray(start, nl).toString('utf8').replace(/\r$/, ''));
        start = nl + 1;
        end = start;
      }
      return { lines, endByte: from + end };
    }
  } finally {
    await fh.close();
  }
}

/** Finds the end of an oversized line by scanning 1 MB windows; null while its end is not written yet. */
async function skipLongLine(fh: Awaited<ReturnType<typeof open>>, from: number, size: number): Promise<{ lines: string[]; endByte: number; skipped: number } | null> {
  const step = 1024 * 1024;
  const buf = Buffer.alloc(step);
  for (let pos = from; pos < size; pos += step) {
    const { bytesRead } = await fh.read(buf, 0, Math.min(step, size - pos), pos);
    const nl = buf.subarray(0, bytesRead).indexOf(0x0a);
    if (nl >= 0) {
      const endByte = pos + nl + 1;
      return { lines: [JSON.stringify({ type: SKIPPED_LINE_TYPE, bytes: endByte - from - 1 })], endByte, skipped: endByte - from - 1 };
    }
  }
  return null;
}
