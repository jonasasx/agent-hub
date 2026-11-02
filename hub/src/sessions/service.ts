// Session lifecycle in the hub (design.md D3, D8, D10): commands from the UI, events from agents, idle sleep.
// Requirements: Запуск сессии из UI; Обмен сообщениями; Карточка разрешения; Прерывание хода; Смена режима
// прав и модели на ходу; Статусы сессии; Засыпание по простою; Продолжение (resume); Продолжение сессий,
// начатых вне хаба; Офлайн-машина.
import type { ProjectService } from '../projects/service.js';
import { expireMonitors } from '../subagents/background.js';
import { EXTERNAL_ACTIVE_MS } from '../replication/ingest.js';
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { sql } from 'kysely';
import type {
  AgentMessage,
  Attachment,
  HubEvent,
  HubMessage,
  ModelOption,
  PatchSessionRequest,
  PayloadOf,
  PermissionDecision,
  SessionStatus,
  SessionView,
  StatResponse,
  UiPermissionMode,
  UiServerMessage,
} from '@agent-hub/shared';
import {
  IMAGES_PROTOCOL,
  protocolAtLeast,
  PROVIDER_LABELS,
  UI_PERMISSION_MODES,
  badPathMessage,
  pathFitsPlatform,
  platformOfHome,
  providerLoginStartResultSchema,
  type CopyUnavailableReason,
  type ExtraProvider,
  type Provider,
  type ProviderLoginStart,
} from '@agent-hub/shared';
import type { Database, Db } from '../db/db.js';
import type { Insertable } from 'kysely';
import type { HubBus } from '../bus.js';
import { CommandError, type AgentConnection, type AgentGateway } from '../runners/agentGateway.js';
import type { UiGateway } from '../ui/uiGateway.js';
import { getRunner, type RunnerRow } from '../runners/repo.js';
import {
  addNote,
  findSessionByClaudeId,
  getSession,
  noteEvent,
  permissionEvent,
  selectSessions,
  sessionSleepsAt,
  toSessionView,
  type SessionBase,
  type SessionRow,
  type TimeoutDefaults,
  permissionKind,
  questionsOf,
} from './repo.js';
import { isLiveStatus } from './status.js';
import { KeyedSerial } from '../util/serial.js';
import { Replication, stripNul } from '../replication/ingest.js';
import { RawGapError } from '../replication/raw.js';
import { BlobLinks, ImageError, storeImage } from '../storage/images.js';
import type { ObjectStore } from '../storage/objectStore.js';
import type { SubscriptionCredFull, SubscriptionService } from '../subscriptions/service.js';
import { supportsCodexSubscriptions, supportsSubscriptions, tokenNewer, type SubscriptionMeta } from '../subscriptions/repo.js';

/** An API error with the D10 status and code. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = code,
    /** More fields of the error body (copy_unavailable: `reason`). */
    readonly details?: Record<string, string>,
  ) {
    super(message);
  }
}

/**
 * Requirement (runner-enrollment): Запуск под root — Claude Code refuses bypassPermissions under root: 422 before any
 * command to the agent, nothing starts and the session does not change.
 */
export function assertModeAllowed(runner: Pick<RunnerRow, 'name' | 'runs_as_root'> | undefined, mode: string | undefined): void {
  if (mode === 'bypassPermissions' && runner?.runs_as_root === true) {
    throw new HttpError(422, 'bypass_root', `Агент на ${runner.name} работает под root — режим bypassPermissions недоступен. Выберите другой режим.`);
  }
}

/**
 * agent-providers D3: a session of another provider than Claude needs it on the machine, signed in. 422
 * provider_unavailable (no such provider: no CLI, or an agent before 1.10), 422 provider_login_required.
 */
export function assertProviderReady(runner: Pick<RunnerRow, 'name' | 'providers'>, provider: Provider, underSubscription = false): void {
  if (provider === 'claude') return;
  const p = runner.providers?.find(x => x.id === provider);
  const label = PROVIDER_LABELS[provider];
  if (!p) throw new HttpError(422, 'provider_unavailable', `${label} недоступен на ${runner.name}: обновите агента`);
  // provider-parity: under a subscription of the registry the machine's own sign-in is not needed
  if (!underSubscription && p.login !== 'ok') throw new HttpError(422, 'provider_login_required', `${label}: нет подписки — добавьте её на экране «Подписки»`);
}

/** The key of a model list: the runner, and the provider when it is not Claude. */
export function modelsKey(runnerId: string, provider: Provider): string {
  return provider === 'claude' ? runnerId : `${runnerId}:${provider}`;
}
export function providerOfModelsKey(key: string): Provider {
  const i = key.lastIndexOf(':');
  return i < 0 ? 'claude' : (key.slice(i + 1) as Provider);
}

/** A copy or handoff of a bypassPermissions session onto a root machine gets acceptEdits; the chat says so. */
export const ROOT_MODE_NOTE = 'Агент на этой машине работает под root — режим bypassPermissions недоступен, сессия в режиме acceptEdits';

/** bypassPermissions of a source → acceptEdits on a machine whose agent runs as root (copy, handoff). */
export function inheritMode(mode: string, runner: Pick<RunnerRow, 'runs_as_root'> | undefined): { mode: string; downgraded: boolean } {
  return mode === 'bypassPermissions' && runner?.runs_as_root === true ? { mode: 'acceptEdits', downgraded: true } : { mode, downgraded: false };
}

/** The stderr of Claude Code started with bypassPermissions under root (an agent without hello.root). */
const ROOT_BYPASS_STDERR = /cannot be used with root\/sudo privileges/;
export const ROOT_BYPASS_NOTE = 'Claude Code не запускает режим bypassPermissions под root. Смените режим сессии (например, на acceptEdits) или переустановите агента под обычным пользователем.';

/** A raw process error as a note: the root refusal becomes advice, anything else is kept. */
export function readableProcessError(raw: string): string | null {
  return ROOT_BYPASS_STDERR.test(raw) ? ROOT_BYPASS_NOTE : null;
}

/** Why a full copy is not possible (D14 p. 1); null — possible. */
export function copyUnavailable(s: Pick<SessionRow, 'source' | 'read_only_reason' | 'cwd'>): { reason: CopyUnavailableReason; text: string } | null {
  if (s.source === 'cron' || s.read_only_reason === 'cron') return { reason: 'cron', text: 'Недоступно: cron-сессия' };
  if (s.read_only_reason === 'unknown_runner') return { reason: 'unknown_runner', text: 'Недоступно: нет каталога на машине' };
  if (s.read_only_reason === 'cwd_missing' || !s.cwd) return { reason: 'cwd_missing', text: 'Недоступно: нет каталога на машине' };
  return null;
}

/**
 * The project of a fork (D14 «Проект форка»): a pinned project stays pinned (the user's decision), any other project
 * of the source is inherited until the classifier finds a leader of the fork's own.
 */
export function forkProject(src: Pick<SessionRow, 'project_id' | 'project_source'>): { project_id: string | null; project_source: 'manual' | 'inherited' | 'none' } {
  if (src.project_source === 'manual') return { project_id: src.project_id, project_source: 'manual' };
  if (src.project_id) return { project_id: src.project_id, project_source: 'inherited' };
  return { project_id: null, project_source: 'none' };
}

export const DEFAULT_MODELS: ModelOption[] = [
  { value: 'opus', displayName: 'Opus' },
  { value: 'sonnet', displayName: 'Sonnet' },
  { value: 'haiku', displayName: 'Haiku' },
];

export interface SessionServiceOptions {
  db: Db;
  bus: HubBus;
  agents: AgentGateway;
  ui: UiGateway;
  log: FastifyBaseLogger;
  idleTimeoutMin: number;
  permissionIdleTimeoutMin: number;
  externalWriteGuardMin: number;
  /** Wait for system init after start/resume (D8: 180 s). */
  initTimeoutMs?: number;
  /** Wait for attachments.fetch (D19: 60 s). */
  attachmentFetchTimeoutMs?: number;
  /** Idle check period (D8: 30 s); 0 disables the timer (tests call checkIdle). */
  idleCheckMs?: number;
  now?: () => Date;
  /** S3 (or a test store) for replication of all transcripts (M3, D4); without it repl.* messages are ignored. */
  store?: ObjectStore;
  /** Project catalogue and classification (D9, M4); absent — every session «Без проекта». */
  projects?: ProjectService;
  /**
   * After the process of a session with an unconfirmed message is gone: wait this long for the transcript tail
   * before the message is reported as not delivered (D10 «Подтверждение доставки», 15 s).
   */
  deliveryGraceMs?: number;
  /** How long an acknowledged message waits for its transcript line at most (10 min). */
  deliveryWindowMs?: number;
  /** claude-subscriptions: the registry; absent — every process runs under the machine login (as before the change). */
  subscriptions?: SubscriptionService;
  /** Wait for cmd.ok of session.stop when switching a subscription (P6: 30 s). */
  switchStopTimeoutMs?: number;
}

/** The last user message of a session, repeated by «Продолжить под другой подпиской» and the auto switch (P6). */
interface LastMessage {
  text: string;
  attachments: Array<{ sha256: string }>;
}

/** «03:40» in the user's zone (the hub runs in UTC; Ivan is in Moscow): the text of a limit note for older clients. */
export function hhmm(d: Date): string {
  return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }).format(d);
}

/** A turn is running: working, or waiting for a permission answer inside the turn. */
function midTurn(status: SessionStatus): boolean {
  return status === 'working' || status === 'permission';
}

/**
 * A switch would cut work short (QA obs 2): a turn is running, or the session waits while its subagents or background
 * commands work («работает в фоне») — stopping the process kills them, so the switch needs `interrupt` as for a turn.
 */
function busyForSwitch(s: Pick<SessionRow, 'status' | 'children_working'>): boolean {
  return midTurn(s.status) || (s.status === 'waiting' && Number(s.children_working ?? 0) > 0);
}

/** A message the agent acknowledged (queued to Claude Code) that the transcript has not shown yet. */
interface UnconfirmedMessage {
  runnerId: string;
  claudeSessionId: string;
  text: string;
  images: number;
  /** The images of the message, for «Повторить» on the note (D10, M3c). */
  attachments: Array<{ sha256: string; mime: string; size: number }>;
  at: number;
  /** «ожидает доставки» was shown (the machine went offline with the message unconfirmed). */
  pendingNoted?: boolean;
}

/** Absolute path of a transcript on the runner: <home>/.claude/projects/<rel_path> in the runner's separators. */
export function transcriptPath(homeDir: string | null, relPath: string): string | null {
  const platform = platformOfHome(homeDir);
  if (!homeDir || !platform) return null;
  if (platform === 'windows') return `${homeDir.replace(/[\\/]+$/, '')}\\.claude\\projects\\${relPath.replaceAll('/', '\\')}`;
  return `${homeDir.replace(/\/+$/, '')}/.claude/projects/${relPath}`;
}

/** Queue key of a session: the agent knows sessions by runner + Claude session id. */
function sessionKey(runnerId: string, claudeSessionId: string): string {
  return `${runnerId}:${claudeSessionId}`;
}

/** The message in a delivery note: up to 200 characters, plus the number of images. */
function quote(text: string, images: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  const body = t ? `«${t.length > 200 ? `${t.slice(0, 200)}…` : t}»` : '';
  const pics = images ? `${body ? ' ' : ''}(изображений: ${images})` : '';
  return body + pics || '(пустое сообщение)';
}

/** Text of the first user prompt for a title: 40 characters (spec «Название сессии»). */
export function titleFromPrompt(prompt: string): string {
  const t = prompt.replace(/\s+/g, ' ').trim();
  return t.length > 40 ? `${t.slice(0, 40)}…` : t;
}

export class SessionService {
  readonly defaults: TimeoutDefaults;
  private readonly models = new Map<string, ModelOption[]>();
  /** Hub session id → the mode the user is setting (PATCH), until the agent confirms set_mode. */
  private readonly modeByUser = new Map<string, string>();

  /** clientUuid of messages already delivered (send or resume started), with the time: repeats are no-ops. */
  private readonly deliveredClientUuids = new Map<string, number>();
  /**
   * D10 «Подтверждение доставки»: cmd.ok on send/resume only means the agent queued the message to Claude Code. It is
   * delivered when its user line (uuid = clientUuid) reaches the transcript. Hub session id → clientUuid → message.
   */
  private readonly unconfirmed = new Map<string, Map<string, UnconfirmedMessage>>();
  /** clientUuid of messages reported as not delivered → session and text: a late transcript line corrects the note. */
  private readonly reportedLost = new Map<string, { sessionId: string; text: string; at: number }>();
  private readonly deliveryTimers = new Set<NodeJS.Timeout>();
  /** Sessions whose turn the user interrupted: the error result that follows gets no «ошибка» note. */
  private readonly interrupted = new Set<string>();
  /** provider-parity D3: sign-ins started for the registry, by loginId (lost on a hub restart — the sign-in is then repeated). */
  private readonly pendingSubscriptionLogins = new Map<string, { userId: string; name?: string; subscriptionId?: string }>();
  /** claude-subscriptions P6: the last user message per hub session (lost on a hub restart — then no repeat). */
  private readonly lastMessage = new Map<string, LastMessage>();
  /** claude-subscriptions P7: subscriptions that hit the limit in the current turn of a session (auto switch chain). */
  private readonly triedInTurn = new Map<string, Set<string>>();
  /** `<userId>:<title>` of copies being made (the fork runs on the agent, the row comes after): change `subagents` S10.4. */
  private readonly copyTitles = new Set<string>();
  /**
   * One queue per session (runner + Claude session id): UI commands, agent events, the sleep check and
   * reconcile of a session are applied one at a time, in arrival order.
   */
  private readonly queue = new KeyedSerial();
  private readonly timer: NodeJS.Timeout | null = null;
  private readonly initTimeoutMs: number;
  private readonly now: () => Date;

  readonly replication: Replication | null;
  private readonly blobLinks = new BlobLinks();
  /** mcp-management M7: a session with an active MCP sign-in attempt does not fall asleep before this time. */
  private sleepHold: ((sessionId: string) => Date | null) | null = null;

  constructor(private readonly o: SessionServiceOptions) {
    this.defaults = { idle: o.idleTimeoutMin, permission: o.permissionIdleTimeoutMin };
    this.initTimeoutMs = o.initTimeoutMs ?? 180_000;
    this.now = o.now ?? (() => new Date());
    this.replication = o.store
      ? new Replication({
          db: o.db,
          store: o.store,
          agents: o.agents,
          ui: o.ui,
          log: o.log,
          now: this.now,
          hooks: { upsert: id => this.upsert(id), userLines: (id, uuids) => this.onUserLines(id, uuids) },
          ...(o.projects ? { projects: o.projects } : {}),
        })
      : null;
    o.bus.on('agent.message', (runnerId, m) => {
      const sid = (m.payload as { sessionId?: unknown }).sessionId;
      const key = typeof sid === 'string' ? sessionKey(runnerId, sid) : `runner:${runnerId}`;
      void this.queue.run(key, () => this.onAgentMessage(runnerId, m)).catch((err: unknown) => o.log.error({ err, runnerId, type: m.type }, 'agent message handling failed'));
    });
    o.bus.on('agent.side', (runnerId, meta, data) => void this.replication?.onSide(runnerId, meta, data).catch((err: unknown) => o.log.warn({ err, runnerId }, 'side file failed')));
    // The machine went offline with unconfirmed messages: the chat says so at once, not after the reconnect.
    o.bus.on('runner.status', (_userId, r) => {
      if (!r.online) void this.onRunnerOffline(r.id, r.name).catch((err: unknown) => o.log.error({ err, runnerId: r.id }, 'offline delivery note failed'));
    });
    o.bus.on('agent.hello', (runnerId, _userId, hello) => void this.reconcile(runnerId, hello.liveSessions, this.now()).catch((err: unknown) => o.log.error({ err, runnerId }, 'reconcile failed')));
    const every = o.idleCheckMs ?? 30_000;
    if (every > 0) {
      this.timer = setInterval(() => {
        void this.checkIdle().catch((err: unknown) => o.log.error({ err }, 'idle check failed'));
        void this.checkExternal().catch((err: unknown) => o.log.error({ err }, 'external activity check failed'));
      }, every);
      this.timer.unref();
    }
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    for (const t of this.deliveryTimers) clearTimeout(t);
    this.deliveryTimers.clear();
  }

  /** Project catalogue and classification (M4), when configured. */
  get projects(): ProjectService | undefined {
    return this.o.projects;
  }

  /** A toast to every window of the user. */
  toast(userId: string, msg: Extract<UiServerMessage, { type: 'toast' }>): void {
    this.o.ui.broadcast(userId, msg);
  }

  view(r: SessionRow): SessionView {
    const v = toSessionView(r, this.defaults, this.o.projects?.catalog, this.now().getTime(), this.o.subscriptions?.enabled ?? false);
    // the countdown follows the sleep rule, an MCP sign-in hold included
    const at = this.sleepsAtOf(r);
    return at?.toISOString() === v.sleepsAt ? v : { ...v, sleepsAt: at ? at.toISOString() : null };
  }

  /** mcp-management M7: the hold of an MCP sign-in attempt (set by McpService). */
  setSleepHold(fn: (sessionId: string) => Date | null): void {
    this.sleepHold = fn;
  }

  /** sessionSleepsAt, not earlier than an MCP sign-in hold (Requirement: Защита потока входа MCP). */
  private sleepsAtOf(s: SessionRow): Date | null {
    const at = sessionSleepsAt(s, this.defaults);
    const hold = at ? this.sleepHold?.(s.id) : null;
    return at && hold && hold > at ? hold : at;
  }

  /** mcp-management M8: `fn` in the session's queue with the owner checked (404 for anyone else). */
  async withOwnedSession<T>(userId: string, id: string, fn: (s: SessionRow) => Promise<T>): Promise<T> {
    return this.withSession(userId, id, fn);
  }

  /**
   * mcp-management M11 (A2): wakes a sleeping session for an MCP action — the checks and the subscription of
   * «Продолжить», no user message. Call inside withOwnedSession. Resolves with a promise of the process start (cmd.ok of
   * session.resume); a live session — an already resolved one. Throws the HttpError of «Продолжить» (offline, read-only…).
   */
  async wakeForAction(s: SessionRow, userId: string): Promise<{ woke: boolean; started: Promise<void> }> {
    this.assertWritable(s);
    const { conn } = await this.onlineRunner(userId, s.runner_id);
    if (s.process_alive && isLiveStatus(s.status)) return { woke: false, started: Promise.resolve() };
    let ok!: () => void;
    let fail!: (e: unknown) => void;
    const started = new Promise<void>((res, rej) => {
      ok = res;
      fail = rej;
    });
    started.catch(() => undefined);
    await this.resume(conn, s, { force: false, onLaunch: err => (err === undefined ? ok() : fail(err)) });
    await this.upsert(s.id);
    return { woke: true, started };
  }

  /** The registry of subscriptions (claude-subscriptions), when configured. */
  get subscriptions(): SubscriptionService | undefined {
    return this.o.subscriptions;
  }

  /** The subscription of a launch on `runner` (P6): null — the machine login. `id` undefined — the default one. */
  private async credFor(userId: string, runner: RunnerRow | undefined, id?: string | null, provider: Provider = 'claude'): Promise<SubscriptionCredFull | null> {
    if (!this.o.subscriptions || !runner) return null;
    return this.o.subscriptions.credFor(userId, runner, id, provider);
  }

  /** The subscription of a command to an agent: Claude exactly as before 1.11, Codex with its provider. */
  private credPayload(cred: SubscriptionCredFull | null): { subscription: { id: string; token: string; provider?: 'codex' } } | Record<string, never> {
    if (!cred) return {};
    return { subscription: { id: cred.id, token: cred.token, ...(cred.provider === 'codex' ? { provider: 'codex' as const } : {}) } };
  }

  private rememberMessage(sessionId: string, text: string, attachments: Array<{ sha256: string }> | undefined): void {
    this.lastMessage.set(sessionId, { text, attachments: (attachments ?? []).map(a => ({ sha256: a.sha256 })) });
    // a new message of the user starts a new auto switch chain (P7)
    this.triedInTurn.delete(sessionId);
  }

  /**
   * Models for the dropdown: from the agents' supportedModels(), default list until a session ran. agent-providers:
   * another provider: the lists of its sessions and of the machines' reports (runners.providers[].models).
   */
  async listModels(userId?: string, provider: Provider = 'claude'): Promise<ModelOption[]> {
    const seen = new Map<string, ModelOption>();
    for (const [key, list] of this.models) if (providerOfModelsKey(key) === provider) for (const m of list) if (!seen.has(m.value)) seen.set(m.value, m);
    if (provider === 'claude') return seen.size > 0 ? [...seen.values()] : DEFAULT_MODELS;
    if (userId) {
      const rows = await this.o.db.selectFrom('runners').select('providers').where('user_id', '=', userId).execute();
      for (const r of rows) for (const p of r.providers ?? []) if (p.id === provider) for (const m of p.models ?? []) if (!seen.has(m.value)) seen.set(m.value, m);
    }
    return [...seen.values()];
  }

  /**
   * The default model of a provider on a machine (agent-providers): Claude: the hub's list; others: the machine's first.
   * A machine without its own sign-in reports no models (its sessions run on a subscription of the hub): the first of a
   * signed-in machine's report, not of the lists the sessions left in memory — those depend on which session ran last
   * and may name a model the ChatGPT account rejects (hub-subagents E2E: gpt-6.1-sol).
   */
  async defaultModel(userId: string, runnerId: string, provider: Provider): Promise<string> {
    if (provider === 'claude') return DEFAULT_MODELS[0]!.value;
    const runner = await this.ownedRunner(userId, runnerId);
    const own = runner.providers?.find(p => p.id === provider)?.models?.[0]?.value;
    const rows = own ? [] : await this.o.db.selectFrom('runners').select('providers').where('user_id', '=', userId).orderBy('created_at').execute();
    const reported = rows.flatMap(r => r.providers ?? []).find(p => p.id === provider && p.login === 'ok' && p.models?.length)?.models?.[0]?.value;
    const first = own ?? reported ?? (await this.listModels(userId, provider))[0]?.value;
    if (!first) throw new HttpError(422, 'provider_login_required', `${PROVIDER_LABELS[provider]}: машина ещё не сообщила модели, войдите на экране «Машины»`);
    return first;
  }

  // ---------- providers of the machine (agent-providers D10) ----------

  /** POST /api/runners/:id/providers/:provider/login: a device-code sign-in on the machine; the end comes as WS provider.login. */
  async providerLoginStart(userId: string, runnerId: string, provider: ExtraProvider): Promise<ProviderLoginStart> {
    const { runner, conn } = await this.onlineRunner(userId, runnerId);
    if (!runner.providers?.some(p => p.id === provider)) throw new HttpError(422, 'provider_unavailable', `${PROVIDER_LABELS[provider]} недоступен на ${runner.name}: обновите агента`);
    try {
      const r = await conn.request('provider.login.start', { provider }, 90_000);
      const parsed = providerLoginStartResultSchema.safeParse(r);
      if (!parsed.success) throw new HttpError(502, 'agent_bad_reply', 'Агент не вернул код входа');
      return parsed.data;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw this.agentError(err, runner);
    }
  }

  /**
   * POST /api/subscriptions/codex-login (provider-parity D3): a device-code ChatGPT sign-in in a temporary CODEX_HOME on
   * the machine. The end comes as provider.login.done with the auth.json; the hub stores it as a new subscription
   * `name` or as the credential of `subscriptionId`.
   */
  async codexSubscriptionLoginStart(userId: string, b: { runnerId: string; name?: string | undefined; subscriptionId?: string | undefined }): Promise<ProviderLoginStart> {
    const subs = this.o.subscriptions;
    if (!subs?.enabled) throw new HttpError(503, 'subscriptions_disabled', 'Хранение токенов не настроено: задайте SUBSCRIPTION_TOKEN_KEY');
    const { runner, conn } = await this.onlineRunner(userId, b.runnerId);
    if (!supportsCodexSubscriptions(runner.protocol_version) || !runner.providers?.some(p => p.id === 'codex')) {
      throw new HttpError(409, 'agent_outdated', `Агент на ${runner.name} не умеет входить в Codex под подписку — обновите агента`);
    }
    if (b.subscriptionId) {
      const s = await subs.ownMeta(userId, b.subscriptionId);
      if (s.provider !== 'codex') throw new HttpError(422, 'subscription_unavailable', 'Это не подписка Codex');
    } else {
      await subs.assertNameFree(userId, 'codex', (b.name ?? 'Codex').trim());
    }
    try {
      const r = await conn.request('provider.login.start', { provider: 'codex', forSubscription: true }, 90_000);
      const parsed = providerLoginStartResultSchema.safeParse(r);
      if (!parsed.success) throw new HttpError(502, 'agent_bad_reply', 'Агент не вернул код входа');
      this.pendingSubscriptionLogins.set(parsed.data.loginId, {
        userId,
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.subscriptionId !== undefined ? { subscriptionId: b.subscriptionId } : {}),
      });
      return parsed.data;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw this.agentError(err, runner);
    }
  }

  /** The end of a sign-in for a subscription: the credential is stored, the client is told with the subscription id. */
  private async onSubscriptionLoginDone(runnerUserId: string, p: PayloadOf<AgentMessage, 'provider.login.done'>): Promise<{ ok: boolean; error?: string; subscriptionId?: string }> {
    const pending = this.pendingSubscriptionLogins.get(p.loginId);
    if (!pending) return { ok: p.ok, ...(p.error ? { error: p.error } : {}) };
    this.pendingSubscriptionLogins.delete(p.loginId);
    const subs = this.o.subscriptions;
    if (!p.ok || !p.credential || !subs || pending.userId !== runnerUserId) return { ok: false, error: p.error ?? 'Вход не завершён' };
    try {
      if (pending.subscriptionId) {
        await subs.replaceToken(pending.userId, pending.subscriptionId, p.credential);
        return { ok: true, subscriptionId: pending.subscriptionId };
      }
      const v = await subs.createCodex(pending.userId, pending.name ?? 'Codex', p.credential);
      return { ok: true, subscriptionId: v.id };
    } catch (err) {
      this.o.log.warn({ err: (err as Error).message }, 'codex subscription sign-in could not be stored');
      return { ok: false, error: err instanceof HttpError ? err.message : 'Не удалось сохранить вход' };
    }
  }

  /** DELETE /api/runners/:id/providers/:provider/login/:loginId: the sign-in is cancelled on the machine. */
  async providerLoginCancel(userId: string, runnerId: string, provider: ExtraProvider, loginId: string): Promise<void> {
    const { runner, conn } = await this.onlineRunner(userId, runnerId);
    try {
      await conn.request('provider.login.cancel', { provider, loginId }, 30_000);
    } catch (err) {
      throw this.agentError(err, runner);
    }
  }

  /** POST /api/runners/:id/providers/:provider/logout. */
  async providerLogout(userId: string, runnerId: string, provider: ExtraProvider): Promise<void> {
    const { runner, conn } = await this.onlineRunner(userId, runnerId);
    try {
      await conn.request('provider.logout', { provider }, 60_000);
    } catch (err) {
      throw this.agentError(err, runner);
    }
  }

  /** Runs `fn` in the session's queue with the session re-read inside it. */
  private async withSession<T>(userId: string, id: string, fn: (s: SessionRow) => Promise<T>): Promise<T> {
    const first = await this.get(userId, id);
    return this.queue.run(sessionKey(first.runner_id, first.claude_session_id), async () => fn(await this.get(userId, id)));
  }

  async get(userId: string, id: string): Promise<SessionRow> {
    const s = await getSession(this.o.db, id, userId);
    if (!s) throw new HttpError(404, 'not_found', 'Сессия не найдена');
    return s;
  }

  // ---------- commands from the UI ----------

  /** GET /api/runners/:id/stat */
  async stat(userId: string, runnerId: string, path: string): Promise<StatResponse> {
    // D10 «Пути по ОС раннера»: a path of the wrong kind is refused before any command to the agent.
    const runner = await this.ownedRunner(userId, runnerId);
    this.checkPath(runner, path);
    const { conn } = await this.onlineRunner(userId, runnerId);
    return this.fsStat(conn, path, runner);
  }

  /** POST /api/sessions. Requirement: Запуск сессии из UI */
  async create(
    userId: string,
    b: {
      runnerId: string;
      cwd: string;
      permissionMode: UiPermissionMode;
      model: string;
      prompt: string;
      attachments?: Array<{ sha256: string }> | undefined;
      subscriptionId?: string | null | undefined;
      provider?: Provider | undefined;
      catalogProjectId?: string | undefined;
    },
    fork?: { source: SessionRow },
    spawn?: { parentId: string; task: string; title?: string | undefined },
  ): Promise<SessionView> {
    const provider: Provider = b.provider ?? 'claude';
    this.checkPath(await this.ownedRunner(userId, b.runnerId), b.cwd);
    const { runner, conn } = await this.onlineRunner(userId, b.runnerId);
    assertModeAllowed(runner, b.permissionMode);
    // agent-providers D3: another provider must be installed and signed in on the machine
    // claude-subscriptions P6: the chosen subscription (checked: 422 subscription_unavailable, 409 token_unreadable)
    // before anything is created; none — the machine login, the command exactly as before the change. provider-parity:
    // the same for Codex — its subscription is a ChatGPT sign-in of the registry.
    const cred = await this.credFor(userId, runner, b.subscriptionId, provider);
    assertProviderReady(runner, provider, !!cred);
    const attachments = await this.attachments(userId, runner, b.attachments);
    const st = await this.fsStat(conn, b.cwd, runner);
    if (!st.exists || !st.isDir) throw new HttpError(422, 'cwd_not_found', `Каталог не найден на ${runner.name}`);
    // D19: the images are on the machine before the session exists; a failure is 502 and nothing is created.
    await this.prefetch(conn, runner, attachments);
    // hub-subagents D9: a spawned session belongs to the project of its parent, as a fork does
    const parent = spawn ? await getSession(this.o.db, spawn.parentId) : undefined;
    const id = randomUUID();
    const now = this.now();
    const sessionValues: Insertable<Database['sessions']> = {
      id,
      user_id: userId,
      runner_id: runner.id,
      claude_session_id: id,
      cwd: b.cwd,
      provider,
      source: 'hub',
      origin_source: 'hub',
      is_hub_managed: true,
      // hub-subagents D4: the title of a spawned session is the given one or the task, not the peer envelope
      title: spawn ? spawn.title?.trim() || titleFromPrompt(spawn.task) : titleFromPrompt(b.prompt) || (attachments.length ? 'Изображение' : ''),
      title_source: 'prompt',
      status: 'working',
      process_alive: true,
      process_started_at: now,
      permission_mode: b.permissionMode,
      model: b.model,
      last_input_at: now,
      created_at: now,
      ...(cred ? { subscription_id: cred.id, subscription_token_at: cred.tokenUpdatedAt } : {}),
      // handoff (D14): the fork mark and the project of the source
      ...(fork ? this.forkFields(fork.source, 'handoff') : {}),
      ...(parent ? forkProject(parent) : {}),
      // hub-subagents D3: the link to the parent and the report the first turn owes it
      ...(spawn ? { spawned_by: spawn.parentId, report_to_session_id: spawn.parentId, report_since: now } : {}),
    };
    await this.o.db.transaction().execute(async tx => {
      await tx.insertInto('sessions').values(sessionValues).execute();
      if (b.catalogProjectId) {
        await tx.insertInto('session_projects').values({ user_id: userId, session_id: id, project_id: b.catalogProjectId, source: 'explicit', confidence: null }).execute();
      }
    });
    if (fork) await this.pinIfManual(userId, id, fork.source);
    if (parent) await this.pinIfManual(userId, id, parent);
    // an explicit choice in the form is the last choice; the default one stays as it is
    if (cred && b.subscriptionId) await this.o.subscriptions!.setLastChoice(userId, cred.id);
    this.rememberMessage(id, b.prompt, b.attachments);
    const view = await this.upsert(id);
    this.launch(conn, id, 'session.start', {
      sessionId: id,
      cwd: b.cwd,
      ...(b.catalogProjectId && protocolAtLeast(runner.protocol_version, '1.13') ? { projectId: b.catalogProjectId } : {}),
      permissionMode: b.permissionMode,
      model: b.model,
      prompt: b.prompt,
      promptUuid: randomUUID(),
      ...(attachments.length ? { attachments } : {}),
      ...this.credPayload(cred),
      // a Claude command stays exactly as before 1.10
      ...(provider !== 'claude' ? { provider } : {}),
    });
    if (attachments.length) await this.markUsed(userId, attachments);
    return view;
  }

  // ---------- fork (D14, M4b) ----------

  /** fork_of, fork_mode and the inherited project of a fork row. */
  private forkFields(src: SessionRow, mode: 'copy' | 'handoff') {
    const p = forkProject(src);
    return { fork_of: src.id, fork_mode: mode, project_id: p.project_id, project_source: p.project_source, project_evidence: null, secondary_project_id: null };
  }

  /** A pinned project of the source is pinned in the fork too (the label of «Перенести в…», D10). */
  private async pinIfManual(userId: string, forkId: string, src: SessionRow): Promise<void> {
    if (src.project_source !== 'manual') return;
    await this.o.db
      .insertInto('classification_labels')
      .values({ session_id: forkId, project_id: src.project_id, user_id: userId })
      .onConflict(oc => oc.column('session_id').doUpdateSet({ project_id: src.project_id }))
      .execute();
  }

  /**
   * POST /api/sessions/:id/fork {mode:'copy'} (D14 «Полная копия»): forkSession on the source's machine into a new
   * session of the same directory, mode and model; nothing starts (the copy is resumed on its first message), the
   * source is not touched. A transcript missing on the machine is restored from the hub's copy first.
   * Requirement (session-fork): Полная копия.
   */
  async forkCopy(userId: string, id: string): Promise<SessionView> {
    return this.withSession(userId, id, async s => {
      const no = copyUnavailable(s);
      if (no) throw new HttpError(409, 'copy_unavailable', no.text, { reason: no.reason });
      const { runner, conn } = await this.onlineRunner(userId, s.runner_id);
      const cwd = s.cwd!;
      if (!pathFitsPlatform(cwd, platformOfHome(runner.home_dir))) throw new HttpError(409, 'copy_unavailable', 'Недоступно: нет каталога на машине', { reason: 'cwd_missing' });
      const st = await this.fsStat(conn, cwd, runner);
      if (!st.exists || !st.isDir) {
        await this.o.db.updateTable('sessions').set({ read_only_reason: 'cwd_missing' }).where('id', '=', s.id).execute();
        await this.upsert(s.id);
        throw new HttpError(409, 'copy_unavailable', 'Недоступно: нет каталога на машине', { reason: 'cwd_missing' });
      }
      // agent-providers D3: a Codex mirror does not restore the Codex thread; the agent checks the mirror itself
      if (s.provider === 'claude') await this.restoreIfMissing(conn, s, runner);
      const title = await this.copyTitle(userId, s.title || 'Сессия');
      try {
        return await this.forkCopyAs(userId, s, runner, conn, cwd, title);
      } finally {
        this.copyTitles.delete(`${userId}:${title}`);
      }
    });
  }

  /** The fork of a full copy under its reserved name and the row of the copy. */
  private async forkCopyAs(userId: string, s: SessionRow, runner: RunnerRow, conn: AgentConnection, cwd: string, title: string): Promise<SessionView> {
    let newSid: string;
    try {
      const r = (await conn.request('session.fork', { sourceSessionId: s.claude_session_id, cwd, title, ...(s.provider !== 'claude' ? { provider: s.provider } : {}) }, 60_000)) as
        { newSessionId?: unknown } | undefined;
      if (typeof r?.newSessionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(r.newSessionId)) throw new HttpError(502, 'agent_bad_reply', 'Агент не вернул идентификатор копии');
      newSid = r.newSessionId.toLowerCase();
    } catch (err) {
      if (err instanceof CommandError && err.code === 'not_implemented') throw new HttpError(409, 'agent_outdated', `Агент на ${runner.name} устарел и не умеет копировать сессии — обновите агента`);
      throw this.agentError(err, runner);
    }
    const now = this.now();
    const inherited = inheritMode(s.permission_mode, runner);
    const values = {
      source: 'hub' as const,
      origin_source: 'hub' as const,
      is_hub_managed: true,
      cwd,
      title,
      title_source: 'custom' as const,
      status: 'waiting' as const,
      process_alive: false,
      permission_mode: inherited.mode,
      model: s.model,
      provider: s.provider,
      last_turn_end_at: now,
      ...this.forkFields(s, 'copy'),
    };
    // The replication of the new .jsonl may have made the row already (an unknown session of the machine).
    const row = await this.o.db
      .insertInto('sessions')
      .values({ id: newSid, user_id: userId, runner_id: s.runner_id, claude_session_id: newSid, created_at: now, ...values })
      .onConflict(oc => oc.columns(['runner_id', 'claude_session_id']).doUpdateSet(values))
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.pinIfManual(userId, row.id, s);
    if (inherited.downgraded) await this.emitEvents({ id: row.id, user_id: userId }, [await addNote(this.o.db, row.id, 'mode', ROOT_MODE_NOTE)]);
    return this.upsert(row.id);
  }

  /**
   * The name of a copy (change `subagents` S10.4): the base without «(копия)»/«(копия N)» and the next free number among
   * the user's sessions of that base — «X (копия)», then «X (копия 2)», «X (копия 3)».
   */
  private async copyTitle(userId: string, title: string): Promise<string> {
    const base = title.replace(/\s*\(копия(?: \d+)?\)$/u, '').slice(0, 180) || 'Сессия';
    // LIKE escapes: \ % _ of the base are literal
    const like = `${base.replace(/[\\%_]/g, c => `\\${c}`)} (копия%`;
    const rows = await this.o.db.selectFrom('sessions').select('title').where('user_id', '=', userId).where('title', 'like', like).execute();
    let max = 0;
    // names given to copies still being made (the agent forks, the row comes after): two copies at once differ
    const pending = [...this.copyTitles].filter(k => k.startsWith(`${userId}:`)).map(k => ({ title: k.slice(userId.length + 1) }));
    for (const r of [...rows, ...pending]) {
      const m = /\(копия(?: (\d+))?\)$/u.exec(r.title.slice(base.length));
      if (m && r.title.slice(0, base.length) === base) max = Math.max(max, m[1] ? Number(m[1]) : 1);
    }
    const name = max === 0 ? `${base} (копия)` : `${base} (копия ${max + 1})`;
    this.copyTitles.add(`${userId}:${name}`);
    return name;
  }

  /**
   * POST /api/sessions/:id/fork {mode:'handoff'} (D14 «Handoff» p. 4): a new session on the chosen runner and
   * directory (checked like POST /api/sessions) with the prompt as its first message; the source may be offline.
   * Requirement (session-fork): Handoff.
   */
  async forkHandoff(
    userId: string,
    id: string,
    b: {
      prompt: string;
      runnerId: string;
      cwd: string;
      permissionMode?: UiPermissionMode | undefined;
      model?: string | undefined;
      subscriptionId?: string | null | undefined;
      provider?: Provider | undefined;
    },
  ): Promise<SessionView> {
    const s = await this.get(userId, id);
    const own = (UI_PERMISSION_MODES as readonly string[]).includes(s.permission_mode) ? (s.permission_mode as UiPermissionMode) : 'default';
    const provider: Provider = b.provider ?? 'claude';
    // a session started outside the hub has no model: the hub's default list (Opus first); another provider than the
    // source's: the first model the machine reported for it
    const model = b.model ?? (provider === s.provider ? s.model : null) ?? (await this.defaultModel(userId, b.runnerId, provider));
    // runner-enrollment «Запуск под root»: an inherited bypassPermissions becomes acceptEdits on a root machine (an
    // explicit choice in the form stays and gets 422 bypass_root)
    const inherited = b.permissionMode === undefined ? inheritMode(own, await this.ownedRunner(userId, b.runnerId)) : { mode: b.permissionMode, downgraded: false };
    const view = await this.create(
      userId,
      { runnerId: b.runnerId, cwd: b.cwd, permissionMode: inherited.mode as UiPermissionMode, model, prompt: b.prompt, subscriptionId: b.subscriptionId, provider },
      { source: s },
    );
    if (inherited.downgraded) await this.emitEvents({ id: view.id, user_id: userId }, [await addNote(this.o.db, view.id, 'mode', ROOT_MODE_NOTE)]);
    return view;
  }

  /** POST /api/sessions/:id/messages. Requirement: Обмен сообщениями; Продолжение (resume) */
  async sendMessage(userId: string, id: string, b: { text: string; clientUuid: string; force?: boolean | undefined; peerFrom?: string | undefined }): Promise<SessionView> {
    // QA B2: a waiting process launched with a token since replaced stops first; the message goes in a later step of
    // the queue, behind session.exited of that process (as a switch does), and resumes with the current token
    await this.withSession(userId, id, async s => {
      if (s.process_alive && s.status === 'waiting' && Number(s.children_working ?? 0) === 0 && !s.read_only_reason && this.o.agents.get(s.runner_id) && (await this.tokenReplaced(s)))
        await this.sleep(s);
    });
    return this.withSession(userId, id, s => this.doSendMessage(s, userId, b));
  }

  private async doSendMessage(
    s: SessionRow,
    userId: string,
    b: { text: string; clientUuid: string; force?: boolean | undefined; attachments?: Array<{ sha256: string }> | undefined; peerFrom?: string | undefined },
  ): Promise<SessionView> {
    this.assertWritable(s);
    // A repeat of a delivered message (lost response, double click) is a no-op. Only delivery marks the uuid:
    // a request refused with 409/423/5xx can be repeated with the same clientUuid («Продолжить всё равно»).
    // An acknowledged message still unconfirmed whose process is gone (machine back, the note not shown yet): the
    // repeat delivers it now and the pending check is dropped, so no «не доставлено» follows a delivered repeat.
    const pending = this.unconfirmed.get(s.id)?.get(b.clientUuid);
    if (pending && this.isDelivered(b.clientUuid) && !(s.process_alive && isLiveStatus(s.status)) && !(await this.seenInTranscript(s.id, [b.clientUuid])).length) {
      this.forgetUnconfirmed(s.id, b.clientUuid);
      this.deliveredClientUuids.delete(b.clientUuid);
    }
    if (this.isDelivered(b.clientUuid)) return this.view(s);
    // A repeat after «не доставлено»: a later line of it is this delivery, not «всё же дошло».
    this.reportedLost.delete(b.clientUuid);
    // The transcript already has the message (a repeat after a lost response or after a note that came too early).
    if ((await this.seenInTranscript(s.id, [b.clientUuid])).length) {
      this.markDelivered(b.clientUuid);
      return this.view(s);
    }
    const { conn, runner } = await this.onlineRunner(userId, s.runner_id);
    const attachments = await this.attachments(userId, runner, b.attachments);
    // D19: send and resume go out only after the agent has every image; a failure is 502, the session is untouched
    // and the clientUuid stays unmarked, so «Повторить» repeats the same message.
    await this.prefetch(conn, runner, attachments);
    // hub-subagents D5: the mark goes in before the send (a fast result must find it); a failed send puts the old one back
    const report = this.reportFields(s, b.peerFrom);
    const hasReport = Object.keys(report).length > 0;
    const setReport = (v: typeof report) => this.o.db.updateTable('sessions').set(v).where('id', '=', s.id).execute();
    const restoreReport = () => setReport({ report_to_session_id: s.report_to_session_id ?? null, report_since: s.report_since ?? null, report_queued: s.report_queued });
    if (hasReport) await setReport(report);
    if (s.process_alive && isLiveStatus(s.status)) {
      try {
        await conn.request('session.send', { sessionId: s.claude_session_id, text: b.text, promptUuid: b.clientUuid, ...(attachments.length ? { attachments } : {}) }, 120_000);
        this.rememberMessage(s.id, b.text, b.attachments);
        this.markDelivered(b.clientUuid);
        this.trackUnconfirmed(s.id, conn.runnerId, s.claude_session_id, b.clientUuid, b.text, attachments);
        if (attachments.length) await this.markUsed(userId, attachments);
        await this.o.db
          .updateTable('sessions')
          .set({ last_input_at: this.now(), unread: false, ...(s.status === 'waiting' ? { status: 'working' as const } : {}) })
          .where('id', '=', s.id)
          .execute();
        return this.upsert(s.id);
      } catch (err) {
        if (!(err instanceof CommandError && err.code === 'not_running')) {
          if (hasReport) await restoreReport();
          throw this.agentError(err);
        }
        // The hub thought the process was alive; the agent has none: resume instead.
      }
    }
    // Marked before the launch: a launch that fails at once unmarks the uuid in its handler, not the other way round.
    this.markDelivered(b.clientUuid);
    this.trackUnconfirmed(s.id, conn.runnerId, s.claude_session_id, b.clientUuid, b.text, attachments);
    try {
      await this.resume(conn, s, { prompt: b.text, promptUuid: b.clientUuid, force: b.force === true, attachments });
    } catch (err) {
      this.deliveredClientUuids.delete(b.clientUuid);
      this.forgetUnconfirmed(s.id, b.clientUuid);
      if (hasReport) await restoreReport();
      throw err;
    }
    this.rememberMessage(s.id, b.text, b.attachments);
    if (attachments.length) await this.markUsed(userId, attachments);
    return this.upsert(s.id);
  }

  /**
   * hub-subagents D5: who the turn of a delivered message reports to. The parent's message expects a report; the user's
   * clears it; another session's message leaves it as it is.
   */
  private reportFields(s: SessionBase, peerFrom: string | undefined): { report_to_session_id?: string | null; report_since?: Date | null; report_queued?: number } {
    if (peerFrom === undefined) return s.report_to_session_id ? { report_to_session_id: null, report_since: null, report_queued: 0 } : {};
    if (s.spawned_by && peerFrom === s.spawned_by) {
      // the message queued behind a running turn owes a report of its own turn: the running one reports first
      if (s.report_to_session_id && s.process_alive && midTurn(s.status)) return { report_queued: s.report_queued + 1 };
      return { report_to_session_id: peerFrom, report_since: this.now(), report_queued: 0 };
    }
    return {};
  }

  /** POST /api/sessions/:id/wake — «Продолжить»: resume without a message. */
  async wake(userId: string, id: string, force: boolean): Promise<SessionView> {
    return this.withSession(userId, id, s => this.doWake(s, userId, force));
  }

  private async doWake(s: SessionRow, userId: string, force: boolean): Promise<SessionView> {
    this.assertWritable(s);
    const { conn } = await this.onlineRunner(userId, s.runner_id);
    if (s.process_alive && isLiveStatus(s.status)) return this.view(s);
    await this.resume(conn, s, { force });
    return this.upsert(s.id);
  }

  /** POST /api/sessions/:id/interrupt. Requirement: Прерывание хода */
  async interrupt(userId: string, id: string): Promise<SessionView> {
    return this.withSession(userId, id, s => this.doInterrupt(s, userId));
  }

  private async doInterrupt(s: SessionRow, userId: string): Promise<SessionView> {
    if (!s.process_alive || !isLiveStatus(s.status)) throw new HttpError(409, 'not_running', 'Сессия не выполняет ход');
    const { conn } = await this.onlineRunner(userId, s.runner_id);
    try {
      this.interrupted.add(s.id);
      await conn.request('session.interrupt', { sessionId: s.claude_session_id });
    } catch (err) {
      this.interrupted.delete(s.id);
      throw this.agentError(err);
    }
    await this.closeOpenPermissions(s, 'Ход прерван');
    await this.o.db.updateTable('sessions').set({ status: 'waiting', last_turn_end_at: this.now() }).where('id', '=', s.id).execute();
    await this.emitEvents(s, [await addNote(this.o.db, s.id, 'interrupt', 'Ход прерван')]);
    return this.upsert(s.id);
  }

  /** PATCH /api/sessions/:id. Requirement: Смена режима прав и модели на ходу; Засыпание по простою */
  async patch(userId: string, id: string, b: PatchSessionRequest): Promise<SessionView> {
    return this.withSession(userId, id, s => this.doPatch(s, userId, b));
  }

  private async doPatch(s: SessionRow, userId: string, b: PatchSessionRequest): Promise<SessionView> {
    const changesProcess = (b.permissionMode !== undefined && b.permissionMode !== s.permission_mode) || (b.model !== undefined && b.model !== s.model);
    if (changesProcess) this.assertWritable(s);
    const live = s.process_alive && isLiveStatus(s.status);
    const notes: HubEvent[] = [];
    if (changesProcess) {
      // Requirement «Офлайн-машина»: mode and model are not changed while the machine is offline.
      const { runner, conn } = await this.onlineRunner(userId, s.runner_id);
      if (b.permissionMode !== s.permission_mode) assertModeAllowed(runner, b.permissionMode);
      try {
        if (live && b.permissionMode !== undefined && b.permissionMode !== s.permission_mode) {
          // the user's choice wins: until the agent confirms it, a mode in session.state is not taken (review M4b)
          this.modeByUser.set(s.id, b.permissionMode);
          try {
            await conn.request('session.set_mode', { sessionId: s.claude_session_id, mode: b.permissionMode });
          } finally {
            this.modeByUser.delete(s.id);
          }
        }
        if (live && b.model !== undefined && b.model !== s.model) await conn.request('session.set_model', { sessionId: s.claude_session_id, model: b.model });
      } catch (err) {
        if (!(err instanceof CommandError && err.code === 'not_running')) throw this.agentError(err);
      }
    }
    await this.o.db
      .updateTable('sessions')
      .set({
        ...(b.permissionMode !== undefined ? { permission_mode: b.permissionMode } : {}),
        ...(b.model !== undefined ? { model: b.model } : {}),
        ...(b.idleTimeoutMin !== undefined ? { idle_timeout_min: b.idleTimeoutMin } : {}),
      })
      .where('id', '=', s.id)
      .execute();
    if (b.permissionMode !== undefined && b.permissionMode !== s.permission_mode) {
      notes.push(await addNote(this.o.db, s.id, 'mode', `Режим прав: ${b.permissionMode}`));
      if (live) this.o.ui.broadcast(userId, { type: 'toast', kind: 'mode_changed', sessionId: s.id, text: 'Режим прав изменён — со следующего хода' });
    }
    if (b.model !== undefined && b.model !== s.model) notes.push(await addNote(this.o.db, s.id, 'model', `Модель: ${b.model}`));
    if (notes.length) await this.emitEvents(s, notes);
    return this.upsert(s.id);
  }

  /** POST /api/sessions/:id/permissions/:requestId. Requirement: Карточка разрешения */
  async resolvePermission(
    userId: string,
    id: string,
    requestId: string,
    decision: PermissionDecision,
    extra: { answers?: Record<string, string | string[]> | undefined; message?: string | undefined } = {},
  ) {
    return this.withSession(userId, id, s => this.doResolvePermission(s, userId, requestId, decision, extra));
  }

  private async doResolvePermission(
    s: SessionRow,
    userId: string,
    requestId: string,
    decision: PermissionDecision,
    extra: { answers?: Record<string, string | string[]> | undefined; message?: string | undefined } = {},
  ) {
    const req = /^[0-9a-f-]{36}$/i.test(requestId)
      ? await this.o.db.selectFrom('permission_requests').selectAll().where('request_id', '=', requestId).where('session_id', '=', s.id).executeTakeFirst()
      : undefined;
    if (!req) throw new HttpError(404, 'not_found', 'Запрос разрешения не найден');
    if (req.resolved_at) throw new HttpError(409, 'already_resolved', 'Запрос уже решён');
    // M4b: questions and plans have their own answers (D3 «Вопросы и план»)
    const kind = permissionKind(req.tool_name);
    let answers: Record<string, string> | undefined;
    let message = extra.message?.trim() || undefined;
    if (kind !== 'tool' && decision === 'allow_session') throw new HttpError(422, 'bad_decision', 'Для вопроса и плана нет решения «в этой сессии»');
    if (kind === 'question' && decision === 'allow') {
      const qs = questionsOf(req.input);
      answers = {};
      for (const q of qs) {
        const a = extra.answers?.[q.question];
        const text = Array.isArray(a)
          ? a
              .map(x => x.trim())
              .filter(Boolean)
              .join(', ')
          : (a ?? '').trim();
        if (!text) throw new HttpError(422, 'bad_answers', `Нет ответа на вопрос «${q.question}»`);
        answers[q.question] = text;
      }
    }
    if (kind === 'question' && decision === 'deny') message = message ?? 'Пользователь отказался отвечать';
    if (kind === 'plan' && decision === 'deny') message = message ?? 'Пользователь не утвердил план — продолжи планирование';
    const conn = this.o.agents.get(s.runner_id);
    if (!conn) throw new HttpError(409, 'runner_offline', 'Машина не в сети');
    // Mark first: a concurrent answer from another device gets 409.
    const upd = await this.o.db
      .updateTable('permission_requests')
      .set({ resolved_at: this.now(), decision, scope: decision === 'allow_session' ? 'session' : 'once', ...(answers ? { answers: JSON.stringify(answers) } : {}), ...(message ? { message } : {}) })
      .where('request_id', '=', requestId)
      .where('resolved_at', 'is', null)
      .returningAll()
      .executeTakeFirst();
    if (!upd) throw new HttpError(409, 'already_resolved', 'Запрос уже решён');
    conn.send('permission.response', {
      requestId,
      behavior: decision === 'deny' ? 'deny' : 'allow',
      scope: decision === 'allow_session' ? 'session' : 'once',
      ...(message ? { message } : {}),
      ...(answers ? { answers } : {}),
    });
    await this.afterPermissionResolved(s, upd.request_id, decision);
    return { request: permissionEvent(upd) };
  }

  // ---------- agent events ----------

  private async onAgentMessage(runnerId: string, m: AgentMessage): Promise<void> {
    switch (m.type) {
      case 'session.state':
        return this.onState(runnerId, m.payload);
      case 'session.partial': {
        const s = await findSessionByClaudeId(this.o.db, runnerId, m.payload.sessionId);
        if (s)
          this.o.ui.sendToSubscribers(s.user_id, s.id, { type: 'session.partial', sessionId: s.id, messageId: m.payload.messageId, blockIndex: m.payload.blockIndex, textDelta: m.payload.textDelta });
        return;
      }
      case 'session.result':
        return this.onResult(runnerId, m.payload);
      case 'session.exited':
        return this.onExited(runnerId, m.payload);
      case 'permission.request':
        return this.onPermissionRequest(runnerId, m.payload);
      case 'repl.chunk':
        return this.replication?.onChunk(runnerId, m.payload);
      case 'repl.meta':
        return this.replication?.onMeta(runnerId, m.payload);
      case 'repl.agent_meta':
        return this.replication?.onAgentMeta(runnerId, m.payload);
      case 'repl.files':
        return this.replication?.onFiles(runnerId, m.payload);
      case 'provider.login.done': {
        const runner = await getRunner(this.o.db, runnerId);
        if (runner) {
          const r = await this.onSubscriptionLoginDone(runner.user_id, m.payload);
          this.o.ui.broadcast(runner.user_id, {
            type: 'provider.login',
            runnerId,
            provider: m.payload.provider,
            loginId: m.payload.loginId,
            ok: r.ok,
            ...(r.error ? { error: r.error } : {}),
            ...(r.subscriptionId ? { subscriptionId: r.subscriptionId } : {}),
          });
        }
        return;
      }
      case 'provider.credential.update': {
        // provider-parity D4: Codex rotated its tokens; only a subscription of the machine's owner is touched
        const runner = await getRunner(this.o.db, runnerId);
        const subs = this.o.subscriptions;
        if (runner && subs && (await subs.byId(m.payload.subscriptionId))?.user_id === runner.user_id) await subs.refreshCodex(m.payload.subscriptionId, m.payload.credential);
        return;
      }
      default:
        return;
    }
  }

  private async onState(runnerId: string, p: PayloadOf<AgentMessage, 'session.state'>): Promise<void> {
    const s = await findSessionByClaudeId(this.o.db, runnerId, p.sessionId);
    if (!s) return;
    if (p.state !== 'permission') await this.closeOpenPermissions(s, 'Запрос отменён');
    // M4b: the mode the process actually runs in — taken only when it cannot undo the user's choice: the mode being
    // set by the user (until set_mode is confirmed), or leaving plan mode by an approved plan. Any other report (a
    // stale state from before a change in the header) is ignored: «bypass» must never come back by itself.
    const byUser = this.modeByUser.get(s.id);
    const reported = p.permissionMode && p.permissionMode !== s.permission_mode ? p.permissionMode : null;
    const mode = reported && (byUser ? reported === byUser : s.permission_mode === 'plan') ? reported : null;
    if (s.status === p.state && s.process_alive === p.processAlive && !mode) return;
    await this.o.db
      .updateTable('sessions')
      .set({
        status: p.state,
        process_alive: p.processAlive,
        ...(p.processAlive && !s.process_alive ? { process_started_at: sql<Date>`COALESCE(process_started_at, ${this.now()})` } : {}),
        ...(mode ? { permission_mode: mode } : {}),
      })
      .where('id', '=', s.id)
      .execute();
    await this.upsert(s.id);
  }

  private async onResult(runnerId: string, p: PayloadOf<AgentMessage, 'session.result'>): Promise<void> {
    const s = await findSessionByClaudeId(this.o.db, runnerId, p.sessionId);
    if (!s) return;
    const unread = !this.o.ui.isActiveVisible(s.user_id, s.id);
    await this.o.db
      .updateTable('sessions')
      .set({ last_turn_end_at: this.now(), unread, ...(s.status === 'working' ? { status: 'waiting' as const } : {}) })
      .where('id', '=', s.id)
      .execute();
    // After «Прервать» the SDK may end the turn with an error result: that is the interrupt, not a failure.
    const wasInterrupted = this.interrupted.delete(s.id);
    // claude-subscriptions P2/P10: every finished turn, under the subscription of the process (the column changes on a
    // switch only after the old process has stopped, so its last results are queued before that)
    const u = p.usage;
    await this.o.db
      .insertInto('session_turns')
      .values({
        user_id: s.user_id,
        session_id: s.id,
        runner_id: runnerId,
        subscription_id: s.subscription_id,
        ended_at: this.now(),
        is_error: p.isError,
        failure: p.failure?.kind ?? null,
        input_tokens: u?.inputTokens ?? 0,
        output_tokens: u?.outputTokens ?? 0,
        cache_read_tokens: u?.cacheReadTokens ?? 0,
        cache_creation_tokens: u?.cacheCreationTokens ?? 0,
      })
      .execute();
    if (!p.isError) this.triedInTurn.delete(s.id);
    // QA B2: a turn that worked under the current token proves it: «токен отклонён» goes away
    if (!p.isError && s.subscription_id && this.o.subscriptions) await this.o.subscriptions.clearRejected(s.subscription_id, s.user_id, s.subscription_token_at);
    const failure = p.failure && !wasInterrupted ? p.failure : null;
    const switched = failure ? await this.onFailure(s, failure) : false;
    if (!failure && p.isError && !wasInterrupted) await this.emitEvents(s, [await addNote(this.o.db, s.id, 'error', `Ход завершился с ошибкой: ${p.errorText ?? p.subtype}`)]);
    await this.upsert(s.id);
    // hub-subagents D5: the turn the parent started reports back; an auto switch repeats the turn, the report waits for it
    if (s.report_to_session_id && !switched) {
      if (wasInterrupted) await this.o.db.updateTable('sessions').set({ report_to_session_id: null, report_since: null, report_queued: 0 }).where('id', '=', s.id).execute();
      else this.turnReporter?.(s, p);
    }
  }

  /** hub-subagents D5: PeersService sends the report (registered there, so the services do not import each other). */
  private turnReporter?: (s: SessionBase, p: PayloadOf<AgentMessage, 'session.result'>) => void;
  setTurnReporter(fn: (s: SessionBase, p: PayloadOf<AgentMessage, 'session.result'>) => void): void {
    this.turnReporter = fn;
  }

  /**
   * A turn failed for a reason of the subscription (P6): the mark on the subscription and a note with the alternatives;
   * a limit of a subscription with auto switch goes on to the next one (P7), in a separate step of the session's queue.
   */
  private async onFailure(s: SessionBase, f: NonNullable<PayloadOf<AgentMessage, 'session.result'>['failure']>): Promise<boolean> {
    const subs = this.o.subscriptions;
    const sub = s.subscription_id && subs ? await subs.byId(s.subscription_id) : undefined;
    const why = f.message ? `: ${f.message}` : '';
    if (s.provider !== 'claude' && !sub) {
      // agent-providers D10: the machine's sign-in of the provider (ChatGPT for Codex)
      const label = PROVIDER_LABELS[s.provider];
      const text =
        f.kind === 'subscription_limit'
          ? `${label}: лимит подписки исчерпан${f.resetsAt ? `, сброс в ${hhmm(new Date(f.resetsAt))}` : ''}`
          : f.kind === 'auth_rejected'
            ? `${label}: вход на машине отклонён, войдите заново на экране «Машины»${why}`
            : `${label}: аккаунт недоступен${why}`;
      await this.emitEvents(s, [await addNote(this.o.db, s.id, 'error', text)]);
      return false;
    }
    if (!subs || !sub) {
      // the machine login (or no registry): the reason in plain text, no switch offered from here
      const text =
        f.kind === 'subscription_limit'
          ? `Лимит входа машины исчерпан${f.resetsAt ? `, сброс в ${hhmm(new Date(f.resetsAt))}` : ''}`
          : f.kind === 'auth_rejected'
            ? `Вход машины отклонён${why}`
            : `Аккаунт входа машины недоступен${why}`;
      await this.emitEvents(s, [await addNote(this.o.db, s.id, 'error', text)]);
      return false;
    }
    if (f.kind === 'subscription_limit') {
      const resetsAt = f.resetsAt ? new Date(f.resetsAt) : null;
      await subs.markLimit(sub.id, s.user_id, resetsAt, f.limitType ?? null);
      const tried = this.triedInTurn.get(s.id) ?? new Set<string>();
      tried.add(sub.id);
      this.triedInTurn.set(s.id, tried);
      // P7: the next one by the registry order — the note comes only when there is none (or no message to repeat)
      if (sub.auto_switch && this.lastMessage.has(s.id)) {
        const next = await subs.nextForAutoSwitch(s.user_id, sub.id, tried, s.provider);
        if (next) {
          this.scheduleAutoSwitch(s, sub, next);
          return true;
        }
      }
      const alternatives = await this.alternativesAfter(s, sub.id);
      const display = `Лимит подписки ${sub.name} исчерпан${resetsAt ? `, сброс в ${hhmm(resetsAt)}` : ''}`;
      const note = { kind: 'limit' as const, subscriptionId: sub.id, ...(resetsAt ? { resetsAt: resetsAt.toISOString() } : {}), alternatives };
      await this.emitEvents(s, [await addNote(this.o.db, s.id, 'subscription_limit', JSON.stringify({ display, subscription: note }))]);
      return false;
    }
    if (f.kind === 'auth_rejected') {
      // QA B2: the mark only when the process got the current token; a process launched with a replaced token says so
      if (await subs.markRejected(sub.id, s.user_id, s.subscription_token_at)) {
        const alternatives = await this.alternativesAfter(s, sub.id);
        const display =
          s.provider === 'codex'
            ? `Подписка ${sub.name}: вход ChatGPT отклонён — войдите заново на экране «Подписки»`
            : `Подписка ${sub.name}: токен отклонён — выпустите новый \`claude setup-token\` и замените токен в настройках`;
        await this.emitEvents(s, [await addNote(this.o.db, s.id, 'subscription_auth', JSON.stringify({ display, subscription: { kind: 'auth', subscriptionId: sub.id, alternatives } }))]);
      } else {
        await this.emitEvents(s, [await addNote(this.o.db, s.id, 'error', `Подписка ${sub.name}: отклонён прежний токен процесса, токен уже заменён — следующее сообщение поднимет сессию с новым`)]);
      }
      // the process keeps the token it was launched with: it stops, the next message resumes with the current one
      await this.stopRejected(s);
      return false;
    }
    await this.emitEvents(s, [await addNote(this.o.db, s.id, 'error', `Подписка ${sub.name} недоступна (биллинг, блокировка или организация)${why}`)]);
    return false;
  }

  /** QA B2: the token of the session's subscription was replaced after its current process was launched. */
  private async tokenReplaced(s: Pick<SessionBase, 'subscription_id' | 'subscription_token_at'>): Promise<boolean> {
    if (!s.subscription_id || !s.subscription_token_at || !this.o.subscriptions) return false;
    const sub = await this.o.subscriptions.byId(s.subscription_id);
    return !!sub && tokenNewer(sub.token_updated_at, s.subscription_token_at);
  }

  /**
   * QA B2: after a rejected token the process stops (it keeps the token it was launched with), so the next message
   * resumes with the current token. Not while subagents or background commands work: they would be killed; then a
   * message after the token replacement restarts the process once the work is over (sendMessage).
   */
  private async stopRejected(s: SessionBase): Promise<void> {
    const cur = await getSession(this.o.db, s.id);
    if (!cur || !cur.process_alive || !isLiveStatus(cur.status) || Number(cur.children_working ?? 0) > 0) return;
    await this.sleep(cur);
  }

  /** The alternatives of a failure note: without the subscriptions that already failed in this turn (auto switch). */
  private async alternativesAfter(s: SessionBase, failedId: string): Promise<string[]> {
    const tried = this.triedInTurn.get(s.id);
    return (await this.o.subscriptions!.alternatives(s.user_id, failedId, s.provider)).filter(a => !tried?.has(a.id)).map(a => a.id);
  }

  /** P7: the auto switch runs after the current step (onResult) in the session's queue. */
  private scheduleAutoSwitch(s: SessionBase, from: SubscriptionMeta, to: SubscriptionMeta): void {
    void this.queue
      .run(sessionKey(s.runner_id, s.claude_session_id), async () => {
        const cur = await getSession(this.o.db, s.id);
        if (!cur || cur.subscription_id !== from.id) return;
        if (!this.o.agents.get(cur.runner_id)) return this.autoSwitchFailed(cur, from, 'машина не в сети');
        try {
          await this.switchStep1(cur, cur.user_id, to, { interrupt: false, repeatLast: true, auto: true, from });
        } catch (err) {
          return this.autoSwitchFailed(cur, from, (err as Error).message);
        }
        // step 2 behind the messages of the stopped process (fire and forget: never awaited inside the queue)
        void this.queue
          .run(sessionKey(cur.runner_id, cur.claude_session_id), () => this.switchStep2(cur.user_id, cur.id, to, { repeatLast: true, auto: true, from }))
          .catch((err: unknown) => this.autoSwitchFailed(cur, from, (err as Error).message));
      })
      .catch((err: unknown) => this.o.log.error({ err, sessionId: s.id }, 'auto switch failed'));
  }

  private async autoSwitchFailed(s: SessionBase, from: SubscriptionMeta, why: string): Promise<void> {
    this.o.log.warn({ sessionId: s.id, why }, 'auto switch did not happen');
    await this.emitEvents(s, [await addNote(this.o.db, s.id, 'error', `Автопереключение с подписки ${from.name} не выполнено: ${why}`)]).catch(() => undefined);
  }

  // ---------- subscription switch (claude-subscriptions P6) ----------

  /**
   * POST /api/sessions/:id/subscription. A session without a live process: the last choice only (with `repeatLast` —
   * also resumed under it with the last message). A live one: stop and resume under the new subscription; a running
   * turn → 409 turn_in_progress unless `interrupt`. Requirement: Подписка в шапке вкладки и переключение.
   */
  async switchSubscription(userId: string, id: string, b: { subscriptionId: string; interrupt?: boolean | undefined; repeatLast?: boolean | undefined }): Promise<SessionView> {
    const subs = this.o.subscriptions;
    if (!subs) throw new HttpError(422, 'subscription_unavailable', 'Подписка недоступна — выберите другую');
    const plan = await this.withSession(userId, id, async s => {
      this.assertWritable(s);
      const { runner } = await this.onlineRunner(userId, s.runner_id);
      if (!(s.provider === 'codex' ? supportsCodexSubscriptions(runner.protocol_version) : supportsSubscriptions(runner.protocol_version))) {
        throw new HttpError(409, 'agent_outdated', `Агент на ${runner.name} устарел и не запускает сессии под подпиской — обновите агента`);
      }
      const to = await subs.requireActive(userId, b.subscriptionId, s.provider);
      // the token must decrypt before anything stops
      await subs.cred(to);
      const live = s.process_alive && isLiveStatus(s.status);
      // a turn waiting for a permission answer is mid-turn too, and so is work in the background (subagents, commands)
      if (live && busyForSwitch(s) && !b.interrupt) throw new HttpError(409, 'turn_in_progress', 'Идёт ход: прервать и переключить?');
      await subs.setLastChoice(userId, to.id);
      if (!live && !b.repeatLast) return null;
      if (live && s.subscription_id === to.id && !b.repeatLast) return null;
      const from = s.subscription_id ? ((await subs.byId(s.subscription_id)) ?? null) : null;
      await this.switchStep1(s, userId, to, { interrupt: b.interrupt === true, repeatLast: b.repeatLast === true, auto: false, from });
      return { s, to, from };
    });
    if (!plan) return this.upsert(id);
    // step 2 in the session's queue behind the session.result / session.exited of the stopped process
    await this.queue.run(sessionKey(plan.s.runner_id, plan.s.claude_session_id), () => this.switchStep2(userId, id, plan.to, { repeatLast: b.repeatLast === true, auto: false, from: plan.from }));
    return this.upsert(id);
  }

  /** Interrupt (if asked) and stop the live process; the agent sends its last results before cmd.ok. */
  private async switchStep1(s: SessionRow, userId: string, _to: SubscriptionMeta, o: { interrupt: boolean; repeatLast: boolean; auto: boolean; from: SubscriptionMeta | null }): Promise<void> {
    const live = s.process_alive && isLiveStatus(s.status);
    if (!live) return;
    if (midTurn(s.status) && o.interrupt) await this.doInterrupt(s, userId);
    const { conn } = await this.onlineRunner(userId, s.runner_id);
    try {
      await conn.request('session.stop', { sessionId: s.claude_session_id, reason: 'user' }, this.o.switchStopTimeoutMs ?? 30_000);
    } catch (err) {
      throw this.agentError(err);
    }
    await this.closeOpenPermissions(s, 'Подписка переключается');
    await this.o.db.updateTable('sessions').set({ process_alive: false, status: 'sleeping', slept_at: this.now() }).where('id', '=', s.id).execute();
  }

  /** The new subscription on the row, the note, resume (with the last message when asked and known). */
  private async switchStep2(userId: string, id: string, to: SubscriptionMeta, o: { repeatLast: boolean; auto: boolean; from: SubscriptionMeta | null }): Promise<void> {
    const s = await this.get(userId, id);
    const { conn, runner } = await this.onlineRunner(userId, s.runner_id);
    const cred = await this.o.subscriptions!.cred(to);
    const fromName = o.from?.name ?? 'вход машины';
    const display = o.auto ? `Автопереключение: ${fromName} → ${to.name}` : `Подписка: ${fromName} → ${to.name}. Первый ход пересчитает контекст без кэша`;
    // the note only after the process is up under the new subscription: a failed resume leaves no false «A → B»
    const switched = async () => {
      await this.emitEvents(s, [await addNote(this.o.db, s.id, 'subscription_switch', JSON.stringify({ display, subscription: { kind: 'switch', subscriptionId: to.id } }))]);
    };
    const last = o.repeatLast ? this.lastMessage.get(s.id) : undefined;
    if (!last) {
      await this.resume(conn, s, { force: true, subscription: cred });
      await switched();
      return;
    }
    const attachments = await this.attachments(userId, runner, last.attachments.length ? last.attachments : undefined);
    await this.prefetch(conn, runner, attachments);
    const promptUuid = randomUUID();
    this.markDelivered(promptUuid);
    this.trackUnconfirmed(s.id, conn.runnerId, s.claude_session_id, promptUuid, last.text, attachments);
    try {
      await this.resume(conn, s, { prompt: last.text, promptUuid, force: true, attachments, subscription: cred });
    } catch (err) {
      this.deliveredClientUuids.delete(promptUuid);
      this.forgetUnconfirmed(s.id, promptUuid);
      throw err;
    }
    await switched();
    if (attachments.length) await this.markUsed(userId, attachments);
  }

  private async onExited(runnerId: string, p: PayloadOf<AgentMessage, 'session.exited'>): Promise<void> {
    const s = await findSessionByClaudeId(this.o.db, runnerId, p.sessionId);
    if (!s) return;
    await this.closeOpenPermissions(s, 'Процесс завершён');
    if (p.reason === 'crashed') {
      // D8: working → waiting on a crash; the next message resumes.
      await this.o.db
        .updateTable('sessions')
        .set({ process_alive: false, status: isLiveStatus(s.status) ? 'waiting' : s.status, last_turn_end_at: this.now() })
        .where('id', '=', s.id)
        .execute();
      await this.emitEvents(s, [await addNote(this.o.db, s.id, 'crashed', (p.errorText && readableProcessError(p.errorText)) || `Процесс Claude Code упал${p.errorText ? `: ${p.errorText}` : ''}`)]);
    } else {
      await this.o.db
        .updateTable('sessions')
        .set({ process_alive: false, ...(isLiveStatus(s.status) ? { status: 'sleeping' as const, slept_at: this.now() } : {}) })
        .where('id', '=', s.id)
        .execute();
    }
    await this.upsert(s.id);
    this.scheduleDeliveryCheck(s.id);
    // hub-subagents D5: a process that ended inside the turn the parent started has no result; the parent hears of it
    if (s.report_to_session_id) {
      await this.o.db.updateTable('sessions').set({ report_queued: 0 }).where('id', '=', s.id).execute();
      this.turnReporter?.(s, { isError: true, subtype: 'exited', errorText: p.errorText || 'процесс завершился, не закончив ход' } as PayloadOf<AgentMessage, 'session.result'>);
    }
  }

  private async onPermissionRequest(runnerId: string, p: PayloadOf<AgentMessage, 'permission.request'>): Promise<void> {
    const s = await findSessionByClaudeId(this.o.db, runnerId, p.sessionId);
    if (!s) return;
    const row = await this.o.db
      .insertInto('permission_requests')
      .values({
        request_id: p.requestId,
        session_id: s.id,
        tool_name: p.toolName,
        tool_use_id: p.toolUseId,
        input: JSON.stringify(stripNul(p.input)),
        suggestions: JSON.stringify(stripNul(p.suggestions)),
        created_at: this.now(),
      })
      .onConflict(oc => oc.column('request_id').doNothing())
      .returningAll()
      .executeTakeFirst();
    if (!row) return;
    await this.o.db
      .updateTable('sessions')
      .set({ status: 'permission', process_alive: true, ...(!s.process_alive ? { process_started_at: sql<Date>`COALESCE(process_started_at, ${this.now()})` } : {}) })
      .where('id', '=', s.id)
      .execute();
    const ev = permissionEvent(row);
    if (ev.kind === 'permission') this.o.ui.sendToSubscribers(s.user_id, s.id, { type: 'permission.request', sessionId: s.id, request: ev.request });
    this.o.ui.sendToSubscribers(s.user_id, s.id, { type: 'session.events', sessionId: s.id, events: [ev] });
    await this.upsert(s.id);
  }

  /**
   * After an agent (re)connects: hub sessions of the runner the agent does not run any more fall asleep,
   * live ones take the reported state (D8 «Переподключение агента»). Requirement: Офлайн-машина
   */
  async reconcile(runnerId: string, live: Array<{ sessionId: string; state: 'working' | 'waiting' | 'permission' }>, helloAt: Date): Promise<void> {
    const byId = new Map(live.map(l => [l.sessionId, l.state]));
    // Sessions started or resumed after the hello are not in its snapshot: they are left alone.
    const rows = await selectSessions(this.o.db)
      .where('s.runner_id', '=', runnerId)
      .where('s.created_at', '<', helloAt)
      .where(eb => eb.or([eb('s.last_input_at', 'is', null), eb('s.last_input_at', '<', helloAt)]))
      .where(eb => eb.or([eb('s.process_alive', '=', true), eb('s.status', 'in', ['working', 'waiting', 'permission'])]))
      .execute();
    for (const row of rows) {
      await this.queue.run(sessionKey(runnerId, row.claude_session_id), async () => {
        const s = await getSession(this.o.db, row.id);
        if (s) await this.reconcileOne(s, byId.get(s.claude_session_id), helloAt);
      });
    }
  }

  private async reconcileOne(s: SessionRow, state: 'working' | 'waiting' | 'permission' | undefined, helloAt: Date): Promise<void> {
    // Started or resumed after the hello: not in its snapshot.
    if (s.created_at >= helloAt || (s.last_input_at && s.last_input_at >= helloAt)) return;
    if (state) {
      if (s.status !== state || !s.process_alive) {
        // the process kept running while the hub thought otherwise: its start is the known one, else now
        await this.o.db
          .updateTable('sessions')
          .set({ status: state, process_alive: true, process_started_at: sql<Date>`COALESCE(process_started_at, ${this.now()})` })
          .where('id', '=', s.id)
          .execute();
        await this.upsert(s.id);
      }
      return;
    }
    await this.closeOpenPermissions(s, 'Процесс не найден после переподключения агента');
    await this.o.db
      .updateTable('sessions')
      .set({ process_alive: false, ...(isLiveStatus(s.status) ? { status: 'sleeping' as const, slept_at: this.now() } : {}) })
      .where('id', '=', s.id)
      .execute();
    await this.upsert(s.id);
    this.scheduleDeliveryCheck(s.id);
  }

  // ---------- delivery confirmation (D10) ----------

  private trackUnconfirmed(sessionId: string, runnerId: string, claudeSessionId: string, clientUuid: string, text: string, attachments: Attachment[]): void {
    const images = attachments.length;
    const refs = attachments.map(a => ({ sha256: a.sha256, mime: a.mime, size: a.size }));
    let m = this.unconfirmed.get(sessionId);
    if (!m) this.unconfirmed.set(sessionId, (m = new Map()));
    m.set(clientUuid, { runnerId, claudeSessionId, text, images, attachments: refs, at: Date.now() });
    // The final check: a message that never reached the transcript is reported even if no process loss was seen.
    this.later(this.o.deliveryWindowMs ?? 10 * 60_000, runnerId, claudeSessionId, () => this.checkDelivery(sessionId, true));
  }

  private forgetUnconfirmed(sessionId: string, clientUuid: string): void {
    const m = this.unconfirmed.get(sessionId);
    m?.delete(clientUuid);
    if (m && !m.size) this.unconfirmed.delete(sessionId);
  }

  /** The process of the session is gone (exit, not in the agent's snapshot): check its messages after the grace. */
  private scheduleDeliveryCheck(sessionId: string): void {
    const first = this.unconfirmed.get(sessionId)?.values().next().value;
    if (!first) return;
    this.later(this.o.deliveryGraceMs ?? 15_000, first.runnerId, first.claudeSessionId, () => this.checkDelivery(sessionId, false));
  }

  private later(ms: number, runnerId: string, claudeSessionId: string, fn: () => Promise<void>): void {
    const t = setTimeout(() => {
      this.deliveryTimers.delete(t);
      void this.queue.run(sessionKey(runnerId, claudeSessionId), fn).catch((err: unknown) => this.o.log.error({ err }, 'delivery check failed'));
    }, ms);
    t.unref();
    this.deliveryTimers.add(t);
  }

  /**
   * Messages of the session that did not reach the transcript: while the process is alive on a connected machine they
   * wait (queued behind a turn); otherwise the chat gets a note and the clientUuid is unmarked, so «Повторить» with the
   * same clientUuid delivers it once. `final`: the delivery window is over.
   */
  private async checkDelivery(sessionId: string, final: boolean): Promise<void> {
    const m = this.unconfirmed.get(sessionId);
    if (!m?.size) return;
    const s = await getSession(this.o.db, sessionId);
    if (!s) return void this.unconfirmed.delete(sessionId);
    for (const u of await this.seenInTranscript(sessionId, [...m.keys()])) this.forgetUnconfirmed(sessionId, u);
    const window = this.o.deliveryWindowMs ?? 10 * 60_000;
    const online = this.o.agents.isOnline(s.runner_id);
    const alive = s.process_alive && isLiveStatus(s.status);
    const lost: Array<[string, UnconfirmedMessage]> = [];
    for (const [u, msg] of m) {
      const expired = final || Date.now() - msg.at >= window;
      // Alive on a connected machine: still queued in Claude Code. Alive on an offline machine: the reconnect decides.
      if (alive && online) {
        if (expired) this.forgetUnconfirmed(sessionId, u);
        continue;
      }
      if (alive && !expired) continue;
      lost.push([u, msg]);
    }
    if (!lost.length) return;
    const notes: HubEvent[] = [];
    for (const [u, msg] of lost) {
      this.forgetUnconfirmed(sessionId, u);
      this.deliveredClientUuids.delete(u);
      // Already reported (two checks of the same loss): one note per message.
      if (this.reportedLost.has(u)) continue;
      this.reportedLost.set(u, { sessionId, text: msg.text, at: Date.now() });
      const why = online ? 'процесс Claude Code на машине завершился' : 'машина отключилась';
      this.o.log.warn({ sessionId, clientUuid: u, online }, 'acknowledged message did not reach the transcript');
      // Structured for «Повторить» (the web puts the text and the images back into the composer).
      const dims = msg.attachments.length
        ? await this.o.db
            .selectFrom('blobs')
            .select(['sha256', 'width', 'height'])
            .where(
              'sha256',
              'in',
              msg.attachments.map(a => a.sha256),
            )
            .execute()
        : [];
      const bySha = new Map(dims.map(d => [d.sha256, d]));
      const attachments = msg.attachments.map(a => {
        const d = bySha.get(a.sha256);
        return { ...a, ...(d?.width ? { width: d.width } : {}), ...(d?.height ? { height: d.height } : {}) };
      });
      const display = `Сообщение не доставлено — ${why}, отправьте ещё раз: ${quote(msg.text, msg.images)}`;
      notes.push(await addNote(this.o.db, sessionId, 'undelivered', JSON.stringify({ display, undelivered: { text: msg.text, attachments, clientUuid: u } })));
    }
    if (notes.length) await this.emitEvents(s, notes);
  }

  /** Messages waiting for their transcript line on a machine that just went offline: one «ожидает доставки» each. */
  private async onRunnerOffline(runnerId: string, name: string): Promise<void> {
    for (const [sessionId, m] of [...this.unconfirmed]) {
      const waiting = [...m.entries()].filter(([, msg]) => msg.runnerId === runnerId && !msg.pendingNoted);
      if (!waiting.length) continue;
      const first = waiting[0]![1];
      await this.queue.run(sessionKey(runnerId, first.claudeSessionId), async () => {
        const s = await getSession(this.o.db, sessionId);
        if (!s) return;
        const left = await this.seenInTranscript(
          sessionId,
          waiting.map(([u]) => u),
        );
        const notes: HubEvent[] = [];
        for (const [u, msg] of waiting) {
          if (left.includes(u)) {
            this.forgetUnconfirmed(sessionId, u);
            continue;
          }
          msg.pendingNoted = true;
          notes.push(await addNote(this.o.db, sessionId, 'pending', `${name} не в сети — сообщение ожидает доставки: ${quote(msg.text, msg.images)}`));
        }
        if (notes.length) await this.emitEvents(s, notes);
      });
    }
  }

  /** User lines stored by replication (inside the session's queue): their messages are delivered. */
  private async onUserLines(sessionId: string, uuids: string[]): Promise<void> {
    for (const u of uuids) {
      const waited = this.unconfirmed.get(sessionId)?.get(u);
      this.forgetUnconfirmed(sessionId, u);
      if (waited?.pendingNoted) {
        const s = await getSession(this.o.db, sessionId);
        if (s) await this.emitEvents(s, [await addNote(this.o.db, sessionId, 'delivered_late', `Сообщение дошло до сессии: ${quote(waited.text, waited.images)}`)]);
      }
      const lost = this.reportedLost.get(u);
      if (!lost || lost.sessionId !== sessionId) continue;
      // Reported too early (the tail came after the grace): correct the note; a repeat is a no-op again.
      this.reportedLost.delete(u);
      this.markDelivered(u);
      const s = await getSession(this.o.db, sessionId);
      if (s) await this.emitEvents(s, [await addNote(this.o.db, sessionId, 'delivered_late', `Сообщение всё же дошло до сессии: ${quote(lost.text, 0)}`)]);
    }
    const now = Date.now();
    for (const [k, v] of this.reportedLost) if (now - v.at > 60 * 60_000) this.reportedLost.delete(k);
  }

  /** clientUuids among `uuids` whose user line is already in the session's transcript (events.uuid). */
  private async seenInTranscript(sessionId: string, uuids: string[]): Promise<string[]> {
    if (!uuids.length) return [];
    const rows = await this.o.db.selectFrom('events').select('uuid').where('session_id', '=', sessionId).where('uuid', 'in', uuids).execute();
    return [...new Set(rows.flatMap(r => (r.uuid ? [r.uuid] : [])))];
  }

  // ---------- idle sleep ----------

  /** Sessions shown as written outside the hub (externalActive) at the last check. */
  private externalShown = new Set<string>();

  /**
   * M4a: a session written outside the hub stops being «работает в …» after 3 minutes of silence — nothing arrives
   * then, so this pass (every 30 s, with the sleep check) sends session.upsert when the flag changes. Returns the ids
   * whose flag changed.
   */
  async checkExternal(): Promise<string[]> {
    const since = new Date(this.now().getTime() - EXTERNAL_ACTIVE_MS);
    const rows = await this.o.db.selectFrom('sessions').select('id').where('process_alive', '=', false).where('external_seen_at', '>', since).execute();
    const now = new Set(rows.map(r => r.id));
    const changed = [...[...now].filter(id => !this.externalShown.has(id)), ...[...this.externalShown].filter(id => !now.has(id))];
    this.externalShown = now;
    for (const id of changed) await this.upsert(id).catch(() => undefined);
    return changed;
  }

  /** One pass of the sleep scheduler (D8: every 30 s). Requirement: Засыпание по простою */
  async checkIdle(): Promise<number> {
    // change `background-tasks` D5: monitors past their timeout leave no transcript line — the windows learn here
    for (const id of await expireMonitors(this.o.db)) await this.upsert(id).catch(() => undefined);
    const due = (s: SessionRow) => {
      if (s.status !== 'waiting' && s.status !== 'permission') return false;
      if (!s.process_alive || !this.o.agents.isOnline(s.runner_id)) return false;
      // the same rule as the countdown in the UI (SessionView.sleepsAt): subagents and background commands count
      const at = this.sleepsAtOf(s);
      return at !== null && at <= this.now();
    };
    const rows = await selectSessions(this.o.db).where('s.status', 'in', ['waiting', 'permission']).where('s.process_alive', '=', true).execute();
    let n = 0;
    for (const r of rows.filter(due)) {
      // Re-checked inside the session's queue: a message or resume that came first wins over the sleep.
      const slept = await this.queue.run(sessionKey(r.runner_id, r.claude_session_id), async () => {
        const s = await getSession(this.o.db, r.id);
        if (!s || !due(s)) return false;
        await this.sleep(s);
        return true;
      });
      if (slept) n++;
    }
    return n;
  }

  private async sleep(s: SessionRow): Promise<void> {
    const conn = this.o.agents.get(s.runner_id);
    if (s.status === 'permission') {
      const reason = 'уснула, не дождавшись разрешения';
      const open = await this.closeOpenPermissions(s, reason);
      for (const id of open) conn?.send('permission.response', { requestId: id, behavior: 'deny', scope: 'once', message: 'Сессия уснула, не дождавшись разрешения' });
      await this.emitEvents(s, [await addNote(this.o.db, s.id, 'sleep', 'Сессия уснула, не дождавшись разрешения')]);
    }
    try {
      await conn?.request('session.stop', { sessionId: s.claude_session_id, reason: 'sleep' }, 30_000);
    } catch (err) {
      this.o.log.warn({ err: (err as Error).message, sessionId: s.id }, 'session.stop for sleep failed; marking asleep');
    }
    await this.o.db.updateTable('sessions').set({ status: 'sleeping', process_alive: false, slept_at: this.now() }).where('id', '=', s.id).execute();
    this.o.log.info({ sessionId: s.id }, 'session put to sleep');
    await this.upsert(s.id);
  }

  // ---------- presence ----------

  /** A client shows these sessions in visible panels: their unread mark goes away. */
  async markRead(userId: string, ids: string[]): Promise<void> {
    const valid = ids.filter(i => /^[0-9a-f-]{36}$/i.test(i));
    if (!valid.length) return;
    const rows = await this.o.db.updateTable('sessions').set({ unread: false }).where('user_id', '=', userId).where('id', 'in', valid).where('unread', '=', true).returning('id').execute();
    for (const r of rows) await this.upsert(r.id);
  }

  // ---------- helpers ----------

  async ownedRunner(userId: string, runnerId: string): Promise<RunnerRow> {
    const runner = await getRunner(this.o.db, runnerId);
    if (!runner || runner.user_id !== userId) throw new HttpError(404, 'runner_not_found', 'Машина не найдена');
    // Change multi-user: a disabled machine is gone from the launch form, its sessions are read-only.
    if (runner.state === 'disabled') throw new HttpError(423, 'read_only', `${runner.name} отключена — только чтение`);
    return runner;
  }

  /**
   * The path must be an absolute local path of the runner's OS (platform from runners.home_dir; either kind while it
   * is unknown), otherwise 422 bad_path with the Russian text of D10. Requirement: Запуск сессии из UI.
   */
  checkPath(runner: RunnerRow, path: string): void {
    const platform = platformOfHome(runner.home_dir);
    if (!pathFitsPlatform(path, platform)) throw new HttpError(422, 'bad_path', badPathMessage(platform));
  }

  private async onlineRunner(userId: string, runnerId: string): Promise<{ runner: RunnerRow; conn: AgentConnection }> {
    const runner = await this.ownedRunner(userId, runnerId);
    const conn = this.o.agents.get(runner.id);
    if (!conn) throw new HttpError(409, 'runner_offline', `${runner.name} не в сети`);
    return { runner, conn };
  }

  private async fsStat(conn: AgentConnection, path: string, runner: RunnerRow | undefined): Promise<StatResponse> {
    try {
      const r = (await conn.request('fs.stat', { path }, 15_000)) as StatResponse;
      return {
        exists: r.exists === true,
        isDir: r.isDir === true,
        ...(typeof r.size === 'number' ? { size: r.size } : {}),
        ...(typeof r.mtimeMs === 'number' ? { mtimeMs: r.mtimeMs } : {}),
      };
    } catch (err) {
      throw this.agentError(err, runner);
    }
  }

  private agentError(err: unknown, runner?: RunnerRow): HttpError {
    if (err instanceof HttpError) return err;
    if (err instanceof CommandError) {
      // The agent refused the kind of path: the same 422 as the hub's own check, not 502 with its English text.
      if (err.code === 'bad_path') return new HttpError(422, 'bad_path', badPathMessage(platformOfHome(runner?.home_dir)));
      // An attachment did not reach the agent (D19): the message is not queued, the client offers «Повторить».
      if (err.code === 'attachment_fetch_failed') return new HttpError(502, 'attachment_delivery_failed', 'Изображения не дошли до машины — попробуйте ещё раз');
      if (err.code === 'disconnected') return new HttpError(409, 'runner_offline', 'Машина отключилась');
      if (err.code === 'timeout') return new HttpError(504, 'agent_timeout', 'Агент не ответил вовремя');
      return new HttpError(502, `agent_${err.code}`, err.message);
    }
    return new HttpError(500, 'internal', (err as Error).message);
  }

  private assertWritable(s: SessionRow): void {
    if (s.read_only_reason === 'cwd_missing') throw new HttpError(423, 'read_only', 'Каталог проекта на машине удалён — только чтение');
    if (s.read_only_reason || s.source === 'cron') throw new HttpError(423, 'read_only', 'Cron-сессия, только чтение');
  }

  private isDelivered(u: string): boolean {
    const now = Date.now();
    for (const [k, t] of this.deliveredClientUuids) if (now - t > 10 * 60_000) this.deliveredClientUuids.delete(k);
    return this.deliveredClientUuids.has(u);
  }

  private markDelivered(u: string): void {
    this.deliveredClientUuids.set(u, Date.now());
  }

  /** Resume a sleeping/closed session on its machine (D8 «Resume»). */
  private async resume(
    conn: AgentConnection,
    s: SessionRow,
    o: { prompt?: string; promptUuid?: string; force: boolean; attachments?: Attachment[]; subscription?: SubscriptionCredFull | null; onLaunch?: (err?: unknown) => void },
  ): Promise<void> {
    const guardMs = this.o.externalWriteGuardMin * 60_000;
    if (!o.force && s.last_external_write_at && this.now().getTime() - s.last_external_write_at.getTime() < guardMs) {
      const runner = await getRunner(this.o.db, s.runner_id);
      throw new HttpError(409, 'concurrent_external', `Сессия, возможно, открыта в терминале на ${runner?.name ?? s.runner_id}`);
    }
    if (!s.cwd) throw new HttpError(423, 'read_only', 'Каталог сессии неизвестен');
    // The directory comes from the transcript: only an absolute local path of the runner's OS goes to the agent.
    const runner = await getRunner(this.o.db, s.runner_id);
    if (!pathFitsPlatform(s.cwd, platformOfHome(runner?.home_dir))) throw new HttpError(423, 'read_only', 'Каталог сессии — не локальный путь этой машины, только чтение');
    assertModeAllowed(runner, s.permission_mode);
    const st = await this.fsStat(conn, s.cwd, runner);
    if (!st.exists || !st.isDir) {
      await this.o.db.updateTable('sessions').set({ read_only_reason: 'cwd_missing' }).where('id', '=', s.id).execute();
      await this.upsert(s.id);
      throw new HttpError(423, 'read_only', 'Каталог проекта на машине удалён — только чтение');
    }
    // agent-providers D3: a Codex session resumes from the Codex thread on its machine; the mirror is not restored
    if (s.provider === 'claude') await this.restoreIfMissing(conn, s, runner);
    // claude-subscriptions P6: resume without a form — the default subscription (the last choice does not change);
    // a switch passes its own. Checked before the row changes: token_unreadable leaves the session as it was.
    const cred = o.subscription !== undefined ? o.subscription : await this.credFor(s.user_id, runner, undefined, s.provider);
    if (s.provider !== 'claude' && runner) assertProviderReady(runner, s.provider, !!cred);
    const now = this.now();
    await this.o.db
      .updateTable('sessions')
      .set({
        subscription_id: cred?.id ?? null,
        subscription_token_at: cred?.tokenUpdatedAt ?? null,
        status: o.prompt ? 'working' : 'waiting',
        process_alive: true,
        // a new process: children of the previous one (a crash leaves no slept_at) do not work any more
        process_started_at: now,
        is_hub_managed: true,
        unread: false,
        last_input_at: now,
        ...(o.prompt ? {} : { last_turn_end_at: now }),
      })
      .where('id', '=', s.id)
      .execute();
    // a switch passes its subscription and writes its own note «Подписка: A → B» (switchStep2): no second one here
    if (o.subscription === undefined) await this.emitEvents(s, [await addNote(this.o.db, s.id, 'resume', cred ? `Поднята через resume · подписка ${cred.name}` : 'Поднята через resume')]);
    const project = await this.o.db.selectFrom('session_projects').select('project_id').where('user_id', '=', s.user_id).where('session_id', '=', s.id).executeTakeFirst();
    this.launch(
      conn,
      s.id,
      'session.resume',
      {
        sessionId: s.claude_session_id,
        cwd: s.cwd,
        ...(project?.project_id && protocolAtLeast(runner?.protocol_version, '1.13') ? { projectId: project.project_id } : {}),
        permissionMode: s.permission_mode as UiPermissionMode,
        // A session started outside the hub has no model here: the user's default on that machine applies.
        ...(s.model ? { model: s.model } : {}),
        ...(o.prompt || o.attachments?.length ? { prompt: o.prompt ?? '', promptUuid: o.promptUuid ?? randomUUID() } : {}),
        ...(o.attachments?.length ? { attachments: o.attachments } : {}),
        ...this.credPayload(cred),
        ...(s.provider !== 'claude' ? { provider: s.provider } : {}),
      },
      o.onLaunch,
    );
  }

  // ---------- images (D19) ----------

  /**
   * Attachments of a message: each must be an upload of this user; the runner must speak 1.2 (an older agent would drop
   * the field and the model would get the text without the images). Each gets a link /agent-api/blobs/<token>.
   */
  private async attachments(userId: string, runner: RunnerRow, refs: Array<{ sha256: string }> | undefined): Promise<Attachment[]> {
    if (!refs?.length) return [];
    this.requireImages(runner);
    const shas = [...new Set(refs.map(r => r.sha256))];
    const rows = await this.o.db
      .selectFrom('uploads')
      .innerJoin('blobs', 'blobs.sha256', 'uploads.sha256')
      .select(['blobs.sha256', 'blobs.mime', 'blobs.size'])
      .where('uploads.user_id', '=', userId)
      .where('uploads.sha256', 'in', shas)
      .execute();
    const bySha = new Map(rows.map(r => [r.sha256, r]));
    const missing = refs.filter(r => !bySha.has(r.sha256));
    if (missing.length) throw new HttpError(422, 'attachment_not_found', 'Изображение не найдено — загрузите его снова');
    return refs.map(r => {
      const b = bySha.get(r.sha256)!;
      return { sha256: b.sha256, mime: b.mime as Attachment['mime'], size: Number(b.size), url: `/agent-api/blobs/${this.blobLinks.issue(runner.id, b.sha256)}` };
    });
  }

  /** Images need protocol 1.2 on the agent (attachments, fs.read_image): 409 agent_outdated otherwise. */
  private requireImages(runner: RunnerRow): void {
    const v = /^(\d+)\.(\d+)$/.exec(runner.protocol_version ?? '');
    const [maj, min] = IMAGES_PROTOCOL.split('.').map(Number) as [number, number];
    if (!v || Number(v[1]) < maj || (Number(v[1]) === maj && Number(v[2]) < min)) {
      throw new HttpError(409, 'agent_outdated', `Агент на ${runner.name} устарел и не передаёт изображения — обновите агента`);
    }
  }

  /** attachments.fetch (D19): the agent downloads and checks every image and caches it; waits up to 60 s. */
  private async prefetch(conn: AgentConnection, runner: RunnerRow, attachments: Attachment[]): Promise<void> {
    if (!attachments.length) return;
    try {
      await conn.request('attachments.fetch', { attachments }, this.o.attachmentFetchTimeoutMs ?? 60_000);
    } catch (err) {
      if (err instanceof CommandError && (err.code === 'timeout' || err.code === 'attachment_fetch_failed')) {
        this.o.log.warn({ err: err.message, runnerId: runner.id }, 'attachments did not reach the agent');
        throw new HttpError(502, 'attachment_delivery_failed', 'Изображения не дошли до машины — попробуйте ещё раз');
      }
      if (err instanceof CommandError && err.code === 'not_implemented') {
        throw new HttpError(409, 'agent_outdated', `Агент на ${runner.name} устарел и не передаёт изображения — обновите агента`);
      }
      throw this.agentError(err, runner);
    }
  }

  private async markUsed(userId: string, attachments: Attachment[]): Promise<void> {
    await this.o.db
      .updateTable('uploads')
      .set({ used_at: this.now() })
      .where('user_id', '=', userId)
      .where(
        'sha256',
        'in',
        attachments.map(a => a.sha256),
      )
      .where('used_at', 'is', null)
      .execute();
  }

  /**
   * POST /api/sessions/:id/images — «Показать изображение» for a local path in an answer (D19): the agent reads the
   * file (fs.read_image), the hub stores it in blobs/ and keeps a note, so it opens again without the machine.
   */
  async showImage(userId: string, id: string, path: string): Promise<HubEvent> {
    const s = await this.get(userId, id);
    const runner = await this.ownedRunner(userId, s.runner_id);
    this.checkPath(runner, path);
    const notes = await this.o.db.selectFrom('session_notes').select(['id', 'ts', 'kind', 'text']).where('session_id', '=', s.id).where('kind', '=', 'image').execute();
    // The newest stored copy of this path; it is shown again only while the file is unchanged (size and mtime).
    const known = notes
      .map(n => {
        try {
          return { n, meta: JSON.parse(n.text) as { path?: string; size?: number; mtimeMs?: number } };
        } catch {
          return null;
        }
      })
      .filter((x): x is NonNullable<typeof x> => !!x && x.meta.path === path)
      .sort((a, b) => b.n.ts.getTime() - a.n.ts.getTime() || Number(b.n.id) - Number(a.n.id))[0];
    const knownEvent = known ? noteEvent(`n:${known.n.id}`, known.n.ts.toISOString(), known.n.kind, known.n.text) : null;
    const conn = this.o.agents.get(s.runner_id);
    // The machine is offline: the stored copy is all there is.
    if (knownEvent && !conn) return knownEvent;
    if (!this.o.store) throw new HttpError(503, 'storage_unavailable', 'Хранилище изображений не настроено');
    if (!conn) throw new HttpError(409, 'runner_offline', `${runner.name} не в сети`);
    this.requireImages(runner);
    if (knownEvent && known!.meta.mtimeMs !== undefined) {
      const st = await this.fsStat(conn, path, runner);
      if (st.exists && st.size === known!.meta.size && st.mtimeMs === known!.meta.mtimeMs) return knownEvent;
    }
    let r: { sha256?: string; data?: Buffer; mtimeMs?: number };
    try {
      r = (await conn.request('fs.read_image', { path }, 60_000)) as { sha256?: string; data?: Buffer; mtimeMs?: number };
    } catch (err) {
      if (err instanceof CommandError && err.code === 'not_found') throw new HttpError(404, 'file_not_found', `Файл не найден на ${runner.name}`);
      if (err instanceof CommandError && err.code === 'not_image') throw new HttpError(415, 'not_image', 'Файл не изображение PNG, JPEG, GIF или WebP');
      if (err instanceof CommandError && err.code === 'too_large') throw new HttpError(413, 'image_too_large', 'Файл больше 20 МБ');
      throw this.agentError(err, runner);
    }
    if (!r.data || createHash('sha256').update(r.data).digest('hex') !== r.sha256) throw new HttpError(502, 'agent_bad_image', 'Агент передал повреждённый файл');
    // Same bytes as the stored copy (only the mtime moved, or a copy from before 1.2): keep that note, refresh its mtime.
    if (known && knownEvent && (known.meta as { sha256?: string }).sha256 === r.sha256) {
      if (typeof r.mtimeMs === 'number' && r.mtimeMs !== known.meta.mtimeMs) {
        await this.o.db
          .updateTable('session_notes')
          .set({ text: JSON.stringify({ ...known.meta, mtimeMs: r.mtimeMs }) })
          .where('id', '=', known.n.id)
          .execute();
      }
      return knownEvent;
    }
    let img;
    try {
      img = await storeImage(this.o.db, this.o.store, userId, r.data);
    } catch (err) {
      if (err instanceof ImageError) throw new HttpError(err.status, err.code, err.message);
      throw err;
    }
    const ev = await addNote(
      this.o.db,
      s.id,
      'image',
      JSON.stringify({ path, sha256: img.sha256, mime: img.mime, size: img.size, width: img.width, height: img.height, ...(typeof r.mtimeMs === 'number' ? { mtimeMs: r.mtimeMs } : {}) }),
    );
    await this.emitEvents(s, [ev]);
    return ev;
  }

  /**
   * GET /api/sessions/:id/tool-results/:name?sid= — the hub's copy of a large tool output (D4): S3
   * `side/<runner>/<sid>/tool-results/<name>` of the session's machine; `sid` is the session folder in the path
   * Claude Code wrote (the session itself, or the one it was forked from).
   */
  async sideFile(userId: string, id: string, sid: string, name: string): Promise<Buffer> {
    const s = await this.get(userId, id);
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(name) || name.includes('..') || !/^[0-9a-f-]{36}$/i.test(sid)) throw new HttpError(404, 'not_found', 'Файл не найден');
    if (!this.o.store) throw new HttpError(503, 'storage_unavailable', 'Хранилище не настроено');
    const folder = sid.toLowerCase();
    // The session's own machine first (itself, a full copy of a session of this machine); a `sid` of another
    // machine (a handoff session or a fork of a fork whose history has a path of the source, D14 «Handoff» p. 5)
    // — the runner of the user's session with that claude_session_id. Another user's session is never looked up.
    const runners = [s.runner_id];
    if (folder !== s.claude_session_id.toLowerCase()) {
      const owners = await this.o.db.selectFrom('sessions').select('runner_id').where('user_id', '=', userId).where('claude_session_id', '=', folder).execute();
      for (const o of owners) if (!runners.includes(o.runner_id)) runners.push(o.runner_id);
    }
    for (const r of runners) {
      const body = await this.o.store.get(`side/${r}/${folder}/tool-results/${name}`);
      if (body) return body;
    }
    throw new HttpError(404, 'not_found', 'Полный вывод ещё не дошёл до хаба — попробуйте позже');
  }

  /** GET /agent-api/blobs/<token> → the sha256 the token was issued for (runner-bound), or null. */
  resolveBlobLink(token: string, runnerId: string): string | null {
    return this.blobLinks.resolve(token, runnerId);
  }

  /**
   * D8 «Resume»: the machine's transcript list (repl.files) does not have the session's .jsonl → the agent writes it
   * back from raw S3 before resume. Requirement: Восстановление .jsonl из S3 перед resume.
   */
  private async restoreIfMissing(conn: AgentConnection, s: SessionRow, runner: RunnerRow | undefined): Promise<void> {
    const rep = this.replication;
    if (!rep || !s.cwd) return;
    const file = await rep.mainFile(s);
    if (!file || Number(file.acked_line) === 0) return;
    // The list from repl.files is a snapshot taken at connect; the file may have been deleted since, so the agent is
    // asked directly (one fs.stat) when the hub knows where the file lives (~/.claude/projects of runners.home_dir).
    const path = transcriptPath(runner?.home_dir ?? null, file.rel_path);
    const missing = path ? !(await this.fsStat(conn, path, runner)).exists : rep.missingOnMachine(s.runner_id, file.rel_key);
    if (!missing) return;
    let r: Awaited<ReturnType<Replication['prepareRestore']>>;
    try {
      r = await rep.prepareRestore(s, file);
    } catch (err) {
      // A raw copy with a gap (a file replicated before raw segments existed and not yet re-sent, D4): no restore.
      if (err instanceof RawGapError) {
        this.o.log.warn({ err: err.message, sessionId: s.id }, 'restore impossible: raw copy incomplete');
        throw new HttpError(423, 'read_only', 'История в хабе неполная — продолжить можно только на машине, где лежит файл');
      }
      // S3 or the network: try again later.
      this.o.log.warn({ err: (err as Error).message, sessionId: s.id }, 'restore failed: raw copy unavailable');
      throw new HttpError(503, 'restore_unavailable', 'Копия в хабе временно недоступна, попробуйте позже');
    }
    try {
      await conn.request('file.restore', { sessionId: s.claude_session_id, cwd: s.cwd, url: r.url, sha256: r.sha256 }, 120_000);
    } catch (err) {
      throw this.agentError(err, runner);
    }
    rep.markPresent(s.runner_id, file.rel_key);
    await this.emitEvents(s, [await addNote(this.o.db, s.id, 'restore', `Транскрипт восстановлен из копии в хабе (${r.lines} строк)`)]);
  }

  /** Sends start/resume and waits for init in the background (up to 180 s); a failure puts the session to sleep. */
  private launch<T extends 'session.start' | 'session.resume'>(conn: AgentConnection, id: string, type: T, payload: PayloadOf<HubMessage, T>, onLaunch?: (err?: unknown) => void): void {
    // request() is typed per command; the two payload shapes are checked at the call sites.
    const req = conn.request(type as 'session.resume', payload as PayloadOf<HubMessage, 'session.resume'>, this.initTimeoutMs);
    req.then(
      result => {
        onLaunch?.();
        const models = (result as { models?: Array<{ value?: unknown; displayName?: unknown }> } | undefined)?.models;
        if (Array.isArray(models) && models.length) {
          this.models.set(
            modelsKey(conn.runnerId, (payload as { provider?: Provider }).provider ?? 'claude'),
            models.filter(m => typeof m.value === 'string').map(m => ({ value: String(m.value), displayName: String(m.displayName ?? m.value) })),
          );
        }
      },
      (err: unknown) => {
        onLaunch?.(err);
        // The message did not reach a live process: a repeat with the same clientUuid must go through. A broken
        // connection is different: the agent may have started the process and queued the message, so a repeat
        // would deliver it twice; reconcile after the reconnect tells what is running.
        const promptUuid = (payload as { promptUuid?: string }).promptUuid;
        const disconnected = err instanceof CommandError && err.code === 'disconnected';
        if (promptUuid && !disconnected) {
          this.deliveredClientUuids.delete(promptUuid);
          // The launch failure note tells the user; no second «не доставлено» for the same message.
          this.forgetUnconfirmed(id, promptUuid);
        }
        void this.queue
          .run(sessionKey(conn.runnerId, payload.sessionId), () => this.onLaunchFailed(id, type, err))
          .catch((e: unknown) => this.o.log.error({ err: e }, 'launch failure handling failed'));
      },
    );
  }

  private async onLaunchFailed(id: string, type: string, err: unknown): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err);
    // The agent went away mid-start: the process may be alive; reconcile on reconnect decides.
    if (err instanceof CommandError && err.code === 'disconnected') return;
    this.o.log.warn({ sessionId: id, type, err: msg }, 'session launch failed');
    const s = await getSession(this.o.db, id);
    if (!s) return;
    await this.o.db.updateTable('sessions').set({ status: 'sleeping', process_alive: false, slept_at: this.now() }).where('id', '=', id).execute();
    const text =
      err instanceof CommandError && err.code === 'timeout'
        ? 'Сессия не поднялась за 180 с'
        : (readableProcessError(msg) ?? `Не удалось ${type === 'session.start' ? 'запустить' : 'поднять'} сессию: ${msg}`);
    await this.emitEvents(s, [await addNote(this.o.db, id, 'launch_failed', text)]);
    await this.upsert(id);
  }

  /** Closes unanswered permission requests (deny) and tells the clients. Returns the closed request ids. */
  private async closeOpenPermissions(s: SessionBase, message: string): Promise<string[]> {
    const rows = await this.o.db
      .updateTable('permission_requests')
      .set({ resolved_at: this.now(), decision: 'deny', scope: 'once', message })
      .where('session_id', '=', s.id)
      .where('resolved_at', 'is', null)
      .returningAll()
      .execute();
    for (const r of rows) {
      this.o.ui.sendToSubscribers(s.user_id, s.id, { type: 'permission.resolved', sessionId: s.id, requestId: r.request_id, decision: 'deny' });
      this.o.ui.sendToSubscribers(s.user_id, s.id, { type: 'session.events', sessionId: s.id, events: [permissionEvent(r)] });
    }
    return rows.map(r => r.request_id);
  }

  private async afterPermissionResolved(s: SessionRow, requestId: string, decision: PermissionDecision): Promise<void> {
    this.o.ui.sendToSubscribers(s.user_id, s.id, { type: 'permission.resolved', sessionId: s.id, requestId, decision });
    const row = await this.o.db.selectFrom('permission_requests').selectAll().where('request_id', '=', requestId).executeTakeFirstOrThrow();
    this.o.ui.sendToSubscribers(s.user_id, s.id, { type: 'session.events', sessionId: s.id, events: [permissionEvent(row)] });
    const open = await this.o.db.selectFrom('permission_requests').select('request_id').where('session_id', '=', s.id).where('resolved_at', 'is', null).execute();
    if (open.length === 0 && s.status === 'permission') await this.o.db.updateTable('sessions').set({ status: 'working' }).where('id', '=', s.id).execute();
    await this.upsert(s.id);
  }

  private async emitEvents(s: Pick<SessionBase, 'id' | 'user_id'>, events: HubEvent[]): Promise<void> {
    if (events.length) this.o.ui.sendToSubscribers(s.user_id, s.id, { type: 'session.events', sessionId: s.id, events });
  }

  /** Re-reads the session and sends session.upsert to every client of the user. */
  async upsert(id: string): Promise<SessionView> {
    const r = await getSession(this.o.db, id);
    if (!r) throw new HttpError(404, 'not_found');
    const view = this.view(r);
    this.o.ui.broadcast(r.user_id, { type: 'session.upsert', session: view, activeVisible: this.o.ui.isActiveVisible(r.user_id, id) });
    // a child hub session changed: its parent counts it as a working child (loader, sleep), so the parent is re-sent too
    if (r.spawned_by) {
      const p = await getSession(this.o.db, r.spawned_by);
      if (p) this.o.ui.broadcast(p.user_id, { type: 'session.upsert', session: this.view(p), activeVisible: this.o.ui.isActiveVisible(p.user_id, p.id) });
    }
    return view;
  }
}
