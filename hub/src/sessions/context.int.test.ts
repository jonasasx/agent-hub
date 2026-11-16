// spec session-context-usage: «Снимок контекстного окна», «Разбивка контекстного окна» — the hub stores the last
// `session.context` of a session, ignores an older one, shows the numbers in SessionView and the breakdown in the API.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionContextResponse, SessionView } from '@agent-hub/shared';
import { PUBLIC_URL, agentSend, autoReply, connectFakeAgent, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';
import * as F from '../test/transcriptFixtures.js';

describe('session context (integration)', () => {
  let t: TestHub;
  let cookie: string;
  let hp: FakeAgent;
  const acked: string[] = [];
  const api = (url: string) => t.hub.app.inject({ method: 'GET', url, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL } });

  async function session() {
    const sid = randomUUID();
    const o = { sessionId: sid, cwd: 'C:\\work\\ctx', entrypoint: 'cli' as const };
    const before = acked.length;
    const lines = [F.userText(o, 'проверь контекст'), F.assistantText(o, 'ок')];
    agentSend(hp, 'repl.chunk', {
      relPath: `c--work-ctx/${sid}.jsonl`,
      kind: 'main',
      sessionId: sid,
      generation: 0,
      fromLine: 0,
      fromByte: 0,
      lines: lines.map(l => JSON.stringify(l)),
      endByte: lines.length * 100,
    });
    await waitFor(() => acked.length > before, 20_000);
    const id = (await t.tdb.pool.query<{ id: string }>(`SELECT id FROM sessions WHERE claude_session_id = $1`, [sid])).rows[0]!.id;
    return { id, sid };
  }

  const snapshot = (sessionId: string, observedAt: number, usedTokens: number) => ({
    sessionId,
    observedAt,
    model: 'claude-haiku-5-5',
    usedTokens,
    windowTokens: 200000,
    percent: Math.round((usedTokens / 200000) * 100),
    categories: [
      { id: 'system_prompt', name: 'System prompt', kind: 'used', tokens: usedTokens },
      { id: 'free_space', name: 'Free space', kind: 'free', tokens: 200000 - usedTokens },
    ],
    mcpServers: [{ name: 'agent-hub', tools: 3, loadedTools: 1, tokens: 900 }],
  });

  const contextOf = async (id: string) => ((await api(`/api/sessions/${id}`)).json() as SessionView).context;

  beforeAll(async () => {
    t = await startTestHub({ sessions: { idleCheckMs: 0 } });
    const token = await t.addRunner('hp', 'HP');
    cookie = await t.login();
    hp = connectFakeAgent(t.wsBase, token);
    hp.ws.on('message', d => {
      const m = JSON.parse(d.toString()) as { type: string };
      if (m.type === 'repl.ack') acked.push(m.type);
    });
    autoReply(hp, type => {
      throw Object.assign(new Error(`${type} not scripted`), { code: 'not_implemented' });
    });
    await hp.next('welcome');
  });
  afterAll(async () => t.close());

  it('a session without a snapshot has no context', async () => {
    const s = await session();
    expect(await contextOf(s.id)).toBeNull();
    const res = await api(`/api/sessions/${s.id}/context`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ context: null });
  });

  it('stores the snapshot: numbers in SessionView, breakdown in GET …/context; an older snapshot is ignored', async () => {
    const s = await session();
    agentSend(hp, 'session.context', snapshot(s.sid, 2_000_000, 66000));
    await waitFor(async () => (await contextOf(s.id)) != null, 10_000);
    expect(await contextOf(s.id)).toEqual({ usedTokens: 66000, windowTokens: 200000, percent: 33 });
    const body = (await api(`/api/sessions/${s.id}/context`)).json() as SessionContextResponse;
    expect(body.context).toMatchObject({ model: 'claude-haiku-5-5', usedTokens: 66000, percent: 33, observedAt: new Date(2_000_000).toISOString() });
    expect(body.context?.categories?.map(c => c.id)).toEqual(['system_prompt', 'free_space']);
    expect(body.context?.mcpServers).toEqual([{ name: 'agent-hub', tools: 3, loadedTools: 1, tokens: 900 }]);
    expect(body.context).not.toHaveProperty('sessionId');

    agentSend(hp, 'session.context', snapshot(s.sid, 1_000_000, 10000));
    agentSend(hp, 'session.context', snapshot(s.sid, 3_000_000, 120000));
    await waitFor(async () => (await contextOf(s.id))?.usedTokens === 120000, 10_000);
    agentSend(hp, 'session.context', snapshot(s.sid, 2_500_000, 5000));
    // the next newer one proves the older one before it was handled and skipped
    agentSend(hp, 'session.context', snapshot(s.sid, 4_000_000, 130000));
    await waitFor(async () => (await contextOf(s.id))?.usedTokens === 130000, 10_000);
    const rows = await t.tdb.pool.query(`SELECT count(*)::int AS n FROM session_context WHERE session_id = $1`, [s.id]);
    expect(rows.rows[0]).toEqual({ n: 1 });
  });

  it('a snapshot of an unknown session is dropped without breaking the connection', async () => {
    agentSend(hp, 'session.context', snapshot(randomUUID(), 1, 1));
    const s = await session();
    agentSend(hp, 'session.context', snapshot(s.sid, 5, 2000));
    await waitFor(async () => (await contextOf(s.id))?.usedTokens === 2000, 10_000);
  });
});
