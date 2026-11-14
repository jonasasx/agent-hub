// Hub <-> web contracts (design.md D10). M1 + M2 subset; later milestones extend it.
import { z } from 'zod';
import type { SubagentStatus } from './subagents.js';
import type { FsAgentErrorCode, FsEntry } from './files.js';
import type { I18nText, Locale } from './i18n/index.js';
import { LOCAL_PATH_MESSAGE, isAbsoluteLocalPath } from './paths.js';
import { normalizeProjectFolder } from './folders.js';
import { mcpActionSchema, providerSchema, subscriptionTokenSchema, type ClaudeLogin, type McpServerSnapshot, type Provider, type ProviderLoginStart, type ProviderStatus } from './protocol.js';

export type RunnerKind = 'machine' | 'k8s';

/** Runner as shown in the sidebar footer and the new-session form. Requirement: Реестр раннеров */
export interface RunnerView {
  id: string;
  name: string;
  kind: RunnerKind;
  os: string | null;
  online: boolean;
  /** ISO timestamp of the last connection activity, null if never connected. */
  lastSeenAt: string | null;
  agentVersion: string | null;
  claudeVersion: string | null;
  protocolVersion: string | null;
  /** The last agent that tried to connect spoke an incompatible major protocol version. */
  incompatible: boolean;
  /**
   * session-folder D4: the default folder of the machine — sessions start there, project folders are relative to it.
   * The hub always sends both fields (null when unknown); they are optional only so M1 web fixtures keep compiling.
   */
  defaultDir?: string | null;
  homeDir?: string | null;
  /**
   * Change `multi-user` (the hub always sends the fields below; optional only for older fixtures).
   * `pending` — created by «Подключить машину», no agent connected yet; `disabled` — «Отключить»: token revoked,
   * hidden from the new-session form, its sessions are read-only.
   */
  state?: RunnerState;
  /** From hello.claude / agent.status (agents of 1.4); null — unknown (older agent or never connected). */
  claudeLogin?: ClaudeLogin | null;
  /** macOS: false — no access to ~/Documents, ~/Desktop, ~/Downloads («нет доступа к защищённым папкам macOS»); null — n/a or unknown. */
  protectedDirsOk?: boolean | null;
  arch?: string | null;
  /** hello.root: the agent runs as root, bypassPermissions is refused (runner-enrollment «Запуск под root»); null — unknown. */
  runsAsRoot?: boolean | null;
  /** The agent is older than the build the hub serves («устарела»). */
  outdated?: boolean;
  /** Self-update (design M4/M5); null — nothing in progress. */
  update?: RunnerUpdateView | null;
  /** agent-providers: providers other than Claude on the machine (hello/agent.status of 1.10); [] — none or unknown. */
  providers?: ProviderStatus[];
}

/** agent-providers: can a session of `provider` start on the runner (Claude — always; others — installed and signed in). */
export function providerReady(r: Pick<RunnerView, 'providers'> | null | undefined, provider: Provider): boolean {
  if (provider === 'claude') return true;
  return r?.providers?.some(p => p.id === provider && p.login === 'ok') ?? false;
}

/** Display name of a provider. */
export const PROVIDER_LABELS: Record<Provider, string> = { claude: 'Claude', codex: 'Codex' };

/** POST /api/runners/:id/providers/:provider/login → 200 this; the end comes as WS provider.login. */
export type ProviderLoginStartView = ProviderLoginStart;

export type RunnerState = 'pending' | 'active' | 'disabled';

/** Requirement (runner-enrollment): Запуск под root — bypassPermissions is not offered on such a machine. */
export function bypassUnavailable(r: Pick<RunnerView, 'runsAsRoot'> | null | undefined): boolean {
  return r?.runsAsRoot === true;
}

export interface RunnerUpdateView {
  /** Target version. */
  version: string;
  /** `sent` — agent.update sent; `waiting` — turns running; `installing`; `failed` — «обновление не удалось». */
  status: 'sent' | 'waiting' | 'installing' | 'failed';
  error: string | null;
  at: string;
}

export type UserRole = 'admin' | 'user';
/** keycloak-auth: `oidc` — the single provider of OIDC_ISSUER. */
export type LoginProvider = 'google' | 'keycloak' | 'oidc';
/** keycloak-auth: how the user came in; `legacy` — created before the single provider. */
export type UserSource = 'legacy' | 'invite' | 'signup';

export interface MeResponse {
  /** Change `multi-user`: `role` — «Пользователи» only for `admin`. */
  user: { id: string; email: string; role: UserRole; name: string | null; provider: LoginProvider };
  vapidPublicKey: string | null;
  /** Dictation is available: the hub has ELEVENLABS_API_KEY (change voice-input, D5). */
  voiceInput: boolean;
  /** Voice conversation is available: ELEVENLABS_API_KEY, VOICE_AGENT_ID and VOICE_LLM_KEY are set (change voice-conversation, D10). */
  voiceTalk: boolean;
  /** Change i18n D4: the interface language chosen in the profile; `null` — the browser language. */
  locale: Locale | null;
  /** keycloak-auth D5: the account page of the provider («Управление входом»); null — the provider has none. */
  accountUrl: string | null;
  /** keycloak-auth D5: the name of the single provider (OIDC_PROVIDER_LABEL, else «OIDC»); null — two-provider mode. */
  singleProvider: string | null;
}

export const PROJECT_COLORS = ['scanner', 'platform', 'customers', 'support', 'infra', 'tools', 'org', 'ext', 'personal', 'rose', 'lime', 'slate'] as const;
export type ProjectColorKey = (typeof PROJECT_COLORS)[number];
export const projectColorSchema = z.enum(PROJECT_COLORS);

/** Assign once; palette order breaks ties independently of project ordering. */
export function allocateProjectColor(used: readonly string[], identity = ''): ProjectColorKey {
  const hash = (key: string) => {
    let n = 2166136261;
    for (const ch of `${identity}:${key}`) n = Math.imul(n ^ ch.charCodeAt(0), 16777619);
    return n >>> 0;
  };
  const count = (key: string) => used.filter(c => c === key).length;
  return [...PROJECT_COLORS].sort((a, b) => count(a) - count(b) || (identity ? hash(a) - hash(b) : PROJECT_COLORS.indexOf(a) - PROJECT_COLORS.indexOf(b)))[0]!;
}

/** Manually curated project catalog (projects-catalog 1.12). */
export interface UserProjectView {
  id: string;
  name: string;
  colorKey: ProjectColorKey;
  sessionCount?: number;
  description: string;
  remote: string | null;
  archived: boolean;
  lastEventAt: string | null;
  /** session-folder D6: the folder relative to the default folder of a machine ('/' separators); null — none. */
  folder: string | null;
}
/** session-folder D2: a project folder in the API — normalized; '' or null — no folder; invalid — 400 invalid_request. */
const projectFolderField = z
  .string()
  .max(4096)
  .nullable()
  .transform((v, ctx) => {
    try {
      return normalizeProjectFolder(v);
    } catch (err) {
      ctx.addIssue({ code: 'custom', message: (err as Error).message });
      return z.NEVER;
    }
  });
export const createUserProjectSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .transform(v => v.normalize('NFC')),
  colorKey: projectColorSchema.optional(),
  description: z.string().max(2000).optional(),
  remote: z.string().max(2000).nullable().optional(),
  folder: projectFolderField.optional(),
});
export type CreateUserProject = z.infer<typeof createUserProjectSchema>;
export const patchUserProjectSchema = z
  .object({
    folder: projectFolderField.optional(),
    colorKey: projectColorSchema.optional(),
    name: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .transform(v => v.normalize('NFC'))
      .optional(),
    description: z.string().max(2000).optional(),
    remote: z.string().max(2000).nullable().optional(),
    archived: z.boolean().optional(),
  })
  .refine(v => Object.keys(v).length > 0);
export const userProjectListQuerySchema = z.object({ sort: z.enum(['recent', 'name']).default('recent'), includeArchived: z.enum(['0', '1']).default('0') });
export const userProjectParamsSchema = z.object({ id: z.guid() });

/** POST /api/sessions/resolve (change session-links): UUIDs written in the feed — hub ids or Claude Code session ids. */
export const resolveSessionRefsSchema = z.object({ ids: z.array(z.guid()).min(1).max(100) });
/** A UUID of the feed that is a session of the user: `ref` as asked, `id` — the hub session to open. */
export interface SessionRefView {
  ref: string;
  id: string;
  title: string;
  runnerName: string | null;
}

export interface ApiError {
  error: string;
  message?: string;
}

// ---------- sessions (D6, D8) ----------

/** Modes offered in the UI. The protocol accepts more (`dontAsk`, `auto`), the UI does not show them. */
export const UI_PERMISSION_MODES = ['bypassPermissions', 'acceptEdits', 'default', 'plan'] as const;
export type UiPermissionMode = (typeof UI_PERMISSION_MODES)[number];

/** Stored statuses (D8). `offline` is computed on the client: runner offline and status ≠ closed. */
export const SESSION_STATUSES = ['working', 'waiting', 'permission', 'sleeping', 'closed'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];
/**
 * `offline` — runner offline and status ≠ closed (computed on the client); `external` — written outside the hub right
 * now while the stored status is closed or sleeping (externalActive, change `subagents` S10.1): «работает в <источник>».
 */
export type DisplayStatus = SessionStatus | 'offline' | 'external';

/** D5 (M3): Remote Control is not a source but the flag `remoteControl`. */
export type SessionSource = 'hub' | 'terminal' | 'orca' | 'desktop' | 'sdk' | 'cron' | 'drive_import';

/** Colour key of a vault area (D9 p.5). */
export type ColorKey = 'scanner' | 'platform' | 'customers' | 'support' | 'infra' | 'tools' | 'org' | 'ext' | 'personal' | 'rose' | 'lime' | 'slate' | 'none';

/** Kind of a catalogue element (D9): area of the vault, system, project, code clone, built-in «Vault»/«Знания». */
export type ProjectKind = 'area' | 'system' | 'project' | 'repo' | 'builtin';

export interface ProjectRef {
  /** `null` — «Без проекта». */
  id: string | null;
  title: string;
  colorKey: ColorKey;
  /** Path in the vault, shown on hover; empty for «Без проекта»; «Vault» — its directories joined by « · ». */
  path: string;
  /** M4; absent for «Без проекта». */
  kind?: ProjectKind;
  /** A project in projects/99-archive (shown muted). */
  archived?: boolean;
  /** The title as a key (the built-in «No project»); the client renders it in its language. */
  i18n?: I18nText;
}

/** GET /api/projects: the catalogue for «Перенести в…»; «Без проекта» is `{id: 'none'}` (last). */
export interface ProjectListItem {
  id: string;
  kind: ProjectKind | 'none';
  title: string;
  path: string;
  areaPath: string | null;
  colorKey: ColorKey;
  archived: boolean;
  /** The title as a key (the built-in «No project»). */
  i18n?: I18nText;
}

/** PUT /api/sessions/:id/project — move = pin (D10). */
export const setProjectRequestSchema = z.object({ projectId: z.union([z.literal('none'), z.guid()]) });
export type SetProjectRequest = z.infer<typeof setProjectRequestSchema>;

/** Reasons a session is read-only (input, mode and model disabled). */
export type ReadOnlyReason = 'cwd_missing' | 'cron' | 'unknown_runner';

/** Idle timeout choices of the UI, minutes; 0 = «не усыплять», null = default (30). */
export const IDLE_TIMEOUT_CHOICES = [15, 30, 60, 120, 480, 0] as const;

/** A session row: sidebar, tabs, chat head. */
export interface SessionView {
  id: string;
  title: string;
  /** agent-providers: the vendor of the session (fixed at creation). Optional only for older fixtures — absent is claude. */
  provider?: Provider;
  runnerId: string;
  cwd: string | null;
  status: SessionStatus;
  unread: boolean;
  processAlive: boolean;
  /** Current source: 'hub' once the hub started or resumed the session. */
  source: SessionSource;
  /** Where the session came from (terminal, Orca, desktop…), kept after the hub resumes it (D5). */
  originSource: SessionSource;
  isHubManaged: boolean;
  isCron: boolean;
  /** The transcript has `bridge-session` lines (Remote Control was on), D5. */
  remoteControl: boolean;
  /** Created by import:drive (D16): the header says «из Drive». Optional for older hubs. */
  isDriveImport?: boolean;
  readOnlyReason: ReadOnlyReason | null;
  project: ProjectRef;
  /** User-owned project catalog link; when present it is the session's visible project. */
  catalogProject?: { id: string; name: string } | null;
  catalogProjectSource?: 'explicit' | 'auto' | 'manual' | null;
  catalogProjectReason?: string | null;
  projectSuggestion?: ProjectSuggestionView | null;
  projectSource: 'auto' | 'manual' | 'inherited' | 'none';
  /**
   * The line under the chat head (D9 p. 6): «2 правки и 5 чтений в 05-agent-hub», «каталог запуска в X», «git remote g/r»
   * for `auto`; «закреплено вручную» (or «проект удалён из справочника») for `manual`; null — «проект пока не определён».
   */
  projectEvidence: string | null;
  /** The same evidence as a key for a manual, inherited or deleted pin; an automatic one has only the English text. */
  projectEvidenceI18n?: I18nText;
  /** The second element with weight ≥3 (shown as a label), null when none. M4. */
  secondaryProject?: ProjectRef | null;
  forkOf: { id: string; title: string } | null;
  /** hub-subagents D7: the session that started this one with session_spawn. Optional only for older hubs and fixtures. */
  spawnedBy?: { id: string; title: string } | null;
  permissionMode: UiPermissionMode;
  model: string | null;
  /** Override set by the user: null = default, 0 = never. */
  idleTimeoutMin: number | null;
  /** Timeout the hub applies now (idleTimeoutMin ?? 30; 120 while waiting for permission); 0 = never. */
  effectiveIdleTimeoutMin: number;
  /** When the hub will put the session to sleep if nothing happens (ISO); null when not counting down. */
  sleepsAt: string | null;
  lastInputAt: string | null;
  lastTurnEndAt: string | null;
  sleptAt: string | null;
  lastEventAt: string | null;
  /** Last time the .jsonl grew while the hub had no process of this session (terminal, Orca). */
  lastExternalWriteAt: string | null;
  /**
   * The session is being written outside the hub right now (desktop, terminal, Orca): its transcript grew within the
   * last 3 minutes while the hub has no process of it. Shown as «работает в <источник>», not «завершена»; turns false
   * after 3 minutes of silence (the hub sends session.upsert). M4a.
   */
  externalActive?: boolean;
  /** Start of that activity (ISO), null when not active. */
  externalSince?: string | null;
  /**
   * Change `subagents`: registry rows of the session; `running` — rows in state «running» (teammates waiting for messages do not count), 0 when the session is not alive.
   * `working` — children that really work now: subagents in state «running» plus background commands (Bash/PowerShell
   * run_in_background) not finished, of the current process; teammates waiting for messages do not count. The same
   * count keeps the session awake (sleep rule). Always sent by the hub; optional only for older fixtures.
   * `background` (change `background-tasks`): monitors and background commands of the session shown in the list
   * (started ones, any state); `working` counts the running ones among them (a monitor past its timeout does not work).
   */
  subagents?: {
    total: number;
    running: number;
    working?: number;
    background?: number;
    /** hub-subagents D7: child hub sessions (session_spawn); `working` — alive ones in working/permission. Alive means the sleep-rule one (children_working), with its 120-minute stall guard. */
    hub?: { total: number; working: number };
  };
  /** The tool of the open permission request (AskUserQuestion, ExitPlanMode, …), null without one (S10.3). */
  pendingPermission?: { toolName: string } | null;
  /**
   * claude-subscriptions (P8): the subscription of the current or last hub process; null — the machine login (or never
   * run by the hub). Optional only for older hubs and fixtures.
   */
  subscription?: SessionSubscriptionRef | null;
  /** How the next hub process of the session is authenticated (see SubscriptionMode). Optional for older hubs. */
  subscriptionMode?: SubscriptionMode;
  /**
   * mcp-management (M8): servers of the last MCP snapshot in `failed` or `needs-auth` — the mark in the tab head and
   * the sidebar row. 0 or absent — no mark (older hubs do not send it).
   */
  mcpProblems?: number;
  createdAt: string;
}

export interface SidebarProject {
  project: ProjectRef;
  /** working/waiting/permission/sleeping. */
  live: number;
  total: number;
  lastActivityAt: string | null;
  /** The five freshest sessions. */
  sessions: SessionView[];
}

export interface SidebarResponse {
  now: SessionView[];
  projects: SidebarProject[];
  runners: RunnerView[];
}

/** GET /api/projects/:id/sessions (`id` = `none` for «Без проекта»). */
export interface ProjectSessionsResponse {
  sessions: SessionView[];
  total: number;
}

export interface ModelOption {
  value: string;
  displayName: string;
}

export interface StatResponse {
  exists: boolean;
  isDir: boolean;
  /** Agents of 1.2: size and modification time of a file (the hub checks a stored «Показать изображение» with them). */
  size?: number;
  mtimeMs?: number;
}

// ---------- chat events ----------

/** A raw `.jsonl` line as stored in `events.payload` (from M3 big payloads are replaced by `$blob`). */
export type TranscriptLine = Record<string, unknown> & { type?: string; uuid?: string; timestamp?: string };

export type PermissionDecision = 'allow' | 'allow_session' | 'deny';

/** What the card asks (M4b): a tool call to allow, questions of AskUserQuestion, a plan of ExitPlanMode. */
export type PermissionKind = 'tool' | 'question' | 'plan';

/** One question of AskUserQuestion (1–4 per card): 2–4 options; «Другое» (own text) is always possible. */
export interface QuestionView {
  question: string;
  /** Short chip, up to 12 characters («Библиотека»). */
  header: string;
  options: Array<{ label: string; description: string; preview?: string }>;
  multiSelect: boolean;
}

export interface PermissionView {
  requestId: string;
  sessionId: string;
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  createdAt: string;
  resolvedAt: string | null;
  decision: PermissionDecision | null;
  /**
   * Why it was denied without the user (e.g. «уснула, не дождавшись разрешения»); for a question — «Пользователь
   * отказался отвечать»; for a plan sent back — the user's comment.
   */
  message: string | null;
  /** M4b. `question`: show `questions` with options and answer them; `plan`: show `plan` (markdown). */
  kind: PermissionKind;
  /** kind = question. */
  questions?: QuestionView[];
  /** kind = plan: the plan in markdown. */
  plan?: string;
  /** kind = question, answered: question text → the answer as the model got it (a multi-select joined with ", "). */
  answers?: Record<string, string> | null;
}

/** One item of `GET /api/sessions/:id/events` and `session.events`, oldest first. */
/** `$blob` reference in an event (D4); images carry width/height, texts a preview. */
export interface BlobRef {
  $blob: string;
  size: number;
  mime: string;
  preview?: string;
  width?: number;
  height?: number;
}

/** Large tool output kept by Claude Code in tool-results/ (D4): the hub's copy, served as text/plain. */
export interface SideFileRef {
  name: string;
  /** `GET /api/sessions/:id/tool-results/:name?sid=` */
  url: string;
}

export type HubEvent =
  /** `sideFiles`: the line has `<persisted-output>` («Output too large… saved to …/tool-results/<name>»). */
  | { kind: 'line'; id: string; ts: string; line: TranscriptLine; sideFiles?: SideFileRef[] }
  /**
   * A hub note. With `image`: a file of the machine shown on request («Показать изображение», D19), stored in the hub,
   * so it opens later without the machine; `text` then is «Изображение: <path>» for clients that do not render it.
   */
  | {
      kind: 'note';
      id: string;
      ts: string;
      /** English; `i18n` is the same text as a key for the client's language (older notes have none and read as stored). */
      text: string;
      i18n?: I18nText;
      image?: { path: string; blob: BlobRef };
      /** «Сообщение не доставлено»: the message as sent, for «Повторить» (text and images back into the composer). */
      undelivered?: { text: string; attachments: Array<{ sha256: string; mime: string; size: number; width?: number; height?: number }>; clientUuid: string };
      /** claude-subscriptions (P6/P8): a limit, a rejected token or a switch; `text` stays readable for older clients. */
      subscription?: SubscriptionNote;
    }
  | { kind: 'permission'; id: string; ts: string; request: PermissionView };

export interface EventsPage {
  events: HubEvent[];
  /** Cursor for the previous (older) page, null at the beginning. */
  before: string | null;
}

// ---------- window workspace (M2.1, D10/D11) ----------

/** Tabs per window: the strip scrolls and evicts nothing (tab-strip-scroll), this only guards the hub against junk bodies. */
export const MAX_TABS = 200;
/** Panes per window. */
export const MAX_PANES = 4;
/** PUT /api/layout body limit. */
export const LAYOUT_BODY_LIMIT = 64 * 1024;

// ---------- subagents (change `subagents`, design S7) ----------

/** A registry row of a session: a subagent, a teammate or a skill run in the background. */
export interface SubagentView {
  id: string;
  sessionId: string;
  /** Without the `agent-` prefix; null — a call whose agent is not known yet. */
  agentId: string | null;
  toolUseId: string | null;
  /** agentId of the subagent that called it; null — called by the session. */
  parentAgentId: string | null;
  /** id of the parent subagent's row, when that row is in the registry. */
  parentId: string | null;
  kind: 'subagent' | 'teammate' | 'skill';
  description: string | null;
  agentType: string | null;
  name: string | null;
  model: string | null;
  background: boolean;
  /** The stored state with the session's liveness applied (effectiveStatus). */
  status: SubagentStatus;
  startedAt: string | null;
  lastEventAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  totalTokens: number | null;
  toolUses: number | null;
  /** Lines of its transcript (an estimate for the UI). */
  eventCount: number;
  hasTranscript: boolean;
  session: { id: string; title: string };
}

/** GET /api/sessions/:id/subagents — by started_at; the tree is built by the client from parentId. */
export interface SubagentsResponse {
  subagents: SubagentView[];
  /** Change `background-tasks`: monitors and background commands, the latest 200 by start. */
  background?: BackgroundTaskView[];
  /** hub-subagents D7: child hub sessions (session_spawn) by creation. */
  hubSessions?: HubSubagentView[];
}

/** A child hub session in the «Субагенты» panel of its parent (hub-subagents D7). */
export interface HubSubagentView {
  id: string;
  title: string;
  provider: Provider;
  runnerId: string;
  machine: string;
  status: SessionStatus;
  processAlive: boolean;
  createdAt: string;
}

// ---------- background tasks (change `background-tasks`, design D6) ----------

/**
 * Shown status of a monitor or a background command: `expired` — a monitor past its timeout; `interrupted` — still
 * running by the transcript, but the session is not alive or the task belongs to an earlier process of it.
 */
export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'expired' | 'interrupted';

export interface BackgroundTaskView {
  /** tool_use_id of the call. */
  id: string;
  sessionId: string;
  kind: 'bash' | 'monitor';
  description: string | null;
  command: string | null;
  taskId: string | null;
  status: BackgroundTaskStatus;
  startedAt: string | null;
  endedAt: string | null;
  /** A monitor with a timeout (not persistent): when it expires. */
  expiresAt: string | null;
  /** The last event of a monitor (≤500 characters) and its time. */
  lastEvent: string | null;
  lastEventAt: string | null;
}

export type Device = 'desktop' | 'phone';

/**
 * GET /api/layout?device= — the last changed window workspace of this device class, the template of a new window.
 * All fields are null when nothing was saved yet. `layout` is `{layout, panes, focus, seq}` of
 * web/src/features/layout/layout.ts, `savedLayout` the «Одно окно» snapshot, `openedAt` `{<sessionId>: ISO}`.
 */
export interface LayoutResponse<L = unknown> {
  layout: L | null;
  savedLayout: L | null;
  openedAt: Record<string, string> | null;
  /** Change `subagents`: kinds of tabs that are not sessions, as the window saved them. */
  tabKinds?: Record<string, string> | null;
  updatedAt: string | null;
}

/** PUT /api/layout → 200. Last write wins, no broadcast. */
export interface PutLayoutResponse {
  /** `updatedAt` of the stored template (unchanged when the body was not applied). */
  updatedAt: string;
  /** false — the stored template carries a newer `clientTs`, this body was older and is dropped. */
  applied: boolean;
}

// ---------- request bodies (validated by the hub) ----------

const uuid = z.guid();
/** An absolute local path on the runner (no UNC/device paths): see paths.ts. */
export const localPathSchema = z.string().min(1).max(4096).refine(isAbsoluteLocalPath, LOCAL_PATH_MESSAGE);
const uiMode = z.enum(UI_PERMISSION_MODES);
const device = z.enum(['desktop', 'phone']);

// The kind of path (local, matching the runner's OS) is checked by the hub against the runner and answered with
// 422 bad_path (D10 «Пути по ОС раннера»); the body schema checks only the form.
const pathField = z.string().min(1).max(4096);

/** Images attached to a message (D19): sha256 of the user's earlier POST /api/uploads, ≤10, in order. */
export const MAX_ATTACHMENTS = 10;
const attachmentRefs = z
  .array(z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/) }))
  .max(MAX_ATTACHMENTS)
  .optional();
/** Text may be empty only when images are attached. */
const textOrImages = (b: { attachments?: unknown[] | undefined }, text: string) => text.trim().length > 0 || (b.attachments?.length ?? 0) > 0;
/** subscriptionId of a launch: a subscription id, null — the machine login, absent — the default subscription. */
const subscriptionIdField = z.guid().nullable().optional();

export const createSessionRequestSchema = z
  .object({
    runnerId: z.string().min(1),
    permissionMode: uiMode.default('bypassPermissions'),
    model: z.string().min(1).max(200),
    prompt: z.string().max(200_000),
    attachments: attachmentRefs,
    /** claude-subscriptions: absent — the default subscription (last choice); null — the machine login. */
    subscriptionId: subscriptionIdField,
    /** agent-providers: absent — claude. provider-parity: subscriptionId is a subscription of this provider. */
    provider: providerSchema.optional(),
    /** projects-catalog 1.12: explicit user-owned catalog project; session-folder D3 — the hub starts the session in its folder. */
    projectId: z.guid().optional(),
  })
  .refine(b => textOrImages(b, b.prompt), { message: 'prompt or attachments required', path: ['prompt'] });
export type CreateSessionRequest = z.input<typeof createSessionRequestSchema>;

// ---------- fork (D14, M4b) ----------

/**
 * POST /api/sessions/:id/fork. `copy` — a full copy on the same machine (201 SessionView; 409 runner_offline |
 * agent_outdated | copy_unavailable with `reason`). `handoff` — a new session on the chosen runner with the (edited)
 * handoff prompt as its first message, in the folder of the source's project on that runner or its default folder
 * (session-folder D3; 201 SessionView; 422 cwd_not_found; 409 runner_offline | agent_outdated); permission mode and
 * model default to the source's.
 */
export const forkRequestSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('copy') }),
  z.object({
    mode: z.literal('handoff'),
    prompt: z.string().min(1).max(200_000),
    runnerId: z.string().min(1),
    draftId: z.guid().optional(),
    permissionMode: uiMode.optional(),
    model: z.string().min(1).max(200).optional(),
    /** claude-subscriptions: as in createSessionRequestSchema. */
    subscriptionId: subscriptionIdField,
    /** agent-providers: the provider of the new session; absent — claude. */
    provider: providerSchema.optional(),
  }),
]);
export type ForkRequest = z.input<typeof forkRequestSchema>;

/** Why a full copy is not possible (409 copy_unavailable): the form shows «Недоступно: …» and opens in «Handoff». */
export type CopyUnavailableReason = 'cron' | 'cwd_missing' | 'unknown_runner';

/**
 * Body of POST /api/sessions/:id/handoff-drafts (claude-subscriptions QA B1): the subscription chosen in the handoff
 * form generates the prompt; absent — the default one unless it has a limit or a rejected token (then the first usable
 * active one); null — the machine login.
 */
export const handoffDraftRequestSchema = z.object({ subscriptionId: subscriptionIdField }).default({});
export type HandoffDraftRequest = z.input<typeof handoffDraftRequestSchema>;

/**
 * A handoff draft: POST /api/sessions/:id/handoff-drafts → 202 this (status pending); GET /api/handoff-drafts/:id; WS
 * `handoff.draft` when it is ready or failed. `error` — the text for the form in English, `errorI18n` — the same as a key («Повторить» creates a new draft).
 */
export interface HandoffDraftView {
  id: string;
  sessionId: string;
  status: 'pending' | 'ready' | 'error';
  text: string | null;
  error: string | null;
  errorI18n?: I18nText;
  createdAt: string;
  finishedAt: string | null;
}

export const sendMessageRequestSchema = z
  .object({
    text: z.string().max(200_000),
    clientUuid: uuid,
    force: z.boolean().optional(),
    attachments: attachmentRefs,
  })
  .refine(b => textOrImages(b, b.text), { message: 'text or attachments required', path: ['text'] });

/** POST /api/uploads → 201/200: the image is stored (content-addressed, D19). */
export interface UploadResponse {
  sha256: string;
  mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  size: number;
  width: number;
  height: number;
}
/** Body limit of POST /api/uploads (raw bytes). */
export const UPLOAD_LIMIT = 4 * 1024 * 1024;

// ---------- voice input (change voice-input, D2, D4) ----------

/** POST /api/voice/transcribe → 200: recognised text, trimmed (may be empty). */
export interface TranscribeResponse {
  text: string;
}
/** Error codes of POST /api/voice/transcribe (design D2). */
export const VOICE_ERROR_CODES = [
  'empty_audio',
  'unsupported_audio',
  'too_large',
  'voice_quota_exceeded',
  'voice_busy',
  'voice_key_rejected',
  'voice_upstream_error',
  'voice_disabled',
  'voice_timeout',
] as const;
export type VoiceErrorCode = (typeof VOICE_ERROR_CODES)[number];
/** 402 voice_quota_exceeded: `resetAt` (ISO 8601) — when the ElevenLabs quota renews, absent when unknown. */
export interface VoiceQuotaError extends ApiError {
  resetAt?: string;
}
/** Body limit of POST /api/voice/transcribe (raw bytes): 12 MiB. */
export const VOICE_UPLOAD_LIMIT = 12 * 1024 * 1024;
/** Longest recording, ms (5 minutes). */
export const VOICE_MAX_DURATION_MS = 300_000;
/** The timer switches to a countdown this long before the limit, ms. */
export const VOICE_COUNTDOWN_MS = 30_000;
/** Accepted Content-Type of a recording (parameters such as `;codecs=opus` are allowed). */
export const VOICE_AUDIO_TYPES = ['audio/webm', 'audio/mp4', 'audio/ogg'] as const;
export type VoiceAudioType = (typeof VOICE_AUDIO_TYPES)[number];

/** GET /api/voice/talk?session=<id> (change voice-conversation, D1): the ElevenLabs conversation link and the hub's token. */
export interface VoiceTalkResponse {
  /** `wss://…` of the ElevenLabs agent, valid 15 minutes. */
  signedUrl: string;
  /** Conversation token: the page passes it in `custom_llm_extra_body.hub_token`. */
  token: string;
}
export const voiceTalkQuerySchema = z.object({ session: z.uuid() });
/** Error codes of the conversation routes; ElevenLabs failures reuse `voice_upstream_error`. */
export const VOICE_TALK_ERROR_CODES = ['voice_talk_disabled', 'voice_talk_token'] as const;
export type VoiceTalkErrorCode = (typeof VOICE_TALK_ERROR_CODES)[number];

/** POST /api/sessions/:id/images — «Показать изображение» for a local path in an answer (D19). */
export const showImageRequestSchema = z.object({ path: pathField });
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;

/** GET /api/runners/:id/stat?path= */
export const statQuerySchema = z.object({ path: pathField });

export const wakeRequestSchema = z.object({ force: z.boolean().optional() });

export const patchSessionRequestSchema = z
  .object({
    /** Manual rename (spec session-title): the title becomes `custom` and is no longer replaced by the transcript. */
    title: z.string().trim().min(1).max(200).optional(),
    permissionMode: uiMode.optional(),
    model: z.string().min(1).max(200).optional(),
    idleTimeoutMin: z
      .number()
      .int()
      .refine(n => (IDLE_TIMEOUT_CHOICES as readonly number[]).includes(n), 'one of 15, 30, 60, 120, 480, 0')
      .nullable()
      .optional(),
  })
  .refine(b => Object.keys(b).length > 0, 'nothing to change');
export type PatchSessionRequest = z.infer<typeof patchSessionRequestSchema>;

/**
 * POST /api/sessions/:id/permissions/:requestId. A tool: allow | allow_session | deny. A question (M4b): `allow` with
 * `answers` (every question: a label, labels of a multi-select, or own text) — «Ответить»; `deny` — «Отказаться
 * отвечать». A plan: `allow` — «Утвердить»; `deny` with `message` — «Продолжить планирование» with the user's comment.
 * `allow_session` is only for tools (422 otherwise); a question without an answer for each question is 422 bad_answers.
 */
export const permissionDecisionRequestSchema = z.object({
  decision: z.enum(['allow', 'allow_session', 'deny']),
  answers: z.record(z.string().max(2000), z.union([z.string().min(1).max(10_000), z.array(z.string().min(1).max(2000)).min(1).max(4)])).optional(),
  message: z.string().max(10_000).optional(),
});

/** Tree of panes: `{type:'leaf', pane}` | `{type:'split', dir, ratio, a, b}`. */
type LayoutNodeShape = { type: 'leaf'; pane: string } | { type: 'split'; dir: 'row' | 'col'; ratio: number; a: LayoutNodeShape; b: LayoutNodeShape };

/** Leaves of a pane tree, or null when it is not a tree of the expected form (depth is bounded by MAX_PANES). */
function treeLeaves(n: unknown, depth = 0): string[] | null {
  if (depth > MAX_PANES || !n || typeof n !== 'object') return null;
  const node = n as Record<string, unknown>;
  if (node.type === 'leaf') return typeof node.pane === 'string' && node.pane.length > 0 && node.pane.length <= 64 ? [node.pane] : null;
  if (node.type !== 'split' || (node.dir !== 'row' && node.dir !== 'col') || typeof node.ratio !== 'number' || !(node.ratio > 0 && node.ratio < 1)) return null;
  const a = treeLeaves(node.a, depth + 1);
  const b = treeLeaves(node.b, depth + 1);
  return a && b ? [...a, ...b] : null;
}

const paneSchema = z.object({ id: z.string().min(1).max(64), tabs: z.array(uuid).max(MAX_TABS), active: uuid.nullable() });

/** Snapshot `{layout, panes, focus}` (the «Одно окно» copy) — the shape the hub accepts. */
const snapshotFields = {
  layout: z.custom<LayoutNodeShape>(v => treeLeaves(v) !== null, 'layout: pane tree expected'),
  panes: z.record(z.string().max(64), paneSchema),
  focus: z.string().min(1).max(64),
};

/**
 * Limits and consistency of a snapshot: ≤4 panes, ≤`MAX_TABS` distinct tabs; the leaves of the tree are exactly the keys of
 * `panes` (no duplicates), `focus` is one of the panes, each pane's `id` is its key and its `active` tab is one of its
 * tabs (or null). A window never builds anything else, so a broken body is refused instead of stored as a template.
 */
function checkSnapshot(v: { layout: LayoutNodeShape; panes: Record<string, { id: string; tabs: string[]; active: string | null }>; focus: string }, ctx: z.RefinementCtx): void {
  const leaves = treeLeaves(v.layout) ?? [];
  const keys = Object.keys(v.panes);
  if (leaves.length > MAX_PANES) ctx.addIssue({ code: 'custom', message: `at most ${MAX_PANES} panes` });
  if (keys.length > MAX_PANES) ctx.addIssue({ code: 'custom', message: `at most ${MAX_PANES} panes` });
  const tabs = new Set(Object.values(v.panes).flatMap(p => p.tabs));
  if (tabs.size > MAX_TABS) ctx.addIssue({ code: 'custom', message: `at most ${MAX_TABS} tabs` });
  if (new Set(leaves).size !== leaves.length || leaves.length !== keys.length || leaves.some(l => !v.panes[l])) {
    ctx.addIssue({ code: 'custom', message: 'layout leaves must match the keys of panes' });
  }
  if (!v.panes[v.focus]) ctx.addIssue({ code: 'custom', message: 'focus must be one of the panes' });
  for (const [key, p] of Object.entries(v.panes)) {
    if (p.id !== key) ctx.addIssue({ code: 'custom', message: `pane ${key}: id must equal its key` });
    if (p.active !== null && !p.tabs.includes(p.active)) ctx.addIssue({ code: 'custom', message: `pane ${key}: active must be one of its tabs` });
  }
}

export const layoutSnapshotSchema = z.object(snapshotFields).superRefine(checkSnapshot);
export const workspaceLayoutSchema = z.object({ ...snapshotFields, seq: z.number().int().nonnegative() }).superRefine(checkSnapshot);

/** PUT /api/layout. `version` from M2 clients is accepted and ignored (cached PWA before the update). */
export const putLayoutRequestSchema = z.object({
  device,
  layout: workspaceLayoutSchema.nullable(),
  savedLayout: layoutSnapshotSchema.nullable(),
  openedAt: z
    .record(uuid, z.iso.datetime({ offset: true }))
    .refine(o => Object.keys(o).length <= 64, 'at most 64 entries')
    .nullable()
    .optional(),
  /** Change `subagents`: the kind of a tab that is not a session (`{<id>: 'subagent'}`); stored as it is. */
  tabKinds: z
    .record(z.string().max(64), z.string().max(32))
    .refine(o => Object.keys(o).length <= 64, 'at most 64 entries')
    .nullable()
    .optional(),
  /**
   * Time (ms, the window's clock) of the change this snapshot carries. The hub keeps the stored template when its
   * `clientTs` is newer — a late keepalive PUT of an older change does not overwrite a later one. Absent → applied.
   */
  clientTs: z.number().int().nonnegative().nullable().optional(),
  version: z.unknown().optional(),
});
export type PutLayoutRequest = z.infer<typeof putLayoutRequestSchema>;

// ---------- /ws/ui ----------

/** Since M2.1 no server message changes a window's tabs or layout (eviction is shown by the window itself). */
/** project_auto: «Проект определён: <сессия> → <проект>»; project_pinned: «Проект закреплён». */
export type ToastKind = 'project_auto' | 'project_pinned' | 'runner_back' | 'mode_changed';

/**
 * Close codes of /ws/ui. 4401 — the browser session ended (logout, expiry, «Выйти на всех устройствах»): open the
 * login. 4403 — the administrator disabled the user: go to `/auth/disabled` («Доступ отключён»).
 */
export const UiCloseCode = { SessionEnded: 4401, AccountDisabled: 4403 } as const;

/**
 * Change `multi-user` M4: progress of «Подключить машину», sent to every window of the owner.
 * `waiting` — code issued, no exchange yet; `code_used` — the installer exchanged the code; `connected` — the agent
 * sent hello; `claude_checked` — hello.claude is known (`runner.claudeLogin`); `ready` — done (right after
 * claude_checked; for agents before 1.4 right after connected). The same stage is in `GET /api/runners/:id`
 * (`enroll.stage`) for a window opened later.
 */
export type EnrollStage = 'waiting' | 'code_used' | 'connected' | 'claude_checked' | 'ready';

export type UiServerMessage =
  | { type: 'runner.status'; runner: RunnerView }
  | { type: 'pong' }
  /** To every client of the user: a sidebar/tab row changed. */
  | {
      type: 'session.upsert';
      session: SessionView;
      /** Desktop app (D7): the session is the active tab of a visible window of any client of the user at send time. */
      activeVisible?: boolean;
    }
  /** To clients subscribed to the session: new chat items (appended, oldest first). */
  | { type: 'session.events'; sessionId: string; events: HubEvent[] }
  /** To subscribed clients: streaming text of the current assistant message; not stored. */
  | { type: 'session.partial'; sessionId: string; messageId: string; blockIndex: number; textDelta: string }
  | { type: 'permission.request'; sessionId: string; request: PermissionView }
  | { type: 'permission.resolved'; sessionId: string; requestId: string; decision: PermissionDecision }
  | { type: 'toast'; kind: ToastKind; sessionId?: string; title?: string; text?: string; i18n?: I18nText }
  /** The catalogue changed and many sessions moved (M4a): reload the sidebar, «Перенести в…» and open tabs. */
  | { type: 'projects.changed' }
  /** A handoff draft is ready or failed (M4b). */
  | { type: 'handoff.draft'; draft: HandoffDraftView }
  /** To the windows subscribed to the parent session: a registry row changed (change `subagents`). */
  | { type: 'subagent.upsert'; sessionId: string; subagent: SubagentView }
  /** To the windows subscribed to the subagent: new items of its transcript (oldest first). */
  | { type: 'subagent.events'; subagentId: string; events: HubEvent[] }
  /** Change `multi-user`: a stage of connecting a machine (see EnrollStage). */
  | { type: 'runner.enroll'; runnerId: string; stage: EnrollStage; runner: RunnerView }
  /** claude-subscriptions: the registry or the last choice changed — reload GET /api/subscriptions. No token inside. Sent to the owner only. */
  | { type: 'subscriptions.changed' }
  /** subscription-limits: a snapshot of the user's limits changed — reload GET /api/subscriptions/limits. No data inside, owner only. */
  | { type: 'subscription_limits.changed' }
  /** mcp-management (M8): the MCP view of a session changed (snapshot, pendingAction, an action's error). Owner only. */
  | { type: 'session.mcp'; sessionId: string; mcp: McpSessionView }
  /**
   * mcp-management (M8): a sign-in attempt of a session's server. `flow` — the attempt to show (null: it ended);
   * `result` — how it ended (`ok`, `failed` with `error`, `expired`, `process_exited`). Owner only.
   */
  | { type: 'mcp.auth'; sessionId: string; server: string; flow: McpAuthFlowView | null; result?: McpAuthResult; error?: string; errorI18n?: I18nText }
  /** mcp-management (M8): the MCP block of a machine changed (a probe ended, a session snapshot with user servers). Owner only. */
  | { type: 'runner.mcp'; runnerId: string; mcp: McpMachineView }
  /** agent-providers: a device-code sign-in of a machine's provider ended. Owner only. */
  | { type: 'provider.login'; runnerId: string; provider: Provider; loginId: string; ok: boolean; error?: string; errorI18n?: I18nText; subscriptionId?: string };

export const uiClientMessageSchema = z.discriminatedUnion('type', [
  // subagentIds (change `subagents`): chats of subagents open in this window; the hub checks the owner
  z.object({ type: z.literal('subscribe'), sessionIds: z.array(z.string()).max(64), subagentIds: z.array(z.string()).max(64).optional() }),
  // hiddenForMs (change push-voice-fixes): how long the tab is already hidden when the hidden presence goes out (a late visibilitychange)
  z.object({ type: z.literal('presence'), visible: z.boolean(), activeSessionIds: z.array(z.string()).max(64), hiddenForMs: z.number().int().min(0).max(600_000).optional() }),
  z.object({ type: z.literal('ping') }),
]);
export type UiClientMessage = z.infer<typeof uiClientMessageSchema>;

// ---------- search (Ctrl+K, task 3.9) ----------

/** What matched: the title, the project (until M4 — the session directory), or the text of a message. */
export type SearchMatch = 'title' | 'project' | 'text';
/** A fragment of the best matching message: plain text and [start, end) UTF-16 offsets of the found words. */
export interface SearchSnippet {
  text: string;
  highlights: Array<[number, number]>;
}
export interface SearchResult {
  session: SessionView;
  snippet: SearchSnippet | null;
  match: SearchMatch;
}
/** GET /api/search?q=&limit=12&cron=0|1 — an empty q gives the most recent sessions. */
export interface SearchResponse {
  results: SearchResult[];
}
export const searchQuerySchema = z.object({
  q: z.string().max(500).default(''),
  limit: z.coerce.number().int().min(1).max(50).default(12),
  cron: z.enum(['0', '1']).optional(),
});

// ---------- multi-user (change `multi-user`: users, runner-enrollment, public-access) ----------

/**
 * Error codes of the multi-user API (body `{error, message?}`):
 * - `unauthenticated` 401 — no browser session (also a disabled user: his sessions are deleted);
 * - `forbidden` 403 — the route needs role `admin`;
 * - `forbidden_origin` 403 — a mutating request without the hub's Origin;
 * - `user_exists` 409 POST /api/admin/invites — an active user with this address («Пользователь уже есть»);
 * - `cannot_disable_self` 400 POST /api/admin/users/:id/disable;
 * - `not_found` 404 — invite, user or runner not found (another user's runner too);
 * - `invite_used` 409 DELETE /api/admin/invites/:id;
 * - `name_taken` 409 POST/PATCH /api/runners — the user already has a machine with this name;
 * - `runner_disabled` 409 POST /api/runners/:id/enroll-code on a disabled runner;
 * - `code_used` | `code_expired` | `code_invalid` 410 POST /enroll;
 * - `too_many_requests` 429 — rate limit (login start, enroll, invite page).
 */
export type MultiUserErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'forbidden_origin'
  | 'user_exists'
  | 'cannot_disable_self'
  | 'not_found'
  | 'invite_used'
  | 'name_taken'
  | 'runner_disabled'
  | 'code_used'
  | 'code_expired'
  | 'code_invalid'
  | 'too_many_requests';

export const MACHINE_OS = ['linux', 'macos', 'windows'] as const;
export type MachineOs = (typeof MACHINE_OS)[number];

/** Lifetimes (design M2, M4; spec public-access). */
export const INVITE_TTL_MS = 7 * 24 * 3600_000;
export const ENROLL_CODE_TTL_MS = 15 * 60_000;
export const SECURITY_LOG_DAYS = 90;

// --- invites (admin) ---

export type InviteStatus = 'active' | 'used' | 'expired' | 'revoked';

export interface InviteView {
  id: string;
  email: string;
  /** keycloak-auth D6: null — an invite of the single provider, bound to the address only. */
  provider: LoginProvider | null;
  status: InviteStatus;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
}

/** POST /api/admin/invites → 201 CreateInviteResponse; 409 user_exists. An earlier active invite of the address is revoked. */
export const createInviteRequestSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(320)),
  /** Two-provider mode: required; single-provider mode: ignored. */
  provider: z.enum(['google', 'keycloak']).optional(),
});
export type CreateInviteRequest = z.input<typeof createInviteRequestSchema>;

export interface CreateInviteResponse {
  invite: InviteView;
  /** `<PUBLIC_URL>/invite/<code>` — shown once, «Скопировать». */
  url: string;
}

/** GET /api/admin/invites — newest first. DELETE /api/admin/invites/:id → 204 (404 not_found, 409 invite_used). */
export interface InvitesResponse {
  invites: InviteView[];
}

// --- users (admin) ---

/** One user for the administrator: no machine names, sessions or projects (requirement «Администратор не видит чужие сессии»). */
export interface AdminUserView {
  id: string;
  email: string;
  name: string | null;
  provider: LoginProvider;
  /** keycloak-auth: «Регистрация», «Приглашение» or «До перехода». */
  source: UserSource;
  role: UserRole;
  status: 'active' | 'disabled';
  /** When the invite that created the user was issued; null — bootstrap administrator. */
  invitedAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  /** Machines that are not disabled; `online` — of them in the network now. */
  machines: { total: number; online: number };
}

/** GET /api/admin/users. POST /api/admin/users/:id/disable | /enable → 200 AdminUserView (400 cannot_disable_self, 404). */
export interface AdminUsersResponse {
  users: AdminUserView[];
}

// --- machines (runner-enrollment) ---

/** POST /api/runners → 201 EnrollCodeResponse (409 name_taken). Without a name: the hub's default name (`machines.enroll.defaultName` in the request language), then «… 2», … */
export const createRunnerRequestSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  os: z.enum(MACHINE_OS),
});
export type CreateRunnerRequest = z.input<typeof createRunnerRequestSchema>;

/**
 * PATCH /api/runners/:id → 200 RunnerDetail (409 name_taken, 404). `defaultDir` — the machine's default folder (session-folder):
 * the machine must be online (409 runner_offline), the path of its OS (400 invalid_path) and an existing folder (422 cwd_not_found).
 */
export const patchRunnerRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(64).optional(),
    defaultDir: localPathSchema.optional(),
  })
  .refine(b => b.name !== undefined || b.defaultDir !== undefined, 'name or defaultDir is required');
export type PatchRunnerRequest = z.input<typeof patchRunnerRequestSchema>;

/**
 * POST /api/runners/:id/enroll-code (body `{}`) → 200 EnrollCodeResponse: «Новый код» and «Переподключить». The previous
 * unused code is revoked; the current token keeps working until the agent connects with the new one.
 */
export interface EnrollCodeResponse {
  runner: RunnerView;
  /** 26 characters base32 (130 bits); shown once. */
  code: string;
  expiresAt: string;
  /**
   * Ready commands with the code: unix — `curl -fsSL <PUBLIC_URL>/install.sh | bash -s -- <code>`,
   * windows — `irm <PUBLIC_URL>/install.ps1 | iex; Install-AgentHub <code>`.
   */
  commands: { unix: string; windows: string };
}

/** GET /api/runners/:id → 200 RunnerDetail (404 for another user's runner). POST /api/runners/:id/disable → 200 RunnerDetail. */
export interface RunnerDetail extends RunnerView {
  hostname: string | null;
  createdAt: string;
  /** The latest enrollment code of the runner; null when it never had one (machines of the CLI era). */
  enroll: { stage: EnrollStage; codeExpiresAt: string | null } | null;
  /** Removes the agent from the machine (shown after «Отключить»). */
  uninstallCommand: { unix: string; windows: string };
}

/** GET /api/runners → 200: every machine of the user, disabled ones too («Настройки → Машины»). */
export interface RunnersResponse {
  runners: RunnerView[];
  /** Version of the agent build the hub serves (null — no build). */
  agentVersion: string | null;
}

/**
 * POST /enroll (no cookie, no Origin: the installer). 200 EnrollResponse; 400 invalid_request; 410 code_used |
 * code_expired | code_invalid; 429 too_many_requests (more than 10 bad codes a minute from the address).
 */
export const enrollRequestSchema = z.object({
  code: z.string().regex(/^[A-Za-z2-7]{26}$/),
  hostname: z.string().min(1).max(253),
  os: z.enum(MACHINE_OS),
  arch: z.string().min(1).max(32),
});
export type EnrollRequest = z.infer<typeof enrollRequestSchema>;

export interface EnrollResponse {
  runnerId: string;
  /** The permanent runner token: goes to ~/.agent-hub/agent.env (mode 600), never printed. */
  token: string;
  /** wss://<host>/ws/agent */
  hubUrl: string;
  /** The agent build: GET agentUrl (relative to the hub), compare sha256. null — the hub serves no build. */
  agentVersion: string | null;
  agentUrl: string | null;
  agentSha256: string | null;
}

/** GET /agent/latest.json (no login); 404 when the hub serves no agent build. */
export interface AgentLatest {
  version: string;
  sha256: string;
  /** `/agent/agent-<version>.tgz` */
  url: string;
  size: number;
}

// --- security log (public-access) ---

export type SecurityEventKind = 'login' | 'login_denied' | 'signup' | 'logout_all' | 'runner_connected' | 'runner_disconnected' | 'enroll_code_issued' | 'enroll_code_used';

export interface SecurityEventView {
  id: string;
  kind: SecurityEventKind;
  at: string;
  ip: string | null;
  userAgent: string | null;
  /** login: the provider. */
  provider: LoginProvider | null;
  /** runner_* and enroll_*: the machine (its current name). */
  runner: { id: string; name: string } | null;
}

export interface AuthSessionView {
  /** First 16 hex characters of the session hash: a handle, not the secret. */
  id: string;
  createdAt: string;
  expiresAt: string;
  userAgent: string | null;
  /** The session of this request. */
  current: boolean;
}

/** GET /api/security → 200: events of the last 90 days, newest first (≤ 500), and the active browser sessions. */
export interface SecurityResponse {
  events: SecurityEventView[];
  sessions: AuthSessionView[];
}

/** POST /api/auth/logout-all → 200: every other browser session of the user is deleted, its sockets closed with 4401. */
/** POST /auth/logout → 200 (keycloak-auth D7): where the browser goes next — the provider logout or `/`. */
export interface LogoutResponse {
  redirect: string;
}

export interface LogoutAllResponse {
  ended: number;
}

// ---------- subscriptions (change claude-subscriptions, design P8) ----------

/** The subscription of a session process as shown in the tab head. */
export interface SessionSubscriptionRef {
  id: string;
  name: string;
}

/**
 * `none` — the registry is empty (no field in forms, no switch in the head); `subscription` — the next process runs
 * under a subscription; `machine_login` — the session ran under the machine login while the registry is not empty;
 * `agent_outdated` — the machine's agent is older than 1.4 and runs under the machine login.
 */
export const SUBSCRIPTION_MODES = ['none', 'subscription', 'machine_login', 'agent_outdated'] as const;
export type SubscriptionMode = (typeof SUBSCRIPTION_MODES)[number];

/** A chat note about a subscription (HubEvent note `subscription`). Times are ISO. */
export interface SubscriptionNote {
  kind: 'limit' | 'auth' | 'switch';
  subscriptionId: string;
  /** limit: when it resets, if the SDK told. */
  resetsAt?: string;
  /** limit: active subscriptions without a limit and without a rejected token, for «Продолжить под другой подпиской». */
  alternatives?: string[];
}

// Requirement: Реестр подписок; Requirement: Хранение токена подписки — the token never leaves the hub, only `tokenHint`.
export interface SubscriptionView {
  id: string;
  name: string;
  position: number;
  autoSwitch: boolean;
  retired: boolean;
  /** The last 4 characters of the token. */
  tokenHint: string;
  tokenUpdatedAt: string;
  /** ISO; set while a limit is known and not yet reset. */
  limitResetsAt: string | null;
  /** rate_limit_info.rateLimitType (five_hour, seven_day, …) of the last limit. */
  limitKind: string | null;
  tokenRejected: boolean;
  /** provider-parity: whose subscription it is (Claude token or Codex ChatGPT sign-in). */
  provider: Provider;
}

/** GET /api/subscriptions; PUT /api/subscriptions/order. */
export interface SubscriptionsResponse {
  /** SUBSCRIPTION_TOKEN_KEY is set: adding and replacing tokens is possible (else 503 subscriptions_disabled). */
  enabled: boolean;
  /** Active ones first by position, then retired ones. */
  subscriptions: SubscriptionView[];
  lastChoiceId: string | null;
  /** lastChoiceId if it is active, else the first active one; null with no active subscription. */
  defaultId: string | null;
  /** provider-parity: the same two values per provider (lastChoiceId/defaultId stay those of Claude). */
  byProvider: Record<Provider, { lastChoiceId: string | null; defaultId: string | null }>;
  /** Show the hint that claude.ai connectors may be unavailable under a subscription (design P11). */
  connectorsHint: boolean;
}

/** Name of a subscription: 1–60 characters after trimming, unique among the user's active ones (409 name_taken). */
export const SUBSCRIPTION_NAME_MAX = 60;
const subscriptionName = z.string().trim().min(1).max(SUBSCRIPTION_NAME_MAX);

/** POST /api/subscriptions → 201 SubscriptionView; 409 name_taken, 422 bad_token, 503 subscriptions_disabled. */
export const createSubscriptionRequestSchema = z.object({
  name: subscriptionName,
  token: subscriptionTokenSchema,
  autoSwitch: z.boolean().optional(),
});
export type CreateSubscriptionRequest = z.infer<typeof createSubscriptionRequestSchema>;

/**
 * POST /api/subscriptions/codex-login → 200 ProviderLoginStartView (device code; the end comes as WS provider.login with
 * the subscription id). Without `subscriptionId` a new subscription `name` is created on success; with it the sign-in
 * of that Codex subscription is replaced. 409 name_taken | runner_offline | agent_outdated; 503 subscriptions_disabled.
 */
export const codexLoginRequestSchema = z
  .object({ runnerId: z.string().min(1), name: subscriptionName.optional(), subscriptionId: z.guid().optional() })
  .refine(b => (b.name !== undefined) !== (b.subscriptionId !== undefined), 'name or subscriptionId');
export type CodexLoginRequest = z.infer<typeof codexLoginRequestSchema>;

/** PATCH /api/subscriptions/:id → SubscriptionView; 404, 409 name_taken. `retired: false` brings it back. */
export const patchSubscriptionRequestSchema = z
  .object({
    name: subscriptionName.optional(),
    autoSwitch: z.boolean().optional(),
    retired: z.boolean().optional(),
  })
  .refine(b => Object.keys(b).length > 0, 'nothing to change');
export type PatchSubscriptionRequest = z.infer<typeof patchSubscriptionRequestSchema>;

/** PUT /api/subscriptions/:id/token → SubscriptionView (clears «токен отклонён»); 404, 422, 503. */
export const putSubscriptionTokenRequestSchema = z.object({ token: subscriptionTokenSchema });
export type PutSubscriptionTokenRequest = z.infer<typeof putSubscriptionTokenRequestSchema>;

/** PUT /api/subscriptions/order → SubscriptionsResponse; every active id exactly once (the hub checks the set: 422 bad_order). */
export const putSubscriptionOrderRequestSchema = z.object({
  ids: z
    .array(z.guid())
    .min(1)
    .max(1000)
    .refine(ids => new Set(ids).size === ids.length, 'duplicate ids'),
});
export type PutSubscriptionOrderRequest = z.infer<typeof putSubscriptionOrderRequestSchema>;

/** The longest period of GET /api/subscriptions/usage, days. */
export const USAGE_MAX_DAYS = 366;
const DAY_MS = 86_400_000;

/**
 * GET /api/subscriptions/usage?from=&to= (ISO date-times, `from` inclusive, `to` exclusive). Default (hub): the last
 * 7 days. `from` must be before `to` and the period ≤ USAGE_MAX_DAYS, else 422.
 */
export const subscriptionUsageQuerySchema = z
  .object({
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
  })
  .refine(q => q.from === undefined || q.to === undefined || Date.parse(q.from) < Date.parse(q.to), {
    message: 'from must be before to',
    path: ['from'],
  })
  .refine(q => q.from === undefined || q.to === undefined || Date.parse(q.to) - Date.parse(q.from) <= USAGE_MAX_DAYS * DAY_MS, {
    message: `period over ${USAGE_MAX_DAYS} days`,
    path: ['to'],
  });
export type SubscriptionUsageQuery = z.infer<typeof subscriptionUsageQuerySchema>;

// Requirement: Учёт ходов и расход по подпискам
export interface SubscriptionUsageRow {
  /** null — «Вход машины» (turns of processes without a subscription). */
  subscriptionId: string | null;
  /** Name, retired subscriptions included; «Вход машины» for null. */
  name: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  limitHits: number;
}
export interface SubscriptionUsageResponse {
  from: string;
  to: string;
  rows: SubscriptionUsageRow[];
}

/**
 * POST /api/sessions/:id/subscription → 202 {session}. A session without a live process: only the last choice changes.
 * A live one: stop and resume under the new subscription; while a turn runs — 409 turn_in_progress unless `interrupt`.
 * `repeatLast` — send the last user message again under the new one («Продолжить под другой подпиской»). Errors: 409
 * turn_in_progress | agent_outdated | runner_offline | token_unreadable, 422 subscription_unavailable, 423 read_only.
 */
export const switchSubscriptionRequestSchema = z.object({
  subscriptionId: z.guid(),
  interrupt: z.boolean().optional(),
  repeatLast: z.boolean().optional(),
});
export type SwitchSubscriptionRequest = z.infer<typeof switchSubscriptionRequestSchema>;
export interface SwitchSubscriptionResponse {
  session: SessionView;
}

// ---------- subscription limits (change subscription-limits, design L6) ----------
// Requirements: Снимок лимитов подписки; Состояния «нет данных»; Ручное обновление; Изоляция лимитов по пользователям.

/** Why a subscription has no trustworthy limits (state `unavailable`); `expired` — the last data is older than 24 h. */
export const LIMITS_REASONS = ['not_polled', 'token_rejected', 'no_runner', 'agent_outdated', 'probe_failed', 'expired'] as const;
export type LimitsReason = (typeof LIMITS_REASONS)[number];
export const LIMITS_STATES = ['ok', 'stale', 'unavailable'] as const;
export type LimitsState = (typeof LIMITS_STATES)[number];

const limitStatusView = z.enum(['allowed', 'allowed_warning', 'rejected', 'unknown']);
const isoView = z.iso.datetime({ offset: true });

/** One window of a snapshot: percent 0–100 or null (unknown), reset time ISO or null. Levels are the web's (80/95/100). */
export const limitWindowViewSchema = z.object({
  type: z.string().min(1).max(64),
  utilization: z.number().min(0).max(100).nullable(),
  resetsAt: isoView.nullable(),
  status: limitStatusView.nullable(),
  observedAt: isoView,
  source: z.enum(['session', 'probe']),
});
export type LimitWindowView = z.infer<typeof limitWindowViewSchema>;

export const limitOverageViewSchema = z.object({
  status: limitStatusView,
  inUse: z.boolean().nullable(),
  enabled: z.boolean().nullable(),
});
export type LimitOverageView = z.infer<typeof limitOverageViewSchema>;

export const subscriptionLimitsViewSchema = z.object({
  subscriptionId: z.guid(),
  state: z.enum(LIMITS_STATES),
  /** Set with state `unavailable` only; `token_rejected` wins over the rest. */
  reason: z.enum(LIMITS_REASONS).nullable(),
  /** Windows of the last snapshot (kept with `stale`/`unavailable` too, to show «данные от HH:MM»). */
  windows: z.array(limitWindowViewSchema),
  overage: limitOverageViewSchema.nullable(),
  /** The last data with windows (a session event or a probe turn). */
  lastOkAt: isoView.nullable(),
  /** A check without an event («ниже порога предупреждения»), only when newer than lastOkAt. */
  quietAt: isoView.nullable(),
  lastProbeAt: isoView.nullable(),
  /** state `stale`: the time of the data that went stale (max of lastOkAt and the quiet check). */
  staleAt: isoView.nullable(),
  /** From this time «Обновить» may be pressed again; null — now. */
  refreshableAt: isoView.nullable(),
});
export type SubscriptionLimitsView = z.infer<typeof subscriptionLimitsViewSchema>;

/** GET /api/subscriptions/limits: the active subscriptions of the user, in registry order. */
export const subscriptionLimitsResponseSchema = z.object({
  limits: z.array(subscriptionLimitsViewSchema),
  /** The hub's clock: the web corrects «через N мин» by it. */
  serverTime: isoView,
});
export type SubscriptionLimitsResponse = z.infer<typeof subscriptionLimitsResponseSchema>;

/**
 * POST /api/subscriptions/:id/limits/refresh → 202 {limits}: a probe turn is queued, the result comes as
 * subscription_limits.changed. Errors: 404 not_found, 409 subscription_retired | token_rejected | runner_offline |
 * agent_outdated | probes_disabled, 429 refresh_too_soon (+ Retry-After, seconds), 503 subscriptions_disabled.
 */
export const refreshLimitsResponseSchema = z.object({ limits: subscriptionLimitsViewSchema });
export type RefreshLimitsResponse = z.infer<typeof refreshLimitsResponseSchema>;
export const REFRESH_LIMITS_ERRORS = [
  'not_found',
  'subscription_retired',
  'token_rejected',
  'runner_offline',
  'agent_outdated',
  'probes_disabled',
  'refresh_too_soon',
  'subscriptions_disabled',
] as const;
export type RefreshLimitsError = (typeof REFRESH_LIMITS_ERRORS)[number];
// ---------- MCP management (change mcp-management, design M8) ----------
// Requirements: Статус MCP сессии; Отметка проблем MCP; Переподключение MCP-сервера; Включение и выключение MCP-сервера;
// Вход в удалённый MCP с любого устройства; Защита потока входа MCP; MCP спящей сессии; MCP машины; Права на MCP;
// Совместимость управления MCP с агентом.

/** What the hub is doing to a server right now: set when the action is accepted, cleared by the answer or an error. */
export const MCP_PENDING_ACTIONS = ['reconnect', 'enable', 'disable', 'auth', 'wake', 'logout'] as const;
export type McpPendingAction = (typeof MCP_PENDING_ACTIONS)[number];

/**
 * A server of a snapshot as the panel shows it: the agent's (redacted) snapshot row plus the hub's state.
 * `persistence` — where «Выключить» is kept: `project` (the machine's Claude config for the session's project, like /mcp)
 * or `process` (dynamic/sdk servers: only this process). `canAuth` — http/sse (not claudeai-proxy): «Войти» may be offered
 * when the status is `needs-auth`.
 */
export interface McpServerView extends McpServerSnapshot {
  pendingAction?: McpPendingAction;
  /** The text of the last action's error (cmd.error), until the next action on the server. */
  lastError?: string;
  /** i18n: `lastError` as a key, the client renders it in its language. */
  lastErrorI18n?: I18nText;
  persistence: 'project' | 'process';
  canAuth: boolean;
  /** mcp-auth-controls A1: an OAuth server (snapshot `oauth` of an agent 1.8+; false from an older one). */
  oauth: boolean;
  /** mcp-auth-controls A2: `failed` with an error that reads as a refused authorisation (isAuthErrorText). */
  authError: boolean;
}

/**
 * mcp-auth-controls A2, Requirement «OAuth-сервер в панели MCP»: an error text that reads as a refused authorisation —
 * 401 as a number of its own, unauthorized, invalid_token, invalid_grant, token expired/revoked, authentication
 * required/failed/cleared. Not 403/forbidden: a proxy or a WAF answers so, a new sign-in does not help there.
 */
export const MCP_AUTH_ERROR_RE = /\b401\b|unauthori[sz]ed|invalid[_ ]token|invalid_grant|token (expired|revoked)|authentication (required|failed|cleared)/i;
export function isAuthErrorText(text: string | null | undefined): boolean {
  return !!text && MCP_AUTH_ERROR_RE.test(text);
}

/** A sign-in attempt being waited for (M7): kept in the hub's memory for 10 min. */
export interface McpAuthFlowView {
  server: string;
  /** The provider's page; open it as a link (target=_blank), not with window.open after a WS event. */
  authUrl: string;
  /** `hub` — the provider returns to <PUBLIC_URL>/mcp/oauth/callback; `localhost` — paste the address from the browser. */
  redirect: 'hub' | 'localhost';
  /** `localhost`: the port in http://localhost:<port>/callback?… the browser will open. */
  callbackPort?: number;
  expiresAt: string;
}

export type McpAuthResult = 'ok' | 'failed' | 'expired' | 'process_exited';

/**
 * Why the panel has no data or no actions: `agent_outdated` — the machine's agent is older than protocol 1.7
 * («Управление MCP требует обновления агента»); `not_hub_managed` — the process was started outside the hub
 * («MCP видны только у сессий, запущенных или продолженных хабом»); `no_snapshot` — none received yet.
 */
export const MCP_VIEW_REASONS = ['agent_outdated', 'not_hub_managed', 'no_snapshot'] as const;
export type McpViewReason = (typeof MCP_VIEW_REASONS)[number];

/** GET /api/sessions/:id/mcp and WS session.mcp. */
export interface McpSessionView {
  /**
   * false — no actions (`agent_outdated`, `not_hub_managed`); servers of an older snapshot may still be listed.
   * `no_snapshot` comes with `available: true` (nothing to show yet; «Обновить» works on a live process).
   */
  available: boolean;
  reason?: McpViewReason;
  /** The hub has a live process of the session; false — «сессия спит; действие разбудит её». */
  live: boolean;
  /** The time of the snapshot (ISO), null — none. */
  observedAt: string | null;
  /** The project a disable is kept for (snapshot `projectRoot`, agent 0.2.5+); absent from an older agent. */
  projectRoot?: string;
  servers: McpServerView[];
  /** Attempts of this session being waited for (one per server). */
  authFlows: McpAuthFlowView[];
  /** The session is being woken up for an action («Сессия просыпается…»). */
  waking: boolean;
  /** mcp-auth-controls A4: the agent is 1.8+ — «Войти заново» and «Выйти» may be offered. */
  authControls: boolean;
}

/** GET /api/runners/:id/mcp and WS runner.mcp: the user-config servers (scope `user`) of a machine. */
export interface McpMachineView {
  /** false — «Проверить» is not possible (see `reason`); known servers are still listed. */
  available: boolean;
  /** `agent_outdated` — the agent is older than 1.7; `no_snapshot` — nothing known yet. */
  reason?: 'agent_outdated' | 'no_snapshot';
  observedAt: string | null;
  /** Where the servers come from: the last probe or a session snapshot, whichever is newer; null — none. */
  source: 'probe' | 'session' | null;
  servers: McpServerView[];
  /** The last «Проверить» that returned (ISO). */
  probeAt: string | null;
  /** «Проверить» is possible from this time (ISO); null — now. */
  probeAvailableAt: string | null;
  /** A probe is running on the machine. */
  probing: boolean;
  /** The error of the last «Проверить» that failed (mcp_probe_timeout, …), cleared by the next success; null — none. */
  probeError: string | null;
  probeErrorI18n?: I18nText | null;
  online: boolean;
  /** mcp-auth-controls A4: the agent is 1.8+ — «Войти заново» and «Выйти» may be offered. */
  authControls: boolean;
}

const mcpServerField = z.string().min(1).max(200);
/** POST /api/sessions/:id/mcp/actions → 202 McpSessionView. */
export const mcpActionRequestSchema = z.object({ server: mcpServerField, action: mcpActionSchema });
export type McpActionRequest = z.infer<typeof mcpActionRequestSchema>;
/** POST /api/sessions/:id/mcp/auth → 202 McpSessionView; the attempt comes as WS mcp.auth. */
export const mcpAuthRequestSchema = z.object({ server: mcpServerField });
export type McpAuthRequest = z.infer<typeof mcpAuthRequestSchema>;
/** POST /api/sessions/:id/mcp/auth/callback (the paste fallback) → 202 McpSessionView. */
export const mcpAuthCallbackRequestSchema = z.object({ server: mcpServerField, callbackUrl: z.string().min(1).max(8192) });
export type McpAuthCallbackRequest = z.infer<typeof mcpAuthCallbackRequestSchema>;
/** POST /api/sessions/:id/mcp/logout (mcp-auth-controls A3) → 202 McpSessionView; the result comes as WS session.mcp. */
export const mcpLogoutRequestSchema = z.object({ server: mcpServerField });
export type McpLogoutRequest = z.infer<typeof mcpLogoutRequestSchema>;

/**
 * Error codes of the MCP routes ({error, message}): 404 not_found | runner_not_found | no_auth_flow; 409 agent_outdated |
 * not_hub_managed | runner_offline | concurrent_external | probe_busy; 423 read_only; 400 bad_callback_url |
 * invalid_request; 422 mcp_unknown_server | mcp_auth_unsupported; 429 probe_too_soon (+ Retry-After, seconds).
 * Errors of an accepted (202) action come later as `lastError` of the server in WS session.mcp, or as mcp.auth `failed`.
 */
export const MCP_API_ERRORS = [
  'not_found',
  'runner_not_found',
  'no_auth_flow',
  'agent_outdated',
  'not_hub_managed',
  'runner_offline',
  'concurrent_external',
  'probe_busy',
  'read_only',
  'bad_callback_url',
  'invalid_request',
  'mcp_unknown_server',
  'mcp_auth_unsupported',
  'probe_too_soon',
] as const;
export type McpApiError = (typeof MCP_API_ERRORS)[number];

/** Texts of an agent's refusal (`CmdError` message, English): the hub maps the error code to a `hub.mcp.*` key, the text goes to logs only. */
export const MCP_TEXTS = {
  authUnsupported: 'Sign-in from the hub is not supported by this Claude Code version on the machine: run /mcp in a terminal',
  /** `<server>` is replaced with the server's name. */
  logoutUnsupported: 'Sign-out from the hub is not supported by this Claude Code version on the machine: run claude mcp logout <server> in a terminal',
  stateMismatch: 'The address is not from this sign-in attempt or has no code: paste the address from the page of this attempt',
} as const;

/** projects-catalog: the card of an unconfident classification — up to 3 projects, a new project by name, «Без проекта». */
export interface ProjectSuggestionView {
  inputHash: string;
  options: Array<{ projectId: string; name: string; colorKey: ProjectColorKey }>;
  newProjectName: string | null;
}
export const projectSuggestionAnswerSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('accept'), projectId: z.uuid(), inputHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z
    .object({
      action: z.literal('create'),
      name: z
        .string()
        .trim()
        .min(1)
        .max(120)
        .transform(v => v.normalize('NFC')),
      inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z.object({ action: z.literal('dismiss'), inputHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);
export type ProjectSuggestionAnswer = z.infer<typeof projectSuggestionAnswerSchema>;

// ---------- file explorer (change `tool-windows-file-explorer`, design D3) ----------

/** Errors of GET /api/runners/:runnerId/fs/list and fs/file: the agent's codes plus the hub's own. */
export const FS_HUB_ERROR_CODES = [
  'invalid_request',
  'forbidden_origin',
  'runner_not_found',
  'runner_offline',
  'root_unknown',
  'capability_unavailable',
  'too_many_requests',
  'agent_timeout',
] as const;
export type FsErrorCode = FsAgentErrorCode | (typeof FS_HUB_ERROR_CODES)[number];
/** HTTP status of each code. */
export const FS_ERROR_STATUS: Record<FsErrorCode, number> = {
  invalid_request: 400,
  invalid_path: 400,
  forbidden_origin: 403,
  restricted: 403,
  outside_root: 403,
  runner_not_found: 404,
  not_found: 404,
  runner_offline: 409,
  root_unknown: 409,
  capability_unavailable: 409,
  too_large: 413,
  not_directory: 422,
  not_file: 422,
  too_many_requests: 429,
  io_error: 502,
  agent_timeout: 504,
  permission_denied: 403,
  unsupported: 415,
};

/**
 * Query of GET /api/runners/:runnerId/fs/list. No `root`: the hub takes the session cwd (with sessionId) or the machine home.
 * `path` is absolute and defaults to the root; `hidden` shows dotfiles.
 */
export const fsListQuerySchema = z.object({
  path: z.string().min(1).max(4096).optional(),
  sessionId: z.uuid().optional(),
  hidden: z.enum(['0', '1']).optional(),
});
export type FsListQuery = z.infer<typeof fsListQuerySchema>;
export const fsFileQuerySchema = z.object({ path: z.string().min(1).max(4096), sessionId: z.uuid().optional() });
export type FsFileQuery = z.infer<typeof fsFileQuerySchema>;

/** 200 of fs/list. */
export interface FsListResponse {
  /** realpath of the listed folder */
  path: string;
  entries: FsEntry[];
  truncated: boolean;
  total: number;
}
/** Error body of both fs routes (the usual `{ error, message }` of the hub). */
export interface FsErrorResponse {
  error: FsErrorCode;
  message?: string;
}
/** 415 of fs/file for a file of class `binary`: nothing is sent, only what the viewer shows. */
export interface FsUnsupportedResponse {
  error: 'unsupported';
  kind: 'binary';
  size: number;
  mime: string;
}
/** Headers of 200 of fs/file besides Content-Type: X-File-Kind is an FsFileKind, X-File-Size the size in bytes. */
export const FS_FILE_HEADERS = { kind: 'x-file-kind', size: 'x-file-size' } as const;

/** Query of fs/download (file-download D4): `probe=1` answers FsDownloadProbe instead of the file. */
export const fsDownloadQuerySchema = fsFileQuerySchema.extend({ probe: z.enum(['1']).optional() });
export type FsDownloadQuery = z.infer<typeof fsDownloadQuerySchema>;
/** 200 of fs/download?probe=1: the file can be downloaded; `name` is the base name of its realpath. */
export interface FsDownloadProbe {
  name: string;
  size: number;
  mtimeMs: number;
}

export const DESKTOP_PLATFORMS = ['win', 'linux', 'mac'] as const;
export type DesktopPlatform = (typeof DESKTOP_PLATFORMS)[number];

export interface DesktopDownload {
  platform: DesktopPlatform;
  size: number;
  fileName: string;
}

/**
 * GET /api/desktop/info (changes desktop-download D7, desktop-platforms D3): the installers of the update feed, `fileName`
 * with the hub tag. `version`, `size` and `fileName` describe the Windows installer; `downloads` lists every platform.
 */
export type DesktopInfo = { available: false } | { available: true; version: string; size: number; fileName: string; downloads: DesktopDownload[] };
