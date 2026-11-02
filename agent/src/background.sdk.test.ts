// Change update-waits-background-tasks with the real SDK (haiku): a turn starts a background Bash command and ends;
// the agent stays busy (Requirement: Занятость агента) until the command finishes. Catches a CLI that stops sending
// system/background_tasks_changed or changes its format. Opt-in: AGENT_HUB_REAL_SDK=1.
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionView } from '@agent-hub/shared';
import { PUBLIC_URL, startTestHub, waitFor, type TestHub } from '../../hub/src/test/harness.js';
import { createAgent, type Agent } from './agent.js';
import { createLogger } from './log.js';
import { encodeCwd } from './transcripts/tailer.js';

const RUN = process.env.AGENT_HUB_REAL_SDK === '1';

describe.skipIf(!RUN)('background tasks: agent + hub + real SDK (haiku)', () => {
  let t: TestHub;
  let agent: Agent;
  let cookie: string;
  let cwd: string;
  const lines: string[] = [];
  beforeAll(async () => {
    t = await startTestHub({ sessions: { idleCheckMs: 0 } });
    const token = await t.addRunner('hp', 'HP');
    cookie = await t.login();
    cwd = mkdtempSync(join(tmpdir(), 'agenthub-bg-'));
    agent = createAgent({
      hubUrl: `${t.wsBase}/ws/agent`,
      token,
      vaultRoot: cwd,
      claudeProjectsDir: join(homedir(), '.claude', 'projects'),
      log: createLogger({ level: 'info', write: l => void lines.push(l) }),
      backoff: { minMs: 50, maxMs: 300 },
      tailPollMs: 100,
      replMaxBytesPerSec: 1,
      // no user MCP servers / hooks: a plain process
      extraOptions: { settingSources: [], mcpServers: {}, strictMcpConfig: true },
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

  it('«Ход окончен, фоновая команда работает» → busy; after it ends → not busy', { timeout: 300_000 }, async () => {
    const r = await api('POST', '/api/sessions', {
      runnerId: 'hp',
      cwd,
      model: 'haiku',
      permissionMode: 'bypassPermissions',
      prompt: 'Запусти инструментом Bash команду `sleep 20` с параметром run_in_background: true. Не жди её завершения и ничего больше не делай — сразу ответь одним словом: Запущено.',
    });
    expect(r.statusCode).toBe(201);
    const s = r.json() as SessionView;
    // the turn ended while the command still runs
    await waitFor(
      () => agent.sessions.liveSessions().some(x => x.sessionId === s.id && x.state === 'waiting') && lines.some(l => l.includes('background tasks changed') && l.includes('"active":1')),
      120_000,
      100,
    );
    const ended = Date.now();
    expect(agent.sessions.liveSessions().find(x => x.sessionId === s.id)?.state).toBe('waiting');
    expect(agent.turns.busy).toBe(true);
    // the command ends (20 s); the CLI may run a short follow-up turn on its notification — then waits again
    await waitFor(() => !agent.turns.busy, 90_000, 200);
    expect(Date.now() - ended).toBeLessThan(90_000);
    expect(lines.some(l => l.includes('background tasks changed') && l.includes('"active":0'))).toBe(true);
  });
});
