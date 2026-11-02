import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { URL } from 'node:url';
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
interface ProcessEntry {
  child: ChildProcess;
  buffers: Buffer;
  pending: Map<string, PendingRequest>;
  sessions: Map<string, string>;
  streams: Map<string, ServerResponse>;
  timer?: NodeJS.Timeout;
  healthyTimer?: NodeJS.Timeout;
  stopping: boolean;
}

interface PendingRequest {
  session: string;
  response: ServerResponse;
  originalId: string | number;
  timer?: NodeJS.Timeout;
}

class McpUnauthorizedError extends Error {}

/** Loopback Streamable HTTP endpoint and lazy stdio process supervisor. */
export class McpGateway {
  private server: Server | null = null;
  private endpoint = '';
  private entries = new Map<string, ProcessEntry>();
  private tokens = new Map<string, Map<string, string>>();
  private config = new Map<string, ServerConfig>();
  private secretValues = new Map<string, Map<string, string>>();
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
    const next = new Map(snapshot.servers.map(x => [x.id, x]));
    for (const [id, old] of this.config)
      if (next.get(id)?.revision !== old.revision) {
        this.secretValues.delete(id);
        this.clearRetries(id);
        this.stopProcesses(id);
        if (!next.has(id)) this.tokens.delete(id);
      }
    this.config = next;
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
    if (this.config.get(serverId)?.revision !== revision) return false;
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
    const old = this.config.get(payload.server.id);
    const candidate = { ...payload.server, mode: 'per-session' as const };
    this.config.set(candidate.id, candidate);
    if (payload.secretDelivery) this.setSecretDelivery(candidate.id, payload.secretDelivery.revision, payload.secretDelivery.secrets);
    const sessionId = randomUUID(),
      bearer = this.authorize(candidate.id, sessionId);
    const call = async (id: number, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const res = await fetch(`${this.endpoint}?server=${encodeURIComponent(candidate.id)}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearer}`,
          'x-agent-session': sessionId,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-03-26',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => ''),
          detail = body ? this.redactText(candidate.id, body).slice(0, 300) : '';
        if (res.status === 401) throw new McpUnauthorizedError('MCP server requires authorization');
        if (res.status === 424) throw new Error('MCP server needs a configured secret');
        throw new Error(`MCP server returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
      }
      const result = (await res.json()) as Record<string, unknown>;
      if (result.error) throw new Error(typeof (result.error as { message?: unknown }).message === 'string' ? (result.error as { message: string }).message : 'MCP request failed');
      return result;
    };
    try {
      await call(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'agent-hub-validator', version: '1.0.0' } });
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
      const safe = this.redactText(candidate.id, error instanceof Error ? error.message : 'MCP validation failed').slice(0, 500);
      return { ok: false, status: /needs a configured secret/i.test(safe) ? 'needs-secret' : 'validation-failed', tools: [], error: safe, oauthRequired: false };
    } finally {
      this.revoke(candidate.id, sessionId);
      const key = `${candidate.id}:${sessionId}`,
        entry = this.entries.get(key);
      if (entry) {
        this.kill(entry);
        this.entries.delete(key);
      }
      if (old) this.config.set(candidate.id, old);
      else this.config.delete(candidate.id);
      if (!old) this.secretValues.delete(candidate.id);
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
    let bySession = this.tokens.get(serverId);
    if (!bySession) this.tokens.set(serverId, (bySession = new Map()));
    bySession.set(sessionId, bearer);
    const cfg = this.config.get(serverId);
    if (!cfg || !cfg.enabled) throw new Error('MCP server is not enabled in the registry');
    if (cfg.transport === 'stdio') await this.process(cfg, sessionId);
    else this.emitStatus({ serverId, status: 'ready', endpoint: this.endpoint, observedAt: Date.now() });
    return this.endpoint;
  }
  stopManaged(serverId: string, sessionId: string): void {
    this.revoke(serverId, sessionId);
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
  revoke(serverId: string, sessionId: string): void {
    this.tokens.get(serverId)?.delete(sessionId);
    for (const [key, e] of this.entries)
      if (key === serverId || key.startsWith(`${serverId}:`)) {
        e.sessions.delete(sessionId);
        if (!e.sessions.size) {
          e.timer = setTimeout(() => {
            if (!e.sessions.size) {
              this.kill(e);
              this.entries.delete(key);
              this.emitStatus({ serverId, status: 'stopped', observedAt: Date.now() });
            }
          }, this.limits.idleMs);
          e.timer.unref();
        }
      }
  }
  revokeSession(sessionId: string): void {
    for (const serverId of this.tokens.keys()) this.revoke(serverId, sessionId);
  }
  async stop(): Promise<void> {
    for (const serverId of this.config.keys()) this.clearRetries(serverId);
    for (const e of this.entries.values()) this.kill(e);
    this.entries.clear();
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
    const cfg = this.config.get(id);
    if (!cfg || !cfg.enabled) {
      res.writeHead(404).end();
      return;
    }
    if (cfg.transport === 'http' || cfg.transport === 'sse') {
      await this.remote(req, res, cfg);
      return;
    }
    if (req.method === 'DELETE') {
      this.revoke(id, sid);
      res.writeHead(200).end();
      return;
    }
    try {
      const entry = await this.process(cfg, sid);
      this.clearIdle(entry);
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
      const body = await readBody(req);
      const rpc = JSON.parse(body.toString('utf8')) as { id?: string | number; method?: string; [k: string]: unknown };
      const originalId = rpc.id;
      const backendId = `${sid}:${String(originalId ?? randomUUID())}`;
      if (originalId !== undefined) {
        const pending: PendingRequest = { session: sid, response: res, originalId };
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
        const value = ref && this.secretValues.get(cfg.id)?.get(ref.name);
        if (value) headers.set(k, value);
      }
    }
    try {
      const target = new URL(cfg.url!);
      if (decodeURIComponent(target.username) === '__AGENT_HUB_SECRET__') {
        const ref = cfg.secrets.find(x => x.name === 'url:username'),
          secret = ref && this.secretValues.get(cfg.id)?.get(ref.name);
        if (!secret) {
          res.writeHead(424, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'MCP server needs a configured secret' }));
          return;
        }
        target.username = secret;
      }
      if (decodeURIComponent(target.password) === '__AGENT_HUB_SECRET__') {
        const ref = cfg.secrets.find(x => x.name === 'url:password'),
          secret = ref && this.secretValues.get(cfg.id)?.get(ref.name);
        if (!secret) {
          res.writeHead(424, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'MCP server needs a configured secret' }));
          return;
        }
        target.password = secret;
      }
      for (const [key, value] of target.searchParams)
        if (value === '__AGENT_HUB_SECRET__') {
          const ref = cfg.secrets.find(x => x.name === `url:${key}`),
            secret = ref && this.secretValues.get(cfg.id)?.get(ref.name);
          if (!secret) {
            res.writeHead(424, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'MCP server needs a configured secret' }));
            return;
          }
          target.searchParams.set(key, secret);
        }
      const method = req.method === 'GET' ? 'GET' : req.method === 'DELETE' ? 'DELETE' : 'POST';
      const body = method === 'POST' ? await readBody(req) : undefined;
      const token = await this.oauthAccess?.(cfg.id);
      if (token) headers.set('authorization', `Bearer ${token}`);
      const request = () => fetch(target, { method, headers, ...(body ? { body } : {}), redirect: 'manual' });
      let response = await request();
      if (token && response.status === 401 && this.oauthRefresh) {
        const token = await this.oauthRefresh(cfg.id);
        if (token) {
          headers.set('authorization', `Bearer ${token}`);
          response = await request();
        }
      }
      const out: Record<string, string> = {};
      response.headers.forEach((v, k) => {
        if (!HOP.has(k.toLowerCase()) && !RESPONSE_BODY_HEADERS.has(k.toLowerCase())) out[k] = v;
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
  private async process(cfg: ServerConfig, session: string): Promise<ProcessEntry> {
    const key = cfg.mode === 'per-session' ? `${cfg.id}:${session}` : cfg.id;
    let entry = this.entries.get(key);
    if (entry) return entry;
    if (this.unavailableExecutables.get(key) === cfg.revision) throw new Error('MCP server executable is unavailable; check the command and runtime installation');
    const now = Date.now();
    if ((this.retryAfter.get(key) ?? 0) > now) throw new Error('MCP server is in restart backoff; retry shortly');
    const history = (this.restartHistory.get(key) ?? []).filter(at => now - at < this.limits.backoffWindowMs);
    this.restartHistory.set(key, history);
    if (history.length >= this.limits.maxRestarts) throw new Error('MCP server restart limit reached; retry later');
    if (cfg.mode === 'per-session' && [...this.entries.keys()].filter(k => k.startsWith(`${cfg.id}:`)).length >= this.limits.maxPerServerSessions)
      throw new Error('MCP per-session process limit reached for this server');
    if (this.entries.size >= this.limits.maxProcesses) throw new Error('MCP process limit reached; stop an unused server and retry');
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfg.env ?? {})) {
      if (v.kind === 'literal') childEnv[k] = v.value;
      else {
        const ref = cfg.secrets.find(x => x.secretId === v.secretId);
        const value = ref && this.secretValues.get(cfg.id)?.get(ref.name);
        if (value) childEnv[k] = value;
      }
    }
    const child = spawn(cfg.command!, cfg.args ?? [], { stdio: ['pipe', 'pipe', 'pipe'], shell: false, env: { ...process.env, ...childEnv } });
    entry = { child, buffers: Buffer.alloc(0), pending: new Map(), sessions: new Map(), streams: new Map(), stopping: false };
    this.entries.set(key, entry);
    child.stdout?.on('data', (chunk: Buffer) => this.lines(entry!, chunk));
    child.once('spawn', () => {
      this.emitStatus({ serverId: cfg.id, status: 'ready', endpoint: this.endpoint, observedAt: Date.now() });
      entry!.healthyTimer = setTimeout(() => this.restartHistory.delete(key), this.limits.healthyResetMs);
      entry!.healthyTimer.unref();
    });
    child.stderr?.on('data', (chunk: Buffer) => this.log.warn('MCP server stderr', { server: cfg.name, text: this.redactText(cfg.id, chunk.toString()).slice(0, 1000) }));
    child.on('error', err => {
      const e = err as NodeJS.ErrnoException;
      this.fail(entry!, key, cfg.id, this.redactText(cfg.id, err.message), e.code === 'ENOENT');
    });
    child.on('exit', code => this.fail(entry!, key, cfg.id, `MCP server exited (${code ?? 'signal'})`, false));
    this.emitStatus({ serverId: cfg.id, status: 'starting', observedAt: Date.now() });
    return entry;
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
          p.response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': p.session });
          p.response.end(JSON.stringify(msg));
        } else if (msg.method === 'notifications/tools/list_changed') for (const stream of e.streams.values()) stream.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
      } catch {
        /* malformed server stdout is ignored and never logged */
      }
    }
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
    this.emitStatus({ serverId, status: 'failed', error: reason.slice(0, 500), observedAt: Date.now() });
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
      void this.process(current, first)
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
  private redactText(serverId: string, text: string): string {
    const values = this.secretValues.get(serverId)?.values() ?? [];
    let safe = redact(text);
    for (const value of values) if (value.length >= 4) safe = safe.split(value).join('[redacted]');
    return safe;
  }
  private kill(e: ProcessEntry): void {
    e.stopping = true;
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
