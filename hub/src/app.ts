import { CatalogDetection } from './projects/detection.js';
import { SubscriptionProjectClassifier, type ProjectClassifier } from './projects/haiku.js';
import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyHelmet from '@fastify/helmet';
import pg from 'pg';
import { sql } from 'kysely';
import type { MeResponse } from '@agent-hub/shared';
import type { Config } from './config.js';
import type { Db } from './db/db.js';
import type { OidcClient } from './auth/oidc.js';
import { registerAuth } from './http/auth.js';
import { idTokenKey, sealLegacyIdTokens } from './auth/idToken.js';
import { registerDesktopAuth } from './http/desktopAuth.js';
import { registerDesktopUpdates } from './http/desktopUpdates.js';
import { HubBus } from './bus.js';
import { AgentGateway, type AgentGatewayOptions } from './runners/agentGateway.js';
import { UiGateway } from './ui/uiGateway.js';
import { TOKEN_CHANNEL } from './runners/repo.js';
import { SessionService } from './sessions/service.js';
import { registerApi } from './http/api.js';
import { HandoffService } from './sessions/handoff.js';
import { deleteExpiredSessions } from './auth/sessions.js';
import { expireHeldMeta } from './subagents/repo.js';
import { createS3Client, S3Store, type ObjectStore } from './storage/objectStore.js';
import { deleteStalePendingRunners, findRunnerByToken } from './runners/repo.js';
import { cleanupUploads, registerBlobs } from './http/blobs.js';
import { registerVoice } from './http/voice.js';
import { cspProvider, voiceConnectSources } from './http/csp.js';
import { registerVoiceTalk } from './http/voiceTalk.js';
import { ProjectCatalog } from './projects/catalogService.js';
import { ProjectService, PROJECTS_CHANNEL } from './projects/service.js';
import { hashSecret, safeEqual } from './auth/secrets.js';
import { diskCheckPeriodMs, DiskWatch, renderMetrics, telegramSender, type SendTelegram, type StatFn } from './ops/metrics.js';
import { createLimits, trustFn, type HubLimits } from './http/limits.js';
import { bootstrapAdmins, expireSecurityEvents } from './users/repo.js';
import { AgentBuild, registerAgentDist } from './runners/agentBuild.js';
import { registerMultiUser } from './http/multiUser.js';
import { SubscriptionService } from './subscriptions/service.js';
import { registerSubscriptionsApi } from './http/subscriptions.js';
import { LimitsService } from './subscriptions/limits.js';
import { CodexHomesSync } from './subscriptions/codexHomes.js';
import { McpService } from './mcp/service.js';
import { registerMcpApi } from './http/mcp.js';
import { McpRegistryService, registerMcpRegistryApi } from './mcp/registry.js';
import { PeersService, type PeersServiceOptions } from './peers/service.js';
import { registerPeersApi } from './http/peers.js';
import { registerPushRoutes } from './http/push.js';
import { PushService } from './push/service.js';
import { createWebPushSender, isValidVapid, type PushSender } from './push/sender.js';
import { setKeycloakLabel } from './http/pages.js';

export interface HubDeps {
  config: Config;
  db: Db;
  /** Google (the provider of the MVP). */
  oidc: OidcClient;
  /** The second provider, Keycloak (change multi-user); absent — its login button is not offered. */
  oidcKeycloak?: OidcClient;
  /** Tests: rate limits with their own clock. */
  limits?: HubLimits;
  agentGateway?: Partial<Pick<AgentGatewayOptions, 'heartbeatIntervalMs' | 'heartbeatTimeoutMs' | 'heartbeatCheckMs' | 'helloTimeoutMs'>>;
  /** Tests: replaces the LISTEN connection factory and its retry base delay. */
  listenClientFactory?: (connectionString: string) => pg.Client;
  listenRetryBaseMs?: number;
  /** Tests: interval of browser socket pings and session-expiry checks (default 30 s). */
  uiPingIntervalMs?: number;
  /** Tests: session service overrides (clock, idle check period, init timeout). */
  sessions?: { now?: () => Date; idleCheckMs?: number; initTimeoutMs?: number; deliveryGraceMs?: number; deliveryWindowMs?: number };
  /** Object store; default S3Store(S3_BUCKET_DATA). Tests pass a MemoryStore. */
  store?: ObjectStore;
  /** Tests: statfs of the data volume, the Telegram sender and the disk check period (default 10 min; 0 — off). */
  ops?: { stat?: StatFn; send?: SendTelegram; diskCheckMs?: number };
  /** Tests: the catalogue check period (default 60 s; 0 — loaded once) and the recompute debounce (default 2 s). */
  projects?: { debounceMs?: number; classifier?: ProjectClassifier };
  /** Tests: limits and timeouts of the file explorer routes (tool-windows-file-explorer). */
  files?: Partial<import('./http/files.js').FsRouteOptions>;
  /** Tests: how long handoff.generate may take (default 120 s). */
  handoffTimeoutMs?: number;
  /** Tests: the limits scheduler (subscription-limits L5): tick period (0 — no timer), jitter, clock. */
  limitsProbe?: { tickMs?: number; jitterMs?: number; now?: () => Date; /** Tests: the hub's wait for a probe (config ≥ 60 s). */ timeoutMs?: number };
  /** Tests: MCP management (mcp-management): shorter waits of the agent, the probe interval, the wake-up delay. */
  mcp?: Partial<Pick<import('./mcp/service.js').McpServiceOptions, 'timeouts' | 'probeMinMs' | 'wakeStatusDelayMs' | 'authTtlMs' | 'sweepMs' | 'now'>>;
  /** Tests: MCP registry WS request timeout. */
  mcpRegistry?: { importTimeoutMs?: number; validationTimeoutMs?: number; oauthFlowTtlMs?: number };
  /** Tests: session peers (session-peers): limits, window, clock. */
  peers?: Partial<Pick<PeersServiceOptions, 'pairLimit' | 'senderLimit' | 'windowMs' | 'now'>>;
  /** Tests: the fetch of the ElevenLabs client (dictation, change voice-input). */
  voice?: { fetch?: typeof fetch; heartbeatMs?: number };
  /** Tests: the language of a request without a header, a profile language or Accept-Language (default en, change i18n D10). */
  defaultLocale?: import('@agent-hub/shared').Locale;
  /** Tests: the sender of Web Push (a fake instead of web-push) and the clock of the throttle. */
  push?: { sender?: PushSender; now?: () => number };
  /** Defaults to a pino logger at config.LOG_LEVEL. */
  logger?: boolean | object;
}

export interface Hub {
  app: FastifyInstance;
  bus: HubBus;
  agents: AgentGateway;
  ui: UiGateway;
  sessions: SessionService;
  projects: ProjectService;
  handoff: HandoffService;
  /** subscription-limits: snapshots, probe turns, refresh. */
  limits: LimitsService;
  /** mcp-management: MCP snapshots, actions, sign-in, machine probe. */
  mcp: McpService;
  /** MCP registry service; exposed to integration tests alongside other hub services. */
  mcpRegistry: McpRegistryService;
  /** session-peers: catalog and messages between sessions. */
  peers: PeersService;
  /** Registered routes (method, pattern), HEAD excluded. */
  routes: ReadonlyArray<{ method: string; url: string }>;
  close(): Promise<void>;
}

/**
 * client-versions D1: files of the web build that name the current build. A cached copy would hide a new deploy from
 * the client (index.html points to the new bundles, sw.js carries the new precache, version.json is polled), so they
 * are revalidated on every request. Hashed bundles keep the default header.
 */
const NO_CACHE_FILES = new Set(['index.html', 'version.json', 'sw.js', 'push-sw.js']);

/** Paths the SPA must never answer with index.html. */
const NON_SPA = /^\/(api|auth|ws|agent-api|agent|enroll|healthz|metrics|mcp)(\/|$)/;

export async function buildHub(deps: HubDeps): Promise<Hub> {
  const { config, db } = deps;
  // The secrets of requests never reach the log; the same rules for a logger of the tests (logStream).
  const logRules = {
    redact: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      'req.body.token',
      'body.token',
      'subscription.token',
      '*.subscription.token',
      'payload.subscription.token',
      'req.body.endpoint',
      'req.body.keys',
      '*.keys',
      'req.body.callbackUrl',
      'body.callbackUrl',
      'payload.callbackUrl',
      '*.payload.callbackUrl',
    ],
    serializers: {
      req: (req: { method: string; url: string; hostname?: string; ip?: string }) => ({
        method: req.method,
        // multi-user: invite codes (path /invite/<code>, ?invite=) are secrets too
        url: req.url
          .replace(/\/agent-api\/(restore|blobs)\/[^/?#]+/, '/agent-api/$1/[token]')
          .replace(/\/invite\/[^/?#]+/, '/invite/[code]')
          .replace(/%2Finvite%2F[^&#]+/gi, '%2Finvite%2F[code]')
          .replace(/([?&]invite=)[^&#]+/, '$1[code]')
          // tool-windows-file-explorer: the paths of the machine's files are not logged
          .replace(/^(\/api\/runners\/[^/?#]+\/fs\/(?:list|file))\?.*$/, '$1?[redacted]')
          // mcp-management: the provider's code in the MCP sign-in address (and in the login's return to it)
          .replace(/^(\/mcp\/oauth\/callback)\?.*$/, '$1?[redacted]')
          .replace(/(return=%2Fmcp%2Foauth%2Fcallback)[^&#]*/i, '$1[redacted]'),
        hostname: req.hostname,
        remoteAddress: req.ip,
      }),
    },
  };
  const app = Fastify({
    logger: deps.logger === undefined ? { level: config.LOG_LEVEL, ...logRules } : typeof deps.logger === 'object' ? { ...logRules, ...deps.logger } : deps.logger,
    // Requirement: Лимиты запросов — X-Forwarded-For only from the trusted proxies (nginx on YM, Traefik).
    trustProxy: config.TRUSTED_PROXIES,
    bodyLimit: 1024 * 1024,
  });
  // Every route of the hub (method, pattern): the isolation and «закрыто по умолчанию» tests walk them all.
  const routes: Array<{ method: string; url: string }> = [];
  app.addHook('onRoute', r => {
    for (const m of [r.method].flat()) if (m !== 'HEAD') routes.push({ method: m, url: r.url });
  });
  setKeycloakLabel(config.OIDC_KEYCLOAK_LABEL);
  await app.register(fastifyCookie, { secret: config.COOKIE_SECRET });
  // Requirement: Защита браузерных запросов — HSTS (a year), X-Frame-Options DENY, nosniff and Referrer-Policy on every
  // response; the CSP stays the one of http/csp.ts (HTML responses below).
  await app.register(fastifyHelmet, {
    global: true,
    contentSecurityPolicy: false,
    hsts: { maxAge: 31_536_000, includeSubDomains: true },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'same-origin' },
    noSniff: true,
    crossOriginEmbedderPolicy: false,
  });
  // Requirement: Роли и первичный администратор — before anything reads roles (the vault catalogue is the admins' only).
  await bootstrapAdmins(db, config.OIDC_ALLOWED_EMAILS);
  // idtoken-at-rest-denied-logout D2: the plaintext id tokens of sessions created before 048 are encrypted (or erased).
  const sealed = await sealLegacyIdTokens(db, idTokenKey(config.SUBSCRIPTION_TOKEN_KEY));
  if (sealed > 0) app.log.info({ sealed, encrypted: config.SUBSCRIPTION_TOKEN_KEY !== undefined }, 'legacy id tokens sealed');
  const limits = deps.limits ?? createLimits();
  const trust = trustFn(config.TRUSTED_PROXIES);
  const agentBuild = new AgentBuild(config.AGENT_DIST_DIR || null);
  const built = await agentBuild.refresh().catch((err: unknown) => {
    app.log.warn({ err }, 'agent build scan failed');
    return null;
  });
  if (!built && config.AGENT_DIST_DIR) {
    app.log.warn({ dir: config.AGENT_DIST_DIR }, 'no agent build: /agent/latest.json answers 404, machines cannot be connected; run npm run build -w agent');
  }

  const bus = new HubBus();
  const agents = new AgentGateway({
    db,
    bus,
    log: app.log.child({ part: 'agents' }),
    badTokenLimiter: limits.agentBadToken,
    trust,
    latestAgent: () => agentBuild.latest,
    ...deps.agentGateway,
  });
  const ui = new UiGateway({
    db,
    bus,
    log: app.log.child({ part: 'ui' }),
    publicOrigins: config.publicOrigins,
    parseCookie: h => app.parseCookie(h),
    ...(deps.uiPingIntervalMs ? { pingIntervalMs: deps.uiPingIntervalMs } : {}),
    onPresence: (userId, ids) => void sessions.markRead(userId, ids).catch((err: unknown) => app.log.warn({ err }, 'mark read failed')),
    onHidden: (userId, ids, lateMs) => void sessions.onHidden(userId, ids, lateMs).catch((err: unknown) => app.log.warn({ err }, 'late hide failed')),
  });
  const s3Location = {
    region: config.AWS_REGION,
    endpoint: config.S3_ENDPOINT,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    accessKeyId: config.S3_ACCESS_KEY_ID,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY,
  };
  const store = deps.store ?? (config.S3_BUCKET_DATA ? new S3Store(config.S3_BUCKET_DATA, config.AWS_REGION, config.S3_PREFIX, createS3Client(s3Location)) : undefined);
  if (!store) app.log.warn('S3_BUCKET_DATA is not set: transcripts of other sessions are not replicated');
  // Legacy `projects` rows (path signals only, single-project-classifier): from the database only (catalog-db-session-context).
  const catalog = new ProjectCatalog({ db, log: app.log.child({ part: 'projects' }) });
  const projects: ProjectService = new ProjectService({
    db,
    catalog,
    log: app.log.child({ part: 'projects' }),
    ...(deps.projects?.debounceMs !== undefined ? { debounceMs: deps.projects.debounceMs } : {}),
    onChanged: async sessionId => {
      await sessions.upsert(sessionId).catch(() => undefined);
    },
  });
  // the classifier runs on the utility runner through the handoff one-shot; `handoff` is created further below
  const handoffRef: { current?: HandoffService } = {};
  const classifier =
    deps.projects?.classifier ??
    new SubscriptionProjectClassifier(
      (userId, p) => {
        if (!handoffRef.current) throw new Error('classifier_not_ready');
        return handoffRef.current.oneShot(userId, p);
      },
      { model: config.PROJECT_CLASSIFIER_MODEL, timeoutMs: config.PROJECT_CLASSIFIER_TIMEOUT_MS },
    );
  const detection = new CatalogDetection({ db, config, projects, classifier, changed: id => sessions.upsert(id), log: app.log.child({ part: 'projects' }) });
  projects.setCatalogDetection(detection);
  await catalog.load();
  // single-project-classifier D2: the legacy path projects removed, their sessions evaluated by the catalog.
  await projects.dropLegacy();
  // claude-subscriptions: the registry of subscriptions (tokens decrypted only to build a command to an agent)
  // provider-parity R3: Codex homes of retired or re-signed subscriptions are removed on the machines
  const codexHomes = new CodexHomesSync({ db, bus, agents, log: app.log.child({ part: 'subscriptions' }) });
  const subscriptions = new SubscriptionService({
    db,
    ui,
    log: app.log.child({ part: 'subscriptions' }),
    key: config.SUBSCRIPTION_TOKEN_KEY,
    connectorsHint: config.SUBSCRIPTION_CONNECTORS_HINT,
    ...(deps.sessions?.now ? { now: deps.sessions.now } : {}),
    codexHomesChanged: (userId, forget) => void codexHomes.sync(userId, forget),
  });
  // Web Push (change web-push-notifications D1/D2): off without the full VAPID set
  if (config.pushIncomplete) app.log.warn('push disabled: incomplete VAPID configuration');
  const vapid = config.pushEnabled ? { subject: config.VAPID_SUBJECT!, publicKey: config.VAPID_PUBLIC_KEY!, privateKey: config.VAPID_PRIVATE_KEY! } : undefined;
  // a sender of a test is trusted; the real keys are checked once: a broken set means push is off, not a hub that wipes subscriptions
  const vapidWorks = vapid !== undefined && (deps.push?.sender !== undefined || isValidVapid(vapid));
  if (vapid && !vapidWorks) app.log.warn('push disabled: the VAPID keys are not a valid pair or the subject is wrong');
  const pushEnabled = vapidWorks;
  const pushSender = deps.push?.sender ?? (pushEnabled && vapid ? createWebPushSender(vapid) : undefined);
  const push = new PushService({
    db,
    ui,
    agents,
    log: app.log.child({ part: 'push' }),
    enabled: pushEnabled,
    ...(pushSender ? { sender: pushSender } : {}),
    ...(deps.defaultLocale ? { defaultLocale: deps.defaultLocale } : {}),
    ...(deps.push?.now ? { now: deps.push.now } : {}),
  });
  await push.init();
  const sessions = new SessionService({
    push,
    subscriptions,
    projects,
    store,
    db,
    bus,
    agents,
    ui,
    log: app.log.child({ part: 'sessions' }),
    idleTimeoutMin: config.IDLE_TIMEOUT_MIN,
    permissionIdleTimeoutMin: config.PERMISSION_IDLE_TIMEOUT_MIN,
    externalWriteGuardMin: config.EXTERNAL_WRITE_GUARD_MIN,
    ...deps.sessions,
  });

  const providers = { google: deps.oidc, keycloak: deps.oidcKeycloak };
  registerAuth(app, { config, db, oidc: providers, limits, onSessionEnded: hash => ui.closeAuthSession(hash), ...(deps.defaultLocale ? { defaultLocale: deps.defaultLocale } : {}) });
  // Desktop app (change desktop-app): login through the system browser and the update feed.
  registerDesktopAuth(app, { config, db, oidc: providers, limits });
  // Change multi-user (task 5.4): the agent build and the installers.
  await registerAgentDist(app, { build: agentBuild, dir: config.AGENT_DIST_DIR || null, installersDir: config.INSTALLERS_DIR, publicUrl: config.PUBLIC_URL });
  await registerDesktopUpdates(app, { dir: config.DESKTOP_UPDATES_DIR });

  app.get('/healthz', async (_req, reply) => {
    try {
      await sql`SELECT 1`.execute(db);
      if (store) await store.check();
      return { ok: true };
    } catch (err) {
      app.log.error({ err }, 'healthz: database unavailable');
      return reply.code(503).send({ ok: false, error: 'database_unavailable' });
    }
  });

  // Requirement: Данные привязаны к пользователю — every /api query is scoped by req.user.id.
  app.get('/api/me', async (req): Promise<MeResponse> => {
    const user = req.user!;
    return {
      user: { id: user.id, email: user.email, role: user.role, name: user.name, provider: user.provider },
      vapidPublicKey: pushEnabled ? config.VAPID_PUBLIC_KEY || null : null,
      voiceInput: !!config.ELEVENLABS_API_KEY,
      voiceTalk: config.voiceTalkEnabled,
      locale: user.locale ?? null,
      accountUrl: config.accountUrl,
      singleProvider: config.singleProvider ? (config.OIDC_PROVIDER_LABEL ?? 'OIDC') : null,
    };
  });

  // Handoff drafts (D14): generated on the utility runner, sent over WS.
  const handoff = new HandoffService({
    db,
    store,
    agents,
    ui,
    subscriptions,
    log: app.log.child({ part: 'handoff' }),
    model: config.HANDOFF_MODEL,
    titleModel: config.PROJECT_CLASSIFIER_MODEL,
    titleTimeoutMs: config.SESSION_TITLE_TIMEOUT_MS,
    ...(deps.handoffTimeoutMs ? { timeoutMs: deps.handoffTimeoutMs } : {}),
  });
  handoffRef.current = handoff;
  registerApi(app, { db, sessions, handoff, agents, detection, latestAgent: () => agentBuild.latest?.version ?? null, ...(deps.files ? { files: deps.files } : {}) });
  // subscription-limits (L5): probe turns under subscription tokens and limits.event of sessions
  const limitsSvc = new LimitsService({
    db,
    bus,
    agents,
    ui,
    subscriptions,
    log: app.log.child({ part: 'limits' }),
    config: {
      enabled: config.LIMITS_PROBE_ENABLED,
      idleSec: config.LIMITS_PROBE_IDLE_SEC,
      timeoutSec: deps.limitsProbe?.timeoutMs !== undefined ? deps.limitsProbe.timeoutMs / 1000 : config.LIMITS_PROBE_TIMEOUT_SEC,
      model: config.LIMITS_PROBE_MODEL,
      refreshMinSec: config.LIMITS_REFRESH_MIN_SEC,
      lastHosts: config.LIMITS_PROBE_LAST_HOSTS,
    },
    ...(deps.limitsProbe?.tickMs !== undefined ? { tickMs: deps.limitsProbe.tickMs } : {}),
    ...(deps.limitsProbe?.jitterMs !== undefined ? { jitterMs: deps.limitsProbe.jitterMs } : {}),
    ...((deps.limitsProbe?.now ?? deps.sessions?.now) ? { now: deps.limitsProbe?.now ?? deps.sessions!.now! } : {}),
  });
  limitsSvc.start();
  registerSubscriptionsApi(app, { subscriptions, sessions, limits: limitsSvc });
  // mcp-management (M6–M8): MCP of sessions and machines
  const mcp = new McpService({
    db,
    bus,
    agents,
    ui,
    sessions,
    log: app.log.child({ part: 'mcp' }),
    publicUrl: config.PUBLIC_URL,
    ...((deps.mcp?.now ?? deps.sessions?.now) ? { now: deps.mcp?.now ?? deps.sessions!.now! } : {}),
    ...deps.mcp,
  });
  const mcpRegistry = new McpRegistryService({
    db,
    bus,
    agents,
    key: config.SUBSCRIPTION_TOKEN_KEY,
    publicUrl: config.PUBLIC_URL,
    ...deps.mcpRegistry,
    log: app.log.child({ part: 'mcp-registry' }),
  });
  registerMcpApi(app, { db, mcp, oauthRegistry: mcpRegistry });
  registerMcpRegistryApi(app, mcpRegistry);
  // session-peers (D2–D6): the agent-hub tools of sessions talk to this service
  const peers = new PeersService({
    db,
    bus,
    agents,
    sessions,
    log: app.log.child({ part: 'peers' }),
    ...((deps.peers?.now ?? deps.sessions?.now) ? { now: deps.peers?.now ?? deps.sessions!.now! } : {}),
    ...deps.peers,
  });
  registerPeersApi(app, { db });
  registerPushRoutes(app, { db, push });
  registerBlobs(app, { db, store, sessions });
  registerMultiUser(app, { config, db, bus, agents, ui, limits, build: agentBuild });
  registerVoice(app, { config, ...(deps.voice?.fetch ? { fetch: deps.voice.fetch } : {}) });
  registerVoiceTalk(app, {
    config,
    sessions,
    ...(deps.voice?.fetch ? { fetch: deps.voice.fetch } : {}),
    ...(deps.voice?.heartbeatMs ? { heartbeatMs: deps.voice.heartbeatMs } : {}),
  });

  // Content-Security-Policy for the web app (D19): own scripts (plus the inline theme script by its hash), Google Fonts,
  // images from the hub and blob:/data: previews only — a Markdown image with an external URL is not loaded.
  const csp = cspProvider(config.publicOrigins, config.WEB_DIST_DIR, config.voiceTalkEnabled ? voiceConnectSources(config.ELEVENLABS_API_URL) : []);
  app.addHook('onSend', async (_req, reply, payload) => {
    const type = String(reply.getHeader('content-type') ?? '');
    if (type.startsWith('text/html') && !reply.getHeader('content-security-policy')) {
      reply.header('Content-Security-Policy', csp());
      // A page that set its own policy (the invite page: no-referrer) keeps it.
      if (!reply.getHeader('x-content-type-options')) reply.header('X-Content-Type-Options', 'nosniff');
      if (!reply.getHeader('referrer-policy')) reply.header('Referrer-Policy', 'same-origin');
    }
    return payload;
  });

  // D3 «Восстановление»: one-time link with a transcript assembled from raw S3, fetched by the agent with its token.
  app.get('/agent-api/restore/:token', async (req, reply) => {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    const runner = m ? await findRunnerByToken(db, m[1]!) : null;
    if (!runner) return reply.code(401).send({ error: 'unauthenticated' });
    const content = sessions.replication?.takeRestore((req.params as { token: string }).token, runner.id) ?? null;
    if (!content) return reply.code(404).send({ error: 'not_found' });
    return reply.type('application/x-ndjson').send(content);
  });

  // Task 3.10: Prometheus metrics behind a bearer token (Traefik exposes the hub inside the VPN only).
  app.get('/metrics', async (req, reply) => {
    if (!config.METRICS_TOKEN) return reply.code(404).send({ error: 'not_found' });
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    if (!m || !safeEqual(hashSecret(m[1]!), hashSecret(config.METRICS_TOKEN))) return reply.code(401).send({ error: 'unauthenticated' });
    const text = await renderMetrics(db, {
      dataPath: config.DATA_VOLUME_PATH,
      ...(deps.ops?.stat ? { stat: deps.ops.stat } : {}),
      online: id => agents.isOnline(id),
      lag: async () => (sessions.replication ? sessions.replication.lag() : []),
    });
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(text);
  });

  // Free space of the Postgres volume: a Telegram warning below DISK_ALERT_FREE_PCT, at most once in 12 h.
  const send = deps.ops?.send ?? telegramSender(config.TELEGRAM_BOT_TOKEN, config.TELEGRAM_CHAT_ID, app.log.child({ part: 'alerts' }));
  const disk = new DiskWatch(db, {
    dataPath: config.DATA_VOLUME_PATH,
    thresholdPct: config.DISK_ALERT_FREE_PCT,
    hostLabel: config.ALERT_HOST_LABEL,
    ...(deps.ops?.stat ? { stat: deps.ops.stat } : {}),
    send,
    log: app.log.child({ part: 'alerts' }),
  });
  const diskCheck = () => disk.tick().catch((err: unknown) => app.log.warn({ err }, 'disk check failed'));
  const diskEvery = diskCheckPeriodMs({ dataPath: config.DATA_VOLUME_PATH, periodMs: deps.ops?.diskCheckMs ?? 10 * 60_000, injectedStat: Boolean(deps.ops?.stat) });
  if (diskEvery === 0 && !deps.ops?.stat && deps.ops?.diskCheckMs !== 0) {
    app.log.info({ path: config.DATA_VOLUME_PATH }, 'disk monitor disabled: the data volume is not mounted');
  }
  const diskTimer = diskEvery > 0 ? setInterval(() => void diskCheck(), diskEvery) : null;
  diskTimer?.unref();

  // Nightly merge of raw segments (D4): checked hourly, runs 01:00–05:00 UTC; uploads never sent are forgotten (D19).
  const merge = setInterval(() => {
    const h = new Date().getUTCHours();
    if (h >= 1 && h < 5) void sessions.replication?.mergeIdle().catch((err: unknown) => app.log.warn({ err }, 'raw merge failed'));
    void cleanupUploads(db).catch((err: unknown) => app.log.warn({ err }, 'uploads cleanup failed'));
  }, 3600_000);
  merge.unref();

  const hasWeb = existsSync(join(config.WEB_DIST_DIR, 'index.html'));
  if (hasWeb) {
    const webRoot = config.WEB_DIST_DIR;
    await app.register(fastifyStatic, {
      root: webRoot,
      wildcard: false,
      index: ['index.html'],
      // Also applies to reply.sendFile, i.e. the SPA fallback below.
      setHeaders: (reply, filePath) => {
        if (NO_CACHE_FILES.has(relative(webRoot, filePath).split(sep).join('/'))) reply.header('cache-control', 'no-cache');
      },
    });
  } else {
    app.log.warn({ dir: config.WEB_DIST_DIR }, 'web build not found, UI is not served');
  }
  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0]!;
    // Paths with a file extension are assets: a missing one is a 404, not index.html served as JS.
    const isAsset = /\.[A-Za-z0-9]+$/.test(path.split('/').pop() ?? '');
    if (hasWeb && req.method === 'GET' && !NON_SPA.test(path) && !isAsset) {
      // SPA fallback: client-side routes such as /s/<id>.
      return reply.type('text/html; charset=utf-8').sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not_found' });
  });

  app.server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/ws/agent') agents.handleUpgrade(req, socket, head);
    else if (path === '/ws/ui') ui.handleUpgrade(req, socket, head);
    else socket.destroy();
  });

  // Token reissue from the CLI (another process) reaches this hub through LISTEN/NOTIFY. The listener
  // reconnects with backoff after any loss, including failed reconnect attempts.
  const listenerLog = app.log.child({ part: 'token-listener' });
  const newListenClient = () => (deps.listenClientFactory ? deps.listenClientFactory(config.DATABASE_URL) : new pg.Client({ connectionString: config.DATABASE_URL }));
  const retryBaseMs = deps.listenRetryBaseMs ?? 1000;
  let listener: pg.Client | null = null;
  let listenAttempt = 0;
  let listenTimer: NodeJS.Timeout | null = null;
  let closing = false;
  const scheduleListen = () => {
    if (closing || listenTimer) return;
    const delay = Math.min(30_000, retryBaseMs * 2 ** Math.min(listenAttempt++, 10));
    listenerLog.info({ inMs: delay, attempt: listenAttempt }, 'token listener reconnect scheduled');
    listenTimer = setTimeout(() => {
      listenTimer = null;
      void listen();
    }, delay);
    listenTimer.unref();
  };
  const listen = async (): Promise<void> => {
    if (closing) return;
    const c = newListenClient();
    c.on('notification', n => {
      if (n.channel === TOKEN_CHANNEL && n.payload) agents.revoke(n.payload);
      // projects:reclassify from the CLI: the windows reload the sidebar without F5.
      if (n.channel === PROJECTS_CHANNEL && n.payload) {
        try {
          for (const u of JSON.parse(n.payload) as string[]) ui.broadcast(u, { type: 'projects.changed' });
        } catch {
          listenerLog.warn({ payload: n.payload.slice(0, 200) }, 'bad projects notification');
        }
      }
    });
    c.on('error', err => {
      if (listener !== c) return; // failures while connecting are handled below
      listenerLog.warn({ err: err.message }, 'token listener lost');
      listener = null;
      c.end().catch(() => undefined);
      scheduleListen();
    });
    try {
      await c.connect();
      await c.query(`LISTEN ${TOKEN_CHANNEL}`);
      await c.query(`LISTEN ${PROJECTS_CHANNEL}`);
      if (closing) {
        await c.end().catch(() => undefined);
        return;
      }
      listener = c;
      listenAttempt = 0;
      listenerLog.info('token listener connected');
    } catch (err) {
      listenerLog.warn({ err: (err as Error).message, attempt: listenAttempt + 1 }, 'token listener connect failed');
      c.end().catch(() => undefined);
      scheduleListen();
    }
  };
  await listen();

  const cleanup = setInterval(
    () => {
      void deleteExpiredSessions(db).catch((err: unknown) => app.log.warn({ err }, 'session cleanup failed'));
      // handoff drafts older than 7 days (D14)
      void handoff.expire().catch((err: unknown) => app.log.warn({ err }, 'handoff draft cleanup failed'));
      // meta.json of subagents held for a session that never appeared (30 days)
      void expireHeldMeta(db).catch((err: unknown) => app.log.warn({ err }, 'held agent meta cleanup failed'));
      // the security log keeps 90 days (spec public-access)
      void expireSecurityEvents(db).catch((err: unknown) => app.log.warn({ err }, 'security log cleanup failed'));
      // machines added but never installed (pending, code unused) for 24 h
      void deleteStalePendingRunners(db).catch((err: unknown) => app.log.warn({ err }, 'pending runner cleanup failed'));
      // a new agent build in the volume is picked up without a restart
      void agentBuild.refresh().catch(() => undefined);
    },
    60 * 60 * 1000,
  );
  cleanup.unref();

  return {
    app,
    bus,
    agents,
    ui,
    sessions,
    projects,
    handoff,
    limits: limitsSvc,
    mcp,
    mcpRegistry,
    peers,
    routes,
    async close() {
      closing = true;
      sessions.close();
      push.close();
      sessions.replication?.close();
      clearInterval(merge);
      projects.stop();
      await projects.flush();
      if (diskTimer) clearInterval(diskTimer);
      clearInterval(cleanup);
      limits.stop();
      limitsSvc.stop();
      mcp.stop();
      await agents.close();
      // probes waiting for an agent end once their commands are rejected
      await limitsSvc.flush().catch(() => undefined);
      await mcp.flush().catch(() => undefined);
      await peers.idle().catch(() => undefined);
      // drafts waiting for an agent end with an error once their requests are rejected
      await handoff.flush().catch(() => undefined);
      await ui.close();
      await app.close();
      if (listenTimer) clearTimeout(listenTimer);
      await listener?.end().catch(() => undefined);
    },
  };
}
