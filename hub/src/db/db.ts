import { Kysely, PostgresDialect, type ColumnType, type Generated } from 'kysely';
import pg from 'pg';
import type { McpServerSnapshot, Provider, ProviderStatus } from '@agent-hub/shared';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface UsersTable {
  id: Generated<string>;
  email: string;
  created_at: Generated<Date>;
  /** claude-subscriptions P2: the last explicitly chosen subscription (one per user, for every client). */
  last_subscription_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** provider-parity (032): the same for Codex subscriptions. */
  last_codex_subscription_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** multi-user (023): `admin` only from OIDC_ALLOWED_EMAILS at start. */
  role: Generated<'admin' | 'user'>;
  /** keycloak-auth (047): `oidc` — the single provider of OIDC_ISSUER. */
  provider: Generated<'google' | 'keycloak' | 'oidc'>;
  /** `sub` of the provider; null until the first login of a bootstrap administrator. */
  subject: string | null;
  name: string | null;
  status: Generated<'active' | 'disabled'>;
  last_login_at: Date | null;
  /** keycloak-auth (047): how the user came; `legacy` — created before the change. */
  source: Generated<'legacy' | 'invite' | 'signup'>;
}

export interface InvitesTable {
  id: Generated<string>;
  email: string;
  /** keycloak-auth (047): null — an invite of the single provider, bound to the address only. */
  provider: 'google' | 'keycloak' | null;
  code_hash: Buffer;
  created_by: string;
  created_at: Generated<Date>;
  expires_at: Timestamp;
  used_at: Date | null;
  revoked_at: Date | null;
  user_id: string | null;
}

export type EnrollStageDb = 'waiting' | 'code_used' | 'connected' | 'claude_checked' | 'ready';

export interface EnrollCodesTable {
  code_hash: Buffer;
  runner_id: string;
  user_id: string;
  created_at: Generated<Date>;
  expires_at: Timestamp;
  used_at: Date | null;
  revoked_at: Date | null;
  stage: Generated<EnrollStageDb>;
}

export interface SecurityEventsTable {
  id: Generated<string>;
  user_id: string | null;
  kind: 'login' | 'login_denied' | 'logout_all' | 'runner_connected' | 'runner_disconnected' | 'enroll_code_issued' | 'enroll_code_used' | 'signup';
  ip: string | null;
  user_agent: string | null;
  provider: string | null;
  email: string | null;
  runner_id: string | null;
  at: Generated<Date>;
}

export interface TelegramLinksTable {
  user_id: string;
  chat_id: string;
  linked_at: Generated<Date>;
}

export interface TelegramLinkCodesTable {
  code_hash: Buffer;
  user_id: string;
  expires_at: Timestamp;
  used_at: Date | null;
}

export interface AuthSessionsTable {
  id_hash: Buffer;
  user_id: string;
  created_at: Generated<Date>;
  expires_at: Timestamp;
  user_agent: string | null;
  /** keycloak-auth (047): the plaintext id_token of older sessions; re-encrypted and erased on start (048). */
  id_token: ColumnType<string | null, string | null | undefined, string | null>;
  /** idtoken-at-rest-denied-logout (048): the id_token encrypted with the hub's key, AAD — `id_hash`; `id_token` stays empty. */
  id_token_enc: ColumnType<Buffer | null, Buffer | null | undefined, Buffer | null>;
}

export interface RunnersTable {
  id: string;
  user_id: string;
  name: string;
  kind: ColumnType<'machine' | 'k8s', 'machine' | 'k8s' | undefined, 'machine' | 'k8s'>;
  os: string | null;
  hostname: string | null;
  home_dir: string | null;
  vault_root: string | null;
  /** session-folder D1: the absolute folder where sessions of the machine start; NULL until the first hello. */
  default_dir: string | null;
  token_hash: Buffer | null;
  is_utility: Generated<boolean>;
  online: Generated<boolean>;
  last_seen_at: Date | null;
  agent_version: string | null;
  sdk_version: string | null;
  claude_version: string | null;
  protocol_version: string | null;
  created_at: Generated<Date>;
  /** multi-user (023). */
  state: Generated<'pending' | 'active' | 'disabled'>;
  /** mcp-hub-only (050): `auto-pending` — connected before the switch, local MCP until the auto-import; `done` — on the registry. */
  mcp_import_state: Generated<'auto-pending' | 'done'>;
  mcp_imported_at: Date | null;
  mcp_import_report: ColumnType<{ imported: string[]; skipped: string[] } | null, string | null | undefined, string | null>;
  claude_login: 'ok' | 'missing' | 'rejected' | null;
  protected_dirs_ok: boolean | null;
  arch: string | null;
  /** 025: hello.root (runner-enrollment «Запуск под root»); null — unknown. */
  runs_as_root: boolean | null;
  update_state: ColumnType<RunnerUpdateState | null, string | null | undefined, string | null>;
  token_hash_next: Buffer | null;
  /** 027 (mcp-management M6): the user-config MCP servers of the machine, the newest of a probe and session snapshots. */
  mcp_servers: ColumnType<McpServerSnapshot[] | null, string | null | undefined, string | null>;
  mcp_observed_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  /** The last «Проверить» (mcp.machine.probe) that returned. */
  mcp_probe_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  /** 031 (agent-providers D3): providers other than Claude from hello/agent.status of 1.10; null — never reported. */
  providers: ColumnType<ProviderStatus[] | null, string | null | undefined, string | null>;
}

export interface RunnerUpdateState {
  version: string;
  sha256?: string;
  status: 'sent' | 'waiting' | 'installing' | 'failed';
  error: string | null;
  at: string;
}

type Json = ColumnType<unknown, string, string>;
type Status = 'working' | 'waiting' | 'permission' | 'sleeping' | 'closed';

export interface SessionsTable {
  id: Generated<string>;
  user_id: string;
  runner_id: string;
  claude_session_id: string;
  cwd: string | null;
  git_branch: string | null;
  git_remote: string | null;
  source: 'hub' | 'terminal' | 'orca' | 'desktop' | 'sdk' | 'cron' | 'drive_import';
  /** Created by import:drive (D16); the source is still computed by D5. */
  is_drive_import: Generated<boolean>;
  remote_control: Generated<boolean>;
  /** Source before the hub took the session over (D5); `source` becomes 'hub' on resume. */
  origin_source: SessionsTable['source'] | null;
  seen_cli: Generated<boolean>;
  seen_sdk_cli: Generated<boolean>;
  seen_human: Generated<boolean>;
  seen_human_non_cli: Generated<boolean>;
  cron_marker: Generated<boolean>;
  is_hub_managed: Generated<boolean>;
  title: Generated<string>;
  title_source: Generated<'custom' | 'ai' | 'prompt' | 'none'>;
  status: Status;
  process_alive: Generated<boolean>;
  process_started_at: Date | null;
  unread: Generated<boolean>;
  read_only_reason: 'cwd_missing' | 'cron' | 'unknown_runner' | null;
  project_id: string | null;
  project_source: Generated<'auto' | 'manual' | 'inherited' | 'none'>;
  project_evidence: Json | null;
  secondary_project_id: string | null;
  fork_of: string | null;
  fork_mode: 'copy' | 'handoff' | null;
  /** 034 (hub-subagents D3): the session that started this one with session_spawn. */
  spawned_by: ColumnType<string | null, string | null | undefined, string | null>;
  /** 034: the parent owed a report at the end of the current turn, and since when (delivery of its message). */
  report_to_session_id: ColumnType<string | null, string | null | undefined, string | null>;
  report_since: ColumnType<Date | null, Date | null | undefined, Date | null>;
  /** 035: parent messages that reached the child inside a running turn; each owes a report of the next turn. */
  report_queued: Generated<number>;
  permission_mode: Generated<string>;
  model: string | null;
  /** 031 (agent-providers D3): the vendor of the session, fixed at creation. */
  provider: ColumnType<Provider, Provider | undefined, Provider>;
  idle_timeout_min: number | null;
  last_input_at: Date | null;
  last_turn_end_at: Date | null;
  slept_at: Date | null;
  first_event_at: Date | null;
  last_event_at: Date | null;
  last_external_write_at: Date | null;
  /** When the hub last received a live write made outside the hub (hub clock, externalActive, D9 p. 10b). */
  external_seen_at: Date | null;
  /** Start of the current streak of writes outside the hub (externalActive, M4a). */
  external_since: Date | null;
  /** claude-subscriptions P2: the subscription of the current (last) hub process; null — the machine login. */
  subscription_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** claude-subscriptions QA B2: token version (token_updated_at) the current process got; null — unknown or none. */
  subscription_token_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  /** 027 (mcp-management M6): the last MCP snapshot of the session's process (redacted on the agent). */
  mcp_servers: ColumnType<McpServerSnapshot[] | null, string | null | undefined, string | null>;
  mcp_observed_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  /** 028: the project a disable is kept under (snapshot projectRoot, agent 0.2.5+). */
  mcp_project_root: ColumnType<string | null, string | null | undefined, string | null>;
  /** `failed` + `needs-auth` of mcp_servers. */
  mcp_problems: ColumnType<number, number | undefined, number>;
  created_at: Generated<Date>;
}

export interface TranscriptFilesTable {
  id: Generated<string>;
  user_id: string;
  session_id: string | null;
  runner_id: string;
  claude_session_id: string;
  /** rel_path, lower-cased on Windows runners (D4). */
  rel_key: string;
  raw_segments: Generated<number>;
  raw_merged_at: Date | null;
  rel_path: string;
  kind: 'main' | 'subagent';
  agent_id: string | null;
  generation: Generated<number>;
  acked_line: Generated<string>;
  acked_byte: Generated<string>;
  size: Generated<string>;
  raw_flushed_line: Generated<string>;
  updated_at: Generated<Date>;
  /** A Drive import replaced by a different live file (kept, hidden from chat, search and signals). */
  superseded_at: Date | null;
}

export interface EventsTable {
  file_id: string;
  generation: number;
  line_no: string | number;
  session_id: string;
  uuid: string | null;
  parent_uuid: string | null;
  type: string;
  subtype: string | null;
  ts: Date;
  is_sidechain: Generated<boolean>;
  payload: Json;
  search_text: string | null;
}

export interface BlobsTable {
  sha256: string;
  s3_key: string;
  size: string | number;
  mime: string;
  width: number | null;
  height: number | null;
  created_at: Generated<Date>;
}

export interface BlobOwnersTable {
  sha256: string;
  user_id: string;
}

export interface UploadsTable {
  sha256: string;
  user_id: string;
  created_at: Generated<Date>;
  used_at: Date | null;
}

export interface PermissionRequestsTable {
  request_id: string;
  session_id: string;
  tool_name: string;
  tool_use_id: string;
  input: Json;
  suggestions: Json;
  created_at: Generated<Date>;
  resolved_at: Date | null;
  decision: 'allow' | 'allow_session' | 'deny' | null;
  scope: 'once' | 'session' | null;
  message: string | null;
  /** M4b: AskUserQuestion answers (question → answer). */
  answers: Json | null;
}

export interface SessionNotesTable {
  id: Generated<string>;
  session_id: string;
  ts: Generated<Date>;
  kind: string;
  text: string;
}

export interface UiLayoutsTable {
  user_id: string;
  device_class: 'desktop' | 'phone';
  layout: Json | null;
  saved_layout: Json | null;
  opened_at: Json | null;
  /** Change `subagents`: kinds of tabs that are not sessions (`{<id>: 'subagent'}`). */
  tab_kinds: Json | null;
  /** Client time (ms) of the change in the snapshot; bigint comes back as a string. */
  client_ts: ColumnType<string | null, number | null | undefined, number | null>;
  updated_at: Generated<Date>;
}

export interface ProjectsTable {
  id: Generated<string>;
  user_id: string;
  kind: 'area' | 'system' | 'project' | 'repo' | 'builtin';
  area_path: string | null;
  path: string;
  slug: string;
  title: string;
  summary: Generated<string>;
  archived: Generated<boolean>;
  color_key: Generated<string>;
  git_remotes: Generated<string[]>;
  clone_paths: Generated<string[]>;
  origin: 'index' | 'repos' | 'builtin';
  updated_at: Generated<Date>;
}

export interface HiddenProjectGroupsTable {
  user_id: string;
  project_id: string;
}

export interface CatalogProjectsTable {
  color_key: Generated<import('@agent-hub/shared').ProjectColorKey>;
  id: Generated<string>;
  user_id: string;
  name: string;
  description: Generated<string>;
  remote: string | null;
  archived: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  last_event_at: Date | null;
  /** session-folder D1: the project folder relative to the default folder of a machine, '/' separators; NULL — none. */
  folder: string | null;
}
export interface ProjectBindingsTable {
  user_id: string;
  project_id: string;
  runner_id: string;
  path: string;
}
export interface UserPreferencesTable {
  user_id: string;
  last_runner_id: string | null;
  last_provider: Provider | null;
  /** change i18n D4: the interface language of the profile; NULL — the browser language. */
  locale: string | null;
}
export interface ProjectSuggestionsTable {
  user_id: string;
  session_id: string;
  project_id: string | null;
  options: ColumnType<string[], string[] | undefined, string[]>;
  new_project_name: string | null;
  confidence: number;
  reason_code: string;
  input_hash: string;
  messages_hash: string;
  state: 'pending' | 'dismissed' | 'accepted';
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface ProjectClassifierUsageTable {
  id: Generated<string>;
  user_id: string;
  session_id: string;
  created_at: Generated<Date>;
}
export interface SessionProjectsTable {
  user_id: string;
  session_id: string;
  project_id: string;
  source: 'explicit' | 'auto' | 'manual';
  reason_code: ColumnType<string | null, string | null | undefined, string | null>;
  confidence: number | null;
  created_at: Generated<Date>;
}

export interface PathTouchesTable {
  session_id: string;
  file_id: string;
  line_no: string | number;
  op: 'edit' | 'read' | 'cwd' | 'remote';
  path_norm: string;
  project_id: string | null;
}

export interface ClassificationLabelsTable {
  session_id: string;
  project_id: string | null;
  user_id: string;
  created_at: Generated<Date>;
}

/** Subagents of a session (change `subagents`, design S1, migration 017). */
/** meta.json of subagents of a session not known yet (migration 020). */
export interface PendingAgentMetaTable {
  runner_id: string;
  claude_session_id: string;
  agent_id: string;
  meta: Json;
  received_at: Generated<Date>;
}

/** Web Push subscriptions of the devices (migration 045, change `web-push-notifications`). */
export interface PushSubscriptionsTable {
  id: Generated<string>;
  user_id: string;
  endpoint: string;
  endpoint_hash: string;
  p256dh: string;
  auth: string;
  device_label: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  last_failure_status: number | null;
  failure_count: Generated<number>;
  /** The language of the UI of the device when it subscribed (migration 046); the profile language wins. */
  locale: string | null;
}

/** 052 (provider-parity R5, R6): a Codex sign-in for a subscription in progress. */
export interface CodexSubscriptionLoginsTable {
  login_id: string;
  user_id: string;
  runner_id: string;
  name: string | null;
  subscription_id: string | null;
  created_at: Generated<Date>;
  expires_at: Date;
}

/** Messages between sessions (migration 030, change `session-peers`). */
export interface PeerMessagesTable {
  id: string;
  user_id: string;
  from_session_id: string;
  to_session_id: string;
  text: string;
  in_reply_to: string | null;
  result: 'delivered' | 'queued' | 'resumed' | 'rate_limited' | 'error';
  error_code: string | null;
  /** 034 (hub-subagents D3). */
  kind: Generated<'message' | 'spawn' | 'report'>;
  created_at: Generated<Date>;
}

/** Background commands of a session (migration 019). */
export interface BackgroundTasksTable {
  session_id: string;
  tool_use_id: string;
  task_id: string | null;
  state: Generated<'pending' | 'running' | 'completed' | 'failed' | 'stopped' | 'expired'>;
  started_at: Date | null;
  ended_at: Date | null;
  // change `background-tasks` (029)
  kind: Generated<'bash' | 'monitor'>;
  description: string | null;
  command: string | null;
  timeout_ms: string | null;
  persistent: Generated<boolean>;
  last_event_at: Date | null;
  last_event: string | null;
  // 044: an end read before the call or its result
  early_end: 'completed' | 'failed' | 'stopped' | null;
  // 051: the subagent whose transcript made the call; null — the main transcript
  agent_id: string | null;
}

export interface SubagentRunsTable {
  id: Generated<string>;
  user_id: string;
  session_id: string;
  agent_id: string | null;
  tool_use_id: string | null;
  file_id: string | null;
  parent_agent_id: string | null;
  kind: Generated<'subagent' | 'teammate' | 'skill'>;
  description: string | null;
  agent_type: string | null;
  name: string | null;
  team_name: string | null;
  model: string | null;
  prompt_sha: Buffer | null;
  background: Generated<boolean>;
  state: Generated<'running' | 'idle' | 'completed' | 'failed' | 'stopped'>;
  started_at: Date | null;
  last_event_at: Date | null;
  ended_at: Date | null;
  state_at: Date | null;
  result_at: Date | null;
  from_call: Generated<boolean>;
  duration_ms: string | null;
  total_tokens: string | null;
  tool_uses: string | null;
  meta: Json | null;
  updated_at: Generated<Date>;
}

/** Handoff drafts (D14, migration 014). */
export interface HandoffDraftsTable {
  id: Generated<string>;
  user_id: string;
  session_id: string;
  status: 'pending' | 'ready' | 'error';
  text: string | null;
  error: string | null;
  runner_id: string | null;
  created_at: Generated<Date>;
  finished_at: Date | null;
}

export interface AlertStateTable {
  key: string;
  last_sent_at: Date;
  detail: string | null;
}

export interface ImportRunsTable {
  id: Generated<string>;
  started_at: Generated<Date>;
  finished_at: Date | null;
  report: ColumnType<unknown, string | undefined, string>;
}

/** claude-subscriptions P2: a Claude subscription with its encrypted `claude setup-token`. */
export interface SubscriptionsTable {
  id: Generated<string>;
  user_id: string;
  name: string;
  /** iv(12) ‖ tag(16) ‖ ciphertext (AES-256-GCM, AAD = id). */
  token_enc: Buffer;
  token_hint: string;
  /** provider-parity (032): claude — the setup-token; codex — the auth.json of a CODEX_HOME in token_enc. */
  provider: Generated<'claude' | 'codex'>;
  position: number;
  auto_switch: Generated<boolean>;
  retired_at: Date | null;
  limit_resets_at: Date | null;
  limit_kind: string | null;
  token_rejected_at: Date | null;
  token_updated_at: Generated<Date>;
  created_at: Generated<Date>;
}

/** claude-subscriptions P2/P10: one finished turn of a hub process. */
export interface SessionTurnsTable {
  id: Generated<string>;
  user_id: string;
  session_id: string;
  runner_id: string;
  subscription_id: string | null;
  ended_at: Date;
  is_error: boolean;
  failure: 'subscription_limit' | 'auth_rejected' | 'account_unavailable' | null;
  input_tokens: ColumnType<string, number | undefined, number>;
  output_tokens: ColumnType<string, number | undefined, number>;
  cache_read_tokens: ColumnType<string, number | undefined, number>;
  cache_creation_tokens: ColumnType<string, number | undefined, number>;
}

/** subscription-limits L4: the one snapshot of limits of a subscription. No token. */
export type LimitsProbeOutcomeDb = 'ok' | 'no_event' | 'limit' | 'auth_rejected' | 'account_unavailable' | 'failed' | 'no_runner' | 'agent_outdated';
export interface SubscriptionLimitsTable {
  subscription_id: string;
  user_id: string;
  /** The token version (subscriptions.token_updated_at) of the snapshot (review A5). */
  token_at: Date;
  /** [{type, utilization, resetsAt, status, surpassedThreshold, observedAt, source}] — StoredLimitWindow[] */
  windows: ColumnType<unknown, string | undefined, string>;
  overage: ColumnType<unknown, string | null | undefined, string | null>;
  last_ok_at: Date | null;
  last_quiet_at: Date | null;
  last_probe_at: Date | null;
  probe_outcome: LimitsProbeOutcomeDb | null;
  probe_error: string | null;
  probe_failures: Generated<number>;
  updated_at: Generated<Date>;
}

/** MCP registry rows (migration 037). JSON columns are decoded by pg on reads. */
export interface McpRegistryServersTable {
  id: Generated<string>;
  user_id: string;
  name: string;
  config: ColumnType<Record<string, unknown>, string, string>;
  enabled: Generated<boolean>;
  revision: ColumnType<string, number | undefined, number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface McpRegistryMetaTable {
  user_id: string;
  revision: ColumnType<string, number | undefined, number>;
  updated_at: Generated<Date>;
}

export interface McpRegistryOverridesTable {
  user_id: string;
  project_id: string;
  server_id: string;
  enabled: boolean | null;
  config: ColumnType<Record<string, unknown> | null, string | null | undefined, string | null>;
  revision: ColumnType<string, number | undefined, number>;
}

export interface McpRegistryMachineOverridesTable {
  user_id: string;
  server_id: string;
  runner_id: string;
  enabled: Generated<boolean>;
  config: ColumnType<Record<string, unknown> | null, string | null | undefined, string | null>;
  updated_at: Generated<Date>;
}

export interface McpSecretsTable {
  id: Generated<string>;
  user_id: string;
  server_id: string | null;
  draft_id: string | null;
  import_id: string | null;
  /** mcp-hub-only (050): set for a secret of a machine override — delivered to that machine only. */
  machine_id: string | null;
  name: string;
  ciphertext: Buffer;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type McpDraftStateDb = 'draft' | 'validating' | 'checked' | 'validation-failed' | 'needs-secret' | 'needs_auth' | 'connected' | 'saved-unchecked';
export interface McpRegistryDraftsTable {
  id: Generated<string>;
  user_id: string;
  runner_id: string | null;
  session_id: string | null;
  server_id: string | null;
  base_revision: ColumnType<string | null, number | null | undefined, number | null>;
  name: string;
  state: McpDraftStateDb;
  config: ColumnType<Record<string, unknown>, string, string>;
  validation: ColumnType<Record<string, unknown> | null, string | null | undefined, string | null>;
  revision: ColumnType<string, number | undefined, number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface McpRegistryImportsTable {
  id: string;
  user_id: string;
  runner_id: string;
  preview: ColumnType<Record<string, unknown>, string, string>;
  state: 'preview' | 'committed' | 'expired';
  created_at: Generated<Date>;
  expires_at: Generated<Date>;
}

export interface McpOauthTokensTable {
  user_id: string;
  server_id: string;
  machine_id: string;
  ciphertext: Buffer;
  updated_at: Generated<Date>;
}

export interface McpOauthStatusesTable {
  user_id: string;
  server_id: string;
  machine_id: string;
  state: 'pending' | 'signed-in' | 'refresh-error' | 'expired' | 'failed' | 'needs-login';
  validation_state: 'unchecked' | 'checked' | 'needs_auth' | 'validation-failed';
  validated_revision: string | null;
  registry_ready: boolean;
  expires_at: Date | null;
  error: string | null;
  updated_at: Generated<Date>;
}

export interface McpGatewayStatusesTable {
  id: Generated<string>;
  server_id: string;
  machine_id: string;
  session_id: string | null;
  status: 'stopped' | 'starting' | 'ready' | 'needs-secret' | 'failed';
  endpoint: string | null;
  error: string | null;
  observed_at: Generated<Date>;
}

export interface McpRegistrySessionUpdatesTable {
  user_id: string;
  runner_id: string;
  session_id: string;
  server_id: string;
  revision: ColumnType<string, number, number>;
  activation: 'connected-live' | 'available-next-thread' | 'deferred';
  applied: boolean;
  error: string | null;
  updated_at: Generated<Date>;
}

export interface McpRegistryAuditTable {
  id: Generated<string>;
  user_id: string;
  actor: string;
  action: string;
  server_id: string | null;
  draft_id: string | null;
  details: ColumnType<unknown, string | undefined, string>;
  created_at: Generated<Date>;
}

export interface Database {
  users: UsersTable;
  auth_sessions: AuthSessionsTable;
  runners: RunnersTable;
  sessions: SessionsTable;
  transcript_files: TranscriptFilesTable;
  events: EventsTable;
  permission_requests: PermissionRequestsTable;
  session_notes: SessionNotesTable;
  blobs: BlobsTable;
  uploads: UploadsTable;
  blob_owners: BlobOwnersTable;
  alert_state: AlertStateTable;
  projects: ProjectsTable;
  catalog_projects: CatalogProjectsTable;
  hidden_project_groups: HiddenProjectGroupsTable;
  project_bindings: ProjectBindingsTable;
  user_preferences: UserPreferencesTable;
  session_projects: SessionProjectsTable;
  project_suggestions: ProjectSuggestionsTable;
  project_classifier_usage: ProjectClassifierUsageTable;
  path_touches: PathTouchesTable;
  classification_labels: ClassificationLabelsTable;
  handoff_drafts: HandoffDraftsTable;
  subagent_runs: SubagentRunsTable;
  background_tasks: BackgroundTasksTable;
  codex_subscription_logins: CodexSubscriptionLoginsTable;
  peer_messages: PeerMessagesTable;
  push_subscriptions: PushSubscriptionsTable;
  pending_agent_meta: PendingAgentMetaTable;
  import_runs: ImportRunsTable;
  ui_layouts: UiLayoutsTable;
  invites: InvitesTable;
  enroll_codes: EnrollCodesTable;
  security_events: SecurityEventsTable;
  telegram_links: TelegramLinksTable;
  telegram_link_codes: TelegramLinkCodesTable;
  subscriptions: SubscriptionsTable;
  session_turns: SessionTurnsTable;
  subscription_limits: SubscriptionLimitsTable;
  mcp_registry_servers: McpRegistryServersTable;
  mcp_registry_meta: McpRegistryMetaTable;
  mcp_registry_overrides: McpRegistryOverridesTable;
  mcp_registry_machine_overrides: McpRegistryMachineOverridesTable;
  mcp_secrets: McpSecretsTable;
  mcp_registry_drafts: McpRegistryDraftsTable;
  mcp_registry_imports: McpRegistryImportsTable;
  mcp_oauth_tokens: McpOauthTokensTable;
  mcp_oauth_statuses: McpOauthStatusesTable;
  mcp_gateway_statuses: McpGatewayStatusesTable;
  mcp_registry_session_updates: McpRegistrySessionUpdatesTable;
  mcp_registry_audit: McpRegistryAuditTable;
}

export type Db = Kysely<Database>;

export function createPool(connectionString: string, onError: (err: Error) => void = () => undefined): pg.Pool {
  // 20: per-session queues, replication of three machines (hundreds of first uploads) and import:drive in parallel;
  // Postgres allows 60 (deploy/compose.yml: hub 20, Keycloak 10, the CLI and backups open their own few; prod 2026-10-26: 9 in use).
  const pool = new pg.Pool({ connectionString, max: 20 });
  // An idle client losing its connection emits 'error' on the pool; without a listener the process crashes.
  pool.on('error', onError);
  return pool;
}

export function createDb(pool: pg.Pool): Db {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
