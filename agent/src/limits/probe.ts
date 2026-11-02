// limits.probe (subscription-limits design L2, task 4.2): one minimal turn of the cheapest model under a subscription
// token, to read the rate_limit_event of the service. Built like handoff.generate: no tools, no MCP, no settings of the
// machine, no transcript (persistSession: false), a scratch directory, a timeout with abort() in finally. The model's
// answer is never read or returned; the token lives in the command payload and the child's env only.
// Requirements: Пробный ход; Выбор машины для пробного хода и защита токена.
import { tmpdir } from 'node:os';
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { HubMessage, LimitsProbeResult, LimitsSnapshot, PayloadOf } from '@agent-hub/shared';
import type { Logger } from '../log.js';
import { classifyFailure, collectSignal, ERROR_RESULT_THROW, resetsAtMs, type ResultLike, type TurnSignals } from '../sessions/failure.js';
import { CmdError, subscriptionEnv, type OneShotFn } from '../sessions/manager.js';
import { rateLimitInfo, snapshotFromInfo, toIso } from './parse.js';

export const PROBE_PROMPT = 'ping';
export const PROBE_SYSTEM_PROMPT = 'Reply with the single word: ok.';
/** The hub waits LIMITS_PROBE_TIMEOUT_SEC (60 s) for the answer: the agent gives up a little earlier. */
export const PROBE_MAX_MS = 55_000;

export interface LimitsProberDeps {
  oneShotFn?: OneShotFn | undefined;
  log: Logger;
  /** Tests: env base and pathToClaudeCodeExecutable (as SessionManagerDeps.extraOptions). */
  extraOptions?: Partial<Options> | undefined;
  scratchDir?: string | undefined;
  timeoutMs?: number | undefined;
  now?: () => number;
}

/** The token never reaches a message: every occurrence replaced (the CLI's error text could quote the env). */
function scrub(text: string | undefined, token: string): string | null {
  if (!text) return null;
  return text.split(token).join('[redacted]').slice(0, 500);
}

export class LimitsProber {
  private busy = false;

  constructor(private readonly deps: LimitsProberDeps) {}

  /** One probe turn at a time on this machine: a second one meanwhile is refused with probe_busy. */
  async probe(p: PayloadOf<HubMessage, 'limits.probe'>): Promise<LimitsProbeResult> {
    const oneShot = this.deps.oneShotFn;
    if (!oneShot) throw new CmdError('not_implemented', 'limits.probe is not supported by this agent');
    if (this.busy) throw new CmdError('probe_busy', 'a probe turn is already running on this machine');
    this.busy = true;
    const now = this.deps.now ?? Date.now;
    const started = now();
    const token = p.subscription.token;
    const abort = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let q: Query | undefined;
    // the subscription id only, never the token (task 4.5)
    this.deps.log.info('limits probe', { subscriptionId: p.subscription.id, model: p.model });
    try {
      q = oneShot({
        prompt: PROBE_PROMPT,
        options: {
          ...this.deps.extraOptions,
          cwd: this.deps.scratchDir ?? tmpdir(),
          model: p.model,
          systemPrompt: PROBE_SYSTEM_PROMPT,
          tools: [],
          allowedTools: [],
          settingSources: [],
          mcpServers: {},
          strictMcpConfig: true,
          persistSession: false,
          maxTurns: 1,
          permissionMode: 'default',
          abortController: abort,
          env: subscriptionEnv(this.deps.extraOptions?.env ?? process.env, token),
        },
      });
      const signals: TurnSignals = {};
      let snapshot: LimitsSnapshot | null = null;
      let info: Record<string, unknown> | null = null;
      let result: (SDKMessage & { type: 'result' }) | null = null;
      const consume = async () => {
        try {
          for await (const m of q!) {
            collectSignal(signals, m);
            const i = rateLimitInfo(m);
            if (i) {
              // the last event of the turn
              info = i;
              snapshot = snapshotFromInfo(i);
            } else if (m.type === 'result') result = m;
          }
        } catch (err) {
          // QA 10.2: after an error result (a limit, a rejected token) the CLI exits non-zero and the SDK throws
          // «Claude Code returned an error result: …» once the result is yielded. The turn has ended: classify it.
          // Anything else, or that error with no result received, stays a failure (probe_failed / probe_timeout).
          const message = err instanceof Error ? err.message : String(err);
          if (!(result && !abort.signal.aborted && ERROR_RESULT_THROW.test(message))) throw err;
        }
      };
      // the race guarantees the timeout even if the process ignores abort()
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new CmdError('probe_timeout', 'the probe turn took too long'));
        }, this.deps.timeoutMs ?? PROBE_MAX_MS);
      });
      const consuming = consume();
      consuming.catch(() => undefined); // after a timeout the aborted loop may still reject: not an unhandled rejection
      await Promise.race([consuming, timeout]);
      const durationMs = Math.max(0, now() - started);
      const r = result as (SDKMessage & { type: 'result' }) | null;
      if (!r) throw new CmdError('probe_failed', 'the probe turn ended without a result');
      const failure = classifyFailure(signals, r as ResultLike);
      const snap = snapshot as LimitsSnapshot | null;
      const top = info as Record<string, unknown> | null;
      const base = { snapshot: snap, resetsAt: null, limitType: null, message: null, durationMs };
      let out: LimitsProbeResult;
      if (failure?.kind === 'subscription_limit') {
        // review B1: without a reset in the failure, the event's top-level resetsAt and rateLimitType (a limit with no
        // windows still tells when it ends)
        const ms = resetsAtMs(failure.resetsAt);
        const resetsAt = ms !== undefined ? new Date(ms).toISOString() : top ? toIso(top.resetsAt) : null;
        const limitType = failure.limitType ?? (typeof top?.rateLimitType === 'string' && top.rateLimitType ? top.rateLimitType.slice(0, 64) : null);
        out = { ...base, outcome: 'limit', resetsAt, limitType, message: scrub(failure.message, token) };
      } else if (failure) {
        out = { ...base, outcome: failure.kind, message: scrub(failure.message, token) };
      } else if (r.is_error || r.subtype !== 'success') {
        // not the subscription's fault (a model that does not resolve, an API error): the hub records probe_failed
        const text = r.subtype === 'success' ? (typeof r.result === 'string' ? r.result : '') : ((r as { errors?: string[] }).errors ?? []).join('\n') || r.subtype;
        throw new CmdError('probe_failed', scrub(text, token) ?? 'the probe turn failed');
      } else {
        // review B1: an event without windows is no data about windows — `no_event` (the hub records a quiet check)
        out = { ...base, outcome: snap && snap.windows.length ? 'ok' : 'no_event' };
      }
      this.deps.log.info('limits probe done', { subscriptionId: p.subscription.id, outcome: out.outcome, windows: out.snapshot?.windows.length ?? 0, durationMs });
      return out;
    } catch (err) {
      if (err instanceof CmdError) {
        this.deps.log.warn('limits probe failed', { subscriptionId: p.subscription.id, code: err.code, error: scrub(err.message, token) });
        throw new CmdError(err.code, scrub(err.message, token) ?? err.code);
      }
      const message = scrub(err instanceof Error ? err.message : String(err), token) ?? 'error';
      const code = abort.signal.aborted ? 'probe_timeout' : 'probe_failed';
      this.deps.log.warn('limits probe failed', { subscriptionId: p.subscription.id, code, error: message });
      throw new CmdError(code, message);
    } finally {
      clearTimeout(timer);
      abort.abort();
      try {
        q?.close();
      } catch {
        // already closed
      }
      this.busy = false;
    }
  }
}
