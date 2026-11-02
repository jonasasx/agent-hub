// Task 2.7 (agent side): complete lines only, acks drive the cursor, truncation starts a new generation.
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CHUNK_MAX_LINES, SKIPPED_LINE_TYPE, encodeCwd, readLines } from './tailer.js';

const root = mkdtempSync(join(tmpdir(), 'agenthub-tail-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('encodeCwd', () => {
  it('matches Claude Code project directory names', () => {
    expect(encodeCwd('C:\\Users\\alice\\vault')).toBe('C--Users-alice-vault');
    expect(encodeCwd('/home/alice')).toBe('-home-alice');
  });
});

describe('readLines', () => {
  it('returns complete lines only; the unfinished one waits', async () => {
    const f = join(root, 'a.jsonl');
    writeFileSync(f, '{"a":1}\n{"b":2}\n{"c":');
    const r = await readLines(f, 0, 21);
    expect(r).toEqual({ lines: ['{"a":1}', '{"b":2}'], endByte: 16 });
    expect(await readLines(f, 16, 21)).toBeNull();
  });

  it('caps a chunk at 500 lines and returns a line longer than the window alone', async () => {
    const f = join(root, 'b.jsonl');
    writeFileSync(f, 'x\n'.repeat(CHUNK_MAX_LINES + 20));
    const r = await readLines(f, 0, (CHUNK_MAX_LINES + 20) * 2);
    expect(r!.lines).toHaveLength(CHUNK_MAX_LINES);
    const long = join(root, 'c.jsonl');
    const big = 'y'.repeat(5 * 1024 * 1024);
    writeFileSync(long, `${big}\nz\n`);
    const r2 = await readLines(long, 0, big.length + 3);
    expect(r2!.lines[0]!.length).toBe(big.length);
  });
});

describe('long lines', () => {
  it('a line longer than the hard limit becomes a marker line once its end is written', async () => {
    const f = join(root, 'huge.jsonl');
    writeFileSync(f, 'h'.repeat(3000));
    expect(await readLines(f, 0, 3000, 1024)).toBeNull(); // end not written yet
    appendFileSync(f, '\n{"n":2}\n');
    const r = await readLines(f, 0, 3009, 1024);
    expect(r).toEqual({ lines: [JSON.stringify({ type: SKIPPED_LINE_TYPE, bytes: 3000 })], endByte: 3001, skipped: 3000 });
    expect(await readLines(f, 3001, 3009, 1024)).toEqual({ lines: ['{"n":2}'], endByte: 3009 });
  });
});
