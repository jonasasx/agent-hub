// Codex as a provider of sessions (change agent-providers, design D5–D9, D11): one `codex app-server` per live
// session, the hub's commands mapped to the app-server protocol, the mirror transcript written for the hub.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  LIMITS_PROTOCOL,
  PEERS_PROTOCOL,
  PEERS_SERVER_NAME,
  protocolAtLeast,
  RESULT_TEXT_MAX,
  SPAWN_PROTOCOL,
  type Attachment,
  type HubMessage,
  type LimitsProbeResult,
  type LiveSessionState,
  type McpServerSnapshot,
  type McpSnapshot,
  type PayloadOf,
  type PermissionMode,
  type ProviderStatus,
  type TurnFailure,
  MCP_REGISTRY_PROTOCOL,
} from '@agent-hub/shared';
import type { Logger } from '../../log.js';
import { assertLocalPath, CmdError, HUB_SYSTEM_PROMPT_APPEND, PEERS_SYSTEM_PROMPT_APPEND, SPAWN_SYSTEM_PROMPT_APPEND } from '../../sessions/manager.js';
import { projectRootOf } from '../../sessions/mcp.js';
import { redactText } from '../../sessions/mcpRedact.js';
import type { PeersClient } from '../../peers/client.js';
import { peersToolDefs, runPeerTool, type PeerToolDef } from '../../peers/tools.js';
import type { SessionProvider } from '../types.js';
import type { CodexBin } from './bin.js';
import type { CodexHomes } from './homes.js';
import type { RegistrySnapshot } from '../../mcp/registryCache.js';
import type { McpGateway } from '../../mcp/gateway.js';
import type { McpDraftClient } from '../../mcp/draftClient.js';
import { serversForProject } from '../../mcp/projectPolicy.js';
import { snapshotOfRateLimits } from './limits.js';
import { codexMcpServers } from './mcpConfig.js';
import { CODEX_MIRROR_DIR, MirrorWriter, readHeader, readLines, unwrapShell, type CodexItem } from './mirror.js';
import { initialize, RpcClient, spawnAppServer, type RpcTransport } from './rpc.js';
import { CodexService, type CodexModel } from './service.js';

type StartPayload = PayloadOf<HubMessage, 'session.start'>;
type ResumePayload = PayloadOf<HubMessage, 'session.resume'>;
type Image = { mime: string; data: Buffer };

/** Design D6: the hub's permission mode → the approval policy and the sandbox of Codex. */
export function policyOf(mode: PermissionMode, cwd: string): { approvalPolicy: string; sandbox: string; sandboxPolicy: Record<string, unknown> } {
  switch (mode) {
    case 'bypassPermissions':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } };
    case 'acceptEdits':
      return {
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
      };
    case 'plan':
      return { approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: true } };
    default:
      return {
        approvalPolicy: 'untrusted',
        sandbox: 'workspace-write',
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
      };
  }
}

const PLAN_INSTRUCTIONS = 'Режим планирования: ничего не меняй (файлы, команды с побочными эффектами), только исследуй и предложи план.';

/** A turn error → the failure the hub knows (design D5). */
export function failureOf(error: { message?: unknown; codexErrorInfo?: unknown } | null | undefined): TurnFailure | undefined {
  if (!error) return undefined;
  const info = error.codexErrorInfo;
  const message = typeof error.message === 'string' ? error.message.slice(0, 2000) : undefined;
  if (info === 'unauthorized') return { kind: 'auth_rejected', ...(message ? { message } : {}) };
  if (info === 'usageLimitExceeded' || info === 'sessionBudgetExceeded') return { kind: 'subscription_limit', ...(message ? { message } : {}) };
  return undefined;
}

interface Pending {
  kind: 'tool' | 'question' | 'plan';
  method: string;
  resolve: (result: unknown) => void;
  /** request id of the app-server (serverRequest/resolved). */
  rpcId: number | string;
  questions?: Array<{ id: string; question: string }>;
}

class CodexSession {
  state: LiveSessionState = 'waiting';
  threadId = '';
  turnId: string | null = null;
  turnStartedAt = 0;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number } | null = null;
  turnError: { message?: unknown; codexErrorInfo?: unknown } | null = null;
  planVersion = 0;
  /** hub-subagents D2: the text of the turn's last agentMessage — the result for the parent's report. */
  lastAgentText = '';
  stopping: 'sleep' | 'user' | null = null;
  readonly pending = new Map<string, Pending>();
  /** item/started of file changes: the approval request carries only the item id. */
  readonly items = new Map<string, CodexItem>();
  rpc!: RpcClient;
  mirror!: MirrorWriter;
  done!: Promise<void>;
  peers: PeerToolDef[] = [];
  /** provider-parity: the subscription of the registry the process runs under (its own CODEX_HOME). */
  subscriptionId: string | null = null;

  constructor(
    readonly id: string,
    readonly cwd: string,
    public mode: PermissionMode,
    public model: string | null,
  ) {}
}

export interface CodexProviderDeps {
  bin: CodexBin;
  /** false — the hub is not connected, the message is dropped. */
  send: (type: string, payload: unknown) => boolean | void;
  log: Logger;
  /** ~/.claude/projects: the mirrors are written into its agent-hub-codex folder. */
  projectsDir: string;
  agentVersion: string;
  /** Images of a command from the agent's cache (attachments.fetch) or downloaded. */
  images: (attachments: Attachment[] | undefined) => Promise<Image[]>;
  hubProtocol?: () => string | null;
  peers?: Pick<PeersClient, 'request'>;
  /** The replication follows the mirror of a started session first. */
  onSessionStarted?: (sessionId: string, dir: string) => void;
  onSessionExited?: (sessionId: string) => void;
  onActivity?: (sessionId: string, at: number) => void;
  /** agent.status with the providers list. */
  onStatus?: (s: ProviderStatus) => void;
  stopGraceMs?: number;
  /** provider-parity: CODEX_HOME per subscription. Absent — sessions run under the machine's sign-in only. */
  homes?: CodexHomes;
  registry?: () => RegistrySnapshot | null;
  gateway?: McpGateway;
  mcpDraft?: Pick<McpDraftClient, 'request'>;
  machineId?: () => string | null;
  now?: () => number;
  /** Tests: fake app-servers. */
  transport?: () => RpcTransport;
  serviceTransport?: () => RpcTransport;
}

export class CodexProvider implements SessionProvider {
  readonly id = 'codex' as const;
  private readonly sessions = new Map<string, CodexSession>();
  readonly service: CodexService;

  constructor(private readonly d: CodexProviderDeps) {
    this.service = new CodexService({
      bin: d.bin,
      log: d.log,
      agentVersion: d.agentVersion,
      onLoginDone: (loginId, ok, error, credential) => d.send('provider.login.done', { provider: 'codex', loginId, ok, ...(error ? { error } : {}), ...(credential ? { credential } : {}) }),
      ...(d.homes ? { homes: d.homes } : {}),
      onStatus: s => d.onStatus?.(s),
      ...(d.serviceTransport ? { transport: d.serviceTransport } : {}),
      ...(d.now ? { now: d.now } : {}),
    });
  }

  private clock(): number {
    return this.d.now?.() ?? Date.now();
  }

  status(): ProviderStatus {
    return this.service.status;
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
    this.service.stop();
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
        if (s.turnId) await s.rpc.request('turn/interrupt', { threadId: s.threadId, turnId: s.turnId }, 30_000);
        return {};
      }
      case 'session.set_mode': {
        const s = this.live(m.payload.sessionId);
        // design D6: the next turn/start carries the new policy
        s.mode = m.payload.mode;
        this.sendState(s);
        return {};
      }
      case 'session.set_model': {
        this.live(m.payload.sessionId).model = m.payload.model;
        return {};
      }
      case 'session.stop':
        return this.stop(m.payload.sessionId, m.payload.reason);
      case 'permission.response':
        this.answer(m.payload);
        return undefined;
      case 'session.fork':
        return this.fork(m.payload);
      case 'mcp.status.get':
        return { snapshot: await this.mcpSnapshot(this.live(m.payload.sessionId)) };
      case 'mcp.registry.session-update': {
        const sessionId = m.payload.sessionId;
        this.d.send('mcp.registry.session-update.ack', {
          sessionId,
          revision: m.payload.revision,
          activation: 'available-next-thread',
          applied: true,
          error: 'This server will appear in the next Codex thread or new session.',
        });
        return { activation: 'available-next-thread' };
      }
      case 'mcp.action':
      case 'mcp.auth.start':
      case 'mcp.auth.callback':
      case 'mcp.auth.logout':
        throw new CmdError('mcp_not_supported', 'В сессии Codex панель MCP показывает только статусы');
      case 'provider.login.start':
        return m.payload.forSubscription ? this.service.loginStartForSubscription() : this.service.loginStart();
      case 'limits.probe':
        return this.probe(m.payload);
      case 'provider.login.cancel':
        await this.service.loginCancel(m.payload.loginId);
        return {};
      case 'provider.logout':
        await this.service.logout();
        return {};
      default:
        throw new CmdError('not_implemented', `${m.type} is not supported by Codex sessions`);
    }
  }

  private live(sessionId: string): CodexSession {
    const s = this.sessions.get(sessionId);
    if (!s || s.stopping) throw new CmdError('not_running', `session ${sessionId} has no live process on this machine`);
    return s;
  }

  // ---------- start / resume ----------

  private spawnOn(): boolean {
    return protocolAtLeast(this.d.hubProtocol?.() ?? null, SPAWN_PROTOCOL);
  }

  private developerInstructions(peersOn: boolean, mode: PermissionMode, spawnOn = false): string {
    const parts = [HUB_SYSTEM_PROMPT_APPEND.replace('инструментом Read', 'по пути (просмотр изображения)')];
    if (peersOn) parts.push(PEERS_SYSTEM_PROMPT_APPEND);
    if (spawnOn) parts.push(SPAWN_SYSTEM_PROMPT_APPEND);
    if (mode === 'plan') parts.push(PLAN_INSTRUCTIONS);
    return parts.join('\n\n');
  }

  private async start(p: StartPayload | ResumePayload, resume: boolean): Promise<{ models: CodexModel[] }> {
    assertLocalPath(p.cwd);
    const existing = this.sessions.get(p.sessionId);
    if (existing && !existing.stopping) {
      if (!resume) throw new CmdError('already_running', `session ${p.sessionId} is already running`);
      const imgs = await this.d.images(p.attachments);
      if (p.prompt || imgs.length) await this.sendInput(existing, p.prompt ?? '', p.promptUuid ?? randomUUID(), imgs);
      return { models: await this.models() };
    }
    if (existing) await existing.done;
    const images = await this.d.images(p.attachments);
    const header = resume ? await readHeader(this.d.projectsDir, p.sessionId) : null;
    if (resume && !header) throw new CmdError('transcript_missing', 'История сессии Codex есть только на машине, где она шла');

    const registrySnapshot = this.d.registry?.();
    const registryProtocol = protocolAtLeast(this.d.hubProtocol?.() ?? null, MCP_REGISTRY_PROTOCOL);
    const registryMode = registryProtocol && registrySnapshot?.registryEnabled === true;
    const s = new CodexSession(p.sessionId, p.cwd, p.permissionMode, p.model ?? null);
    const sub = p.subscription?.provider === 'codex' ? p.subscription : null;
    if (sub && !this.d.homes) throw new CmdError('not_implemented', 'Подписки Codex не поддерживаются этим агентом');
    const home = sub ? await this.d.homes!.prepare(sub.id, sub.token, registryMode) : undefined;
    s.subscriptionId = sub?.id ?? null;
    const t = this.d.transport ? this.d.transport() : spawnAppServer(this.d.bin, this.d.log, [], home);
    s.rpc = new RpcClient(t, {
      log: this.d.log,
      onNotification: (method, params) => this.onNotification(s, method, params),
      onRequest: (method, params, id) => this.onServerRequest(s, method, params, id),
    });
    s.mirror = new MirrorWriter(
      this.d.projectsDir,
      s.id,
      s.cwd,
      () => this.clock(),
      err => this.d.log.error('codex mirror write failed', { sessionId: s.id, error: err.message }),
    );
    this.sessions.set(s.id, s);
    let exitError: string | null = null;
    s.done = s.rpc.exited.then(r => {
      exitError = r.error;
    });
    void s.done.then(() => this.onExit(s, exitError));
    this.d.log.info(resume ? 'resuming codex session' : 'starting codex session', { sessionId: s.id, cwd: s.cwd, mode: s.mode, model: s.model });

    try {
      await initialize(s.rpc, this.d.agentVersion);
      const peersOn = !!this.d.peers && protocolAtLeast(this.d.hubProtocol?.() ?? null, PEERS_PROTOCOL);
      const spawnOn = peersOn && this.spawnOn();
      // A machine with registry mode enabled gets registry definitions in thread/start.
      const machineId = this.d.machineId?.();
      s.peers = peersOn
        ? peersToolDefs(s.id, this.d.peers!, {
            spawn: spawnOn,
            ...(registryMode && this.d.mcpDraft && machineId ? { mcpDraft: this.d.mcpDraft, machineId } : {}),
          })
        : [];
      const mcpServers: Record<string, unknown> = {};
      if (registryMode && this.d.gateway && registrySnapshot) {
        for (const server of serversForProject(registrySnapshot, p.projectId)) {
          const machineId = this.d.machineId?.();
          if (!server.enabled || (!server.machineScope.allMachines && (!machineId || !server.machineScope.machineIds.includes(machineId))) || server.secrets.some(x => x.state === 'needs-secret'))
            continue;
          const bearer = this.d.gateway.authorize(server.id, s.id);
          mcpServers[server.name] = { url: `${this.d.gateway.url}?server=${encodeURIComponent(server.id)}`, http_headers: { Authorization: `Bearer ${bearer}`, 'x-agent-session': s.id } };
        }
      } else {
        const legacy = codexMcpServers(s.cwd, { exclude: [PEERS_SERVER_NAME] });
        Object.assign(mcpServers, legacy.servers);
        if (legacy.skipped.length) this.d.log.info('codex: MCP servers left out', { sessionId: s.id, skipped: legacy.skipped });
      }
      const mcp = { servers: mcpServers };
      const pol = policyOf(s.mode, s.cwd);
      const common = {
        cwd: s.cwd,
        ...(s.model ? { model: s.model } : {}),
        approvalPolicy: pol.approvalPolicy,
        sandbox: pol.sandbox,
        config: { mcp_servers: mcp.servers },
        developerInstructions: this.developerInstructions(peersOn, s.mode, spawnOn),
      };
      // client tools are declared at thread/start only (thread/resume has no such field): the thread keeps them
      const tools = s.peers.length
        ? {
            dynamicTools: [
              {
                type: 'namespace',
                name: PEERS_SERVER_NAME,
                description: spawnOn ? 'Сессии Agent Hub: список, подробности, сообщения другим сессиям, запуск новой сессии' : 'Сессии Agent Hub: список, подробности, сообщения другим сессиям',
                tools: s.peers.map(d => ({ type: 'function', name: d.name, description: d.description, inputSchema: z.toJSONSchema(z.object(d.shape)) })),
              },
            ],
          }
        : {};
      const r = await s.rpc.request<{ thread: { id: string }; model?: string }>(
        resume ? 'thread/resume' : 'thread/start',
        resume ? { threadId: header!.threadId, excludeTurns: true, ...common } : { ...common, ...tools },
        120_000,
      );
      s.threadId = r.thread.id;
      if (!s.model && r.model) s.model = r.model;
      await s.mirror.open();
      if (!resume) {
        s.mirror.header(s.threadId, s.model);
        // the thread of the session is on disk before the hub hears of it (resume and fork read it)
        await s.mirror.flush();
      }
    } catch (err) {
      const message = redactText(err instanceof Error ? err.message : String(err));
      s.rpc.kill();
      throw new CmdError('start_failed', `Codex не запустился: ${message}`);
    }
    this.d.onSessionStarted?.(s.id, CODEX_MIRROR_DIR);
    if (p.prompt || images.length) await this.sendInput(s, p.prompt ?? '', p.promptUuid ?? randomUUID(), images);
    else this.sendState(s);
    this.pushMcpStatus(s);
    return { models: await this.models() };
  }

  /** The panel hears of the live process and its servers by itself, as with Claude Code (otherwise it keeps «Сессия спит»). */
  private pushMcpStatus(s: CodexSession): void {
    void this.mcpSnapshot(s).then(
      snapshot => {
        if (!s.stopping) this.d.send('mcp.status', { sessionId: s.id, snapshot });
      },
      (err: unknown) => this.d.log.warn('codex mcp status push failed', { sessionId: s.id, error: err instanceof Error ? err.message : String(err) }),
    );
  }

  private async models(): Promise<CodexModel[]> {
    try {
      return await this.service.listModels();
    } catch (err) {
      this.d.log.warn('codex model list failed', { error: (err as Error).message });
      return [];
    }
  }

  /** Images go to Codex as local files (UserInput localImage) in the OS temp folder, named by their sha256. */
  private async imageFiles(images: Image[]): Promise<string[]> {
    if (!images.length) return [];
    const dir = join(tmpdir(), 'agent-hub-codex-images');
    await mkdir(dir, { recursive: true });
    return Promise.all(
      images.map(async i => {
        const ext = i.mime.split('/')[1] === 'jpeg' ? 'jpg' : (i.mime.split('/')[1] ?? 'png');
        const file = join(dir, `${createHash('sha256').update(i.data).digest('hex')}.${ext}`);
        await writeFile(file, i.data);
        return file;
      }),
    );
  }

  /** A user message: a new turn, or more input of the running one (turn/steer). */
  private async sendInput(s: CodexSession, text: string, uuid: string, images: Image[]): Promise<unknown> {
    const files = await this.imageFiles(images);
    const input = [...files.map(path => ({ type: 'localImage', path })), ...(text ? [{ type: 'text', text, text_elements: [] }] : [])];
    // the hub confirms delivery by this uuid in the transcript (design D4)
    s.mirror.user(text, uuid, images, /^<peer-message\b/.test(text.trim()) ? 'peer' : 'human');
    if (s.state !== 'permission') {
      s.state = 'working';
      this.sendState(s);
    }
    if (s.turnId) {
      try {
        await s.rpc.request('turn/steer', { threadId: s.threadId, input, clientUserMessageId: uuid, expectedTurnId: s.turnId }, 60_000);
        return {};
      } catch (err) {
        // the turn ended in between: a new one
        this.d.log.info('codex steer refused, starting a turn', { sessionId: s.id, error: (err as Error).message });
      }
    }
    const pol = policyOf(s.mode, s.cwd);
    const r = await s.rpc.request<{ turn: { id: string } }>(
      'turn/start',
      { threadId: s.threadId, input, clientUserMessageId: uuid, approvalPolicy: pol.approvalPolicy, sandboxPolicy: pol.sandboxPolicy, ...(s.model ? { model: s.model } : {}) },
      120_000,
    );
    if (!s.turnId) {
      s.turnId = r.turn.id;
      s.turnStartedAt = this.clock();
    }
    return {};
  }

  // ---------- events of the app-server ----------

  private onNotification(s: CodexSession, method: string, p: Record<string, unknown>): void {
    this.d.onActivity?.(s.id, this.clock());
    if (typeof p.threadId === 'string' && s.threadId && p.threadId !== s.threadId) return;
    switch (method) {
      case 'turn/started': {
        const turn = p.turn as { id: string };
        s.turnId = turn.id;
        s.turnStartedAt = this.clock();
        s.turnError = null;
        s.lastAgentText = '';
        s.usage = null;
        if (s.state === 'waiting') {
          s.state = 'working';
          this.sendState(s);
        }
        return;
      }
      case 'item/started': {
        const item = p.item as CodexItem;
        if (item?.type === 'fileChange' || item?.type === 'commandExecution') s.items.set(item.id, item);
        return;
      }
      case 'item/completed': {
        const item = p.item as CodexItem;
        s.items.delete(item.id);
        if (item.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()) s.lastAgentText = item.text;
        s.mirror.item(item, s.model);
        return;
      }
      case 'item/agentMessage/delta':
        if (typeof p.delta === 'string' && typeof p.itemId === 'string') this.d.send('session.partial', { sessionId: s.id, messageId: p.itemId, blockIndex: 0, textDelta: p.delta });
        return;
      case 'turn/plan/updated':
        if (Array.isArray(p.plan)) s.mirror.plan(String(p.turnId ?? s.turnId ?? ''), s.planVersion++, p.plan as Array<{ step?: unknown; status?: unknown }>, s.model);
        return;
      case 'thread/tokenUsage/updated': {
        const last = (p.tokenUsage as { last?: Record<string, number> } | undefined)?.last;
        if (last)
          s.usage = {
            inputTokens: last.inputTokens ?? 0,
            outputTokens: (last.outputTokens ?? 0) + (last.reasoningOutputTokens ?? 0),
            cacheReadTokens: last.cachedInputTokens ?? 0,
            cacheCreationTokens: last.cacheWriteInputTokens ?? 0,
          };
        return;
      }
      case 'error':
        if (p.willRetry !== true) s.turnError = (p.error ?? null) as CodexSession['turnError'];
        return;
      case 'turn/completed':
        return this.onTurnCompleted(s, p.turn as { id: string; status: string; error: CodexSession['turnError']; durationMs: number | null });
      case 'serverRequest/resolved': {
        // the app-server closed a request itself (the turn ended, a timeout): the card goes away with the state
        for (const [rid, q] of s.pending) if (String(q.rpcId) === String(p.requestId)) s.pending.delete(rid);
        if (s.state === 'permission' && s.pending.size === 0) {
          s.state = s.turnId ? 'working' : 'waiting';
          this.sendState(s);
        }
        return;
      }
      default:
        return;
    }
  }

  private onTurnCompleted(s: CodexSession, turn: { id: string; status: string; error: CodexSession['turnError']; durationMs: number | null }): void {
    const error = turn.error ?? s.turnError;
    const failed = turn.status === 'failed';
    const interrupted = turn.status === 'interrupted';
    const failure = failed ? failureOf(error) : undefined;
    // a subscription's home is not the machine's own sign-in
    if (failure?.kind === 'auth_rejected' && !s.subscriptionId) this.service.markRejected();
    const errorText = failed ? (typeof error?.message === 'string' ? error.message : 'Ход Codex завершился ошибкой') : undefined;
    if (failed && errorText) s.mirror.system('api_error', errorText, `error-${turn.id}`);
    // hub-subagents D2: the text of a successful turn, for the report to the parent session
    const resultText = !failed && !interrupted && s.lastAgentText && this.spawnOn() ? s.lastAgentText.slice(0, RESULT_TEXT_MAX) : undefined;
    s.lastAgentText = '';
    this.d.send('session.result', {
      sessionId: s.id,
      subtype: failed ? 'error_during_execution' : interrupted ? 'interrupted' : 'success',
      isError: failed,
      durationMs: Math.max(0, turn.durationMs ?? this.clock() - s.turnStartedAt),
      costUsd: 0,
      ...(errorText ? { errorText: errorText.slice(0, 4000) } : {}),
      ...(resultText ? { resultText } : {}),
      usage: s.usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      ...(failure ? { failure } : {}),
    });
    if (s.turnId === turn.id) s.turnId = null;
    s.turnError = null;
    s.usage = null;
    for (const [rid, q] of s.pending) {
      q.resolve(this.cancelAnswer(q));
      s.pending.delete(rid);
    }
    s.state = 'waiting';
    this.sendState(s);
    void this.afterTurn(s);
  }

  /** provider-parity D4, D5: tokens the CLI rotated go to the hub; the limits of the subscription follow the turn. */
  private async afterTurn(s: CodexSession): Promise<void> {
    await this.syncCredential(s.subscriptionId);
    if (!s.subscriptionId || !protocolAtLeast(this.d.hubProtocol?.() ?? null, LIMITS_PROTOCOL) || !s.rpc.alive) return;
    try {
      const r = await s.rpc.request<Parameters<typeof snapshotOfRateLimits>[0]>('account/rateLimits/read', undefined, 30_000);
      const snapshot = snapshotOfRateLimits(r);
      this.d.send('limits.event', { sessionId: s.id, snapshot, quiet: snapshot === null, observedAt: this.clock() });
    } catch (err) {
      this.d.log.debug('codex rate limits read failed', { sessionId: s.id, error: (err as Error).message });
    }
  }

  private async syncCredential(subscriptionId: string | null): Promise<void> {
    if (!subscriptionId || !this.d.homes) return;
    const credential = await this.d.homes.changed(subscriptionId);
    // known to the agent only once the hub got it; otherwise the next turn or probe sends it again
    if (credential && this.d.send('provider.credential.update', { subscriptionId, credential }) !== false) this.d.homes.confirm(subscriptionId, credential);
  }

  /** limits.probe under a Codex subscription: the rate limits of its sign-in, no turn is spent. */
  private async probe(p: PayloadOf<HubMessage, 'limits.probe'>): Promise<LimitsProbeResult> {
    const homes = this.d.homes;
    if (p.subscription.provider !== 'codex' || !homes) throw new CmdError('not_implemented', 'limits.probe: подписка Codex не поддерживается этим агентом');
    const started = this.clock();
    const done = (o: Pick<LimitsProbeResult, 'outcome' | 'snapshot' | 'message'>): LimitsProbeResult => ({ resetsAt: null, limitType: null, durationMs: Math.max(0, this.clock() - started), ...o });
    try {
      const home = await homes.prepare(p.subscription.id, p.subscription.token);
      const snapshot = snapshotOfRateLimits(await this.service.rateLimitsIn(home));
      await this.syncCredential(p.subscription.id);
      const full = snapshot?.windows.find(w => w.status === 'rejected');
      if (full) return { ...done({ outcome: 'limit', snapshot, message: null }), resetsAt: full.resetsAt, limitType: full.type };
      return done({ outcome: snapshot ? 'ok' : 'no_event', snapshot, message: null });
    } catch (err) {
      const message = redactText(err instanceof Error ? err.message : String(err)).slice(0, 500);
      if (/unauthori|401|sign in|log in|token/i.test(message)) return done({ outcome: 'auth_rejected', snapshot: null, message });
      throw new CmdError('probe_failed', message);
    }
  }

  // ---------- requests of the app-server ----------

  private onServerRequest(s: CodexSession, method: string, p: Record<string, unknown>, rpcId: number | string): Promise<unknown> {
    switch (method) {
      case 'item/commandExecution/requestApproval':
        return this.ask(
          s,
          method,
          rpcId,
          'tool',
          'Bash',
          String(p.itemId ?? rpcId),
          { command: unwrapShell(String(p.command ?? (s.items.get(String(p.itemId))?.command as string | undefined) ?? '')), cwd: p.cwd ?? s.cwd, ...(p.reason ? { reason: p.reason } : {}) },
          typeof p.reason === 'string' ? p.reason : undefined,
        );
      case 'item/fileChange/requestApproval': {
        const item = s.items.get(String(p.itemId));
        const changes = Array.isArray(item?.changes)
          ? (item!.changes as Array<{ path?: unknown; kind?: { type?: unknown }; diff?: unknown }>).map(c => ({
              path: String(c.path ?? ''),
              kind: String(c.kind?.type ?? 'update'),
              diff: String(c.diff ?? ''),
            }))
          : [];
        return this.ask(
          s,
          method,
          rpcId,
          'tool',
          'ApplyPatch',
          String(p.itemId ?? rpcId),
          { changes, ...(p.reason ? { reason: p.reason } : {}), ...(p.grantRoot ? { grantRoot: p.grantRoot } : {}) },
          typeof p.reason === 'string' ? p.reason : undefined,
        );
      }
      case 'item/permissions/requestApproval':
        return this.ask(
          s,
          method,
          rpcId,
          'tool',
          'Permissions',
          String(p.itemId ?? rpcId),
          { permissions: p.permissions ?? {}, cwd: p.cwd ?? s.cwd, ...(p.reason ? { reason: p.reason } : {}) },
          typeof p.reason === 'string' ? p.reason : undefined,
        ).then(r => (r === 'accept' || r === 'acceptForSession' ? { permissions: p.permissions ?? {}, scope: r === 'acceptForSession' ? 'session' : 'turn' } : { permissions: {}, scope: 'turn' }));
      case 'item/tool/requestUserInput': {
        const qs = Array.isArray(p.questions) ? (p.questions as Array<{ id: string; header?: string; question: string; options?: Array<{ label: string; description?: string }> | null }>) : [];
        const input = {
          questions: qs.map(q => ({
            question: q.question,
            header: (q.header ?? '').slice(0, 30),
            options: (q.options ?? []).map(o => ({ label: o.label, description: o.description ?? '' })),
            multiSelect: false,
          })),
        };
        return this.ask(
          s,
          method,
          rpcId,
          'question',
          'AskUserQuestion',
          String(p.itemId ?? rpcId),
          input,
          undefined,
          qs.map(q => ({ id: q.id, question: q.question })),
        );
      }
      case 'item/tool/call':
        return this.toolCall(s, p);
      case 'mcpServer/elicitation/request':
        s.mirror.system('codex_item', `MCP-сервер ${String(p.serverName)} запросил ввод — отклонено (не поддерживается в хабе)`);
        return Promise.resolve({ action: 'decline', content: null, _meta: null });
      case 'applyPatchApproval':
      case 'execCommandApproval':
        return Promise.resolve({ decision: { denied: { rejection: 'not supported by Agent Hub' } } });
      default:
        return Promise.reject(new Error(`${method} is not supported by Agent Hub`));
    }
  }

  /** A client tool call of the agent-hub namespace (design D9). */
  private async toolCall(s: CodexSession, p: Record<string, unknown>): Promise<unknown> {
    const tool = String(p.tool ?? '');
    const r = s.peers.length ? await runPeerTool(s.peers, tool, p.arguments) : { content: [{ type: 'text' as const, text: `unknown tool ${tool}` }], isError: true };
    return { contentItems: r.content.map(c => ({ type: 'inputText', text: c.text })), success: !r.isError };
  }

  /**
   * A request of the app-server as a permission card of the hub (design D7). Resolves with the decision of Codex:
   * `accept`, `acceptForSession`, `decline`, `cancel`; for a question — its answers.
   */
  private ask(
    s: CodexSession,
    method: string,
    rpcId: number | string,
    kind: 'tool' | 'question',
    toolName: string,
    toolUseId: string,
    input: Record<string, unknown>,
    reason?: string,
    questions?: Array<{ id: string; question: string }>,
  ): Promise<unknown> {
    const requestId = randomUUID();
    return new Promise(resolve => {
      s.pending.set(requestId, { kind, method, rpcId, resolve, ...(questions ? { questions } : {}) });
      s.state = 'permission';
      this.sendState(s);
      this.d.send('permission.request', { requestId, sessionId: s.id, toolName, toolUseId, input, suggestions: [], kind, ...(reason ? { reason } : {}) });
    });
  }

  /** The answer of a request closed without the user (stop, end of the turn). */
  private cancelAnswer(q: Pending): unknown {
    if (q.kind === 'question') return { answers: {} };
    return q.method === 'item/permissions/requestApproval' ? 'cancel' : { decision: 'cancel' };
  }

  private answer(p: PayloadOf<HubMessage, 'permission.response'>): void {
    for (const s of this.sessions.values()) {
      const q = s.pending.get(p.requestId);
      if (!q) continue;
      s.pending.delete(p.requestId);
      if (q.kind === 'question') {
        const answers: Record<string, { answers: string[] }> = {};
        if (p.behavior === 'allow') {
          for (const item of q.questions ?? []) {
            const a = p.answers?.[item.question];
            if (a !== undefined) answers[item.id] = { answers: Array.isArray(a) ? a : [a] };
          }
        }
        q.resolve({ answers });
      } else {
        const decision = p.behavior === 'deny' ? 'decline' : p.scope === 'session' ? 'acceptForSession' : 'accept';
        q.resolve(q.method === 'item/permissions/requestApproval' ? decision : { decision });
      }
      if (s.pending.size === 0 && !s.stopping) {
        s.state = s.turnId ? 'working' : 'waiting';
        this.sendState(s);
      }
      return;
    }
    this.d.log.info('permission response for an unknown codex request ignored', { requestId: p.requestId });
  }

  // ---------- MCP status (design D8) ----------

  private async mcpSnapshot(s: CodexSession): Promise<McpSnapshot> {
    // the thread's servers (config.mcp_servers of thread/start), not only those of CODEX_HOME's config.toml
    const servers: McpServerSnapshot[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const r: {
        data: Array<{
          name: string;
          httpOrigin: string | null;
          tools: Record<string, unknown>;
          toolsError: string | null;
          authStatus: string;
          serverInfo: { name?: string; version?: string } | null;
          pluginId: string | null;
        }>;
        nextCursor?: string | null;
      } = await s.rpc.request('mcpServerStatus/list', { threadId: s.threadId, ...(cursor ? { cursor } : {}) }, 30_000);
      for (const x of r.data) {
        const needsAuth = x.authStatus === 'notLoggedIn';
        const status = x.toolsError ? (needsAuth ? 'needs-auth' : 'failed') : needsAuth ? 'needs-auth' : 'connected';
        servers.push({
          name: x.name,
          status,
          ...(x.toolsError ? { error: redactText(x.toolsError).slice(0, 1000) } : {}),
          transport: x.httpOrigin ? 'http' : 'stdio',
          ...(x.httpOrigin ? { target: x.httpOrigin } : {}),
          scope: x.pluginId ? 'plugin' : 'user',
          ...(x.serverInfo?.name ? { serverInfo: { name: String(x.serverInfo.name).slice(0, 200), version: String(x.serverInfo.version ?? '').slice(0, 100) } } : {}),
          toolCount: Object.keys(x.tools ?? {}).length,
          ...(x.authStatus === 'oAuth' || needsAuth ? { oauth: true } : {}),
        });
      }
      cursor = r.nextCursor ?? null;
      if (!cursor) break;
    }
    return { servers: servers.slice(0, 100), observedAt: this.clock(), projectRoot: projectRootOf(s.cwd) };
  }

  // ---------- fork (design D11) ----------

  private async fork(p: PayloadOf<HubMessage, 'session.fork'>): Promise<{ newSessionId: string }> {
    assertLocalPath(p.cwd);
    const header = await readHeader(this.d.projectsDir, p.sourceSessionId);
    if (!header) throw new CmdError('fork_failed', 'История сессии Codex есть только на машине, где она шла');
    try {
      const threadId = await this.service.fork(header.threadId, p.cwd);
      const newSessionId = randomUUID();
      const w = new MirrorWriter(this.d.projectsDir, newSessionId, p.cwd, () => this.clock());
      w.copyFrom(await readLines(this.d.projectsDir, p.sourceSessionId), threadId);
      if (p.title) w.system('custom-title', p.title);
      await w.flush();
      this.d.log.info('codex session forked', { source: p.sourceSessionId, copy: newSessionId });
      return { newSessionId };
    } catch (err) {
      throw new CmdError('fork_failed', redactText(err instanceof Error ? err.message : String(err)));
    }
  }

  // ---------- stop / exit ----------

  private async stop(sessionId: string, reason: 'sleep' | 'user', graceMs?: number): Promise<unknown> {
    const s = this.sessions.get(sessionId);
    if (!s) return { alreadyStopped: true };
    s.stopping = reason;
    for (const q of s.pending.values()) q.resolve(this.cancelAnswer(q));
    s.pending.clear();
    if (s.turnId) await s.rpc.request('turn/interrupt', { threadId: s.threadId, turnId: s.turnId }, 5_000).catch(() => undefined);
    s.rpc.close();
    const grace = graceMs ?? this.d.stopGraceMs ?? 10_000;
    const timer = setTimeout(() => {
      this.d.log.warn('codex session did not stop in time, killing', { sessionId, graceMs: grace });
      s.rpc.kill();
    }, grace);
    try {
      await s.done;
    } finally {
      clearTimeout(timer);
    }
    return {};
  }

  private onExit(s: CodexSession, error: string | null): void {
    this.d.gateway?.revokeSession(s.id);
    for (const q of s.pending.values()) q.resolve(this.cancelAnswer(q));
    s.pending.clear();
    if (this.sessions.get(s.id) === s) this.sessions.delete(s.id);
    const stopped = !!s.stopping;
    const errorText = stopped ? undefined : redactText(error ?? 'Процесс Codex завершился неожиданно');
    this.d.log.info('codex session exited', { sessionId: s.id, reason: stopped ? 'stopped' : 'crashed', ...(errorText ? { error: errorText } : {}) });
    void this.syncCredential(s.subscriptionId);
    this.d.send('session.exited', { sessionId: s.id, code: stopped ? 0 : null, reason: stopped ? 'stopped' : 'crashed', ...(errorText ? { errorText } : {}) });
    this.d.onSessionExited?.(s.id);
  }

  private sendState(s: CodexSession): void {
    this.d.send('session.state', { sessionId: s.id, state: s.state, processAlive: !s.stopping, permissionMode: s.mode });
  }
}
