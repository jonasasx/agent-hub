// MCP servers of a live session process (mcp-management design M1, M3).
// Requirements: Статус MCP сессии; Секреты в снимке MCP; Совместимость управления MCP с агентом; OAuth-сервер в панели
// MCP (mcp-auth-controls A1).
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { MCP_PROTOCOL, PEERS_SERVER_NAME, protocolAtLeast, type McpSnapshot } from '@agent-hub/shared';
import type { Logger } from '../log.js';
import { redactServer, redactUrl, type SdkMcpStatus } from './mcpRedact.js';

/** The MCP methods of the SDK's Query the agent uses (declared in sdk.d.ts). */
export interface McpQuery {
  mcpServerStatus(): Promise<unknown[]>;
  reconnectMcpServer(serverName: string): Promise<void>;
  toggleMcpServer(serverName: string, enabled: boolean): Promise<void>;
}

/**
 * M1: sign-in methods present in the SDK's runtime (sdk.mjs, class Query) but not declared in sdk.d.ts (0.3.310). The
 * agent checks that they exist before calling them; the CLI answers `mcp_authenticate` with
 * {authUrl, requiresUserAction, callbackExpected, redirectScheme: 'custom' | 'localhost', state, callbackPort?}.
 */
export interface McpAuthApi {
  mcpAuthenticate?: (serverName: string, redirectUri?: string) => Promise<unknown>;
  mcpSubmitOAuthCallbackUrl?: (serverName: string, callbackUrl: string) => Promise<unknown>;
  /** mcp-auth-controls A3: `mcp_clear_auth` — revoke at the provider and delete the machine's saved sign-in. */
  mcpClearAuth?: (serverName: string) => Promise<unknown>;
}

/**
 * The Claude config directory of the session processes (the store of `.credentials.json`): `CLAUDE_CONFIG_DIR` of their
 * environment, else `~/.claude` — subscriptions do not change it (mcp-management SA-1 p. 4).
 */
export function credentialsDirOf(env: Record<string, string | undefined> = process.env): string {
  return env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude');
}

const namesCache = new Map<string, { mtimeMs: number; size: number; names: Set<string> }>();

/** The key of a saved sign-in: the server's name and its address (origin + path, as `target`); `*` — no address saved. */
export const signInKey = (name: string, target: string | undefined) => `${name}\n${target ?? '*'}`;

/**
 * mcp-auth-controls A1: the servers with a saved OAuth sign-in on the machine — entries of `mcpOAuth` in
 * `<dir>/.credentials.json` with a non-empty access or refresh token, as signInKey(name, redacted serverUrl). Only names
 * and addresses leave this function: no token or client value is kept, returned or logged. Cached by mtime and size; no
 * file or a broken one → an empty set. macOS keeps the tokens in the Keychain, not in this file: there the set is empty.
 */
export function oauthServerNames(dir: string): Set<string> {
  const file = path.join(dir, '.credentials.json');
  let st;
  try {
    st = statSync(file);
  } catch {
    namesCache.delete(file);
    return new Set();
  }
  const hit = namesCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.names;
  const names = new Set<string>();
  try {
    const store = (JSON.parse(readFileSync(file, 'utf8')) as { mcpOAuth?: unknown }).mcpOAuth;
    if (store && typeof store === 'object') {
      for (const [key, v] of Object.entries(store as Record<string, unknown>)) {
        const cut = key.lastIndexOf('|');
        const name = cut > 0 ? key.slice(0, cut) : key;
        const e = v as { accessToken?: unknown; refreshToken?: unknown; serverUrl?: unknown } | null;
        const has = (t: unknown) => typeof t === 'string' && t.length > 0;
        if (!name || !e || typeof e !== 'object' || !(has(e.accessToken) || has(e.refreshToken))) continue;
        names.add(signInKey(name, typeof e.serverUrl === 'string' ? redactUrl(e.serverUrl) : undefined));
      }
    }
  } catch {
    // being written by the CLI or not JSON: no saved sign-ins known this time (not cached)
    return names;
  }
  namesCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, names });
  return names;
}

/**
 * A1 (review fix): http/sse with a saved sign-in (a non-empty token) for this name and this address — what «Войти
 * заново» and «Выйти» act on. A server with the same name and another address has another sign-in.
 */
export function isOAuthServer(name: string, transport: string, target: string | undefined, saved: ReadonlySet<string>): boolean {
  if (transport !== 'http' && transport !== 'sse') return false;
  return saved.has(signInKey(name, target)) || saved.has(signInKey(name, undefined));
}

/** The CLI's answer to mcp_authenticate, as far as the agent reads it. */
export interface CliAuthStart {
  authUrl?: unknown;
  redirectScheme?: unknown;
  state?: unknown;
  callbackPort?: unknown;
  requiresUserAction?: unknown;
}

/** Poll every 2 s while a server is `pending`, at most this long after a start or an action (M3). */
export const MCP_PENDING_POLL_MS = 2_000;
export const MCP_PENDING_WINDOW_MS = 30_000;
/** Poll this often while the process lives; a snapshot is sent only when it changed. */
export const MCP_POLL_MS = 60_000;

/**
 * The key of `projects` in ~/.claude.json the CLI keeps a disable under (its project path for config): the canonical git
 * root of `cwd` — the nearest folder with `.git`, a linked worktree resolved to its main checkout through `commondir` —
 * else `cwd` itself; normalised, `\` → `/` on Windows like the CLI. Read from the file system, no git process.
 */
export function projectRootOf(cwd: string, platform: NodeJS.Platform = process.platform): string {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const out = (dir: string) => (platform === 'win32' ? p.normalize(dir).replaceAll('\\', '/') : p.normalize(dir));
  const start = p.resolve(cwd);
  for (let dir = start; ;) {
    const dotGit = p.join(dir, '.git');
    try {
      const st = statSync(dotGit);
      if (st.isDirectory()) return out(dir);
      if (st.isFile()) {
        const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
        if (m) {
          const gitDir = p.resolve(dir, m[1]!);
          try {
            const common = p.resolve(gitDir, readFileSync(p.join(gitDir, 'commondir'), 'utf8').trim());
            if (p.basename(common) === '.git') return out(p.dirname(common));
          } catch {
            // not a linked worktree (a submodule): the folder with the .git file is the root
          }
        }
        return out(dir);
      }
    } catch {
      // no .git here: one folder up
    }
    const up = p.dirname(dir);
    if (up === dir) return out(start);
    dir = up;
  }
}

/**
 * The redacted snapshot of a query; null when the status cannot be read (the process is ending). `oauthNames` — the
 * servers with a saved sign-in on the machine (A1); every row gets `oauth`.
 */
export async function readSnapshot(q: Pick<McpQuery, 'mcpServerStatus'>, now: number, log?: Logger, projectRoot?: string, oauthNames?: () => ReadonlySet<string>): Promise<McpSnapshot | null> {
  try {
    const list = await q.mcpServerStatus();
    let saved: ReadonlySet<string> | null = null;
    const servers = (Array.isArray(list) ? list : [])
      .filter(
        (s): s is SdkMcpStatus =>
          !!s && typeof (s as SdkMcpStatus).name === 'string' && (s as SdkMcpStatus).name !== '' && (s as SdkMcpStatus).name !== PEERS_SERVER_NAME && typeof (s as SdkMcpStatus).status === 'string',
      )
      .slice(0, 100)
      .map(s => {
        const row = redactServer(s);
        if (row.transport === 'http' || row.transport === 'sse') saved ??= safeNames(oauthNames, log);
        return { ...row, oauth: isOAuthServer(s.name, row.transport, row.target, saved ?? EMPTY) };
      });
    return { servers, observedAt: now, ...(projectRoot ? { projectRoot } : {}) };
  } catch (err) {
    log?.debug('mcp status unavailable', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

const EMPTY: ReadonlySet<string> = new Set();

function safeNames(fn: (() => ReadonlySet<string>) | undefined, log?: Logger): ReadonlySet<string> {
  try {
    return fn?.() ?? EMPTY;
  } catch (err) {
    log?.debug('mcp sign-ins unreadable', { error: err instanceof Error ? err.name : 'error' });
    return EMPTY;
  }
}

function hashOf(s: McpSnapshot): string {
  return JSON.stringify(s.servers);
}

export interface McpWatchDeps {
  sessionId: string;
  query: McpQuery;
  /** Sends an agent → hub message. */
  send: (type: string, payload: unknown) => void;
  /** The protocol of the hub from its last welcome: MCP messages go to hubs of 1.7+ only. */
  hubProtocol?: () => string | null;
  log: Logger;
  now?: () => number;
  /** projectRootOf(the session directory): sent in every snapshot. */
  projectRoot?: string;
  /** A1: the servers with a saved sign-in on the machine (oauthServerNames of the processes' config directory). */
  oauthNames?: () => ReadonlySet<string>;
  /** Every snapshot read (sent or not): the manager watches sign-ins that end without the hub's callback. */
  onSnapshot?: (snap: McpSnapshot) => void;
}

/**
 * Snapshots of one session process (M3): read after init, every 2 s while a server is `pending` (≤ 30 s after a start
 * or an action), every 60 s while the process lives, after every turn and every action; sent as mcp.status to a hub of
 * 1.7+ when the servers changed. Timers are dropped by stop() (onExit).
 */
export class McpWatch {
  private lastHash: string | null = null;
  private last: McpSnapshot | null = null;
  private pendingUntil = 0;
  private pendingTimer: NodeJS.Timeout | null = null;
  private readonly every: NodeJS.Timeout;
  private stopped = false;

  constructor(private readonly d: McpWatchDeps) {
    this.every = setInterval(() => void this.poll(), MCP_POLL_MS);
    this.every.unref?.();
  }

  get query(): McpQuery {
    return this.d.query;
  }

  /** The last snapshot read (null before the first). */
  get snapshot(): McpSnapshot | null {
    return this.last;
  }

  get active(): boolean {
    return !this.stopped;
  }

  private clock(): number {
    return this.d.now?.() ?? Date.now();
  }

  private hubOk(): boolean {
    return protocolAtLeast(this.d.hubProtocol?.() ?? null, MCP_PROTOCOL);
  }

  /** After init (start and resume): the first snapshot, then the pending window. */
  start(): Promise<McpSnapshot | null> {
    this.pendingUntil = this.clock() + MCP_PENDING_WINDOW_MS;
    return this.poll();
  }

  /** After an action: a fresh snapshot and a new pending window. */
  afterAction(): Promise<McpSnapshot | null> {
    this.pendingUntil = this.clock() + MCP_PENDING_WINDOW_MS;
    return this.poll();
  }

  /**
   * Reads the status; sends mcp.status when the servers changed. `reply` — the snapshot answers a command (cmd.ok
   * carries it), so it counts as sent.
   */
  async poll(reply = false): Promise<McpSnapshot | null> {
    if (this.stopped) return null;
    const snap = await readSnapshot(this.d.query, this.clock(), this.d.log, this.d.projectRoot, this.d.oauthNames);
    if (!snap || this.stopped) return snap;
    this.last = snap;
    const h = hashOf(snap);
    const changed = h !== this.lastHash;
    this.lastHash = h;
    if (changed && !reply && this.hubOk()) this.d.send('mcp.status', { sessionId: this.d.sessionId, snapshot: snap });
    this.schedulePending(snap);
    this.d.onSnapshot?.(snap);
    return snap;
  }

  private schedulePending(snap: McpSnapshot): void {
    if (this.pendingTimer || this.stopped) return;
    if (!snap.servers.some(s => s.status === 'pending') || this.clock() >= this.pendingUntil) return;
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      void this.poll();
    }, MCP_PENDING_POLL_MS);
    this.pendingTimer.unref?.();
  }

  /**
   * The agent (re)connected to a hub (welcome): the hub may have missed the last mcp.status while the link was down —
   * the hash is forgotten and the status is read again, so the current snapshot is sent once more.
   */
  resync(): Promise<McpSnapshot | null> {
    this.lastHash = null;
    return this.poll();
  }

  /** The process ended: no more timers, no more messages. */
  stop(): void {
    this.stopped = true;
    clearInterval(this.every);
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
  }

  /** Tests: timers still armed. */
  timers(): number {
    return this.stopped ? 0 : 1 + (this.pendingTimer ? 1 : 0);
  }
}
