// Tasks 4.2 and 4.5: limits.probe against a scripted one-shot SDK query (design L2). The real CLI path: probe.sdk.test.ts.
import { readFileSync } from 'node:fs';
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { limitsProbeResultSchema, type HubMessage } from '@agent-hub/shared';
import { createLogger } from '../log.js';
import { CmdError, SessionManager, type OneShotFn } from '../sessions/manager.js';
import { LimitsProber } from './probe.js';

const TOKEN = 'sk-ant-oat01-' + 'Zq7_-'.repeat(16) + 'PROBETOKEN';
const SUB = { id: '3a7c1e2d-5b4f-4a6e-9c8d-7e6f5a4b3c2d', token: TOKEN };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as Record<string, unknown>;
const REJECTED = fixture('1-setup-token-rejected.json');
const ALLOWED = fixture('2-interactive-allowed-warning.json');

const success = { type: 'result', subtype: 'success', is_error: false, result: 'ok', duration_ms: 900, total_cost_usd: 0, usage: {} };
const answer = { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'ok' }] } };
// 429 usage_limit_reached as seen in the spike (design «Итоги спайка» p. 5)
const limitAssistant = { type: 'assistant', error: 'rate_limit', parent_tool_use_id: null, message: { content: [{ type: 'text', text: "You've hit your weekly limit · resets Oct 29, 6pm" }] } };
const limitResult = {
  type: 'result',
  subtype: 'success',
  is_error: true,
  result: "You've hit your weekly limit · resets Oct 29, 6pm",
  api_error_status: 429,
  duration_ms: 300,
  total_cost_usd: 0,
  usage: {},
};
const authAssistant = { type: 'assistant', error: 'authentication_failed', parent_tool_use_id: null, message: { content: [{ type: 'text', text: `Invalid API key · token ${TOKEN} rejected` }] } };
const authResult = { type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key', api_error_status: 401, duration_ms: 100, total_cost_usd: 0, usage: {} };

interface Run {
  options: Options;
  prompt: string;
  closed: boolean;
}

/** What SDK 0.3.310 throws after it has yielded an error result (Query.readMessages replaces the CLI's exit error). */
const sdkThrow = (text: string) => ({ __throw: `Claude Code returned an error result: ${text}` });

/** A one-shot query that yields `script` (or hangs until aborted when `hang`). */
function fakeOneShot(script: Array<Record<string, unknown>> | 'hang' | 'ignore-abort', runs: Run[]): OneShotFn {
  return ({ prompt, options }) => {
    const run: Run = { options, prompt, closed: false };
    runs.push(run);
    async function* gen(): AsyncGenerator<SDKMessage> {
      if (script === 'hang' || script === 'ignore-abort') {
        await new Promise<void>((_, reject) => {
          if (script === 'hang') options.abortController!.signal.addEventListener('abort', () => reject(new Error('Claude Code process aborted by user')));
        });
        return;
      }
      for (const m of script) {
        // { __throw } — the iterator throws there, as the real SDK does after an error result (QA 10.2)
        if (typeof m.__throw === 'string') throw new Error(m.__throw);
        yield m as unknown as SDKMessage;
      }
    }
    const g = gen();
    return Object.assign(g, { close: () => void (run.closed = true) }) as unknown as Query;
  };
}

function prober(script: Parameters<typeof fakeOneShot>[0], o: { timeoutMs?: number; env?: Record<string, string> } = {}) {
  const runs: Run[] = [];
  const lines: string[] = [];
  const p = new LimitsProber({
    oneShotFn: fakeOneShot(script, runs),
    log: createLogger({ level: 'debug', write: l => lines.push(l) }),
    extraOptions: { env: o.env ?? { PATH: '/bin', AGENT_TOKEN: 'agent-secret-token-1234', ANTHROPIC_API_KEY: 'sk-api' } },
    scratchDir: '/scratch',
    ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
  });
  return { p, runs, lines };
}

const payload = { subscription: SUB, model: 'haiku' };

describe('limits.probe', () => {
  it('event + success → ok with the snapshot; the options: no tools, MCP, settings, transcript; one turn of haiku; the env of the subscription', async () => {
    const { p, runs } = prober([ALLOWED, answer, success]);
    const r = await p.probe(payload);
    expect(limitsProbeResultSchema.parse(r)).toEqual(r);
    expect(r).toMatchObject({ outcome: 'ok', resetsAt: null, limitType: null, message: null });
    expect(r.snapshot!.windows.map(w => [w.type, w.utilization])).toEqual([
      ['five_hour', 11],
      ['seven_day', 34],
    ]);
    const o = runs[0]!.options;
    expect(runs[0]!.prompt).toBe('ping');
    expect(o).toMatchObject({
      cwd: '/scratch',
      model: 'haiku',
      tools: [],
      allowedTools: [],
      settingSources: [],
      mcpServers: {},
      strictMcpConfig: true,
      persistSession: false,
      maxTurns: 1,
      permissionMode: 'default',
    });
    expect(o.systemPrompt).toBe('Reply with the single word: ok.');
    expect(o.env).toEqual({ PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
    expect(o.abortController!.signal.aborted).toBe(true); // abort() in finally
    expect(runs[0]!.closed).toBe(true);
    // the model's answer is not in the result
    expect(Object.keys(r).sort()).toEqual(['durationMs', 'limitType', 'message', 'outcome', 'resetsAt', 'snapshot']);
  });

  it('success without an event → no_event, no snapshot', async () => {
    const { p } = prober([answer, success]);
    expect(await p.probe(payload)).toMatchObject({ outcome: 'no_event', snapshot: null });
  });

  it('review B1: an event without windows (no unifiedWindows, no rateLimitType) + success → no_event, the snapshot without windows', async () => {
    const { p } = prober([{ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', overageStatus: 'rejected' } }, answer, success]);
    const r = await p.probe(payload);
    expect(r.outcome).toBe('no_event');
    expect(r.snapshot!.windows).toEqual([]);
  });

  it('review B1: a limit whose event has no windows still carries the top-level resetsAt', async () => {
    const { p } = prober([{ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1793264400 } }, limitAssistant, limitResult]);
    const r = await p.probe(payload);
    expect(r).toMatchObject({ outcome: 'limit', resetsAt: new Date(1793264400_000).toISOString() });
    expect(r.snapshot!.windows).toEqual([]);
  });

  it('429 usage_limit_reached with a rejected event → limit with the snapshot, the reset and the window type', async () => {
    const { p } = prober([REJECTED, limitAssistant, limitResult]);
    const r = await p.probe(payload);
    expect(r).toMatchObject({ outcome: 'limit', resetsAt: new Date(1793264400_000).toISOString(), limitType: 'seven_day' });
    expect(r.message).toContain('weekly limit');
    expect(r.snapshot!.windows.find(w => w.type === 'seven_day')).toMatchObject({ utilization: 100, status: 'rejected' });
  });

  it('401 → auth_rejected; the token in the error text is masked', async () => {
    const { p, lines } = prober([authAssistant, authResult]);
    const r = await p.probe(payload);
    expect(r.outcome).toBe('auth_rejected');
    expect(r.message).toContain('[redacted]');
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(lines.join('\n')).not.toContain(TOKEN);
  });

  it('QA 10.2: the SDK throws «error result» after a limit result → still limit with the windows and the reset', async () => {
    const { p } = prober([REJECTED, limitAssistant, limitResult, sdkThrow("You've hit your weekly limit · resets Oct 29, 12pm (Europe/Moscow)")]);
    const r = await p.probe(payload);
    expect(limitsProbeResultSchema.parse(r)).toEqual(r);
    expect(r).toMatchObject({ outcome: 'limit', resetsAt: new Date(1793264400_000).toISOString(), limitType: 'seven_day' });
    expect(r.snapshot!.windows.map(w => [w.type, w.utilization, w.status])).toEqual([
      ['five_hour', 92, 'allowed_warning'],
      ['seven_day', 100, 'rejected'],
    ]);
  });

  it('QA 10.2: the SDK throws «error result» after a 401 result → still auth_rejected, the token masked', async () => {
    const { p, lines } = prober([authAssistant, authResult, sdkThrow(`Invalid API key · token ${TOKEN}`)]);
    const r = await p.probe(payload);
    expect(r.outcome).toBe('auth_rejected');
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(lines.join('\n')).not.toContain(TOKEN);
  });

  it('QA 10.2: another throw, or the «error result» throw with no result received → probe_failed', async () => {
    const { p } = prober([REJECTED, limitAssistant, limitResult, { __throw: `Claude Code process exited with code 1 ${TOKEN}` }]);
    const e = await p.probe(payload).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'probe_failed' });
    expect((e as Error).message).not.toContain(TOKEN);
    const { p: p2 } = prober([REJECTED, limitAssistant, sdkThrow("You've hit your weekly limit")]);
    await expect(p2.probe(payload)).rejects.toMatchObject({ code: 'probe_failed' });
  });

  it('billing → account_unavailable', async () => {
    const { p } = prober([
      { ...authAssistant, error: 'billing_error', message: { content: [{ type: 'text', text: 'Credit balance too low' }] } },
      { ...authResult, api_error_status: 400 },
    ]);
    expect(await p.probe(payload)).toMatchObject({ outcome: 'account_unavailable', message: 'Credit balance too low' });
  });

  it('an error not of the subscription (a model that does not resolve) → cmd.error probe_failed', async () => {
    const { p } = prober([{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['model haiku-x not found'], duration_ms: 1, total_cost_usd: 0, usage: {} }]);
    await expect(p.probe(payload)).rejects.toMatchObject({ code: 'probe_failed', message: 'model haiku-x not found' });
    const { p: p2 } = prober([answer]);
    await expect(p2.probe(payload)).rejects.toMatchObject({ code: 'probe_failed' });
  });

  it('a hanging process → probe_timeout and abort(); also when the process ignores abort', async () => {
    for (const script of ['hang', 'ignore-abort'] as const) {
      const { p, runs } = prober(script, { timeoutMs: 50 });
      const err = await p.probe(payload).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CmdError);
      expect(err).toMatchObject({ code: 'probe_timeout' });
      expect(runs[0]!.options.abortController!.signal.aborted).toBe(true);
      expect(runs[0]!.closed).toBe(true);
    }
  });

  it('a second probe while one runs → probe_busy; after it ends the next one runs', async () => {
    const { p } = prober('hang', { timeoutMs: 100 });
    const first = p.probe(payload).catch((e: unknown) => e);
    await expect(p.probe(payload)).rejects.toMatchObject({ code: 'probe_busy' });
    expect(await first).toMatchObject({ code: 'probe_timeout' });
    await expect(p.probe(payload)).rejects.toMatchObject({ code: 'probe_timeout' }); // not busy any more
  });

  it('4.5 the token is not in the logs (debug level), the result, nor the env beside CLAUDE_CODE_OAUTH_TOKEN; AGENT_TOKEN removed', async () => {
    for (const script of [[ALLOWED, success], [authAssistant, authResult], 'hang'] as const) {
      const { p, lines, runs } = prober(script as Parameters<typeof fakeOneShot>[0], { timeoutMs: 30 });
      const r = await p.probe(payload).catch((e: unknown) => ({ code: (e as CmdError).code, message: (e as CmdError).message }));
      expect(JSON.stringify(r)).not.toContain(TOKEN);
      expect(lines.join('\n')).not.toContain(TOKEN);
      expect(lines.join('\n')).toContain(SUB.id);
      const env = runs[0]!.options.env!;
      expect(env.AGENT_TOKEN).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(
        Object.entries(env)
          .filter(([, v]) => v === TOKEN)
          .map(([k]) => k),
      ).toEqual(['CLAUDE_CODE_OAUTH_TOKEN']);
    }
  });

  it('SessionManager.handle routes limits.probe to the prober; without oneShotFn → not_implemented', async () => {
    const runs: Run[] = [];
    const lines: string[] = [];
    const mgr = new SessionManager({
      send: () => undefined,
      log: createLogger({ level: 'debug', write: l => lines.push(l) }),
      queryFn: () => {
        throw new Error('no');
      },
      oneShotFn: fakeOneShot([ALLOWED, success], runs),
    });
    const m = { v: 1, ts: 1, id: 'c1', type: 'limits.probe', payload } as HubMessage;
    expect(await mgr.handle(m)).toMatchObject({ outcome: 'ok' });
    expect(lines.join('\n')).not.toContain(TOKEN);
    const bare = new SessionManager({
      send: () => undefined,
      log: createLogger({ level: 'error', write: () => undefined }),
      queryFn: () => {
        throw new Error('no');
      },
    });
    await expect(bare.handle(m)).rejects.toMatchObject({ code: 'not_implemented' });
  });
});
