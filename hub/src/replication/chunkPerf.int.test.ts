// Hot path of the agent's stream (hub-followups p. 2): time to take in a chunk (repl.chunk → repl.ack) and to look up
// the session of a session.partial. Opt-in measurement, prints numbers: AGENT_HUB_PERF=1 npx vitest run hub/src/replication/chunkPerf.int.test.ts
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentSend, autoReply, connectFakeAgent, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';
import { findByClaudeId, findSessionByClaudeId } from '../sessions/repo.js';

const RUN = process.env.AGENT_HUB_PERF === '1';
const VAULT = 'C:\\Users\\alice\\vault';

describe.skipIf(!RUN)('chunk intake and partial lookup timing', () => {
  let t: TestHub;
  let agent: FakeAgent;
  const got: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const sid = randomUUID();
  const rel = `c--Users-alice-vault/${sid}.jsonl`;

  beforeAll(async () => {
    t = await startTestHub({ sessions: { idleCheckMs: 0 } });
    const token = await t.addRunner('hp', 'HP');
    agent = connectFakeAgent(t.wsBase, token);
    agent.ws.on('message', d => got.push(JSON.parse(d.toString()) as (typeof got)[number]));
    autoReply(agent, () => ({}));
    await agent.next('welcome');
    // the session with a realistic registry: 60 subagents, 20 background commands, 10 permission requests
    const line = (n: number) =>
      JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: sid, cwd: VAULT, entrypoint: 'cli', timestamp: new Date().toISOString(), message: { role: 'user', content: `строка ${n}` } });
    agentSend(agent, 'repl.chunk', { relPath: rel, kind: 'main', sessionId: sid, generation: 0, fromLine: 0, fromByte: 0, lines: [line(0)], endByte: 100 });
    await waitFor(() => got.some(m => m.type === 'repl.ack'), 20_000);
    const id = (await t.tdb.pool.query<{ id: string }>(`SELECT id FROM sessions WHERE claude_session_id = $1`, [sid])).rows[0]!.id;
    await t.tdb.pool.query(
      `INSERT INTO subagent_runs (user_id, session_id, agent_id, tool_use_id, state, started_at, last_event_at)
       SELECT s.user_id, s.id, 'a' || g, 'toolu_' || g, CASE WHEN g % 3 = 0 THEN 'running' ELSE 'completed' END, now(), now()
       FROM sessions s, generate_series(1, 60) g WHERE s.id = $1`,
      [id],
    );
    await t.tdb.pool.query(`INSERT INTO background_tasks (session_id, tool_use_id, task_id, started_at) SELECT $1, 'tb' || g, 'b' || g, now() FROM generate_series(1, 20) g`, [id]);
    await t.tdb.pool.query(
      `INSERT INTO permission_requests (request_id, session_id, tool_name, tool_use_id, input) SELECT gen_random_uuid(), $1, 'Bash', 'tp' || g, '{}' FROM generate_series(1, 10) g`,
      [id],
    );
  });
  afterAll(async () => t.close());

  it('prints the timings', { timeout: 300_000 }, async () => {
    const N = 300;
    let from = 1;
    const times: number[] = [];
    for (let i = 0; i < N; i++) {
      const lines = Array.from({ length: 5 }, (_, k) =>
        JSON.stringify({
          type: 'assistant',
          uuid: randomUUID(),
          sessionId: sid,
          cwd: VAULT,
          entrypoint: 'cli',
          timestamp: new Date().toISOString(),
          message: { role: 'assistant', content: [{ type: 'text', text: `ответ ${i}.${k}` }] },
        }),
      );
      const acks = got.filter(m => m.type === 'repl.ack').length;
      const t0 = performance.now();
      agentSend(agent, 'repl.chunk', { relPath: rel, kind: 'main', sessionId: sid, generation: 0, fromLine: from, fromByte: from * 100, lines, endByte: (from + 5) * 100 });
      await waitFor(() => got.filter(m => m.type === 'repl.ack').length > acks, 20_000, 1);
      times.push(performance.now() - t0);
      from += 5;
    }
    const lookup = async (f: () => Promise<unknown>) => {
      const ts: number[] = [];
      for (let i = 0; i < 500; i++) {
        const t0 = performance.now();
        await f();
        ts.push(performance.now() - t0);
      }
      return ts;
    };
    const full = await lookup(() => findByClaudeId(t.tdb.db, 'hp', sid));
    const light = await lookup(() => findSessionByClaudeId(t.tdb.db, 'hp', sid));
    const stats = (a: number[]) => {
      const s = [...a].sort((x, y) => x - y);
      const p = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!.toFixed(2);
      return `median ${p(0.5)} ms, p95 ${p(0.95)} ms`;
    };
    const report = [
      `chunk of 5 lines, repl.chunk → repl.ack (${N}): ${stats(times.slice(20))}`,
      `session lookup, full selectSessions (500): ${stats(full)}`,
      `session lookup, light (500): ${stats(light)}`,
    ].join('\n');
    // the hub's test config silences console output: the numbers go to a file when asked
    if (process.env.AGENT_HUB_PERF_OUT) appendFileSync(process.env.AGENT_HUB_PERF_OUT, `${report}\n`);
    expect(times.length).toBe(N);
  });
});
