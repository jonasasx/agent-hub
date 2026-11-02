// hub-subagents tasks 2.2–2.6 against a real hub, Postgres and scripted agents: X1 and VM (protocol 1.12, VM with
// Codex), OLD (1.11). Requirements: Запуск субагента через хаб; Ограничения запуска; Отчёт родителю по концу хода;
// Связь в интерфейсе (API); Совместимость агентов для запуска. The tests of the describe share the hub and run in order.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PEER_TEXT_MAX, envelope, parsePeerMessage, type SessionView, type SubagentsResponse } from '@agent-hub/shared';
import { PUBLIC_URL, connectFakeAgent, connectUi, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';
import { REPORT_CUT_NOTE, REPORT_UNAVAILABLE } from './service.js';

const VAULT = 'C:\\Users\\alice\\vault';
const CODEX_OK = { id: 'codex', version: '0.166.0', login: 'ok', account: { email: 'ivan@example.com', plan: 'pro' }, models: [{ value: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol' }] };

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
}
interface Spawned {
  sessionId: string;
  title: string;
  machine: string;
  provider: string;
  cwd: string;
  model: string | null;
}

describe('hub subagents (integration)', () => {
  let t: TestHub;
  let cookie: string;
  const got: Cmd[] = [];
  const agents = new Map<string, FakeAgent>();
  type S = { id: string; sid: string };

  const api = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    t.hub.app.inject({ method, url, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, ...(payload !== undefined ? { payload: payload as object } : {}) });

  function agent(runner: string, token: string, hello: Record<string, unknown>) {
    const a = connectFakeAgent(t.wsBase, token, { hostname: `${runner}-host`, ...hello });
    a.ws.on('message', d => {
      const m = JSON.parse(d.toString()) as Cmd;
      if (!m.id || m.type === 'peers.reply') return;
      got.push({ ...m, runner });
      const ok = (result: unknown) => a.ws.send(JSON.stringify(envelope('cmd.ok', { result }, { re: m.id! })));
      if (m.type === 'fs.stat') return ok({ exists: true, isDir: true });
      if (m.type === 'session.start' || m.type === 'session.resume')
        return ok({ models: m.payload.provider === 'codex' ? [{ value: 'gpt-listed', displayName: 'GPT-Listed' }, ...CODEX_OK.models] : [{ value: 'haiku', displayName: 'Haiku' }] });
      ok({});
    });
    agents.set(runner, a);
    return a;
  }

  const row = async (id: string) => (await t.tdb.pool.query(`SELECT * FROM sessions WHERE id = $1`, [id])).rows[0] as Record<string, unknown>;
  const sidOf = async (id: string) => (await row(id)).claude_session_id as string;
  const result = (runner: string, sid: string, extra: Record<string, unknown> = {}) =>
    agents.get(runner)!.ws.send(JSON.stringify(envelope('session.result', { sessionId: sid, subtype: 'success', isError: false, durationMs: 1, costUsd: 0, ...extra })));

  /** A hub session on `runner` that finished its first turn (waiting, process alive). */
  async function session(runner: string): Promise<S> {
    const r = await api('POST', '/api/sessions', { runnerId: runner, cwd: VAULT, model: 'haiku', prompt: 'hi', permissionMode: 'acceptEdits' });
    expect(r.statusCode, r.body).toBe(201);
    const id = (r.json() as SessionView).id;
    const sid = await sidOf(id);
    result(runner, sid);
    await waitFor(async () => (await row(id)).status === 'waiting');
    return { id, sid };
  }

  async function ask(runner: string, sid: string, payload: Record<string, unknown>): Promise<Reply> {
    const a = agents.get(runner)!;
    const id = randomUUID();
    a.ws.send(JSON.stringify(envelope('peers.request', { sessionId: sid, ...payload }, { id })));
    const m = await waitFor(() => a.messages.find(x => x.type === 'peers.reply' && (x as unknown as { re?: string }).re === id), 10_000);
    return m.payload as unknown as Reply;
  }
  const spawn = (runner: string, from: S, extra: Record<string, unknown>) => ask(runner, from.sid, { op: 'spawn', ...extra });
  const count = async () => Number((await t.tdb.pool.query(`SELECT count(*) AS n FROM sessions`)).rows[0].n);
  /** Peer messages of a kind that reached the parent's runner as session.send. */
  const delivered = (runner: string, parentSid: string, kind?: string) =>
    got
      .filter(c => c.runner === runner && c.type === 'session.send' && c.payload.sessionId === parentSid)
      .map(c => parsePeerMessage(c.payload.text as string))
      .filter(m => m && (kind ? m.envelope.kind === kind : !m.envelope.kind));
  const reports = async (from: string) =>
    (await t.tdb.pool.query(`SELECT * FROM peer_messages WHERE from_session_id = $1 AND kind = 'report' ORDER BY created_at`, [from])).rows as Array<{
      to_session_id: string;
      text: string;
      result: string;
    }>;

  /** A child of `parent` spawned with defaults that is now in its first turn. */
  async function child(parent: S, task = 'посчитай строки'): Promise<S> {
    const r = await spawn('x1', parent, { task });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const id = (r.result as unknown as Spawned).sessionId;
    return { id, sid: await sidOf(id) };
  }

  let P: S; // X1, the parent
  let Q: S; // OLD, an agent below 1.12

  beforeAll(async () => {
    t = await startTestHub({ sessions: { idleCheckMs: 0, initTimeoutMs: 3000 }, peers: { pairLimit: 100, senderLimit: 100 } });
    const tok: Record<string, string> = {};
    for (const [id, name] of [
      ['x1', 'X1'],
      ['vm', 'VM'],
      ['old', 'OLD'],
      ['bare', 'BARE'],
    ] as const)
      tok[id] = await t.addRunner(id, name);
    cookie = await t.login();
    agent('x1', tok.x1!, { protocol: '1.12' });
    agent('vm', tok.vm!, { protocol: '1.12', os: 'Ubuntu 24.04', homeDir: '/home/ubuntu', vaultRoot: '/home/ubuntu/vault', providers: [CODEX_OK] });
    agent('old', tok.old!, { protocol: '1.11' });
    // signed in, the models not reported yet
    agent('bare', tok.bare!, { protocol: '1.12', os: 'Ubuntu 24.04', homeDir: '/home/ubuntu', providers: [{ id: 'codex', version: '0.166.0', login: 'ok' }] });
    for (const a of agents.values()) await a.next('welcome');
    P = await session('x1');
    Q = await session('old');
  }, 240_000);
  afterAll(async () => {
    await t.close();
  });

  it('defaults: the parent machine, folder, provider, model and mode; the task arrives as a spawn envelope', async () => {
    const r = await spawn('x1', P, { task: 'Проверь README и перечисли разделы' });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const res = r.result as unknown as Spawned;
    expect(res).toMatchObject({ machine: 'X1', provider: 'claude', cwd: VAULT, model: 'haiku', title: 'Проверь README и перечисли разделы' });
    const s = await row(res.sessionId);
    expect(s).toMatchObject({ runner_id: 'x1', cwd: VAULT, provider: 'claude', model: 'haiku', permission_mode: 'acceptEdits', spawned_by: P.id, report_to_session_id: P.id });
    expect(s.report_since).not.toBeNull();
    const start = await waitFor(() => got.find(c => c.type === 'session.start' && c.payload.sessionId === s.claude_session_id));
    const env = parsePeerMessage(start.payload.prompt as string);
    expect(env).toMatchObject({ envelope: { from: P.id, kind: 'spawn', parent: true }, text: 'Проверь README и перечисли разделы' });
    const j = (await t.tdb.pool.query(`SELECT kind, result, text FROM peer_messages WHERE from_session_id = $1 AND to_session_id = $2`, [P.id, res.sessionId])).rows;
    expect(j).toEqual([{ kind: 'spawn', result: 'resumed', text: 'Проверь README и перечисли разделы' }]);
  });

  it('Codex on another machine with a folder; the title given', async () => {
    const r = await spawn('x1', P, { task: 'обнови зависимости', provider: 'codex', machine: 'vm', cwd: '/home/ubuntu/agent-hub', model: 'gpt-6.1-sol', title: 'Зависимости' });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const res = r.result as unknown as Spawned;
    expect(res).toMatchObject({ machine: 'VM', provider: 'codex', cwd: '/home/ubuntu/agent-hub', model: 'gpt-6.1-sol', title: 'Зависимости' });
    const s = await row(res.sessionId);
    expect(s).toMatchObject({ runner_id: 'vm', provider: 'codex', spawned_by: P.id });
    const start = await waitFor(() => got.find(c => c.runner === 'vm' && c.type === 'session.start' && c.payload.sessionId === s.claude_session_id));
    expect(start.payload).toMatchObject({ provider: 'codex', cwd: '/home/ubuntu/agent-hub' });
  });

  it('Codex without a model on a machine that reported none: the first of a signed-in machine, not of the session lists', async () => {
    // the session of the test above left «gpt-listed» first in the hub's memory; the app-server may list a model the
    // account rejects (prod E2E 2026-11-01: gpt-6.1-sol), the machines' reports are the stable source
    const R = await session('x1'); // its own parent: P's live children are counted by the limit test below
    const r = await spawn('x1', R, { task: 'проверь', provider: 'codex', machine: 'bare', cwd: '/home/ubuntu' });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect((r.result as unknown as Spawned).model).toBe('gpt-6.1-sol');
    expect(await row((r.result as unknown as Spawned).sessionId)).toMatchObject({ runner_id: 'bare', model: 'gpt-6.1-sol' });
  });

  it('another machine without a folder: invalid_request, no session', async () => {
    const before = await count();
    const r = await spawn('x1', P, { task: 'x', machine: 'VM' });
    expect(r).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(r.message).toContain('cwd');
    expect(await count()).toBe(before);
  });

  it('unknown machine: not_found with the names of the machines', async () => {
    const before = await count();
    const r = await spawn('x1', P, { task: 'x', machine: 'nope', cwd: '/tmp' });
    expect(r).toMatchObject({ ok: false, code: 'not_found' });
    expect(r.message).toMatch(/X1.*VM|VM.*X1/);
    expect(await count()).toBe(before);
  });

  it('the provider not ready on the machine: spawn_failed, no session', async () => {
    const before = await count();
    const r = await spawn('x1', P, { task: 'x', provider: 'codex' });
    expect(r).toMatchObject({ ok: false, code: 'spawn_failed' });
    expect(await count()).toBe(before);
  });

  it('an agent below 1.12: unsupported', async () => {
    const r = await spawn('old', Q, { task: 'x' });
    expect(r).toMatchObject({ ok: false, code: 'unsupported' });
  });

  it('the report comes by itself with resultText; once per expected report', async () => {
    const c = await child(P);
    result('x1', c.sid, { resultText: 'Строк: 42' });
    const m = await waitFor(() => delivered('x1', P.sid, 'report').find(x => x!.envelope.from === c.id));
    expect(m!.text).toBe('Строк: 42');
    await waitFor(async () => (await row(c.id)).report_to_session_id === null);
    result('x1', c.sid, { resultText: 'ещё раз' });
    await new Promise(r => setTimeout(r, 300));
    expect((await reports(c.id)).map(x => x.text)).toEqual(['Строк: 42']);
  });

  it('the child answered with session_send during the turn: no report', async () => {
    const c = await child(P);
    const s = await ask('x1', c.sid, { op: 'send', to: P.id, text: 'готово, вот итог' });
    expect(s.ok, JSON.stringify(s)).toBe(true);
    result('x1', c.sid, { resultText: 'итог' });
    await waitFor(async () => (await row(c.id)).report_to_session_id === null);
    await new Promise(r => setTimeout(r, 300));
    expect(await reports(c.id)).toEqual([]);
  });

  it('a turn with an error: the report carries the error', async () => {
    const c = await child(P);
    result('x1', c.sid, { subtype: 'error_during_execution', isError: true, errorText: 'процесс упал' });
    await waitFor(async () => (await reports(c.id)).length === 1);
    expect((await reports(c.id))[0]!.text).toBe('Ход завершился ошибкой: процесс упал');
  });

  it('the child process ends inside the turn: the parent gets a report of it', async () => {
    const c = await child(P);
    agents.get('x1')!.ws.send(JSON.stringify(envelope('session.exited', { sessionId: c.sid, code: 1, reason: 'crashed', errorText: 'boom' })));
    await waitFor(async () => (await reports(c.id)).length === 1);
    expect((await reports(c.id))[0]!.text).toContain('boom');
    expect((await row(c.id)).report_to_session_id).toBeNull();
  });

  it('a parent message queued behind a running turn: each turn reports once', async () => {
    const c = await child(P);
    const s = await ask('x1', P.sid, { op: 'send', to: c.id, text: 'уточнение' });
    expect(s.ok, JSON.stringify(s)).toBe(true);
    result('x1', c.sid, { resultText: 'итог первого' });
    await waitFor(async () => (await reports(c.id)).length === 1);
    expect((await reports(c.id))[0]!.text).toBe('итог первого');
    expect((await row(c.id)).report_to_session_id).toBe(P.id);
    result('x1', c.sid, { resultText: 'итог уточнения' });
    await waitFor(async () => (await reports(c.id)).length === 2);
    expect((await reports(c.id))[1]!.text).toBe('итог уточнения');
    expect((await row(c.id)).report_to_session_id).toBeNull();
    agents.get('x1')!.ws.send(JSON.stringify(envelope('session.exited', { sessionId: c.sid, code: 0, reason: 'stopped' }))); // not a live child of P any more
    await waitFor(async () => (await row(c.id)).process_alive === false);
  });

  it('a user message clears the expected report; a parent message sets it again', async () => {
    const c = await child(P);
    result('x1', c.sid, { resultText: 'первый' });
    await waitFor(async () => (await reports(c.id)).length === 1);
    const u = await api('POST', `/api/sessions/${c.id}/messages`, { text: 'а теперь вот это', clientUuid: randomUUID() });
    expect(u.statusCode, u.body).toBe(202);
    expect((await row(c.id)).report_to_session_id).toBeNull();
    result('x1', c.sid, { resultText: 'ответ пользователю' });
    await new Promise(r => setTimeout(r, 300));
    expect((await reports(c.id)).map(x => x.text)).toEqual(['первый']);
    // the parent writes again: the turn reports again
    const s = await ask('x1', P.sid, { op: 'send', to: c.id, text: 'ещё задача' });
    expect(s.ok, JSON.stringify(s)).toBe(true);
    expect((await row(c.id)).report_to_session_id).toBe(P.id);
    result('x1', c.sid, { resultText: 'второй' });
    await waitFor(async () => (await reports(c.id)).length === 2);
  });

  it('a message of the parent is marked parent="true"; of another session and the child own message — not', async () => {
    const R = await session('x1'); // its own parent: P is near the limit of live children
    const c = await child(R);
    const other = await session('x1');
    const byText = (text: string) =>
      got
        .filter(m => m.type === 'session.send' || m.type === 'session.resume')
        .map(m => parsePeerMessage(String(m.payload.text ?? m.payload.prompt ?? '')))
        .find(m => m?.text === text);
    expect((await ask('x1', R.sid, { op: 'send', to: c.id, text: 'от родителя' })).ok).toBe(true);
    expect((await ask('x1', other.sid, { op: 'send', to: c.id, text: 'от соседа' })).ok).toBe(true);
    const fromParent = await waitFor(() => byText('от родителя'));
    const fromOther = await waitFor(() => byText('от соседа'));
    expect(fromParent!.envelope).toMatchObject({ from: R.id, parent: true });
    expect(fromOther!.envelope.parent).toBeUndefined();
    // the child writes to its parent: no mark, the parent did not spawn from the child
    expect((await ask('x1', c.sid, { op: 'send', to: R.id, text: 'от ребёнка' })).ok).toBe(true);
    expect((await waitFor(() => byText('от ребёнка')))!.envelope.parent).toBeUndefined();
  });

  it('no resultText: the last answer of the turn from the replica, else «unavailable»', async () => {
    const c = await child(P);
    result('x1', c.sid);
    await waitFor(async () => (await reports(c.id)).length === 1);
    expect((await reports(c.id))[0]!.text).toBe(REPORT_UNAVAILABLE);

    const d = await child(P);
    const q = (text: string, values: unknown[]) => t.tdb.pool.query(text, values);
    const file = (
      await q(
        `INSERT INTO transcript_files (user_id, session_id, runner_id, claude_session_id, rel_key, rel_path, kind) SELECT user_id, id, runner_id, claude_session_id, 'p/d.jsonl', 'p/d.jsonl', 'main' FROM sessions WHERE id = $1 RETURNING id`,
        [d.id],
      )
    ).rows[0].id;
    for (const [i, text] of ['черновик', 'итог из реплики'].entries())
      await q(
        `INSERT INTO events (file_id, generation, line_no, session_id, uuid, type, ts, payload, search_text) VALUES ($1, 0, $2::int, $3, gen_random_uuid(), 'assistant', now() + make_interval(secs => $2::int), $4, $5)`,
        [file, i, d.id, JSON.stringify({ type: 'assistant' }), text],
      );
    result('x1', d.sid);
    await waitFor(async () => (await reports(d.id)).length === 1);
    expect((await reports(d.id))[0]!.text).toBe('итог из реплики');
  });

  it('a long result is cut to the peer limit with a note', async () => {
    const c = await child(P);
    result('x1', c.sid, { resultText: 'я'.repeat(PEER_TEXT_MAX + 500) });
    await waitFor(async () => (await reports(c.id)).length === 1);
    const text = (await reports(c.id))[0]!.text;
    expect(text.length).toBeLessThanOrEqual(PEER_TEXT_MAX);
    expect(text.endsWith(REPORT_CUT_NOTE)).toBe(true);
  });

  it('a nested spawn reports to its direct parent', async () => {
    const c = await child(P);
    const r = await spawn('x1', c, { task: 'вложенное' });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const g = (r.result as unknown as Spawned).sessionId;
    expect(await row(g)).toMatchObject({ spawned_by: c.id, report_to_session_id: c.id });
    result('x1', await sidOf(g), { resultText: 'внук готов' });
    await waitFor(async () => (await reports(g)).length === 1);
    expect((await reports(g))[0]!.to_session_id).toBe(c.id);
  });

  it('API: spawnedBy on the child, hubSessions and the counter on the parent', async () => {
    const kids = (await t.tdb.pool.query(`SELECT id FROM sessions WHERE spawned_by = $1 ORDER BY created_at`, [P.id])).rows.map(r => r.id as string);
    const v = (await api('GET', `/api/sessions/${kids[0]}`)).json() as SessionView;
    expect(v.spawnedBy).toMatchObject({ id: P.id });
    const sub = (await api('GET', `/api/sessions/${P.id}/subagents`)).json() as SubagentsResponse;
    expect(sub.hubSessions?.map(s => s.id)).toEqual(kids);
    expect(sub.hubSessions?.find(s => s.provider === 'codex')).toMatchObject({ machine: 'VM' });
    const pv = (await api('GET', `/api/sessions/${P.id}`)).json() as SessionView;
    expect(pv.subagents?.hub?.total).toBe(kids.length);
  });

  it('a working child counts as a working child of the parent (loader, no sleep) until its turn ends', async () => {
    const R = await session('x1');
    const workingOf = async () => ((await api('GET', `/api/sessions/${R.id}`)).json() as SessionView).subagents?.working ?? 0;
    expect(await workingOf()).toBe(0);
    const c = await child(R, 'долгая задача');
    expect((await row(c.id)).status).toBe('working');
    expect(await workingOf()).toBe(1);
    // a child silent for longer than the stall guard does not hold the parent
    await t.tdb.pool.query(`UPDATE sessions SET last_event_at = now() - interval '3 hours' WHERE id = $1`, [c.id]);
    expect(await workingOf()).toBe(0);
    await t.tdb.pool.query(`UPDATE sessions SET last_event_at = now() WHERE id = $1`, [c.id]);
    expect(await workingOf()).toBe(1);
    result('x1', c.sid);
    await waitFor(async () => (await row(c.id)).status === 'waiting');
    expect(await workingOf()).toBe(0);
  });

  it('the child belongs to the project of its parent: pinned stays pinned, a parent without a project gives none', async () => {
    const list = (await api('GET', '/api/projects')).json() as Array<{ id: string; title: string }>;
    expect(list.length).toBeGreaterThan(0);
    const proj = list[0]!;
    const R = await session('x1');
    await t.hub.projects.flush();
    // no project pinned: the child gets exactly what the parent has (the classifier decides later by its paths)
    const parentNow = await row(R.id);
    const c0 = await child(R, 'без закрепа');
    expect(await row(c0.id)).toMatchObject({ project_id: parentNow.project_id, project_source: parentNow.project_id ? 'inherited' : 'none' });
    // pinned by hand: the child is pinned to the same project, with a label
    const pin = await api('PUT', `/api/sessions/${R.id}/project`, { projectId: proj.id });
    expect(pin.statusCode, pin.body).toBe(200);
    const c1 = await child(R, 'с закрепом');
    expect(await row(c1.id)).toMatchObject({ project_id: proj.id, project_source: 'manual', spawned_by: R.id });
    expect((await t.tdb.pool.query(`SELECT project_id FROM classification_labels WHERE session_id = $1`, [c1.id])).rows[0]?.project_id).toBe(proj.id);
    expect(((await api('GET', `/api/sessions/${c1.id}`)).json() as SessionView).project.id).toBe(proj.id);
  });

  it('a spawned session is not in the sidebar lists (now, project groups, «ещё N»), only under its parent', async () => {
    const R = await session('x1');
    const c = await child(R, 'не в меню');
    const side = (await api('GET', '/api/sidebar')).json() as { now: Array<{ id: string }>; projects: Array<{ project: { id: string | null }; total: number; sessions: Array<{ id: string }> }> };
    expect(side.now.map(s => s.id)).not.toContain(c.id); // working, not permission
    const all = side.projects.flatMap(g => g.sessions.map(s => s.id));
    expect(all).not.toContain(c.id);
    const pid = ((await api('GET', `/api/sessions/${R.id}`)).json() as SessionView).project.id ?? 'none';
    const group = side.projects.find(g => (g.project.id ?? 'none') === pid)!;
    const page = (await api('GET', `/api/projects/${pid}/sessions`)).json() as { sessions: Array<{ id: string }>; total: number };
    expect(page.sessions.map(s => s.id)).not.toContain(c.id);
    expect(page.sessions.map(s => s.id)).toContain(R.id);
    expect(group.total).toBe(page.total);
    // the child is still there for its parent and by its own address
    expect(((await api('GET', `/api/sessions/${c.id}`)).json() as SessionView).spawnedBy?.id).toBe(R.id);
    expect(((await api('GET', `/api/sessions/${R.id}`)).json() as SessionView).subagents?.hub?.total).toBeGreaterThan(0);
    // except a child that waits for the user's permission: nobody else can answer it
    await t.tdb.pool.query(`UPDATE sessions SET status = 'permission' WHERE id = $1`, [c.id]);
    const side2 = (await api('GET', '/api/sidebar')).json() as { now: Array<{ id: string }> };
    expect(side2.now.map(x => x.id)).toContain(c.id);
  });

  it('the parent is re-sent to the UI when its child changes', async () => {
    const R = await session('x1');
    const c = await child(R, 'ещё задача');
    const ui = connectUi(t.wsBase, cookie);
    await ui.open;
    const parentUpsert = (working: number) => ui.received.some(m => m.type === 'session.upsert' && (m.session as SessionView).id === R.id && (m.session as SessionView).subagents?.working === working);
    result('x1', c.sid);
    await waitFor(async () => (await row(c.id)).status === 'waiting');
    await waitFor(() => parentUpsert(0), 10_000);
    ui.ws.close();
  });

  it('the 11th live child: rate_limited, no session', async () => {
    const live = Number((await t.tdb.pool.query(`SELECT count(*) AS n FROM sessions WHERE spawned_by = $1 AND process_alive AND status IN ('working','waiting','permission')`, [P.id])).rows[0].n);
    for (let i = live; i < 10; i++) await child(P, `фон ${i}`);
    await t.tdb.pool.query(`UPDATE sessions SET status = 'working', process_alive = true WHERE spawned_by = $1`, [P.id]);
    const before = await count();
    const r = await spawn('x1', P, { task: 'одиннадцатый' });
    expect(r).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(await count()).toBe(before);
  });

  it('parallel spawns of one session stay within the limit of 10', async () => {
    const R2 = await session('x1');
    const rs = await Promise.all(Array.from({ length: 13 }, (_, i) => spawn('x1', R2, { task: `параллельно ${i}` })));
    expect(rs.filter(r => r.ok)).toHaveLength(10);
    expect(rs.filter(r => !r.ok).every(r => r.code === 'rate_limited')).toBe(true);
  });
});
