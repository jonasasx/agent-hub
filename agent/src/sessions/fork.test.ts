// session.fork and handoff.generate (design D14, tasks 4.12, 4.14) against stubs of the SDK; the real SDK:
// agent/src/fork.sdk.test.ts.
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { HubMessage, PayloadOf } from '@agent-hub/shared';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../log.js';
import { CmdError, SessionManager, type ForkFn, type OneShotFn } from './manager.js';

/** An absolute path of this machine's OS (the agent refuses the other kind). */
const LOCAL = process.platform === 'win32' ? 'C:\\Users\\alice\\vault' : '/home/ubuntu/vault';
const cmd = <T extends HubMessage['type']>(type: T, payload: PayloadOf<HubMessage, T>): HubMessage => ({ v: 1, ts: Date.now(), id: randomUUID(), type, payload }) as HubMessage;

function oneShot(messages: Array<Record<string, unknown>>, seen: Array<{ prompt: string; options: Options }>): OneShotFn {
  return p => {
    seen.push(p);
    async function* gen() {
      for (const m of messages) yield m as unknown as SDKMessage;
    }
    return gen() as unknown as Query;
  };
}

function manager(o: { forkFn?: ForkFn; oneShotFn?: OneShotFn; projectsDir?: string; log?: ReturnType<typeof createLogger> } = {}) {
  return new SessionManager({
    send: () => undefined,
    log: createLogger({ level: 'error', write: () => undefined }),
    queryFn: () => {
      throw new Error('no live session in these tests');
    },
    scratchDir: '/tmp/agent-hub-scratch',
    ...o,
  });
}

describe('session.fork', () => {
  it('forkSession of the SDK into the project of cwd with the title; the new id back', async () => {
    const calls: Array<[string, unknown]> = [];
    const m = manager({ forkFn: async (id, opts) => (calls.push([id, opts]), { sessionId: 'b2c3d4e5-0000-4000-8000-000000000001' }) });
    const src = randomUUID();
    await expect(m.handle(cmd('session.fork', { sourceSessionId: src, cwd: 'C:\\Users\\alice\\vault', title: 'X (копия)' }))).resolves.toEqual({
      newSessionId: 'b2c3d4e5-0000-4000-8000-000000000001',
    });
    expect(calls).toEqual([[src, { dir: 'C:\\Users\\alice\\vault', title: 'X (копия)' }]]);
    expect(m.liveSessions()).toEqual([]); // nothing started
  });

  it('a source not found under the project folder of dir (8.3 short path) is looked up in every project folder; the folder of the copy is logged', async () => {
    const calls: unknown[] = [];
    const projects = mkdtempSync(join(tmpdir(), 'agenthub-projects-'));
    mkdirSync(join(projects, 'C--Users-IVOLYN-1-x'));
    writeFileSync(join(projects, 'C--Users-IVOLYN-1-x', 'b2c3d4e5-0000-4000-8000-000000000002.jsonl'), '{}\n');
    const logs: string[] = [];
    const m = manager({
      projectsDir: projects,
      log: createLogger({ level: 'info', write: l => logs.push(l) }),
      forkFn: async (id, opts) => {
        calls.push(opts);
        if (opts.dir) throw new Error(`Session ${id} not found in project directory for ${opts.dir}`);
        return { sessionId: 'b2c3d4e5-0000-4000-8000-000000000002' };
      },
    });
    await expect(m.handle(cmd('session.fork', { sourceSessionId: randomUUID(), cwd: LOCAL }))).resolves.toEqual({ newSessionId: 'b2c3d4e5-0000-4000-8000-000000000002' });
    expect(calls).toEqual([{ dir: LOCAL }, {}]);
    expect(logs.join('\n')).toMatch(/source looked up in every project folder[\s\S]*C--Users-IVOLYN-1-x/);
    rmSync(projects, { recursive: true, force: true });
  });

  it('a failure of the SDK is fork_failed; a UNC directory is refused before the SDK', async () => {
    let called = 0;
    const m = manager({
      forkFn: async () => {
        called++;
        throw new Error('Session not found');
      },
    });
    await expect(m.handle(cmd('session.fork', { sourceSessionId: randomUUID(), cwd: LOCAL }))).rejects.toMatchObject({ code: 'fork_failed', message: 'Session not found' });
    expect(called).toBe(1);
    await expect(m.handle(cmd('session.fork', { sourceSessionId: randomUUID(), cwd: '\\\\host\\share' }))).rejects.toBeInstanceOf(CmdError);
    expect(called).toBe(1); // refused before the SDK
  });
});

describe('handoff.generate', () => {
  it('one turn without tools, settings, MCP and transcript, in the scratch directory; the text of the answer', async () => {
    const seen: Array<{ prompt: string; options: Options }> = [];
    const m = manager({
      oneShotFn: oneShot(
        [
          { type: 'system', subtype: 'init' },
          { type: 'assistant', message: { content: [{ type: 'text', text: '## Цель\nчерновик' }] } },
          { type: 'result', subtype: 'success', is_error: false, result: '## Цель\nПочинить сборку' },
        ],
        seen,
      ),
    });
    await expect(m.handle(cmd('handoff.generate', { transcript: 'Пользователь: цель', model: 'sonnet', systemPrompt: 'разделы' }))).resolves.toEqual({ text: '## Цель\nПочинить сборку' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.prompt).toBe('Пользователь: цель');
    expect(seen[0]!.options).toMatchObject({
      cwd: '/tmp/agent-hub-scratch',
      model: 'sonnet',
      systemPrompt: 'разделы',
      tools: [],
      allowedTools: [],
      settingSources: [],
      mcpServers: {},
      strictMcpConfig: true,
      persistSession: false,
      maxTurns: 1,
    });
  });

  it('an error result or no text is generation_failed; an agent without the SDK function is not_implemented', async () => {
    const m = manager({ oneShotFn: oneShot([{ type: 'result', subtype: 'error_max_turns', is_error: true }], []) });
    await expect(m.handle(cmd('handoff.generate', { transcript: 't', model: 'sonnet', systemPrompt: 's' }))).rejects.toMatchObject({ code: 'generation_failed' });
    const empty = manager({ oneShotFn: oneShot([{ type: 'result', subtype: 'success', is_error: false, result: '' }], []) });
    await expect(empty.handle(cmd('handoff.generate', { transcript: 't', model: 'sonnet', systemPrompt: 's' }))).rejects.toMatchObject({ code: 'generation_failed' });
    await expect(manager().handle(cmd('handoff.generate', { transcript: 't', model: 'sonnet', systemPrompt: 's' }))).rejects.toMatchObject({ code: 'not_implemented' });
  });

  // claude-subscriptions QA B1: the generation under a limited subscription or a rejected token says why
  const FIXTURES = fileURLToPath(new URL('./fixtures/failure/', import.meta.url));
  const fixture = (prefix: string) =>
    (JSON.parse(readFileSync(`${FIXTURES}${readdirSync(FIXTURES).find(f => f.startsWith(prefix))!}`, 'utf8')) as { messages: Array<Record<string, unknown>> }).messages;

  it('a limit (real VM stream) is generation_failed with failure subscription_limit and the reset time; the limit text is not the answer', async () => {
    const m = manager({ oneShotFn: oneShot(fixture('7-'), []) });
    const err = (await m.handle(cmd('handoff.generate', { transcript: 't', model: 'sonnet', systemPrompt: 's' })).catch((e: unknown) => e)) as CmdError;
    expect(err).toBeInstanceOf(CmdError);
    expect(err.code).toBe('generation_failed');
    expect(err.failure).toMatchObject({ kind: 'subscription_limit' });
    expect(err.failure!.resetsAt).toBeGreaterThan(1e12);
  });

  it('a rejected token is generation_failed with failure auth_rejected', async () => {
    const m = manager({ oneShotFn: oneShot(fixture('4-'), []) });
    await expect(m.handle(cmd('handoff.generate', { transcript: 't', model: 'sonnet', systemPrompt: 's' }))).rejects.toMatchObject({ code: 'generation_failed', failure: { kind: 'auth_rejected' } });
  });

  it('an error without a subscription reason carries no failure', async () => {
    const m = manager({ oneShotFn: oneShot([{ type: 'result', subtype: 'error_max_turns', is_error: true }], []) });
    const err = (await m.handle(cmd('handoff.generate', { transcript: 't', model: 'sonnet', systemPrompt: 's' })).catch((e: unknown) => e)) as CmdError;
    expect(err.failure).toBeUndefined();
  });
});
