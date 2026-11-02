// mcp.machine.probe (mcp-management design M4, UC-7): a service process of Claude without a turn — no model call, no
// quota — in the home directory with the user configuration only; it reads the MCP status of the machine's user servers
// and ends. Built like limits/probe.ts: one at a time, a timeout, close() in finally.
// Requirement: MCP машины.
import { homedir } from 'node:os';
import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { McpProbeResult, McpSnapshot } from '@agent-hub/shared';
import type { Logger } from '../log.js';
import { AsyncQueue } from './asyncQueue.js';
import { CmdError, SUBSCRIPTION_ENV_REMOVED, type QueryFn } from './manager.js';
import { credentialsDirOf, oauthServerNames, readSnapshot, type McpQuery } from './mcp.js';
import { redactText } from './mcpRedact.js';

/** The hub waits 45 s for the answer: initialisation (≈2 s) plus ≤ 30 s of `pending`, the agent gives up earlier. */
export const MCP_PROBE_MAX_MS = 30_000;
/** Initialisation of the service process at most this long (else mcp_probe_timeout). */
export const MCP_PROBE_INIT_MS = 12_000;
export const MCP_PROBE_POLL_MS = 1_000;

export interface McpProberDeps {
  queryFn: QueryFn;
  log: Logger;
  /** Tests: env base and pathToClaudeCodeExecutable. */
  extraOptions?: Partial<Options> | undefined;
  /** The wait for no `pending` server (default 30 s). */
  timeoutMs?: number;
  initTimeoutMs?: number;
  pollMs?: number;
  /** Working directory (default the home directory: only the user configuration applies). */
  cwd?: string;
  now?: () => number;
}

/** The agent's environment without its own secret and without subscription tokens (MCP config does not depend on them). */
export function probeEnv(base: Record<string, string | undefined>): Record<string, string | undefined> {
  const env = { ...base };
  for (const k of SUBSCRIPTION_ENV_REMOVED) delete env[k];
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  return env;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms).unref?.());

export class McpProber {
  private busy = false;

  constructor(private readonly deps: McpProberDeps) {}

  get running(): boolean {
    return this.busy;
  }

  /** One probe at a time on this machine: a second one meanwhile is refused with mcp_probe_busy. */
  async probe(): Promise<McpProbeResult> {
    if (this.busy) throw new CmdError('mcp_probe_busy', 'an MCP check is already running on this machine');
    this.busy = true;
    const now = this.deps.now ?? Date.now;
    const started = now();
    const abort = new AbortController();
    // streaming input without messages: the CLI starts, connects the MCP servers and waits — no turn, no model call
    const input = new AsyncQueue<SDKUserMessage>();
    let q: Query | undefined;
    let initTimer: NodeJS.Timeout | undefined;
    this.deps.log.info('mcp machine probe');
    try {
      q = this.deps.queryFn({
        prompt: input,
        options: {
          ...this.deps.extraOptions,
          cwd: this.deps.cwd ?? homedir(),
          settingSources: ['user'],
          persistSession: false,
          permissionMode: 'default',
          abortController: abort,
          env: probeEnv(this.deps.extraOptions?.env ?? process.env),
        },
      });
      const query = q;
      // messages are drained so the process is never held up by an unread stream
      void (async () => {
        try {
          for await (const m of query) void m;
        } catch {
          // closed or aborted
        }
      })();
      const initTimeout = new Promise<never>((_, reject) => {
        initTimer = setTimeout(() => reject(new CmdError('mcp_probe_timeout', 'the service process did not start in time')), this.deps.initTimeoutMs ?? MCP_PROBE_INIT_MS);
      });
      await Promise.race([query.initializationResult(), initTimeout]);
      clearTimeout(initTimer);
      const deadline = started + (this.deps.timeoutMs ?? MCP_PROBE_MAX_MS);
      let snap: McpSnapshot | null = null;
      for (;;) {
        snap = await readSnapshot(query as unknown as McpQuery, now(), this.deps.log, undefined, () => oauthServerNames(credentialsDirOf(this.deps.extraOptions?.env ?? process.env)));
        if (!snap) throw new CmdError('mcp_probe_timeout', 'the MCP status of the service process could not be read');
        if (!snap.servers.some(s => s.status === 'pending') || now() >= deadline) break;
        await sleep(this.deps.pollMs ?? MCP_PROBE_POLL_MS);
      }
      // only the user configuration counts for the machine (dynamic/managed/plugin rows stay in the snapshot)
      const durationMs = Math.max(0, now() - started);
      this.deps.log.info('mcp machine probe done', { servers: snap.servers.length, pending: snap.servers.filter(s => s.status === 'pending').length, durationMs });
      return { snapshot: snap, durationMs };
    } catch (err) {
      if (err instanceof CmdError) {
        this.deps.log.warn('mcp machine probe failed', { code: err.code, error: err.message });
        throw err;
      }
      // the CLI's text may carry a URL with a token or a header: redacted before the log and the hub
      const message = redactText(err instanceof Error ? err.message : String(err), 500);
      this.deps.log.warn('mcp machine probe failed', { error: message });
      throw new CmdError('mcp_probe_timeout', message);
    } finally {
      clearTimeout(initTimer);
      input.close();
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
