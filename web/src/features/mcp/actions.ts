/**
 * Side effects of the session MCP UI: session views, refresh and auth actions, session WS events,
 * and the reload after a reconnect. A 404 of the hub hides the panel.
 */
import { ApiError, api } from '../../api/client';
import { type McpAction, type McpSessionView, type UiServerMessage } from '../../api/types';
import { useStore } from '../../store';
import { hubText, t } from '../../i18n';
import { authKey, authResultText } from './mcpModel';

const get = useStore.getState;
const set = useStore.setState;

export type McpResult = { ok: true } | { ok: false; message: string; code: string };

/** The text of a refused request: the hub's `message` (texts of the spec, «X1 не в сети»), else by the code. */
export function mcpErrorText(err: unknown): { message: string; code: string } {
  if (!(err instanceof ApiError)) return { code: 'network_error', message: t('mcp.error.hubNoReply') };
  const byCode: Record<string, string> = {
    agent_outdated: t('mcp.error.agentOutdated', { text: t('mcp.text.agentOutdated') }),
    not_hub_managed: t('mcp.text.notHubManaged'),
    mcp_auth_unsupported: t('mcp.text.authUnsupported'),
    bad_callback_url: t('mcp.text.stateMismatch'),
    no_auth_flow: t('mcp.error.noAuthFlow'),
    runner_offline: t('mcp.error.runnerOffline'),
    read_only: t('mcp.error.readOnly'),
    mcp_unknown_server: t('mcp.error.unknownServer'),
    probe_busy: t('mcp.error.probeBusy'),
    concurrent_external: t('mcp.error.concurrentExternal'),
    revision_conflict: t('mcp.error.revisionConflict'),
  };
  // agent_outdated: the spec's text plus the offer to update; else the hub's text wins
  if (err.code === 'agent_outdated') return { code: err.code, message: byCode.agent_outdated! };
  if (err.code === 'revision_conflict') return { code: err.code, message: byCode.revision_conflict! };
  return { code: err.code, message: err.serverMessage ?? byCode[err.code] ?? (err.status === 0 ? t('mcp.error.hubNoReply') : t('mcp.error.failedStatus', { status: err.status })) };
}

/** A body that is not the hub's view (an older hub, a proxy page) hides the panel instead of breaking it. */
const isSessionView = (v: unknown): v is McpSessionView => !!v && typeof v === 'object' && Array.isArray((v as McpSessionView).servers) && Array.isArray((v as McpSessionView).authFlows);

function putView(sessionId: string, view: McpSessionView | null) {
  set({ mcp: { ...get().mcp, [sessionId]: view } });
}

function setAuthError(sessionId: string, server: string, text: string | undefined) {
  const k = authKey(sessionId, server);
  if (get().mcpAuthErrors[k] === text) return;
  set({ mcpAuthErrors: { ...get().mcpAuthErrors, [k]: text } });
}

const loading = new Map<string, Promise<void>>();

/** GET /api/sessions/:id/mcp into the store; 404 → null (no panel). `force` — again even when loaded. */
export function loadMcp(sessionId: string, force = false): Promise<void> {
  if (!force && get().mcp[sessionId] !== undefined) return Promise.resolve();
  const cur = loading.get(sessionId);
  if (cur && !force) return cur;
  const p = api
    .mcp(sessionId)
    .then(v => putView(sessionId, isSessionView(v) ? v : null))
    .catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 404) putView(sessionId, null);
    })
    .finally(() => loading.delete(sessionId));
  loading.set(sessionId, p);
  return p;
}

async function run(sessionId: string, fn: () => Promise<McpSessionView>): Promise<McpResult> {
  try {
    const v = await fn();
    if (isSessionView(v)) putView(sessionId, v);
    return { ok: true };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return { ok: false, code: 'unauthorized', message: '' };
    if (err instanceof ApiError && err.status === 404 && err.code === 'not_found') putView(sessionId, null);
    return { ok: false, ...mcpErrorText(err) };
  }
}

/** «Обновить»: a live process is asked for a snapshot (202); a sleeping one is not woken. */
export const refreshMcp = (sessionId: string) => run(sessionId, () => api.mcpRefresh(sessionId));

/** «Переподключить», «Включить», «Выключить» (202): the result comes as session.mcp; a sleeping session wakes up. */
export const mcpAction = (sessionId: string, server: string, action: McpAction) => run(sessionId, () => api.mcpAction(sessionId, server, action));

/** «Войти» (202): the attempt comes as WS mcp.auth with the link to the provider's page. */
export function startMcpAuth(sessionId: string, server: string): Promise<McpResult> {
  setAuthError(sessionId, server, undefined);
  return run(sessionId, () => api.mcpAuth(sessionId, server));
}

/** «Выйти» (202, mcp-auth-controls A3): the row shows «Выход…», the result comes as session.mcp. */
export function logoutServer(sessionId: string, server: string): Promise<McpResult> {
  setAuthError(sessionId, server, undefined);
  return run(sessionId, () => api.mcpLogout(sessionId, server));
}

/** The paste fallback: the address the browser opened after the sign-in (http://localhost:<port>/callback?…). */
export function submitMcpCallback(sessionId: string, server: string, callbackUrl: string): Promise<McpResult> {
  setAuthError(sessionId, server, undefined);
  return run(sessionId, () => api.mcpAuthCallback(sessionId, server, callbackUrl.trim()));
}

export function openMcpPanel(sessionId: string) {
  set({ mcpPanel: sessionId });
  void loadMcp(sessionId);
}

export function closeMcpPanel() {
  set({ mcpPanel: null });
}

// ---------- WS ----------

type McpMessage = Extract<UiServerMessage, { type: 'session.mcp' | 'mcp.auth' }>;

/** session.mcp and mcp.auth; returns false for any other message. */
export function handleMcpMessage(m: UiServerMessage): boolean {
  if (m.type !== 'session.mcp' && m.type !== 'mcp.auth') return false;
  const msg = m as McpMessage;
  switch (msg.type) {
    case 'session.mcp':
      putView(msg.sessionId, msg.mcp);
      return true;
    case 'mcp.auth': {
      const cur = get().mcp[msg.sessionId];
      if (cur) {
        const others = cur.authFlows.filter(f => f.server !== msg.server);
        putView(msg.sessionId, { ...cur, authFlows: msg.flow ? [...others, msg.flow] : others });
      } else if (cur === undefined) void loadMcp(msg.sessionId, true);
      // a flow with an error — the attempt goes on (a pasted address of another attempt); no flow — it ended
      const failure = msg.error ? hubText(msg.error, msg.errorI18n) : undefined;
      if (msg.flow) setAuthError(msg.sessionId, msg.server, failure);
      else setAuthError(msg.sessionId, msg.server, msg.result === 'ok' ? undefined : (failure ?? authResultText(msg.result)));
      return true;
    }
  }
}

/** After a WS reconnect: the loaded views may have missed events. */
export function reloadMcp(): void {
  for (const [id, v] of Object.entries(get().mcp)) if (v) void loadMcp(id, true);
}
