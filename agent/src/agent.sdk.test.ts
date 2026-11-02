// Full chain on this machine: real agent + real SDK (haiku, subscription) + in-process hub + browser socket.
// Covers task 2.7 («сообщение из UI даёт поток частичного текста и итоговое событие без перезагрузки») and the
// sleep → resume → context path of 2.6 end to end. Opt-in: AGENT_HUB_REAL_SDK=1.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EventsPage, HubEvent, SessionView } from '@agent-hub/shared';
import { PUBLIC_URL, connectUi, startTestHub, waitFor, type TestHub } from '../../hub/src/test/harness.js';
import { createAgent, type Agent } from './agent.js';
import { createLogger } from './log.js';
import { encodeCwd } from './transcripts/tailer.js';

const RUN = process.env.AGENT_HUB_REAL_SDK === '1';
let offsetMs = 0;

function assistantText(events: HubEvent[]): string {
  return events
    .filter((e): e is Extract<HubEvent, { kind: 'line' }> => e.kind === 'line' && e.line.type === 'assistant')
    .flatMap(e => ((e.line.message as { content?: Array<{ type: string; text?: string }> }).content ?? []).filter(b => b.type === 'text').map(b => b.text ?? ''))
    .join('\n');
}

describe.skipIf(!RUN)('agent + hub + real SDK (haiku)', () => {
  let t: TestHub;
  let agent: Agent;
  let cookie: string;
  let cwd: string;
  beforeAll(async () => {
    t = await startTestHub({ sessions: { now: () => new Date(Date.now() + offsetMs), idleCheckMs: 0 } });
    const token = await t.addRunner('hp', 'HP');
    cookie = await t.login();
    cwd = mkdtempSync(join(tmpdir(), 'agenthub-e2e-'));
    agent = createAgent({
      hubUrl: `${t.wsBase}/ws/agent`,
      token,
      vaultRoot: cwd,
      claudeProjectsDir: join(homedir(), '.claude', 'projects'),
      log: createLogger({ level: 'warn', write: () => undefined }),
      backoff: { minMs: 50, maxMs: 300 },
      tailPollMs: 100,
      // Only this test's session: the machine's history (hundreds of real transcripts) is not copied into the test hub.
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
  const view = async (id: string) => (await api('GET', `/api/sessions/${id}`)).json() as SessionView;

  it('start from the API, partial text and final event reach the browser socket; sleep and resume keep the context', { timeout: 400_000 }, async () => {
    const ui = connectUi(t.wsBase, cookie);
    await ui.open;
    const r = await api('POST', '/api/sessions', { runnerId: 'hp', cwd, model: 'haiku', prompt: 'Запомни число 4817. Ответь одним словом: Запомнил.' });
    expect(r.statusCode).toBe(201);
    const s = r.json() as SessionView;
    ui.send({ type: 'subscribe', sessionIds: [s.id] });
    ui.send({ type: 'presence', visible: true, activeSessionIds: [s.id] });

    await waitFor(() => ui.received.some(m => m.type === 'session.partial' && m.sessionId === s.id), 120_000, 200);
    const final = await waitFor(() => ui.received.find(m => m.type === 'session.events' && m.sessionId === s.id && /Запомнил/i.test(assistantText(m.events as HubEvent[]))), 120_000, 200);
    expect(final).toBeTruthy();
    await waitFor(async () => (await view(s.id)).status === 'waiting', 60_000, 200);
    const sv = await view(s.id);
    expect(sv.unread).toBe(false); // visible and active in this client
    expect(sv.sleepsAt).not.toBeNull();

    // Sleep after the idle timeout: the process ends, history stays.
    offsetMs = 31 * 60_000;
    expect(await t.hub.sessions.checkIdle()).toBe(1);
    offsetMs = 0;
    await waitFor(async () => (await view(s.id)).status === 'sleeping', 30_000, 200);
    expect(agent.sessions.liveSessions()).toEqual([]);

    // A message resumes the session on the same machine with the conversation intact.
    const m = await api('POST', `/api/sessions/${s.id}/messages`, { text: 'Какое число я просил запомнить? Ответь только числом.', clientUuid: randomUUID() });
    expect(m.statusCode).toBe(202);
    await waitFor(
      async () => {
        const page = (await api('GET', `/api/sessions/${s.id}/events?limit=500`)).json() as EventsPage;
        return assistantText(page.events).includes('4817');
      },
      180_000,
      500,
    );
    const page = (await api('GET', `/api/sessions/${s.id}/events?limit=500`)).json() as EventsPage;
    expect(page.events.some(e => e.kind === 'note' && e.text === 'Поднята через resume')).toBe(true);

    // Task 3.5: the local .jsonl is deleted; a message restores it from the hub copy and the context survives.
    await waitFor(async () => (await view(s.id)).status === 'waiting', 60_000, 200);
    offsetMs = 31 * 60_000;
    expect(await t.hub.sessions.checkIdle()).toBe(1);
    offsetMs = 0;
    await waitFor(async () => (await view(s.id)).status === 'sleeping', 30_000, 200);
    // Let the replication deliver the last lines before the file goes away.
    await new Promise(r => setTimeout(r, 2000));
    const transcript = join(homedir(), '.claude', 'projects', await agent.replicator.projectDirFor(cwd), `${s.id}.jsonl`);
    expect(existsSync(transcript)).toBe(true);
    unlinkSync(transcript);
    const m2 = await api('POST', `/api/sessions/${s.id}/messages`, { text: 'Повтори ещё раз число, которое я просил запомнить. Только число.', clientUuid: randomUUID() });
    expect(m2.statusCode).toBe(202);
    await waitFor(
      async () => {
        const p = (await api('GET', `/api/sessions/${s.id}/events?limit=500`)).json() as EventsPage;
        return p.events.some(e => e.kind === 'note' && e.text.startsWith('Транскрипт восстановлен')) && (assistantText(p.events).match(/4817/g) ?? []).length >= 2;
      },
      180_000,
      500,
    );
    expect(existsSync(transcript)).toBe(true);
    ui.ws.close();
  });
});

// claude-subscriptions task 3.4: the real SDK starts a process under a (fake) subscription token. No prompt is sent, so
// no model turn and no quota: the CLI only initialises. Runs in every `npm test` (no AGENT_HUB_REAL_SDK needed).
describe('a process under a subscription token (real SDK, no turn)', () => {
  it('init comes, options.env carries the token and no API key, the token is in no log line', async () => {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const { SessionManager } = await import('./sessions/manager.js');
    const token = 'sk-ant-oat01-' + 'Zx'.repeat(40) + 'fake';
    const seen: Array<Parameters<typeof query>[0]['options']> = [];
    const lines: string[] = [];
    const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const dir = mkdtempSync(join(tmpdir(), 'agenthub-sub-'));
    const mgr = new SessionManager({
      send: (type, payload) => void sent.push({ type, payload: payload as Record<string, unknown> }),
      log: createLogger({ level: 'debug', write: l => void lines.push(l) }),
      queryFn: p => {
        seen.push(p.options);
        return query(p);
      },
      // no settings, CLAUDE.md or MCP of this machine: a fast init; the subscription env still built on process.env
      extraOptions: { settingSources: [], mcpServers: {}, strictMcpConfig: true },
      stopGraceMs: 10_000,
    });
    const sessionId = randomUUID();
    try {
      const ok = await mgr.handle({
        v: 1,
        ts: Date.now(),
        id: randomUUID(),
        type: 'session.start',
        payload: { sessionId, cwd: dir, permissionMode: 'default', model: 'haiku', prompt: '', promptUuid: randomUUID(), subscription: { id: randomUUID(), token } },
      });
      // cmd.ok comes after the CLI's initialisation (D3)
      expect(ok).toHaveProperty('models');
      const env = seen[0]!.env!;
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(token);
      expect('ANTHROPIC_API_KEY' in env).toBe(false);
      expect('ANTHROPIC_AUTH_TOKEN' in env).toBe(false);
      expect(mgr.liveSessions()).toEqual([{ sessionId, state: 'waiting' }]);
    } finally {
      await mgr.stopAll(10_000);
      for (const p of [dir, join(homedir(), '.claude', 'projects', encodeCwd(dir))]) {
        try {
          rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
        } catch {
          // left in %TEMP%
        }
      }
    }
    for (const l of [...lines, ...sent.map(m => JSON.stringify(m))]) expect(l).not.toContain(token.slice(-12));
  }, 120_000);
});
