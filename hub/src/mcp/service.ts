// MCP management in the hub (mcp-management design M6–M8, M11): snapshots of sessions and machines from agents,
// actions over servers (reconnect, enable, disable), the sign-in of remote servers through the hub's address, the
// wake-up of a sleeping session for an action, «Проверить» of a machine. The owner only (withOwnedSession, the runner's
// owner); agents of protocol 1.7+ only. The code of an OAuth callback is never logged or stored.
// Requirements: Статус MCP сессии; Отметка проблем MCP; Переподключение MCP-сервера; Включение и выключение MCP-сервера;
// Вход в удалённый MCP с любого устройства; Защита потока входа MCP; MCP спящей сессии; MCP машины; Права на MCP;
// Совместимость управления MCP с агентом; Выход из удалённого MCP (mcp-auth-controls A3).
import type { FastifyBaseLogger } from 'fastify';
import {
  MCP_AUTH_CONTROLS_PROTOCOL,
  MCP_PROTOCOL,
  MCP_TEXTS,
  mcpAuthStartResultSchema,
  mcpProbeResultSchema,
  mcpSnapshotResultSchema,
  protocolAtLeast,
  type AgentMessage,
  type McpAction,
  type McpMachineView,
  type McpPendingAction,
  type McpSessionView,
  type McpSnapshot,
  type PayloadOf,
  type UiServerMessage,
} from '@agent-hub/shared';
import type { Db } from '../db/db.js';
import type { HubBus } from '../bus.js';
import { CommandError, type AgentGateway } from '../runners/agentGateway.js';
import type { UiGateway } from '../ui/uiGateway.js';
import { getOwnedRunner, getRunner, type RunnerRow } from '../runners/repo.js';
import { findSessionByClaudeId, getSession, type SessionBase, type SessionRow } from '../sessions/repo.js';
import { HttpError, type SessionService } from '../sessions/service.js';
import { isLiveStatus } from '../sessions/status.js';
import { McpAuthFlows, flowView, type McpAuthFlow } from './authFlows.js';
import { canAuthOf, storeMachineServers, storeSessionSnapshot, toMachineMcpView, toSessionMcpView, type ServerState } from './repo.js';

/**
 * Timeouts of the hub's wait for the agent (M2). `callback` stays below the 60-s proxy_read_timeout of nginx on YM: the
 * GET /mcp/oauth/callback holds the browser's request while the process submits the code.
 */
export const MCP_TIMEOUTS: Readonly<Record<'status' | 'action' | 'authStart' | 'callback' | 'probe', number>> = { status: 15_000, action: 45_000, authStart: 30_000, callback: 45_000, probe: 45_000 };
/** «Проверить» at most this often per machine (M4). */
export const MCP_PROBE_MIN_MS = 30_000;
/** After a wake-up for «Переподключить»: the new process connects the servers itself; the status is read after this. */
export const MCP_WAKE_STATUS_DELAY_MS = 2_000;
export const MCP_CALLBACK_PATH = '/mcp/oauth/callback';
/** The answer of a passed callback is kept this long: a reload of the provider's page shows it, not «не найдена». */
export const MCP_CALLBACK_KEEP_MS = 10 * 60_000;
const MCP_CALLBACK_KEEP_MAX = 64;
/** «Войти» of a woken session: its snapshot is read until the server leaves `pending`, at most this long. */
export const MCP_WAKE_SETTLE_MS = 30_000;

export type McpCallbackOutcome = { ok: boolean; error?: string };
/** A callback passed to the process (or being passed): the key is the attempt's state. */
interface CallbackRun {
  userId: string;
  sessionId: string;
  server: string;
  at: number;
  done: McpCallbackOutcome | null;
  promise: Promise<McpCallbackOutcome>;
}

export interface McpServiceOptions {
  db: Db;
  bus: HubBus;
  agents: AgentGateway;
  ui: UiGateway;
  sessions: SessionService;
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
  /** PUBLIC_URL of the hub: the redirect address of a sign-in is `<publicUrl>/mcp/oauth/callback`. */
  publicUrl: string;
  now?: () => Date;
  /** Tests: shorter waits. */
  timeouts?: Partial<typeof MCP_TIMEOUTS>;
  probeMinMs?: number;
  wakeStatusDelayMs?: number;
  /** Tests: the longest wait for a woken server to leave `pending` before «Войти» starts. */
  wakeSettleMs?: number;
  /** Tests: the TTL of a sign-in attempt. */
  authTtlMs?: number;
  /** The period of the expiry sweep of sign-in attempts (default 30 s; 0 — no timer). */
  sweepMs?: number;
}

/** The text of an agent's refusal for the panel (lastError, mcp.auth error). */
function agentText(err: unknown): string {
  if (err instanceof HttpError) return err.message;
  if (err instanceof CommandError) {
    if (err.code === 'mcp_auth_unsupported') return MCP_TEXTS.authUnsupported;
    if (err.code === 'mcp_auth_state_mismatch') return MCP_TEXTS.stateMismatch;
    if (err.code === 'timeout') return 'Агент не ответил вовремя';
    if (err.code === 'disconnected') return 'Машина отключилась';
    if (err.code === 'not_running') return 'Процесс сессии не запущен';
    if (err.code === 'not_implemented') return MCP_TEXTS.agentOutdated;
    return err.message.slice(0, 1000) || err.code;
  }
  return err instanceof Error ? err.message.slice(0, 1000) : String(err);
}

/** The agent's sign-in address failed the schema (not https, http other than localhost, too long). */
export const MCP_AUTH_URL_REFUSED = 'Адрес входа от агента отклонён: нужен https (http — только для localhost)';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export class McpService {
  readonly flows: McpAuthFlows;
  private readonly now: () => Date;
  private readonly t: typeof MCP_TIMEOUTS;
  /** Hub session id → server → the action in flight and the last action's error. */
  private readonly states = new Map<string, Map<string, ServerState>>();
  /** Sessions being woken up for an action → the start of the new process (a second action waits for the same). */
  private readonly waking = new Map<string, Promise<void>>();
  /** Callbacks by state: a repeated GET of the provider's address does not pass the code a second time. */
  private readonly callbacks = new Map<string, CallbackRun>();
  private readonly probing = new Set<string>();
  /** Hub session id → servers whose «Войти» waits for the woken process to settle (afterWakeAuth); an exit cancels it. */
  private readonly settling = new Map<string, Set<string>>();
  private readonly probeAt = new Map<string, number>();
  private readonly probeErrors = new Map<string, string>();
  private readonly running = new Set<Promise<unknown>>();
  private readonly timer: NodeJS.Timeout | null = null;

  constructor(private readonly o: McpServiceOptions) {
    this.now = o.now ?? (() => new Date());
    this.t = { ...MCP_TIMEOUTS, ...o.timeouts };
    this.flows = new McpAuthFlows({ now: () => this.now().getTime(), ...(o.authTtlMs ? { ttlMs: o.authTtlMs } : {}), onExpire: f => this.track(this.flowEnded(f, 'expired')) });
    o.sessions.setSleepHold(id => this.flows.holdUntil(id));
    o.bus.on('agent.message', (runnerId, m) => {
      if (m.type === 'mcp.status') this.track(this.onStatus(runnerId, m.payload));
      else if (m.type === 'mcp.auth.done') this.track(this.onAuthDone(runnerId, m.payload));
      else if (m.type === 'session.exited') this.track(this.onExited(runnerId, m.payload.sessionId));
    });
    const every = o.sweepMs ?? 30_000;
    if (every > 0) {
      this.timer = setInterval(() => this.flows.sweep(), every);
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Background work of accepted (202) requests and agent messages; tests and close() wait for it. */
  async flush(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running]);
  }

  private track(p: Promise<unknown>): void {
    const q = p.catch((err: unknown) => this.o.log.error({ err }, 'mcp task failed'));
    this.running.add(q);
    void q.finally(() => this.running.delete(q));
  }

  get redirectUri(): string {
    return `${this.o.publicUrl.replace(/\/$/, '')}${MCP_CALLBACK_PATH}`;
  }

  // ---------- views ----------

  private stateOf(sessionId: string, server: string): ServerState {
    let m = this.states.get(sessionId);
    if (!m) this.states.set(sessionId, (m = new Map()));
    let st = m.get(server);
    if (!st) m.set(server, (st = {}));
    return st;
  }

  private setPending(sessionId: string, server: string, pending: McpPendingAction | undefined, lastError?: string | null): void {
    const st = this.stateOf(sessionId, server);
    if (pending) st.pending = pending;
    else delete st.pending;
    if (lastError === null) delete st.lastError;
    else if (lastError !== undefined) st.lastError = lastError;
  }

  private isPending(sessionId: string, server: string): boolean {
    return !!this.states.get(sessionId)?.get(server)?.pending;
  }

  private async viewOf(s: SessionBase): Promise<McpSessionView> {
    const runner = await getRunner(this.o.db, s.runner_id);
    return toSessionMcpView(s, {
      protocol: runner?.protocol_version ?? null,
      online: this.o.agents.isOnline(s.runner_id),
      states: this.states.get(s.id) ?? new Map(),
      flows: this.flows.ofSession(s.id).map(flowView),
      waking: this.waking.has(s.id),
    });
  }

  /** GET /api/sessions/:id/mcp (404 for anyone but the owner). */
  async view(userId: string, id: string): Promise<McpSessionView> {
    return this.viewOf(await this.o.sessions.get(userId, id));
  }

  private send(userId: string, msg: UiServerMessage): void {
    this.o.ui.broadcast(userId, msg);
  }

  /** WS session.mcp to the owner's windows (the row re-read). */
  private async emit(sessionId: string): Promise<void> {
    const s = await getSession(this.o.db, sessionId);
    if (s) this.send(s.user_id, { type: 'session.mcp', sessionId: s.id, mcp: await this.viewOf(s) });
  }

  private async machineView(runner: RunnerRow): Promise<McpMachineView> {
    const last = this.probeAt.get(runner.id);
    return toMachineMcpView(runner, {
      online: this.o.agents.isOnline(runner.id),
      probing: this.probing.has(runner.id),
      probeAvailableAt: last !== undefined ? new Date(last + (this.o.probeMinMs ?? MCP_PROBE_MIN_MS)) : null,
      probeError: this.probeErrors.get(runner.id) ?? null,
      now: this.now(),
    });
  }

  private async emitMachine(runnerId: string): Promise<void> {
    const r = await getRunner(this.o.db, runnerId);
    if (r) this.send(r.user_id, { type: 'runner.mcp', runnerId: r.id, mcp: await this.machineView(r) });
  }

  /** A snapshot of a session (mcp.status or a cmd.ok): stored when newer; the head mark, the machine block, the panel. */
  private async apply(s: Pick<SessionBase, 'id' | 'runner_id'>, snap: McpSnapshot): Promise<void> {
    const stored = await storeSessionSnapshot(this.o.db, s.id, snap);
    if (stored?.problemsChanged) await this.o.sessions.upsert(s.id);
    if (await storeMachineServers(this.o.db, s.runner_id, snap, 'session')) await this.emitMachine(s.runner_id);
    // the sign-in passed without the hub (the CLI's own localhost callback in a browser of the same machine): an accepted
    // newer snapshot shows the server connected — the attempt is over with ok, an earlier error of the server goes too
    // (the agents' clock is not compared with the hub's). An attempt started on a `connected` server («Войти заново»)
    // is not ended by `connected` alone: the process keeps its old connection after the CLI dropped the token — only
    // after the server left `connected` once, or by mcp.auth.done (mcp-auth-controls, review fix)
    let ended = false;
    for (const f of stored ? this.flows.ofSession(s.id) : []) {
      const status = snap.servers.find(x => x.name === f.server)?.status;
      if (status !== 'connected') {
        if (status !== undefined) f.leftConnected = true;
        continue;
      }
      if (f.startedConnected && !f.leftConnected) continue;
      if (!this.flows.remove(f)) continue;
      ended = true;
      this.setPending(s.id, f.server, undefined, null);
      this.send(f.userId, { type: 'mcp.auth', sessionId: f.sessionId, server: f.server, flow: null, result: 'ok' });
    }
    if (ended) await this.o.sessions.upsert(s.id);
    await this.emit(s.id);
  }

  // ---------- agent messages ----------

  private async onStatus(runnerId: string, p: PayloadOf<AgentMessage, 'mcp.status'>): Promise<void> {
    const s = await findSessionByClaudeId(this.o.db, runnerId, p.sessionId);
    if (s) await this.apply(s, p.snapshot);
  }

  private async onAuthDone(runnerId: string, p: PayloadOf<AgentMessage, 'mcp.auth.done'>): Promise<void> {
    const s = await findSessionByClaudeId(this.o.db, runnerId, p.sessionId);
    if (!s) return;
    const f = this.flows.find(s.id, p.server);
    if (f && this.flows.remove(f)) {
      // the agent's text is English and technical: the panel gets the spec's text
      this.send(s.user_id, { type: 'mcp.auth', sessionId: s.id, server: p.server, flow: null, result: p.ok ? 'ok' : 'failed', ...(p.ok ? {} : { error: MCP_TEXTS.notConnectedAfterSignIn }) });
      await this.o.sessions.upsert(s.id);
    }
    await this.emit(s.id);
  }

  /** Requirement «Защита потока входа MCP»: the process exited — its attempts end with «Вход прерван…». */
  private async onExited(runnerId: string, claudeSessionId: string): Promise<void> {
    const s = await findSessionByClaudeId(this.o.db, runnerId, claudeSessionId);
    if (!s) return;
    for (const f of this.flows.removeSession(s.id)) {
      this.send(s.user_id, { type: 'mcp.auth', sessionId: s.id, server: f.server, flow: null, result: 'process_exited', error: MCP_TEXTS.processExited });
    }
    // a «Войти» still waiting for the woken process to settle: the wait ends here, the start is not sent
    for (const server of this.settling.get(s.id) ?? []) {
      this.send(s.user_id, { type: 'mcp.auth', sessionId: s.id, server, flow: null, result: 'process_exited', error: MCP_TEXTS.processExited });
    }
    this.settling.delete(s.id);
    const m = this.states.get(s.id);
    // an action in flight on the process that is gone (a wake-up waits for the next process: kept); errors of earlier
    // actions belong to the gone process — dropped with their rows, the map of the session goes when it is empty
    if (m) {
      for (const [server, st] of m) {
        if (st.pending === 'wake') continue;
        if (st.pending) this.setPending(s.id, server, undefined, 'Процесс сессии завершился');
        else m.delete(server);
      }
      if (!m.size) this.states.delete(s.id);
    }
    await this.emit(s.id);
  }

  private async flowEnded(f: McpAuthFlow, result: 'expired'): Promise<void> {
    this.send(f.userId, { type: 'mcp.auth', sessionId: f.sessionId, server: f.server, flow: null, result });
    await this.o.sessions.upsert(f.sessionId).catch(() => undefined);
    await this.emit(f.sessionId);
  }

  // ---------- commands of the panel ----------

  /** 409 agent_outdated (protocol < 1.7), 409 not_hub_managed. */
  private async gate(s: SessionRow): Promise<RunnerRow> {
    const runner = await getRunner(this.o.db, s.runner_id);
    if (!runner || !protocolAtLeast(runner.protocol_version, MCP_PROTOCOL)) throw new HttpError(409, 'agent_outdated', MCP_TEXTS.agentOutdated);
    if (!s.is_hub_managed) throw new HttpError(409, 'not_hub_managed', MCP_TEXTS.notHubManaged);
    return runner;
  }

  /** A session being woken for an action is not live yet: its process may still be initialising. */
  private isLive(s: SessionRow): boolean {
    return !this.waking.has(s.id) && s.process_alive && isLiveStatus(s.status) && this.o.agents.isOnline(s.runner_id);
  }

  /** The server in the stored snapshot (when there is one): 422 mcp_unknown_server otherwise. */
  private knownServer(s: SessionRow, server: string) {
    const rows = Array.isArray(s.mcp_servers) ? s.mcp_servers : null;
    if (!rows) return null;
    const row = rows.find(r => r.name === server);
    if (!row) throw new HttpError(422, 'mcp_unknown_server', `Сервер ${server.slice(0, 200)} не найден в сессии`);
    return row;
  }

  private conn(runnerId: string) {
    const c = this.o.agents.get(runnerId);
    if (!c) throw new HttpError(409, 'runner_offline', 'Машина не в сети');
    return c;
  }

  /**
   * Prepares `then` to run once the session's process is up: a live process — at once; a sleeping one is woken first
   * (M11) — `pendingAction: 'wake'` until its start; the refusal of «Продолжить» (offline, read-only…) is thrown here.
   * Returns the starter: the caller builds the 202 view first (with the pending mark), then starts the work.
   */
  private async prepare(s: SessionRow, userId: string, server: string, pending: McpPendingAction, then: () => Promise<void>, onWoken?: () => Promise<void>): Promise<() => void> {
    if (this.isLive(s)) {
      this.setPending(s.id, server, pending, null);
      return () => this.track(then());
    }
    // a wake-up already in progress (another server's action): wait for the same start, no second «Продолжить»
    let started = this.waking.get(s.id);
    if (!started) {
      started = (await this.o.sessions.wakeForAction(s, userId)).started;
      this.waking.set(s.id, started);
    }
    this.setPending(s.id, server, 'wake', null);
    const woken = started;
    return () =>
      this.track(
        woken.then(
          async () => {
            this.waking.delete(s.id);
            this.setPending(s.id, server, pending);
            await this.emit(s.id);
            await (onWoken ?? then)();
          },
          async (err: unknown) => {
            this.waking.delete(s.id);
            this.setPending(s.id, server, undefined, `Сессия не поднялась: ${agentText(err)}`);
            await this.emit(s.id);
          },
        ),
      );
  }

  /** The 202 view with the pending mark, then the work starts. */
  private async accepted(s: SessionRow, go: () => void): Promise<McpSessionView> {
    const v = await this.viewOf(s);
    go();
    return v;
  }

  /** POST /api/sessions/:id/mcp/refresh: a live process is asked for its status; a sleeping one is not woken. */
  async refresh(userId: string, id: string): Promise<McpSessionView> {
    return this.o.sessions.withOwnedSession(userId, id, async s => {
      await this.gate(s);
      return this.accepted(s, () => (this.isLive(s) ? this.track(this.statusGet(s)) : undefined));
    });
  }

  private async statusGet(s: Pick<SessionBase, 'id' | 'runner_id' | 'claude_session_id'>): Promise<McpSnapshot | null> {
    try {
      const r = mcpSnapshotResultSchema.parse(await this.conn(s.runner_id).request('mcp.status.get', { sessionId: s.claude_session_id }, this.t.status));
      await this.apply(s, r.snapshot);
      return r.snapshot;
    } catch (err) {
      this.o.log.warn({ sessionId: s.id, err: agentText(err) }, 'mcp status refresh failed');
      return null;
    }
  }

  /** POST /api/sessions/:id/mcp/actions → 202: the result comes as session.mcp (new snapshot or lastError). */
  async action(userId: string, id: string, server: string, action: McpAction): Promise<McpSessionView> {
    const view = await this.o.sessions.withOwnedSession(userId, id, async s => {
      await this.gate(s);
      const row = this.knownServer(s, server);
      if (row && row.status === 'disabled' && action === 'reconnect') throw new HttpError(422, 'invalid_request', 'Сервер выключен — сначала включите его');
      if (this.isPending(s.id, server)) return this.viewOf(s);
      this.o.log.info({ sessionId: s.id, server, action }, 'mcp action');
      // «Переподключить» of a sleeping session: the new process connects its servers itself — the status after 2 s
      const afterWake = action === 'reconnect' ? () => this.afterWakeStatus(s, server) : undefined;
      return this.accepted(s, await this.prepare(s, userId, server, action, () => this.runAction(s, server, action), afterWake));
    });
    void this.emit(id).catch(() => undefined);
    return view;
  }

  private async afterWakeStatus(s: SessionRow, server: string): Promise<void> {
    await sleep(this.o.wakeStatusDelayMs ?? MCP_WAKE_STATUS_DELAY_MS);
    this.setPending(s.id, server, undefined);
    await this.statusGet(s);
    await this.emit(s.id);
  }

  /**
   * «Войти» of a woken session: the snapshot is read until the server is no longer `pending` (≤ 30 s), then the start.
   * The process exits meanwhile — the wait ends (onExited sends «Вход прерван…» once); the server is not in the new
   * process's snapshot — mcp_unknown_server at once, no start.
   */
  private async afterWakeAuth(s: SessionRow, server: string): Promise<void> {
    const waiting = this.settling.get(s.id) ?? new Set<string>();
    this.settling.set(s.id, waiting.add(server));
    const cancelled = () => this.settling.get(s.id)?.has(server) !== true;
    const deadline = this.now().getTime() + (this.o.wakeSettleMs ?? MCP_WAKE_SETTLE_MS);
    try {
      for (;;) {
        await sleep(this.o.wakeStatusDelayMs ?? MCP_WAKE_STATUS_DELAY_MS);
        if (cancelled()) return;
        const snap = await this.statusGet(s);
        if (cancelled()) return;
        const row = snap?.servers.find(x => x.name === server);
        if (snap && !row) {
          const text = `Сервер ${server.slice(0, 200)} не найден в сессии`;
          this.o.log.info({ sessionId: s.id, server, code: 'mcp_unknown_server' }, 'mcp sign-in refused');
          this.setPending(s.id, server, undefined, text);
          this.send(s.user_id, { type: 'mcp.auth', sessionId: s.id, server, flow: null, result: 'failed', error: text });
          await this.emit(s.id);
          return;
        }
        if ((row && row.status !== 'pending') || this.now().getTime() >= deadline) break;
      }
    } finally {
      const set = this.settling.get(s.id);
      if (set?.delete(server) && !set.size) this.settling.delete(s.id);
    }
    await this.runAuthStart(s, server);
  }

  private async runAction(s: SessionRow, server: string, action: McpAction): Promise<void> {
    try {
      const r = mcpSnapshotResultSchema.parse(await this.conn(s.runner_id).request('mcp.action', { sessionId: s.claude_session_id, server, action }, this.t.action));
      this.setPending(s.id, server, undefined, null);
      await this.apply(s, r.snapshot);
    } catch (err) {
      this.o.log.info({ sessionId: s.id, server, action, err: agentText(err) }, 'mcp action failed');
      this.setPending(s.id, server, undefined, agentText(err));
      await this.emit(s.id);
    }
  }

  /** POST /api/sessions/:id/mcp/auth → 202: the attempt (or its refusal) comes as mcp.auth. */
  async auth(userId: string, id: string, server: string): Promise<McpSessionView> {
    const view = await this.o.sessions.withOwnedSession(userId, id, async s => {
      await this.gate(s);
      const row = this.knownServer(s, server);
      if (row && !canAuthOf(row)) throw new HttpError(422, 'mcp_auth_unsupported', 'Вход есть только у удалённых серверов (http, sse)');
      if (this.isPending(s.id, server)) return this.viewOf(s);
      this.o.log.info({ sessionId: s.id, server }, 'mcp sign-in requested');
      // a woken process connects its servers itself: the sign-in starts once this server left `pending`
      return this.accepted(
        s,
        await this.prepare(
          s,
          userId,
          server,
          'auth',
          () => this.runAuthStart(s, server),
          () => this.afterWakeAuth(s, server),
        ),
      );
    });
    void this.emit(id).catch(() => undefined);
    return view;
  }

  private async runAuthStart(s: SessionRow, server: string): Promise<void> {
    // the status of the server when the attempt starts: the latest stored snapshot (a woken process re-read it)
    const cur = await getSession(this.o.db, s.id);
    const startedConnected = (Array.isArray(cur?.mcp_servers) ? cur.mcp_servers : []).find(r => r.name === server)?.status === 'connected';
    try {
      const parsed = mcpAuthStartResultSchema.safeParse(
        await this.conn(s.runner_id).request('mcp.auth.start', { sessionId: s.claude_session_id, server, redirectUri: this.redirectUri }, this.t.authStart),
      );
      if (!parsed.success) {
        const badUrl = parsed.error.issues.some(i => i.path[0] === 'authUrl');
        throw new HttpError(502, 'bad_agent_reply', badUrl ? MCP_AUTH_URL_REFUSED : 'Агент вернул некорректный ответ на запрос входа');
      }
      const r = parsed.data;
      // a snapshot stored while the agent was answering (needs-auth after the CLI dropped the token) counts as «left»
      const now = startedConnected ? await getSession(this.o.db, s.id) : null;
      const leftConnected = !!now && (Array.isArray(now.mcp_servers) ? now.mcp_servers : []).find(r => r.name === server)?.status !== 'connected';
      const { flow, removed } = this.flows.add({
        state: r.state,
        userId: s.user_id,
        sessionId: s.id,
        runnerId: s.runner_id,
        claudeSessionId: s.claude_session_id,
        server,
        authUrl: r.authUrl,
        redirect: r.redirect,
        ...(r.callbackPort !== undefined ? { callbackPort: r.callbackPort } : {}),
        ...(startedConnected ? { startedConnected } : {}),
        ...(leftConnected ? { leftConnected } : {}),
      });
      // attempts evicted by the limit of 8 (another session or server): they end as expired
      for (const old of removed)
        if (old.sessionId !== s.id || old.server !== server) this.send(old.userId, { type: 'mcp.auth', sessionId: old.sessionId, server: old.server, flow: null, result: 'expired' });
      this.setPending(s.id, server, undefined, null);
      this.send(s.user_id, { type: 'mcp.auth', sessionId: s.id, server, flow: flowView(flow) });
      this.o.log.info({ sessionId: s.id, server, redirect: r.redirect }, 'mcp sign-in started');
      // the countdown of sleep moves (an attempt holds the session awake)
      await this.o.sessions.upsert(s.id);
    } catch (err) {
      const text = agentText(err);
      this.o.log.info({ sessionId: s.id, server, err: text }, 'mcp sign-in refused');
      this.setPending(s.id, server, undefined, text);
      this.send(s.user_id, { type: 'mcp.auth', sessionId: s.id, server, flow: null, result: 'failed', error: text });
    }
    await this.emit(s.id);
  }

  /**
   * The address of the paste fallback (M8): `http://localhost|127.0.0.1:<the port the CLI gave>/…` or the hub's own
   * redirect address; it must carry the attempt's `state` and a `code` or an `error`. 400 bad_callback_url otherwise.
   */
  checkCallbackUrl(f: McpAuthFlow, raw: string): URL {
    let u: URL;
    try {
      u = new URL(raw.trim());
    } catch {
      throw new HttpError(400, 'bad_callback_url', 'Это не адрес страницы — скопируйте адрес из строки браузера целиком');
    }
    const local = u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && f.callbackPort !== undefined && Number(u.port) === f.callbackPort;
    const hub = `${u.origin}${u.pathname}` === this.redirectUri;
    if (!local && !hub) {
      throw new HttpError(400, 'bad_callback_url', f.callbackPort !== undefined ? `Адрес должен начинаться с http://localhost:${f.callbackPort}/` : 'Адрес не от страницы входа');
    }
    if (u.searchParams.get('state') !== f.state || (!u.searchParams.get('code') && !u.searchParams.get('error'))) throw new HttpError(400, 'bad_callback_url', MCP_TEXTS.stateMismatch);
    return u;
  }

  /** POST /api/sessions/:id/mcp/auth/callback (the paste fallback) → 202; the end comes as mcp.auth. */
  async pasteCallback(userId: string, id: string, server: string, callbackUrl: string): Promise<McpSessionView> {
    return this.o.sessions.withOwnedSession(userId, id, async s => {
      await this.gate(s);
      const f = this.flows.find(s.id, server);
      if (!f) throw new HttpError(404, 'no_auth_flow', 'Попытка входа не найдена — нажмите «Войти» ещё раз');
      const u = this.checkCallbackUrl(f, callbackUrl);
      this.setPending(s.id, server, 'auth', null);
      return this.accepted(s, () => this.track(this.runCallback(f, u.toString())));
    });
  }

  /**
   * A callback of `state` already passed (or being passed) for `userId`: a repeated GET of the provider's address gets
   * the waiting page or the result, the code is not sent to the machine again.
   */
  callbackOf(userId: string, state: string | undefined): { done: McpCallbackOutcome | null; sessionId: string; server: string } | null {
    if (!state) return null;
    const c = this.callbacks.get(state);
    if (!c || c.userId !== userId || this.now().getTime() - c.at > MCP_CALLBACK_KEEP_MS) return null;
    return { done: c.done, sessionId: c.sessionId, server: c.server };
  }

  /** The browser came back to the hub (GET /mcp/oauth/callback): the attempt of `state` owned by `userId`, else null. */
  flowFor(userId: string, state: string | undefined): McpAuthFlow | null {
    if (!state) return null;
    const f = this.flows.get(state);
    return f && f.userId === userId ? f : null;
  }

  /**
   * Passes the address to the process (mcp.auth.callback): submit → reconnect → snapshot. A state mismatch keeps the
   * attempt waiting; anything else ends it. Resolves with the outcome for the page of the callback route. A callback of
   * the same attempt already in flight is not sent again: the caller gets the same outcome.
   */
  runCallback(f: McpAuthFlow, callbackUrl: string): Promise<McpCallbackOutcome> {
    const cur = this.callbacks.get(f.state);
    if (cur && !cur.done) return cur.promise;
    const now = this.now().getTime();
    for (const [k, c] of this.callbacks) if (now - c.at > MCP_CALLBACK_KEEP_MS || (this.callbacks.size >= MCP_CALLBACK_KEEP_MAX && c.done)) this.callbacks.delete(k);
    const run: CallbackRun = { userId: f.userId, sessionId: f.sessionId, server: f.server, at: now, done: null, promise: Promise.resolve({ ok: false }) };
    run.promise = this.passCallback(f, callbackUrl).then(
      out => {
        run.done = out;
        // a state mismatch keeps the attempt waiting: the next address of it must reach the process
        if (this.flows.get(f.state)) this.callbacks.delete(f.state);
        return out;
      },
      (err: unknown) => {
        this.callbacks.delete(f.state);
        throw err;
      },
    );
    this.callbacks.set(f.state, run);
    return run.promise;
  }

  private async passCallback(f: McpAuthFlow, callbackUrl: string): Promise<McpCallbackOutcome> {
    const providerError = new URL(callbackUrl).searchParams.get('error');
    let out: { ok: boolean; error?: string };
    try {
      const r = mcpSnapshotResultSchema.parse(await this.conn(f.runnerId).request('mcp.auth.callback', { sessionId: f.claudeSessionId, server: f.server, callbackUrl }, this.t.callback));
      const ok = !providerError && r.snapshot.servers.find(x => x.name === f.server)?.status === 'connected';
      out = ok ? { ok } : { ok, error: providerError ?? MCP_TEXTS.notConnectedAfterSignIn };
      this.setPending(f.sessionId, f.server, undefined, ok ? null : out.error);
      if (this.flows.remove(f)) this.send(f.userId, { type: 'mcp.auth', sessionId: f.sessionId, server: f.server, flow: null, result: ok ? 'ok' : 'failed', ...(ok ? {} : { error: out.error! }) });
      await this.apply({ id: f.sessionId, runner_id: f.runnerId }, r.snapshot);
    } catch (err) {
      const text = providerError ?? agentText(err);
      out = { ok: false, error: text };
      this.setPending(f.sessionId, f.server, undefined, text);
      if (err instanceof CommandError && err.code === 'mcp_auth_state_mismatch') {
        // the attempt keeps waiting (the CLI's own rule)
        this.send(f.userId, { type: 'mcp.auth', sessionId: f.sessionId, server: f.server, flow: flowView(f), error: MCP_TEXTS.stateMismatch });
      } else if (this.flows.remove(f)) {
        this.send(f.userId, { type: 'mcp.auth', sessionId: f.sessionId, server: f.server, flow: null, result: 'failed', error: text });
      }
      await this.emit(f.sessionId);
    }
    this.o.log.info({ sessionId: f.sessionId, server: f.server, ok: out.ok }, 'mcp sign-in callback');
    await this.o.sessions.upsert(f.sessionId).catch(() => undefined);
    return out;
  }

  /**
   * POST /api/sessions/:id/mcp/logout → 202 (mcp-auth-controls A3): the owner only; agents of 1.8+ (else 409
   * agent_outdated); http/sse only (422 mcp_auth_unsupported); a sleeping session wakes up. The result comes as
   * session.mcp (the new snapshot or `lastError`).
   */
  async logout(userId: string, id: string, server: string): Promise<McpSessionView> {
    const view = await this.o.sessions.withOwnedSession(userId, id, async s => {
      const runner = await this.gate(s);
      if (!protocolAtLeast(runner.protocol_version, MCP_AUTH_CONTROLS_PROTOCOL)) throw new HttpError(409, 'agent_outdated', MCP_TEXTS.agentOutdated);
      const row = this.knownServer(s, server);
      if (row && !canAuthOf(row)) throw new HttpError(422, 'mcp_auth_unsupported', 'Выход есть только у удалённых серверов (http, sse)');
      if (this.isPending(s.id, server)) return this.viewOf(s);
      this.o.log.info({ sessionId: s.id, server }, 'mcp sign-out requested');
      return this.accepted(
        s,
        await this.prepare(
          s,
          userId,
          server,
          'logout',
          () => this.runLogout(s, server),
          () => this.afterWakeLogout(s, server),
        ),
      );
    });
    void this.emit(id).catch(() => undefined);
    return view;
  }

  /** A woken process connects its servers itself: the sign-out waits until this server left `pending` (≤ 30 s). */
  private async afterWakeLogout(s: SessionRow, server: string): Promise<void> {
    const deadline = this.now().getTime() + (this.o.wakeSettleMs ?? MCP_WAKE_SETTLE_MS);
    for (;;) {
      await sleep(this.o.wakeStatusDelayMs ?? MCP_WAKE_STATUS_DELAY_MS);
      const row = (await this.statusGet(s))?.servers.find(x => x.name === server);
      if ((row && row.status !== 'pending') || this.now().getTime() >= deadline) break;
    }
    await this.runLogout(s, server);
  }

  private async runLogout(s: SessionRow, server: string): Promise<void> {
    // Requirement «Выход из удалённого MCP»: an open sign-in into this server on this machine ends
    const closed = this.flows.removeFor(s.runner_id, server);
    for (const f of closed) this.send(f.userId, { type: 'mcp.auth', sessionId: f.sessionId, server: f.server, flow: null, result: 'expired' });
    for (const sid of new Set(closed.map(f => f.sessionId))) {
      await this.o.sessions.upsert(sid).catch(() => undefined);
      if (sid !== s.id) await this.emit(sid);
    }
    try {
      const r = mcpSnapshotResultSchema.parse(await this.conn(s.runner_id).request('mcp.auth.logout', { sessionId: s.claude_session_id, server }, this.t.action));
      this.setPending(s.id, server, undefined, null);
      this.o.log.info({ sessionId: s.id, server }, 'mcp sign-out done');
      await this.apply(s, r.snapshot);
    } catch (err) {
      const text =
        err instanceof CommandError && err.code === 'mcp_auth_unsupported'
          ? err.message.startsWith('Выход')
            ? err.message.slice(0, 1000)
            : MCP_TEXTS.logoutUnsupported.replace('<сервер>', server.slice(0, 200))
          : agentText(err);
      this.o.log.info({ sessionId: s.id, server, err: text }, 'mcp sign-out failed');
      this.setPending(s.id, server, undefined, text);
      await this.emit(s.id);
    }
  }

  // ---------- machine ----------

  private async owned(userId: string, runnerId: string): Promise<RunnerRow> {
    const r = await getOwnedRunner(this.o.db, userId, runnerId);
    if (!r) throw new HttpError(404, 'runner_not_found', 'Машина не найдена');
    return r;
  }

  /** GET /api/runners/:id/mcp (the owner only). */
  async machine(userId: string, runnerId: string): Promise<McpMachineView> {
    return this.machineView(await this.owned(userId, runnerId));
  }

  /** POST /api/runners/:id/mcp/probe → 202; 409 runner_offline | agent_outdated | probe_busy; 429 probe_too_soon. */
  async probe(userId: string, runnerId: string): Promise<McpMachineView> {
    const r = await this.owned(userId, runnerId);
    if (!protocolAtLeast(r.protocol_version, MCP_PROTOCOL)) throw new HttpError(409, 'agent_outdated', MCP_TEXTS.agentOutdated);
    const conn = this.o.agents.get(r.id);
    if (!conn) throw new HttpError(409, 'runner_offline', `${r.name} не в сети`);
    if (this.probing.has(r.id)) throw new HttpError(409, 'probe_busy', 'Проверка уже идёт');
    const now = this.now().getTime();
    const last = this.probeAt.get(r.id);
    const min = this.o.probeMinMs ?? MCP_PROBE_MIN_MS;
    if (last !== undefined && now - last < min) {
      const sec = Math.ceil((last + min - now) / 1000);
      throw new HttpError(429, 'probe_too_soon', `Проверить снова можно через ${sec} с`, { retryAfter: String(sec) });
    }
    this.probeAt.set(r.id, now);
    this.probing.add(r.id);
    this.o.log.info({ runnerId: r.id }, 'mcp machine probe');
    this.track(
      (async () => {
        try {
          const res = mcpProbeResultSchema.parse(await conn.request('mcp.machine.probe', {}, this.t.probe));
          await storeMachineServers(this.o.db, r.id, res.snapshot, 'probe');
          this.probeErrors.delete(r.id);
        } catch (err) {
          const text = err instanceof CommandError && err.code === 'mcp_probe_busy' ? 'Проверка уже идёт на машине' : agentText(err);
          this.probeErrors.set(r.id, text);
          this.o.log.warn({ runnerId: r.id, err: text }, 'mcp machine probe failed');
        } finally {
          this.probing.delete(r.id);
          await this.emitMachine(r.id);
        }
      })(),
    );
    const view = await this.machineView(r);
    void this.emitMachine(r.id).catch(() => undefined);
    return view;
  }
}
