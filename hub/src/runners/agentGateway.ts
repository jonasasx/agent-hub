// /ws/agent — agent connections (design.md D3).
// Requirements: Аутентификация агента по токену; Версионированный протокол; Онлайн-статус и переподключение.
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  AGENT_UPDATE_PROTOCOL,
  HUB_CAPABILITIES,
  CloseCode,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  PROTOCOL_VERSION,
  PROVIDERS_PROTOCOL,
  WS_MAX_PAYLOAD,
  envelope,
  isCompatibleProtocol,
  parseAgentMessage,
  protocolAtLeast,
  type AgentMessage,
  type EnrollStage,
  type HubMessage,
  type PayloadOf,
  type TurnFailure,
} from '@agent-hub/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Db, RunnerUpdateState } from '../db/db.js';
import type { HubBus } from '../bus.js';
import { advanceEnroll, findRunnerAuth, getRunner, promoteNextToken, toRunnerView, versionLess } from './repo.js';
import type { AgentBuildInfo } from './agentBuild.js';
import { clientIp, type RateLimiter, type TrustFn } from '../http/limits.js';
import { logSecurity } from '../users/repo.js';
import { cursorsForRunner } from '../sessions/repo.js';
import { KeyedSerial } from '../util/serial.js';

const SENSITIVE_FIELD_NAME = /(?:secret|credential|token|password|authorization|cookie)/i;

function hasSensitiveField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasSensitiveField);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, nested]) => SENSITIVE_FIELD_NAME.test(key) || hasSensitiveField(nested));
}

function shouldRedactInvalidMessage(type: string | undefined, raw: string): boolean {
  if (type?.startsWith('mcp.')) return true;
  try {
    return hasSensitiveField(JSON.parse(raw) as unknown);
  } catch {
    return false;
  }
}

/** Frame limit before the agent has authenticated and sent hello; raised to WS_MAX_PAYLOAD afterwards. */
export const PRE_HELLO_MAX_PAYLOAD = 1024 * 1024;

/** Raises the per-socket frame limit of a ws connection (ws has no public API for this). */
function setMaxPayload(ws: WebSocket, bytes: number): void {
  const receiver = (ws as unknown as { _receiver?: { _maxPayload?: number } })._receiver;
  if (receiver && typeof receiver._maxPayload === 'number') receiver._maxPayload = bytes;
}

export interface AgentGatewayOptions {
  db: Db;
  bus: HubBus;
  log: FastifyBaseLogger;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  /** How often silence is checked against heartbeatTimeoutMs (default 5 s: a dead link is noticed ≤65 s). */
  heartbeatCheckMs?: number;
  helloTimeoutMs?: number;
  /** Default timeout of request() commands. */
  commandTimeoutMs?: number;
  /** Change multi-user (M9): bad tokens per address before the handshake; addresses behind trusted proxies. */
  badTokenLimiter?: RateLimiter;
  trust?: TrustFn;
  /** The agent build the hub serves (M5): «устарела» and agent.update. */
  latestAgent?: () => AgentBuildInfo | null;
  /** How often connected agents are re-checked for an update offer (default 10 min): retries after UPDATE_RETRY_*. */
  updateCheckMs?: number;
}

/** A failed update (other than a bad SHA-256) is offered again after this long. */
export const UPDATE_RETRY_FAILED_MS = 6 * 60 * 60_000;
/** `installing` without a result (the agent never came back with the version nor reported a failure): offered again. */
export const UPDATE_RETRY_INSTALLING_MS = 60 * 60_000;

/**
 * Whether the offer of `version` is held back by the runner's update state (design M5). `failed` — retried after 6 h,
 * except `sha_mismatch`: the same build would fail again; `installing` — the agent is restarting into it (a failed start
 * is reported by the old version right after welcome), retried after 1 h without a result.
 */
export function updateOfferHeld(state: RunnerUpdateState | null, version: string, sha256: string, nowMs = Date.now()): boolean {
  if (!state || state.version !== version) return false;
  const age = nowMs - Date.parse(state.at);
  const fresh = (ms: number) => !(age >= ms); // an unparsable `at` counts as fresh
  if (state.status === 'failed') {
    if ((state.error ?? '').startsWith('sha_mismatch')) {
      const expectedSha = state.sha256 ?? state.error?.match(/^sha_mismatch:\s*expected\s+([a-f\d]{64})\b/i)?.[1];
      return !expectedSha || expectedSha === sha256;
    }
    return fresh(UPDATE_RETRY_FAILED_MS);
  }
  if (state.status === 'installing') return fresh(UPDATE_RETRY_INSTALLING_MS);
  return false;
}

type CommandType = Extract<HubMessage, { id: string }>['type'];

export class CommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** 1.4: why handoff.generate failed when the subscription or account is the reason (claude-subscriptions QA B1). */
    readonly failure?: TurnFailure,
  ) {
    super(message);
  }
}

export class AgentConnection {
  lastAliveAt = Date.now();
  /** side.file announced; its bytes come in the next binary frame (D3). */
  pendingSide: PayloadOf<AgentMessage, 'side.file'> | null = null;
  /** cmd.ok whose bytes come in the next binary frame. */
  pendingCmdBinary: { re: string; result: Record<string, unknown> } | null = null;
  replaced = false;
  /** Hub clock minus the machine's clock at hello (ms); null for an agent before M4a (no clockMs). */
  clockOffsetMs: number | null = null;
  capabilities: string[] = [];
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  /** Client address of the connection (trusted X-Forwarded-For): the security log. */
  ip: string | null = null;

  constructor(
    readonly runnerId: string,
    readonly userId: string,
    readonly ws: WebSocket,
    private readonly commandTimeoutMs: number,
  ) {}

  send(type: string, payload: unknown, extra: { id?: string; re?: string } = {}): void {
    this.ws.send(JSON.stringify(envelope(type, payload, extra)));
  }

  /** Sends a command and resolves with cmd.ok.result, rejects with cmd.error / timeout / disconnect. */
  request<T extends CommandType>(type: T, payload: PayloadOf<HubMessage, T>, timeoutMs = this.commandTimeoutMs, requestId = randomUUID()): Promise<unknown> {
    const id = requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CommandError('timeout', `${type} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send(type, payload, { id });
    });
  }

  settle(re: string, ok: boolean, payload: { result?: unknown; code?: string; message?: string; failure?: TurnFailure | undefined }): void {
    const p = this.pending.get(re);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(re);
    if (ok) p.resolve(payload.result);
    else p.reject(new CommandError(payload.code ?? 'error', payload.message ?? '', payload.failure));
  }

  failAll(reason: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new CommandError('disconnected', reason));
      this.pending.delete(id);
    }
  }
}

function text(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1]! : null;
}

export class AgentGateway {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: PRE_HELLO_MAX_PAYLOAD });
  private readonly conns = new Map<string, AgentConnection>();
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly helloTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private checkTimer: NodeJS.Timeout | null = null;
  private updateTimer: NodeJS.Timeout | null = null;
  /** Per-runner queue: DB writes of hello and close are applied in event order. */
  private readonly queue = new KeyedSerial();

  constructor(private readonly opts: AgentGatewayOptions) {
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
    this.helloTimeoutMs = opts.helloTimeoutMs ?? 15_000;
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 30_000;
    this.heartbeatTimer = setInterval(() => this.ping(), this.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
    this.checkTimer = setInterval(() => this.checkAlive(), opts.heartbeatCheckMs ?? Math.min(5000, this.heartbeatIntervalMs));
    this.checkTimer.unref();
    // An agent that stays connected for days still gets the retry of a failed or stuck update.
    this.updateTimer = setInterval(
      () => {
        for (const id of this.conns.keys()) void this.offerUpdate(id, { periodic: true }).catch((err: unknown) => opts.log.warn({ err }, 'agent update offer failed'));
      },
      opts.updateCheckMs ?? 10 * 60_000,
    );
    this.updateTimer.unref();
  }

  get(runnerId: string): AgentConnection | undefined {
    return this.conns.get(runnerId);
  }

  isOnline(runnerId: string): boolean {
    return this.conns.has(runnerId);
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const token = bearer(req);
    // Requirement: Лимиты запросов — scenario «Перебор токенов агента»: 429 before the handshake.
    const ip = this.opts.trust ? clientIp(req, this.opts.trust) : (req.socket.remoteAddress ?? 'unknown');
    if (this.opts.badTokenLimiter?.blocked(ip)) {
      this.opts.log.warn({ ip }, 'rate limit: agent bad tokens');
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, ws => this.onConnection(ws, token, req, ip));
  }

  /** Closes the live connection of a runner whose token was reissued (scenario «Перевыпуск токена»). */
  revoke(runnerId: string): void {
    const c = this.conns.get(runnerId);
    if (c) {
      this.opts.log.info({ runnerId }, 'agent token reissued, closing connection');
      c.ws.close(CloseCode.InvalidToken, 'token revoked');
    }
  }

  /** Requirement: Отключение пользователя — every agent of the user is closed with 4401. */
  revokeUser(userId: string): number {
    let n = 0;
    for (const c of this.conns.values()) {
      if (c.userId === userId) {
        c.ws.close(CloseCode.InvalidToken, 'user disabled');
        n++;
      }
    }
    return n;
  }

  /**
   * Sends agent.update when the agent is older than the build and speaks 1.5 (AGENT_UPDATE_PROTOCOL, design M5; agents
   * of 1.3 and 1.4 keep working and never get it). `periodic` (the timer, same
   * connection): an offer already `sent`/`waiting` on this connection is not repeated — only retries and new builds.
   */
  async offerUpdate(runnerId: string, o: { periodic?: boolean } = {}): Promise<boolean> {
    const conn = this.conns.get(runnerId);
    const build = this.opts.latestAgent?.() ?? null;
    if (!conn || !build) return false;
    const r = await getRunner(this.opts.db, runnerId);
    if (!r?.agent_version || !protocolAtLeast(r.protocol_version, AGENT_UPDATE_PROTOCOL) || !versionLess(r.agent_version, build.version)) return false;
    // A failed update is not retried on every reconnect, an update in progress is not offered twice.
    if (updateOfferHeld(r.update_state, build.version, build.sha256)) return false;
    if (o.periodic && r.update_state?.version === build.version && (r.update_state.status === 'sent' || r.update_state.status === 'waiting')) return false;
    conn.send('agent.update', { version: build.version, sha256: build.sha256, url: build.url });
    await this.setUpdate(runnerId, { version: build.version, sha256: build.sha256, status: 'sent', error: null, at: new Date().toISOString() });
    this.opts.log.info({ runnerId, from: r.agent_version, to: build.version }, 'agent update offered');
    return true;
  }

  async close(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.checkTimer) clearInterval(this.checkTimer);
    if (this.updateTimer) clearInterval(this.updateTimer);
    for (const c of this.conns.values()) c.ws.close(1001, 'hub shutting down');
    await new Promise<void>(r => this.wss.close(() => r()));
  }

  private onConnection(ws: WebSocket, token: string | null, _req: IncomingMessage, ip: string): void {
    const log = this.opts.log;
    // Hold the first message (hello) until the token is checked. Anything more before that is a protocol
    // violation: the buffer stays bounded at one frame of at most PRE_HELLO_MAX_PAYLOAD.
    const early: RawData[] = [];
    let handler: ((data: RawData, isBinary?: boolean) => void) | null = null;
    ws.on('message', (data, isBinary) => {
      if (handler) return handler(data, isBinary);
      if (early.length >= 1) {
        ws.close(1008, 'hello expected once before authentication completes');
        return;
      }
      early.push(data);
    });
    ws.on('error', err => log.warn({ err: err.message, ip }, 'agent socket error'));

    void (async () => {
      const auth = token ? await findRunnerAuth(this.opts.db, token) : null;
      if (!auth) {
        // The token value is never logged.
        this.opts.badTokenLimiter?.hit(ip);
        log.warn({ ip, hadToken: token !== null }, 'agent rejected: invalid token');
        ws.close(CloseCode.InvalidToken, 'invalid token');
        return;
      }
      const { runner, next } = auth;
      const helloTimer = setTimeout(() => ws.close(1008, 'hello timeout'), this.helloTimeoutMs);
      let helloSeen = false;
      handler = (data, isBinary) => {
        if (!helloSeen) {
          helloSeen = true;
          clearTimeout(helloTimer);
          void this.onHello(ws, runner.id, runner.user_id, data, { ip, next }).catch((err: unknown) => {
            log.error({ err, runnerId: runner.id }, 'hello handling failed');
            ws.close(1011, 'internal error');
          });
          return;
        }
        // The connection is registered synchronously in onHello before welcome is sent.
        const conn = this.conns.get(runner.id);
        if (conn && conn.ws === ws) {
          if (isBinary) this.onBinary(conn, data);
          else this.onMessage(conn, data);
        }
      };
      ws.on('close', () => clearTimeout(helloTimer));
      for (const d of early.splice(0)) handler(d);
    })().catch((err: unknown) => {
      log.error({ err }, 'agent connection setup failed');
      ws.close(1011, 'internal error');
    });
  }

  private async onHello(ws: WebSocket, runnerId: string, userId: string, data: RawData, auth: { ip: string; next: boolean } = { ip: 'unknown', next: false }): Promise<void> {
    const log = this.opts.log.child({ runnerId });
    let raw: { type?: unknown; payload?: { protocol?: unknown } } | null;
    try {
      raw = JSON.parse(text(data));
    } catch {
      raw = null;
    }
    if (!raw || raw.type !== 'hello') {
      ws.close(1008, 'expected hello');
      return;
    }
    // The version is checked before strict validation: a 2.x agent may send a payload this hub cannot parse.
    const protocol = raw.payload?.protocol;
    if (!isCompatibleProtocol(protocol)) {
      const v = typeof protocol === 'string' ? protocol.slice(0, 20) : 'unknown';
      log.warn({ protocol: v }, 'agent rejected: incompatible protocol');
      await this.opts.db.updateTable('runners').set({ protocol_version: v, last_seen_at: new Date() }).where('id', '=', runnerId).execute();
      await this.emitStatus(runnerId);
      ws.close(CloseCode.IncompatibleVersion, `incompatible protocol ${v}; hub supports ${PROTOCOL_VERSION.split('.')[0]}.x`);
      return;
    }
    const parsed = parseAgentMessage(text(data));
    if (!parsed.ok || parsed.message.type !== 'hello') {
      log.warn({ reason: parsed.ok ? 'wrong type' : parsed.reason, error: parsed.ok ? undefined : parsed.error }, 'invalid hello');
      ws.close(1008, 'invalid hello');
      return;
    }
    if (ws.readyState !== ws.OPEN) return;
    const hello = parsed.message.payload;
    setMaxPayload(ws, WS_MAX_PAYLOAD);

    // Scenario «Второе соединение того же раннера»: the previous connection is closed with 4409.
    const prev = this.conns.get(runnerId);
    if (prev) {
      prev.replaced = true;
      prev.failAll('replaced');
      prev.ws.close(CloseCode.Replaced, 'replaced by a new connection');
      log.info('previous agent connection replaced');
    }
    const conn = new AgentConnection(runnerId, userId, ws, this.commandTimeoutMs);
    conn.capabilities = hello.capabilities ?? [];
    conn.ip = auth.ip;
    if (hello.clockMs !== undefined) conn.clockOffsetMs = Date.now() - hello.clockMs;
    this.conns.set(runnerId, conn);
    ws.on('close', () => void this.onClose(conn).catch((err: unknown) => log.error({ err }, 'agent close handling failed')));
    ws.on('pong', () => {
      conn.lastAliveAt = Date.now();
      void this.opts.db
        .updateTable('runners')
        .set({ last_seen_at: new Date() })
        .where('id', '=', runnerId)
        .execute()
        .catch(() => undefined);
    });

    await this.serial(runnerId, async () => {
      // The socket may have closed while the hello was being handled: never mark a closed connection online.
      const current = this.conns.get(runnerId) === conn;
      const base = {
        os: hello.os,
        home_dir: hello.homeDir,
        vault_root: hello.vaultRoot,
        agent_version: hello.agentVersion,
        sdk_version: hello.sdkVersion,
        claude_version: hello.claudeCodeVersion,
        protocol_version: hello.protocol,
        last_seen_at: new Date(),
        ...(current ? { online: true } : {}),
        // Change multi-user (M4): hello of 1.5; older agents leave the fields as they are.
        ...(hello.claude ? { claude_login: hello.claude.login } : {}),
        ...(hello.protectedDirs ? { protected_dirs_ok: hello.protectedDirs === 'n/a' ? null : hello.protectedDirs === 'ok' } : {}),
        ...(hello.arch ? { arch: hello.arch } : {}),
        ...(hello.root !== undefined ? { runs_as_root: hello.root } : {}),
        // agent-providers D3: an agent of 1.10 reports all its other providers (none — an empty list)
        ...(protocolAtLeast(hello.protocol, PROVIDERS_PROTOCOL) ? { providers: JSON.stringify(hello.providers ?? []) } : {}),
      };
      // A pending runner becomes active with its first hello; a disabled one never gets here (token refused).
      const activate = { state: 'active' as const };
      try {
        await this.opts.db
          .updateTable('runners')
          .set({ ...base, ...activate, hostname: hello.hostname })
          .where('id', '=', runnerId)
          .where('state', '<>', 'disabled')
          .execute();
      } catch (err) {
        // hostname is UNIQUE per owner: another runner of the user already claims it. Keep the connection, skip the hostname.
        log.error({ err: (err as Error).message, hostname: hello.hostname }, 'runner hostname conflict');
        await this.opts.db
          .updateTable('runners')
          .set({ ...base, ...activate })
          .where('id', '=', runnerId)
          .where('state', '<>', 'disabled')
          .execute();
      }
      if (!current) return;
      // The first connection with the token of a new enrollment: the old token stops working now (design M4).
      if (auth.next) await promoteNextToken(this.opts.db, runnerId);
      const capabilities = (hello.capabilities ?? []).filter(capability => HUB_CAPABILITIES.some(supported => supported === capability));
      conn.send('welcome', { runnerId, protocol: PROTOCOL_VERSION, cursors: await cursorsForRunner(this.opts.db, runnerId), ...(capabilities.length ? { capabilities } : {}) });
      log.info({ agentVersion: hello.agentVersion, hostname: hello.hostname, liveSessions: hello.liveSessions.length }, 'agent connected');
      await this.emitStatus(runnerId);
      this.opts.bus.emit('agent.hello', runnerId, userId, hello);
      // Change multi-user, after the MVP steps (their timing unchanged): the journal, the enrollment window, the update.
      void logSecurity(this.opts.db, { userId, kind: 'runner_connected', runnerId, ip: auth.ip }).catch((err: unknown) => log.warn({ err }, 'security log write failed'));
      await this.emitEnroll(runnerId, userId, hello.claude ? ['connected', 'claude_checked', 'ready'] : ['connected', 'ready']);
      // An update that brought the agent to the target version is done.
      const after = await getRunner(this.opts.db, runnerId);
      if (after?.update_state && after.agent_version && !versionLess(after.agent_version, after.update_state.version)) {
        await this.setUpdate(runnerId, null);
        await this.emitStatus(runnerId);
      }
      await this.offerUpdate(runnerId).catch((err: unknown) => log.warn({ err }, 'agent update offer failed'));
    });
  }

  /** Requirement: Окно подключения машины — stages of the latest used code, each once, to the owner's windows. */
  private async emitEnroll(runnerId: string, userId: string, stages: EnrollStage[]): Promise<void> {
    const passed = await advanceEnroll(this.opts.db, runnerId, stages);
    if (!passed.length) return;
    const r = await getRunner(this.opts.db, runnerId);
    if (!r) return;
    const view = toRunnerView(r, this.opts.latestAgent?.()?.version ?? null);
    for (const stage of passed) this.opts.bus.emit('runner.enroll', userId, runnerId, stage, view);
  }

  private async setUpdate(runnerId: string, state: RunnerUpdateState | null): Promise<void> {
    await this.opts.db
      .updateTable('runners')
      .set({ update_state: state ? JSON.stringify(state) : null })
      .where('id', '=', runnerId)
      .execute();
  }

  /** agent.status and agent.update.result (1.5): stored on the runner, shown in «Машины». */
  private async onRunnerReport(conn: AgentConnection, m: Extract<AgentMessage, { type: 'agent.status' | 'agent.update.result' }>): Promise<void> {
    if (m.type === 'agent.status') {
      const set = {
        ...(m.payload.claude ? { claude_login: m.payload.claude.login, claude_version: m.payload.claude.version } : {}),
        ...(m.payload.protectedDirs ? { protected_dirs_ok: m.payload.protectedDirs === 'n/a' ? null : m.payload.protectedDirs === 'ok' } : {}),
        ...(m.payload.providers ? { providers: JSON.stringify(m.payload.providers) } : {}),
      };
      if (Object.keys(set).length) await this.opts.db.updateTable('runners').set(set).where('id', '=', conn.runnerId).execute();
    } else {
      const p = m.payload;
      const runner = await getRunner(this.opts.db, conn.runnerId);
      const sha256 = runner?.update_state?.version === p.version ? runner.update_state.sha256 : undefined;
      await this.setUpdate(conn.runnerId, { version: p.version, ...(sha256 ? { sha256 } : {}), status: p.status, error: p.error ?? null, at: new Date().toISOString() });
      if (p.status === 'failed') this.opts.log.warn({ runnerId: conn.runnerId, version: p.version, error: p.error }, 'agent update failed');
    }
    await this.emitStatus(conn.runnerId);
  }

  private onBinary(conn: AgentConnection, data: RawData): void {
    conn.lastAliveAt = Date.now();
    const buf0 = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
    // A command answered with bytes (fs.read_image, D19): cmd.ok {binary: true} is followed by this frame.
    const cmd = conn.pendingCmdBinary;
    if (cmd) {
      conn.pendingCmdBinary = null;
      conn.settle(cmd.re, true, { result: { ...cmd.result, data: buf0 } });
      return;
    }
    const meta = conn.pendingSide;
    conn.pendingSide = null;
    if (!meta) return void this.opts.log.warn({ runnerId: conn.runnerId }, 'binary frame without side.file ignored');
    this.opts.bus.emit('agent.side', conn.runnerId, meta, buf0);
  }

  private onMessage(conn: AgentConnection, data: RawData): void {
    conn.lastAliveAt = Date.now();
    const raw = text(data);
    const parsed = parseAgentMessage(raw);
    if (!parsed.ok) {
      if (parsed.reason === 'unknown_type') this.opts.log.info({ runnerId: conn.runnerId, type: parsed.type }, 'unknown agent message type ignored');
      else if (shouldRedactInvalidMessage(parsed.type, raw)) {
        this.opts.log.warn({ runnerId: conn.runnerId, reason: parsed.reason, type: parsed.type, issuePaths: parsed.issuePaths ?? [] }, 'invalid agent message');
      } else {
        this.opts.log.warn({ runnerId: conn.runnerId, reason: parsed.reason, type: parsed.type, error: parsed.error }, 'invalid agent message');
      }
      return;
    }
    const m = parsed.message;
    const okResult = m.type === 'cmd.ok' ? (m.payload.result as { binary?: unknown } | undefined) : undefined;
    if (m.type === 'cmd.ok' && okResult && okResult.binary === true) conn.pendingCmdBinary = { re: m.re, result: okResult as Record<string, unknown> };
    else if (m.type === 'cmd.ok') conn.settle(m.re, true, m.payload);
    else if (m.type === 'cmd.error') conn.settle(m.re, false, m.payload);
    else if (m.type === 'side.file') conn.pendingSide = m.payload;
    else if (m.type === 'agent.status' || m.type === 'agent.update.result') {
      void this.serial(conn.runnerId, () => this.onRunnerReport(conn, m)).catch((err: unknown) => this.opts.log.warn({ err, runnerId: conn.runnerId }, 'runner report failed'));
    } else this.opts.bus.emit('agent.message', conn.runnerId, m);
  }

  private async onClose(conn: AgentConnection): Promise<void> {
    conn.failAll('connection closed');
    if (conn.replaced || this.conns.get(conn.runnerId) !== conn) return;
    this.conns.delete(conn.runnerId);
    await this.serial(conn.runnerId, async () => {
      // A newer connection may have registered meanwhile; it owns the online flag then.
      if (this.conns.has(conn.runnerId)) return;
      await this.opts.db.updateTable('runners').set({ online: false, last_seen_at: new Date() }).where('id', '=', conn.runnerId).execute();
      this.opts.log.info({ runnerId: conn.runnerId }, 'agent disconnected');
      void logSecurity(this.opts.db, { userId: conn.userId, kind: 'runner_disconnected', runnerId: conn.runnerId, ip: conn.ip }).catch(() => undefined);
      await this.emitStatus(conn.runnerId);
    });
  }

  /** Runs `fn` after every earlier queued step of this runner. */
  private serial(runnerId: string, fn: () => Promise<void>): Promise<void> {
    return this.queue.run(runnerId, fn);
  }

  private ping(): void {
    for (const conn of this.conns.values()) conn.ws.ping();
  }

  /** Drops connections silent for longer than heartbeatTimeoutMs (no pong, no message). */
  private checkAlive(): void {
    const now = Date.now();
    for (const conn of this.conns.values()) {
      if (now - conn.lastAliveAt > this.heartbeatTimeoutMs) {
        this.opts.log.warn({ runnerId: conn.runnerId, silentMs: now - conn.lastAliveAt }, 'agent heartbeat timeout');
        conn.ws.terminate();
      }
    }
  }

  private async emitStatus(runnerId: string): Promise<void> {
    const r = await getRunner(this.opts.db, runnerId);
    if (r) this.opts.bus.emit('runner.status', r.user_id, toRunnerView(r, this.opts.latestAgent?.()?.version ?? null));
  }
}
