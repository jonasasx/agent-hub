// Change `subagents` (tasks 2.3–2.7, 3.1, 3.3, 3.5): the registry from the transcripts of the real session cc291a76
// (fixtures) against a real hub, Postgres and a memory S3: order and parallel chunks, idempotence, linking by prompt,
// meta.json, WS delivery, API, metric, backfill.
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EventsPage, SearchResponse, SessionView, SubagentView, SubagentsResponse } from '@agent-hub/shared';
import { PUBLIC_URL, agentSend, autoReply, connectFakeAgent, connectUi, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';
import { renderMetrics } from '../ops/metrics.js';
import { backfillSubagents } from './backfill.js';
import type { Fact } from './extract.js';
import { applyFacts, expireHeldMeta } from './repo.js';

const VAULT = 'C:\\Users\\alice\\vault';
const DIR = 'c--Users-alice-vault';
const FIX_SID = 'cc291a76-eb90-59b0-a1b9-9176313c9413';

/** Lines of a fixture with the session id replaced and the start directory set. */
const fixture = (name: string, sid: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
    .replaceAll(FIX_SID, sid)
    .split('\n')
    .filter(Boolean)
    .map(l => ({ cwd: VAULT, ...(JSON.parse(l) as Record<string, unknown>) }));

describe('subagents registry (integration)', () => {
  let t: TestHub;
  let cookie: string;
  let agent: FakeAgent;
  const got: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const api = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    t.hub.app.inject({ method, url, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, ...(payload !== undefined ? { payload: payload as object } : {}) });

  function send(sid: string, lines: unknown[], o: { agentId?: string; from?: number } = {}) {
    const relPath = o.agentId ? `${DIR}/${sid}/subagents/agent-${o.agentId}.jsonl` : `${DIR}/${sid}.jsonl`;
    const texts = lines.map(l => JSON.stringify(l));
    agentSend(agent, 'repl.chunk', {
      relPath,
      kind: o.agentId ? 'subagent' : 'main',
      sessionId: sid,
      ...(o.agentId ? { agentId: `agent-${o.agentId}` } : {}),
      generation: 0,
      fromLine: o.from ?? 0,
      fromByte: 0,
      lines: texts,
      endByte: 1000 * ((o.from ?? 0) + texts.length),
    });
    return relPath;
  }
  const acks = (rel: string) => got.filter(m => m.type === 'repl.ack' && m.payload.relPath === rel).length;
  async function chunk(sid: string, lines: unknown[], o: { agentId?: string; from?: number } = {}) {
    const rel = o.agentId ? `${DIR}/${sid}/subagents/agent-${o.agentId}.jsonl` : `${DIR}/${sid}.jsonl`;
    const n = acks(rel);
    send(sid, lines, o);
    await waitFor(() => acks(rel) > n, 15_000);
  }
  const hubId = async (sid: string) => (await t.tdb.pool.query<{ id: string }>(`SELECT id FROM sessions WHERE claude_session_id = $1`, [sid])).rows[0]!.id;
  const list = async (id: string) => ((await api('GET', `/api/sessions/${id}/subagents`)).json() as SubagentsResponse).subagents;
  const rows = async (id: string) =>
    (
      await t.tdb.pool.query<{ agent_id: string | null; tool_use_id: string | null; file_id: string | null; state: string; kind: string }>(
        `SELECT agent_id, tool_use_id, file_id, state, kind FROM subagent_runs WHERE session_id = $1 ORDER BY id`,
        [id],
      )
    ).rows;

  beforeAll(async () => {
    t = await startTestHub({ sessions: { idleCheckMs: 0, initTimeoutMs: 2000 } });
    const token = await t.addRunner('hp', 'HP');
    cookie = await t.login();
    agent = connectFakeAgent(t.wsBase, token);
    agent.ws.on('message', d => got.push(JSON.parse(d.toString()) as (typeof got)[number]));
    autoReply(agent, type => (type === 'fs.stat' ? { exists: true, isDir: true } : {}));
    await agent.next('welcome');
  });
  afterAll(async () => t.close());

  it('the main transcript: a row per Agent call with its agentId, kind and status; Bash notification and SendMessage resume add none', async () => {
    const sid = randomUUID();
    await chunk(sid, fixture('main.jsonl', sid));
    const id = await hubId(sid);
    const subs = await list(id);
    const by = (tu: string) => subs.find(s => s.toolUseId === tu)!;
    expect(subs).toHaveLength(6);
    expect(by('toolu_018W6Ey1mbLRDnPiML8TB4Ev')).toMatchObject({
      agentId: 'ae7c275287abe82aa',
      kind: 'subagent',
      status: 'completed',
      background: true,
      description: 'Collect facts for agent hub brief',
      hasTranscript: false,
    });
    expect(by('toolu_01SogddeZ8UPSv1rAbfvRBFq')).toMatchObject({ agentId: 'ae58397c483dd9a81', status: 'completed', durationMs: 118617, totalTokens: 173192, toolUses: 9, background: false });
    expect(by('toolu_01MqT95gek8NqWw7sLm4A1a4')).toMatchObject({ agentId: 'a225717d9560b148b', status: 'failed' });
    expect(by('toolu_01GMUqs9n1P8YitSCd3qzQ7Q')).toMatchObject({ agentId: 'adevops-x1-8db2d007e785553a', kind: 'teammate', name: 'devops-x1' });
    expect(by('toolu_synthetic_killed')).toMatchObject({ status: 'stopped' });
    expect(by('toolu_synthetic_skill')).toMatchObject({ kind: 'skill' });
    // the list is ordered by start; the session row counts them
    const starts = subs.map(s => s.startedAt);
    expect([...starts].sort()).toEqual(starts);
    // the teammate is still running in the registry, but the session is not alive: 0 running, status interrupted
    expect((await rows(id)).some(r => r.state === 'running')).toBe(true);
    expect(((await api('GET', `/api/sessions/${id}`)).json() as SessionView).subagents).toMatchObject({ total: 6, running: 0, working: 0 });
    expect(by('toolu_01GMUqs9n1P8YitSCd3qzQ7Q').status).toBe('interrupted');
  });

  it('subagent chunk before the main one, and both in parallel: one row per subagent, linked to its call by agentId', async () => {
    for (const parallel of [false, true]) {
      const sid = randomUUID();
      const main = fixture('main.jsonl', sid);
      const sub = fixture('agent-ae7c275287abe82aa.jsonl', sid);
      if (parallel) {
        const r1 = send(sid, main);
        const r2 = send(sid, sub, { agentId: 'ae7c275287abe82aa' });
        await waitFor(() => acks(r1) > 0 && acks(r2) > 0, 15_000);
      } else {
        await chunk(sid, sub, { agentId: 'ae7c275287abe82aa' });
        expect((await rows(await hubId(sid))).filter(r => r.agent_id === 'ae7c275287abe82aa')).toHaveLength(1);
        await chunk(sid, main);
      }
      const id = await hubId(sid);
      const r = (await rows(id)).filter(x => x.agent_id === 'ae7c275287abe82aa');
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ tool_use_id: 'toolu_018W6Ey1mbLRDnPiML8TB4Ev', state: 'completed' });
      expect(r[0]!.file_id).not.toBeNull();
      expect(await rows(id)).toHaveLength(6);
      // a repeated chunk changes nothing
      const before = await rows(id);
      await chunk(sid, sub, { agentId: 'ae7c275287abe82aa' });
      await chunk(sid, main);
      expect(await rows(id)).toEqual(before);
    }
  });

  it('a file with no agentId in any result is linked by the prompt only when the prompt is unique', async () => {
    const sid = randomUUID();
    const ts = (n: number) => new Date(Date.UTC(2026, 9, 26, 10, 0, n)).toISOString();
    const call = (tu: string, prompt: string, n: number) => ({
      type: 'assistant',
      uuid: randomUUID(),
      sessionId: sid,
      cwd: VAULT,
      timestamp: ts(n),
      message: { role: 'assistant', content: [{ type: 'tool_use', id: tu, name: 'Agent', input: { description: tu, subagent_type: 'general-purpose', prompt } }] },
    });
    const first = (prompt: string, n: number) => ({ type: 'user', uuid: randomUUID(), sessionId: sid, cwd: VAULT, isSidechain: true, timestamp: ts(n), message: { role: 'user', content: prompt } });
    await chunk(sid, [
      { type: 'user', uuid: randomUUID(), sessionId: sid, cwd: VAULT, timestamp: ts(0), message: { role: 'user', content: 'go' } },
      call('toolu_u1', 'unique task', 1),
      call('toolu_d1', 'same task', 2),
      call('toolu_d2', 'same task', 3),
    ]);
    await chunk(sid, [first('unique task', 4)], { agentId: 'a1111111111111111' });
    await chunk(sid, [first('same task', 5)], { agentId: 'a2222222222222222' });
    const r = await rows(await hubId(sid));
    expect(r.find(x => x.tool_use_id === 'toolu_u1')).toMatchObject({ agent_id: 'a1111111111111111' });
    expect(r.filter(x => x.agent_id === 'a2222222222222222')).toEqual([expect.objectContaining({ tool_use_id: null })]);
    expect(r.filter(x => x.tool_use_id?.startsWith('toolu_d')).every(x => x.agent_id === null)).toBe(true);
    // the unlinked file is counted by the metric until a meta.json links it
    const metrics = () => renderMetrics(t.tdb.db, { dataPath: '.', stat: async () => ({ total: 1, free: 1 }), online: () => true, lag: async () => [] });
    expect(await metrics()).toMatch(/^agenthub_subagent_unlinked [1-9]/m);
    agentSend(agent, 'repl.agent_meta', {
      sessionId: sid,
      relPath: `${DIR}/${sid}/subagents/agent-a2222222222222222.meta.json`,
      agentId: 'a2222222222222222',
      meta: { toolUseId: 'toolu_d2', agentType: 'general-purpose' },
    });
    await waitFor(async () => (await rows(await hubId(sid))).find(x => x.tool_use_id === 'toolu_d2')?.agent_id === 'a2222222222222222');
    expect((await rows(await hubId(sid))).filter(x => x.agent_id === 'a2222222222222222')).toHaveLength(1);
  });

  describe('review: links and order of facts', () => {
    const ts = (n: number) => new Date(Date.UTC(2026, 9, 26, 11, 0, n)).toISOString();
    const base = (sid: string, n: number) => ({ uuid: randomUUID(), sessionId: sid, cwd: VAULT, timestamp: ts(n) });
    const call = (sid: string, tu: string, prompt: string, n: number) => ({
      type: 'assistant',
      ...base(sid, n),
      message: { role: 'assistant', content: [{ type: 'tool_use', id: tu, name: 'Agent', input: { description: tu, subagent_type: 'general-purpose', prompt, run_in_background: true } }] },
    });
    const failed = (sid: string, tu: string, n: number) => ({
      type: 'user',
      ...base(sid, n),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu, is_error: true, content: 'API Error: overloaded' }] },
      toolUseResult: 'Error: API Error: overloaded',
    });
    const launched = (sid: string, tu: string, agentId: string, n: number) => ({
      type: 'user',
      ...base(sid, n),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu, content: [{ type: 'text', text: 'Async agent launched' }] }] },
      toolUseResult: { status: 'async_launched', agentId },
    });
    const user = (sid: string, text: string, n: number) => ({ type: 'user', ...base(sid, n), message: { role: 'user', content: text } });
    const first = (sid: string, prompt: string, n: number) => ({ ...user(sid, prompt, n), isSidechain: true });
    const state = async (id: string, tu: string) => (await rows(id)).find(r => r.tool_use_id === tu);

    it('C0 failed → C1 with the same prompt → file X before the result of C1 → result C1: X belongs to C1, C0 keeps its row', async () => {
      // the file after the failure: the failed call is not a candidate, C1 is the only one
      const a = randomUUID();
      await chunk(a, [user(a, 'go', 0), call(a, 'toolu_c0', 'same', 1), failed(a, 'toolu_c0', 2), call(a, 'toolu_c1', 'same', 3)]);
      await chunk(a, [first(a, 'same', 4)], { agentId: 'a000000000000000x' });
      await chunk(a, [launched(a, 'toolu_c1', 'a000000000000000x', 5)], { from: 4 });
      const ia = await hubId(a);
      expect(await state(ia, 'toolu_c0')).toMatchObject({ agent_id: null, file_id: null, state: 'failed' });
      expect((await state(ia, 'toolu_c1'))!.agent_id).toBe('a000000000000000x');
      expect((await state(ia, 'toolu_c1'))!.file_id).not.toBeNull();
      expect(await rows(ia)).toHaveLength(2);
      // the file before the failure: linked to C0 by the prompt, then the result of C1 names X — C0 is not deleted
      const b = randomUUID();
      await chunk(b, [user(b, 'go', 0), call(b, 'toolu_c0', 'same', 1)]);
      await chunk(b, [first(b, 'same', 2)], { agentId: 'a000000000000000y' });
      const ib = await hubId(b);
      expect((await state(ib, 'toolu_c0'))!.agent_id).toBe('a000000000000000y');
      await chunk(b, [failed(b, 'toolu_c0', 3), call(b, 'toolu_c1', 'same', 4), launched(b, 'toolu_c1', 'a000000000000000y', 5)], { from: 2 });
      expect(await state(ib, 'toolu_c0')).toMatchObject({ agent_id: null, file_id: null, state: 'failed' });
      expect((await state(ib, 'toolu_c1'))!.agent_id).toBe('a000000000000000y');
      expect((await state(ib, 'toolu_c1'))!.file_id).not.toBeNull();
      expect(await rows(ib)).toHaveLength(2);
    });

    it('facts in reverse order: a late hook or notification with an earlier time does not undo a resume', async () => {
      const sid = randomUUID();
      await chunk(sid, [user(sid, 'go', 0), call(sid, 'toolu_r', 'task', 1), launched(sid, 'toolu_r', 'a00000000000000rr', 2)]);
      const id = await hubId(sid);
      const owner = (await t.tdb.pool.query<{ user_id: string }>(`SELECT user_id FROM sessions WHERE id = $1`, [id])).rows[0]!.user_id;
      const at = (n: number) => new Date(ts(n));
      const apply = (facts: Fact[]) => t.tdb.db.transaction().execute(tx => applyFacts(tx, { userId: owner, sessionId: id, fileId: null }, facts));
      await apply([{ t: 'notify', agentId: 'a00000000000000rr', toolUseId: null, state: 'completed', ts: at(10) }]);
      await apply([{ t: 'resume', agentId: 'a00000000000000rr', ts: at(30) }]);
      expect((await state(id, 'toolu_r'))!.state).toBe('running');
      // the SubagentStop of the first run and its notification arrive late, with their own (earlier) times
      await apply([{ t: 'hook', agentId: 'a00000000000000rr', state: 'completed', ts: at(20) }]);
      await apply([{ t: 'notify', agentId: 'a00000000000000rr', toolUseId: 'toolu_r', state: 'completed', ts: at(20) }]);
      await apply([{ t: 'hook', agentId: 'a00000000000000rr', state: 'idle', ts: at(25) }]);
      expect((await state(id, 'toolu_r'))!.state).toBe('running');
      // a later end applies
      await apply([{ t: 'hook', agentId: 'a00000000000000rr', state: 'completed', ts: at(40) }]);
      expect((await state(id, 'toolu_r'))!.state).toBe('completed');
      // and an earlier resume does not reopen it
      await apply([{ t: 'resume', agentId: 'a00000000000000rr', ts: at(35) }]);
      expect((await state(id, 'toolu_r'))!.state).toBe('completed');
    });

    it('a queued task notification is not stored (it repeats a user line), but its status reaches the registry', async () => {
      const sid = randomUUID();
      await chunk(sid, [user(sid, 'go', 0), call(sid, 'toolu_q', 'task', 1), launched(sid, 'toolu_q', 'a00000000000000qq', 2)]);
      const id = await hubId(sid);
      const note = '<task-notification>\n<task-id>a00000000000000qq</task-id>\n<tool-use-id>toolu_q</tool-use-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>';
      await chunk(
        sid,
        [
          { type: 'attachment', ...base(sid, 3), attachment: { type: 'queued_command', prompt: note, origin: { kind: 'task-notification' } } },
          { type: 'attachment', ...base(sid, 4), attachment: { type: 'queued_command', prompt: 'проверь деплой', origin: { kind: 'human' } } },
        ],
        { from: 3 },
      );
      const att = await t.tdb.pool.query<{ t: string }>(`SELECT search_text AS t FROM events WHERE session_id = $1 AND type = 'attachment'`, [id]);
      expect(att.rows.map(r => r.t)).toEqual(['проверь деплой']);
    });

    it('subagents:backfill alongside live chunks of the same session: no deadlock, no duplicate rows', async () => {
      const sid = randomUUID();
      const main = fixture('main.jsonl', sid);
      const sub = fixture('agent-adevops-x1-8db2d007e785553a.jsonl', sid);
      await chunk(sid, main.slice(0, 9));
      await chunk(sid, sub.slice(0, 2), { agentId: 'adevops-x1-8db2d007e785553a' });
      const id = await hubId(sid);
      const runs: Array<Promise<unknown>> = [];
      for (let i = 0; i < 4; i++) runs.push(backfillSubagents(t.tdb.db, t.store, { sessionId: id, dryRun: false }));
      runs.push(chunk(sid, main.slice(9), { from: 9 }));
      runs.push(chunk(sid, sub.slice(2), { agentId: 'adevops-x1-8db2d007e785553a', from: 2 }));
      const out = await Promise.all(runs);
      for (const r of out.slice(0, 4)) expect(r).toMatchObject({ errors: 0 });
      const r = await rows(id);
      expect(r.filter(x => x.agent_id === 'adevops-x1-8db2d007e785553a')).toEqual([expect.objectContaining({ tool_use_id: 'toolu_01GMUqs9n1P8YitSCd3qzQ7Q' })]);
      expect(r.filter(x => x.tool_use_id)).toHaveLength(6);
    });
  });

  it('meta.json before the file: the row waits by agentId; teammate and finished are applied', async () => {
    const sid = randomUUID();
    await chunk(sid, fixture('main.jsonl', sid).slice(0, 3));
    const id = await hubId(sid);
    agentSend(agent, 'repl.agent_meta', {
      sessionId: sid,
      relPath: `${DIR}/${sid}/subagents/agent-a3333333333333333.meta.json`,
      agentId: 'a3333333333333333',
      meta: { taskKind: 'in_process_teammate', name: 'qa-m2', finished: true },
    });
    await waitFor(async () => (await rows(id)).some(x => x.agent_id === 'a3333333333333333'));
    expect((await rows(id)).find(x => x.agent_id === 'a3333333333333333')).toMatchObject({ kind: 'teammate', state: 'completed' });
    await chunk(sid, [{ type: 'user', uuid: randomUUID(), sessionId: sid, cwd: VAULT, isSidechain: true, timestamp: new Date().toISOString(), message: { role: 'user', content: 'hi' } }], {
      agentId: 'a3333333333333333',
    });
    const r = (await rows(id)).filter(x => x.agent_id === 'a3333333333333333');
    expect(r).toHaveLength(1);
    expect(r[0]!.file_id).not.toBeNull();
  });

  it('WS: subagent.upsert to subscribers of the session, subagent.events to subscribers of the subagent; session.events carries only main lines', async () => {
    const sid = randomUUID();
    await chunk(sid, fixture('main.jsonl', sid).slice(0, 2));
    const id = await hubId(sid);
    const [run] = await list(id);
    const ui = connectUi(t.wsBase, cookie);
    await ui.open;
    ui.send({ type: 'subscribe', sessionIds: [id], subagentIds: [run!.id, '999999999'] });
    await waitFor(() => t.hub.ui.isSubscribed(id));
    await new Promise(r => setTimeout(r, 200));
    const before = ui.received.length;
    await chunk(sid, fixture('agent-ae7c275287abe82aa.jsonl', sid), { agentId: 'ae7c275287abe82aa' });
    const up = await waitFor(() => ui.received.slice(before).find(m => m.type === 'subagent.upsert' && (m.subagent as SubagentView).id === run!.id));
    expect(up.sessionId).toBe(id);
    expect((up.subagent as SubagentView).hasTranscript).toBe(true);
    const ev = await waitFor(() => ui.received.slice(before).find(m => m.type === 'subagent.events'));
    expect(ev.subagentId).toBe(run!.id);
    expect((ev.events as unknown[]).length).toBeGreaterThan(0);
    expect(ui.received.slice(before).some(m => m.type === 'session.events')).toBe(false);
    // the subagent's transcript: its own events API; a foreign user and a missing id get 404
    expect(((await api('GET', `/api/subagents/${run!.id}/events`)).json() as EventsPage).events.length).toBeGreaterThan(0);
    expect((await api('GET', `/api/subagents/${run!.id}`)).json()).toMatchObject({ id: run!.id, session: { id } });
    expect((await api('GET', '/api/subagents/999999999')).statusCode).toBe(404);
    const other = (await t.tdb.pool.query<{ id: string }>(`INSERT INTO users (email) VALUES ('sub-other@example.com') RETURNING id`)).rows[0]!.id;
    const owner = (await t.tdb.pool.query<{ user_id: string }>(`UPDATE subagent_runs SET user_id = $2 WHERE id = $1 RETURNING (SELECT user_id FROM sessions WHERE id = session_id)`, [run!.id, other]))
      .rows[0]!.user_id;
    expect((await api('GET', `/api/subagents/${run!.id}`)).statusCode).toBe(404);
    expect((await api('GET', `/api/subagents/${run!.id}/events`)).statusCode).toBe(404);
    await t.tdb.pool.query(`UPDATE subagent_runs SET user_id = $2 WHERE id = $1`, [run!.id, owner]);
    // a call without a file: empty events
    const noFile = (await list(id)).find(s => !s.hasTranscript);
    if (noFile) expect((await api('GET', `/api/subagents/${noFile.id}/events`)).json()).toEqual({ events: [], before: null });
    ui.ws.close();
  });

  it('subscribe.subagentIds: an id of a row of another user is ignored', async () => {
    const sid = randomUUID();
    await chunk(sid, fixture('main.jsonl', sid).slice(0, 2));
    const id = await hubId(sid);
    const [run] = await list(id);
    const other = (await t.tdb.pool.query<{ id: string }>(`INSERT INTO users (email) VALUES ('sub-foreign@example.com') RETURNING id`)).rows[0]!.id;
    const owner = (await t.tdb.pool.query<{ user_id: string }>(`SELECT user_id FROM subagent_runs WHERE id = $1`, [run!.id])).rows[0]!.user_id;
    await t.tdb.pool.query(`UPDATE subagent_runs SET user_id = $2 WHERE id = $1`, [run!.id, other]);
    const ui = connectUi(t.wsBase, cookie);
    await ui.open;
    ui.send({ type: 'subscribe', sessionIds: [], subagentIds: [run!.id] });
    await new Promise(r => setTimeout(r, 300));
    await chunk(sid, fixture('agent-ae7c275287abe82aa.jsonl', sid), { agentId: 'ae7c275287abe82aa' });
    await new Promise(r => setTimeout(r, 300));
    expect(ui.received.some(m => m.type === 'subagent.events')).toBe(false);
    await t.tdb.pool.query(`UPDATE subagent_runs SET user_id = $2 WHERE id = $1`, [run!.id, owner]);
    ui.ws.close();
  });

  it('performance: a session with 47 subagents (each with a transcript, some nested) lists in < 300 ms', async () => {
    const sid = randomUUID();
    const ts = (n: number) => new Date(Date.UTC(2026, 9, 26, 9, 0, 0) + n * 1000).toISOString();
    const hex = (i: number) => `a${i.toString(16).padStart(16, '0')}`;
    const call = (i: number) => ({
      type: 'assistant',
      uuid: randomUUID(),
      sessionId: sid,
      cwd: VAULT,
      timestamp: ts(i),
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: `toolu_p${i}`, name: 'Agent', input: { description: `task ${i}`, subagent_type: 'general-purpose', prompt: `task ${i}`, run_in_background: true } }],
      },
    });
    const result = (i: number) => ({
      type: 'user',
      uuid: randomUUID(),
      sessionId: sid,
      cwd: VAULT,
      timestamp: ts(i),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_p${i}`, content: [{ type: 'text', text: 'Async agent launched' }] }] },
      toolUseResult: { status: 'async_launched', agentId: hex(i), description: `task ${i}` },
    });
    const main = [{ type: 'user', uuid: randomUUID(), sessionId: sid, cwd: VAULT, timestamp: ts(0), message: { role: 'user', content: 'go' } }];
    for (let i = 1; i <= 40; i++) main.push(call(i) as never, result(i) as never);
    await chunk(sid, main);
    for (let i = 1; i <= 47; i++) {
      const lines: unknown[] = [{ type: 'user', uuid: randomUUID(), sessionId: sid, cwd: VAULT, isSidechain: true, timestamp: ts(i), message: { role: 'user', content: `task ${i}` } }];
      // subagents 1..7 each call one nested subagent 41..47
      if (i <= 7) lines.push({ ...call(40 + i), isSidechain: true }, { ...result(40 + i), isSidechain: true });
      for (let k = 0; k < 30; k++)
        lines.push({
          type: 'assistant',
          uuid: randomUUID(),
          sessionId: sid,
          cwd: VAULT,
          isSidechain: true,
          timestamp: ts(i + k),
          message: { role: 'assistant', content: [{ type: 'text', text: `step ${k}` }] },
        });
      await chunk(sid, lines, { agentId: hex(i) });
    }
    const id = await hubId(sid);
    const subs = await list(id);
    expect(subs).toHaveLength(47);
    expect(subs.filter(x => x.parentId)).toHaveLength(7);
    expect(subs.every(x => x.hasTranscript)).toBe(true);
    const times: number[] = [];
    for (let k = 0; k < 5; k++) {
      const t0 = performance.now();
      const res = await api('GET', `/api/sessions/${id}/subagents`);
      times.push(performance.now() - t0);
      expect(res.statusCode).toBe(200);
    }
    times.sort((a, b) => a - b);
    expect(times[2]).toBeLessThan(300);
  }, 120_000);

  it('nested call: parentId is the subagent whose transcript holds the call; queued_command is stored and searchable', async () => {
    const sid = randomUUID();
    await chunk(sid, fixture('main.jsonl', sid));
    await chunk(sid, fixture('agent-aef6947385afad951.jsonl', sid), { agentId: 'aef6947385afad951' });
    await chunk(sid, fixture('agent-adevops-x1-8db2d007e785553a.jsonl', sid), { agentId: 'adevops-x1-8db2d007e785553a' });
    const id = await hubId(sid);
    const subs = await list(id);
    const parent = subs.find(s => s.agentId === 'aef6947385afad951')!;
    expect(subs.find(s => s.toolUseId === 'toolu_01VCiwoFVubxZEvGhAiPqBTy')).toMatchObject({ parentAgentId: 'aef6947385afad951', parentId: parent.id });
    const queued = async () => (await t.tdb.pool.query(`SELECT count(*)::int AS n FROM events WHERE session_id = $1 AND type = 'attachment'`, [id])).rows[0].n as number;
    expect(await queued()).toBe(0); // the teammate's queued line is a task notification: not stored
    const q = fixture('queued-peer.jsonl', sid)[0]!;
    await chunk(sid, [q], { agentId: 'adevops-x1-8db2d007e785553a', from: fixture('agent-adevops-x1-8db2d007e785553a.jsonl', sid).length });
    expect(await queued()).toBe(1); // a peer message is
    const found = (await api('GET', `/api/search?q=${encodeURIComponent('фикс')}&cron=1`)).json() as SearchResponse;
    expect(found.results.some(r => r.session.id === id)).toBe(true);
    // the teammate's transcript pages from the end like a session's
    const mate = subs.find(x => x.agentId === 'adevops-x1-8db2d007e785553a')!;
    const page = (await api('GET', `/api/subagents/${mate.id}/events?limit=1`)).json() as EventsPage;
    expect(page.events).toHaveLength(1);
    expect(page.before).not.toBeNull();
    const p2 = (await api('GET', `/api/subagents/${mate.id}/events?limit=1&before=${page.before}`)).json() as EventsPage;
    expect(p2.events.length).toBeGreaterThan(0);
    expect(p2.events.map(e => e.id)).not.toContain(page.events[0]!.id);
  });

  it('subagents:backfill rebuilds the registry from the raw copy; a second run changes nothing', async () => {
    const sid = randomUUID();
    await chunk(sid, fixture('main.jsonl', sid));
    await chunk(sid, fixture('agent-ae7c275287abe82aa.jsonl', sid), { agentId: 'ae7c275287abe82aa' });
    const id = await hubId(sid);
    const live = await rows(id);
    await t.tdb.pool.query(`DELETE FROM subagent_runs WHERE session_id = $1`, [id]);
    const dry = await backfillSubagents(t.tdb.db, t.store, { sessionId: id, dryRun: true });
    expect(dry).toMatchObject({ sessions: 1, rows: live.length, errors: 0 });
    expect(await rows(id)).toEqual([]);
    const r1 = await backfillSubagents(t.tdb.db, t.store, { sessionId: id, dryRun: false });
    expect(r1).toMatchObject({ sessions: 1, files: 2, fromEvents: 0, errors: 0 });
    const strip = (x: Awaited<ReturnType<typeof rows>>) =>
      x.map(({ agent_id, tool_use_id, state, kind, file_id }) => ({ agent_id, tool_use_id, state, kind, file: !!file_id })).sort((a, b) => String(a.tool_use_id).localeCompare(String(b.tool_use_id)));
    expect(strip(await rows(id))).toEqual(strip(live));
    const once = await rows(id);
    await backfillSubagents(t.tdb.db, t.store, { sessionId: id, dryRun: false });
    expect(await rows(id)).toEqual(once);
  });

  describe('QA: meta.json of nested subagents and the background flag', () => {
    const ts = (n: number) => new Date(Date.UTC(2026, 9, 26, 12, 0, n)).toISOString();
    const first = (sid: string, prompt: string) => ({ type: 'user', uuid: randomUUID(), sessionId: sid, cwd: VAULT, isSidechain: true, timestamp: ts(1), message: { role: 'user', content: prompt } });
    const metaOf = (parent: string, tu: string) => ({
      agentType: 'ui-ux-reviewer',
      description: 'UI review of M3b image UI',
      toolUseId: tu,
      parentAgentId: parent,
      spawnDepth: 2,
      requestShape: 'background',
      finished: true,
    });
    const sendMeta = (sid: string, agentId: string, meta: Record<string, unknown>) =>
      agentSend(agent, 'repl.agent_meta', { sessionId: sid, relPath: `${DIR}/${sid}/subagents/agent-${agentId}.meta.json`, agentId, meta });
    const full = async (id: string, agentId: string) =>
      (
        await t.tdb.pool.query<{ parent_agent_id: string | null; tool_use_id: string | null; agent_type: string | null; description: string | null; background: boolean }>(
          `SELECT parent_agent_id, tool_use_id, agent_type, description, background FROM subagent_runs WHERE session_id = $1 AND agent_id = $2`,
          [id, agentId],
        )
      ).rows;

    it('meta.json that came before the session is kept and applied; it beats the prompt prefix of the file', async () => {
      const sid = randomUUID();
      const agentId = 'a01410230d8bbb5d5';
      sendMeta(sid, agentId, metaOf('aef6947385afad951', 'toolu_qa_1'));
      await waitFor(async () => (await t.tdb.pool.query(`SELECT 1 FROM pending_agent_meta WHERE claude_session_id = $1`, [sid])).rowCount === 1);
      await chunk(sid, fixture('main.jsonl', sid).slice(0, 3));
      const id = await hubId(sid);
      expect((await t.tdb.pool.query(`SELECT 1 FROM pending_agent_meta WHERE claude_session_id = $1`, [sid])).rowCount).toBe(0);
      await chunk(sid, [first(sid, 'Сделай UI-ревью экрана изображений M3b: проверь превью, полноэкранный просмотр и тёмную тему, отчёт списком.')], { agentId });
      expect(await full(id, agentId)).toEqual([
        { parent_agent_id: 'aef6947385afad951', tool_use_id: 'toolu_qa_1', agent_type: 'ui-ux-reviewer', description: 'UI review of M3b image UI', background: true },
      ]);
      const sub = (await list(id)).find(x => x.agentId === agentId)!;
      expect(sub.parentId).not.toBeUndefined();
    });

    it('held meta.json of a session that never appears is dropped after 30 days', async () => {
      const keep = randomUUID();
      const old = randomUUID();
      sendMeta(keep, 'a7777777777777777', { agentType: 'general-purpose' });
      sendMeta(old, 'a8888888888888888', { agentType: 'general-purpose' });
      await waitFor(async () => (await t.tdb.pool.query(`SELECT 1 FROM pending_agent_meta WHERE claude_session_id IN ($1, $2)`, [keep, old])).rowCount === 2);
      await t.tdb.pool.query(`UPDATE pending_agent_meta SET received_at = now() - interval '31 days' WHERE claude_session_id = $1`, [old]);
      await t.tdb.pool.query(`UPDATE pending_agent_meta SET received_at = now() - interval '29 days' WHERE claude_session_id = $1`, [keep]);
      expect(await expireHeldMeta(t.tdb.db)).toBe(1);
      const left = await t.tdb.pool.query<{ claude_session_id: string }>(`SELECT claude_session_id FROM pending_agent_meta WHERE claude_session_id IN ($1, $2)`, [keep, old]);
      expect(left.rows.map(r => r.claude_session_id)).toEqual([keep]);
    });

    it('file first, meta.json later: meta replaces the prompt prefix; backfill keeps it', async () => {
      const sid = randomUUID();
      const agentId = 'a3011763b19678855';
      await chunk(sid, fixture('main.jsonl', sid).slice(0, 3));
      const id = await hubId(sid);
      await chunk(sid, [first(sid, 'Почини цикл пинг-понга раскладки между двумя окнами: layout.changed порождает PUT, который снова шлёт layout.changed.')], { agentId });
      expect((await full(id, agentId))[0]!.description).toMatch(/^Почини цикл/);
      sendMeta(sid, agentId, { ...metaOf('aef6947385afad951', 'toolu_qa_2'), description: 'Fix layout ping-pong loop', agentType: 'general-purpose' });
      await waitFor(async () => (await full(id, agentId))[0]?.description === 'Fix layout ping-pong loop');
      expect(await full(id, agentId)).toEqual([
        { parent_agent_id: 'aef6947385afad951', tool_use_id: 'toolu_qa_2', agent_type: 'general-purpose', description: 'Fix layout ping-pong loop', background: true },
      ]);
      await backfillSubagents(t.tdb.db, t.store, { sessionId: id, dryRun: false });
      expect((await full(id, agentId))[0]).toMatchObject({ parent_agent_id: 'aef6947385afad951', description: 'Fix layout ping-pong loop', agent_type: 'general-purpose' });
    });

    it('a call in the transcript keeps priority over meta.json where it exists', async () => {
      const sid = randomUUID();
      const agentId = 'a4c7ab0aa4e0b6185';
      const prompt = 'Проверь вкладки';
      await chunk(sid, [
        ...fixture('main.jsonl', sid).slice(0, 3),
        {
          type: 'assistant',
          uuid: randomUUID(),
          sessionId: sid,
          cwd: VAULT,
          timestamp: ts(2),
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_qa_3', name: 'Agent', input: { description: 'Из транскрипта', subagent_type: 'qa-engineer', prompt } }] },
        },
      ]);
      const id = await hubId(sid);
      sendMeta(sid, agentId, { agentType: 'general-purpose', description: 'Из meta', toolUseId: 'toolu_qa_3', parentAgentId: 'aSomeone' });
      await waitFor(async () => (await full(id, agentId)).length === 1);
      expect((await full(id, agentId))[0]).toMatchObject({ tool_use_id: 'toolu_qa_3', agent_type: 'qa-engineer', description: 'Из транскрипта', parent_agent_id: null });
    });

    it('background stays true when meta.json made the row before the call, and «Async agent launched» marks it', async () => {
      const sid = randomUUID();
      await chunk(sid, fixture('main.jsonl', sid).slice(0, 3));
      const id = await hubId(sid);
      // meta without requestShape first: it creates the row with the tool_use_id of the call
      sendMeta(sid, 'a5555555555555555', { agentType: 'general-purpose', toolUseId: 'toolu_bg_1' });
      await waitFor(async () => (await full(id, 'a5555555555555555')).length === 1);
      await chunk(
        sid,
        [
          {
            type: 'assistant',
            uuid: randomUUID(),
            sessionId: sid,
            cwd: VAULT,
            timestamp: ts(3),
            message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bg_1', name: 'Agent', input: { description: 'bg', prompt: 'p1', run_in_background: true } }] },
          },
        ],
        { from: 3 },
      );
      expect((await full(id, 'a5555555555555555'))[0]!.background).toBe(true);
      // a call without the flag whose result says it was launched asynchronously
      await chunk(
        sid,
        [
          {
            type: 'assistant',
            uuid: randomUUID(),
            sessionId: sid,
            cwd: VAULT,
            timestamp: ts(4),
            message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bg_2', name: 'Agent', input: { description: 'bg2', prompt: 'p2' } }] },
          },
          {
            type: 'user',
            uuid: randomUUID(),
            sessionId: sid,
            cwd: VAULT,
            timestamp: ts(5),
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bg_2', content: [{ type: 'text', text: 'Async agent launched successfully.' }] }] },
            toolUseResult: { status: 'async_launched', agentId: 'a6666666666666666' },
          },
        ],
        { from: 4 },
      );
      expect((await full(id, 'a6666666666666666'))[0]!.background).toBe(true);
    });
  });
});
