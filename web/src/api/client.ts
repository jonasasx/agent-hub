// HTTP client for the hub API (design.md D10).
import type {
  AdminUserView,
  ExtraProvider,
  Provider,
  ProviderLoginStartView,
  CodexLoginRequest,
  AdminUsersResponse,
  CreateInviteRequest,
  CreateInviteResponse,
  CreateRunnerRequest,
  EnrollCodeResponse,
  InvitesResponse,
  LogoutAllResponse,
  LogoutResponse,
  RunnerDetail,
  RunnerView,
  RunnersResponse,
  SecurityResponse,
  CreateSessionRequest,
  CreateSubscriptionRequest,
  Device,
  EventsPage,
  HubEvent,
  LayoutResponse,
  Locale,
  MeResponse,
  ModelOption,
  PatchSessionRequest,
  PatchSubscriptionRequest,
  PushDeviceView,
  PushSubscriptionsResponse,
  PermissionDecision,
  PermissionView,
  ProjectSessionsResponse,
  PutLayoutResponse,
  SessionView,
  SidebarResponse,
  SubagentView,
  SubagentsResponse,
  TranscribeResponse,
  VoiceTalkResponse,
  SubscriptionUsageResponse,
  SubscriptionView,
  SubscriptionsResponse,
  SwitchSubscriptionRequest,
  SwitchSubscriptionResponse,
  RestartSessionRequest,
  RestartSessionResponse,
  UploadResponse,
  RefreshLimitsResponse,
  SubscriptionLimitsResponse,
  McpAction,
  McpSessionView,
  UserProjectView,
} from './types';
import type {
  McpDraftConnectRequest,
  McpRegistryCreateRequest,
  McpDraftSaveUncheckedRequest,
  McpDraftUpdateRequest,
  McpDraftValidateRequest,
  McpImportPreviewRequest,
  McpImportPreviewResponse,
  McpRegistryPersistedDraftResponse,
  McpRegistryDraftView,
  McpRegistryImportCommitRequest,
  McpProjectOverride,
  McpProjectOverrideUpdate,
  McpRegistryResponse,
  McpRegistryServerUpdate,
  McpRegistryStatus,
  McpRegistryOAuthCompleteRequest,
  McpRegistryOAuthCompleteResponse,
  McpRegistryOAuthStartRequest,
  McpRegistryOAuthStartResponse,
  McpRegistryOAuthRevokeRequest,
  McpRegistryOAuthRevokeResponse,
  McpRegistryOAuthValidateRequest,
  McpRegistryOAuthValidateResponse,
  McpRegistryOAuthConnectRequest,
  McpRegistryOAuthConnectResponse,
  McpRegistryMachineOverrideRequest,
  McpRegistryMachineOverrideResponse,
  McpImportCommitResponse,
  McpServerConfig,
} from './mcpRegistryTypes';
import { currentLocale } from '../i18n';

/** PUT /api/layout (M2.1): last write wins, no version (shared putLayoutRequestSchema). */
export interface PutLayoutBody {
  device: Device;
  layout: unknown;
  savedLayout: unknown;
  openedAt: Record<string, string>;
  /** Window clock (ms) of the change in this snapshot: the hub drops a body older than the stored one (D10). */
  clientTs: number;
  /** Change `subagents`: tabs that are not sessions (`{<id>: 'subagent'}`). */
  tabKinds?: Record<string, string> | null;
}

/** An image the hub stores (POST /api/uploads, D10, D19). */
export type UploadedImage = UploadResponse;

/** An image attached to a message: an upload of this user (`attachments` of the request schemas in shared). */
export interface AttachmentRef {
  sha256: string;
}

/** POST /api/sessions/:id/images → the hub note with the image (stored, so a repeat does not reach the machine). */
export type ShowImageResponse = { event: Extract<HubEvent, { kind: 'note' }> };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /** Human-readable text from the hub, when it sent one. */
    readonly serverMessage?: string,
    readonly body?: Record<string, unknown>,
  ) {
    super(`${status} ${code}`);
  }
}

let unauthorizedHandler: (() => void) | null = null;

/**
 * Called on 401 from any /api request (the browser session expired while the app is open): the app sends the user
 * to the login page instead of showing an error toast. /auth/* answers are handled by their callers.
 */
export function onUnauthorized(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  // change i18n D5: the hub answers human-readable texts in the interface language
  const headers = { Accept: 'application/json', 'X-Agent-Hub-Locale': currentLocale(), ...init.headers };
  const res = await fetch(path, { credentials: 'same-origin', ...init, headers });
  if (res.status === 401 && path.startsWith('/api/')) unauthorizedHandler?.();
  if (!res.ok) {
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      // non-JSON body
    }
    // 429 refresh_too_soon (subscription-limits): the wait comes in Retry-After, seconds
    const retryAfter = Number(res.headers?.get?.('Retry-After'));
    if (Number.isFinite(retryAfter) && retryAfter > 0 && body.retryAfter === undefined) body = { ...body, retryAfter };
    throw new ApiError(res.status, typeof body.error === 'string' ? body.error : 'http_error', typeof body.message === 'string' ? body.message : undefined, body);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const enc = encodeURIComponent;

/** Answers by question text (several choices joined by ", "), or a message with a denial. */
export interface DecideExtra {
  answers?: Record<string, string | string[]>;
  message?: string;
}

/** A handoff prompt draft (D14 «Handoff» 1): `pending` until the model answers, then `ready` with the text or `error`. */
export interface HandoffDraft {
  id: string;
  status: 'pending' | 'ready' | 'error';
  text?: string | null;
  error?: string | null;
  errorI18n?: import('@agent-hub/shared').I18nText;
}

export const api = {
  answerProjectSuggestion: (id: string, answer: import('@agent-hub/shared').ProjectSuggestionAnswer) => request<{ ok: true }>(`/api/sessions/${enc(id)}/project-suggestion`, json('POST', answer)),
  me: () => request<MeResponse>('/api/me'),
  /** GET /api/voice/talk — the ElevenLabs conversation link and the hub's token (change voice-conversation, D1). */
  voiceTalk: (sessionId: string) => request<VoiceTalkResponse>(`/api/voice/talk?session=${enc(sessionId)}`),
  setLocale: (locale: Locale | null) => request<void>('/api/preferences/locale', json('PUT', { locale })),
  desktopInfo: () => request<import('@agent-hub/shared').DesktopInfo>('/api/desktop/info'),
  sidebar: (cron = false) => request<SidebarResponse>(`/api/sidebar?cron=${cron ? 1 : 0}`),
  /** keycloak-auth D7: `redirect` — the provider's end_session_endpoint, or `/`. */
  logout: () => request<LogoutResponse>('/auth/logout', { method: 'POST' }),
  projectSessions: (projectId: string | null, offset: number, limit: number, cron: boolean) =>
    request<ProjectSessionsResponse>(`/api/projects/${enc(projectId ?? 'none')}/sessions?offset=${offset}&limit=${limit}&cron=${cron ? 1 : 0}`),
  models: () => request<ModelOption[]>('/api/models'),
  catalogProjects: (sort: 'recent' | 'name' = 'recent', includeArchived = false) => request<UserProjectView[]>(`/api/catalog/projects?sort=${sort}${includeArchived ? '&includeArchived=1' : ''}`),
  launchPreferences: () => request<{ runnerId: string | null; provider: Provider | null }>('/api/preferences/launch'),
  createCatalogProject: (body: { name: string; description?: string; remote?: string | null; folder?: string | null; colorKey?: UserProjectView['colorKey'] }) =>
    request<UserProjectView>('/api/catalog/projects', json('POST', body)),
  patchCatalogProject: (id: string, body: { name?: string; colorKey?: UserProjectView['colorKey']; description?: string; remote?: string | null; folder?: string | null }) =>
    request<{ ok: true }>(`/api/catalog/projects/${enc(id)}`, json('PATCH', body)),
  deleteCatalogProject: (id: string) => request<{ ok: true }>(`/api/catalog/projects/${enc(id)}`, { method: 'DELETE' }),
  patchProjectGroupColor: (id: string, colorKey: UserProjectView['colorKey']) => request<{ ok: true }>(`/api/projects/${enc(id)}/color`, json('PATCH', { colorKey })),
  hiddenProjectGroups: () => request<import('./types').ProjectRef[]>('/api/projects/hidden'),
  hideProjectGroup: (id: string, hidden: boolean) => request<{ ok: true }>(`/api/projects/${enc(id)}/hidden`, { method: hidden ? 'PUT' : 'DELETE' }),
  deleteProjectGroup: (id: string) => request<{ ok: true }>(`/api/projects/${enc(id)}/hidden`, { method: 'PUT' }),
  runnerDirectories: (runnerId: string, path?: string, showHidden = false) =>
    request<{ path: string; parent: string | null; directories: { name: string; path: string }[] }>(
      `/api/runners/${enc(runnerId)}/directories?showHidden=${showHidden}${path ? `&path=${enc(path)}` : ''}`,
    ),
  /** Ctrl+K (D10): titles, projects and the text of the replies; the body is parsed by features/search/snippet.ts. */
  search: (q: string, cron: boolean, limit = 12, signal?: AbortSignal) => request<unknown>(`/api/search?q=${enc(q)}&limit=${limit}&cron=${cron ? 1 : 0}`, { signal }),
  session: (id: string) => request<SessionView>(`/api/sessions/${enc(id)}`),
  /** Change session-links (D2): UUIDs of the feed → sessions of the user; unknown ones are absent from the answer. */
  resolveSessions: (ids: string[]) => request<{ sessions: import('@agent-hub/shared').SessionRefView[] }>('/api/sessions/resolve', json('POST', { ids })),
  /** The directory for «Перенести в…» (D10); parsed by features/projects/projects.ts. */
  projects: () => request<unknown>('/api/projects'),
  /** Move = pin (D10): `projectId` of the directory or 'none'. */
  setProject: (id: string, projectId: string) => request<SessionView>(`/api/sessions/${enc(id)}/project`, json('PUT', { projectId })),
  pin: (id: string) => request<SessionView>(`/api/sessions/${enc(id)}/pin`, json('POST', {})),
  unpin: (id: string) => request<SessionView>(`/api/sessions/${enc(id)}/pin`, { method: 'DELETE' }),
  events: (id: string, before: string | null, limit = 200) => request<EventsPage>(`/api/sessions/${enc(id)}/events?limit=${limit}${before ? `&before=${enc(before)}` : ''}`),
  /** Change `subagents` (design S7): the registry of a session, one row, the transcript of a subagent by pages. */
  subagents: (sessionId: string) => request<SubagentsResponse>(`/api/sessions/${enc(sessionId)}/subagents`),
  subagent: (id: string) => request<SubagentView>(`/api/subagents/${enc(id)}`),
  subagentEvents: (id: string, before: string | null, limit = 200) => request<EventsPage>(`/api/subagents/${enc(id)}/events?limit=${limit}${before ? `&before=${enc(before)}` : ''}`),
  createSession: (body: CreateSessionRequest & { attachments?: AttachmentRef[] }) => request<SessionView>('/api/sessions', json('POST', body)),
  /** M4b (D10, D14): a full copy on the same machine, or a handoff with an edited prompt on a chosen runner. */
  fork: (id: string, body: { mode: 'copy' } | { mode: 'handoff'; prompt: string; runnerId: string; draftId?: string; subscriptionId?: string | null }) =>
    request<SessionView>(`/api/sessions/${enc(id)}/fork`, json('POST', body)),
  /** The hub writes the handoff prompt (202); the result comes as WS `handoff.draft` and from GET /api/handoff-drafts/:id. */
  createHandoffDraft: (id: string, subscriptionId?: string) => request<HandoffDraft>(`/api/sessions/${enc(id)}/handoff-drafts`, json('POST', subscriptionId ? { subscriptionId } : {})),
  handoffDraft: (draftId: string) => request<HandoffDraft>(`/api/handoff-drafts/${enc(draftId)}`),
  /** «Показать изображение» for a local path in an assistant answer (D10, D19). */
  showImage: (id: string, path: string) => request<ShowImageResponse>(`/api/sessions/${enc(id)}/images`, json('POST', { path })),
  sendMessage: (id: string, text: string, clientUuid: string, force = false, attachments: AttachmentRef[] = []) =>
    request<{ session: SessionView }>(`/api/sessions/${enc(id)}/messages`, json('POST', { text, clientUuid, ...(force ? { force: true } : {}), ...(attachments.length ? { attachments } : {}) })),
  wake: (id: string, force = false) => request<{ session: SessionView }>(`/api/sessions/${enc(id)}/wake`, json('POST', force ? { force: true } : {})),
  interrupt: (id: string) => request<{ session: SessionView }>(`/api/sessions/${enc(id)}/interrupt`, json('POST', {})),
  patchSession: (id: string, body: PatchSessionRequest) => request<SessionView>(`/api/sessions/${enc(id)}`, json('PATCH', body)),
  regenerateSessionTitle: (id: string) => request<SessionView>(`/api/sessions/${enc(id)}/title/regenerate`, json('POST', {})),
  /** `extra`: the answers of an AskUserQuestion card, the comment of «Продолжить планирование» (M4b contract). */
  decide: (id: string, requestId: string, decision: PermissionDecision, extra: DecideExtra = {}) =>
    request<{ request: PermissionView }>(`/api/sessions/${enc(id)}/permissions/${enc(requestId)}`, json('POST', { decision, ...extra })),
  /** Template for a new window of this device class (D10, M2.1). */
  layout: (device: Device) => request<LayoutResponse>(`/api/layout?device=${device}`),
  /** The snapshot of this window becomes the template; `keepalive` lets it leave on pagehide. */
  putLayout: (body: PutLayoutBody, keepalive = false) => request<PutLayoutResponse>('/api/layout', { ...json('PUT', body), keepalive }),

  // ---------- change `multi-user` (shared/src/api.ts) ----------
  /** «Настройки → Машины»: every machine of the user, disabled ones too. */
  runners: () => request<RunnersResponse>('/api/runners'),
  runner: (id: string) => request<RunnerDetail>(`/api/runners/${enc(id)}`),
  /** «Подключить машину»: a pending runner and its enrollment code (409 name_taken). */
  createRunner: (body: CreateRunnerRequest) => request<EnrollCodeResponse>('/api/runners', json('POST', body)),
  renameRunner: (id: string, name: string) => request<RunnerView>(`/api/runners/${enc(id)}`, json('PATCH', { name })),
  /** session-folder D3: the default folder of the machine (409 runner_offline, 400 invalid_path, 422 cwd_not_found). */
  setDefaultDir: (id: string, defaultDir: string) => request<RunnerView>(`/api/runners/${enc(id)}`, json('PATCH', { defaultDir })),
  /** «Новый код» and «Переподключить»: the previous unused code is revoked. */
  enrollCode: (id: string) => request<EnrollCodeResponse>(`/api/runners/${enc(id)}/enroll-code`, json('POST', {})),
  disableRunner: (id: string) => request<RunnerDetail>(`/api/runners/${enc(id)}/disable`, json('POST', {})),
  // agent-providers: the device-code sign-in of a machine's provider
  providerLogin: (id: string, provider: ExtraProvider) => request<ProviderLoginStartView>(`/api/runners/${enc(id)}/providers/${provider}/login`, json('POST', {})),
  codexLogin: (body: CodexLoginRequest) => request<ProviderLoginStartView>('/api/subscriptions/codex-login', json('POST', body)),
  providerLoginCancel: (id: string, provider: ExtraProvider, loginId: string) => request<void>(`/api/runners/${enc(id)}/providers/${provider}/login/${enc(loginId)}`, { method: 'DELETE' }),
  providerLogout: (id: string, provider: ExtraProvider) => request<void>(`/api/runners/${enc(id)}/providers/${provider}/logout`, json('POST', {})),
  adminUsers: () => request<AdminUsersResponse>('/api/admin/users'),
  setUserEnabled: (id: string, enabled: boolean) => request<AdminUserView>(`/api/admin/users/${enc(id)}/${enabled ? 'enable' : 'disable'}`, json('POST', {})),
  invites: () => request<InvitesResponse>('/api/admin/invites'),
  createInvite: (body: CreateInviteRequest) => request<CreateInviteResponse>('/api/admin/invites', json('POST', body)),
  revokeInvite: (id: string) => request<void>(`/api/admin/invites/${enc(id)}`, { method: 'DELETE' }),
  security: () => request<SecurityResponse>('/api/security'),
  // web-push-notifications (design D7): the list has no endpoint and keys, «this device» is found by endpointHash
  pushDevices: () => request<PushSubscriptionsResponse>('/api/push/subscriptions'),
  subscribePush: (body: { endpoint: string; keys: { p256dh: string; auth: string } }) => request<PushDeviceView>('/api/push/subscriptions', json('POST', body)),
  deletePushDevice: (id: string) => request<void>(`/api/push/subscriptions/${enc(id)}`, { method: 'DELETE' }),
  deletePushByHash: (endpointHash: string) => request<void>(`/api/push/subscriptions?endpointHash=${enc(endpointHash)}`, { method: 'DELETE' }),
  testPush: (endpointHash: string) => request<void>('/api/push/test', json('POST', { endpointHash })),
  logoutAll: () => request<LogoutAllResponse>('/api/auth/logout-all', json('POST', {})),

  // claude-subscriptions (design P8). The token goes to the hub only in the bodies of POST and PUT …/token; no answer carries it.
  subscriptions: () => request<SubscriptionsResponse>('/api/subscriptions'),
  createSubscription: (body: CreateSubscriptionRequest) => request<SubscriptionView>('/api/subscriptions', json('POST', body)),
  patchSubscription: (id: string, body: PatchSubscriptionRequest) => request<SubscriptionView>(`/api/subscriptions/${enc(id)}`, json('PATCH', body)),
  putSubscriptionToken: (id: string, token: string) => request<SubscriptionView>(`/api/subscriptions/${enc(id)}/token`, json('PUT', { token })),
  putSubscriptionOrder: (ids: string[]) => request<SubscriptionsResponse>('/api/subscriptions/order', json('PUT', { ids })),
  // subscription-limits (design.md L6): the snapshot of every active subscription; refresh asks for a probe turn (202)
  subscriptionLimits: () => request<SubscriptionLimitsResponse>('/api/subscriptions/limits'),
  refreshSubscriptionLimits: (id: string) => request<RefreshLimitsResponse>(`/api/subscriptions/${enc(id)}/limits/refresh`, json('POST', {})),
  subscriptionUsage: (from: string, to: string) => request<SubscriptionUsageResponse>(`/api/subscriptions/usage?from=${enc(from)}&to=${enc(to)}`),
  /** Switch the subscription of a session (202); for a session without a live process — only the last choice. */
  switchSubscription: (id: string, body: SwitchSubscriptionRequest) => request<SwitchSubscriptionResponse>(`/api/sessions/${enc(id)}/subscription`, json('POST', body)),
  restartSession: (id: string, body: RestartSessionRequest) => request<RestartSessionResponse>(`/api/sessions/${enc(id)}/restart`, json('POST', body)),

  // mcp-management: actions answer 202 with the view; results come as WS session.mcp / mcp.auth
  mcp: (id: string) => request<McpSessionView>(`/api/sessions/${enc(id)}/mcp`),
  mcpRefresh: (id: string) => request<McpSessionView>(`/api/sessions/${enc(id)}/mcp/refresh`, json('POST', {})),
  mcpAction: (id: string, server: string, action: McpAction) => request<McpSessionView>(`/api/sessions/${enc(id)}/mcp/actions`, json('POST', { server, action })),
  mcpAuth: (id: string, server: string) => request<McpSessionView>(`/api/sessions/${enc(id)}/mcp/auth`, json('POST', { server })),
  /** The paste fallback: the body carries the address with the code; the hub never logs it. */
  mcpAuthCallback: (id: string, server: string, callbackUrl: string) => request<McpSessionView>(`/api/sessions/${enc(id)}/mcp/auth/callback`, json('POST', { server, callbackUrl })),
  // mcp-auth-controls A3: «Выйти» → 202 with the view; the result comes as WS session.mcp
  mcpLogout: (id: string, server: string) => request<McpSessionView>(`/api/sessions/${enc(id)}/mcp/logout`, json('POST', { server })),

  // MCP registry (protocol 1.13; openspec mcp-registry design §§3, 11–12).
  mcpRegistry: () => request<McpRegistryResponse>('/api/mcp/registry'),
  mcpRegistryCreate: (body: McpRegistryCreateRequest) => request<McpRegistryDraftView>('/api/mcp/registry/drafts', json('POST', body)),
  mcpRegistryDraft: (id: string) => request<McpRegistryDraftView>(`/api/mcp/registry/drafts/${enc(id)}`),
  mcpRegistryUpdate: (id: string, body: McpDraftUpdateRequest) => request<McpRegistryDraftView>(`/api/mcp/registry/drafts/${enc(id)}`, json('PATCH', body)),
  mcpRegistryValidate: (id: string, body: McpDraftValidateRequest) => request<McpRegistryDraftView>(`/api/mcp/registry/drafts/${enc(id)}/validate`, json('POST', body)),
  mcpRegistryConnect: (id: string, body: McpDraftConnectRequest) => request<McpRegistryPersistedDraftResponse>(`/api/mcp/registry/drafts/${enc(id)}/connect`, json('POST', body)),
  mcpRegistrySaveUnchecked: (id: string, body: McpDraftSaveUncheckedRequest) => request<McpRegistryPersistedDraftResponse>(`/api/mcp/registry/drafts/${enc(id)}/save-unchecked`, json('POST', body)),
  mcpRegistryDelete: (id: string, revision: number) => request<void>(`/api/mcp/registry/servers/${enc(id)}`, json('DELETE', { revision })),
  mcpRegistryPatchServer: (id: string, body: McpRegistryServerUpdate) => request<McpServerConfig>(`/api/mcp/registry/servers/${enc(id)}`, json('PATCH', body)),
  mcpRegistryProjectOverride: (id: string, projectId: string) => request<McpProjectOverride>(`/api/mcp/registry/servers/${enc(id)}/projects/${enc(projectId)}`),
  mcpRegistryPutProjectOverride: (id: string, projectId: string, body: McpProjectOverrideUpdate) =>
    request<McpProjectOverride>(`/api/mcp/registry/servers/${enc(id)}/projects/${enc(projectId)}`, json('PUT', body)),
  mcpRegistryDeleteProjectOverride: (id: string, projectId: string, revision: number) =>
    request<McpProjectOverride>(`/api/mcp/registry/servers/${enc(id)}/projects/${enc(projectId)}?revision=${revision}`, { method: 'DELETE' }),
  mcpRegistryImportPreview: (body: McpImportPreviewRequest) => request<McpImportPreviewResponse>('/api/mcp/registry/import/preview', json('POST', body)),
  mcpRegistryImportCommit: (body: McpRegistryImportCommitRequest) => request<McpImportCommitResponse>('/api/mcp/registry/import/commit', json('POST', body)),
  mcpRegistryStatus: () => request<McpRegistryStatus>('/api/mcp/registry/status'),
  mcpRegistryOAuthComplete: (id: string, body: McpRegistryOAuthCompleteRequest) => request<McpRegistryOAuthCompleteResponse>(`/api/mcp/registry/servers/${enc(id)}/oauth/complete`, json('POST', body)),
  mcpRegistryOAuthStart: (id: string, body: McpRegistryOAuthStartRequest) => request<McpRegistryOAuthStartResponse>(`/api/mcp/registry/servers/${enc(id)}/oauth/start`, json('POST', body)),
  mcpRegistryOAuthRevoke: (id: string, body: McpRegistryOAuthRevokeRequest) => request<McpRegistryOAuthRevokeResponse>(`/api/mcp/registry/servers/${enc(id)}/oauth/revoke`, json('POST', body)),
  mcpRegistryOAuthValidate: (id: string, body: McpRegistryOAuthValidateRequest) => request<McpRegistryOAuthValidateResponse>(`/api/mcp/registry/servers/${enc(id)}/oauth/validate`, json('POST', body)),
  mcpRegistryOAuthConnect: (id: string, body: McpRegistryOAuthConnectRequest) => request<McpRegistryOAuthConnectResponse>(`/api/mcp/registry/servers/${enc(id)}/oauth/connect`, json('POST', body)),
  mcpRegistryMachineOverride: (serverId: string, machineId: string, body: McpRegistryMachineOverrideRequest) =>
    request<McpRegistryMachineOverrideResponse>(`/api/mcp/registry/servers/${enc(serverId)}/machines/${enc(machineId)}`, json('PUT', body)),
};

/** Sends the browser to the login (the hub picks the provider) and back to the current address. */
export function redirectToLogin(loc: Pick<Location, 'pathname' | 'search' | 'assign'> = window.location): void {
  const back = `${loc.pathname}${loc.search}`;
  loc.assign(`/auth/login?return=${encodeURIComponent(back)}`);
}

/**
 * POST /api/uploads with the bytes of one image (D19 p. 3). XMLHttpRequest for the upload progress; the errors are
 * ApiError like the rest of the client (413 too_large, 415 not_image, 422 image_too_large). 201 — stored now, 200 —
 * the same image was stored before; both carry the body.
 */
export function uploadImage(blob: Blob, mime: string, onProgress?: (fraction: number) => void): Promise<UploadedImage> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/uploads');
    xhr.setRequestHeader('Content-Type', mime);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(xhr.responseText) as Record<string, unknown>;
      } catch {
        // non-JSON body
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(body as unknown as UploadedImage);
      if (xhr.status === 401) unauthorizedHandler?.();
      reject(new ApiError(xhr.status, typeof body.error === 'string' ? body.error : 'http_error', typeof body.message === 'string' ? body.message : undefined, body));
    };
    xhr.onerror = () => reject(new ApiError(0, 'network_error'));
    xhr.send(blob);
  });
}

/** Client-side limit of one transcription: longer than the hub's VOICE_TIMEOUT_MS (60 s), so the hub's 504 arrives first (D2). */
export const TRANSCRIBE_TIMEOUT_MS = 75_000;

/**
 * POST /api/voice/transcribe with the bytes of one recording (voice-input design D2, D7). `signal` — «Отмена» of the
 * dictation; the client gives up by itself after 75 s (`ApiError(0, 'timeout')`); a lost connection is
 * `ApiError(0, 'network_error')`; hub errors are `ApiError` with the body (`resetAt` of the quota error in `body`).
 */
export async function transcribe(blob: Blob, mime: string, signal?: AbortSignal, timeoutMs = TRANSCRIBE_TIMEOUT_MS): Promise<TranscribeResponse> {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, timeoutMs);
  const onAbort = () => ctl.abort();
  if (signal?.aborted) ctl.abort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  try {
    let res: Response;
    try {
      res = await fetch('/api/voice/transcribe', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': mime, Accept: 'application/json' },
        body: blob,
        signal: ctl.signal,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new ApiError(0, timedOut ? 'timeout' : 'network_error');
    }
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch (err) {
      // aborted while reading the body; otherwise a non-JSON body (a proxy error page)
      if (signal?.aborted) throw err;
      if (ctl.signal.aborted) throw new ApiError(0, 'timeout');
    }
    if (res.status === 401) unauthorizedHandler?.();
    if (!res.ok) throw new ApiError(res.status, typeof body.error === 'string' ? body.error : 'http_error', typeof body.message === 'string' ? body.message : undefined, body);
    return { text: typeof body.text === 'string' ? body.text : '' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
