// Change `subagents` with the real SDK (haiku, subscription): a session calls the Agent tool; the hub registry shows
// the subagent as running while it works, then completed, linked to its call and to its transcript. Opt-in:
// AGENT_HUB_REAL_SDK=1.
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionView, SubagentView, SubagentsResponse } from '@agent-hub/shared';
import { PUBLIC_URL, connectUi, startTestHub, waitFor, type TestHub } from '../../hub/src/test/harness.js';
import { createAgent, type Agent } from './agent.js';
import { createLogger } from './log.js';
import { encodeCwd } from './transcripts/tailer.js';

const RUN = process.env.AGENT_HUB_REAL_SDK === '1';

describe.skipIf(!RUN)('subagents: agent + hub + real SDK (haiku)', () => {
  let t: TestHub;
  let agent: Agent;
  let cookie: string;
  let cwd: string;
  beforeAll(async () => {
    t = await startTestHub({ sessions: { idleCheckMs: 0 } });
    const token = await t.addRunner('hp', 'HP');
    cookie = await t.login();
    cwd = mkdtempSync(join(tmpdir(), 'agenthub-sub-'));
    agent = createAgent({
      hubUrl: `${t.wsBase}/ws/agent`,
      token,
      vaultRoot: cwd,
      claudeProjectsDir: join(homedir(), '.claude', 'projects'),
      log: createLogger({ level: 'warn', write: () => undefined }),
      backoff: { minMs: 50, maxMs: 300 },
      tailPollMs: 100,
      // only this test's session (own sessions ignore the limit): not the machine's history
      replMaxBytesPerSec: 1,
    });
    agent.start();
    await waitFor(() => t.hub.agents.isOnline('hp'), 10_000);
  });
  afterAll(async () => {
    await agent.stop();
    await t.close();
    for (const p of [cwd, join(homedir(), '.claude', 'projects', encodeCwd(cwd))]) {
      try {
        rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
      } catch {
        // left in %TEMP%
      }
    }
  });

  const api = (method: 'GET' | 'POST', url: string, payload?: object) =>
    t.hub.app.inject({ method, url, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, ...(payload ? { payload } : {}) });
  const subs = async (id: string) => ((await api('GET', `/api/sessions/${id}/subagents`)).json() as SubagentsResponse).subagents;

  it('the Agent tool call: running while the subagent works → completed, linked to the call and its transcript', { timeout: 400_000 }, async () => {
    const ui = connectUi(t.wsBase, cookie);
    await ui.open;
    const r = await api('POST', '/api/sessions', {
      runnerId: 'hp',
      cwd,
      model: 'haiku',
      permissionMode: 'bypassPermissions',
      prompt:
        'Вызови инструмент Agent ровно один раз: subagent_type "general-purpose", description "sleep probe", prompt "Выполни Bash-команду `sleep 15` и ответь одним словом: ГОТОВО". ' +
        'Дождись его результата и ответь одним словом: Сделано.',
    });
    expect(r.statusCode).toBe(201);
    const s = r.json() as SessionView;
    ui.send({ type: 'subscribe', sessionIds: [s.id] });

    const running = await waitFor(async () => (await subs(s.id)).find(x => x.status === 'running' && x.toolUseId), 180_000, 200);
    expect(running).toMatchObject({ kind: 'subagent', agentType: 'general-purpose', description: 'sleep probe', session: { id: s.id } });
    expect(((await api('GET', `/api/sessions/${s.id}`)).json() as SessionView).subagents).toMatchObject({ total: 1, running: 1 });

    const done = await waitFor(async () => (await subs(s.id)).find(x => x.id === running.id && x.status === 'completed'), 240_000, 500);
    expect(done.toolUseId).toBe(running.toolUseId);
    expect(done.agentId).toMatch(/^a[0-9a-f]+$/);
    // the transcript of the subagent reaches the hub and is linked to the same row
    const linked = await waitFor(async () => (await subs(s.id)).find(x => x.id === running.id && x.hasTranscript), 60_000, 500);
    expect(linked.eventCount).toBeGreaterThan(0);
    expect(await subs(s.id)).toHaveLength(1);
    const ev = (await api('GET', `/api/subagents/${running.id}/events?limit=200`)).json() as { events: unknown[] };
    expect(ev.events.length).toBeGreaterThan(0);
    expect(ui.received.some(m => m.type === 'subagent.upsert' && (m.subagent as SubagentView).id === running.id)).toBe(true);
    ui.ws.close();
  });
});
