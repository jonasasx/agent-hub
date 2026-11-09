// Hub <-> agent protocol, version 1.x (design.md D3).
// Requirement: Версионированный протокол
import { z } from 'zod';
import {
  MCP_IMPORT_V2_CAPABILITY,
  MCP_REGISTRY_CAPABILITIES,
  mcpGatewayStartPayload,
  mcpGatewayStatusPayload,
  mcpGatewayStopPayload,
  mcpDraftRequestPayload,
  mcpDraftResultPayload,
  mcpImportPreviewPayload,
  mcpImportPreviewResultPayload,
  mcpOAuthCallbackPayload,
  mcpOAuthCredentialPayload,
  mcpOAuthRevokePayload,
  mcpOAuthStartPayload,
  mcpOAuthStatusUpdatePayload,
  mcpOAuthTokenUpdatePayload,
  mcpRegistryAckPayload,
  mcpRegistrySyncPayload,
  mcpRegistryValidatePayload,
  mcpRegistryValidateResultPayload,
  mcpRegistrySessionUpdatePayload,
  mcpSecretDeliveryPayload,
  mcpRegistrySessionUpdateAckPayload,
} from './mcpRegistry.js';
import { fsListPayload, fsReadChunkPayload, fsReadPayload } from './files.js';

/**
 * 1.1 (M3a): repl.files, side files. 1.2 (M3b): attachments, attachments.fetch, fs.read_image, fs.stat size/mtime.
 * 1.3: repl.agent_meta. 1.4 (claude-subscriptions P3): `subscription` in session.start/resume and handoff.generate,
 * `usage`/`failure` in session.result, `failure` in cmd.error of handoff.generate. 1.5 (change `multi-user`, design M4):
 * hello.claude/protectedDirs/arch, agent.status, agent.update, agent.update.result. 1.6 (change `subscription-limits`,
 * design L3): command limits.probe (a probe turn under a subscription token), message limits.event (rate_limit_event of
 * a session turn under a subscription, or `quiet` — a successful turn without one). 1.7 (change `mcp-management`, design
 * M2): messages mcp.status, mcp.auth.done; commands mcp.status.get, mcp.action, mcp.auth.start, mcp.auth.callback,
 * mcp.machine.probe. 1.8 (change `mcp-auth-controls`, design A4): `oauth` in a server of an MCP snapshot, command
 * mcp.auth.logout. 1.9 (change `session-peers`, design D2): command peers.request (agent→hub: list/get/send of the
 * agent-hub MCP tools of a session), message peers.reply (hub→agent). 1.10 (change `agent-providers`, design D2):
 * `provider` in session.start/resume/fork, `providers` in hello/agent.status, commands provider.login.start,
 * provider.login.cancel, provider.logout, message provider.login.done. 1.11 (change `provider-parity`, design D1): `provider`
 * in a subscription cred (Codex: the auth.json of a CODEX_HOME), `forSubscription` in provider.login.start, `credential` in
 * provider.login.done, message provider.credential.update (a refreshed Codex auth.json). 1.12 (change `hub-subagents`,
 * design D2): op `spawn` in peers.request (a child hub session), `resultText` in session.result (the final answer).
 * 1.13 (change `mcp-registry`): the MCP registry, gateway, secret delivery, OAuth, import preview, draft API and capabilities;
 * negotiated fs.list-dirs (projects-catalog D).
 * 1.14 (change `tool-windows-file-explorer`, design D1): negotiated fs.browse, commands fs.list and fs.read (read-only file explorer).
 * 1.15 (change `catalog-db-session-context`, design D2): the user's project catalogue `projectCatalog` in session.start/resume.
 * 1.16 (change `file-download`, design D1): negotiated fs.download, command fs.read_chunk (a file read in pieces for download).
 * 1.17 (change `mcp-hub-only`, design D8): negotiated mcp.import.v2 — import from Codex, Claude plugins and all projects
 * (`projectRoots` in mcp.import.preview), `projectIds` honoured by the agent, static `oauthClientId`.
 * Minor versions talk to each other (D3); images need 1.2 on the agent, subscriptions 1.4, self-update 1.5, limits 1.6,
 * MCP management 1.7, MCP sign-out 1.8, session peers 1.9, providers other than Claude 1.10, negotiated fs.list-dirs 1.13, fs.browse 1.14,
 * the project catalogue in the session context 1.15, file download 1.16.
 */
export const PROTOCOL_VERSION = '1.17';
/** The first protocol version whose agents declare `mcp.import.v2` and filter servers by `projectIds` (mcp-hub-only D8). */
export const MCP_IMPORT_V2_PROTOCOL = '1.17';
/** The first protocol version whose agents answer fs.list / fs.read and declare the capability `fs.browse` (tool-windows-file-explorer D1). */
export const FILES_PROTOCOL = '1.14';
/** The first protocol version whose agents take `projectCatalog` in session.start/resume (catalog-db-session-context D2). */
export const PROJECT_CATALOG_PROTOCOL = '1.15';
/** The first protocol version whose agents answer fs.read_chunk and declare the capability `fs.download` (file-download D7). */
export const DOWNLOAD_PROTOCOL = '1.16';
/** First protocol version with the centralized MCP registry and gateway contracts. */
export const MCP_REGISTRY_PROTOCOL = '1.13';
/** The agent takes provider.credentials.sync and removes the Codex homes of retired subscriptions (provider-parity R3). */
export const CODEX_HOMES_SYNC_CAPABILITY = 'codex.homes.sync' as const;
export const AGENT_CAPABILITIES = [...MCP_REGISTRY_CAPABILITIES, 'fs.list-dirs', 'fs.browse', 'fs.download', MCP_IMPORT_V2_CAPABILITY, CODEX_HOMES_SYNC_CAPABILITY] as const;
export const HUB_CAPABILITIES = [...MCP_REGISTRY_CAPABILITIES, 'fs.list-dirs', 'fs.browse', 'fs.download', CODEX_HOMES_SYNC_CAPABILITY] as const;
/** The first protocol version whose agents give sessions `session_spawn` and send `resultText` (hub-subagents D2). */
export const SPAWN_PROTOCOL = '1.12';
/** The first protocol version whose agents take Codex subscriptions (provider-parity D1): `provider` in a subscription cred, provider.credential.update. */
export const CODEX_SUBSCRIPTIONS_PROTOCOL = '1.11';
/** The first protocol version whose agents run sessions of other providers (agent-providers D2). */
export const PROVIDERS_PROTOCOL = '1.10';
/** The first protocol version whose agents give their sessions the agent-hub tools and send peers.request (session-peers D2). */
export const PEERS_PROTOCOL = '1.9';
/** The first protocol version whose agents send `oauth` in MCP snapshots and take mcp.auth.logout (mcp-auth-controls A4). */
export const MCP_AUTH_CONTROLS_PROTOCOL = '1.8';
/** The first protocol version whose agents send MCP snapshots and take MCP commands (mcp-management M2). */
export const MCP_PROTOCOL = '1.7';
/** The first protocol version whose agents run limits.probe and send limits.event (subscription-limits L3). */
export const LIMITS_PROTOCOL = '1.6';
/** The first protocol version whose agents take agent.update (change `multi-user`, design M4). */
export const AGENT_UPDATE_PROTOCOL = '1.5';
/** The first protocol version whose agents take images (D19). */
export const IMAGES_PROTOCOL = '1.2';
/** The first protocol version whose agents run a process under a subscription token (claude-subscriptions P3). */
export const SUBSCRIPTIONS_PROTOCOL = '1.4';
export const PROTOCOL_MAJOR = 1;

// How a transcript is cut into lines (D4), the same for the agent (tailer.ts) and the hub Drive import
// (import/drive.ts streamLines): every segment ending with \n is a line - an empty one too -, \r before \n is dropped,
// an unfinished tail is not a line yet.

/**
 * A line of this many bytes or more (\r counted, \n not) is not sent: a marker line {type: SKIPPED_LINE_TYPE, bytes}
 * takes its place, so line numbers and byte offsets stay those of the file. The largest line seen is 1.4 MB.
 */
export const LINE_HARD_LIMIT = 48 * 1024 * 1024;
/** type of the marker line in place of a line of LINE_HARD_LIMIT bytes or more; the hub counts it, does not store it. */
export const SKIPPED_LINE_TYPE = 'agent-hub-skipped-line';

/** WebSocket close codes used by the hub on /ws/agent. */
export const CloseCode = {
  /** Unknown or revoked agent token. */
  InvalidToken: 4401,
  /** Replaced by a newer connection of the same runner. */
  Replaced: 4409,
  /** Incompatible major protocol version. */
  IncompatibleVersion: 4426,
} as const;
export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode];

/** Transport limits and heartbeat (D3). */
export const WS_MAX_PAYLOAD = 64 * 1024 * 1024;
export const HEARTBEAT_INTERVAL_MS = 20_000;
export const HEARTBEAT_TIMEOUT_MS = 60_000;

/** Parses "1.0" → 1; returns null for anything that is not "<major>.<minor>". */
export function protocolMajor(version: unknown): number | null {
  if (typeof version !== 'string') return null;
  const m = /^(\d+)\.(\d+)$/.exec(version);
  return m ? Number(m[1]) : null;
}

/** "1.4" ≥ "1.3": same major and minor at least `min`'s; false for anything unparsable. */
export function protocolAtLeast(version: unknown, min: string): boolean {
  if (typeof version !== 'string') return false;
  const a = /^(\d+)\.(\d+)$/.exec(version);
  const b = /^(\d+)\.(\d+)$/.exec(min);
  if (!a || !b) return false;
  return Number(a[1]) === Number(b[1]) && Number(a[2]) >= Number(b[2]);
}

export function isCompatibleProtocol(version: unknown): boolean {
  return protocolMajor(version) === PROTOCOL_MAJOR;
}

// ---------- shared field schemas ----------

const sessionId = z.guid();
const nonEmpty = z.string().min(1);
const nonNegInt = z.number().int().nonnegative();

export const permissionModeSchema = z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto']);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

export const liveSessionStateSchema = z.enum(['working', 'waiting', 'permission']);
export type LiveSessionState = z.infer<typeof liveSessionStateSchema>;

// ---------- agent -> hub payloads ----------

/**
 * 1.5: `ok` — `claude` is logged in (or CLAUDE_CODE_OAUTH_TOKEN is set); `missing` — no login; `rejected` — a turn or the
 * check failed with an authorization error. `version` — `claude --version`, null when not found.
 */
export const claudeLoginSchema = z.enum(['ok', 'missing', 'rejected']);
export type ClaudeLogin = z.infer<typeof claudeLoginSchema>;
export const claudeStatusSchema = z.object({ login: claudeLoginSchema, version: z.string().max(100).nullable() });
export type ClaudeStatus = z.infer<typeof claudeStatusSchema>;
export const protectedDirsSchema = z.enum(['ok', 'denied', 'n/a']);
export type ProtectedDirs = z.infer<typeof protectedDirsSchema>;

/** agent-providers D1: the vendor of a session. Absent in a command — `claude` (hubs and agents before 1.10). */
export const PROVIDERS = ['claude', 'codex'] as const;
export const providerSchema = z.enum(PROVIDERS);
export type Provider = z.infer<typeof providerSchema>;
/** Providers other than Claude an agent reports (Claude has hello.claude). */
export const extraProviderSchema = z.enum(['codex']);
export type ExtraProvider = z.infer<typeof extraProviderSchema>;
export const providerLoginSchema = z.enum(['ok', 'missing', 'rejected', 'unknown']);
export type ProviderLogin = z.infer<typeof providerLoginSchema>;
/** 1.10 (agent-providers D2): a provider of the machine — CLI version, sign-in and its account. Never a token. */
export const providerStatusSchema = z.object({
  id: extraProviderSchema,
  version: z.string().max(100).nullable(),
  login: providerLoginSchema,
  account: z.object({ email: z.string().max(320).nullable(), plan: z.string().max(100).nullable() }).optional(),
  /** The models of the provider for the new-session form (signed in only). */
  models: z
    .array(z.object({ value: z.string().min(1).max(200), displayName: z.string().max(200) }))
    .max(50)
    .optional(),
});
export type ProviderStatus = z.infer<typeof providerStatusSchema>;
export const providersStatusSchema = z.array(providerStatusSchema).max(10);

/**
 * 1.5 agent.status: the agent re-checked the Claude login (after an authorization failure in a turn, after
 * `agent-hub login`) or the protected directories; only the fields that are known are sent.
 */
export const agentStatusPayload = z.object({
  claude: claudeStatusSchema.optional(),
  /** 1.10: the full list of the machine's other providers when one of them changed. */
  providers: providersStatusSchema.optional(),
  protectedDirs: protectedDirsSchema.optional(),
});

/**
 * 1.5 agent.update.result: progress of an `agent.update`. `waiting` — turns are running, the update waits (≤ 2 h);
 * `installing` — downloaded and checked, restarting; `failed` — the previous version keeps running, `error` says why
 * (`sha_mismatch`, `download_failed`, `start_failed`, `busy_timeout`, …). Success is the next hello with `version`.
 */
export const agentUpdateResultPayload = z.object({
  version: nonEmpty,
  status: z.enum(['waiting', 'installing', 'failed']),
  error: z.string().max(500).optional(),
});

export const helloPayload = z.object({
  protocol: z.string().regex(/^\d+\.\d+$/),
  agentVersion: nonEmpty,
  sdkVersion: nonEmpty,
  claudeCodeVersion: z.string().nullable(),
  hostname: nonEmpty,
  os: nonEmpty,
  homeDir: nonEmpty,
  vaultRoot: z.string().nullable(),
  liveSessions: z.array(z.object({ sessionId, state: liveSessionStateSchema })),
  files: z.array(z.object({ relPath: nonEmpty, size: nonNegInt, mtimeMs: z.number().nonnegative() })),
  /** The machine's clock when hello is sent (ms): the hub's offset to it for «идёт вне хаба» (D9 p. 10b). Since M4a. */
  clockMs: z.number().nonnegative().optional(),
  /** 1.5 (multi-user M4): the subscription login of `claude` on the machine. Absent — an older agent, unknown. */
  claude: claudeStatusSchema.optional(),
  /** 1.5: can the agent read ~/Documents, ~/Desktop, ~/Downloads (macOS TCC); `n/a` on Linux and Windows. */
  protectedDirs: protectedDirsSchema.optional(),
  /** 1.5: `process.arch` of the agent (x64, arm64). */
  arch: z.string().min(1).max(32).optional(),
  /**
   * 1.5, additive (runner-enrollment «Запуск под root»): uid 0 outside a sandbox (IS_SANDBOX=1, CLAUDE_CODE_BUBBLEWRAP),
   * not Windows — Claude Code refuses bypassPermissions there. Absent — an older agent, unknown.
   */
  root: z.boolean().optional(),
  /** 1.10 (agent-providers D2): providers other than Claude installed on the machine. Absent — none or an older agent. */
  providers: providersStatusSchema.optional(),
  /** Registry and gateway features supported by this agent. */
  capabilities: z.array(z.string().min(1).max(100)).max(100).optional(),
});

export const sessionStatePayload = z.object({
  sessionId,
  state: liveSessionStateSchema,
  processAlive: z.boolean(),
  /**
   * M4b: the mode of the live process as the SDK reports it (system init/status). It changes without a hub command when
   * a plan is approved (ExitPlanMode: plan → default); the hub stores it so the badge and a later resume follow.
   */
  permissionMode: permissionModeSchema.optional(),
});

export const sessionPartialPayload = z.object({
  sessionId,
  messageId: nonEmpty,
  blockIndex: nonNegInt,
  textDelta: z.string(),
});

// Requirement: Учёт ходов и расход по подпискам — tokens of one turn (SDK result.usage: the main loop only, no subagents).
export const turnUsageSchema = z.object({
  inputTokens: nonNegInt,
  outputTokens: nonNegInt,
  cacheReadTokens: nonNegInt,
  cacheCreationTokens: nonNegInt,
});
export type TurnUsage = z.infer<typeof turnUsageSchema>;

export const TURN_FAILURE_KINDS = ['subscription_limit', 'auth_rejected', 'account_unavailable'] as const;
export const turnFailureKindSchema = z.enum(TURN_FAILURE_KINDS);
export type TurnFailureKind = z.infer<typeof turnFailureKindSchema>;

// Requirement: Исчерпан лимит подписки — why a turn failed, as classified by the agent (design P5).
export const turnFailureSchema = z.object({
  kind: turnFailureKindSchema,
  /** ms since epoch, when the limit resets (rate_limit_event.resetsAt; seconds are converted). */
  resetsAt: z.number().nonnegative().optional(),
  /** rate_limit_info.rateLimitType as reported: five_hour, seven_day, … (free string: new SDK values must not break parsing). */
  limitType: z.string().max(64).optional(),
  message: z.string().max(2000).optional(),
});
export type TurnFailure = z.infer<typeof turnFailureSchema>;

// Requirement: Снимок лимитов подписки (subscription-limits L3). Percent 0–100 (the agent multiplied the service's
// fractions by 100), times ISO 8601. Tolerant: an unknown status becomes `unknown`, unknown fields are dropped.
export const LIMIT_STATUSES = ['allowed', 'allowed_warning', 'rejected', 'unknown'] as const;
export type LimitStatus = (typeof LIMIT_STATUSES)[number];
export const limitStatusSchema = z.preprocess(v => (typeof v === 'string' && (LIMIT_STATUSES as readonly string[]).includes(v) ? v : 'unknown'), z.enum(LIMIT_STATUSES));
const isoTime = z.iso.datetime({ offset: true });
const percent = z.number().min(0).max(100);

export const limitWindowSchema = z.object({
  /** The key of unifiedWindows as the service sent it: five_hour, seven_day, seven_day_opus, … */
  type: z.string().min(1).max(64),
  utilization: percent.nullable(),
  resetsAt: isoTime.nullable(),
  status: limitStatusSchema.nullable(),
  surpassedThreshold: percent.nullable().optional(),
});
export type LimitWindow = z.infer<typeof limitWindowSchema>;

/** Overage of the account: the state only, never amounts. */
export const limitOverageSchema = z.object({
  status: limitStatusSchema,
  inUse: z.boolean().nullable(),
  enabled: z.boolean().nullable(),
  disabledReason: z.string().max(64).nullable(),
});
export type LimitOverage = z.infer<typeof limitOverageSchema>;

export const limitsSnapshotSchema = z.object({
  windows: z.array(limitWindowSchema).max(16),
  overage: limitOverageSchema.nullable(),
});
export type LimitsSnapshot = z.infer<typeof limitsSnapshotSchema>;

export const LIMITS_PROBE_OUTCOMES = ['ok', 'no_event', 'limit', 'auth_rejected', 'account_unavailable'] as const;
export type LimitsProbeOutcome = (typeof LIMITS_PROBE_OUTCOMES)[number];
/** cmd.ok result of limits.probe. The model's answer is never returned; `message` is the failure text without the token. */
export const limitsProbeResultSchema = z.object({
  outcome: z.enum(LIMITS_PROBE_OUTCOMES),
  snapshot: limitsSnapshotSchema.nullable(),
  /** `limit`: when it resets, if the service told. */
  resetsAt: isoTime.nullable(),
  limitType: z.string().max(64).nullable(),
  message: z.string().max(500).nullable(),
  durationMs: nonNegInt,
});
export type LimitsProbeResult = z.infer<typeof limitsProbeResultSchema>;
/** cmd.error codes of limits.probe. */
export const LIMITS_PROBE_ERRORS = ['probe_failed', 'probe_timeout', 'probe_busy'] as const;

/**
 * 1.6 limits.event: a rate_limit_event of a session turn under a subscription (`snapshot`), or a successful turn without
 * one (`snapshot: null, quiet: true` — below the service's warning thresholds). Sent to hubs of 1.6+ only.
 */
export const limitsEventPayload = z.object({
  sessionId,
  snapshot: limitsSnapshotSchema.nullable(),
  quiet: z.boolean(),
  /** ms since epoch, when the agent saw the event (or the result of the quiet turn). */
  observedAt: z.number().nonnegative(),
});

// Requirement: Статус MCP сессии, Секреты в снимке MCP (mcp-management M2). The agent has already replaced the secrets
// (M5); the schema is tolerant: an unknown status becomes `unknown`, an unknown transport `other`, unknown fields drop.
export const MCP_SERVER_STATUSES = ['connected', 'failed', 'needs-auth', 'pending', 'disabled', 'unknown'] as const;
export type McpServerStatus = (typeof MCP_SERVER_STATUSES)[number];
export const MCP_TRANSPORTS = ['stdio', 'http', 'sse', 'sdk', 'claudeai-proxy', 'other'] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];
/** At most this many servers in a snapshot. */
export const MCP_SNAPSHOT_MAX_SERVERS = 100;

export const mcpServerSnapshotSchema = z.object({
  name: z.string().min(1).max(200),
  status: z.enum(MCP_SERVER_STATUSES).catch('unknown'),
  /** `failed`: the CLI's text with the secrets replaced (M5). */
  error: z.string().max(1000).optional(),
  transport: z.enum(MCP_TRANSPORTS).catch('other'),
  /** http/sse: origin + pathname; stdio: the command with secret-looking arguments as •••; absent for claudeai-proxy. */
  target: z.string().max(500).optional(),
  /** `source ?? scope` of the CLI as is: user, project, local, plugin, managed, dynamic, … */
  scope: z.string().max(32).optional(),
  serverInfo: z.object({ name: z.string().max(200), version: z.string().max(100) }).optional(),
  toolCount: nonNegInt,
  /**
   * 1.8 (mcp-auth-controls A1): an OAuth server — http/sse and an `oauth` block in its config, a saved sign-in on the
   * machine or `needs-auth`. Only yes/no: tokens, clientId and clientSecret never leave the machine.
   */
  oauth: z.boolean().optional(),
});
export type McpServerSnapshot = z.infer<typeof mcpServerSnapshotSchema>;

export const mcpSnapshotSchema = z.object({
  servers: z.array(mcpServerSnapshotSchema).max(MCP_SNAPSHOT_MAX_SERVERS),
  /** ms since epoch, when the agent read the status. */
  observedAt: z.number().nonnegative(),
  /**
   * Agent 0.2.5+: the key of `projects` in ~/.claude.json the CLI keeps `disabledMcpServers` under — the canonical git
   * root of the session directory (a worktree → its main checkout), else the directory; `/` separators on Windows.
   */
  projectRoot: z.string().min(1).max(1000).optional(),
});
export type McpSnapshot = z.infer<typeof mcpSnapshotSchema>;

/** 1.7 mcp.status: a snapshot of a live session's MCP servers; sent on change (and in reply to mcp.status.get). */
export const mcpStatusPayload = z.object({ sessionId, snapshot: mcpSnapshotSchema });
/** 1.7 mcp.auth.done: the end of a sign-in attempt after the callback (submit + reconnect), for the UI and the sleep lock. */
export const mcpAuthDonePayload = z.object({
  sessionId,
  server: z.string().min(1).max(200),
  ok: z.boolean(),
  error: z.string().max(1000).optional(),
});

/** cmd.error codes of the MCP commands (M2). */
export const MCP_ERROR_CODES = [
  'not_running',
  'mcp_unknown_server',
  'mcp_auth_unsupported',
  'mcp_auth_state_mismatch',
  'mcp_auth_failed',
  'mcp_action_failed',
  'mcp_probe_busy',
  'mcp_probe_timeout',
  'not_implemented',
] as const;
export type McpErrorCode = (typeof MCP_ERROR_CODES)[number];

export const MCP_ACTIONS = ['reconnect', 'enable', 'disable'] as const;
export const mcpActionSchema = z.enum(MCP_ACTIONS);
export type McpAction = z.infer<typeof mcpActionSchema>;

/** cmd.ok of mcp.status.get, mcp.action, mcp.auth.callback, mcp.auth.logout. */
export const mcpSnapshotResultSchema = z.object({ snapshot: mcpSnapshotSchema });
/** The provider's page a browser is sent to: https only (http for localhost / 127.0.0.1 — a local test provider). */
export function isSafeAuthUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

/** cmd.ok of mcp.auth.start: `hub` — the provider returns to the hub's redirectUri; `localhost` — the paste fallback. */
export const mcpAuthStartResultSchema = z.object({
  authUrl: z.string().min(1).max(8192).refine(isSafeAuthUrl, 'authUrl must be https (http only for localhost)'),
  redirect: z.enum(['hub', 'localhost']),
  state: z.string().min(1).max(512),
  callbackPort: z.number().int().min(1).max(65535).optional(),
});
export type McpAuthStartResult = z.infer<typeof mcpAuthStartResultSchema>;
/** cmd.ok of mcp.machine.probe. */
export const mcpProbeResultSchema = z.object({ snapshot: mcpSnapshotSchema, durationMs: nonNegInt });
export type McpProbeResult = z.infer<typeof mcpProbeResultSchema>;

// ---------- session peers (change `session-peers`, design D2) ----------

export const PEER_TEXT_MAX = 20_000;
export const PEER_LIST_MAX = 100;
export const PEER_SESSION_STATUSES = ['working', 'waiting', 'permission', 'sleeping', 'closed'] as const;
export const PEER_ERROR_CODES = ['not_found', 'invalid_target', 'runner_offline', 'rate_limited', 'invalid_request', 'send_failed', 'unsupported', 'spawn_failed'] as const;
/** Live children a session may hold (hub-subagents D4). */
export const SPAWN_LIVE_MAX = 10;
/** Final answer of a turn carried by session.result (hub-subagents D2). */
export const RESULT_TEXT_MAX = 100_000;
export type PeerErrorCode = (typeof PEER_ERROR_CODES)[number];
export const PEER_SEND_RESULTS = ['delivered', 'queued', 'resumed'] as const;
export type PeerSendResult = (typeof PEER_SEND_RESULTS)[number];

/** A session as another session sees it. */
export const peerSessionSchema = z.object({
  id: sessionId,
  title: z.string(),
  machine: z.string(),
  cwd: z.string(),
  status: z.enum(PEER_SESSION_STATUSES),
  processAlive: z.boolean(),
  lastActivityAt: z.string().nullable(),
  self: z.boolean(),
  /** Only in `get`: running subagents plus background tasks. */
  workingChildren: nonNegInt.optional(),
});
export type PeerSession = z.infer<typeof peerSessionSchema>;

const peerCaller = { sessionId };
export const peersRequestPayload = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('list'),
    ...peerCaller,
    machine: z.string().max(200).optional(),
    project: z.string().max(1000).optional(),
    status: z.enum(PEER_SESSION_STATUSES).optional(),
    limit: z.number().int().min(1).max(PEER_LIST_MAX).optional(),
  }),
  z.object({ op: z.literal('get'), ...peerCaller, target: sessionId }),
  z.object({ op: z.literal('send'), ...peerCaller, to: sessionId, text: z.string(), inReplyTo: z.guid().optional() }),
  z.object({
    op: z.literal('spawn'),
    ...peerCaller,
    task: z.string(),
    provider: z.enum(PROVIDERS).optional(),
    machine: z.string().max(200).optional(),
    /** session-folder D3: ignored — the hub picks the folder; agents before 0.7.1 may still send it. */
    cwd: z.string().max(1000).optional(),
    model: z.string().max(200).optional(),
    title: z.string().max(200).optional(),
  }),
]);
/** cmd result of a `spawn` (hub-subagents D1). */
export interface PeerSpawnResult {
  sessionId: string;
  title: string;
  machine: string;
  provider: (typeof PROVIDERS)[number];
  cwd: string;
  model: string;
}
export type PeersRequest = z.infer<typeof peersRequestPayload>;

export const peersReplyPayload = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), code: z.enum(PEER_ERROR_CODES), message: z.string(), retryAfterSec: nonNegInt.optional() }),
]);
export type PeersReply = z.infer<typeof peersReplyPayload>;

export const sessionResultPayload = z.object({
  sessionId,
  subtype: nonEmpty,
  isError: z.boolean(),
  durationMs: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
  errorText: z.string().optional(),
  /** 1.4: tokens of the turn; absent from agents of 1.3 (the hub records zeros). */
  usage: turnUsageSchema.optional(),
  /** 1.4: set when the turn failed for a reason tied to the subscription or account. */
  failure: turnFailureSchema.optional(),
  /** 1.12: the final answer of the turn (Claude — `result`, Codex — the last agent message). */
  resultText: z.string().max(RESULT_TEXT_MAX).optional(),
});

export const sessionExitedPayload = z.object({
  sessionId,
  code: z.number().int().nullable(),
  reason: z.enum(['stopped', 'crashed']),
  errorText: z.string().optional(),
});

export const permissionRequestPayload = z.object({
  requestId: z.guid(),
  sessionId,
  toolName: nonEmpty,
  toolUseId: nonEmpty,
  input: z.record(z.string(), z.unknown()),
  suggestions: z.array(z.unknown()),
  blockedPath: z.string().optional(),
  reason: z.string().optional(),
  /**
   * M4b: `question` — AskUserQuestion (the input has `questions`), `plan` — ExitPlanMode (the input has `plan`); absent
   * or `tool` — any other tool. The hub also derives it from toolName (older agents).
   */
  kind: z.enum(['tool', 'question', 'plan']).optional(),
});

export const replChunkPayload = z.object({
  relPath: nonEmpty,
  kind: z.enum(['main', 'subagent']),
  sessionId,
  agentId: z.string().optional(),
  generation: nonNegInt,
  fromLine: nonNegInt,
  fromByte: nonNegInt,
  lines: z.array(z.string()),
  endByte: nonNegInt,
  rewrite: z.boolean().optional(),
});

export const replMetaPayload = z.object({
  sessionId,
  cwd: nonEmpty,
  gitRemote: z.string().optional(),
  gitBranch: z.string().optional(),
  cronMarker: z.boolean().optional(),
});

/** The largest `meta` of repl.agent_meta (bytes of its JSON); a bigger meta.json is not sent. */
export const AGENT_META_LIMIT = 16 * 1024;

/**
 * 1.3 (change `subagents`, design S5): `subagents/agent-<agentId>.meta.json` of a session — sent when it appears or
 * changes, and again after a reconnect for files changed within 24 h. A type of its own, not `repl.meta`: a hub of 1.2
 * ignores an unknown type (and logs it) but would reject the payload of a known one.
 */
export const replAgentMetaPayload = z.object({
  sessionId,
  relPath: nonEmpty,
  /** `agentId` without the `agent-` prefix of the file name. */
  agentId: z.string().regex(/^[\w-]{1,128}$/),
  meta: z.record(z.string(), z.unknown()).refine(m => JSON.stringify(m).length <= AGENT_META_LIMIT, `meta.json over ${AGENT_META_LIMIT} bytes`),
});

export const sideFilePayload = z.object({
  sessionId,
  relPath: nonEmpty,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: nonNegInt,
});

export const cmdOkPayload = z.object({ result: z.unknown().optional() });
export const cmdErrorPayload = z.object({
  code: nonEmpty,
  message: z.string(),
  /** 1.4 (claude-subscriptions QA B1): why handoff.generate failed, when the reason is the subscription or account. */
  failure: turnFailureSchema.optional(),
});

// ---------- hub -> agent payloads ----------

const cursor = z.object({ relPath: nonEmpty, generation: nonNegInt, ackedLine: nonNegInt, ackedByte: nonNegInt });

export const welcomePayload = z.object({
  runnerId: nonEmpty,
  protocol: z.string().regex(/^\d+\.\d+$/),
  cursors: z.array(cursor),
  capabilities: z.array(z.string().min(1).max(100)).optional(),
});

export const replAckPayload = cursor;

/** Image attached by the user (1.1, D19): fetched by the agent from `url` (/agent-api/blobs/<token>). */
export const attachmentSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  mime: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
  size: nonNegInt,
  url: z.string().regex(/^\/agent-api\/blobs\/[A-Za-z0-9_-]+$/),
});
export type Attachment = z.infer<typeof attachmentSchema>;
const attachments = z.array(attachmentSchema).max(10).optional();

// Requirement: Запуск процесса под подпиской — the token the agent puts into the process env (design P3/P4).
/** `claude setup-token` as pasted: 20–4096 chars, no whitespace (spec «Хранение токена подписки»). Never logged. */
export const subscriptionTokenSchema = z.string().min(20).max(4096).regex(/^\S+$/, 'no whitespace');
/** 1.11: the auth.json of a Codex sign-in as one JSON string (provider-parity D1). Never logged. */
export const codexCredentialSchema = z
  .string()
  .min(2)
  .max(65536)
  .refine(v => {
    try {
      const o: unknown = JSON.parse(v);
      return typeof o === 'object' && o !== null && !Array.isArray(o);
    } catch {
      return false;
    }
  }, 'not a JSON object');
export const subscriptionCredSchema = z
  .object({
    id: z.guid(),
    /** 1.11: absent — claude. */
    provider: z.enum(PROVIDERS).optional(),
    /** claude: the setup-token; codex: the auth.json (codexCredentialSchema). */
    token: z.string().min(2).max(65536),
  })
  .superRefine((c, ctx) => {
    const r = (c.provider ?? 'claude') === 'codex' ? codexCredentialSchema.safeParse(c.token) : subscriptionTokenSchema.safeParse(c.token);
    if (!r.success) ctx.addIssue({ code: 'custom', path: ['token'], message: r.error.issues[0]?.message ?? 'invalid token' });
  });
export type SubscriptionCred = z.infer<typeof subscriptionCredSchema>;
/** 1.4: absent — the process runs under the machine login, as before. The hub sends it to agents of 1.4+ only. */
const subscription = subscriptionCredSchema.optional();

/**
 * attachments.fetch (1.2, D19): the agent downloads and checks every image and keeps it in its cache by sha256
 * (TTL 15 min); start/resume/send that follow take the bytes from the cache. Result `{cached: n}`.
 */
export const attachmentsFetchPayload = z.object({ attachments: z.array(attachmentSchema).min(1).max(10) });

/** At most this many projects of the catalogue go to a session (catalog-db-session-context D2). */
export const PROJECT_CATALOG_MAX = 200;
/** A project of the user's catalogue for the session's instructions; `path` — its binding folder on the session's machine. */
export const projectCatalogEntry = z.object({
  id: z.guid(),
  name: z.string(),
  description: z.string().nullable(),
  remote: z.string().nullable(),
  path: z.string().nullable(),
  current: z.boolean(),
});
export type ProjectCatalogEntry = z.infer<typeof projectCatalogEntry>;
export const projectCatalog = z.array(projectCatalogEntry).max(PROJECT_CATALOG_MAX);

export const sessionStartPayload = z.object({
  sessionId,
  cwd: nonEmpty,
  /** 1.13: the catalog project resolved by the hub; absent means no project override applies. */
  projectId: z.guid().optional(),
  /** 1.15: the user's project catalogue; the agent always adds it to the session's instructions (empty — nothing). */
  projectCatalog: projectCatalog.optional(),
  permissionMode: permissionModeSchema,
  model: nonEmpty,
  prompt: z.string(),
  promptUuid: z.guid(),
  attachments,
  subscription,
  /** 1.10: absent — claude. */
  provider: providerSchema.optional(),
});

export const sessionResumePayload = z.object({
  sessionId,
  cwd: nonEmpty,
  /** 1.13: the catalog project resolved by the hub; absent means no project override applies. */
  projectId: z.guid().optional(),
  /** 1.15: the user's project catalogue; the agent always adds it to the session's instructions (empty — nothing). */
  projectCatalog: projectCatalog.optional(),
  permissionMode: permissionModeSchema,
  /** Absent: the user's default model on that machine (sessions started outside the hub). Optional since M2 (agents of M1 do not handle resume). */
  model: nonEmpty.optional(),
  prompt: z.string().optional(),
  promptUuid: z.guid().optional(),
  attachments,
  subscription,
  /** 1.10: absent — claude. */
  provider: providerSchema.optional(),
});

export const sessionSendPayload = z.object({ sessionId, text: z.string(), promptUuid: z.guid(), attachments });
export const sessionInterruptPayload = z.object({ sessionId });
export const sessionSetModePayload = z.object({ sessionId, mode: permissionModeSchema });
export const sessionSetModelPayload = z.object({ sessionId, model: nonEmpty });
export const sessionStopPayload = z.object({ sessionId, reason: z.enum(['sleep', 'user']) });

export const permissionResponsePayload = z.object({
  requestId: z.guid(),
  behavior: z.enum(['allow', 'deny']),
  scope: z.enum(['once', 'session']),
  message: z.string().optional(),
  /**
   * M4b, AskUserQuestion: question text → the chosen label, the labels of a multi-select, or the user's own text. The
   * agent passes them to the CLI as `updatedInput.answers` (a string each; a multi-select joined with ", ").
   */
  answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
});

/** M4b: cmd.ok {newSessionId}. `title` — of the copy (the SDK default is the source's + " (fork)"). */
export const sessionForkPayload = z.object({ sourceSessionId: sessionId, cwd: nonEmpty, title: z.string().max(200).optional(), provider: providerSchema.optional() });

/**
 * 1.10 provider.login.start (agent-providers D10): a device-code sign-in of the provider on the machine; cmd.ok
 * ProviderLoginStart. The end comes as provider.login.done.
 */
export const providerLoginStartPayload = z.object({
  provider: extraProviderSchema,
  /** 1.11: the sign-in is for a subscription of the registry: it runs in a temporary CODEX_HOME and the auth.json goes to the hub. */
  forSubscription: z.boolean().optional(),
});
export const providerLoginStartResultSchema = z.object({
  loginId: nonEmpty,
  verificationUrl: z.url().max(2048),
  userCode: z.string().min(1).max(64),
  expiresAt: z.number().nonnegative(),
});
export type ProviderLoginStart = z.infer<typeof providerLoginStartResultSchema>;
export const providerLoginCancelPayload = z.object({ provider: extraProviderSchema, loginId: nonEmpty });
export const providerLogoutPayload = z.object({ provider: extraProviderSchema });
/** 1.10 agent → hub: the device-code sign-in ended (ok, or why not). */
export const providerLoginDonePayload = z.object({
  provider: extraProviderSchema,
  loginId: nonEmpty,
  ok: z.boolean(),
  error: z.string().max(500).optional(),
  /** 1.11: the auth.json of a sign-in started with forSubscription. Never logged. */
  credential: codexCredentialSchema.optional(),
});
/** 1.11 agent → hub: Codex refreshed the tokens of a subscription; the hub stores the new auth.json (provider-parity D4). */
export const providerCredentialUpdatePayload = z.object({ subscriptionId: z.guid(), credential: codexCredentialSchema });
/**
 * Capability codex.homes.sync, hub → agent (provider-parity R3): the Codex homes that may stay on the machine. Every
 * subscription home not in `keep` is removed; of the ones in `forget` (credential replaced) only the auth.json.
 */
export const providerCredentialsSyncPayload = z.object({
  provider: z.literal('codex'),
  keep: z.array(z.guid()).max(1000),
  forget: z.array(z.guid()).max(1000).optional(),
});

export const fileRestorePayload = z.object({
  sessionId,
  cwd: nonEmpty,
  url: z.string().regex(/^\/agent-api\/restore\/[A-Za-z0-9_-]+$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const fsStatPayload = z.object({ path: nonEmpty });
export const fsListDirsPayload = z.object({ path: z.string().max(4096).optional(), showHidden: z.boolean() });

/**
 * Agent build version: semver (`1.2.3`, `1.2.3-rc.1`, `1.2.3+build.5`). It names the directory app/versions/<v> on the
 * machine, so empty identifiers (`..`), `/` and `\` never pass. agent/src/supervisor.ts keeps a copy (dependency-free).
 */
const SEMVER_SRC = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?`;
export const AGENT_VERSION_RE = new RegExp(String.raw`^${SEMVER_SRC}$`);
/** `agent-<semver>.tgz`, group 1 — the version. */
export const AGENT_BUILD_FILE_RE = new RegExp(String.raw`^agent-(${SEMVER_SRC})\.tgz$`);

/**
 * 1.5 agent.update (multi-user M4/M5): the hub has a newer agent build. The agent waits for the end of running turns
 * (≤ 2 h), downloads `url` (relative to the hub, no token needed), checks `sha256`, replaces itself and restarts; it
 * reports through agent.update.result. Not a command (no cmd.ok): agents before 1.5 never get it.
 */
export const agentUpdatePayload = z.object({
  version: z.string().regex(AGENT_VERSION_RE),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  url: z.string().regex(new RegExp(String.raw`^/agent/agent-${SEMVER_SRC}\.tgz$`)),
});

/** 1.1: the hub stored a side file (tool-results) — the agent marks it sent. */
export const sideAckPayload = z.object({ sessionId, relPath: nonEmpty, sha256: z.string().regex(/^[0-9a-f]{64}$/) });

/** 1.1: the hub will never store this side file (name refused, sha256 mismatch): not offered again until it changes. */
export const sideRejectPayload = z.object({ sessionId, relPath: nonEmpty, sha256: z.string().regex(/^[0-9a-f]{64}$/), reason: z.enum(['bad_name', 'sha_mismatch']) });

/** 1.1 (D19): the agent answers cmd.ok {sha256, mime, size, width, height} followed by a binary frame. */
export const fsReadImagePayload = z.object({ path: nonEmpty });

/** Transcript list after welcome (1.1, D4): pages of ≤5000, `final` on the last one. */
export const REPL_FILES_PAGE = 5000;
export const replFilesPayload = z.object({
  files: z.array(z.object({ relPath: nonEmpty, size: nonNegInt, mtimeMs: z.number().nonnegative() })).max(REPL_FILES_PAGE),
  final: z.boolean(),
});

/** M4b: cmd.ok {text}; one turn without tools and without a transcript on the machine (D14). */
export const handoffGeneratePayload = z.object({
  transcript: z.string(),
  model: nonEmpty,
  systemPrompt: z.string(),
  subscription,
});

/** 1.6 limits.probe: one minimal turn under the subscription token (design L2); cmd.ok LimitsProbeResult. */
export const limitsProbePayload = z.object({
  subscription: subscriptionCredSchema,
  model: z.string().min(1).max(64),
});

// 1.7 MCP commands (mcp-management M2). The server name is the CLI's key of the MCP server.
const mcpServerName = z.string().min(1).max(200);
export const mcpStatusGetPayload = z.object({ sessionId });
export const mcpActionPayload = z.object({ sessionId, server: mcpServerName, action: mcpActionSchema });
export const mcpAuthStartPayload = z.object({ sessionId, server: mcpServerName, redirectUri: z.url().max(2048) });
/** The full address the browser came back to (code/error + state). Never logged. */
export const mcpAuthCallbackPayload = z.object({ sessionId, server: mcpServerName, callbackUrl: z.string().min(1).max(8192) });
export const mcpMachineProbePayload = z.object({});
/** 1.8 mcp.auth.logout (mcp-auth-controls A3): clear the machine's sign-in into the server; cmd.ok {snapshot}. */
export const mcpAuthLogoutPayload = z.object({ sessionId, server: mcpServerName });

// ---------- envelopes ----------

const envelopeBase = {
  v: z.literal(PROTOCOL_MAJOR),
  ts: z.number(),
};

/** Message without id/re. */
function msg<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.object({ ...envelopeBase, type: z.literal(type), id: z.string().optional(), re: z.string().optional(), payload });
}
/** Command that expects cmd.ok / cmd.error: id is required. */
function command<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.object({ ...envelopeBase, type: z.literal(type), id: nonEmpty, re: z.string().optional(), payload });
}
/** Reply to a command: re is required. */
function reply<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.object({ ...envelopeBase, type: z.literal(type), id: z.string().optional(), re: nonEmpty, payload });
}

export const agentMessageSchema = z.discriminatedUnion('type', [
  msg('hello', helloPayload),
  msg('session.state', sessionStatePayload),
  msg('session.partial', sessionPartialPayload),
  msg('session.result', sessionResultPayload),
  msg('session.exited', sessionExitedPayload),
  msg('permission.request', permissionRequestPayload),
  msg('repl.chunk', replChunkPayload),
  msg('repl.meta', replMetaPayload),
  msg('repl.agent_meta', replAgentMetaPayload),
  msg('side.file', sideFilePayload),
  msg('repl.files', replFilesPayload),
  msg('agent.status', agentStatusPayload),
  msg('agent.update.result', agentUpdateResultPayload),
  msg('limits.event', limitsEventPayload),
  msg('mcp.status', mcpStatusPayload),
  msg('mcp.auth.done', mcpAuthDonePayload),
  msg('mcp.registry.ack', mcpRegistryAckPayload),
  reply('mcp.registry.validate.result', mcpRegistryValidateResultPayload),
  msg('mcp.gateway.status', mcpGatewayStatusPayload),
  msg('mcp.oauth.token.update', mcpOAuthTokenUpdatePayload),
  msg('mcp.oauth.status.update', mcpOAuthStatusUpdatePayload),
  msg('mcp.import.preview.result', mcpImportPreviewResultPayload),
  msg('mcp.draft.request', mcpDraftRequestPayload),
  msg('mcp.registry.session-update.ack', mcpRegistrySessionUpdateAckPayload),
  command('peers.request', peersRequestPayload),
  msg('provider.login.done', providerLoginDonePayload),
  msg('provider.credential.update', providerCredentialUpdatePayload),
  reply('cmd.ok', cmdOkPayload),
  reply('cmd.error', cmdErrorPayload),
]);
export type AgentMessage = z.infer<typeof agentMessageSchema>;
export type AgentMessageType = AgentMessage['type'];

export const hubMessageSchema = z.discriminatedUnion('type', [
  msg('welcome', welcomePayload),
  msg('repl.ack', replAckPayload),
  msg('side.ack', sideAckPayload),
  msg('side.reject', sideRejectPayload),
  command('session.start', sessionStartPayload),
  command('session.resume', sessionResumePayload),
  command('session.send', sessionSendPayload),
  command('session.interrupt', sessionInterruptPayload),
  command('session.set_mode', sessionSetModePayload),
  command('session.set_model', sessionSetModelPayload),
  command('session.stop', sessionStopPayload),
  msg('permission.response', permissionResponsePayload),
  command('session.fork', sessionForkPayload),
  command('file.restore', fileRestorePayload),
  command('fs.stat', fsStatPayload),
  command('fs.list-dirs', fsListDirsPayload),
  command('fs.list', fsListPayload),
  command('fs.read', fsReadPayload),
  command('fs.read_chunk', fsReadChunkPayload),
  command('fs.read_image', fsReadImagePayload),
  command('attachments.fetch', attachmentsFetchPayload),
  command('handoff.generate', handoffGeneratePayload),
  msg('agent.update', agentUpdatePayload),
  command('limits.probe', limitsProbePayload),
  command('mcp.status.get', mcpStatusGetPayload),
  command('mcp.action', mcpActionPayload),
  command('mcp.auth.start', mcpAuthStartPayload),
  command('mcp.auth.callback', mcpAuthCallbackPayload),
  command('mcp.machine.probe', mcpMachineProbePayload),
  command('mcp.auth.logout', mcpAuthLogoutPayload),
  command('mcp.registry.sync', mcpRegistrySyncPayload),
  command('mcp.registry.validate', mcpRegistryValidatePayload),
  msg('mcp.registry.session-update', mcpRegistrySessionUpdatePayload),
  command('mcp.gateway.start', mcpGatewayStartPayload),
  command('mcp.gateway.stop', mcpGatewayStopPayload),
  command('mcp.secrets.deliver', mcpSecretDeliveryPayload),
  command('mcp.oauth.start', mcpOAuthStartPayload),
  command('mcp.oauth.callback', mcpOAuthCallbackPayload),
  command('mcp.oauth.revoke', mcpOAuthRevokePayload),
  command('mcp.oauth.credentials', mcpOAuthCredentialPayload),
  command('mcp.import.preview', mcpImportPreviewPayload),
  msg('mcp.draft.result', mcpDraftResultPayload),
  reply('peers.reply', peersReplyPayload),
  command('provider.login.start', providerLoginStartPayload),
  command('provider.login.cancel', providerLoginCancelPayload),
  command('provider.logout', providerLogoutPayload),
  command('provider.credentials.sync', providerCredentialsSyncPayload),
]);
export type HubMessage = z.infer<typeof hubMessageSchema>;
export type HubMessageType = HubMessage['type'];

export const AGENT_MESSAGE_TYPES = agentMessageSchema.options.map(o => o.shape.type.value);
export const HUB_MESSAGE_TYPES = hubMessageSchema.options.map(o => o.shape.type.value);

export type PayloadOf<M extends { type: string; payload: unknown }, T extends M['type']> = Extract<M, { type: T }>['payload'];

// ---------- parsing ----------

export type ParseResult<M> = { ok: true; message: M } | { ok: false; reason: 'invalid_json' | 'not_envelope' | 'unknown_type' | 'invalid'; type?: string; error?: string; issuePaths?: string[][] };

function parseWith<M>(raw: string | Buffer, schema: z.ZodType<M>, known: readonly string[]): ParseResult<M> {
  let data: unknown;
  try {
    data = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  if (typeof data !== 'object' || data === null || typeof (data as { type?: unknown }).type !== 'string') {
    return { ok: false, reason: 'not_envelope' };
  }
  const type = (data as { type: string }).type;
  // Minor versions may add message types: unknown types are ignored by the receiver (with a log line).
  if (!known.includes(type)) return { ok: false, reason: 'unknown_type', type };
  const r = schema.safeParse(data);
  if (!r.success) {
    return {
      ok: false,
      reason: 'invalid',
      type,
      error: z.prettifyError(r.error),
      issuePaths: r.error.issues.map(issue => issue.path.map(part => String(part))),
    };
  }
  return { ok: true, message: r.data };
}

export function parseAgentMessage(raw: string | Buffer): ParseResult<AgentMessage> {
  return parseWith(raw, agentMessageSchema, AGENT_MESSAGE_TYPES);
}

export function parseHubMessage(raw: string | Buffer): ParseResult<HubMessage> {
  return parseWith(raw, hubMessageSchema, HUB_MESSAGE_TYPES);
}

/** Builds an envelope. `ts` defaults to now. */
export function envelope<T extends string, P>(type: T, payload: P, extra: { id?: string; re?: string; ts?: number } = {}) {
  const e: { v: typeof PROTOCOL_MAJOR; type: T; ts: number; payload: P; id?: string; re?: string } = {
    v: PROTOCOL_MAJOR,
    type,
    ts: extra.ts ?? Date.now(),
    payload,
  };
  if (extra.id !== undefined) e.id = extra.id;
  if (extra.re !== undefined) e.re = extra.re;
  return e;
}
