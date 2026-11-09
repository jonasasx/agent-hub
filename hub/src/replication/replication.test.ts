// Tasks 3.4–3.6: replication of transcripts started outside the hub, against a real hub, Postgres and a memory S3.
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EventsPage, SessionView, SidebarResponse } from '@agent-hub/shared';
import { PUBLIC_URL, agentSend, autoReply, connectFakeAgent, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';
import type { MemoryStore } from '../storage/objectStore.js';
import * as F from '../test/transcriptFixtures.js';
import { assemble, decompress, rawPrefix } from './raw.js';
import { backfillPayloads } from './backfill.js';

const VAULT = 'C:\\Users\\alice\\vault';
const DIR = 'c--Users-alice-vault';

describe('replication of all transcripts (integration)', () => {
  let t: TestHub;
  let cookie: string;
  let agent: FakeAgent;
  let token: string;
  const got: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const api = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    t.hub.app.inject({ method, url, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, ...(payload !== undefined ? { payload: payload as object } : {}) });

  async function startAgent() {
    const a = connectFakeAgent(t.wsBase, token);
    a.ws.on('message', d => got.push(JSON.parse(d.toString()) as { type: string; payload: Record<string, unknown> }));
    autoReply(a, (type, p) => {
      // Directories exist; transcripts are «deleted» on this machine (the restore test relies on it).
      if (type === 'fs.stat') return String(p.path).endsWith('.jsonl') ? { exists: false, isDir: false } : { exists: true, isDir: true };
      if (type === 'session.resume') return { models: [] };
      if (type === 'file.restore') return { path: 'x' };
      return {};
    });
    await a.next('welcome');
    return a;
  }

  /** Sends the lines as one chunk from `from` and waits for its ack. */
  async function chunk(sessionId: string, lines: unknown[], o: { from?: number; relPath?: string; kind?: 'main' | 'subagent'; agentId?: string } = {}) {
    const relPath = o.relPath ?? `${DIR}/${sessionId}.jsonl`;
    const texts = lines.map(l => JSON.stringify(l));
    const acks = got.filter(m => m.type === 'repl.ack' && m.payload.relPath === relPath).length;
    agentSend(agent, 'repl.chunk', {
      relPath,
      kind: o.kind ?? 'main',
      sessionId,
      ...(o.agentId ? { agentId: o.agentId } : {}),
      generation: 0,
      fromLine: o.from ?? 0,
      fromByte: 0,
      lines: texts,
      endByte: 1000 * ((o.from ?? 0) + texts.length),
    });
    return waitFor(() => got.filter(m => m.type === 'repl.ack' && m.payload.relPath === relPath)[acks]);
  }

  const sessionOf = async (claudeId: string) => {
    const r = await t.tdb.pool.query<{ id: string }>(`SELECT id FROM sessions WHERE claude_session_id = $1`, [claudeId]);
    if (!r.rows[0]) return null;
    return (await api('GET', `/api/sessions/${r.rows[0].id}`)).json() as SessionView;
  };

  beforeAll(async () => {
    t = await startTestHub({ sessions: { idleCheckMs: 0, initTimeoutMs: 2000 } });
    token = await t.addRunner('x1', 'X1');
    cookie = await t.login();
    agent = await startAgent();
  });
  afterAll(async () => t.close());

  it('3.4: no base64 and no string >16 KB in payload; Read image is one S3 object; image $blob has width/height', async () => {
    const sid = randomUUID();
    const o = { sessionId: sid, cwd: VAULT, entrypoint: 'cli' as const };
    const readPng = F.png(925, 83);
    const shot = F.png(1280, 720);
    const pasted = F.png(640, 480);
    await chunk(sid, [F.userText(o, 'покажи файлы'), F.readImage(o, readPng), F.mcpScreenshot(o, shot), F.pastedImage(o, pasted), F.bigBash(o), F.attachment(o)]);
    const s = (await sessionOf(sid))!;
    const page = (await api('GET', `/api/sessions/${s.id}/events?limit=500`)).json() as EventsPage;
    expect(page.events).toHaveLength(5); // attachment is raw only
    const json = JSON.stringify(page.events);
    expect(json).not.toContain(readPng.toString('base64').slice(0, 200));
    expect(json).not.toContain(shot.toString('base64').slice(0, 200));
    for (const e of page.events) {
      const walk = (v: unknown): void => {
        if (typeof v === 'string') expect(v.length).toBeLessThanOrEqual(16 * 1024);
        else if (v && typeof v === 'object') Object.values(v).forEach(walk);
      };
      walk(e);
    }
    const store = t.store as MemoryStore;
    const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    expect(store.objects.has(`blobs/${sha(readPng)}`)).toBe(true);
    expect([...store.objects.keys()].filter(k => k === `blobs/${sha(readPng)}`)).toHaveLength(1);
    const read = page.events[1]!;
    if (read.kind !== 'line') throw new Error('line expected');
    const block = (read.line.message as { content: Array<{ content: Array<{ source: Record<string, unknown> }> }> }).content[0]!.content[0]!.source;
    expect(block).toMatchObject({ $blob: sha(readPng), mime: 'image/png', width: 925, height: 83, size: readPng.length });
    expect((read.line.toolUseResult as { file: { base64: unknown } }).file.base64).toMatchObject({ $blob: sha(readPng), width: 925, height: 83 });
    const big = page.events[4]!;
    if (big.kind !== 'line') throw new Error('line expected');
    const content = (big.line.message as { content: Array<{ content: { $blob: string; preview: string; mime: string } }> }).content[0]!.content;
    expect(content.mime).toBe('text/plain; charset=utf-8');
    expect(content.preview.length).toBe(2000);
    expect(store.objects.get(`blobs/${content.$blob}`)!.body.length).toBeGreaterThan(200_000);
    const blobRows = await t.tdb.pool.query(`SELECT width, height FROM blobs WHERE sha256 = $1`, [sha(shot)]);
    expect(blobRows.rows[0]).toEqual({ width: 1280, height: 720 });
  });

  // Requirement: Хранение событий без больших полезных нагрузок (QA M3a: structured copies stayed in Postgres).
  const blobOf = (store: MemoryStore, ref: { $blob: string }) => JSON.parse(store.objects.get(`blobs/${ref.$blob}`)!.body.toString('utf8')) as unknown;
  const checkCopies = (line: Record<string, unknown>, mcp: Record<string, unknown>, store: MemoryStore) => {
    for (const l of [line, mcp]) expect(Buffer.byteLength(JSON.stringify(l))).toBeLessThan(16 * 1024 + 4 * 1024);
    const tur = line.toolUseResult as { $blob: string; mime: string; preview: string; structuredPatch: unknown };
    expect(tur.mime).toBe('application/json');
    expect(tur.preview.length).toBeLessThanOrEqual(2000);
    expect(tur.structuredPatch).toEqual([{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }]);
    expect(blobOf(store, tur)).toMatchObject({ filePath: 'a.md', bashEditDiff: { files: [{ hunks: [{}] }] } });
    const meta = mcp.mcpMeta as { structuredContent: { $blob: string; mime: string; preview: string; size: number }; _meta: unknown };
    expect(meta._meta).toEqual({ 'claude/x': 1 });
    expect(meta.structuredContent.mime).toBe('application/json');
    expect(meta.structuredContent.size).toBeGreaterThan(300_000);
    expect((blobOf(store, meta.structuredContent) as { result: unknown[] }).result).toHaveLength(1500);
    expect(mcp.toolUseResult).toEqual([{ type: 'text', text: 'ok: 1500 events' }]); // small copies stay inline
  };

  it('D4: toolUseResult 200 KB and mcpMeta.structuredContent 300 KB of short strings go to S3; Edit diff stays', async () => {
    const sid = randomUUID();
    const o = { sessionId: sid, cwd: VAULT, entrypoint: 'cli' as const };
    const edit = F.bigEdit(o);
    const mcp = F.mcpStructured(o);
    expect(Buffer.byteLength(JSON.stringify(edit.toolUseResult))).toBeGreaterThan(200_000);
    expect(Buffer.byteLength(JSON.stringify(mcp.mcpMeta.structuredContent))).toBeGreaterThan(300_000);
    await chunk(sid, [F.userText(o, 'правь'), edit, mcp]);
    const s = (await sessionOf(sid))!;
    const page = (await api('GET', `/api/sessions/${s.id}/events?limit=500`)).json() as EventsPage;
    const lines = page.events.flatMap(x => (x.kind === 'line' ? [x.line] : []));
    const e = lines.find(l => (l.message as { content: Array<{ tool_use_id?: string }> }).content[0]?.tool_use_id === 'toolu_edit');
    const m = lines.find(l => 'mcpMeta' in l);
    if (!e || !m) throw new Error('lines expected');
    checkCopies(e, m, t.store as MemoryStore);
    const sizes = await t.tdb.pool.query<{ n: number }>(`SELECT max(octet_length(payload::text))::int AS n FROM events WHERE session_id = $1`, [s.id]);
    expect(sizes.rows[0]!.n).toBeLessThan(20 * 1024);
  });

  it('D4 backfill: stored events with big copies are rewritten once; a second run changes nothing', async () => {
    const sid = randomUUID();
    const o = { sessionId: sid, cwd: VAULT, entrypoint: 'cli' as const };
    await chunk(sid, [F.userText(o, 'старое')]);
    const s = (await sessionOf(sid))!;
    const ev = (await t.tdb.pool.query<{ file_id: string }>(`SELECT file_id FROM events WHERE session_id = $1`, [s.id])).rows[0]!;
    // Lines as the hub stored them before the fix.
    const old = [F.bigEdit(o), F.mcpStructured(o)];
    for (const [i, l] of old.entries()) {
      await t.tdb.pool.query(`INSERT INTO events (file_id, generation, line_no, session_id, uuid, type, ts, payload) VALUES ($1, 0, $2, $3, $4, 'user', now(), $5)`, [
        ev.file_id,
        100 + i,
        s.id,
        l.uuid,
        JSON.stringify(l),
      ]);
    }
    const store = t.store as MemoryStore;
    const first = await backfillPayloads(t.tdb.db, store);
    expect(first.changed).toBe(2);
    expect(first.bytesAfter).toBeLessThan(first.bytesBefore / 10);
    const rows = (await t.tdb.pool.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM events WHERE session_id = $1 AND line_no >= 100 ORDER BY line_no`, [s.id])).rows;
    checkCopies(rows[0]!.payload, rows[1]!.payload, store);
    const blobRows = await t.tdb.pool.query(`SELECT count(*)::int AS n FROM blobs WHERE sha256 = $1`, [(rows[1]!.payload.mcpMeta as { structuredContent: { $blob: string } }).structuredContent.$blob]);
    expect(blobRows.rows[0]).toEqual({ n: 1 });
    const second = await backfillPayloads(t.tdb.db, store);
    expect(second.changed).toBe(0);
    expect(second.scanned).toBeGreaterThanOrEqual(0);
  });

  it('3.5: every chunk is a raw segment; assembled raw equals the file; nightly merge keeps it; restore link works once', async () => {
    const sid = randomUUID();
    const o = { sessionId: sid, cwd: VAULT, entrypoint: 'cli' as const };
    const l1 = [F.userText(o, 'раз'), F.attachment(o)];
    const l2 = [F.assistantText(o, 'два'), F.userText(o, 'три')];
    await chunk(sid, l1);
    await chunk(sid, l2, { from: 2 });
    await chunk(sid, l2, { from: 2 }); // lost ack: no second segment content
    const prefix = rawPrefix('x1', sid, `${DIR}/${sid}.jsonl`.toLowerCase(), 0);
    const expected = [...l1, ...l2].map(l => `${JSON.stringify(l)}\n`).join('');
    const a = await assemble(t.store, prefix);
    expect(a.content.toString('utf8')).toBe(expected);
    expect(a.lines).toBe(4);
    // merge (idle 24 h)
    await t.tdb.pool.query(`UPDATE transcript_files SET updated_at = now() - interval '25 hours' WHERE claude_session_id = $1`, [sid]);
    expect(await t.hub.sessions.replication!.mergeIdle()).toBeGreaterThanOrEqual(1);
    const keys = await t.store.list(prefix);
    expect(keys).toEqual([`${prefix}full.jsonl.zst`]);
    expect(decompress((await t.store.get(keys[0]!))!).toString('utf8')).toBe(expected);
    // restore link
    const s = (await sessionOf(sid))!;
    const row = (await t.tdb.pool.query(`SELECT * FROM sessions WHERE id = $1`, [s.id])).rows[0];
    const rep = t.hub.sessions.replication!;
    const file = (await rep.mainFile(row))!;
    const r = await rep.prepareRestore(row, file);
    expect(r.sha256).toBe(createHash('sha256').update(expected).digest('hex'));
    const bad = await t.hub.app.inject({ method: 'GET', url: r.url, headers: { authorization: 'Bearer nope' } });
    expect(bad.statusCode).toBe(401);
    const ok = await t.hub.app.inject({ method: 'GET', url: r.url, headers: { authorization: `Bearer ${token}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe(expected);
    expect((await t.hub.app.inject({ method: 'GET', url: r.url, headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(404);
  });

  it('3.5: message to a session whose .jsonl is missing on the machine restores it before resume', async () => {
    const sid = randomUUID();
    const o = { sessionId: sid, cwd: VAULT, entrypoint: 'cli' as const, ts: new Date(Date.now() - 3600_000).toISOString() };
    await chunk(sid, [F.userText(o, 'запомни слово барабан'), F.assistantText(o, 'Запомнил')]);
    const s = (await sessionOf(sid))!;
    const before = got.length;
    const m = await api('POST', `/api/sessions/${s.id}/messages`, { text: 'какое слово?', clientUuid: randomUUID() });
    expect(m.statusCode).toBe(202);
    // resume is sent before the 202 but reaches the scripted agent's socket a moment later
    await waitFor(() => got.slice(before).some(x => x.type === 'session.resume'));
    const after = got.slice(before).map(x => x.type);
    expect(after.indexOf('file.restore')).toBeGreaterThanOrEqual(0);
    expect(after.indexOf('file.restore')).toBeLessThan(after.indexOf('session.resume'));
    const stat = got.slice(before).find(x => x.type === 'fs.stat' && String(x.payload.path).endsWith('.jsonl'))!.payload;
    expect(stat.path).toBe(`C:\\Users\\alice\\.claude\\projects\\${DIR}\\${sid}.jsonl`);
    const fr = got.slice(before).find(x => x.type === 'file.restore')!.payload;
    expect(fr).toMatchObject({ sessionId: sid, cwd: VAULT });
    const page = (await api('GET', `/api/sessions/${s.id}/events`)).json() as EventsPage;
    expect(page.events.some(e => e.kind === 'note' && e.text.startsWith('The transcript was restored'))).toBe(true);
  });

  it('3.6: source by D5 on fixtures; Remote Control is a flag', async () => {
    const mk = async (cwd: string, lines: (o: F.LineOpts) => unknown[], id = randomUUID()) => {
      await chunk(id, lines({ sessionId: id, cwd }));
      return (await sessionOf(id))!;
    };
    const cliRc = await mk(VAULT, o => [F.userText({ ...o, entrypoint: 'cli' }, 'привет'), F.bridge(o)]);
    expect(cliRc).toMatchObject({ source: 'terminal', remoteControl: true, isCron: false, readOnlyReason: null });
    const orca = await mk('C:\\Users\\alice\\orca\\workspaces\\fleet-ops\\fat-agent', o => [F.userText({ ...o, entrypoint: 'cli' }, 'x'), F.bridge(o)]);
    expect(orca).toMatchObject({ source: 'orca', remoteControl: true });
    const desktop = await mk(
      VAULT,
      o => [F.userText({ ...o, entrypoint: 'sdk-cli' }, 'вопрос', 'human'), F.assistantText({ ...o, entrypoint: 'sdk-cli' }, 'ответ')],
      'cc291a76-eb90-59b0-a1b9-9176313c9413',
    );
    expect(desktop).toMatchObject({ source: 'desktop', remoteControl: false, readOnlyReason: null, isCron: false });
    const cron = await mk('/home/ubuntu/vault', o => [F.userText({ ...o, entrypoint: 'sdk-cli' }, 'отчёт', 'sdk'), F.assistantText({ ...o, entrypoint: 'sdk-cli' }, 'готово')]);
    expect(cron).toMatchObject({ source: 'cron', isCron: true, readOnlyReason: 'cron' });
    // dd346743: started in the terminal, continued in the desktop app, Remote Control on → desktop + RC, not cron.
    const dd = 'dd346743-9bbb-5c33-a0c4-38db15ed5df6';
    const o = { sessionId: dd, cwd: VAULT };
    await chunk(dd, [F.userText({ ...o, entrypoint: 'cli' }, 'начал в терминале'), F.bridge(o)]);
    expect(await sessionOf(dd)).toMatchObject({ source: 'terminal', remoteControl: true });
    await chunk(dd, [F.userText({ ...o, entrypoint: 'sdk-cli' }, 'продолжил в приложении', 'human')], { from: 2 });
    expect(await sessionOf(dd)).toMatchObject({ source: 'desktop', remoteControl: true, isCron: false, readOnlyReason: null });
    // cron sessions are hidden in the sidebar by default
    const sb = (await api('GET', '/api/sidebar')).json() as SidebarResponse;
    const ids = sb.projects.flatMap(p => p.sessions.map(x => x.id));
    expect(ids).not.toContain(cron.id);
    // a cron session is read-only
    expect((await api('POST', `/api/sessions/${cron.id}/messages`, { text: 'x', clientUuid: randomUUID() })).statusCode).toBe(423);
  });

  it('3.6: an empty or service-only file creates no session; the first stored line does; title from the first message', async () => {
    const sid = randomUUID();
    const o = { sessionId: sid, cwd: VAULT, entrypoint: 'cli' as const };
    await chunk(sid, [F.attachment(o), { type: 'last-prompt', sessionId: sid }]);
    expect(await sessionOf(sid)).toBeNull();
    const file = await t.tdb.pool.query(`SELECT session_id, acked_line::int AS l FROM transcript_files WHERE claude_session_id = $1`, [sid]);
    expect(file.rows[0]).toEqual({ session_id: null, l: 2 });
    await chunk(sid, [F.userText(o, 'Найди в логах ошибки таймаута за вчерашний день и составь отчёт')], { from: 2 });
    const s = (await sessionOf(sid))!;
    expect(s.title).toBe(`${'Найди в логах ошибки таймаута за вчерашний день и составь отчёт'.slice(0, 40)}…`);
    expect(s.status).toBe('closed');
    expect((await t.tdb.pool.query(`SELECT session_id FROM transcript_files WHERE claude_session_id = $1`, [sid])).rows[0].session_id).toBe(s.id);
    await chunk(sid, [F.aiTitle(o, 'Отчёт по таймаутам')], { from: 3 });
    expect((await sessionOf(sid))!.title).toBe('Отчёт по таймаутам');
  });

  it('D4: one transcript for C--… and c--… of the same Windows file; subagent lines are not in the chat', async () => {
    const sid = randomUUID();
    const o = { sessionId: sid, cwd: VAULT, entrypoint: 'cli' as const };
    await chunk(sid, [F.userText(o, 'первый')], { relPath: `C--Users-alice-vault/${sid}.jsonl` });
    await chunk(sid, [F.userText(o, 'первый'), F.assistantText(o, 'второй')], { relPath: `c--Users-alice-vault/${sid}.jsonl` });
    const files = await t.tdb.pool.query(`SELECT rel_path FROM transcript_files WHERE claude_session_id = $1`, [sid]);
    expect(files.rows).toEqual([{ rel_path: `c--Users-alice-vault/${sid}.jsonl` }]);
    const s = (await sessionOf(sid))!;
    expect(((await api('GET', `/api/sessions/${s.id}/events`)).json() as EventsPage).events).toHaveLength(2);
    await chunk(sid, [{ ...F.userText(o, 'задача субагента'), isSidechain: true }], { relPath: `${DIR}/${sid}/subagents/agent-a1.jsonl`, kind: 'subagent', agentId: 'a1' });
    expect(((await api('GET', `/api/sessions/${s.id}/events`)).json() as EventsPage).events).toHaveLength(2);
    expect((await t.tdb.pool.query(`SELECT count(*)::int AS n FROM events WHERE session_id = $1`, [s.id])).rows[0].n).toBe(3);
  });

  it('a terminal session written right now warns before resume (concurrent_external)', async () => {
    const sid = randomUUID();
    const o = { sessionId: sid, cwd: VAULT, entrypoint: 'cli' as const };
    await chunk(sid, [F.userText(o, 'пишу в терминале')]);
    const s = (await sessionOf(sid))!;
    expect(s.lastExternalWriteAt).not.toBeNull();
    const r = await api('POST', `/api/sessions/${s.id}/messages`, { text: 'x', clientUuid: randomUUID() });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: 'concurrent_external', message: 'Сессия, возможно, открыта в терминале на X1' });
  });
});
