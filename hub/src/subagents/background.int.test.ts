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

  /** Lines of a subagent file of the session (`again` — the same lines once more). */
  async function subChunk(sid: string, agentId: string, lines: unknown[], again = false) {
    const rel = `${DIR}/${sid}/subagents/agent-${agentId}.jsonl`;
    const n = acks(rel);
    const key = `${sid}/${agentId}`;
    const start = again ? (from.get(key) ?? 0) - lines.length : (from.get(key) ?? 0);
    const texts = lines.map(l => JSON.stringify(l));
    agentSend(agent, 'repl.chunk', { relPath: rel, kind: 'subagent', sessionId: sid, generation: 0, fromLine: start, fromByte: 0, lines: texts, endByte: 1000 * (start + texts.length) });
    if (!again) from.set(key, start + texts.length);
    await waitFor(() => acks(rel) > n, 15_000);
  }
  const rowOf = async (toolUseId: string) =>
    (
      await t.tdb.pool.query<{ state: string; ended_at: Date | null; task_id: string | null; kind: string }>(`SELECT state, ended_at, task_id, kind FROM background_tasks WHERE tool_use_id = $1`, [
        toolUseId,
      ])
    ).rows[0]!;

  // The real lines of session 653834c2 (X1, 2026-11-06), content trimmed: a background Bash of a subagent whose notification
  // was read from the main transcript before the call and its result of the subagent file (the files come in any order).
  const REAL = {
    toolUseId: 'toolu_01A92BcGDGUiuDwZNd16uLFq',
    taskId: 'bkl112941',
    enqueuedAt: '2026-11-06T11:11:05.237Z',
    startedAt: '2026-11-06T11:11:06.807Z',
    agentId: 'a3d074c1980fee3cf',
  };
  const taskDone = `<task-notification>\n<task-id>${REAL.taskId}</task-id>\n<tool-use-id>${REAL.toolUseId}</tool-use-id>\n<output-file>C:\\Users\\IVOLYN~1\\tasks\\${REAL.taskId}.output</output-file>\n<status>completed</status>\n<summary>Background command "cat … | tail -12" completed (exit code 0)</summary>\n</task-notification>`;
  const realSubLines = (sid: string, withCopy: boolean) => [
    call(sid, '2026-11-06T11:11:04.000Z', REAL.toolUseId, 'Bash', { command: 'cat out | tail -12', timeout: 600000, run_in_background: true }),
    result(sid, REAL.startedAt, REAL.toolUseId, `Command running in background with ID: ${REAL.taskId}. Output is being written to: C:\\Users\\IVOLYN~1\\tasks\\${REAL.taskId}.output.`, undefined),
    ...(withCopy
      ? [{ ...base(sid, REAL.enqueuedAt), type: 'attachment', attachment: { type: 'queued_command', prompt: taskDone, origin: { kind: 'task-notification' }, timestamp: REAL.enqueuedAt } }]
      : []),
  ];

  it('the notification read before the call and the result (another file first) ends the task; a repeat changes nothing', async () => {
    const sid = randomUUID();
    // the main transcript first: the enqueue of the notification (line 805 of the real file)
    await chunk(sid, [queued(sid, REAL.enqueuedAt, taskDone), userText(sid, '2026-11-06T11:11:08.000Z', 'next')]);
    const id = await hubId(sid);
    expect((await rowOf(REAL.toolUseId)).state).toBe('pending');
    // then the file of the subagent: the call and the result (lines 610 and 612); the copy is absent in this variant
    await subChunk(sid, REAL.agentId, realSubLines(sid, false));
    let row = await rowOf(REAL.toolUseId);
    expect(row).toMatchObject({ state: 'completed', task_id: REAL.taskId, kind: 'bash' });
    expect(row.ended_at!.toISOString()).toBe(REAL.enqueuedAt);
    await alive(id);
    expect((await bg(id)).map(v => [v.id, v.status, v.endedAt])).toEqual([[REAL.toolUseId, 'completed', REAL.enqueuedAt]]);
    expect((await view(id)).subagents).toMatchObject({ working: 0, background: 1 });
    // the same chunks once more and the notification again: the end stays
    await subChunk(sid, REAL.agentId, realSubLines(sid, false), true);
    await chunk(sid, [queued(sid, '2026-11-06T11:11:09.000Z', taskDone)]);
    row = await rowOf(REAL.toolUseId);
    expect(row.state).toBe('completed');
    expect(row.ended_at!.toISOString()).toBe(REAL.enqueuedAt);
  });

  it('the queued_command copy of the notification in the subagent file alone ends the task (line 614 of the real file); the second copy is idempotent', async () => {
    const sid = randomUUID();
    await chunk(sid, [userText(sid, '2026-11-06T11:10:00.000Z', 'go')]);
    await subChunk(sid, REAL.agentId, realSubLines(sid, true));
    expect(await rowOf(REAL.toolUseId)).toMatchObject({ state: 'completed', task_id: REAL.taskId });
    await chunk(sid, [queued(sid, REAL.enqueuedAt, taskDone)]);
    const row = await rowOf(REAL.toolUseId);
    expect(row.state).toBe('completed');
    expect(row.ended_at!.toISOString()).toBe(REAL.enqueuedAt);
    const id = await hubId(sid);
    await alive(id);
    expect((await view(id)).subagents?.working).toBe(0);
  });

  it('a notification of a subagent makes no row of background tasks', async () => {
    const sid = randomUUID();
    const sub = `<task-notification>\n<task-id>a1111111111111111</task-id>\n<tool-use-id>toolu_agent1</tool-use-id>\n<status>completed</status>\n<summary>Agent done</summary>\n</task-notification>`;
    await chunk(sid, [
      call(sid, ts(60_000), 'toolu_agent1', 'Agent', { description: 'x', prompt: 'p', subagent_type: 'general-purpose', run_in_background: true }),
      queued(sid, ts(30_000), sub),
      queued(sid, ts(29_000), sub),
    ]);
    expect((await t.tdb.pool.query(`SELECT 1 FROM background_tasks WHERE tool_use_id = 'toolu_agent1'`)).rowCount).toBe(0);
  });

  it('calls whose result is an error end failed (not pending): Monitor with InputValidationError and a denied background Bash; they are not listed', async () => {
    const sid = randomUUID();
    const bad = 'toolu_018H1c4QAPnpDzXYPLH41nvi';
    await chunk(sid, [
      call(sid, '2026-11-06T11:10:49.000Z', bad, 'Monitor', { query: 'select:Monitor', max_results: '1' }),
      result(
        sid,
        '2026-11-06T11:10:50.011Z',
        bad,
        '<tool_use_error>InputValidationError: Monitor failed: the parameter `description` is missing</tool_use_error>',
        'InputValidationError: [ … ]',
        true,
      ),
      call(sid, ts(60_000), 'toolu_denied', 'Bash', { command: 'rm x', run_in_background: true }),
      result(sid, ts(59_000), 'toolu_denied', 'Permission to use Bash has been denied.', null, true),
    ]);
    const bad1 = await rowOf(bad);
    expect(bad1.state).toBe('failed');
    expect(bad1.ended_at!.toISOString()).toBe('2026-11-06T11:10:50.011Z');
    expect(bad1.task_id).toBeNull();
    expect((await rowOf('toolu_denied')).state).toBe('failed');
    const id = await hubId(sid);
    await alive(id);
    expect(await bg(id)).toEqual([]);
    expect((await view(id)).subagents).toMatchObject({ working: 0, background: 0 });
  });

  it('a background Bash without a notification expires: 30 min by default, its own timeout when set (at most 2 h); the sweep marks it', async () => {
    const sid = randomUUID();
    const min = (n: number) => n * 60_000;
    const start = (n: number, toolUseId: string, taskId: string, input: Record<string, unknown>) => [
      call(sid, ts(min(n) + 1000), toolUseId, 'Bash', { description: toolUseId, command: 'sleep 9999', run_in_background: true, ...input }),
      result(sid, ts(min(n)), toolUseId, `Command running in background with ID: ${taskId}. Output is being written to: x.`, undefined),
    ];
    await chunk(sid, [
      ...start(31, 'toolu_bd1', 'bd1', {}),
      ...start(11, 'toolu_bd2', 'bd2', { timeout: min(10) }),
      ...start(5, 'toolu_bd3', 'bd3', { timeout: min(10) }),
      ...start(29, 'toolu_bd4', 'bd4', {}),
      ...start(121, 'toolu_bd5', 'bd5', { timeout: 10 * 60 * 60_000 }),
    ]);
    const id = await hubId(sid);
    await alive(id);
    await t.tdb.pool.query(`UPDATE sessions SET process_started_at = now() - interval '3 hours' WHERE id = $1`, [id]);
    expect((await bg(id)).map(v => [v.id, v.status]).sort()).toEqual([
      ['toolu_bd1', 'expired'],
      ['toolu_bd2', 'expired'],
      ['toolu_bd3', 'running'],
      ['toolu_bd4', 'running'],
      ['toolu_bd5', 'expired'],
    ]);
    expect((await view(id)).subagents?.working).toBe(2);
    const ui = connectUi(t.wsBase, cookie);
    await ui.open;
    await t.hub.sessions.checkIdle();
    await waitFor(() => ui.received.some(m => m.type === 'session.upsert' && (m.session as SessionView).id === id), 10_000);
    for (const [tu, limit] of [
      ['toolu_bd1', 30],
      ['toolu_bd2', 10],
      ['toolu_bd5', 120],
    ] as const) {
      const r = (await t.tdb.pool.query<{ state: string; d: number }>(`SELECT state, extract(epoch FROM ended_at - started_at)::int AS d FROM background_tasks WHERE tool_use_id = $1`, [tu])).rows[0]!;
      expect(r).toEqual({ state: 'expired', d: limit * 60 });
    }
    expect((await rowOf('toolu_bd3')).state).toBe('running');
    expect((await rowOf('toolu_bd4')).state).toBe('running');
    ui.ws.close();
  });

  // Acceptance 2026-11-08, session c0f1c580 (HP): a background subagent started a background Bash and a Monitor and gave its
  // final response. Claude Code ends both with the subagent and writes no notification for them in any transcript.
  const SUB_PROMPT = 'Run the e2e suite and watch the deploy';
  const subNotify = (agentId: string, toolUseId: string) =>
    `<task-notification>\n<task-id>${agentId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n<summary>Agent "e2e" completed</summary>\n<result>done</result>\n</task-notification>`;
  const subTaskLines = (sid: string, at: (s: number) => string, n: string) => [
    userText(sid, at(600), SUB_PROMPT),
    call(sid, at(590), `toolu_sb_${n}`, 'Bash', { description: 'e2e', command: 'npm run e2e', run_in_background: true }),
    result(sid, at(589), `toolu_sb_${n}`, `Command running in background with ID: b0oh3g${n}. Output is being written to: x.`, undefined),
    call(sid, at(588), `toolu_sm_${n}`, 'Monitor', { description: 'deploy', command: 'tail -f deploy.log' }),
    // the result kept its text only: the timeout comes from it
    result(sid, at(587), `toolu_sm_${n}`, `Monitor started (task b004g8${n}, expires in 30m unless the source ends first).`, undefined),
  ];
  const launchLines = (sid: string, at: (s: number) => string, agentId: string, toolUseId: string) => [
    call(sid, at(610), toolUseId, 'Agent', { description: 'e2e', prompt: SUB_PROMPT, subagent_type: 'general-purpose', run_in_background: true }),
    result(sid, at(609), toolUseId, `Async agent launched successfully.\nagentId: ${agentId}`, { status: 'async_launched', agentId }),
  ];
  const states = async (...ids: string[]) => Promise.all(ids.map(async i => (await rowOf(i)).state));
  const secondsAgo = () => {
    const now = Date.now();
    return (s: number) => new Date(now - s * 1000).toISOString();
  };

  it('the end of a subagent ends its background command and monitor (no notification of theirs); the session stops working', async () => {
    const sid = randomUUID();
    const at = secondsAgo();
    const agentId = 'a0c0f1c580aa0bb01';
    await chunk(sid, launchLines(sid, at, agentId, 'toolu_agent_e2e1'));
    await subChunk(sid, agentId, subTaskLines(sid, at, '1'));
    const id = await hubId(sid);
    await alive(id);
    expect(await states('toolu_sb_1', 'toolu_sm_1')).toEqual(['running', 'running']);
    expect((await view(id)).subagents?.working).toBe(3);
    // the subagent gave its final response: its notification in the main transcript
    await chunk(sid, [queued(sid, at(300), subNotify(agentId, 'toolu_agent_e2e1'))]);
    expect(await states('toolu_sb_1', 'toolu_sm_1')).toEqual(['stopped', 'stopped']);
    expect((await rowOf('toolu_sb_1')).ended_at!.toISOString()).toBe(at(300));
    expect((await bg(id)).map(v => v.status)).toEqual(['stopped', 'stopped']);
    expect((await view(id)).subagents?.working).toBe(0);
  });

  it('the subagent ended before its file is read: its tasks end at once; a task of the main transcript stays', async () => {
    const sid = randomUUID();
    const at = secondsAgo();
    const agentId = 'a0c0f1c580aa0bb02';
    await chunk(sid, [
      ...launchLines(sid, at, agentId, 'toolu_agent_e2e2'),
      call(sid, at(500), 'toolu_main_bg', 'Bash', { description: 'main', command: 'sleep 999', run_in_background: true }),
      result(sid, at(499), 'toolu_main_bg', 'Command running in background with ID: bmain2. Output is being written to: x.', undefined),
      queued(sid, at(300), subNotify(agentId, 'toolu_agent_e2e2')),
    ]);
    await subChunk(sid, agentId, subTaskLines(sid, at, '2'));
    const id = await hubId(sid);
    await alive(id);
    expect(await states('toolu_sb_2', 'toolu_sm_2', 'toolu_main_bg')).toEqual(['stopped', 'stopped', 'running']);
    expect((await view(id)).subagents?.working).toBe(1);
  });

  it('SubagentStop of a foreground subagent ends its tasks; a task started after the end (a resumed run) keeps running', async () => {
    const sid = randomUUID();
    const at = secondsAgo();
    const agentId = 'a0c0f1c580aa0bb03';
    await chunk(sid, [call(sid, at(610), 'toolu_agent_e2e3', 'Agent', { description: 'e2e', prompt: SUB_PROMPT, subagent_type: 'general-purpose' })]);
    await subChunk(sid, agentId, [
      ...subTaskLines(sid, at, '3'),
      { ...base(sid, at(400)), type: 'attachment', attachment: { type: 'hook_success', hookName: 'SubagentStop', hookEvent: 'SubagentStop', content: '' } },
    ]);
    expect(await states('toolu_sb_3', 'toolu_sm_3')).toEqual(['stopped', 'stopped']);
    // resumed by SendMessage: a new message of the subagent and a new background command
    await subChunk(sid, agentId, [
      userText(sid, at(200), 'one more run'),
      call(sid, at(190), 'toolu_sb_3b', 'Bash', { description: 'again', command: 'npm run e2e', run_in_background: true }),
      result(sid, at(189), 'toolu_sb_3b', 'Command running in background with ID: b3b. Output is being written to: x.', undefined),
    ]);
    expect(await states('toolu_sb_3', 'toolu_sm_3', 'toolu_sb_3b')).toEqual(['stopped', 'stopped', 'running']);
  });

  it('a monitor whose timeout is not known stops working after 1 h (the bound); a persistent one does not; text-only results keep the call', async () => {
    const sid = randomUUID();
    const at = secondsAgo();
    await chunk(sid, [
      call(sid, at(3661), 'toolu_mon_nt', 'Monitor', { description: 'no timeout', command: 'tail -f x' }),
      result(sid, at(3660), 'toolu_mon_nt', 'Monitor started (task mnt1).', undefined),
      // persistent in the call, the result kept its text only
      call(sid, at(3661), 'toolu_mon_p', 'Monitor', { description: 'persistent', command: 'tail -f z', persistent: true }),
      result(sid, at(3660), 'toolu_mon_p', 'Monitor started (task mp1).', undefined),
      call(sid, at(1801), 'toolu_mon_nt2', 'Monitor', { description: 'fresh', command: 'tail -f y' }),
      result(sid, at(1800), 'toolu_mon_nt2', 'Monitor started (task mnt2).', undefined),
      // the timeout in the text of the result, or in the call
      call(sid, at(601), 'toolu_mon_txt', 'Monitor', { description: 'text', command: 'tail -f t' }),
      result(sid, at(600), 'toolu_mon_txt', 'Monitor started (task mtx1, expires in 5m unless the source ends first).', undefined),
      call(sid, at(601), 'toolu_mon_call', 'Monitor', { description: 'call', command: 'tail -f c', timeout_ms: 300_000 }),
      result(sid, at(600), 'toolu_mon_call', 'Monitor started (task mcl1).', undefined),
    ]);
    const id = await hubId(sid);
    await alive(id);
    await t.tdb.pool.query(`UPDATE sessions SET process_started_at = now() - interval '2 hours' WHERE id = $1`, [id]);
    const list = await bg(id);
    expect(list.map(v => [v.id, v.status]).sort()).toEqual([
      ['toolu_mon_call', 'expired'],
      ['toolu_mon_nt', 'expired'],
      ['toolu_mon_nt2', 'running'],
      ['toolu_mon_p', 'running'],
      ['toolu_mon_txt', 'expired'],
    ]);
    const fresh = list.find(v => v.id === 'toolu_mon_nt2')!;
    expect(Date.parse(fresh.expiresAt!) - Date.parse(fresh.startedAt!)).toBe(60 * 60_000);
    expect((await view(id)).subagents?.working).toBe(2);
    await t.hub.sessions.checkIdle();
    expect((await rowOf('toolu_mon_nt')).state).toBe('expired');
    expect((await rowOf('toolu_mon_p')).state).toBe('running');
  });
});
