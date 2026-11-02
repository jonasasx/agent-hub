// Snapshot of the 1.6 protocol schemas (verbatim copy of shared/src/protocol.ts of main before 1.7, commit 7ec3398).
// Compatibility tests parse messages of 1.7 with it: an agent or hub of 1.6 must accept what a peer of 1.7 sends it (D3).
// Do not edit.
// Requirement: Совместимость управления MCP с агентом
// Hub <-> agent protocol, version 1.x (design.md D3).
// Requirement: Версионированный протокол
import { z } from 'zod';

/**
 * 1.1 (M3a): repl.files, side files. 1.2 (M3b): attachments, attachments.fetch, fs.read_image, fs.stat size/mtime.
 * 1.3: repl.agent_meta. 1.4 (claude-subscriptions P3): `subscription` in session.start/resume and handoff.generate,
 * `usage`/`failure` in session.result, `failure` in cmd.error of handoff.generate. 1.5 (change `multi-user`, design M4):
 * hello.claude/protectedDirs/arch, agent.status, agent.update, agent.update.result. 1.6 (change `subscription-limits`,
 * design L3): command limits.probe (a probe turn under a subscription token), message limits.event (rate_limit_event of
 * a session turn under a subscription, or `quiet` — a successful turn without one).
 * Minor versions talk to each other (D3); images need 1.2 on the agent, subscriptions 1.4, self-update 1.5, limits 1.6.
 */
export const PROTOCOL_VERSION = '1.6';
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

/**
 * 1.5 agent.status: the agent re-checked the Claude login (after an authorization failure in a turn, after
 * `agent-hub login`) or the protected directories; only the fields that are known are sent.
 */
export const agentStatusPayload = z.object({
  claude: claudeStatusSchema.optional(),
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
export const subscriptionCredSchema = z.object({
  id: z.guid(),
  token: subscriptionTokenSchema,
});
export type SubscriptionCred = z.infer<typeof subscriptionCredSchema>;
/** 1.4: absent — the process runs under the machine login, as before. The hub sends it to agents of 1.4+ only. */
const subscription = subscriptionCredSchema.optional();

/**
 * attachments.fetch (1.2, D19): the agent downloads and checks every image and keeps it in its cache by sha256
 * (TTL 15 min); start/resume/send that follow take the bytes from the cache. Result `{cached: n}`.
 */
export const attachmentsFetchPayload = z.object({ attachments: z.array(attachmentSchema).min(1).max(10) });

export const sessionStartPayload = z.object({
  sessionId,
  cwd: nonEmpty,
  permissionMode: permissionModeSchema,
  model: nonEmpty,
  prompt: z.string(),
  promptUuid: z.guid(),
  attachments,
  subscription,
});

export const sessionResumePayload = z.object({
  sessionId,
  cwd: nonEmpty,
  permissionMode: permissionModeSchema,
  /** Absent: the user's default model on that machine (sessions started outside the hub). Optional since M2 (agents of M1 do not handle resume). */
  model: nonEmpty.optional(),
  prompt: z.string().optional(),
  promptUuid: z.guid().optional(),
  attachments,
  subscription,
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
export const sessionForkPayload = z.object({ sourceSessionId: sessionId, cwd: nonEmpty, title: z.string().max(200).optional() });

export const fileRestorePayload = z.object({
  sessionId,
  cwd: nonEmpty,
  url: z.string().regex(/^\/agent-api\/restore\/[A-Za-z0-9_-]+$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const fsStatPayload = z.object({ path: nonEmpty });

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
  command('fs.read_image', fsReadImagePayload),
  command('attachments.fetch', attachmentsFetchPayload),
  command('handoff.generate', handoffGeneratePayload),
  msg('agent.update', agentUpdatePayload),
  command('limits.probe', limitsProbePayload),
]);
export type HubMessage = z.infer<typeof hubMessageSchema>;
export type HubMessageType = HubMessage['type'];

export const AGENT_MESSAGE_TYPES = agentMessageSchema.options.map(o => o.shape.type.value);
export const HUB_MESSAGE_TYPES = hubMessageSchema.options.map(o => o.shape.type.value);

export type PayloadOf<M extends { type: string; payload: unknown }, T extends M['type']> = Extract<M, { type: T }>['payload'];

// ---------- parsing ----------

export type ParseResult<M> = { ok: true; message: M } | { ok: false; reason: 'invalid_json' | 'not_envelope' | 'unknown_type' | 'invalid'; type?: string; error?: string };

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
  if (!r.success) return { ok: false, reason: 'invalid', type, error: z.prettifyError(r.error) };
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
