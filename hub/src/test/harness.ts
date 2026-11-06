import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { envelope, hubMessageSchema, PROTOCOL_VERSION } from '@agent-hub/shared';
import { loadConfig, type Config } from '../config.js';
import { createOidcClient } from '../auth/oidc.js';
import { buildHub, type Hub, type HubDeps } from '../app.js';
import { createTestDb, type TestDb } from './db.js';
import { startFakeOidc, type FakeIdentity, type FakeOidc } from './fakeOidc.js';
import { upsertUser } from '../auth/sessions.js';
import { createLimits, type LIMITS } from '../http/limits.js';
import { addRunner, issueRunnerToken } from '../runners/repo.js';
import { MemoryStore, type ObjectStore } from '../storage/objectStore.js';

export const PUBLIC_URL = 'https://agents.test.example';
export const ALLOWED_EMAIL = 'jonasasx@gmail.com';

export interface TestHub {
  hub: Hub;
  store: ObjectStore;
  config: Config;
  tdb: TestDb;
  oidc: FakeOidc;
  /** The Keycloak provider (option `keycloak`). */
  keycloak: FakeOidc | null;
  /** http://127.0.0.1:<port> */
  httpBase: string;
  /** ws://127.0.0.1:<port> */
  wsBase: string;
  /** Runs the full OIDC login and returns the session cookie value. */
  login(identity?: Partial<FakeIdentity>, opts?: { provider?: 'google' | 'keycloak'; invite?: string }): Promise<string>;
  /** The same login, returning the callback response (denied logins). */
  loginResponse(
    identity?: Partial<FakeIdentity>,
    opts?: { provider?: 'google' | 'keycloak'; invite?: string },
  ): Promise<{ statusCode: number; body: string; headers: Record<string, unknown>; session: string | undefined }>;
  /** Creates a runner owned by the allowed user and returns its token. */
  addRunner(id: string, name?: string): Promise<string>;
  close(): Promise<void>;
}

export function cookieValue(setCookie: string | string[] | undefined, name: string): string | undefined {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const c of list) {
    const [pair] = c.split(';');
    const i = pair!.indexOf('=');
    if (pair!.slice(0, i) === name) return pair!.slice(i + 1);
  }
  return undefined;
}

export async function startTestHub(
  opts: {
    agentGateway?: HubDeps['agentGateway'];
    env?: Record<string, string>;
    logStream?: { write(line: string): void };
    /** Default: a fresh MemoryStore. */
    store?: ObjectStore;
    /** Change multi-user: a second fake provider as Keycloak. */
    keycloak?: boolean;
    /** Rate limits of the spec (default: raised — many logins from 127.0.0.1 in one test file). */
    limits?: Partial<Record<keyof typeof LIMITS, number>> | 'spec';
  } & Pick<HubDeps, 'listenClientFactory' | 'listenRetryBaseMs' | 'uiPingIntervalMs' | 'sessions' | 'ops' | 'projects' | 'voice' | 'limitsProbe' | 'mcp' | 'mcpRegistry' | 'peers' | 'files'> = {},
): Promise<TestHub> {
  const tdb = await createTestDb();
  const store = opts.store ?? new MemoryStore();
  const oidc = await startFakeOidc();
  const keycloak = opts.keycloak ? await startFakeOidc() : null;
  const config = loadConfig({
    NODE_ENV: 'test',
    PUBLIC_URL,
    DATABASE_URL: tdb.url,
    COOKIE_SECRET: 'test-cookie-secret-0123456789abcdef0123',
    OIDC_ISSUER: oidc.issuer,
    OIDC_CLIENT_ID: oidc.clientId,
    OIDC_CLIENT_SECRET: oidc.clientSecret,
    OIDC_ALLOWED_EMAILS: ALLOWED_EMAIL,
    WEB_DIST_DIR: '/nonexistent-web-dist',
    LOG_LEVEL: 'silent',
    AGENT_DIST_DIR: '/nonexistent-agent-release',
    INSTALLERS_DIR: '/nonexistent-installers',
    ...(keycloak ? { OIDC_KEYCLOAK_ISSUER: keycloak.issuer, OIDC_KEYCLOAK_LABEL: 'Acme', OIDC_KEYCLOAK_CLIENT_ID: keycloak.clientId, OIDC_KEYCLOAK_CLIENT_SECRET: keycloak.clientSecret } : {}),
    ...opts.env,
  });
  const many = 1_000_000;
  const limits = createLimits({
    overrides: opts.limits === 'spec' ? {} : { loginStart: many, enrollBad: many, invitePage: many, agentBadToken: many, ...opts.limits },
  });
  const hub = await buildHub({
    config,
    db: tdb.db,
    // change i18n D10: the existing tests check Russian texts
    defaultLocale: 'ru',
    oidc: createOidcClient({ issuer: config.OIDC_GOOGLE_ISSUER, clientId: config.OIDC_GOOGLE_CLIENT_ID, clientSecret: config.OIDC_GOOGLE_CLIENT_SECRET }),
    ...(keycloak ? { oidcKeycloak: createOidcClient({ issuer: keycloak.issuer, clientId: keycloak.clientId, clientSecret: keycloak.clientSecret }) } : {}),
    limits,
    ...(opts.agentGateway ? { agentGateway: opts.agentGateway } : {}),
    ...(opts.listenClientFactory ? { listenClientFactory: opts.listenClientFactory } : {}),
    ...(opts.listenRetryBaseMs ? { listenRetryBaseMs: opts.listenRetryBaseMs } : {}),
    ...(opts.uiPingIntervalMs ? { uiPingIntervalMs: opts.uiPingIntervalMs } : {}),
    ...(opts.sessions ? { sessions: opts.sessions } : {}),
    ...(opts.voice ? { voice: opts.voice } : {}),
    // mcp-management: no expiry timer unless a test asks
    mcp: { sweepMs: 0, ...opts.mcp },
    ...(opts.mcpRegistry ? { mcpRegistry: opts.mcpRegistry } : {}),
    ...(opts.peers ? { peers: opts.peers } : {}),
    ...(opts.files ? { files: opts.files } : {}),
    // subscription-limits: no scheduler timer (and no probes on hello) unless a test asks; tests call limits.tick()
    limitsProbe: { tickMs: 0, jitterMs: 0, ...opts.limitsProbe },
    store,
    // The disk check timer is off in tests unless asked; tests call checkDisk directly.
    ops: { diskCheckMs: 0, ...opts.ops },
    // The catalogue is loaded once; recompute without the 2 s debounce unless a test asks for it.
    projects: { debounceMs: 0, ...opts.projects },
    logger: opts.logStream ? { level: 'info', stream: opts.logStream } : false,
  });
  await hub.app.listen({ host: '127.0.0.1', port: 0 });
  const port = (hub.app.server.address() as AddressInfo).port;
  const loginResponse: TestHub['loginResponse'] = async (identity = {}, o = {}) => {
    const q = new URLSearchParams({ return: '/s/abc' });
    // /auth/login without a provider is the choice page: Google unless an invite decides
    const asked = o.provider ?? (!o.invite ? 'google' : undefined);
    if (asked) q.set('provider', asked);
    if (o.invite) q.set('invite', o.invite);
    const start = await hub.app.inject({ method: 'GET', url: `/auth/login?${q.toString()}` });
    const oidcCookie = cookieValue(start.headers['set-cookie'], 'ah_oidc');
    if (!oidcCookie) throw new Error(`login start failed: ${start.statusCode} ${start.body.slice(0, 200)}`);
    const location = start.headers.location as string;
    const provider = keycloak && location.startsWith(`${keycloak.issuer}/`) ? keycloak : oidc;
    const { code, state } = provider.authorize(location, { email: ALLOWED_EMAIL, ...identity });
    const cb = await hub.app.inject({
      method: 'GET',
      url: `/auth/callback?code=${code}&state=${state}`,
      cookies: { ah_oidc: decodeURIComponent(oidcCookie) },
    });
    return { statusCode: cb.statusCode, body: cb.body, headers: cb.headers as Record<string, unknown>, session: cookieValue(cb.headers['set-cookie'], 'ah_session') };
  };

  return {
    hub,
    store,
    config,
    tdb,
    oidc,
    keycloak,
    httpBase: `http://127.0.0.1:${port}`,
    wsBase: `ws://127.0.0.1:${port}`,
    loginResponse,
    async login(identity = {}, o = {}) {
      const cb = await loginResponse(identity, o);
      if (cb.statusCode !== 302 || !cb.session) throw new Error(`login failed: ${cb.statusCode} ${cb.body}`);
      return cb.session;
    },
    async addRunner(id, name = id.toUpperCase()) {
      const user = await upsertUser(tdb.db, ALLOWED_EMAIL);
      await addRunner(tdb.db, { id, userId: user.id, name, os: null });
      return issueRunnerToken(tdb.db, id);
    },
    async close() {
      await hub.close();
      await oidc.close();
      await keycloak?.close();
      await tdb.drop();
    },
  };
}

export function helloPayload(over: Record<string, unknown> = {}) {
  return {
    protocol: PROTOCOL_VERSION,
    agentVersion: '0.1.0',
    sdkVersion: '0.3.310',
    claudeCodeVersion: '2.1.310',
    hostname: 'HP-Elitebook',
    os: 'Windows 11 Pro',
    homeDir: 'C:\\Users\\alice',
    vaultRoot: 'C:\\Users\\alice\\vault',
    liveSessions: [],
    files: [],
    ...over,
  };
}

export interface FakeAgent {
  ws: WebSocket;
  messages: Array<{ type: string; id?: string; payload: Record<string, unknown> }>;
  sentMessages: Array<{ type: string; re?: string; payload: Record<string, unknown> }>;
  protocolErrors: string[];
  closed: Promise<{ code: number; reason: string }>;
  next(type: string, timeoutMs?: number): Promise<{ type: string; payload: Record<string, unknown> }>;
}

/** Connects a scripted agent; sends hello on open unless `hello: false`. */
export function connectFakeAgent(wsBase: string, token: string | null, hello: Record<string, unknown> | false = {}): FakeAgent {
  const ws = new WebSocket(`${wsBase}/ws/agent`, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
  const messages: FakeAgent['messages'] = [];
  const sentMessages: FakeAgent['sentMessages'] = [];
  const protocolErrors: string[] = [];
  const waiters: Array<{ type: string; resolve: (m: FakeAgent['messages'][number]) => void }> = [];
  ws.on('message', d => {
    const raw = d.toString();
    const parsed = hubMessageSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) protocolErrors.push(parsed.error.message);
    const m = JSON.parse(raw) as FakeAgent['messages'][number];
    messages.push(m);
    const i = waiters.findIndex(w => w.type === m.type);
    if (i >= 0) waiters.splice(i, 1)[0]!.resolve(m);
  });
  ws.on('error', () => undefined);
  if (hello !== false) ws.on('open', () => ws.send(JSON.stringify(envelope('hello', helloPayload(hello)))));
  const closed = new Promise<{ code: number; reason: string }>(r => ws.on('close', (code, reason) => r({ code, reason: reason.toString() })));
  return {
    ws,
    messages,
    sentMessages,
    protocolErrors,
    closed,
    // 15 s: under a full parallel run on Windows the hello → welcome round trip can take several seconds.
    next(type, timeoutMs = 15_000) {
      const have = messages.find(m => m.type === type);
      if (have) return Promise.resolve(have);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`no ${type} within ${timeoutMs} ms`)), timeoutMs);
        waiters.push({ type, resolve: m => (clearTimeout(t), resolve(m)) });
      });
    },
  };
}

export async function waitFor<T>(fn: () => Promise<T | undefined | null | false> | T | undefined | null | false, timeoutMs = 5000, stepMs = 50): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, stepMs));
  }
}

/** Answers the hub's commands of a fake agent: `handler` returns the cmd.ok result or throws {code, message}. */
export const NO_AUTO_REPLY = Symbol('NO_AUTO_REPLY');

export function autoReply(agent: FakeAgent, handler: (type: string, payload: Record<string, unknown>, id?: string) => unknown): void {
  agent.ws.on('message', async d => {
    const m = JSON.parse(d.toString()) as { type: string; id?: string; payload: Record<string, unknown> };
    if (!m.id) return;
    try {
      const result = await handler(m.type, m.payload, m.id);
      if (result === NO_AUTO_REPLY) return;
      const payload = result === undefined ? {} : { result };
      agent.sentMessages.push({ type: 'cmd.ok', payload, re: m.id });
      agent.ws.send(JSON.stringify(envelope('cmd.ok', payload, { re: m.id })));
    } catch (err) {
      const e = err as { code?: string; message?: string; failure?: unknown };
      const payload = { code: e.code ?? 'error', message: e.message ?? '', ...(e.failure ? { failure: e.failure } : {}) };
      agent.sentMessages.push({ type: 'cmd.error', payload, re: m.id });
      agent.ws.send(JSON.stringify(envelope('cmd.error', payload, { re: m.id })));
    }
  });
}

/** Sends an agent → hub message from a fake agent. */
export function agentSend(agent: FakeAgent, type: string, payload: unknown, extra: { id?: string; re?: string } = {}): void {
  agent.sentMessages.push({ type, payload: payload as Record<string, unknown>, ...(extra.re ? { re: extra.re } : {}) });
  agent.ws.send(JSON.stringify(envelope(type, payload, extra)));
}

/** Browser WebSocket with the session cookie; collects server messages. */
export function connectUi(wsBase: string, session: string) {
  const ws = new WebSocket(`${wsBase}/ws/ui`, { headers: { Origin: PUBLIC_URL, Cookie: `ah_session=${session}` } });
  const received: Array<{ type: string } & Record<string, unknown>> = [];
  ws.on('message', d => received.push(JSON.parse(d.toString()) as { type: string }));
  const open = new Promise<void>(r => ws.on('open', () => r()));
  return { ws, received, open, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

/** The mini vault of the catalogue fixtures (INDEX.md, 40-automation/repos.txt copied from the vault 2026-10-26). */
export const FIXTURE_VAULT = fileURLToPath(new URL('../projects/fixtures/vault', import.meta.url));
