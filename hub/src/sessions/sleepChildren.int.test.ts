// Fix «засыпание убивает работающих субагентов»: the idle timer counts the session as a whole — its subagents and
// background commands — and the UI countdown (SessionView.sleepsAt) follows the same rule as the scheduler.
// Real hub, Postgres, a scripted agent and a fake clock.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionView } from '@agent-hub/shared';
import { PUBLIC_URL, agentSend, autoReply, connectFakeAgent, connectUi, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';

const VAULT = 'C:\\Users\\alice\\vault';
const MIN = 60_000;
let offsetMs = 0;
const clock = () => new Date(Date.now() + offsetMs);

describe('sleep counts subagents and background commands (integration)', () => {
  let t: TestHub;
  let cookie: string;
  let agent: FakeAgent;
  const got: Array<{ type: string; payload: Record<string, unknown> }> = [];

  const api = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    t.hub.app.inject({ method, url, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const view = async (id: string) => (await api('GET', `/api/sessions/${id}`)).json() as SessionView;
  const stops = (id: string) => got.filter(m => m.type === 'session.stop' && m.payload.sessionId === id).length;
  /** Hub clock now minus `min` minutes. */
  const ago = (min: number) => new Date(clock().getTime() - min * MIN);

  /** A live session that finished its turn `quietMin` minutes ago (status waiting, process alive). */
  async function waitingSession(quietMin: number): Promise<string> {
    offsetMs = 0;
    const r = await api('POST', '/api/sessions', { runnerId: 'hp', cwd: VAULT, model: 'haiku', prompt: 'запусти субагентов' });
    expect(r.statusCode).toBe(201);
    const id = (r.json() as SessionView).id;
    await waitFor(() => got.some(m => m.type === 'session.start' && m.payload.sessionId === id), 20_000);
    const at = ago(quietMin);
    await t.tdb.pool.query(`UPDATE sessions SET status = 'waiting', process_alive = true, last_turn_end_at = $2, last_input_at = $2, last_event_at = $2 WHERE id = $1`, [id, at]);
    return id;
  }

  async function subagent(sessionId: string, o: { state: string; lastEventMin: number; startedMin?: number }) {
    await t.tdb.pool.query(
      `INSERT INTO subagent_runs (user_id, session_id, agent_id, tool_use_id, state, started_at, last_event_at, state_at, background)
       SELECT user_id, id, $2, $3, $4, $5, $6, $6, true FROM sessions WHERE id = $1`,
      [sessionId, randomUUID().slice(0, 16), `toolu_${randomUUID()}`, o.state, ago(o.startedMin ?? o.lastEventMin + 1), ago(o.lastEventMin)],
    );
  }

  /** Moves the hub clock `min` minutes ahead and runs one pass of the sleep scheduler. */
  async function after(min: number): Promise<void> {
    offsetMs = min * MIN;
    await t.hub.sessions.checkIdle();
  }

  beforeAll(async () => {
    t = await startTestHub({ sessions: { now: clock, idleCheckMs: 0, initTimeoutMs: 2000 } });
    const token = await t.addRunner('hp', 'HP');
    cookie = await t.login();
    agent = connectFakeAgent(t.wsBase, token);
    agent.ws.on('message', d => got.push(JSON.parse(d.toString()) as (typeof got)[number]));
    autoReply(agent, type => {
      if (type === 'fs.stat') return { exists: true, isDir: true };
      if (type === 'session.start' || type === 'session.resume') return { models: [] };
      return {};
    });
    await agent.next('welcome');
  });
  afterAll(async () => {
    offsetMs = 0;
    await t.close();
  });

  it('waiting with a working subagent: awake after 31 min; the countdown shows the stall guard (120 min)', async () => {
    const id = await waitingSession(0);
    await subagent(id, { state: 'running', lastEventMin: 0 });
    const v = await view(id);
    const subAt = Date.parse(v.lastEventAt!);
    // 120 min from the latest activity (the subagent's event is not earlier than the turn end here)
    expect(Date.parse(v.sleepsAt!) - subAt).toBeGreaterThanOrEqual(119 * MIN);
    await after(31);
    expect(stops(id)).toBe(0);
    expect((await view(id)).status).toBe('waiting');
    await after(0);
  });

  it('the subagent wrote 10 min ago, the leader is silent for 40 min: awake, the count starts at the subagent', async () => {
    const id = await waitingSession(40);
    await subagent(id, { state: 'completed', lastEventMin: 10, startedMin: 39 });
    const v = await view(id);
    // 30 min from the subagent's event, i.e. 20 min from now (a minute of tolerance for the test's own run time)
    const left = Date.parse(v.sleepsAt!) - clock().getTime();
    expect(left).toBeGreaterThan(19 * MIN);
    expect(left).toBeLessThanOrEqual(20 * MIN);
    await after(0);
    expect(stops(id)).toBe(0);
    await after(19);
    expect(stops(id)).toBe(0);
    await after(21);
    expect(stops(id)).toBe(1);
    expect((await view(id)).status).toBe('sleeping');
  });

  it('all subagents ended: the usual 30 min from the last activity', async () => {
    const id = await waitingSession(5);
    await subagent(id, { state: 'completed', lastEventMin: 6 });
    await subagent(id, { state: 'failed', lastEventMin: 8 });
    const v = await view(id);
    expect(Date.parse(v.sleepsAt!) - Date.parse(v.lastTurnEndAt!)).toBe(30 * MIN);
    await after(24);
    expect(stops(id)).toBe(0);
    await after(26);
    expect(stops(id)).toBe(1);
  });

  it('a «running» row with no events for 121 min falls asleep (stall guard)', async () => {
    const id = await waitingSession(121);
    await subagent(id, { state: 'running', lastEventMin: 121, startedMin: 125 });
    // the row belongs to the current process (started 130 min ago): it «works», only the stall guard applies
    await t.tdb.pool.query(`UPDATE sessions SET process_started_at = $2 WHERE id = $1`, [id, ago(130)]);
    expect((await view(id)).subagents?.working).toBe(1);
    await after(0);
    expect(stops(id)).toBe(1);
    expect((await view(id)).status).toBe('sleeping');
  });

  it('children of a crashed process do not work after resume (no slept_at on a crash)', async () => {
    const id = await waitingSession(5);
    await subagent(id, { state: 'running', lastEventMin: 6, startedMin: 8 });
    await t.tdb.pool.query(`INSERT INTO background_tasks (session_id, tool_use_id, task_id, started_at) VALUES ($1, 'toolu_crash_bg', 'cb1', $2)`, [id, ago(7)]);
    await t.tdb.pool.query(`UPDATE sessions SET process_started_at = $2 WHERE id = $1`, [id, ago(10)]);
    expect((await view(id)).subagents?.working).toBe(2);
    agentSend(agent, 'session.exited', { sessionId: id, code: 1, reason: 'crashed', errorText: 'boom' });
    await waitFor(async () => !(await view(id)).processAlive, 10_000);
    expect((await view(id)).sleptAt).toBeNull();
    expect((await view(id)).subagents?.working).toBe(0);
    // resume: a new process; the old children stay «running» in the registry but do not work
    expect((await api('POST', `/api/sessions/${id}/wake`, {})).statusCode).toBe(202);
    await waitFor(async () => (await view(id)).processAlive, 10_000);
    const v = await view(id);
    expect(v.subagents?.working).toBe(0);
    expect(Date.parse(v.sleepsAt!) - Date.parse(v.lastTurnEndAt!)).toBe(30 * MIN);
    await after(31);
    expect(stops(id)).toBe(1);
  });

  it('an external session raised from the hub: an old background command without notification does not work', async () => {
    const id = await waitingSession(0);
    await t.tdb.pool.query(
      `UPDATE sessions SET status = 'closed', process_alive = false, process_started_at = NULL, slept_at = NULL, source = 'terminal', is_hub_managed = false, last_external_write_at = NULL WHERE id = $1`,
      [id],
    );
    await t.tdb.pool.query(`INSERT INTO background_tasks (session_id, tool_use_id, task_id, started_at) VALUES ($1, 'toolu_ext_bg', 'eb1', $2)`, [id, ago(300)]);
    expect((await api('POST', `/api/sessions/${id}/wake`, {})).statusCode).toBe(202);
    await waitFor(async () => (await view(id)).processAlive, 10_000);
    expect((await view(id)).subagents?.working).toBe(0);
    await after(31);
    expect(stops(id)).toBe(1);
  });

  it('a running row of a process that went to sleep before does not hold the resumed session', async () => {
    const id = await waitingSession(35);
    await subagent(id, { state: 'running', lastEventMin: 50, startedMin: 55 });
    await t.tdb.pool.query(`UPDATE sessions SET slept_at = $2 WHERE id = $1`, [id, ago(45)]);
    await after(0);
    expect(stops(id)).toBe(1);
  });

  it('SessionView.subagents.working: running subagents and background commands; idle teammates and ended rows do not count', async () => {
    const id = await waitingSession(0);
    await subagent(id, { state: 'running', lastEventMin: 0 });
    await subagent(id, { state: 'idle', lastEventMin: 0 });
    await subagent(id, { state: 'completed', lastEventMin: 1 });
    await t.tdb.pool.query(`INSERT INTO background_tasks (session_id, tool_use_id, task_id, started_at) VALUES ($1, 'toolu_bg', 'bg1', $2)`, [id, ago(0)]);
    expect((await view(id)).subagents).toMatchObject({ total: 3, running: 1, working: 2 }); // the idle teammate is neither
    await t.tdb.pool.query(`UPDATE sessions SET process_alive = false, status = 'sleeping', slept_at = $2 WHERE id = $1`, [id, ago(0)]);
    expect((await view(id)).subagents).toMatchObject({ running: 0, working: 0 });
  });

  it('a background Bash command from the transcript keeps the session awake until its notification, then 30 min', async () => {
    const id = await waitingSession(0);
    const ui = connectUi(t.wsBase, cookie);
    await ui.open;
    const upserts = (working: number) => ui.received.some(m => m.type === 'session.upsert' && (m.session as SessionView).id === id && (m.session as SessionView).subagents?.working === working);
    const rel = `c--Users-alice-vault/${id}.jsonl`;
    const toolUseId = `toolu_${randomUUID().replaceAll('-', '')}`;
    const t0 = clock();
    const iso = (d: Date) => d.toISOString();
    const started = [
      {
        type: 'assistant',
        uuid: randomUUID(),
        timestamp: iso(t0),
        message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'sleep 3600', run_in_background: true } }] },
      },
      {
        type: 'user',
        uuid: randomUUID(),
        timestamp: iso(t0),
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'Command running in background with ID: b1x2y3z. Output is being written to: C:\\tmp\\b1x2y3z.output' }],
        },
      },
    ];
    let acks = got.filter(m => m.type === 'repl.ack' && m.payload.relPath === rel).length;
    agentSend(agent, 'repl.chunk', { relPath: rel, kind: 'main', sessionId: id, generation: 0, fromLine: 0, fromByte: 0, lines: started.map(l => JSON.stringify(l)), endByte: 200 });
    await waitFor(() => got.filter(m => m.type === 'repl.ack' && m.payload.relPath === rel).length > acks, 20_000);
    const row = await t.tdb.pool.query(`SELECT task_id, state FROM background_tasks WHERE session_id = $1`, [id]);
    expect(row.rows).toEqual([{ task_id: 'b1x2y3z', state: 'running' }]);
    // the parent's session.upsert goes right away with the working command (not once a minute)
    await waitFor(() => upserts(1), 5000);

    await after(31);
    expect(stops(id)).toBe(0);
    await after(100);
    expect(stops(id)).toBe(0);

    // The command ends 110 min after the start: from then on the usual 30 min.
    const end = new Date(t0.getTime() + 110 * MIN);
    const notification = `<task-notification>\n<task-id>b1x2y3z</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n<summary>Background command completed</summary>\n</task-notification>`;
    acks = got.filter(m => m.type === 'repl.ack' && m.payload.relPath === rel).length;
    agentSend(agent, 'repl.chunk', {
      relPath: rel,
      kind: 'main',
      sessionId: id,
      generation: 0,
      fromLine: 2,
      fromByte: 200,
      lines: [JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(end), sessionId: id, content: notification })],
      endByte: 400,
    });
    await waitFor(() => got.filter(m => m.type === 'repl.ack' && m.payload.relPath === rel).length > acks, 20_000);
    expect((await t.tdb.pool.query(`SELECT state FROM background_tasks WHERE session_id = $1`, [id])).rows).toEqual([{ state: 'completed' }]);
    await waitFor(() => upserts(0), 5000);
    ui.ws.close();
    await after(110 + 29);
    expect(stops(id)).toBe(0);
    await after(110 + 31);
    expect(stops(id)).toBe(1);
  });
});
