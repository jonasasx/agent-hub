import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { URL } from 'node:url';
// Runs `.cmd` shims on Windows with escaped arguments, the way Claude Code does; Node's spawn without a shell refuses them.
import crossSpawn from 'cross-spawn';
import { resolveCommand } from './command.js';
import type { Logger } from '../log.js';
import type { RegistrySnapshot } from './registryCache.js';
import type { PayloadOf } from '@agent-hub/shared';
import type { HubMessage } from '@agent-hub/shared';

interface GatewayLimits {
  maxProcesses: number;
  maxSessions: number;
  maxPending: number;
  maxPerServerSessions: number;
  idleMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  backoffWindowMs: number;
  maxRestarts: number;
  healthyResetMs: number;
  requestTimeoutMs?: number;
}
const DEFAULT_LIMITS: GatewayLimits = {
  maxProcesses: 8,
  maxSessions: 64,
  maxPending: 256,
  maxPerServerSessions: 4,
  idleMs: 60_000,
  backoffBaseMs: 1000,
  backoffMaxMs: 30_000,
  backoffWindowMs: 5 * 60_000,
  maxRestarts: 5,
  healthyResetMs: 10 * 60_000,
};
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'authorization', 'x-agent-session']);
const RESPONSE_BODY_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding']);
type ServerConfig = RegistrySnapshot['servers'][number];
type RpcMessage = { id?: string | number; method?: string; params?: unknown; [k: string]: unknown };
/**
 * MCP revisions a stdio process cannot mix: one connection either takes the initialize handshake (up to 2025-11-25)
 * or serves the stateless revision 2026-07-28 without it, and rejects the other kind of client with -32022.
 */
type ProtocolFamily = 'legacy' | 'stateless';
const STATELESS_PROTOCOL_VERSION = '2026-07-28';

// Streamable HTTP servers may answer a request with an SSE stream instead of a JSON body; the stream may stay open after the response.
async function readRpcResponse(res: Response, id: number): Promise<Record<string, unknown>> {
  if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) return (await res.json()) as Record<string, unknown>;
  if (!res.body) throw new Error('MCP server returned an empty event stream');
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
      const data = event
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      const message = JSON.parse(data) as Record<string, unknown>;
      if (message.id !== id) continue;
      await res.body.cancel().catch(() => undefined);
      return message;
    }
  }
  throw new Error('MCP server closed the event stream without a response');
}
interface ProcessEntry {
  child: ChildProcess;
  serverId: string;
  serverName: string;
  family: ProtocolFamily;
  started: Promise<void>;
  exited: boolean;
  exitCode: number | null;
  exitReason?: string;
  buffers: Buffer;
  pending: Map<string, PendingRequest>;
  sessions: Map<string, string>;
  managedSessions: Set<string>;
  streams: Map<string, ServerResponse>;
  timer?: NodeJS.Timeout;
  healthyTimer?: NodeJS.Timeout;
  stopping: boolean;
  /** Counted against maxProcesses: per-session and validation processes. A machine-shared server has one process per protocol family at most. */
  capped: boolean;
}

interface StartGenerationState {
  generation: number;
  activeStarts: number;
}

interface PendingRequest {
  session: string;
  response: ServerResponse;
  originalId: string | number;
  method?: string;
  timer?: NodeJS.Timeout;
}

interface PendingSecretDelivery {
  revision: number;
  values: Array<{ name: string; value: string }>;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

const PENDING_SECRET_TTL_MS = 60_000;
const GATEWAY_ERROR_HEADER = 'x-agent-hub-error';

class McpUnauthorizedError extends Error {}
class McpNeedsSecretError extends Error {}

/** Loopback Streamable HTTP endpoint and lazy stdio process supervisor. */
export class McpGateway {
  private server: Server | null = null;
  private endpoint = '';
  private entries = new Map<string, ProcessEntry>();
  private tokens = new Map<string, Map<string, string>>();
  private sessionGenerations = new Map<string, StartGenerationState>();
  private sessionServerGenerations = new Map<string, StartGenerationState>();
  /** Protocol family of a session's MCP clients per server, for requests that do not name a revision (GET streams, notifications). */
  private clientFamilies = new Map<string, ProtocolFamily>();
  private config = new Map<string, ServerConfig>();
  private secretValues = new Map<string, Map<string, string>>();
  private validationConfigs = new Map<string, ServerConfig>();
  private validationSecrets = new Map<string, Map<string, string>>();
  private validationOrigins = new Map<string, string>();
  private validationChildren = new Map<string, ChildProcess>();
  private pendingSecretDeliveries = new Map<string, PendingSecretDelivery>();
  private registryEnabled: boolean | null = null;
  private restartHistory = new Map<string, number[]>();
  private retryTimers = new Map<string, NodeJS.Timeout>();
  private retryAfter = new Map<string, number>();
  private unavailableExecutables = new Map<string, number>();
  private oauthAccess: ((serverId: string) => Promise<string | null>) | null = null;
  private oauthRefresh: ((serverId: string) => Promise<string | null>) | null = null;
  constructor(
    private readonly log: Logger,
    private readonly emitStatus: (payload: unknown) => void = () => undefined,
    private readonly limits: GatewayLimits = DEFAULT_LIMITS,
  ) {}
  async start(): Promise<void> {
    if (this.server) return;
    const s = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => resolve());
    });
    const address = s.address();
    if (!address || typeof address === 'string') throw new Error('gateway failed to bind loopback');
    this.server = s;
    this.endpoint = `http://127.0.0.1:${address.port}/mcp`;
  }
  get url(): string {
    return this.endpoint;
  }
  setRegistry(snapshot: RegistrySnapshot): void {
    this.registryEnabled = snapshot.registryEnabled !== false;
    const next = new Map(snapshot.servers.map(x => [x.id, x]));
    if (snapshot.registryEnabled === false) {
      for (const pending of this.pendingSecretDeliveries.values()) clearTimeout(pending.timer);
      this.pendingSecretDeliveries.clear();
    }
    for (const [id, old] of this.config)
      if (next.get(id)?.revision !== old.revision) {
        this.secretValues.delete(id);
        this.clearRetries(id);
        this.stopProcesses(id);
        if (!next.has(id)) this.tokens.delete(id);
      }
    this.config = next;
    for (const [id, delivery] of this.pendingSecretDeliveries) {
      clearTimeout(delivery.timer);
      const server = next.get(id);
      if (!server || server.revision > delivery.revision) {
        this.pendingSecretDeliveries.delete(id);
      } else if (server.revision === delivery.revision) {
        this.secretValues.set(id, new Map(delivery.values.map(value => [value.name, value.value])));
        this.pendingSecretDeliveries.delete(id);
      } else {
        this.armPendingDelivery(id, delivery);
      }
    }
  }
  setServerConfig(server: ServerConfig): void {
    const old = this.config.get(server.id);
    if (old && old.revision !== server.revision) {
      this.secretValues.delete(server.id);
      this.clearRetries(server.id);
      this.stopProcesses(server.id);
    }
    this.config.set(server.id, server);
  }
  setSecretDelivery(serverId: string, revision: number, values: Array<{ name: string; value: string }>): boolean {
    if (this.registryEnabled === false) return false;
    const current = this.config.get(serverId);
    if (!current || current.revision < revision) {
      const pending = this.pendingSecretDeliveries.get(serverId);
      if (pending && pending.revision > revision) return false;
      if (pending) clearTimeout(pending.timer);
      const delivery: PendingSecretDelivery = {
        revision,
        values,
        expiresAt: Date.now() + PENDING_SECRET_TTL_MS,
        timer: setTimeout(() => this.expirePendingDelivery(serverId, delivery), PENDING_SECRET_TTL_MS),
      };
      delivery.timer.unref();
      this.pendingSecretDeliveries.set(serverId, delivery);
      return true;
    }
    if (current.revision !== revision) return false;
    this.secretValues.set(serverId, new Map(values.map(x => [x.name, x.value])));
    return true;
  }
  setOAuthAccess(handler: (serverId: string) => Promise<string | null>): void {
    this.oauthAccess = handler;
  }
  setOAuthRefresh(handler: (serverId: string) => Promise<string | null>): void {
    this.oauthRefresh = handler;
  }
  async validate(payload: PayloadOf<HubMessage, 'mcp.registry.validate'>): Promise<{
    ok: boolean;
    status: 'checked' | 'validation-failed' | 'needs-secret' | 'needs_auth';
    tools: Array<{ name: string; description?: string }>;
    error?: string;
    oauthRequired: boolean;
  }> {
    const validationId = randomUUID();
    const candidate = { ...payload.server, id: validationId, mode: 'per-session' as const };
    this.validationConfigs.set(validationId, candidate);
    this.validationOrigins.set(validationId, payload.oauthServerId ?? payload.server.id);
    if (payload.secretDelivery && payload.secretDelivery.serverId === payload.server.id && payload.secretDelivery.revision === payload.revision) {
      this.validationSecrets.set(validationId, new Map(payload.secretDelivery.secrets.map(secret => [secret.name, secret.value])));
    }
    const sessionId = randomUUID(),
      bearer = this.authorize(candidate.id, sessionId);
    let mcpSession: string | null = null;
    const post = (message: Record<string, unknown>) =>
      fetch(`${this.endpoint}?server=${encodeURIComponent(candidate.id)}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearer}`,
          'x-agent-session': sessionId,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-03-26',
          ...(mcpSession ? { 'mcp-session-id': mcpSession } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', ...message }),
        signal: AbortSignal.timeout(30_000),
      });
    const call = async (id: number, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const res = await post({ id, method, params });
      if (!res.ok) {
        const gatewayError = res.headers.get(GATEWAY_ERROR_HEADER);
        const body = await res.text().catch(() => '');
        if (gatewayError === 'needs-secret') {
          throw new McpNeedsSecretError('MCP server needs secret');
        }
        let detail = body;
        try {
          const parsed = JSON.parse(body) as { error?: unknown };
          if (typeof parsed.error === 'string') detail = parsed.error;
        } catch {
          // Keep plain-text gateway errors readable.
        }
        detail = detail ? this.redactText(candidate.id, detail).slice(0, 300) : '';
        if (res.status === 401) throw new McpUnauthorizedError('MCP server requires authorization');
        throw new Error(`MCP server returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
      }
      mcpSession = res.headers.get('mcp-session-id') ?? mcpSession;
      const result = await readRpcResponse(res, id);
      if (result.error) throw new Error(typeof (result.error as { message?: unknown }).message === 'string' ? (result.error as { message: string }).message : 'MCP request failed');
      return result;
    };
    try {
      await call(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'agent-hub-validator', version: '1.0.0' } });
      await post({ method: 'notifications/initialized' }).then(res => res.body?.cancel());
      const listed = await call(2, 'tools/list', {}),
        result = listed.result as { tools?: Array<{ name?: unknown; description?: unknown }> } | undefined;
      const tools = (Array.isArray(result?.tools) ? result.tools : []).flatMap(t =>
        typeof t.name === 'string' ? [{ name: t.name, ...(typeof t.description === 'string' ? { description: t.description.slice(0, 2000) } : {}) }] : [],
      );
      return { ok: true, status: 'checked', tools, oauthRequired: false };
    } catch (error) {
      if (error instanceof McpUnauthorizedError) {
        return { ok: false, status: 'needs_auth', tools: [], error: error.message, oauthRequired: true };
      }
      if (error instanceof McpNeedsSecretError) {
        return { ok: false, status: 'needs-secret', tools: [], error: error.message, oauthRequired: false };
      }
      const safe = this.redactText(candidate.id, error instanceof Error ? error.message : 'MCP validation failed').slice(0, 500);
      return { ok: false, status: 'validation-failed', tools: [], error: safe, oauthRequired: false };
    } finally {
      this.revoke(candidate.id, sessionId);
      for (const [key, entry] of this.entries)
        if (key.startsWith(`${candidate.id}:`)) {
          if (entry.timer) clearTimeout(entry.timer);
          this.kill(entry);
          this.entries.delete(key);
        }
      this.validationConfigs.delete(candidate.id);
      const child = this.validationChildren.get(candidate.id);
      if (child) {
        const cleanup = () => this.clearValidationState(candidate.id);
        const cleanupTimer = setTimeout(cleanup, 10_000);
        cleanupTimer.unref();
        child.once('close', () => {
          clearTimeout(cleanupTimer);
          cleanup();
        });
      } else {
        this.clearValidationState(candidate.id);
      }
    }
  }
  authorize(serverId: string, sessionId: string): string {
    let bySession = this.tokens.get(serverId);
    if (!bySession) this.tokens.set(serverId, (bySession = new Map()));
    const token = randomUUID() + randomUUID();
    bySession.set(sessionId, token);
    return token;
  }
  async startManaged(serverId: string, sessionId: string, bearer: string): Promise<string> {
    if (!/^[\x21-\x7e]{32,512}$/.test(bearer)) throw new Error('invalid gateway bearer token');
    const cfg = this.config.get(serverId);
    if (!cfg || !cfg.enabled) throw new Error('MCP server is not enabled in the registry');
    const startingRevision = cfg.revision;
    const pairKey = this.sessionServerKey(serverId, sessionId);
    const sessionState = this.beginStart(this.sessionGenerations, sessionId);
    const pairState = this.beginStart(this.sessionServerGenerations, pairKey);
    const sessionGeneration = sessionState.generation;
    const pairGeneration = pairState.generation;
    let startedEntry: ProcessEntry | undefined;
    try {
      // Started ahead of the first client: in the family this session's clients used before, the handshake one otherwise.
      if (cfg.transport === 'stdio') startedEntry = await this.process(cfg, sessionId, this.clientFamilies.get(pairKey) ?? 'legacy');
      if (startedEntry) {
        startedEntry.managedSessions.add(sessionId);
        this.clearIdle(startedEntry);
      }
      if (sessionState.generation !== sessionGeneration || pairState.generation !== pairGeneration) {
        if (startedEntry) this.releaseManagedSession(serverId, sessionId, startedEntry, startingRevision);
        throw new Error('MCP session closed while its server was starting');
      }
      if (this.config.get(serverId)?.revision !== startingRevision || !this.config.get(serverId)?.enabled) {
        this.stopProcessesForRevision(serverId, startingRevision);
        this.emitStatus({ serverId, revision: startingRevision, status: 'stopped', observedAt: Date.now() });
        throw new Error('MCP server configuration changed while starting');
      }
      if (cfg.transport !== 'stdio') this.emitStatus({ serverId, revision: startingRevision, status: 'ready', endpoint: this.endpoint, observedAt: Date.now() });
      let bySession = this.tokens.get(serverId);
      if (!bySession) this.tokens.set(serverId, (bySession = new Map()));
      bySession.set(sessionId, bearer);
      return this.endpoint;
    } finally {
      this.endStart(this.sessionGenerations, sessionId, sessionState);
      this.endStart(this.sessionServerGenerations, pairKey, pairState);
    }
  }
  managedBearer(serverId: string, sessionId: string): string | undefined {
    return this.tokens.get(serverId)?.get(sessionId);
  }
  stopManaged(serverId: string, sessionId: string): void {
    this.revoke(serverId, sessionId);
  }
  stopTimedOutStart(serverId: string, sessionId: string, revision?: number, bearer?: string, previousBearer?: string): void {
    const bySession = this.tokens.get(serverId);
    if (bearer && bySession?.get(sessionId) !== bearer) return;
    if (previousBearer) {
      bySession?.set(sessionId, previousBearer);
      return;
    }
    bySession?.delete(sessionId);
    let stopped = false;
    for (const [key, entry] of this.entries) {
      if (!this.matchesTimedOutProcess(key, serverId, sessionId, revision)) continue;
      entry.sessions.delete(sessionId);
      entry.managedSessions.delete(sessionId);
      if (entry.sessions.size || entry.managedSessions.size) continue;
      this.clearIdle(entry);
      this.kill(entry);
      this.entries.delete(key);
      stopped = true;
    }
    const stillRunning = [...this.entries.keys()].some(key => this.matchesServerRevision(key, serverId, revision));
    if (stopped && !stillRunning) this.emitStatus({ serverId, ...(revision === undefined ? {} : { revision }), status: 'stopped', observedAt: Date.now() });
  }
  stopServer(serverId: string): void {
    this.clearRetries(serverId);
    this.tokens.delete(serverId);
    this.stopProcesses(serverId);
    this.emitStatus({ serverId, status: 'stopped', observedAt: Date.now() });
  }
  private stopProcesses(serverId: string): void {
    for (const [key, e] of this.entries)
      if (key === serverId || key.startsWith(`${serverId}:`)) {
        this.kill(e);
        this.entries.delete(key);
      }
  }
  private stopProcessesForRevision(serverId: string, revision: number): void {
    const prefix = `${serverId}:${revision}`;
    for (const [key, entry] of this.entries) {
      if (key === prefix || key.startsWith(`${prefix}:`)) {
        this.kill(entry);
        this.entries.delete(key);
      }
    }
  }
  private releaseManagedSession(serverId: string, sessionId: string, entry: ProcessEntry, revision: number): void {
    entry.managedSessions.delete(sessionId);
    entry.sessions.delete(sessionId);
    if (entry.sessions.size || entry.managedSessions.size) return;
    for (const [key, current] of this.entries) {
      if (current !== entry) continue;
      this.clearIdle(entry);
      this.kill(entry);
      this.entries.delete(key);
      const stillRunning = [...this.entries.keys()].some(currentKey => this.matchesServerRevision(currentKey, serverId, revision));
      if (!stillRunning) this.emitStatus({ serverId, revision, status: 'stopped', observedAt: Date.now() });
      return;
    }
  }
  private matchesServerRevision(key: string, serverId: string, revision?: number): boolean {
    if (revision === undefined) return key === serverId || key.startsWith(`${serverId}:`);
    const prefix = `${serverId}:${revision}`;
    return key === prefix || key.startsWith(`${prefix}:`);
  }
  private matchesTimedOutProcess(key: string, serverId: string, sessionId: string, revision?: number): boolean {
    const server = this.config.get(serverId);
    if (server?.mode === 'per-session') {
      if (revision !== undefined) return key === `${serverId}:${revision}:${sessionId}` || key === `${serverId}:${revision}:@stateless:${sessionId}`;
      return key.startsWith(`${serverId}:`) && key.endsWith(`:${sessionId}`);
    }
    return this.matchesServerRevision(key, serverId, revision);
  }
  private sessionServerKey(serverId: string, sessionId: string): string {
    return `${serverId}\0${sessionId}`;
  }
  private beginStart(states: Map<string, StartGenerationState>, key: string): StartGenerationState {
    let state = states.get(key);
    if (!state) {
      state = { generation: 0, activeStarts: 0 };
      states.set(key, state);
    }
    state.activeStarts += 1;
    return state;
  }
  private endStart(states: Map<string, StartGenerationState>, key: string, state: StartGenerationState): void {
    state.activeStarts -= 1;
    if (state.activeStarts === 0 && states.get(key) === state) states.delete(key);
  }
  private invalidateStart(states: Map<string, StartGenerationState>, key: string): void {
    const state = states.get(key);
    if (!state) return;
    state.generation += 1;
    if (state.activeStarts === 0) states.delete(key);
  }
  revoke(serverId: string, sessionId: string): void {
    const pairKey = this.sessionServerKey(serverId, sessionId);
    this.invalidateStart(this.sessionServerGenerations, pairKey);
    this.tokens.get(serverId)?.delete(sessionId);
    this.clientFamilies.delete(pairKey);
    for (const [key, e] of this.entries)
      if (key === serverId || key.startsWith(`${serverId}:`)) {
        e.sessions.delete(sessionId);
        e.managedSessions.delete(sessionId);
        if (!e.sessions.size && !e.managedSessions.size) this.armIdle(key, serverId, e);
      }
  }
  private armIdle(key: string, serverId: string, e: ProcessEntry): void {
    this.clearIdle(e);
    e.timer = setTimeout(() => {
      this.expireIdle(key, serverId, e);
    }, this.limits.idleMs);
    e.timer.unref();
  }
  revokeSession(sessionId: string): void {
    this.invalidateStart(this.sessionGenerations, sessionId);
    const serverIds = new Set([...this.tokens.keys(), ...[...this.entries.keys()].map(key => key.split(':', 1)[0] ?? key)]);
    for (const serverId of serverIds) this.revoke(serverId, sessionId);
  }
  async stop(): Promise<void> {
    for (const serverId of this.config.keys()) this.clearRetries(serverId);
    for (const e of this.entries.values()) this.kill(e);
    this.entries.clear();
    this.clientFamilies.clear();
    this.secretValues.clear();
    this.validationConfigs.clear();
    this.validationSecrets.clear();
    this.validationOrigins.clear();
    this.validationChildren.clear();
    for (const pending of this.pendingSecretDeliveries.values()) clearTimeout(pending.timer);
    this.pendingSecretDeliveries.clear();
    if (this.server) await new Promise<void>(r => this.server!.close(() => r()));
    this.server = null;
    this.endpoint = '';
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.endpoint || 'http://127.0.0.1');
    const id = url.searchParams.get('server');
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(204).end();
      return;
    }
    if (!id || !['POST', 'GET', 'DELETE'].includes(req.method ?? '') || url.pathname !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    const session = req.headers['mcp-session-id'];
    const sessionHeader = req.headers['x-agent-session'];
    const sid = typeof sessionHeader === 'string' ? sessionHeader : typeof session === 'string' ? session : '';
    const authHeader = req.headers.authorization;
    const token = (typeof authHeader === 'string' ? authHeader : '').replace(/^Bearer\s+/i, '');
    const expected = this.tokens.get(id)?.get(sid);
    if (!expected || !token || token.length !== expected.length || !timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
      res.writeHead(401, { 'www-authenticate': 'Bearer' }).end();
      return;
    }
    const cfg = this.validationConfigs.get(id) ?? this.config.get(id);
    if (!cfg || !cfg.enabled) {
      res.writeHead(404).end();
      return;
    }
    if (!this.hasRequiredSecrets(cfg)) {
      this.reportStatus(cfg.id, { serverId: cfg.id, status: 'needs-secret', observedAt: Date.now() });
      res
        .writeHead(503, {
          'content-type': 'text/plain; charset=utf-8',
          [GATEWAY_ERROR_HEADER]: 'needs-secret',
        })
        .end(`MCP server ${cfg.name} needs secret`);
      return;
    }
    if (cfg.transport === 'http' || cfg.transport === 'sse') {
      await this.remote(req, res, cfg);
      return;
    }
    if (req.method === 'DELETE') {
      // One hub session can open several MCP clients (Codex replaces its startup client), so closing one must not revoke the session's bearer or stop the process.
      // Access ends with the hub session: revokeSession on exit.
      for (const [key, entry] of this.entries)
        if (key === id || key.startsWith(`${id}:`)) {
          entry.streams.get(sid)?.end();
          entry.streams.delete(sid);
        }
      res.writeHead(200).end();
      return;
    }
    try {
      const rpc = req.method === 'POST' ? (JSON.parse((await readBody(req)).toString('utf8')) as RpcMessage) : undefined;
      const entry = await this.process(cfg, sid, this.clientFamily(cfg.id, sid, req, rpc));
      this.clearIdle(entry);
      this.adoptManagedSession(cfg.id, sid, entry);
      if (!entry.sessions.has(sid) && entry.sessions.size >= this.limits.maxSessions) {
        res.writeHead(503).end('MCP client session limit reached');
        return;
      }
      if (entry.pending.size >= this.limits.maxPending) {
        res.writeHead(503).end('MCP request limit reached');
        return;
      }
      if (req.method === 'GET') {
        entry.sessions.set(sid, sid);
        entry.streams.get(sid)?.end();
        entry.streams.set(sid, res);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': connected\n\n');
        res.on('close', () => {
          if (entry!.streams.get(sid) === res) entry!.streams.delete(sid);
        });
        return;
      }
      if (!rpc) throw new Error('MCP request has no body');
      if (entry.exited) throw this.processExitError(entry);
      const originalId = rpc.id;
      // Unique per HTTP request: several MCP clients of one hub session (Codex opens a startup client and a session client at once) number their requests from 0.
      const backendId = `${sid}:${randomUUID()}`;
      if (originalId !== undefined) {
        const pending: PendingRequest = { session: sid, response: res, originalId, ...(typeof rpc.method === 'string' ? { method: rpc.method } : {}) };
        const timeoutMs = this.limits.requestTimeoutMs ?? 30_000;
        pending.timer = setTimeout(() => {
          entry!.pending.delete(backendId);
          if (!res.headersSent && !res.destroyed) res.writeHead(504, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'MCP request timed out' }));
        }, timeoutMs);
        pending.timer.unref();
        entry.pending.set(backendId, pending);
      }
      entry.sessions.set(sid, backendId);
      if (originalId !== undefined) rpc.id = backendId;
      entry.child.stdin?.write(`${JSON.stringify(rpc)}\n`);
      if (originalId === undefined) {
        res.writeHead(202).end();
      }
    } catch (e) {
      this.safeError(res, new Error(this.redactText(cfg.id, e instanceof Error ? e.message : 'MCP gateway request failed')));
    }
  }
  private async remote(req: IncomingMessage, res: ServerResponse, cfg: ServerConfig): Promise<void> {
    const headers = new Headers();
    const connectionHeaders = new Set(
      (req.headers.connection ?? '')
        .split(',')
        .map((x: string) => x.trim().toLowerCase())
        .filter(Boolean),
    );
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k.toLowerCase()) && !connectionHeaders.has(k.toLowerCase()) && v) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    for (const [k, v] of Object.entries(cfg.headers ?? {})) {
      if (v.kind === 'literal') headers.set(k, v.value);
      else {
        const ref = cfg.secrets.find(x => x.secretId === v.secretId);
        const value = ref && this.secretMap(cfg.id)?.get(ref.name);
        if (value) headers.set(k, value);
      }
    }
    try {
      const target = new URL(cfg.url!);
      if (decodeURIComponent(target.username) === '__AGENT_HUB_SECRET__') {
        const ref = cfg.secrets.find(x => x.name === 'url:username'),
          secret = ref && this.secretMap(cfg.id)?.get(ref.name);
        if (!secret) {
          res.writeHead(424, { 'content-type': 'application/json', [GATEWAY_ERROR_HEADER]: 'needs-secret' }).end(JSON.stringify({ error: 'MCP server needs a configured secret' }));
          return;
        }
        target.username = secret;
      }
      if (decodeURIComponent(target.password) === '__AGENT_HUB_SECRET__') {
        const ref = cfg.secrets.find(x => x.name === 'url:password'),
          secret = ref && this.secretMap(cfg.id)?.get(ref.name);
        if (!secret) {
          res.writeHead(424, { 'content-type': 'application/json', [GATEWAY_ERROR_HEADER]: 'needs-secret' }).end(JSON.stringify({ error: 'MCP server needs a configured secret' }));
          return;
        }
        target.password = secret;
      }
      for (const [key, value] of target.searchParams)
        if (value === '__AGENT_HUB_SECRET__') {
          const ref = cfg.secrets.find(x => x.name === `url:${key}`),
            secret = ref && this.secretMap(cfg.id)?.get(ref.name);
          if (!secret) {
            res.writeHead(424, { 'content-type': 'application/json', [GATEWAY_ERROR_HEADER]: 'needs-secret' }).end(JSON.stringify({ error: 'MCP server needs a configured secret' }));
            return;
          }
          target.searchParams.set(key, secret);
        }
      const method = req.method === 'GET' ? 'GET' : req.method === 'DELETE' ? 'DELETE' : 'POST';
      const body = method === 'POST' ? await readBody(req) : undefined;
      const oauthServerId = this.validationOrigins.get(cfg.id) ?? cfg.id;
      // A server waiting for its first validation is not in the machine's registry yet: validation takes the URL the hub sent.
      const registeredOrigin = this.registeredOrigin(oauthServerId) ?? this.validationOrigin(cfg.id, oauthServerId);
      const token = registeredOrigin === target.origin ? await this.oauthAccess?.(oauthServerId) : null;
      if (token) headers.set('authorization', `Bearer ${token}`);
      // A client that hangs up must not leave the upstream request (an open SSE stream) running.
      const upstream = new AbortController();
      res.once('close', () => upstream.abort());
      const request = () => fetch(target, { method, headers, ...(body ? { body } : {}), redirect: 'manual', signal: upstream.signal });
      let response = await request();
      if (token && response.status === 401 && this.oauthRefresh) {
        const token = await this.oauthRefresh(oauthServerId);
        if (token) {
          headers.set('authorization', `Bearer ${token}`);
          response = await request();
        }
      }
      const out: Record<string, string> = {};
      response.headers.forEach((v, k) => {
        if (k.toLowerCase() !== GATEWAY_ERROR_HEADER && !HOP.has(k.toLowerCase()) && !RESPONSE_BODY_HEADERS.has(k.toLowerCase())) out[k] = v;
      });
      res.writeHead(response.status, out);
      if (response.body)
        for await (const chunk of response.body) {
          if (!res.write(Buffer.from(chunk)))
            await new Promise<void>((resolve, reject) => {
              res.once('drain', resolve);
              res.once('error', reject);
            });
        }
      res.end();
    } catch (e) {
      this.safeError(res, new Error(this.redactText(cfg.id, e instanceof Error ? e.message : 'MCP proxy request failed')));
    }
  }
  /**
   * Protocol family of a request: `initialize` is the handshake revision; otherwise the `MCP-Protocol-Version` header or the
   * protocol version in `params._meta`; a request without either takes the family the session's client used last, the handshake one at first.
   */
  private clientFamily(serverId: string, sid: string, req: IncomingMessage, rpc: RpcMessage | undefined): ProtocolFamily {
    const key = this.sessionServerKey(serverId, sid);
    const header = req.headers['mcp-protocol-version'];
    const version = typeof header === 'string' && header ? header : rpc && requestedProtocolVersion(rpc);
    const family: ProtocolFamily = rpc?.method === 'initialize' ? 'legacy' : version ? protocolFamily(version) : (this.clientFamilies.get(key) ?? 'legacy');
    this.clientFamilies.set(key, family);
    return family;
  }
  /** A managed session belongs to the process its clients talk to: the process started ahead in the other protocol family is released. */
  private adoptManagedSession(serverId: string, sid: string, entry: ProcessEntry): void {
    if (entry.managedSessions.has(sid)) return;
    let managed = false;
    for (const [key, other] of this.entries) {
      if (other === entry || !other.managedSessions.has(sid) || !this.matchesServerRevision(key, serverId)) continue;
      other.managedSessions.delete(sid);
      managed = true;
      if (!other.sessions.size && !other.managedSessions.size) this.armIdle(key, serverId, other);
    }
    if (managed) entry.managedSessions.add(sid);
  }
  private async process(cfg: ServerConfig, session: string, family: ProtocolFamily = 'legacy'): Promise<ProcessEntry> {
    const key = this.processKey(cfg, session, family);
    let entry = this.entries.get(key);
    if (entry) {
      await entry.started;
      if (entry.exited) throw this.processExitError(entry);
      return entry;
    }
    if (this.unavailableExecutables.get(key) === cfg.revision) throw new Error('MCP server executable is unavailable; check the command and runtime installation');
    const now = Date.now();
    if ((this.retryAfter.get(key) ?? 0) > now) throw new Error('MCP server is in restart backoff; retry shortly');
    const history = (this.restartHistory.get(key) ?? []).filter(at => now - at < this.limits.backoffWindowMs);
    this.restartHistory.set(key, history);
    if (history.length >= this.limits.maxRestarts) throw new Error('MCP server restart limit reached; retry later');
    if (cfg.mode === 'per-session' && [...this.entries.keys()].filter(k => k.startsWith(`${cfg.id}:${cfg.revision}:`)).length >= this.limits.maxPerServerSessions)
      throw new Error('MCP per-session process limit reached for this server');
    const capped = cfg.mode !== 'machine-shared' || this.validationOrigins.has(cfg.id);
    if (capped && [...this.entries.values()].filter(e => e.capped).length >= this.limits.maxProcesses) throw new Error('MCP process limit reached; stop an unused server and retry');
    if (!this.hasRequiredSecrets(cfg)) {
      this.reportStatus(cfg.id, { serverId: cfg.id, status: 'needs-secret', observedAt: Date.now() });
      throw new Error('MCP server needs a configured secret');
    }
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfg.env ?? {})) {
      if (v.kind === 'literal') childEnv[k] = v.value;
      else {
        const ref = cfg.secrets.find(x => x.secretId === v.secretId);
        const value = ref && this.secretMap(cfg.id)?.get(ref.name);
        if (value) childEnv[k] = value;
      }
    }
    const env = { ...process.env, ...childEnv };
    const options = { stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], windowsHide: true, env };
    const file = resolveCommand(cfg.command!, env);
    // An unresolved command goes to Node's spawn as is: it fails at once with ENOENT, not later through cmd.exe.
    const child = file ? crossSpawn(file, cfg.args ?? [], options) : spawn(cfg.command!, cfg.args ?? [], { ...options, shell: false });
    let resolveStarted!: () => void;
    let rejectStarted!: (error: Error) => void;
    const started = new Promise<void>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    if (this.validationOrigins.has(cfg.id)) {
      this.validationChildren.set(cfg.id, child);
      child.once('close', () => this.clearValidationState(cfg.id));
    }
    entry = {
      child,
      serverId: cfg.id,
      serverName: cfg.name,
      family,
      started,
      exited: false,
      exitCode: null,
      buffers: Buffer.alloc(0),
      pending: new Map(),
      sessions: new Map(),
      managedSessions: new Set(),
      streams: new Map(),
      stopping: false,
      capped,
    };
    this.entries.set(key, entry);
    child.stdout?.on('data', (chunk: Buffer) => this.lines(entry!, chunk));
    child.once('spawn', () => {
      resolveStarted();
      this.reportStatus(cfg.id, { serverId: cfg.id, status: 'ready', endpoint: this.endpoint, observedAt: Date.now() });
      entry!.healthyTimer = setTimeout(() => this.restartHistory.delete(key), this.limits.healthyResetMs);
      entry!.healthyTimer.unref();
    });
    child.stderr?.on('data', (chunk: Buffer) => this.log.warn('MCP server stderr', { server: cfg.name, text: this.redactText(cfg.id, chunk.toString()).slice(0, 1000) }));
    child.on('error', err => {
      const e = err as NodeJS.ErrnoException;
      const reason = e.code === 'ENOENT' ? `command not found: ${cfg.command}` : 'MCP server failed to start';
      entry!.exited = true;
      entry!.exitReason = reason;
      rejectStarted(new Error(reason));
      this.fail(entry!, key, cfg.id, this.redactText(cfg.id, reason), e.code === 'ENOENT');
    });
    child.on('exit', code => {
      entry!.exited = true;
      entry!.exitCode = code;
      entry!.exitReason ??= this.processExitError(entry!).message;
      if (entry!.child.pid === undefined) rejectStarted(this.processExitError(entry!));
      this.fail(entry!, key, cfg.id, entry!.exitReason, false);
    });
    this.reportStatus(cfg.id, { serverId: cfg.id, status: 'starting', observedAt: Date.now() });
    this.log.info('MCP stdio process starting', { server: cfg.name, mode: cfg.mode, family });
    await started;
    if (entry.exited) throw this.processExitError(entry);
    return entry;
  }

  private processExitError(entry: ProcessEntry): Error {
    return new Error(entry.exitReason ?? `MCP server process exited with code ${entry.exitCode ?? 'signal'}`);
  }

  private processKey(cfg: ServerConfig, session: string, family: ProtocolFamily): string {
    const base = family === 'stateless' ? `${cfg.id}:${cfg.revision}:@stateless` : `${cfg.id}:${cfg.revision}`;
    return cfg.mode === 'per-session' ? `${base}:${session}` : base;
  }

  private armPendingDelivery(serverId: string, delivery: PendingSecretDelivery): void {
    const remaining = delivery.expiresAt - Date.now();
    if (remaining <= 0) {
      this.pendingSecretDeliveries.delete(serverId);
      return;
    }
    delivery.timer = setTimeout(() => {
      this.expirePendingDelivery(serverId, delivery);
    }, remaining);
    delivery.timer.unref();
  }

  private expirePendingDelivery(serverId: string, delivery: PendingSecretDelivery): void {
    if (this.pendingSecretDeliveries.get(serverId) !== delivery) return;
    this.pendingSecretDeliveries.delete(serverId);
    this.log.warn('MCP secret delivery expired before registry sync', { serverId, revision: delivery.revision });
  }

  private validationOrigin(validationId: string, oauthServerId: string): string | null {
    const candidate = this.validationConfigs.get(validationId);
    if (!candidate?.url || this.validationOrigins.get(validationId) !== oauthServerId) return null;
    try {
      return new URL(candidate.url).origin;
    } catch {
      return null;
    }
  }

  private registeredOrigin(serverId: string): string | null {
    const server = this.config.get(serverId);
    if (!server?.url) return null;
    try {
      return new URL(server.url).origin;
    } catch {
      return null;
    }
  }

  private hasRequiredSecrets(cfg: ServerConfig): boolean {
    const values = this.secretMap(cfg.id);
    for (const bucket of [cfg.env, cfg.headers]) {
      for (const value of Object.values(bucket ?? {})) {
        if (value.kind !== 'secret') continue;
        const ref = cfg.secrets.find(secret => secret.secretId === value.secretId);
        if (!ref || !values?.has(ref.name)) return false;
      }
    }
    if (cfg.urlSecretId) {
      const ref = cfg.secrets.find(secret => secret.secretId === cfg.urlSecretId);
      if (!ref || !values?.has(ref.name)) return false;
    }
    return true;
  }
  private lines(e: ProcessEntry, chunk: Buffer): void {
    e.buffers = Buffer.concat([e.buffers, chunk]);
    let n: number;
    while ((n = e.buffers.indexOf(10)) >= 0) {
      const line = e.buffers.subarray(0, n).toString();
      e.buffers = e.buffers.subarray(n + 1);
      try {
        const msg = JSON.parse(line) as { id?: string | number; method?: string; [k: string]: unknown };
        if (typeof msg.id === 'string' && e.pending.has(msg.id)) {
          const p = e.pending.get(msg.id)!;
          e.pending.delete(msg.id);
          if (p.timer) clearTimeout(p.timer);
          msg.id = p.originalId;
          if (msg.error) this.logRpcError(e, p.method, msg.error);
          p.response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': p.session });
          p.response.end(JSON.stringify(msg));
        } else if (msg.method === 'notifications/tools/list_changed') for (const stream of e.streams.values()) stream.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
      } catch {
        /* malformed server stdout is ignored and never logged */
      }
    }
  }
  private logRpcError(e: ProcessEntry, method: string | undefined, error: unknown): void {
    const { code, message } = (typeof error === 'object' && error ? error : {}) as { code?: unknown; message?: unknown };
    this.log.warn('MCP server returned an error', {
      server: e.serverName,
      family: e.family,
      method,
      code: typeof code === 'number' ? code : undefined,
      message: typeof message === 'string' ? this.redactText(e.serverId, message).slice(0, 500) : undefined,
    });
  }
  private fail(e: ProcessEntry, key: string, serverId: string, reason: string, terminal: boolean): void {
    if (e.stopping) return;
    e.stopping = true;
    if (e.healthyTimer) clearTimeout(e.healthyTimer);
    for (const p of e.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      this.safeError(p.response, new Error(reason));
    }
    e.pending.clear();
    if (this.entries.get(key) === e) this.entries.delete(key);
    if (terminal) {
      const revision = this.config.get(serverId)?.revision;
      if (revision !== undefined) this.unavailableExecutables.set(key, revision);
    }
    this.reportStatus(serverId, { serverId, status: 'failed', error: reason.slice(0, 500), observedAt: Date.now() });
    if (terminal || !e.sessions.size) return;
    const now = Date.now(),
      history = (this.restartHistory.get(key) ?? []).filter(at => now - at < this.limits.backoffWindowMs);
    if (history.length >= this.limits.maxRestarts) return;
    history.push(now);
    this.restartHistory.set(key, history);
    const delay = Math.min(this.limits.backoffBaseMs * 2 ** (history.length - 1), this.limits.backoffMaxMs),
      cfg = this.config.get(serverId);
    if (!cfg) return;
    this.clearRetry(key);
    this.retryAfter.set(key, Date.now() + delay);
    const timer = setTimeout(() => {
      this.retryTimers.delete(key);
      this.retryAfter.delete(key);
      const current = this.config.get(serverId);
      if (!current || current.revision !== cfg.revision) return;
      const first = [...e.sessions.keys()][0] ?? 'machine';
      void this.process(current, first, e.family)
        .then(next => {
          for (const [sid, value] of e.sessions) next.sessions.set(sid, value);
          for (const [sid, stream] of e.streams) next.streams.set(sid, stream);
        })
        .catch(() => undefined);
    }, delay);
    this.retryTimers.set(key, timer);
    timer.unref();
  }
  private clearRetries(serverId: string): void {
    for (const key of [...this.retryTimers.keys()]) if (key === serverId || key.startsWith(`${serverId}:`)) this.clearRetry(key);
    for (const key of [...this.retryAfter.keys()]) if (key === serverId || key.startsWith(`${serverId}:`)) this.retryAfter.delete(key);
    for (const key of [...this.restartHistory.keys()]) if (key === serverId || key.startsWith(`${serverId}:`)) this.restartHistory.delete(key);
    for (const key of [...this.unavailableExecutables.keys()]) if (key === serverId || key.startsWith(`${serverId}:`)) this.unavailableExecutables.delete(key);
  }
  private clearRetry(key: string): void {
    const timer = this.retryTimers.get(key);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(key);
    this.retryAfter.delete(key);
  }
  private clearIdle(e: ProcessEntry): void {
    if (e.timer) clearTimeout(e.timer);
    e.timer = undefined;
  }
  private expireIdle(key: string, serverId: string, entry: ProcessEntry): void {
    entry.timer = undefined;
    if (this.entries.get(key) !== entry || entry.sessions.size || entry.managedSessions.size) return;
    this.kill(entry);
    this.entries.delete(key);
    // The server's process of the other protocol family may still run.
    if ([...this.entries.keys()].some(current => this.matchesServerRevision(current, serverId))) return;
    this.emitStatus({ serverId, status: 'stopped', observedAt: Date.now() });
  }
  private redactText(serverId: string, text: string): string {
    const values = this.secretMap(serverId)?.values() ?? [];
    let safe = redact(text);
    for (const value of values) if (value.length >= 4) safe = safe.split(value).join('[redacted]');
    return safe;
  }
  private secretMap(serverId: string): Map<string, string> | undefined {
    return this.validationSecrets.get(serverId) ?? this.secretValues.get(serverId);
  }
  private reportStatus(serverId: string, payload: unknown): void {
    if (this.validationOrigins.has(serverId)) return;
    this.emitStatus(payload);
  }
  private clearValidationState(validationId: string): void {
    this.validationSecrets.delete(validationId);
    this.validationOrigins.delete(validationId);
    this.validationChildren.delete(validationId);
  }
  private kill(e: ProcessEntry): void {
    e.stopping = true;
    if (e.timer) clearTimeout(e.timer);
    if (e.healthyTimer) clearTimeout(e.healthyTimer);
    for (const pending of e.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
    }
    e.pending.clear();
    for (const stream of e.streams.values()) stream.end();
    e.streams.clear();
    e.child.stdin?.end();
    const timer = setTimeout(() => e.child.kill(), 3000);
    timer.unref();
  }
  private safeError(res: ServerResponse, error: unknown): void {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: redact(error instanceof Error ? error.message : 'MCP gateway request failed') }));
  }
}
function protocolFamily(version: string): ProtocolFamily {
  return /^\d{4}-\d{2}-\d{2}$/.test(version) && version >= STATELESS_PROTOCOL_VERSION ? 'stateless' : 'legacy';
}
/** The stateless revision repeats the protocol version in every request's `_meta`. */
function requestedProtocolVersion(rpc: RpcMessage): string | undefined {
  const meta = (rpc.params as { _meta?: unknown } | undefined)?._meta;
  if (!meta || typeof meta !== 'object') return undefined;
  for (const [key, value] of Object.entries(meta)) if ((key === 'protocolVersion' || key.endsWith('/protocolVersion')) && typeof value === 'string' && value) return value;
  return undefined;
}
function redact(s: string): string {
  return s.replace(/(bearer\s+)[^\s"']+/gi, '$1[redacted]').replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, '$1[redacted]');
}
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (b: Buffer) => {
      size += b.length;
      if (size > 4 * 1024 * 1024) {
        reject(new Error('request too large'));
        req.destroy();
      } else chunks.push(b);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
