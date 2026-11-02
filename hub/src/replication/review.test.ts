// Review M3a: the chat does not depend on S3, restore of an incomplete copy, old generations, restore links,
// assembly racing the merge, side.ack.
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EventsPage, SessionView } from '@agent-hub/shared';
import { PUBLIC_URL, agentSend, autoReply, connectFakeAgent, connectUi, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';
import { MemoryStore } from '../storage/objectStore.js';
import * as F from '../test/transcriptFixtures.js';
import { RESTORE_LINKS } from './ingest.js';
import { assemble, compress, rawPrefix, segmentKey, writeSegment } from './raw.js';

/** A memory store whose writes can be switched off (S3 outage). */
class FlakyStore extends MemoryStore {
  down = false;
  readsDown = false;
  override get(key: string): Promise<Buffer | null> {
    if (this.readsDown) return Promise.reject(new Error('S3 unavailable'));
    return super.get(key);
  }
  override put(key: string, body: Buffer, contentType?: string): Promise<void> {
    if (this.down) return Promise.reject(new Error('S3 unavailable'));
    return super.put(key, body, contentType);
  }
}

const VAULT = 'C:\\Users\\alice\\vault';
const DIR = 'c--Users-alice-vault';

describe('review M3a (integration)', () => {
  let t: TestHub;
  let cookie: string;
  let agent: FakeAgent;
  let token: string;
  const store = new FlakyStore();
  const got: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const api = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    t.hub.app.inject({ method, url, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const acks = (relPath: string) => got.filter(m => m.type === 'repl.ack' && m.payload.relPath === relPath);
  const send = (sessionId: string, lines: unknown[], from = 0, relPath = `${DIR}/${sessionId}.jsonl`, generation = 0) =>
    agentSend(agent, 'repl.chunk', {
      relPath,
      kind: 'main',
      sessionId,
      generation,
      fromLine: from,
      fromByte: 0,
      lines: lines.map(l => JSON.stringify(l)),
      endByte: 100 * (from + lines.length),
      ...(generation ? { rewrite: true } : {}),
    });
  const sessionOf = async (claudeId: string) => {
    const r = await t.tdb.pool.query<{ id: string }>(`SELECT id FROM sessions WHERE claude_session_id = $1`, [claudeId]);
    return r.rows[0] ? ((await api('GET', `/api/sessions/${r.rows[0].id}`)).json() as SessionView) : null;
  };

  beforeAll(async () => {
    t = await startTestHub({ store, sessions: { idleCheckMs: 0 } });
    token = await t.addRunner('x1', 'X1');
    cookie = await t.login();
    agent = connectFakeAgent(t.wsBase, token);
    agent.ws.on('message', d => got.push(JSON.parse(d.toString()) as { type: string; payload: Record<string, unknown> }));
    autoReply(agent, (type, p) => (type === 'fs.stat' ? (String(p.path).endsWith('.jsonl') ? { exists: false, isDir: false } : { exists: true, isDir: true }) : {}));
    await agent.next('welcome');
  });
  afterAll(async () => t.close());
  // a failed test must not leave S3 «down» for the next ones (one failure used to fail the whole file)
  afterEach(() => {
    store.down = false;
    store.readsDown = false;
  });

  it('S3 down: events are in the chat, no ack; S3 back: the re-sent chunk is acked, the segment is in S3, no duplicates', async () => {
    const sid = randomUUID();
    const o = { sessionId: sid, cwd: VAULT, entrypoint: 'cli' as const };
    const rel = `${DIR}/${sid}.jsonl`;
    const lines = [F.userText(o, 'вопрос без S3'), F.assistantText(o, 'ответ без S3'), F.readImage(o, F.png(10, 10))];
    // a subscribed browser
    send(sid, [F.userText(o, 'первая')]);
    await waitFor(() => acks(rel).length === 1);
    const s = (await sessionOf(sid))!;
    const ui = connectUi(t.wsBase, cookie);
    await ui.open;
    ui.send({ type: 'subscribe', sessionIds: [s.id] });
    // the subscription is registered before the chunk (a fixed pause was too short under a full parallel run)
    await waitFor(() => t.hub.ui.isSubscribed(s.id));

    store.down = true;
    send(sid, lines, 1);
    await waitFor(async () => ((await api('GET', `/api/sessions/${s.id}/events`)).json() as EventsPage).events.length === 4);
    await new Promise(r => setTimeout(r, 300));
    expect(acks(rel)).toHaveLength(1); // no ack while S3 is down
    const pushed = () => ui.received.filter(m => m.type === 'session.events').flatMap(m => (m.events as Array<{ id: string }>).map(e => e.id));
    expect(pushed()).toHaveLength(3);
    const cur = await t.tdb.pool.query(`SELECT acked_line::int AS l FROM transcript_files WHERE claude_session_id = $1`, [sid]);
    expect(cur.rows[0].l).toBe(1);

    store.down = false;
    send(sid, lines, 1); // the agent re-sends after its ack timeout
    await waitFor(() => acks(rel).length === 2);
    expect(acks(rel)[1]!.payload).toMatchObject({ ackedLine: 4 });
    expect((await t.tdb.pool.query(`SELECT count(*)::int AS n FROM events e JOIN sessions s ON s.id = e.session_id WHERE s.claude_session_id = $1`, [sid])).rows[0].n).toBe(4);
    expect(pushed()).toHaveLength(3); // the same events are not pushed again
    expect(new Set(pushed()).size).toBe(3);
    const a = await assemble(store, rawPrefix('x1', sid, rel.toLowerCase(), 0));
    expect(a.lines).toBe(4);
    const png = F.png(10, 10);
    expect(store.objects.has(`blobs/${createHash('sha256').update(png).digest('hex')}`)).toBe(true);
    ui.ws.close();
  });

  it('restore of a session whose raw copy has a gap → 423 with the Russian text, not 500', async () => {
    const sid = randomUUID();
    const o = { sessionId: sid, cwd: VAULT, entrypoint: 'cli' as const, ts: new Date(Date.now() - 3600_000).toISOString() };
    const rel = `${DIR}/${sid}.jsonl`;
    send(sid, [F.userText(o, 'раз'), F.assistantText(o, 'два')]);
    await waitFor(() => acks(rel).length === 1);
    // An M2-era file: events without the first raw segment.
    await store.delete(await store.list(rawPrefix('x1', sid, rel.toLowerCase(), 0)));
    await store.put(segmentKey(rawPrefix('x1', sid, rel.toLowerCase(), 0), 5, 6), compress('{}\n{}\n'));
    const s = (await sessionOf(sid))!;
    const r = await api('POST', `/api/sessions/${s.id}/messages`, { text: 'ещё', clientUuid: randomUUID() });
    expect(r.statusCode).toBe(423);
    expect(r.json()).toEqual({ error: 'read_only', message: 'История в хабе неполная — продолжить можно только на машине, где лежит файл' });
  });

  it('restore while S3 cannot be read → 503 restore_unavailable', async () => {
    const sid = randomUUID();
    const o = { sessionId: sid, cwd: VAULT, entrypoint: 'cli' as const, ts: new Date(Date.now() - 3600_000).toISOString() };
    const rel = `${DIR}/${sid}.jsonl`;
    send(sid, [F.userText(o, 'раз')]);
    await waitFor(() => acks(rel).length === 1);
    const s = (await sessionOf(sid))!;
    store.readsDown = true;
    try {
      const r = await api('POST', `/api/sessions/${s.id}/messages`, { text: 'ещё', clientUuid: randomUUID() });
      expect(r.statusCode).toBe(503);
      expect(r.json()).toEqual({ error: 'restore_unavailable', message: 'Копия в хабе временно недоступна, попробуйте позже' });
    } finally {
      store.readsDown = false;
    }
  });

  it('a new generation removes the raw objects of the previous one', async () => {
    const sid = randomUUID();
    const o = { sessionId: sid, cwd: VAULT, entrypoint: 'cli' as const };
    const rel = `${DIR}/${sid}.jsonl`;
    send(sid, [F.userText(o, 'старое')]);
    await waitFor(() => acks(rel).length === 1);
    const g0 = rawPrefix('x1', sid, rel.toLowerCase(), 0);
    expect(await store.list(g0)).toHaveLength(1);
    send(sid, [F.userText(o, 'новое')], 0, rel, 1);
    await waitFor(() => acks(rel).length === 2);
    await waitFor(async () => (await store.list(g0)).length === 0);
    expect(await store.list(rawPrefix('x1', sid, rel.toLowerCase(), 1))).toHaveLength(1);
  });

  it('restore links are bounded in number and do not survive their use', async () => {
    const sid = randomUUID();
    const o = { sessionId: sid, cwd: VAULT, entrypoint: 'cli' as const };
    const rel = `${DIR}/${sid}.jsonl`;
    send(sid, [F.userText(o, 'файл')]);
    await waitFor(() => acks(rel).length === 1);
    const row = (await t.tdb.pool.query(`SELECT * FROM sessions WHERE claude_session_id = $1`, [sid])).rows[0];
    const rep = t.hub.sessions.replication!;
    const file = (await rep.mainFile(row))!;
    const links = [];
    for (let i = 0; i < RESTORE_LINKS + 5; i++) links.push(await rep.prepareRestore(row, file));
    const token = (u: string) => u.split('/').pop()!;
    expect(rep.takeRestore(token(links[0]!.url), 'x1')).toBeNull(); // evicted
    expect(rep.takeRestore(token(links.at(-1)!.url), 'x1')).not.toBeNull();
    expect(rep.takeRestore(token(links.at(-1)!.url), 'x1')).toBeNull(); // one use
  });

  it('assemble re-reads the list when a segment disappears (merge running meanwhile)', async () => {
    const prefix = rawPrefix('x1', randomUUID(), 'c--x/a.jsonl', 0);
    await writeSegment(store, prefix, 0, ['{"a":1}']);
    await writeSegment(store, prefix, 1, ['{"b":2}']);
    // A store that loses the first segment once, as if the merge replaced it between list and get.
    let first = true;
    const racing = Object.create(store) as MemoryStore;
    racing.get = async (k: string) => {
      if (first && k.endsWith('000000000-000000000.jsonl.zst')) {
        first = false;
        return null;
      }
      return store.get(k);
    };
    expect((await assemble(racing, prefix)).content.toString('utf8')).toBe('{"a":1}\n{"b":2}\n');
  });

  it('side.file is acked after it is stored; a wrong sha256 is not acked', async () => {
    const sid = randomUUID();
    const data = Buffer.from('вывод инструмента');
    const sha = createHash('sha256').update(data).digest('hex');
    agentSend(agent, 'side.file', { sessionId: sid, relPath: 'tool-results/t.txt', sha256: sha, size: data.length });
    agent.ws.send(data);
    await waitFor(() => got.some(m => m.type === 'side.ack' && m.payload.sha256 === sha));
    expect(store.objects.has(`side/x1/${sid}/tool-results/t.txt`)).toBe(true);
    agentSend(agent, 'side.file', { sessionId: sid, relPath: 'tool-results/u.txt', sha256: 'f'.repeat(64), size: data.length });
    agent.ws.send(data);
    await waitFor(() => got.some(m => m.type === 'side.reject' && m.payload.relPath === 'tool-results/u.txt'));
    expect(got.find(m => m.type === 'side.reject')!.payload).toMatchObject({ reason: 'sha_mismatch' });
    expect(got.some(m => m.type === 'side.ack' && m.payload.relPath === 'tool-results/u.txt')).toBe(false);
    const bad = Buffer.from('x');
    agentSend(agent, 'side.file', { sessionId: sid, relPath: '../etc/passwd', sha256: createHash('sha256').update(bad).digest('hex'), size: 1 });
    agent.ws.send(bad);
    await waitFor(() => got.some(m => m.type === 'side.reject' && m.payload.reason === 'bad_name'));
  });

  it('M3c tail: a large Bash output links to its S3 copy, served as text/plain; an empty base64 makes no blob', async () => {
    const sid = randomUUID();
    const o = { sessionId: sid, cwd: VAULT, entrypoint: 'cli' as const };
    const full = 'строка вывода\n'.repeat(4000);
    const persisted = `<persisted-output>\nOutput too large (54.5KB). Full output saved to: C:\\Users\\alice\\.claude\\projects\\${DIR}\\${sid}\\tool-results\\bdp6vmxmf.txt\n\nPreview (first 2KB):\nстрока вывода\n</persisted-output>`;
    const result = {
      type: 'user',
      uuid: randomUUID(),
      sessionId: sid,
      cwd: VAULT,
      entrypoint: 'cli',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: persisted }] },
    };
    const empty = {
      type: 'user',
      uuid: randomUUID(),
      sessionId: sid,
      cwd: VAULT,
      entrypoint: 'cli',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } }] },
    };
    const blobs = Number((await t.tdb.pool.query(`SELECT count(*)::int AS n FROM blobs`)).rows[0].n);
    send(sid, [F.userText(o, 'выведи лог'), result, empty]);
    await waitFor(() => acks(`${DIR}/${sid}.jsonl`).length === 1);
    expect(Number((await t.tdb.pool.query(`SELECT count(*)::int AS n FROM blobs`)).rows[0].n)).toBe(blobs);
    expect(Number((await t.tdb.pool.query(`SELECT count(*)::int AS n FROM blobs WHERE size = 0`)).rows[0].n)).toBe(0);
    const s = (await sessionOf(sid))!;
    const page = (await api('GET', `/api/sessions/${s.id}/events`)).json() as EventsPage;
    const ev = page.events.find(e => e.kind === 'line' && e.sideFiles) as Extract<EventsPage['events'][number], { kind: 'line' }>;
    expect(ev.sideFiles).toEqual([{ name: 'bdp6vmxmf.txt', url: `/api/sessions/${s.id}/tool-results/bdp6vmxmf.txt?sid=${sid}` }]);
    // Not in the hub yet: 404 with a reason; after side.file — the full text.
    expect((await api('GET', ev.sideFiles![0]!.url)).statusCode).toBe(404);
    const data = Buffer.from(full, 'utf8');
    agentSend(agent, 'side.file', { sessionId: sid, relPath: 'tool-results/bdp6vmxmf.txt', sha256: createHash('sha256').update(data).digest('hex'), size: data.length });
    agent.ws.send(data);
    await waitFor(() => got.some(m => m.type === 'side.ack' && m.payload.relPath === 'tool-results/bdp6vmxmf.txt'));
    const r = await api('GET', ev.sideFiles![0]!.url);
    expect(r.statusCode).toBe(200);
    expect(String(r.headers['content-type'])).toBe('text/plain; charset=utf-8');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.body).toBe(full);
    expect((await api('GET', `/api/sessions/${s.id}/tool-results/..%2Fx?sid=${sid}`)).statusCode).toBe(404);
  });

  it('the origin source survives a resume from the hub', async () => {
    const sid = randomUUID();
    const o = { sessionId: sid, cwd: VAULT, entrypoint: 'cli' as const, ts: new Date(Date.now() - 3600_000).toISOString() };
    const rel = `${DIR}/${sid}.jsonl`;
    send(sid, [F.userText(o, 'из терминала'), F.bridge(o)]);
    await waitFor(() => acks(rel).length === 1);
    expect(await sessionOf(sid)).toMatchObject({ source: 'terminal', originSource: 'terminal', remoteControl: true });
    await t.tdb.pool.query(`UPDATE sessions SET is_hub_managed = true WHERE claude_session_id = $1`, [sid]);
    send(sid, [F.assistantText(o, 'ответ через хаб')], 2);
    await waitFor(() => acks(rel).length === 2);
    expect(await sessionOf(sid)).toMatchObject({ source: 'hub', originSource: 'terminal' });
  });
});
