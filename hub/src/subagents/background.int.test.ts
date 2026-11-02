// Change `background-tasks` (tasks 1.3, 1.4): monitors and background commands from transcript lines in the format of
// a real X1 session (4a49f2ec, 2026-10-08) against a real hub and Postgres: call and result in different chunks, a
// chunk sent again, events, stream end, TaskStop, timeout and its sweep, the working count and the list.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionView, SubagentsResponse } from '@agent-hub/shared';
import { PUBLIC_URL, agentSend, autoReply, connectFakeAgent, connectUi, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';

const VAULT = 'C:\\Users\\alice\\vault';
const DIR = 'c--Users-alice-vault';

const ts = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const base = (sid: string, at: string) => ({ sessionId: sid, cwd: VAULT, timestamp: at, uuid: randomUUID() });
const call = (sid: string, at: string, id: string, name: string, input: Record<string, unknown>) => ({
  ...base(sid, at),
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const result = (sid: string, at: string, id: string, text: string, tur: unknown, isError = false) => ({
  ...base(sid, at),
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, ...(isError ? { is_error: true } : {}) }] },
  toolUseResult: tur,
});
const monitorEvent = (taskId: string, ev: string) =>
  `<task-notification>\n<task-id>${taskId}</task-id>\n<summary>Monitor event: "CI"</summary>\n<event>${ev}</event>\nIf this event is something the user would act on now, send a PushNotification.\n</task-notification>`;
const ended = (taskId: string, toolUseId: string) =>
  `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<output-file>C:\\tmp\\${taskId}.output</output-file>\n<status>completed</status>\n<summary>Monitor "CI" stream ended</summary>\n<event>PIPELINE: success</event>\n</task-notification>`;
const queued = (sid: string, at: string, content: string) => ({ type: 'queue-operation', operation: 'enqueue', timestamp: at, sessionId: sid, content });
const userText = (sid: string, at: string, content: string) => ({ ...base(sid, at), type: 'user', message: { role: 'user', content } });

describe('background tasks: monitors and background commands (integration)', () => {
  let t: TestHub;
  let cookie: string;
  let agent: FakeAgent;
  const got: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const api = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    t.hub.app.inject({ method, url, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const from = new Map<string, number>();
  const acks = (rel: string) => got.filter(m => m.type === 'repl.ack' && m.payload.relPath === rel).length;
  /** Sends the next lines of the main transcript (`again` — the same lines once more, as after a reconnect). */
  async function chunk(sid: string, lines: unknown[], again = false) {
    const rel = `${DIR}/${sid}.jsonl`;
    const n = acks(rel);
    const start = again ? (from.get(sid) ?? 0) - lines.length : (from.get(sid) ?? 0);
    const texts = lines.map(l => JSON.stringify(l));
    agentSend(agent, 'repl.chunk', { relPath: rel, kind: 'main', sessionId: sid, generation: 0, fromLine: start, fromByte: 0, lines: texts, endByte: 1000 * (start + texts.length) });
    if (!again) from.set(sid, start + texts.length);
    await waitFor(() => acks(rel) > n, 15_000);
  }
  const hubId = async (sid: string) => (await t.tdb.pool.query<{ id: string }>(`SELECT id FROM sessions WHERE claude_session_id = $1`, [sid])).rows[0]!.id;
  const bg = async (id: string) => ((await api('GET', `/api/sessions/${id}/subagents`)).json() as SubagentsResponse).background ?? [];
  const view = async (id: string) => (await api('GET', `/api/sessions/${id}`)).json() as SessionView;
  /** The session is alive in the hub (its process runs), started 10 min ago. */
  const alive = (id: string) => t.tdb.pool.query(`UPDATE sessions SET status = 'waiting', process_alive = true, process_started_at = now() - interval '10 minutes' WHERE id = $1`, [id]);

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

  it('a monitor: call and result in different chunks give one running row; events (twice each) keep the newest; working counts it', async () => {
    const sid = randomUUID();
    await chunk(sid, [call(sid, ts(60_000), 'toolu_mon1', 'Monitor', { description: 'CI pipeline #92435', command: 'while true; do glab api …; sleep 30; done', timeout_ms: 1_800_000 })]);
    const id = await hubId(sid);
    await alive(id);
    // the call alone: pending, not shown, not working
    expect(await bg(id)).toEqual([]);
    expect((await view(id)).subagents).toMatchObject({ working: 0, background: 0 });
    await chunk(sid, [
      result(sid, ts(59_000), 'toolu_mon1', 'Monitor started (task b19s2119t, expires in 30m unless the source ends first).', { taskId: 'b19s2119t', timeoutMs: 1_800_000, persistent: false }),
      queued(sid, ts(30_000), monitorEvent('b19s2119t', 'build-api: success')),
      userText(sid, ts(29_000), monitorEvent('b19s2119t', 'build-api: success')),
      queued(sid, ts(10_000), monitorEvent('b19s2119t', 'deploy-api: success')),
    ]);
    const [m] = await bg(id);
    expect(m).toMatchObject({ id: 'toolu_mon1', kind: 'monitor', description: 'CI pipeline #92435', taskId: 'b19s2119t', status: 'running', lastEvent: 'deploy-api: success' });
    expect(m!.command).toContain('glab api');
    expect(Date.parse(m!.expiresAt!) - Date.parse(m!.startedAt!)).toBe(1_800_000);
    expect((await view(id)).subagents).toMatchObject({ working: 1, background: 1 });
    // an older event delivered late does not replace the newer one
    await chunk(sid, [userText(sid, ts(25_000), monitorEvent('b19s2119t', 'build-web: success'))]);
    expect((await bg(id))[0]!.lastEvent).toBe('deploy-api: success');
    // the stream ended: completed, not working
    await chunk(sid, [queued(sid, ts(5_000), ended('b19s2119t', 'toolu_mon1'))]);
    expect((await bg(id))[0]).toMatchObject({ status: 'completed' });
    expect((await view(id)).subagents).toMatchObject({ working: 0, background: 1 });
    // the result sent again (reconnect) does not bring it back to running
    await chunk(sid, [result(sid, ts(59_000), 'toolu_mon1', 'Monitor started (task b19s2119t).', { taskId: 'b19s2119t', timeoutMs: 1_800_000, persistent: false })]);
    expect((await bg(id))[0]!.status).toBe('completed');
  });

  it('TaskStop stops a background command and a monitor by task id', async () => {
    const sid = randomUUID();
    await chunk(sid, [
      call(sid, ts(60_000), 'toolu_bash1', 'Bash', { description: 'Run tests', command: 'npm test', run_in_background: true }),
      result(sid, ts(59_000), 'toolu_bash1', 'Command running in background with ID: bx1. Output is being written to: C:\\tmp\\bx1.output', { stdout: '', backgroundTaskId: 'bx1' }),
      call(sid, ts(58_000), 'toolu_mon2', 'Monitor', { description: 'logs', command: 'tail -f x', persistent: true }),
      result(sid, ts(57_000), 'toolu_mon2', 'Monitor started (task m2).', { taskId: 'm2', timeoutMs: null, persistent: true }),
    ]);
    const id = await hubId(sid);
    await alive(id);
    expect((await bg(id)).map(v => [v.kind, v.status, v.description, v.expiresAt])).toEqual([
      ['bash', 'running', 'Run tests', null],
      ['monitor', 'running', 'logs', null],
    ]);
    expect((await view(id)).subagents?.working).toBe(2);
    await chunk(sid, [
      call(sid, ts(20_000), 'toolu_stop1', 'TaskStop', { task_id: 'bx1' }),
      result(sid, ts(19_000), 'toolu_stop1', 'Successfully stopped task: bx1 (npm test)', {
        message: 'Successfully stopped task: bx1 (npm test)',
        task_id: 'bx1',
        task_type: 'local_bash',
        command: 'npm test',
      }),
      call(sid, ts(18_000), 'toolu_stop2', 'TaskStop', { task_id: 'm2' }),
      result(sid, ts(17_000), 'toolu_stop2', 'Successfully stopped task: m2', { message: 'Successfully stopped task: m2', task_id: 'm2', task_type: 'local_bash', command: 'tail -f x' }),
    ]);
    expect((await bg(id)).map(v => v.status)).toEqual(['stopped', 'stopped']);
    expect((await view(id)).subagents?.working).toBe(0);
  });

  it('a failed call is not a task; a Bash without run_in_background is not either', async () => {
    const sid = randomUUID();
    await chunk(sid, [
      call(sid, ts(60_000), 'toolu_bad', 'Monitor', { description: 'denied', command: 'x' }),
      result(sid, ts(59_000), 'toolu_bad', 'Permission denied', null, true),
      call(sid, ts(58_000), 'toolu_fg', 'Bash', { description: 'ls', command: 'ls' }),
      result(sid, ts(57_000), 'toolu_fg', 'a b c', { stdout: 'a b c' }),
    ]);
    const id = await hubId(sid);
    await alive(id);
    expect(await bg(id)).toEqual([]);
    expect((await view(id)).subagents).toMatchObject({ working: 0, background: 0 });
  });

  it('a monitor past its timeout stops working at once; the sweep marks it expired and sends session.upsert', async () => {
    const sid = randomUUID();
    await chunk(sid, [
      call(sid, ts(130_000), 'toolu_mon3', 'Monitor', { description: 'short', command: 'sleep 999', timeout_ms: 120_000 }),
      result(sid, ts(125_000), 'toolu_mon3', 'Monitor started (task m3).', { taskId: 'm3', timeoutMs: 120_000, persistent: false }),
      call(sid, ts(60_000), 'toolu_mon4', 'Monitor', { description: 'long', command: 'sleep 999', timeout_ms: 3_600_000 }),
      result(sid, ts(59_000), 'toolu_mon4', 'Monitor started (task m4).', { taskId: 'm4', timeoutMs: 3_600_000, persistent: false }),
    ]);
    const id = await hubId(sid);
    await alive(id);
    // before the sweep: the expired one is shown expired and is not counted
    expect((await bg(id)).map(v => [v.description, v.status])).toEqual([
      ['short', 'expired'],
      ['long', 'running'],
    ]);
    expect((await view(id)).subagents?.working).toBe(1);
    const ui = connectUi(t.wsBase, cookie);
    await ui.open;
    await t.hub.sessions.checkIdle();
    await waitFor(() => ui.received.some(m => m.type === 'session.upsert' && (m.session as SessionView).id === id), 10_000);
    const row = (await t.tdb.pool.query<{ state: string; ended_at: Date; started_at: Date }>(`SELECT state, ended_at, started_at FROM background_tasks WHERE tool_use_id = 'toolu_mon3'`)).rows[0]!;
    expect(row.state).toBe('expired');
    expect(row.ended_at.getTime() - row.started_at.getTime()).toBe(120_000);
    // a second pass finds nothing to expire
    const n = ui.received.length;
    await t.hub.sessions.checkIdle();
    expect(ui.received.slice(n).filter(m => m.type === 'session.upsert' && (m.session as SessionView).id === id)).toHaveLength(0);
    ui.ws.close();
  });

  it('a running monitor of an earlier process, or of a session that is not alive, is interrupted and not working', async () => {
    const sid = randomUUID();
    await chunk(sid, [
      call(sid, ts(300_000), 'toolu_mon5', 'Monitor', { description: 'old', command: 'x', timeout_ms: 3_600_000 }),
      result(sid, ts(299_000), 'toolu_mon5', 'Monitor started (task m5).', { taskId: 'm5', timeoutMs: 3_600_000, persistent: false }),
    ]);
    const id = await hubId(sid);
    // not alive: no hub process, last written outside the hub 10 min ago
    await t.tdb.pool.query(`UPDATE sessions SET process_alive = false, external_seen_at = now() - interval '10 minutes' WHERE id = $1`, [id]);
    expect((await bg(id))[0]!.status).toBe('interrupted');
    // alive, but a new process started after the monitor (resume)
    await t.tdb.pool.query(`UPDATE sessions SET status = 'waiting', process_alive = true, process_started_at = now() WHERE id = $1`, [id]);
    expect((await bg(id))[0]!.status).toBe('interrupted');
    expect((await view(id)).subagents?.working).toBe(0);
  });

  it('the sleep: a waiting session with a running monitor does not count down by the idle timeout', async () => {
    const sid = randomUUID();
    await chunk(sid, [
      call(sid, ts(60_000), 'toolu_mon6', 'Monitor', { description: 'CI', command: 'x', timeout_ms: 3_600_000 }),
      result(sid, ts(59_000), 'toolu_mon6', 'Monitor started (task m6).', { taskId: 'm6', timeoutMs: 3_600_000, persistent: false }),
    ]);
    const id = await hubId(sid);
    await t.tdb.pool.query(
      `UPDATE sessions SET status = 'waiting', process_alive = true, process_started_at = now() - interval '10 minutes', last_turn_end_at = now() - interval '40 seconds', last_input_at = now() - interval '2 minutes' WHERE id = $1`,
      [id],
    );
    const v = await view(id);
    expect(v.subagents?.working).toBe(1);
    // the stall guard (120 min), not the idle timeout (30 min)
    expect(Date.parse(v.sleepsAt!) - Date.now()).toBeGreaterThan(110 * 60_000);
  });
});
