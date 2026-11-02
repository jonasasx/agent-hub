// Change session-peers (task 3.5) with the real SDK (haiku): two sessions of one agent; A sends B a message with
// session_send, B answers with inReplyTo. Checks the in-process agent-hub server in a real CLI, the wrapper in B's
// transcript, the journal of the hub. Opt-in: AGENT_HUB_REAL_SDK=1.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parsePeerMessage, type SessionView } from '@agent-hub/shared';
import { PUBLIC_URL, startTestHub, waitFor, type TestHub } from '../../hub/src/test/harness.js';
import { createAgent, type Agent } from './agent.js';
import { createLogger } from './log.js';
import { encodeCwd } from './transcripts/tailer.js';

const RUN = process.env.AGENT_HUB_REAL_SDK === '1';

describe.skipIf(!RUN)('session peers: agent + hub + real SDK (haiku)', () => {
  let t: TestHub;
  let agent: Agent;
  let cookie: string;
  let cwd: string;
  const projectsDir = join(homedir(), '.claude', 'projects');
  const lines: string[] = [];

  beforeAll(async () => {
    t = await startTestHub({ sessions: { idleCheckMs: 0 } });
    const token = await t.addRunner('hp', 'HP');
    cookie = await t.login();
    cwd = mkdtempSync(join(tmpdir(), 'agenthub-peers-'));
    agent = createAgent({
      hubUrl: `${t.wsBase}/ws/agent`,
      token,
      vaultRoot: cwd,
      claudeProjectsDir: projectsDir,
      log: createLogger({ level: 'info', write: l => void lines.push(l) }),
      backoff: { minMs: 50, maxMs: 300 },
      tailPollMs: 100,
      replMaxBytesPerSec: 1,
      // no user MCP servers or hooks, but the agent-hub server of the session must stay: no mcpServers/strictMcpConfig here
      extraOptions: { settingSources: [] },
    });
    agent.start();
    await waitFor(() => t.hub.agents.isOnline('hp'), 10_000);
  });
  afterAll(async () => {
    await agent.stop();
    await t.close();
    for (const p of [cwd, join(projectsDir, encodeCwd(cwd))]) {
      try {
        rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
      } catch {
        // left in %TEMP%
      }
    }
  });

  const api = (method: 'GET' | 'POST', url: string, payload?: object) =>
    t.hub.app.inject({ method, url, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, ...(payload ? { payload } : {}) });
  const claudeId = async (id: string) => (await t.tdb.pool.query(`SELECT claude_session_id FROM sessions WHERE id = $1`, [id])).rows[0].claude_session_id as string;
  const transcript = (sid: string) => {
    const f = join(projectsDir, encodeCwd(cwd), `${sid}.jsonl`);
    return existsSync(f) ? readFileSync(f, 'utf8') : '';
  };
  const create = async (prompt: string) => {
    const r = await api('POST', '/api/sessions', { runnerId: 'hp', cwd, model: 'haiku', permissionMode: 'bypassPermissions', prompt });
    expect(r.statusCode, r.body).toBe(201);
    return (r.json() as SessionView).id;
  };
  const waiting = (id: string) => waitFor(async () => (await t.tdb.pool.query(`SELECT status FROM sessions WHERE id = $1`, [id])).rows[0].status === 'waiting', 180_000, 300);

  it('A writes to B through session_send; B replies with inReplyTo; wrapper, journal and transcripts agree', { timeout: 600_000 }, async () => {
    const nonce = randomUUID().slice(0, 8);
    const b = await create('Ответь одним словом: готов.');
    await waiting(b);
    const bSid = await claudeId(b);

    const a = await create(
      `Вызови инструмент mcp__agent-hub__session_send с to="${b}" и text="ping-${nonce}. Ответь мне инструментом session_send: to — значение атрибута from из тега peer-message, inReplyTo — значение его атрибута id, text — pong-${nonce}." ` +
        'После вызова ответь одним словом: отправлено. Больше ничего не делай.',
    );
    const aSid = await claudeId(a);

    // B got the message: a user turn in its transcript with the wrapper
    await waitFor(() => transcript(bSid).includes(`ping-${nonce}`), 240_000, 500);
    const bText = transcript(bSid);
    expect(bText).toContain('peer-message');
    expect(bText).toContain(`from=\\"${a}\\"`);

    // B answered A: the journal has both, the second one in reply to the first
    await waitFor(async () => (await t.tdb.pool.query(`SELECT count(*)::int AS n FROM peer_messages`)).rows[0].n >= 2, 300_000, 500);
    const rows = (await t.tdb.pool.query(`SELECT id, from_session_id, to_session_id, text, in_reply_to, result FROM peer_messages ORDER BY created_at`)).rows as Array<{
      id: string;
      from_session_id: string;
      to_session_id: string;
      text: string;
      in_reply_to: string | null;
      result: string;
    }>;
    expect(rows[0]).toMatchObject({ from_session_id: a, to_session_id: b });
    expect(rows[0]!.text).toContain(`ping-${nonce}`);
    expect(rows[1]).toMatchObject({ from_session_id: b, to_session_id: a, in_reply_to: rows[0]!.id });
    expect(rows[1]!.text).toContain(`pong-${nonce}`);

    // A's transcript has the wrapped answer with in-reply-to
    await waitFor(() => transcript(aSid).includes(`pong-${nonce}`) && transcript(aSid).includes('in-reply-to'), 120_000, 500);
    const aLines = transcript(aSid)
      .split('\n')
      .filter(l => l.includes('<peer-message'))
      .map(l => {
        try {
          const j = JSON.parse(l) as { message?: { content?: unknown } };
          const c = j.message?.content;
          return typeof c === 'string' ? c : Array.isArray(c) ? c.map((x: { text?: string }) => x.text ?? '').join('') : '';
        } catch {
          return '';
        }
      });
    const parsed = aLines.map(x => parsePeerMessage(x)).find(p => p?.text.includes(`pong-${nonce}`));
    expect(parsed?.envelope).toMatchObject({ from: b, inReplyTo: rows[0]!.id });

    // the built-in server is not offered to the user as an MCP server of the session
    const mcp = await api('GET', `/api/sessions/${a}/mcp`);
    expect(JSON.stringify(mcp.json())).not.toContain('agent-hub');
  });
});
