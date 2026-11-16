// Qwen Code as a provider of sessions (change qwen-provider, design D1-D10): one SDK query per live session, the hub's
// commands mapped to the SDK, the mirror transcript written for the hub. The model is an OpenAI-compatible endpoint
// (llama-server); there is no sign-in, the endpoint status is the sign-in status.
import { randomUUID } from 'node:crypto';
import {
  CONTEXT_PROTOCOL,
  PEERS_PROTOCOL,
  PEERS_SERVER_NAME,
  PROJECT_TOOLS_PROTOCOL,
  protocolAtLeast,
  RESULT_TEXT_MAX,
  SPAWN_PROTOCOL,
  type Attachment,
  type HubMessage,
  type LiveSessionState,
  type PayloadOf,
  type PermissionMode,
  type ProviderStatus,
  type TurnFailure,
} from '@agent-hub/shared';
import type { QwenConfig } from '../../config.js';
import type { Logger } from '../../log.js';
import { assertLocalPath, CmdError, HUB_SYSTEM_PROMPT_APPEND, PEERS_SYSTEM_PROMPT_APPEND, PROJECTS_SYSTEM_PROMPT_APPEND, SPAWN_SYSTEM_PROMPT_APPEND } from '../../sessions/manager.js';
import { projectRootOf } from '../../sessions/mcp.js';
import { redactText } from '../../sessions/mcpRedact.js';
import type { PeersClient } from '../../peers/client.js';
import { peersToolDefs, runPeerTool, type PeerToolDef } from '../../peers/tools.js';
import { renderMachineContext } from '../../machineContext.js';
import { renderProjectCatalog } from '../../projectContext.js';
import { MirrorWriter, readLines } from '../codex/mirror.js';
import type { SessionProvider } from '../types.js';
import { mirrorMessage, normalizeTool, QWEN_MIRROR, QWEN_MIRROR_DIR, readResumePlan } from './mirror.js';
import { loadQwenSdk, type QwenMessage, type QwenPermissionMode, type QwenQuery, type QwenQueryOptions, type QwenSdk, type QwenUserMessage } from './sdk.js';
import { redactKey, type QwenModel, type QwenService } from './service.js';

type StartPayload = PayloadOf<HubMessage, 'session.start'>;
type ResumePayload = PayloadOf<HubMessage, 'session.resume'>;
type Image = { mime: string; data: Buffer };

/** Design D6: a tool permission request waits for the user this long (the SDK default is a minute). */
const CAN_USE_TOOL_TIMEOUT_MS = 24 * 3_600_000;
const START_TIMEOUT_MS = 120_000;
const PLAN_INSTRUCTIONS = 'Planning mode: change nothing (files, commands with side effects), only investigate and propose a plan.';

/** Design D6: the hub's permission mode → the permission mode of Qwen Code. */
export function qwenModeOf(mode: PermissionMode): QwenPermissionMode {
  switch (mode) {
    case 'bypassPermissions':
      return 'yolo';
    case 'acceptEdits':
    case 'dontAsk':
    case 'auto':
      return 'auto-edit';
    case 'plan':
      return 'plan';
    default:
      return 'default';
  }
}

/** The input of a query: the user's messages wait here until the SDK takes them. */
class InputQueue implements AsyncIterable<QwenUserMessage> {
  private readonly items: QwenUserMessage[] = [];
  private waiter: ((r: IteratorResult<QwenUserMessage>) => void) | null = null;
  private closed = false;

  push(m: QwenUserMessage): void {
    if (this.closed) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: m, done: false });
      return;
    }
    this.items.push(m);
  }

  close(): void {
    this.closed = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<QwenUserMessage> {
    return {
      next: () => {
        const m = this.items.shift();
        if (m) return Promise.resolve({ value: m, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise(resolve => {
          this.waiter = resolve;
        });
      },
    };
  }
}

interface Pending {
  resolve: (r: { behavior: 'allow' | 'deny' }) => void;
}

class QwenSession {
  state: LiveSessionState = 'waiting';
  /** Turns sent and not yet answered by a `result`: the session waits when it is 0. */
  outstanding = 0;
  turnStartedAt = 0;
  lastText = '';
  lastUsage: { input: number; output: number; cacheRead: number; cacheCreation: number } | null = null;
  interrupted = false;
  stopping: 'sleep' | 'user' | null = null;
  seq = 0;
  partialMessageId = '';
  readonly pending = new Map<string, Pending>();
  readonly input = new InputQueue();
  readonly abort = new AbortController();
  query!: QwenQuery;
  mirror!: MirrorWriter;
  done!: Promise<void>;
  sdkSessionId = '';
  exitError: string | null = null;
  peers: PeerToolDef[] = [];

  constructor(
    readonly id: string,
    readonly cwd: string,
    public mode: PermissionMode,
    public model: string | null,
  ) {}
}

export interface QwenProviderDeps {
  config: QwenConfig;
  service: QwenService;
  /** false — the hub is not connected, the message is dropped. */
  send: (type: string, payload: unknown) => boolean | void;
  log: Logger;
  /** ~/.claude/projects: the mirrors are written into its agent-hub-qwen folder. */
  projectsDir: string;
  agentVersion: string;
  images: (attachments: Attachment[] | undefined) => Promise<Image[]>;
  hubProtocol?: () => string | null;
  peers?: Pick<PeersClient, 'request'>;
  onSessionStarted?: (sessionId: string, dir: string) => void;
  onSessionExited?: (sessionId: string) => void;
  onActivity?: (sessionId: string, at: number) => void;
  stopGraceMs?: number;
  machineId?: () => string | null;
  now?: () => number;
  /** Tests: a fake SDK. */
  loadSdk?: () => Promise<QwenSdk>;
}

/** A turn error → the failure the hub knows: a refused key. */
export function failureOf(text: string): TurnFailure | undefined {
  return /\b401\b|\b403\b|unauthori[sz]ed|invalid api key|incorrect api key/i.test(text) ? { kind: 'auth_rejected', message: text.slice(0, 2000) } : undefined;
}

export class QwenProvider implements SessionProvider {
  readonly id = 'qwen' as const;
  private readonly sessions = new Map<string, QwenSession>();
  private sdk: Promise<QwenSdk> | null = null;

  constructor(private readonly d: QwenProviderDeps) {}

  private clock(): number {
    return this.d.now?.() ?? Date.now();
  }

  private loadSdk(): Promise<QwenSdk> {
    if (!this.sdk) {
      this.sdk = (this.d.loadSdk ?? loadQwenSdk)().catch((err: unknown) => {
        this.sdk = null;
        throw err;
      });
    }
    return this.sdk;
  }

  status(): ProviderStatus {
    return this.d.service.status;
  }

  onWelcome(): void {
    void this.d.service.refresh(true).catch((err: unknown) => this.d.log.warn('qwen status refresh failed', { error: redactKey(String(err), this.d.config.apiKey) }));
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  ownsRequest(requestId: string): boolean {
    for (const s of this.sessions.values()) if (s.pending.has(requestId)) return true;
    return false;
  }

  liveSessions(): Array<{ sessionId: string; state: LiveSessionState }> {
    return [...this.sessions.values()].filter(s => !s.stopping).map(s => ({ sessionId: s.id, state: s.state }));
  }

  async stopAll(graceMs?: number): Promise<void> {
    await Promise.all([...this.sessions.keys()].map(id => this.stop(id, 'user', graceMs).catch(() => undefined)));
  }

  async handle(m: HubMessage): Promise<unknown> {
    switch (m.type) {
      case 'session.start':
        return this.start(m.payload, false);
      case 'session.resume':
        return this.start(m.payload, true);
      case 'session.send':
        return this.sendInput(this.live(m.payload.sessionId), m.payload.text, m.payload.promptUuid, await this.d.images(m.payload.attachments));
      case 'session.interrupt': {
        const s = this.live(m.payload.sessionId);
        if (s.outstanding > 0) {
          s.interrupted = true;
          await s.query.interrupt();
        }
        return {};
      }
      case 'session.set_mode': {
        const s = this.live(m.payload.sessionId);
        s.mode = m.payload.mode;
        await s.query.setPermissionMode(qwenModeOf(s.mode));
        this.sendState(s);
        return {};
      }
      case 'session.set_model': {
        const s = this.live(m.payload.sessionId);
        s.model = m.payload.model;
        await s.query.setModel(m.payload.model);
        return {};
      }
      case 'session.stop':
        return this.stop(m.payload.sessionId, m.payload.reason);
      case 'permission.response':
        this.answer(m.payload);
        return undefined;
      case 'session.fork':
        return this.fork(m.payload);
      case 'mcp.status.get': {
        const s = this.live(m.payload.sessionId);
        return { snapshot: { servers: [], observedAt: this.clock(), projectRoot: projectRootOf(s.cwd) } };
      }
      case 'mcp.registry.session-update':
        this.d.send('mcp.registry.session-update.ack', {
          sessionId: m.payload.sessionId,
          revision: m.payload.revision,
          activation: 'available-next-thread',
          applied: true,
          error: 'Registry MCP servers are not connected to Qwen sessions yet.',
        });
        return { activation: 'available-next-thread' };
      case 'mcp.action':
      case 'mcp.auth.start':
      case 'mcp.auth.callback':
      case 'mcp.auth.logout':
        throw new CmdError('mcp_not_supported', 'The MCP panel of a Qwen session shows statuses only');
      default:
        throw new CmdError('not_implemented', `${m.type} is not supported by Qwen sessions`);
    }
  }

  private live(sessionId: string): QwenSession {
    const s = this.sessions.get(sessionId);
    if (!s || s.stopping) throw new CmdError('not_running', `session ${sessionId} has no live process on this machine`);
    return s;
  }

  // ---------- start / resume ----------

  private spawnOn(): boolean {
    return protocolAtLeast(this.d.hubProtocol?.() ?? null, SPAWN_PROTOCOL);
  }

  private systemAppend(peersOn: boolean, mode: PermissionMode, spawnOn: boolean, catalog: string, projectsOn: boolean, machine: string): string {
    const parts = [HUB_SYSTEM_PROMPT_APPEND.replace('with the Read tool', 'by its path (read_file)')];
    if (machine) parts.push(machine);
    if (peersOn) parts.push(PEERS_SYSTEM_PROMPT_APPEND);
    if (spawnOn) parts.push(SPAWN_SYSTEM_PROMPT_APPEND);
    if (projectsOn) parts.push(PROJECTS_SYSTEM_PROMPT_APPEND);
    if (mode === 'plan') parts.push(PLAN_INSTRUCTIONS);
    if (catalog) parts.push(catalog);
    return parts.join('\n\n');
  }

  private models(): QwenModel[] {
    return this.d.service.listModels();
  }

  private async start(p: StartPayload | ResumePayload, resume: boolean): Promise<{ models: QwenModel[] }> {
    assertLocalPath(p.cwd);
    const existing = this.sessions.get(p.sessionId);
    if (existing && !existing.stopping) {
      if (!resume) throw new CmdError('already_running', `session ${p.sessionId} is already running`);
      const imgs = await this.d.images(p.attachments);
      if (p.prompt || imgs.length) await this.sendInput(existing, p.prompt ?? '', p.promptUuid ?? randomUUID(), imgs);
      return { models: this.models() };
    }
    if (existing) await existing.done;
    const images = await this.d.images(p.attachments);
    const plan = resume ? await readResumePlan(this.d.projectsDir, p.sessionId) : null;
    if (resume && !plan) throw new CmdError('transcript_missing', 'The history of a Qwen session exists only on the machine where it ran');
    let sdk: QwenSdk;
    try {
      sdk = await this.loadSdk();
    } catch (err) {
      throw new CmdError('start_failed', `Qwen did not start: ${this.clean(err)}`);
    }

    await this.d.service.refresh().catch(() => undefined);
    const model = p.model ?? this.d.config.model ?? this.models()[0]?.value ?? null;
    const s = new QwenSession(p.sessionId, p.cwd, p.permissionMode, model);
    s.sdkSessionId = plan && !plan.fork ? plan.resume : s.id;
    s.mirror = new MirrorWriter(
      this.d.projectsDir,
      s.id,
      s.cwd,
      () => this.clock(),
      err => this.d.log.error('qwen mirror write failed', { sessionId: s.id, error: err.message }),
      QWEN_MIRROR,
    );
    this.sessions.set(s.id, s);
    this.d.log.info(resume ? 'resuming qwen session' : 'starting qwen session', { sessionId: s.id, cwd: s.cwd, mode: s.mode, model: s.model });

    try {
      const peersOn = !!this.d.peers && protocolAtLeast(this.d.hubProtocol?.() ?? null, PEERS_PROTOCOL);
      const spawnOn = peersOn && this.spawnOn();
      const projectsOn = peersOn && protocolAtLeast(this.d.hubProtocol?.() ?? null, PROJECT_TOOLS_PROTOCOL);
      s.peers = peersOn ? peersToolDefs(s.id, this.d.peers!, { spawn: spawnOn, projects: projectsOn }) : [];
      const options = this.optionsOf(s, sdk, plan, this.systemAppend(peersOn, s.mode, spawnOn, renderProjectCatalog(p.projectCatalog), projectsOn, renderMachineContext(p.machineName)));
      s.query = sdk.query({ prompt: s.input, options });
      s.done = this.pump(s);
      void s.done.then(() => this.onExit(s));
      await s.mirror.open();
      await withTimeout(s.query.initialized, START_TIMEOUT_MS, 'the Qwen CLI did not initialise in time');
      if (!resume) {
        s.mirror.header(s.id, s.model);
        await s.mirror.flush();
      } else if (plan?.fork) {
        s.mirror.system('qwen_fork_materialized', `Qwen chat forked from ${plan.resume}`);
        await s.mirror.flush();
      }
    } catch (err) {
      const message = this.clean(err);
      s.abort.abort();
      s.input.close();
      this.sessions.delete(s.id);
      void s.query?.close().catch(() => undefined);
      throw new CmdError('start_failed', `Qwen did not start: ${message}`);
    }
    this.d.onSessionStarted?.(s.id, QWEN_MIRROR_DIR);
    if (p.prompt || images.length) await this.sendInput(s, p.prompt ?? '', p.promptUuid ?? randomUUID(), images);
    else this.sendState(s);
    return { models: this.models() };
  }

  private optionsOf(s: QwenSession, sdk: QwenSdk, plan: { resume: string; fork: boolean } | null, append: string): QwenQueryOptions {
    const env: Record<string, string> = { OPENAI_API_KEY: this.d.config.apiKey, OPENAI_BASE_URL: this.d.config.baseUrl };
    if (s.model) env.OPENAI_MODEL = s.model;
    const options: QwenQueryOptions = {
      cwd: s.cwd,
      env,
      authType: 'openai',
      systemPrompt: { type: 'preset', preset: 'qwen_code', append },
      permissionMode: qwenModeOf(s.mode),
      canUseTool: (toolName, input) => this.canUseTool(s, toolName, input),
      timeout: { canUseTool: CAN_USE_TOOL_TIMEOUT_MS },
      includePartialMessages: true,
      abortController: s.abort,
      stderr: line => this.d.log.debug('qwen cli', { sessionId: s.id, line: redactKey(line, this.d.config.apiKey).slice(0, 500) }),
    };
    if (s.model) options.model = s.model;
    if (s.peers.length)
      options.mcpServers = {
        [PEERS_SERVER_NAME]: sdk.mcpServer(
          PEERS_SERVER_NAME,
          s.peers.map(d => ({ name: d.name, description: d.description, shape: d.shape, run: (a: unknown) => runPeerTool(s.peers, d.name, a) })),
        ),
      };
    if (plan) {
      options.resume = plan.resume;
      if (plan.fork) {
        options.forkSession = true;
        options.sessionId = s.id;
      }
    } else {
      options.sessionId = s.id;
    }
    return options;
  }

  private clean(err: unknown): string {
    return redactKey(redactText(err instanceof Error ? err.message : String(err)), this.d.config.apiKey);
  }

  /** A user message: a new turn or more input of the running one; the SDK queues it itself. */
  private async sendInput(s: QwenSession, text: string, uuid: string, images: Image[]): Promise<unknown> {
    s.mirror.user(text, uuid, images, /^<peer-message\b/.test(text.trim()) ? 'peer' : 'human');
    const content = images.length
      ? [...images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data.toString('base64') } })), ...(text ? [{ type: 'text', text }] : [])]
      : text;
    if (s.outstanding === 0) {
      s.turnStartedAt = this.clock();
      s.lastText = '';
      s.interrupted = false;
    }
    s.outstanding++;
    if (s.state !== 'permission') {
      s.state = 'working';
      this.sendState(s);
    }
    s.input.push({ type: 'user', session_id: s.sdkSessionId, message: { role: 'user', content }, parent_tool_use_id: null });
    return {};
  }

  // ---------- messages of the SDK ----------

  private async pump(s: QwenSession): Promise<void> {
    try {
      for await (const msg of s.query) this.onMessage(s, msg);
    } catch (err) {
      if (!s.stopping) this.d.log.warn('qwen stream failed', { sessionId: s.id, error: this.clean(err) });
      s.exitError = this.clean(err);
    }
  }

  private onMessage(s: QwenSession, msg: QwenMessage): void {
    this.d.onActivity?.(s.id, this.clock());
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init' && typeof msg.model === 'string' && !s.model) s.model = msg.model;
        return;
      case 'stream_event':
        this.onStreamEvent(s, msg);
        return;
      case 'assistant':
      case 'user': {
        const usage = msg.message?.usage;
        if (msg.type === 'assistant' && usage) {
          s.lastUsage = {
            input: usage.input_tokens ?? 0,
            output: usage.output_tokens ?? 0,
            cacheRead: usage.cache_read_input_tokens ?? 0,
            cacheCreation: usage.cache_creation_input_tokens ?? 0,
          };
        }
        const r = mirrorMessage(s.mirror, msg, s.model, () => s.seq++);
        if (r?.text) s.lastText = r.text;
        return;
      }
      case 'result':
        this.onResult(s, msg);
        return;
      default:
        return;
    }
  }

  private onStreamEvent(s: QwenSession, msg: QwenMessage): void {
    if (msg.parent_tool_use_id) return;
    const ev = msg.event;
    if (ev?.type === 'message_start' && ev.message?.id) s.partialMessageId = ev.message.id;
    if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
      this.d.send('session.partial', { sessionId: s.id, messageId: s.partialMessageId || s.id, blockIndex: ev.index ?? 0, textDelta: ev.delta.text });
    }
  }

  private onResult(s: QwenSession, msg: QwenMessage): void {
    const interrupted = s.interrupted;
    const failed = msg.is_error === true && !interrupted;
    const rawError = failed ? this.clean(msg.error?.message ?? msg.result ?? 'The Qwen turn ended with an error') : undefined;
    const failure = rawError ? failureOf(rawError) : undefined;
    if (failure) this.d.service.markRejected();
    if (rawError) s.mirror.system('api_error', rawError, `error-${s.seq++}`);
    const resultText = !failed && !interrupted && s.lastText && this.spawnOn() ? s.lastText.slice(0, RESULT_TEXT_MAX) : undefined;
    const u = msg.usage;
    this.d.send('session.result', {
      sessionId: s.id,
      subtype: failed ? 'error_during_execution' : interrupted ? 'interrupted' : 'success',
      isError: failed,
      durationMs: Math.max(0, msg.duration_ms ?? this.clock() - s.turnStartedAt),
      costUsd: 0,
      ...(rawError ? { errorText: rawError.slice(0, 4000) } : {}),
      ...(resultText ? { resultText } : {}),
      usage: {
        inputTokens: u?.input_tokens ?? s.lastUsage?.input ?? 0,
        outputTokens: u?.output_tokens ?? s.lastUsage?.output ?? 0,
        cacheReadTokens: u?.cache_read_input_tokens ?? s.lastUsage?.cacheRead ?? 0,
        cacheCreationTokens: u?.cache_creation_input_tokens ?? s.lastUsage?.cacheCreation ?? 0,
      },
      ...(failure ? { failure } : {}),
    });
    this.sendContext(s, msg);
    s.lastText = '';
    s.lastUsage = null;
    s.outstanding = Math.max(0, s.outstanding - 1);
    if (s.outstanding > 0) return;
    s.interrupted = false;
    for (const q of s.pending.values()) q.resolve({ behavior: 'deny' });
    s.pending.clear();
    s.state = 'waiting';
    this.sendState(s);
  }

  /** The fill of the window: the last request's tokens and the window of the model, once per turn, to hubs ≥1.20. */
  private sendContext(s: QwenSession, msg: QwenMessage): void {
    if (!s.lastUsage || !protocolAtLeast(this.d.hubProtocol?.() ?? null, CONTEXT_PROTOCOL)) return;
    const window = Math.max(0, ...Object.values(msg.modelUsage ?? {}).map(m => m.contextWindow ?? 0));
    if (window <= 0) return;
    const used = s.lastUsage.input + s.lastUsage.cacheRead + s.lastUsage.cacheCreation;
    this.d.send('session.context', {
      sessionId: s.id,
      observedAt: this.clock(),
      model: s.model ? s.model.slice(0, 200) : null,
      usedTokens: used,
      windowTokens: window,
      percent: Math.min(100, Math.round((used / window) * 100)),
    });
  }

  // ---------- permissions ----------

  /** A tool call that needs the user: a permission card of the hub; resolves with the decision (design D6). */
  private canUseTool(s: QwenSession, toolName: string, input: Record<string, unknown>): Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }> {
    const requestId = randomUUID();
    const shown = normalizeTool(toolName, input);
    return new Promise(resolve => {
      s.pending.set(requestId, {
        resolve: r => resolve(r.behavior === 'allow' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Denied in Agent Hub' }),
      });
      s.state = 'permission';
      this.sendState(s);
      this.d.send('permission.request', { requestId, sessionId: s.id, toolName: shown.name, toolUseId: randomUUID(), input: shown.input, suggestions: [], kind: 'tool' });
    });
  }

  private answer(p: PayloadOf<HubMessage, 'permission.response'>): void {
    for (const s of this.sessions.values()) {
      const q = s.pending.get(p.requestId);
      if (!q) continue;
      s.pending.delete(p.requestId);
      q.resolve({ behavior: p.behavior === 'deny' ? 'deny' : 'allow' });
      if (s.pending.size === 0 && !s.stopping) {
        s.state = s.outstanding > 0 ? 'working' : 'waiting';
        this.sendState(s);
      }
      return;
    }
    this.d.log.info('permission response for an unknown qwen request ignored', { requestId: p.requestId });
  }

  // ---------- fork (design D4) ----------

  private async fork(p: PayloadOf<HubMessage, 'session.fork'>): Promise<{ newSessionId: string }> {
    assertLocalPath(p.cwd);
    const plan = await readResumePlan(this.d.projectsDir, p.sourceSessionId);
    if (!plan) throw new CmdError('fork_failed', 'The history of a Qwen session exists only on the machine where it ran');
    try {
      const newSessionId = randomUUID();
      const w = new MirrorWriter(
        this.d.projectsDir,
        newSessionId,
        p.cwd,
        () => this.clock(),
        () => undefined,
        QWEN_MIRROR,
      );
      // the chat of the CLI is forked at the first resume of the copy (the SDK forks only while resuming)
      w.copyFrom(await readLines(this.d.projectsDir, p.sourceSessionId, QWEN_MIRROR_DIR), newSessionId, { forkedFrom: plan.resume });
      if (p.title) w.system('custom-title', p.title);
      await w.flush();
      this.d.log.info('qwen session forked', { source: p.sourceSessionId, copy: newSessionId });
      return { newSessionId };
    } catch (err) {
      throw new CmdError('fork_failed', this.clean(err));
    }
  }

  // ---------- stop / exit ----------

  private async stop(sessionId: string, reason: 'sleep' | 'user', graceMs?: number): Promise<unknown> {
    const s = this.sessions.get(sessionId);
    if (!s) return { alreadyStopped: true };
    s.stopping = reason;
    for (const q of s.pending.values()) q.resolve({ behavior: 'deny' });
    s.pending.clear();
    if (s.outstanding > 0) await s.query.interrupt().catch(() => undefined);
    s.input.close();
    const grace = graceMs ?? this.d.stopGraceMs ?? 10_000;
    const timer = setTimeout(() => {
      this.d.log.warn('qwen session did not stop in time, killing', { sessionId, graceMs: grace });
      s.abort.abort();
    }, grace);
    try {
      await s.query.close().catch(() => undefined);
      await s.done;
    } finally {
      clearTimeout(timer);
    }
    return {};
  }

  private onExit(s: QwenSession): void {
    for (const q of s.pending.values()) q.resolve({ behavior: 'deny' });
    s.pending.clear();
    if (this.sessions.get(s.id) === s) this.sessions.delete(s.id);
    const stopped = !!s.stopping;
    const errorText = stopped ? undefined : redactText(s.exitError ?? 'The Qwen process exited unexpectedly');
    this.d.log.info('qwen session exited', { sessionId: s.id, reason: stopped ? 'stopped' : 'crashed', ...(errorText ? { error: errorText } : {}) });
    this.d.send('session.exited', { sessionId: s.id, code: stopped ? 0 : null, reason: stopped ? 'stopped' : 'crashed', ...(errorText ? { errorText } : {}) });
    this.d.onSessionExited?.(s.id);
  }

  private sendState(s: QwenSession): void {
    this.d.send('session.state', { sessionId: s.id, state: s.state, processAlive: !s.stopping, permissionMode: s.mode });
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}
