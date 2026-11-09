// Task 3.12: import:drive on a Drive fixture — runner by hostname, unknown host read-only, the same write path as
// replication (events, raw S3), a live session only gets its missing lines, a second run reports «новых 0».
// Requirements (history-import): Импорт из Drive vault-sessions; Идемпотентность и слияние с живой репликой; Отчёт и сверка.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryStore } from '../storage/objectStore.js';
import { createTestDb, type TestDb } from '../test/db.js';
import * as F from '../test/transcriptFixtures.js';
import { Replication } from '../replication/ingest.js';
import { runCli } from '../cliCommands.js';
import { googleDriveClient, unknownRunnerName, type DriveClient, type DriveFile } from './drive.js';
import type { AgentGateway } from '../runners/agentGateway.js';
import type { UiGateway } from '../ui/uiGateway.js';
import type { FastifyBaseLogger } from 'fastify';

const VAULT = 'C:\\Users\\alice\\vault';
const jsonl = (lines: unknown[]) => Buffer.from(lines.map(l => `${JSON.stringify(l)}\n`).join(''), 'utf8');

class FakeDrive implements DriveClient {
  files = new Map<string, { meta: DriveFile; body: Buffer }>();
  downloads = 0;
  add(name: string, body: Buffer, modifiedTime = '2026-10-01T00:00:00Z') {
    const id = `id${this.files.size}`;
    this.files.set(id, { meta: { id, name, modifiedTime, size: body.length }, body });
  }
  async listFolder(name: string) {
    return name === 'vault-sessions' ? [...this.files.values()].map(f => f.meta) : null;
  }
  /** Streams in 7-byte pieces: lines and multi-byte letters cross the piece boundaries. */
  async *download(id: string) {
    this.downloads++;
    const b = this.files.get(id)!.body;
    for (let i = 0; i < b.length; i += 7) yield b.subarray(i, i + 7);
  }
}

describe('import:drive (Postgres)', () => {
  let t: TestDb;
  const store = new MemoryStore();
  const replOpts = () => ({
    db: t.db,
    store,
    agents: { get: () => undefined } as unknown as AgentGateway,
    ui: { sendToSubscribers: () => undefined } as unknown as UiGateway,
    log: { warn: () => undefined, info: () => undefined, error: () => undefined } as unknown as FastifyBaseLogger,
    hooks: { upsert: async () => undefined, userLines: async () => undefined },
  });
  const drive = new FakeDrive();
  const hpOld = randomUUID();
  const live = randomUUID();
  const unknown = randomUUID();
  const headless = randomUUID();
  let repl: Replication;
  const counts = async () => {
    const q = async (sql: string) => Number((await t.pool.query<{ n: string }>(sql)).rows[0]!.n);
    return { sessions: await q('SELECT count(*) AS n FROM sessions'), events: await q('SELECT count(*) AS n FROM events') };
  };
  const cli = async (args: string[]) => {
    const out: string[] = [];
    const code = await runCli(['import:drive', ...args], t.db, s => out.push(s), {}, { store, drive });
    return { code, out };
  };

  beforeAll(async () => {
    t = await createTestDb();
    const uid = (await t.pool.query<{ id: string }>(`INSERT INTO users (email, role) VALUES ('alice@example.com', 'admin') RETURNING id`)).rows[0]!.id;
    await t.pool.query(`INSERT INTO runners (id, user_id, name, hostname, home_dir) VALUES ('hp', $1, 'HP', 'HP-Elitebook', 'C:\\Users\\alice')`, [uid]);
    // A session already replicated live: the hub has its first two lines.
    const oLive = { sessionId: live, cwd: VAULT, entrypoint: 'cli' as const };
    const liveLines = [F.userText(oLive, 'живая сессия'), F.assistantText(oLive, 'ответ 1'), F.userText(oLive, 'ещё вопрос'), F.assistantText(oLive, 'ответ 2')];
    repl = new Replication(replOpts());
    const full = jsonl(liveLines);
    const firstTwo = jsonl(liveLines.slice(0, 2));
    await repl.onChunk('hp', {
      relPath: `c--Users-alice-vault/${live}.jsonl`,
      kind: 'main',
      sessionId: live,
      generation: 0,
      fromLine: 0,
      fromByte: 0,
      lines: liveLines.slice(0, 2).map(l => JSON.stringify(l)),
      endByte: firstTwo.length,
    });
    await t.pool.query(`UPDATE sessions SET source = 'terminal' WHERE claude_session_id = $1`, [live]);

    const oOld = { sessionId: hpOld, cwd: `${VAULT}\\20-personal\\01-finance\\systems\\01-ledger`, entrypoint: 'cli' as const };
    drive.add(`${hpOld}__HP-Elitebook.jsonl`, jsonl([F.userText(oOld, 'импорт выписки ledger'), F.assistantText(oOld, 'Готово, барабан'), F.readImage(oOld, F.png(20, 10))]));
    drive.add(`${live}__HP-Elitebook.jsonl`, full);
    const oUnk = { sessionId: unknown, cwd: 'C:\\Users\\old\\vault', entrypoint: 'cli' as const };
    drive.add(`${unknown}__old-laptop.jsonl`, jsonl([F.userText(oUnk, 'сессия со старого ноутбука')]));
    // claude -p on the VM exported to Drive: sdk-cli, no human — cron by D5, not «импорт Drive».
    const oHl = { sessionId: headless, cwd: '/home/ubuntu/vault', entrypoint: 'sdk-cli' as const };
    await t.pool.query(`INSERT INTO runners (id, user_id, name, hostname, home_dir) VALUES ('vm', $1, 'ВМ .3', 'vault', '/home/ubuntu')`, [uid]);
    drive.add(`${headless}__vault.jsonl`, jsonl([F.userText(oHl, 'запусти скилл monitoring-report за вчера', 'sdk'), F.assistantText(oHl, 'Отчёт готов')]));
    drive.add('notes.txt', Buffer.from('x'));
  });
  afterAll(async () => t.drop());

  it('first run: new sessions on their runners, the live one gets its missing lines, the unknown host is read-only', async () => {
    const before = await counts();
    const r = await cli([]);
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).toContain('new 3, extended 1, lines 8');
    expect(r.out.join('\n')).toContain('check: session_id in Drive 4, in the hub 4, missing 0');
    expect(r.out.join('\n')).toContain('unknown machines (read only): old-laptop');
    const after = await counts();
    expect(after.sessions - before.sessions).toBe(3);
    expect(after.events - before.events).toBe(8);
    const rows = (await t.pool.query(`SELECT claude_session_id, runner_id, source, origin_source, read_only_reason, is_drive_import FROM sessions ORDER BY created_at`)).rows;
    // D5 is not bypassed: terminal lines stay terminal, the flag tells the import
    expect(rows.find(x => x.claude_session_id === hpOld)).toMatchObject({ runner_id: 'hp', source: 'terminal', origin_source: 'terminal', read_only_reason: null, is_drive_import: true });
    expect(rows.find(x => x.claude_session_id === live)).toMatchObject({ runner_id: 'hp', source: 'terminal', is_drive_import: false }); // the source is not changed
    // multi-user (design M3): the runner of an unknown host has a generated id and is the importing user's
    const unknownRunner = (await t.pool.query(`SELECT id FROM runners WHERE name = $1`, [unknownRunnerName('old-laptop')])).rows[0];
    expect(unknownRunner.id).toMatch(/^r-[a-z2-7]{10}$/);
    expect(rows.find(x => x.claude_session_id === unknown)).toMatchObject({ runner_id: unknownRunner.id, read_only_reason: 'unknown_runner', is_drive_import: true });
    expect(rows.find(x => x.claude_session_id === headless)).toMatchObject({ runner_id: 'vm', source: 'cron', origin_source: 'cron', read_only_reason: 'cron', is_drive_import: true });
    // the same write path: raw segments in S3, the image as a blob; no live copy yet → drive-import/<sid>.jsonl
    const f = (await t.pool.query(`SELECT rel_path, acked_line FROM transcript_files WHERE claude_session_id = $1`, [hpOld])).rows[0];
    expect(f).toMatchObject({ rel_path: `drive-import/${hpOld}.jsonl`, acked_line: '3' });
    expect([...store.objects.keys()].some(k => k.startsWith(`raw/hp/${hpOld}/`))).toBe(true);
    expect(Number((await t.pool.query(`SELECT count(*) AS n FROM blobs`)).rows[0].n)).toBe(1);
    expect(Number((await t.pool.query(`SELECT count(*) AS n FROM events WHERE tsv @@ websearch_to_tsquery('russian', 'барабан')`)).rows[0].n)).toBe(1);
    const run = (await t.pool.query(`SELECT finished_at, report FROM import_runs ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(run.finished_at).not.toBeNull();
    expect(run.report).toMatchObject({ sessionsNew: 3, sessionsExtended: 1, linesNew: 8, missingInHub: 0 });
  });

  it('the live copy of an imported session takes the import file over: one main transcript, cursor and raw moved', async () => {
    const files = async () => (await t.pool.query(`SELECT rel_path, rel_key, acked_line FROM transcript_files WHERE claude_session_id = $1 AND kind = 'main'`, [hpOld])).rows;
    const events = async () => Number((await t.pool.query(`SELECT count(*) AS n FROM events WHERE session_id = (SELECT id FROM sessions WHERE claude_session_id = $1)`, [hpOld])).rows[0].n);
    const body = drive.files.get('id0')!.body;
    const lines = body.toString('utf8').trim().split('\n');
    const live = `C--Users-alice-vault-20-personal-01-finance-systems-01-ledger/${hpOld}.jsonl`;
    // A chunk that does not start at line 0 cannot be compared: the agent is told to send from 0, nothing is created.
    const acks: unknown[] = [];
    const replAck = new Replication({ ...replOpts(), agents: { get: () => ({ send: (_t: string, a: unknown) => acks.push(a) }) } as unknown as AgentGateway });
    await replAck.onChunk('hp', { relPath: live, kind: 'main', sessionId: hpOld, generation: 0, fromLine: 3, fromByte: body.length, lines: ['{}'], endByte: body.length + 3 });
    expect(acks).toEqual([{ relPath: live, generation: 0, ackedLine: 0, ackedByte: 0 }]);
    expect((await files()).map(f => f.rel_path)).toEqual([`drive-import/${hpOld}.jsonl`]);
    // The agent of HP sends the file from line 0: the three exported lines plus one written after the export.
    const more = JSON.stringify(F.userText({ sessionId: hpOld, cwd: VAULT, entrypoint: 'cli' }, 'продолжение на машине'));
    await repl.onChunk('hp', { relPath: live, kind: 'main', sessionId: hpOld, generation: 0, fromLine: 0, fromByte: 0, lines: [...lines, more], endByte: body.length + Buffer.byteLength(more) + 1 });
    expect(await files()).toEqual([{ rel_path: live, rel_key: live.toLowerCase(), acked_line: '4' }]);
    expect(await events()).toBe(4); // no duplicates of the three imported lines
    expect([...store.objects.keys()].some(k => k.startsWith(`raw/hp/${hpOld}/${live.toLowerCase()}/g0/`))).toBe(true);
    expect([...store.objects.keys()].some(k => k.includes(`/drive-import/`) && k.includes(hpOld))).toBe(false);
    // the restore copy assembles from the moved raw segments plus the new one
    const { assemble, rawPrefix } = await import('../replication/raw.js');
    expect((await assemble(store, rawPrefix('hp', hpOld, live.toLowerCase(), 0))).content.toString('utf8').split('\n').filter(Boolean)).toHaveLength(4);
  });

  it('a live file that is another file than the import: the import is superseded (hidden), the live one is shown from line 0', async () => {
    const sid = randomUUID();
    const o = { sessionId: sid, cwd: VAULT, entrypoint: 'cli' as const };
    drive.add(`${sid}__HP-Elitebook.jsonl`, jsonl([F.userText(o, 'версия из Drive'), F.assistantText(o, 'старый ответ')]));
    expect((await cli([])).code).toBe(0);
    const rel = `c--Users-alice-vault/${sid}.jsonl`;
    const live = [F.userText(o, 'другой файл на машине'), F.assistantText(o, 'новый ответ'), F.userText(o, 'ещё')].map(l => JSON.stringify(l));
    await repl.onChunk('hp', { relPath: rel, kind: 'main', sessionId: sid, generation: 0, fromLine: 0, fromByte: 0, lines: live, endByte: live.reduce((a, l) => a + Buffer.byteLength(l) + 1, 0) });
    const rows = (await t.pool.query(`SELECT rel_path, acked_line, superseded_at IS NOT NULL AS superseded FROM transcript_files WHERE claude_session_id = $1 ORDER BY id`, [sid])).rows;
    expect(rows).toEqual([
      { rel_path: `drive-import/${sid}.jsonl`, acked_line: '2', superseded: true },
      { rel_path: rel, acked_line: '3', superseded: false },
    ]);
    const hubId = (await t.pool.query(`SELECT id FROM sessions WHERE claude_session_id = $1`, [sid])).rows[0].id as string;
    const { eventsPage, cursorsForRunner } = await import('../sessions/repo.js');
    const page = await eventsPage(t.db, hubId, undefined, 100);
    const texts = page.events.flatMap(e => (e.kind === 'line' ? [JSON.stringify(e.line)] : []));
    expect(texts.some(x => x.includes('другой файл на машине'))).toBe(true);
    expect(texts.some(x => x.includes('версия из Drive'))).toBe(false); // hidden, not mixed in
    expect(page.events.filter(e => e.kind === 'line')).toHaveLength(3);
    // the agent never gets the cursor of an import file
    expect((await cursorsForRunner(t.db, 'hp')).some(c => c.relPath.startsWith('drive-import/'))).toBe(false);
    // a re-run of the import: the live file is the session's transcript now, the export differs → skipped, no change
    const again = await cli([]);
    expect(again.out.join('\n')).toContain('new 0, extended 0, lines 0');
    expect((await t.pool.query(`SELECT count(*)::int AS n FROM transcript_files WHERE claude_session_id = $1`, [sid])).rows[0].n).toBe(2);
  });

  it('import:drive does not make a second main transcript when the live copy appeared meanwhile', async () => {
    const sid = randomUUID();
    const o = { sessionId: sid, cwd: VAULT, entrypoint: 'cli' as const };
    const line = JSON.stringify(F.userText(o, 'живая'));
    await repl.onChunk('hp', {
      relPath: `c--Users-alice-vault/${sid}.jsonl`,
      kind: 'main',
      sessionId: sid,
      generation: 0,
      fromLine: 0,
      fromByte: 0,
      lines: [line],
      endByte: Buffer.byteLength(line) + 1,
    });
    await expect(
      repl.onChunk(
        'hp',
        { relPath: `drive-import/${sid}.jsonl`, kind: 'main', sessionId: sid, generation: 0, fromLine: 0, fromByte: 0, lines: [line], endByte: Buffer.byteLength(line) + 1 },
        { driveImport: true },
      ),
    ).rejects.toThrow(/already has a main transcript/);
    expect((await t.pool.query(`SELECT count(*)::int AS n FROM transcript_files WHERE claude_session_id = $1`, [sid])).rows[0].n).toBe(1);
  });

  it('runner:set-hostname maps the exports of a machine before its agent connects; the report is split by runner', async () => {
    const out: string[] = [];
    expect(await runCli(['runner:set-hostname', 'vm', 'HP-Elitebook'], t.db, x => out.push(x), {})).toBe(1); // taken by hp
    expect(out.at(-1)).toBe('hostname HP-Elitebook already belongs to runner hp');
    await t.pool.query(`INSERT INTO runners (id, user_id, name) SELECT 'x1', user_id, 'X1' FROM runners WHERE id = 'hp'`);
    expect(await runCli(['runner:set-hostname', 'x1', 'X1-Carbon-Gen13'], t.db, x => out.push(x), {})).toBe(0);
    expect(await runCli(['runner:set-hostname', 'nope', 'h'], t.db, x => out.push(x), {})).toBe(1);
    const sid = randomUUID();
    drive.add(`${sid}__X1-Carbon-Gen13.jsonl`, jsonl([F.userText({ sessionId: sid, cwd: VAULT, entrypoint: 'cli' }, 'с X1')]));
    const r = await cli([]);
    expect(r.out).toContain('  x1: new 1, extended 0, lines 1');
    expect((await t.pool.query(`SELECT runner_id, rel_path FROM transcript_files WHERE claude_session_id = $1`, [sid])).rows[0]).toEqual({ runner_id: 'x1', rel_path: `drive-import/${sid}.jsonl` });
  });

  it('streamLines cuts like the agent: empty lines count, \\r dropped, an unfinished tail is not a line, a long line is a marker', async () => {
    const { streamLines } = await import('./drive.js');
    async function* pieces(...p: string[]) {
      for (const x of p) yield Buffer.from(x, 'utf8');
    }
    const got: Array<{ text: string; end: number }> = [];
    for await (const l of streamLines(pieces('{"a":1}\r\n', '\n{"б":"', 'в"}\n', `${'x'.repeat(20)}\n`, `${'y'.repeat(12)}\n`, `${'z'.repeat(11)}\n`, '{"tail":'), 12)) got.push(l);
    // 12 bytes = the limit → a marker (as the agent: its 12-byte window never holds the \n); 11 bytes → the line
    expect(got.map(l => l.text)).toEqual([
      '{"a":1}',
      '',
      '{"б":"в"}',
      JSON.stringify({ type: 'agent-hub-skipped-line', bytes: 20 }),
      JSON.stringify({ type: 'agent-hub-skipped-line', bytes: 12 }),
      'z'.repeat(11),
    ]);
    expect(got.map(l => l.end)).toEqual([9, 10, 22, 43, 56, 68]);
  });

  it('second run: «новых 0», nothing changes', async () => {
    const before = await counts();
    const r = await cli([]);
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).toContain('new 0, extended 0, lines 0');
    expect(r.out.join('\n')).toMatch(/already_complete \d+/);
    expect(await counts()).toEqual(before);
    // the unknown machine is found again by its name: no second runner
    expect(Number((await t.pool.query(`SELECT count(*) AS n FROM runners WHERE name = $1`, [unknownRunnerName('old-laptop')])).rows[0].n)).toBe(1);
  });

  it('dry run changes nothing; an export that differs from the live copy is skipped; a missing folder is an error', async () => {
    const other = randomUUID();
    const o = { sessionId: other, cwd: VAULT, entrypoint: 'cli' as const };
    drive.add(`${other}__HP-Elitebook.jsonl`, jsonl([F.userText(o, 'новая')]));
    const before = await counts();
    const dry = await cli(['--dry-run']);
    expect(dry.out.join('\n')).toContain('dry run: Drive');
    expect(dry.out.join('\n')).toContain('new 1');
    expect(await counts()).toEqual(before);
    // The live session's file was rewritten on the machine: the Drive copy is another file now.
    await t.pool.query(`UPDATE transcript_files SET acked_byte = acked_byte + 1 WHERE claude_session_id = $1`, [live]);
    drive.add(`${live}__HP-Elitebook.jsonl`, Buffer.concat([drive.files.get('id1')!.body, jsonl([F.userText({ sessionId: live, cwd: VAULT }, 'хвост')])]), '2026-10-02T00:00:00Z');
    const r = await cli([]);
    expect(r.out.join('\n')).toContain('differs_from_live 1');
    await expect(runCli(['import:drive', '--folder', 'nope'], t.db, () => undefined, {}, { store, drive })).rejects.toThrow(/not found/);
  });

  // Change multi-user, task 3.6: hostnames are matched among the runners of the importing user only.
  it('two users with the same hostname: the import for the second does not write into the runner of the first', async () => {
    const u2 = (await t.pool.query<{ id: string }>(`INSERT INTO users (email) VALUES ('bob@example.com') RETURNING id`)).rows[0]!.id;
    await t.pool.query(`INSERT INTO runners (id, user_id, name, hostname, home_dir) VALUES ('r-bob00hp', $1, 'HP', 'HP-Elitebook', 'C:\\Users\\bob')`, [u2]);
    const sid = randomUUID();
    const o = { sessionId: sid, cwd: 'C:\\Users\\bob\\code', entrypoint: 'cli' as const };
    drive.add(`${sid}__HP-Elitebook.jsonl`, jsonl([F.userText(o, 'сессия Кати'), F.assistantText(o, 'ответ')]));
    const r = await cli(['--user', 'bob@example.com']);
    expect(r.code).toBe(0);
    const row = (await t.pool.query(`SELECT runner_id, user_id FROM sessions WHERE claude_session_id = $1`, [sid])).rows[0];
    expect(row).toEqual({ runner_id: 'r-bob00hp', user_id: u2 });
    expect(Number((await t.pool.query(`SELECT count(*) AS n FROM sessions WHERE runner_id = 'hp' AND user_id = $1`, [u2])).rows[0].n)).toBe(0);
  });

  it('googleDriveClient: refreshes the token in memory, pages the folder, downloads with the bearer', async () => {
    const calls: string[] = [];
    const fake = (async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
      calls.push(`${url} ${init?.headers?.authorization ?? ''}`);
      if (url.startsWith('https://oauth2.googleapis.com/token')) return Response.json({ access_token: 'at1', expires_in: 3600 });
      if (url.includes('mimeType')) return Response.json({ files: [{ id: 'F' }] });
      if (url.includes('in%20parents') && !url.includes('pageToken'))
        return Response.json({ nextPageToken: 'p2', files: [{ id: 'a', name: 'a__h.jsonl', modifiedTime: '2026-01-01T00:00:00Z', size: '3' }] });
      if (url.includes('pageToken=p2')) return Response.json({ files: [{ id: 'b', name: 'b__h.jsonl', modifiedTime: '2026-01-01T00:00:00Z' }] });
      if (url.includes('alt=media')) return new Response('{}\n');
      return new Response('no', { status: 404 });
    }) as unknown as typeof fetch;
    const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'agenthub-drive-'));
    try {
      const file = join(dir, 'token.json');
      writeFileSync(file, JSON.stringify({ token: 'old', refresh_token: 'rt', client_id: 'cid', client_secret: 'cs', token_uri: 'https://oauth2.googleapis.com/token' }));
      const c = await googleDriveClient(file, fake);
      expect((await c.listFolder('vault-sessions'))!.map(f => f.name)).toEqual(['a__h.jsonl', 'b__h.jsonl']);
      const parts: Uint8Array[] = [];
      for await (const x of c.download('a')) parts.push(x);
      expect(Buffer.concat(parts).toString()).toBe('{}\n');
      expect(calls.filter(x => x.startsWith('https://oauth2'))).toHaveLength(1);
      expect(calls.filter(x => x.includes('googleapis.com/drive')).every(x => x.endsWith('Bearer at1'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
