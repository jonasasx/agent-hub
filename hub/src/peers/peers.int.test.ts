// session-peers tasks 2.2–2.5 against a real hub, Postgres and scripted agents: X1 and HP (protocol 1.9), OLD (1.8).
// Requirements: Каталог сессий для сессий; Отправка сообщения другой сессии; Метка отправителя и ответ; Защита от
// зацикливания и журнал; Совместимость с агентами. The tests of the describe share the hub and run in order.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { envelope, parsePeerMessage, type PeerSession, type SessionView } from '@agent-hub/shared';
import { PUBLIC_URL, connectFakeAgent, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';

const VAULT = 'C:\\Users\\alice\\vault';

interface Cmd {
  type: string;
  id?: string;
  payload: Record<string, unknown>;
  runner: string;
}
interface Reply {
  ok: boolean;
  result?: Record<string, unknown>;
  code?: string;
  message?: string;
  retryAfterSec?: number;
}

describe('session peers (integration)', () => {
  let t: TestHub;
  let cookie: string;
  let shift = 0;
  const now = () => new Date(Date.now() + shift);
  const got: Cmd[] = [];
  const agents = new Map<string, FakeAgent>();
  type S = { id: string; sid: string };

  const api = async (method: 'GET' | 'POST', url: string, payload?: unknown, withCookie = true) =>
    t.hub.app.inject({ method, url, ...(withCookie ? { cookies: { ah_session: cookie } } : {}), headers: { origin: PUBLIC_URL }, ...(payload !== undefined ? { payload: payload as object } : {}) });

  function agent(runner: string, token: string, protocol: string) {
    const a = connectFakeAgent(t.wsBase, token, { protocol, hostname: `${runner}-host` });
    a.ws.on('message', d => {
      const m = JSON.parse(d.toString()) as Cmd;
      if (!m.id || m.type === 'peers.reply') return;
      got.push({ ...m, runner });
      const ok = (result: unknown) => a.ws.send(JSON.stringify(envelope('cmd.ok', { result }, { re: m.id! })));
      if (m.type === 'fs.stat') return ok({ exists: true, isDir: true });
      if (m.type === 'session.start' || m.type === 'session.resume') return ok({ models: [] });
      ok({});
    });
    agents.set(runner, a);
    return a;
  }

  /** A hub session on `runner` that finished its first turn (waiting, process alive). */
  async function session(runner: string): Promise<S> {
    const r = await api('POST', '/api/sessions', { runnerId: runner, cwd: VAULT, model: 'haiku', prompt: 'hi' });
    expect(r.statusCode, r.body).toBe(201);
    const id = (r.json() as SessionView).id;
    const sid = (await t.tdb.pool.query(`SELECT claude_session_id FROM sessions WHERE id = $1`, [id])).rows[0].claude_session_id as string;
    const a = agents.get(runner)!;
    a.ws.send(JSON.stringify(envelope('session.result', { sessionId: sid, subtype: 'success', isError: false, durationMs: 1, costUsd: 0 })));
    await waitFor(async () => (await t.tdb.pool.query(`SELECT status FROM sessions WHERE id = $1`, [id])).rows[0].status === 'waiting');
    return { id, sid };
  }
  const status = async (id: string) => (await t.tdb.pool.query(`SELECT status FROM sessions WHERE id = $1`, [id])).rows[0].status as string;
  const setStatus = (id: string, st: string, alive: boolean) => t.tdb.pool.query(`UPDATE sessions SET status = $2, process_alive = $3 WHERE id = $1`, [id, st, alive]);

  /** peers.request from `runner` on behalf of the Claude session `sid`; the matching peers.reply. */
  async function ask(runner: string, sid: string, payload: Record<string, unknown>): Promise<Reply> {
    const a = agents.get(runner)!;
    const id = randomUUID();
    a.ws.send(JSON.stringify(envelope('peers.request', { sessionId: sid, ...payload }, { id })));
    const m = await waitFor(() => a.messages.find(x => x.type === 'peers.reply' && (x as unknown as { re?: string }).re === id), 10_000);
    return m.payload as unknown as Reply;
  }
  const send = (runner: string, from: S, to: string, text: string, extra: Record<string, unknown> = {}) => ask(runner, from.sid, { op: 'send', to, text, ...extra });
  const sentTo = (runner: string, type: string) => got.filter(c => c.runner === runner && c.type === type);
  const journal = async (from: string) =>
    (await t.tdb.pool.query(`SELECT * FROM peer_messages WHERE from_session_id = $1 ORDER BY created_at`, [from])).rows as Array<{
      result: string;
      to_session_id: string;
      text: string;
      in_reply_to: string | null;
      error_code: string | null;
    }>;

  let A: S; // X1, the main sender
  let B: S; // HP, waiting
  let C: S; // HP, sleeping
  let D: S; // OLD, waiting
  let E: S; // X1, the rate-limit sender
  let OTHER: string; // another owner's session

  beforeAll(async () => {
    t = await startTestHub({
      sessions: { idleCheckMs: 0, initTimeoutMs: 3000, now },
      // pair 3 and sender 5 per window: the spec's 20/60 scaled down
      peers: { pairLimit: 3, senderLimit: 5, now },
    });
    const tok: Record<string, string> = {};
    for (const [id, name] of [
      ['x1', 'X1'],
      ['hp', 'HP'],
      ['old', 'OLD'],
    ] as const)
      tok[id] = await t.addRunner(id, name);
    cookie = await t.login();
    agent('x1', tok.x1!, '1.9');
    agent('hp', tok.hp!, '1.9');
    agent('old', tok.old!, '1.8');
    for (const a of agents.values()) await a.next('welcome');
    A = await session('x1');
    E = await session('x1');
    B = await session('hp');
    C = await session('hp');
    await setStatus(C.id, 'sleeping', false);
    D = await session('old');
    // another owner's session: must not exist for the sessions above
    const u = await t.tdb.pool.query(`INSERT INTO users (email) VALUES ('other@example.com') RETURNING id`);
    await t.tdb.pool.query(`INSERT INTO runners (id, user_id, name, os) VALUES ('other', $1, 'OTHER', 'Windows 11')`, [u.rows[0].id]);
    const s = await t.tdb.pool.query(
      `INSERT INTO sessions (user_id, runner_id, claude_session_id, cwd, source, status, is_hub_managed, title) VALUES ($1, 'other', $2, $3, 'hub', 'waiting', true, 'чужая') RETURNING id`,
      [u.rows[0].id, randomUUID(), VAULT],
    );
    OTHER = s.rows[0].id as string;
  }, 240_000);
  afterAll(async () => {
    await t.close();
  });

  it('sessions_list: sessions of all machines with statuses, the caller marked, no other owner', async () => {
    const r = await ask('x1', A.sid, { op: 'list' });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const list = (r.result as { sessions: PeerSession[] }).sessions;
    const ids = list.map(s => s.id);
    expect(ids).toEqual(expect.arrayContaining([A.id, B.id, C.id, D.id, E.id]));
    expect(ids).not.toContain(OTHER);
    expect(list.find(s => s.id === A.id)).toMatchObject({ self: true, machine: 'X1', status: 'waiting', processAlive: true });
    expect(list.find(s => s.id === B.id)).toMatchObject({ self: false, machine: 'HP', status: 'waiting' });
    expect(list.find(s => s.id === C.id)).toMatchObject({ status: 'sleeping', processAlive: false });
    expect(list.filter(s => s.self)).toHaveLength(1);
  });

  it('sessions_list: filters by status, machine, project', async () => {
    const sleeping = ((await ask('x1', A.sid, { op: 'list', status: 'sleeping' })).result as { sessions: PeerSession[] }).sessions;
    expect(sleeping.map(s => s.id)).toEqual([C.id]);
    const hp = ((await ask('x1', A.sid, { op: 'list', machine: 'hp' })).result as { sessions: PeerSession[] }).sessions;
    expect(hp.map(s => s.id).sort()).toEqual([B.id, C.id].sort());
    const none = ((await ask('x1', A.sid, { op: 'list', project: 'no-such-project' })).result as { sessions: PeerSession[] }).sessions;
    expect(none).toEqual([]);
    // LIKE wildcards in a filter are literal characters
    for (const project of ['%', '_', 'vault%', 'v_ult']) expect(((await ask('x1', A.sid, { op: 'list', project })).result as { sessions: PeerSession[] }).sessions).toEqual([]);
    const some = ((await ask('x1', A.sid, { op: 'list', project: 'VAULT' })).result as { sessions: PeerSession[] }).sessions;
    expect(some.length).toBeGreaterThanOrEqual(5);
  });

  it('session_get: details of one session; another owner and an unknown id are not_found', async () => {
    const r = await ask('x1', A.sid, { op: 'get', target: B.id });
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ id: B.id, machine: 'HP', status: 'waiting', workingChildren: 0 });
    for (const target of [OTHER, randomUUID()]) {
      const x = await ask('x1', A.sid, { op: 'get', target });
      expect(x).toMatchObject({ ok: false, code: 'not_found' });
    }
  });

  it('session_send to a waiting session on another machine: delivered, wrapped with the sender, the journal has it', async () => {
    const r = await send('x1', A, B.id, 'привет с X1');
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.result).toMatchObject({ result: 'delivered' });
    const cmd = sentTo('hp', 'session.send').at(-1)!;
    expect(cmd.payload.sessionId).toBe(B.sid);
    const parsed = parsePeerMessage(cmd.payload.text as string)!;
    expect(parsed.text).toBe('привет с X1');
    expect(parsed.envelope).toMatchObject({ from: A.id, machine: 'X1', id: r.result!.messageId });
    expect(parsed.envelope.inReplyTo).toBeUndefined();
    expect(cmd.payload.promptUuid).toBe(r.result!.messageId);
    await waitFor(async () => (await status(B.id)) === 'working');
    const j = await journal(A.id);
    expect(j).toHaveLength(1);
    expect(j[0]).toMatchObject({ result: 'delivered', to_session_id: B.id, text: 'привет с X1', in_reply_to: null });
  });

  it('a busy addressee: queued (the agent queues it for the next turn)', async () => {
    expect(await status(B.id)).toBe('working');
    const r = await send('x1', A, B.id, 'вторая');
    expect(r.result).toMatchObject({ result: 'queued' });
    expect(sentTo('hp', 'session.send').at(-1)!.payload.sessionId).toBe(B.sid);
  });

  it('a reply carries in-reply-to', async () => {
    const first = (await journal(A.id))[0]!;
    const r = await send('hp', B, A.id, 'ответ', { inReplyTo: (await t.tdb.pool.query(`SELECT id FROM peer_messages WHERE from_session_id = $1 ORDER BY created_at LIMIT 1`, [A.id])).rows[0].id });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const cmd = sentTo('x1', 'session.send').at(-1)!;
    const parsed = parsePeerMessage(cmd.payload.text as string)!;
    expect(parsed.envelope).toMatchObject({ from: B.id, machine: 'HP' });
    expect(parsed.envelope.inReplyTo).toBeTruthy();
    expect(first.to_session_id).toBe(B.id);
  });

  it('a sleeping addressee is resumed with the message', async () => {
    const r = await send('x1', A, C.id, 'проснись');
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.result).toMatchObject({ result: 'resumed' });
    const cmd = sentTo('hp', 'session.resume').at(-1)!;
    expect(cmd.payload.sessionId).toBe(C.sid);
    expect(parsePeerMessage(cmd.payload.prompt as string)?.text).toBe('проснись');
  });

  it('refuses: self, another owner, unknown id, empty text, too long', async () => {
    expect(await send('x1', A, A.id, 'я себе')).toMatchObject({ ok: false, code: 'invalid_target' });
    expect(await send('x1', A, OTHER, 'чужой')).toMatchObject({ ok: false, code: 'not_found' });
    expect(await send('x1', A, randomUUID(), 'никому')).toMatchObject({ ok: false, code: 'not_found' });
    expect(await send('x1', A, B.id, '   ')).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(await send('x1', A, B.id, 'x'.repeat(20_001))).toMatchObject({ ok: false, code: 'invalid_request' });
    expect((await journal(A.id)).length).toBe(3); // none of the refused ones is journaled
  });

  it('an unknown caller session and a malformed request', async () => {
    expect(await ask('x1', randomUUID(), { op: 'list' })).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('an agent of protocol 1.8 gets unsupported; its sessions stay visible and writable to the others', async () => {
    expect(await ask('old', D.sid, { op: 'list' })).toMatchObject({ ok: false, code: 'unsupported' });
    const r = await send('x1', E, D.id, 'старому агенту');
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.result).toMatchObject({ result: 'delivered' });
    expect(sentTo('old', 'session.send').at(-1)!.payload.sessionId).toBe(D.sid);
  });

  it('an addressee whose machine is offline: runner_offline, journaled as an error, nothing queued', async () => {
    agents.get('old')!.ws.close();
    await waitFor(async () => (await t.tdb.pool.query(`SELECT online FROM runners WHERE id = 'old'`)).rows[0].online === false);
    const before = sentTo('old', 'session.send').length;
    const r = await send('x1', A, D.id, 'в пустоту');
    expect(r).toMatchObject({ ok: false, code: 'runner_offline' });
    expect(sentTo('old', 'session.send')).toHaveLength(before);
    const last = (await journal(A.id)).at(-1)!;
    expect(last).toMatchObject({ result: 'error', error_code: 'runner_offline' });
  });

  it('rate limit: the pair limit, then the sender limit; refused messages are journaled and not counted; the window passes', async () => {
    // E has sent 1 (to D) in the previous test: pair limit 3 per addressee, sender limit 5 in total
    await setStatus(B.id, 'waiting', true);
    for (let i = 0; i < 3; i++) expect((await send('x1', E, B.id, `b${i}`)).ok).toBe(true);
    const pair = await send('x1', E, B.id, 'b3');
    expect(pair).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(pair.retryAfterSec).toBeGreaterThan(0);
    // 4 sent; one more to another addressee reaches the sender limit of 5, the next is refused whoever it goes to
    expect((await send('x1', E, C.id, 'c0')).ok).toBe(true);
    expect(await send('x1', E, C.id, 'c1')).toMatchObject({ ok: false, code: 'rate_limited' });
    const j = await journal(E.id);
    expect(j.filter(x => x.result === 'rate_limited')).toHaveLength(2);
    expect(j.filter(x => x.result !== 'rate_limited')).toHaveLength(5);
    shift += 11 * 60_000;
    expect((await send('x1', E, B.id, 'после окна')).ok).toBe(true);
  });

  it('the journal API: the owner reads both directions; another owner and no cookie do not', async () => {
    const r = await api('GET', `/api/peers/messages?session=${B.id}`);
    expect(r.statusCode, r.body).toBe(200);
    const msgs = (r.json() as { messages: Array<{ from: string; to: string; text: string; result: string }> }).messages;
    expect(msgs.some(m => m.from === A.id && m.to === B.id && m.text === 'привет с X1' && m.result === 'delivered')).toBe(true);
    expect(msgs.some(m => m.from === B.id && m.to === A.id)).toBe(true);
    expect((await api('GET', `/api/peers/messages?session=${OTHER}`)).statusCode).toBe(404);
    expect((await api('GET', `/api/peers/messages?session=${B.id}`, undefined, false)).statusCode).toBe(401);
  });
});
