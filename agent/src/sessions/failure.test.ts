// Task 3.2: classification of a failed turn on the six SDK sequences of design P5, as the session manager sees them.
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import * as sdk from '@anthropic-ai/claude-agent-sdk';
import type { HubMessage, PayloadOf } from '@agent-hub/shared';
import { sessionResultPayload } from '@agent-hub/shared';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../log.js';
import { AsyncQueue } from './asyncQueue.js';
import { LIMIT_PREFIXES, classifyFailure, collectSignal, resetsAtMs, turnUsage, type TurnSignals } from './failure.js';
import { SessionManager } from './manager.js';

interface Fixture {
  description: string;
  messages: Array<Record<string, unknown>>;
  expect: { kind: string; resetsAt?: number; limitType?: string } | null;
  usage?: Record<string, number>;
  errorText?: string;
}

const DIR = fileURLToPath(new URL('./fixtures/failure/', import.meta.url));
const fixture = (prefix: string): Fixture => {
  const f = readdirSync(DIR).find(n => n.startsWith(prefix))!;
  return JSON.parse(readFileSync(`${DIR}${f}`, 'utf8')) as Fixture;
};

/** Every message through the manager of a session started with a scripted SDK: the session.result it sends. */
async function replay(messages: Array<Record<string, unknown>>): Promise<Array<{ type: string; payload: Record<string, unknown> }>> {
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const out = new AsyncQueue<SDKMessage>();
  const mgr = new SessionManager({
    send: (type, payload) => void sent.push({ type, payload: payload as Record<string, unknown> }),
    log: createLogger({ level: 'error', write: () => undefined }),
    queryFn: ({ prompt }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
      void (async () => {
        for await (const _ of prompt) void _;
      })();
      const it = out[Symbol.asyncIterator]();
      const q = {
        next: () => it.next(),
        return: () => Promise.resolve({ value: undefined, done: true }),
        [Symbol.asyncIterator]: () => q,
        initializationResult: () => Promise.resolve({}),
        supportedModels: () => Promise.resolve([]),
        close: () => out.close(),
      };
      return q as unknown as Query;
    },
    stopGraceMs: 100,
  });
  const sessionId = randomUUID();
  const cwd = process.platform === 'win32' ? 'C:\\w' : '/w';
  await mgr.handle({
    v: 1,
    ts: Date.now(),
    id: randomUUID(),
    type: 'session.start',
    payload: { sessionId, cwd, permissionMode: 'default', model: 'haiku', prompt: 'hi', promptUuid: randomUUID() } satisfies PayloadOf<HubMessage, 'session.start'>,
  } as HubMessage);
  for (const m of messages) out.push({ ...m, session_id: sessionId } as unknown as SDKMessage);
  await new Promise(r => setTimeout(r, 30));
  out.close();
  await new Promise(r => setTimeout(r, 30));
  return sent;
}

const resultOf = (sent: Array<{ type: string; payload: Record<string, unknown> }>) => sent.find(m => m.type === 'session.result')!.payload;

describe('failure classification on the fixtures (design P5)', () => {
  it('(1) limit with rate_limit_event → subscription_limit, resetsAt converted from seconds to ms', async () => {
    const r = resultOf(await replay(fixture('1-').messages));
    expect(r.failure).toEqual({ kind: 'subscription_limit', resetsAt: 1793264400000, limitType: 'five_hour', message: "You've hit your session limit · resets 3:40am (Europe/Moscow)" });
    expect(r.isError).toBe(true);
    // success + is_error: the text of the error is result.result, no longer lost
    expect(r.errorText).toBe("You've hit your session limit · resets 3:40am (Europe/Moscow)");
    expect(sessionResultPayload.safeParse(r).success).toBe(true);
  });

  it('(2) limit by the text only → subscription_limit without resetsAt (the text «resets 3:40am» is not parsed)', async () => {
    const r = resultOf(await replay(fixture('2-').messages));
    expect(r.failure).toMatchObject({ kind: 'subscription_limit' });
    expect((r.failure as Record<string, unknown>).resetsAt).toBeUndefined();
  });

  it('(3) temporary 429 retried by the CLI → no failure, usage of the turn', async () => {
    const f = fixture('3-');
    const r = resultOf(await replay(f.messages));
    expect(r.failure).toBeUndefined();
    expect(r.isError).toBe(false);
    expect(r.errorText).toBeUndefined();
    expect(r.usage).toEqual(f.usage);
  });

  it('(4) rejected token (the real sequence of task 1.1) → auth_rejected; api_retry 401 is not a failure by itself', async () => {
    const f = fixture('4-');
    expect((await replay(f.messages.slice(0, 3).concat([{ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: {} }])).then(resultOf)).failure).toBeUndefined();
    const r = resultOf(await replay(f.messages));
    expect(r.failure).toMatchObject({ kind: 'auth_rejected', message: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.' });
  });

  it('(5) billing_error → account_unavailable', async () => {
    expect(resultOf(await replay(fixture('5-').messages)).failure).toMatchObject({ kind: 'account_unavailable' });
  });

  it('(6) error_during_execution → no failure, errorText from errors[]; a subagent rate_limit does not count', async () => {
    const f = fixture('6-');
    const r = resultOf(await replay(f.messages));
    expect(r.failure).toBeUndefined();
    expect(r.errorText).toBe(f.errorText);
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 });
  });

  // QA 9.4: the stream captured on the VM under an exhausted subscription (unifiedWindows, terminal_reason api_error)
  it('(7) real limit stream of SDK 0.3.310 → subscription_limit with the reset time of the five-hour window', async () => {
    const f = fixture('7-');
    const r = resultOf(await replay(f.messages));
    expect(r.failure).toEqual({ ...f.expect, message: "You've hit your session limit · resets 11am (UTC)" });
    expect(r.isError).toBe(true);
    expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
    expect(sessionResultPayload.safeParse(r).success).toBe(true);
  });

  it('signals of one turn do not leak into the next one', async () => {
    const lim = fixture('1-').messages.slice(1);
    const ok = fixture('3-').messages.slice(-2);
    const sent = await replay([...lim, ...ok]);
    const results = sent.filter(m => m.type === 'session.result').map(m => m.payload);
    expect(results.map(r => (r.failure as { kind?: string } | undefined)?.kind ?? null)).toEqual(['subscription_limit', null]);
  });

  it('every fixture matches its expectation through the pure functions too', () => {
    for (const name of readdirSync(DIR)) {
      const f = JSON.parse(readFileSync(`${DIR}${name}`, 'utf8')) as Fixture;
      const signals: TurnSignals = {};
      let failure: ReturnType<typeof classifyFailure> | 'none' = 'none';
      for (const m of f.messages) {
        collectSignal(signals, m as unknown as SDKMessage);
        if (m.type === 'result') failure = classifyFailure(signals, m);
      }
      if (f.expect === null) expect(failure, name).toBeUndefined();
      else expect(failure, name).toMatchObject(f.expect);
    }
  });

  it('terminal_reason blocking_limit with a rejected event → subscription_limit', () => {
    expect(classifyFailure({ rateLimitRejected: { resetsAt: 1_793_264_400_123 } }, { is_error: true, terminal_reason: 'blocking_limit', result: 'blocked' })).toEqual({
      kind: 'subscription_limit',
      resetsAt: 1_793_264_400_123,
      message: 'blocked',
    });
    expect(classifyFailure({}, { is_error: true, terminal_reason: 'blocking_limit', result: 'blocked' })).toBeUndefined();
  });

  it('resetsAt: seconds → ms, ms kept, junk dropped', () => {
    expect(resetsAtMs(1793264400)).toBe(1793264400000);
    expect(resetsAtMs(1793264400000)).toBe(1793264400000);
    expect(resetsAtMs(0)).toBeUndefined();
    expect(resetsAtMs(Number.NaN)).toBeUndefined();
  });

  it('usage: missing fields are 0', () => {
    expect(turnUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
  });

  it('the SDK still exports USAGE_LIMIT_ERROR_PREFIXES (else the local copy is used — update it)', () => {
    const exported = (sdk as { USAGE_LIMIT_ERROR_PREFIXES?: readonly string[] }).USAGE_LIMIT_ERROR_PREFIXES;
    expect(Array.isArray(exported)).toBe(true);
    expect(exported).toContain("You've hit your");
    expect(LIMIT_PREFIXES).toBe(exported);
  });
});
