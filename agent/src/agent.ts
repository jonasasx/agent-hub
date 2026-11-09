// Wires the hub connection, the live session manager and the replication of transcripts. Used by main.ts and by
// integration tests (with an in-process hub).
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { forkSession, query, type Options } from '@anthropic-ai/claude-agent-sdk';
import type { HubMessage } from '@agent-hub/shared';
import type { BackoffOptions } from './backoff.js';
import { HubClient } from './hubClient.js';
import type { Logger } from './log.js';
import { isAuthError } from './claudeStatus.js';
import { Caffeinator } from './macos.js';
import { AGENT_VERSION, buildHello, type MachineStatus } from './machine.js';
import { TurnTracker } from './turns.js';
import { Updater } from './updater.js';
import { CmdError, SessionManager, type ForkFn, type OneShotFn, type QueryFn } from './sessions/manager.js';
import { PeersClient } from './peers/client.js';
import { Replicator } from './transcripts/replicator.js';
import { httpBase, restoreFile } from './transcripts/restore.js';
import { readImageFile } from './sessions/images.js';
import { FsError, listFolder, readFileChunk, readFileForView } from './fs/browse.js';
import { ClaudeProvider } from './providers/claude.js';
import { ProviderRouter } from './providers/router.js';
import { findCodexBin, type CodexBin } from './providers/codex/bin.js';
import { CodexHomes } from './providers/codex/homes.js';
import { CodexProvider } from './providers/codex/provider.js';
import type { RpcTransport } from './providers/codex/rpc.js';
import { RegistryCache, type RegistrySnapshot } from './mcp/registryCache.js';
import { McpGateway } from './mcp/gateway.js';
import { McpDraftClient } from './mcp/draftClient.js';
import { McpImportPreviewer } from './mcp/importPreview.js';
import { McpOAuthManager } from './mcp/oauth.js';
import { McpRegistryQueue } from './mcp/registryQueue.js';
import { RegistryCacheWriter } from './mcp/registryCacheWriter.js';

const MAX_MESSAGES_BEFORE_WELCOME = 256;

export interface AgentOptions {
  hubUrl: string;
  token: string;
  vaultRoot: string | null;
  claudeProjectsDir: string;
  /** Test-only HOME override used by one-shot MCP import preview scans. */
  homeDir?: string;
  log: Logger;
  queryFn?: QueryFn;
  oneShotFn?: OneShotFn;
  forkFn?: ForkFn;
  backoff?: BackoffOptions;
  tailPollMs?: number;
  walkMs?: number;
  stopGraceMs?: number;
  extraOptions?: Partial<Options>;
  /** History replication limit (D4: 2 MB/s). */
  replMaxBytesPerSec?: number;
  /** History files in flight at once (REPL_HISTORY_INFLIGHT, default 8). */
  replHistoryInflight?: number;
  /** ~/.agent-hub: local replication state. */
  stateDir?: string;
  /** Tests may inject a delayed cache to verify registry command ordering. */
  registryCache?: RegistryCache;
  /** Use fs.watch (tests may turn it off). */
  watch?: boolean;
  /** 1.5: Claude login and macOS protected folders for hello (mutated on an authorization failure). */
  status?: MachineStatus;
  /** ~/.agent-hub/app when started by supervisor.mjs (AGENT_HUB_APP_DIR); null — self-update is refused. */
  appDir?: string | null;
  /** Ends the process after a staged update (main.ts: stop, exit; the supervisor starts the new version). */
  restart?: () => Promise<void>;
  /** Called on every welcome (main.ts tells the supervisor the agent is ready). */
  onWelcome?: () => void;
  /** Tests: a fake caffeinate / updater dependencies. */
  caffeinator?: Caffeinator;
  updaterDeps?: Partial<Pick<import('./updater.js').UpdaterOptions, 'fetchImpl' | 'npmInstall' | 'pollMs' | 'maxWaitMs'>>;
  /** agent-providers: the Codex CLI (null — none on this machine; undefined — looked up). Tests: fake app-servers. */
  codexBin?: CodexBin | null;
  codexTransport?: () => RpcTransport;
  codexServiceTransport?: () => RpcTransport;
}

export interface Agent {
  client: HubClient;
  sessions: SessionManager;
  /** agent-providers: the hub's session commands go through it to the provider of the session. */
  providers: ProviderRouter;
  codex: CodexProvider | null;
  replicator: Replicator;
  turns: TurnTracker;
  updater: Updater;
  start(): void;
  /** Stops sessions (aborting those that do not end within graceMs), then the connection. */
  stop(graceMs?: number): Promise<void>;
}

export function createAgent(o: AgentOptions): Agent {
  const { log } = o;
  const status: MachineStatus = o.status ?? {};
  const turns = new TurnTracker();
  const caffeinator = o.caffeinator ?? new Caffeinator({ log });
  turns.onChange(busy => caffeinator.setBusy(busy));
  // `client` is created below; the callbacks run only after it exists.
  const send = (type: string, payload: unknown): boolean => {
    turns.observe(type, payload);
    if ((type === 'session.result' || type === 'session.exited') && isAuthError((payload as { errorText?: string }).errorText)) {
      // Requirement «Нет входа в Claude»: the machine shows the banner with `agent-hub login`.
      if (status.claude?.login !== 'rejected') {
        status.claude = { login: 'rejected', version: status.claude?.version ?? null };
        log.warn('Claude rejected the login; run ~/.agent-hub/bin/agent-hub login');
      }
      const ok = client.send(type, payload);
      client.send('agent.status', { claude: status.claude });
      return ok;
    }
    return client.send(type, payload);
  };
  // agent-providers: messages of other providers — their authorization errors are not Claude's (no banner)
  const sendOther = (type: string, payload: unknown): boolean => {
    turns.observe(type, payload);
    return client.send(type, payload);
  };
  const replicator = new Replicator({
    projectsDir: o.claudeProjectsDir,
    send,
    sendBinary: data => client.sendBinary(data),
    log,
    maxBytesPerSec: o.replMaxBytesPerSec ?? 2 * 1024 * 1024,
    ...(o.replHistoryInflight ? { maxInflight: o.replHistoryInflight } : {}),
    cronMarkersFile: join(dirname(o.claudeProjectsDir), 'agent-hub', 'cron-sessions.txt'),
    ...(o.stateDir ? { stateDir: o.stateDir } : {}),
    ...(o.tailPollMs ? { pollMs: o.tailPollMs } : {}),
    ...(o.walkMs ? { walkMs: o.walkMs } : {}),
    ...(o.watch === false ? { watch: false } : {}),
  });
  // the protocol of the hub's last welcome: limits.event only to a hub of 1.6+ (subscription-limits L3)
  let hubProtocol: string | null = null;
  let runnerId: string | null = null;
  // AGENT_STATE_DIR keeps test agents off the machine's real ~/.agent-hub (codex-auth-restore)
  const stateDir = o.stateDir ?? process.env.AGENT_STATE_DIR ?? join(homedir(), '.agent-hub');
  const registryCache = o.registryCache ?? new RegistryCache(stateDir);
  const registryQueue = new McpRegistryQueue();
  const registryCacheWriter = new RegistryCacheWriter(registryCache, log);
  let registry: RegistrySnapshot | null = null;
  const gateway = new McpGateway(log, payload => (runnerId ? client.send('mcp.gateway.status', { ...(payload as Record<string, unknown>), machineId: runnerId }) : false));
  const mcpOAuth = new McpOAuthManager(
    () => registry,
    gateway,
    (type, payload) => client.send(type, payload),
    log,
  );
  if (registry) gateway.setRegistry(registry);
  // session-peers D2: requests of the agent-hub tools; the client exists below, the callback runs after it
  const peers = new PeersClient({ send: (payload, id) => client.send('peers.request', payload, { id }) });
  const mcpDraft = new McpDraftClient((type, payload) => client.send(type, payload));
  const mcpImporter = new McpImportPreviewer(o.homeDir ?? homedir());
  const sessions = new SessionManager({
    send,
    peers,
    registry: () => registry,
    gateway,
    mcpDraft,
    machineId: () => runnerId,
    hubProtocol: () => hubProtocol ?? (registry ? registry.protocol : null),
    log,
    queryFn: o.queryFn ?? (p => query(p)),
    oneShotFn: o.oneShotFn ?? (p => query(p)),
    projectsDir: o.claudeProjectsDir,
    forkFn: o.forkFn ?? ((id, opts) => forkSession(id, opts)),
    // Attachments (D19): /agent-api/blobs/<token> with the agent token.
    fetchAttachment: async a => {
      const res = await fetch(`${httpBase(o.hubUrl)}${a.url}`, { headers: { authorization: `Bearer ${o.token}` } });
      if (!res.ok) throw new Error(`hub answered ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
    onSessionStarted: (id, cwd) => void replicator.follow(id, cwd),
    onSessionExited: id => replicator.release(id),
    // Requirement: Занятость агента — background tasks of the session processes and the 120-min guard
    onSdkActivity: (id, at) => turns.touch(id, at),
    onBackgroundTasks: (id, tasks, at) => turns.setBackground(id, tasks, at),
    onBackgroundReset: id => turns.clear(id),
    ...(o.stopGraceMs ? { stopGraceMs: o.stopGraceMs } : {}),
    ...(o.extraOptions ? { extraOptions: o.extraOptions } : {}),
  });
  // agent-providers D1: Codex when its CLI is here (the package of the runtime manifest, or AGENT_CODEX_BIN)
  const codexBin = o.codexBin === undefined ? findCodexBin() : o.codexBin;
  const codex = codexBin
    ? new CodexProvider({
        bin: codexBin,
        send: sendOther,
        log,
        projectsDir: o.claudeProjectsDir,
        agentVersion: AGENT_VERSION,
        images: a => sessions.images(a),
        hubProtocol: () => hubProtocol ?? (registry ? registry.protocol : null),
        peers,
        registry: () => registry,
        gateway,
        mcpDraft,
        machineId: () => runnerId,
        homes: new CodexHomes({ stateDir, log }),
        onSessionStarted: (id, dir) => replicator.followIn(id, dir),
        onSessionExited: id => replicator.release(id),
        onActivity: (id, at) => turns.touch(id, at),
        onStatus: () => {
          if (hubProtocol) client.send('agent.status', { providers: providers.statuses() });
        },
        ...(o.stopGraceMs ? { stopGraceMs: o.stopGraceMs } : {}),
        ...(o.codexTransport ? { transport: o.codexTransport } : {}),
        ...(o.codexServiceTransport ? { serviceTransport: o.codexServiceTransport } : {}),
      })
    : null;
  const providers = new ProviderRouter(new ClaudeProvider(sessions), codex ? [codex] : []);
  const client: HubClient = new HubClient({
    url: o.hubUrl,
    token: o.token,
    log,
    // D4: the transcript list goes in repl.files after welcome, not in hello.
    hello: () => {
      const extra = providers.statuses();
      return { ...buildHello({ vaultRoot: o.vaultRoot, status }), liveSessions: providers.liveSessions(), files: [], ...(extra.length ? { providers: extra } : {}) };
    },
    ...(o.backoff ? { backoff: o.backoff } : {}),
  });

  const handle = (m: HubMessage): Promise<unknown> => {
    if (m.type === 'mcp.registry.sync') {
      return registryQueue.enqueue(async () => {
        registry = m.payload;
        gateway.setRegistry(m.payload);
        registryCacheWriter.enqueue(m.payload);
        return { revision: m.payload.revision, applied: true };
      });
    }
    if (m.type === 'mcp.secrets.deliver') {
      return registryQueue.enqueue(async () => {
        const accepted = gateway.setSecretDelivery(m.payload.serverId, m.payload.revision, m.payload.secrets);
        return { delivered: accepted, revision: m.payload.revision };
      });
    }
    if (m.type === 'mcp.gateway.start') {
      const sessionId = m.payload.sessionId ?? 'machine';
      let previousBearer: string | undefined;
      return registryQueue.enqueue(
        async () => {
          previousBearer = gateway.managedBearer(m.payload.serverId, sessionId);
          const endpoint = await gateway.startManaged(m.payload.serverId, sessionId, m.payload.bearerToken);
          return { serverId: m.payload.serverId, sessionId: m.payload.sessionId, endpoint };
        },
        () => gateway.stopTimedOutStart(m.payload.serverId, sessionId, m.payload.revision, m.payload.bearerToken, previousBearer),
      );
    }
    if (m.type === 'mcp.registry.validate') {
      return gateway.validate(m.payload).then(result => {
        const message = { draftId: m.payload.draftId, revision: m.payload.revision, ...result };
        if (!m.id || !client.send('mcp.registry.validate.result', message, { re: m.id })) throw new Error('hub disconnected before MCP validation result was delivered');
        return { resultSent: true };
      });
    }
    if (m.type === 'mcp.gateway.stop') {
      return registryQueue.enqueue(async () => {
        if (m.payload.sessionId) gateway.stopManaged(m.payload.serverId, m.payload.sessionId);
        else gateway.stopServer(m.payload.serverId);
        return { stopped: true };
      });
    }
    if (m.type === 'mcp.oauth.start') return mcpOAuth.begin(m.payload);
    if (m.type === 'mcp.oauth.callback') return mcpOAuth.callback(m.payload);
    if (m.type === 'mcp.oauth.credentials') {
      return registryQueue.enqueue(async () => {
        mcpOAuth.receiveCredentials(m.payload);
        return { received: true };
      });
    }
    if (m.type === 'mcp.oauth.revoke') return Promise.resolve(mcpOAuth.revoke(m.payload.serverId, m.payload.machineId));
    if (m.type === 'mcp.import.preview') {
      return mcpImporter.preview(m.payload).then(preview => {
        // The payload contains plaintext secrets solely for hub-side encryption. Do not log or include it in cmd.ok.
        if (!client.send('mcp.import.preview.result', preview)) throw new Error('hub disconnected before import preview was delivered');
        return { importId: preview.importId, secretsCaptured: preview.secretsCaptured, warnings: preview.warnings };
      });
    }
    if (m.type === 'file.restore') {
      return restoreFile(m.payload, { hubUrl: o.hubUrl, token: o.token, projectsDir: o.claudeProjectsDir, projectDirFor: cwd => replicator.projectDirFor(cwd) });
    }
    return providers.handle(m);
  };

  const updater = new Updater({
    appDir: o.appDir ?? null,
    hubHttp: httpBase(o.hubUrl),
    currentVersion: AGENT_VERSION,
    send,
    isBusy: () => turns.busy,
    restart: o.restart ?? (async () => log.warn('update staged but no restart handler')),
    log,
    ...o.updaterDeps,
  });

  let hubWelcomed = false;
  const messagesBeforeWelcome: HubMessage[] = [];
  const dispatchHubMessage = (m: HubMessage): void => {
    if (m.type === 'repl.ack') return replicator.onAck(m.payload);
    if (m.type === 'side.ack') return replicator.onSideAck(m.payload);
    if (m.type === 'side.reject') return replicator.onSideReject(m.payload);
    if (m.type === 'peers.reply') return peers.onReply(m.re, m.payload);
    if (m.type === 'mcp.draft.result') return mcpDraft.onResult(m.payload);
    if (m.type === 'agent.update') {
      void updater.handle(m.payload).catch((err: unknown) => log.error('agent update crashed', { error: (err as Error).message }));
      return;
    }
    const id = m.id;
    if (m.type === 'fs.list' || m.type === 'fs.read' || m.type === 'fs.read_chunk') {
      // Read-only file explorer (tool-windows-file-explorer). A failure carries a protocol code and no path.
      const failed = (err: unknown): void => {
        const code = err instanceof FsError ? err.code : 'io_error';
        if (id) client.send('cmd.error', { code, message: code }, { re: id });
      };
      if (m.type === 'fs.list') {
        listFolder(m.payload.path, m.payload.root, m.payload.showHidden === true).then(result => {
          if (id) client.send('cmd.ok', { result }, { re: id });
        }, failed);
        return;
      }
      if (m.type === 'fs.read_chunk') {
        // a piece of a file for download (file-download D1): bytes follow cmd.ok {binary: true} as a binary frame
        readFileChunk(m.payload.path, m.payload.root, m.payload.offset, m.payload.length).then(answer => {
          if (!id) return;
          client.send('cmd.ok', { result: answer.result }, { re: id });
          if (answer.data) client.sendBinary(answer.data);
        }, failed);
        return;
      }
      readFileForView(m.payload.path, m.payload.root).then(answer => {
        if (!id) return;
        client.send('cmd.ok', { result: answer.result }, { re: id });
        // image / pdf bytes follow cmd.ok {binary: true} as a binary frame, like fs.read_image
        if (answer.data) client.sendBinary(answer.data);
      }, failed);
      return;
    }
    if (m.type === 'fs.read_image') {
      // Bytes go in a binary frame right after cmd.ok {binary: true} (D19), not as base64 in JSON.
      readImageFile(m.payload.path).then(
        img => {
          if (!id) return;
          client.send('cmd.ok', { result: { sha256: img.sha256, mime: img.mime, size: img.size, mtimeMs: img.mtimeMs, binary: true } }, { re: id });
          client.sendBinary(img.data);
        },
        (err: unknown) => {
          const code = err instanceof CmdError ? err.code : 'error';
          if (id) client.send('cmd.error', { code, message: err instanceof Error ? err.message : String(err) }, { re: id });
        },
      );
      return;
    }
    handle(m).then(
      result => {
        if (id) client.send('cmd.ok', result === undefined ? {} : { result }, { re: id });
      },
      (err: unknown) => {
        const code = err instanceof CmdError ? err.code : 'error';
        const message = err instanceof Error ? err.message : String(err);
        if (!(err instanceof CmdError)) log.error('command failed', { type: m.type, error: message });
        const failure = err instanceof CmdError ? err.failure : undefined;
        if (id) client.send('cmd.error', { code, message, ...(failure ? { failure } : {}) }, { re: id });
      },
    );
  };
  client.on('welcome', w => {
    hubProtocol = w.protocol;
    runnerId = w.runnerId;
    hubWelcomed = true;
    try {
      mcpOAuth.setMachine(w.runnerId);
      replicator.onWelcome(w.cursors, w.protocol);
      updater.reportPending();
      providers.onWelcome();
      // agent-providers D10: the sign-in of the machine's other providers, then every 10 minutes
      if (codex) void codex.service.refresh().catch(() => undefined);
      o.onWelcome?.();
    } finally {
      for (const message of messagesBeforeWelcome.splice(0)) {
        try {
          dispatchHubMessage(message);
        } catch (error) {
          const id = message.id;
          if (id) {
            client.send('cmd.error', { code: 'error', message: 'command failed after hub welcome' }, { re: id });
          }
          log.warn('buffered hub message failed after welcome', {
            type: message.type,
            errorClass: error instanceof Error ? error.name : 'unknown',
          });
        }
      }
    }
  });
  client.on('disconnected', () => {
    hubProtocol = null;
    hubWelcomed = false;
    const droppedMessages = messagesBeforeWelcome.splice(0);
    // The hub expires outstanding command IDs on its own timeout.
    if (droppedMessages.length) log.warn('dropping buffered hub messages after disconnect', { count: droppedMessages.length });
    peers.failAll('connection to the hub lost');
    mcpDraft.failAll();
    replicator.onDisconnected();
  });
  client.on('message', (m: HubMessage) => {
    if (!hubWelcomed) {
      if (messagesBeforeWelcome.length >= MAX_MESSAGES_BEFORE_WELCOME) {
        log.warn('dropping hub message while waiting for welcome', { type: m.type, limit: MAX_MESSAGES_BEFORE_WELCOME });
        return;
      }
      messagesBeforeWelcome.push(m);
      return;
    }
    dispatchHubMessage(m);
  });

  const codexTimer = codex ? setInterval(() => void codex.service.refresh().catch(() => undefined), 10 * 60_000) : null;
  codexTimer?.unref?.();

  return {
    client,
    sessions,
    providers,
    codex,
    replicator,
    turns,
    updater,
    async start() {
      registry = await registryCache.read();
      if (registry) gateway.setRegistry(registry);
      await gateway.start();
      void replicator.start().catch((err: unknown) => log.error('replication failed to start', { error: (err as Error).message }));
      client.start();
    },
    async stop(graceMs?: number) {
      if (codexTimer) clearInterval(codexTimer);
      await providers.stopAll(graceMs);
      mcpOAuth.clear();
      await gateway.stop();
      // One more pass for the final lines before the socket closes.
      await replicator.tick();
      replicator.stop();
      await client.stop();
      if (!(await registryCacheWriter.flush(5000))) {
        log.warn('MCP registry cache writes remained pending during shutdown');
      }
      turns.dispose();
      caffeinator.setBusy(false);
    },
  };
}
