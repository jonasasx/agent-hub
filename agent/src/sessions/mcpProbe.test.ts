// mcp.machine.probe against a scripted SDK (mcp-management task 2.5). Requirement: MCP машины.
import { homedir } from 'node:os';
import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../log.js';
import { CmdError, type QueryFn } from './manager.js';
import { McpProber, probeEnv } from './mcpProbe.js';

const log = createLogger({ level: 'error', write: () => undefined });

function fake(o: { statuses: string[][]; init?: Promise<unknown> }) {
  const calls: { options?: Options; prompt?: AsyncIterable<SDKUserMessage>; closed: boolean; reads: number; inputs: number } = { closed: false, reads: 0, inputs: 0 };
  const queryFn: QueryFn = ({ prompt, options }) => {
    calls.options = options;
    calls.prompt = prompt;
    void (async () => {
      for await (const m of prompt) if (m) calls.inputs++;
    })();
    let done = false;
    const q = {
      next: () => new Promise(r => (done ? r({ value: undefined, done: true }) : setTimeout(() => r({ value: undefined, done: true }), 5))),
      return: () => Promise.resolve({ value: undefined, done: true }),
      [Symbol.asyncIterator]: () => q,
      initializationResult: () => o.init ?? Promise.resolve({}),
      mcpServerStatus: async () => {
        const i = Math.min(calls.reads++, o.statuses.length - 1);
        return o.statuses[i]!.map((status, n) => ({ name: `s${n}`, status, config: { command: 'node', args: ['x.js'] }, scope: 'user' }));
      },
      close: () => {
        done = true;
        calls.closed = true;
      },
    };
    return q as unknown as Query;
  };
  return { queryFn, calls };
}

describe('McpProber', () => {
  it('a service process in the home directory with the user config only, no transcript, no subscription env; waits out pending; closes', async () => {
    const f = fake({
      statuses: [
        ['pending', 'connected'],
        ['pending', 'connected'],
        ['needs-auth', 'connected'],
      ],
    });
    const p = new McpProber({ queryFn: f.queryFn, log, pollMs: 5, extraOptions: { env: { PATH: '/bin', AGENT_TOKEN: 'agt', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-x', ANTHROPIC_API_KEY: 'k' } } });
    const r = await p.probe();
    expect(f.calls.options).toMatchObject({ cwd: homedir(), settingSources: ['user'], persistSession: false, env: { PATH: '/bin' } });
    expect(f.calls.options!.env).toEqual({ PATH: '/bin' });
    expect(f.calls.options!.mcpServers).toBeUndefined();
    expect(r.snapshot.servers.map(s => s.status)).toEqual(['needs-auth', 'connected']);
    expect(f.calls.reads).toBe(3);
    expect(f.calls.inputs).toBe(0); // no turn
    expect(f.calls.closed).toBe(true);
    expect(p.running).toBe(false);
  });

  it('pending beyond the wait: the snapshot as it is, not longer than the timeout', async () => {
    const f = fake({ statuses: [['pending']] });
    const p = new McpProber({ queryFn: f.queryFn, log, pollMs: 5, timeoutMs: 60 });
    const t0 = Date.now();
    const r = await p.probe();
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(r.snapshot.servers[0]!.status).toBe('pending');
    expect(f.calls.closed).toBe(true);
  });

  it('a process that does not initialise → mcp_probe_timeout, closed', async () => {
    const f = fake({ statuses: [[]], init: new Promise(() => undefined) });
    const p = new McpProber({ queryFn: f.queryFn, log, initTimeoutMs: 30 });
    await expect(p.probe()).rejects.toMatchObject({ code: 'mcp_probe_timeout' });
    expect(f.calls.closed).toBe(true);
    expect(p.running).toBe(false);
  });

  it('an SDK error: its text is redacted before it reaches the hub (URL query, Bearer)', async () => {
    const f = fake({ statuses: [[]], init: Promise.reject(new Error('connect https://mcp.example.com/sse?api_key=abc123 failed: Authorization: Bearer sk-live-0123456789abcdefghij')) });
    const p = new McpProber({ queryFn: f.queryFn, log });
    const err = (await p.probe().catch((e: unknown) => e)) as CmdError;
    expect(err.code).toBe('mcp_probe_timeout');
    expect(err.message).toContain('https://mcp.example.com/sse');
    expect(err.message).not.toContain('abc123');
    expect(err.message).not.toContain('sk-live');
  });

  it('one at a time: a second probe meanwhile → mcp_probe_busy', async () => {
    let release!: () => void;
    const f = fake({ statuses: [['connected']], init: new Promise<void>(r => (release = r)) });
    const p = new McpProber({ queryFn: f.queryFn, log });
    const first = p.probe();
    const err = await p.probe().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CmdError);
    expect((err as CmdError).code).toBe('mcp_probe_busy');
    release();
    await first;
    expect(p.running).toBe(false);
  });

  it('probeEnv drops the agent token and subscription tokens', () => {
    expect(probeEnv({ A: '1', AGENT_TOKEN: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'y', ANTHROPIC_AUTH_TOKEN: 'z' })).toEqual({ A: '1' });
  });
});
