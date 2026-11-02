/**
 * The MCP panel's model: pure functions over session views from the hub.
 * Covers status, problem marks, reconnect and enablement, remote auth, sleeping sessions, agent compatibility,
 * OAuth, and logout from remote MCP servers.
 */
import { MCP_PROTOCOL, MCP_TEXTS, protocolAtLeast, type RunnerView, type McpAuthFlowView, type McpServerStatus, type McpServerView, type McpSessionView } from '../../api/types';

export const MCP_STATUS_LABEL: Record<McpServerStatus, string> = {
  connected: 'подключён',
  failed: 'ошибка',
  'needs-auth': 'нужен вход',
  pending: 'подключается',
  disabled: 'выключен',
  // UI review L1: the CLI does not report a status for such a server
  unknown: 'статус не сообщается',
};

/** The colour of a status: `failed` → --bad, `needs-auth` → --warn (Requirement «Отметка проблем MCP»). */
export type McpTone = 'ok' | 'bad' | 'warn' | 'info' | 'off' | 'muted';

export const MCP_STATUS_TONE: Record<McpServerStatus, McpTone> = {
  connected: 'ok',
  failed: 'bad',
  'needs-auth': 'warn',
  pending: 'info',
  disabled: 'off',
  unknown: 'muted',
};

/** A server in `failed` or `needs-auth` (`disabled` is not a problem). */
export const isProblem = (s: Pick<McpServerView, 'status'>) => s.status === 'failed' || s.status === 'needs-auth';

/** QA fix 3: servers with a problem (failed, needs-auth) first, the CLI's order kept within each group. */
export function problemsFirst<T extends Pick<McpServerView, 'status'>>(servers: readonly T[]): T[] {
  return [...servers.filter(isProblem), ...servers.filter(s => !isProblem(s))];
}

export const problemCount = (servers: readonly Pick<McpServerView, 'status'>[]) => servers.filter(isProblem).length;

/**
 * The colour of the mark in the head and the tree: --bad when any server failed, --warn when only sign-ins are
 * missing, null — no problem. Without a loaded view only the count is known (`SessionView.mcpProblems`): --warn.
 */
export function problemTone(view: McpSessionView | null | undefined, count = 0): 'bad' | 'warn' | null {
  if (view) {
    if (view.servers.some(s => s.status === 'failed')) return 'bad';
    if (view.servers.some(s => s.status === 'needs-auth')) return 'warn';
    return null;
  }
  return count > 0 ? 'warn' : null;
}

/** The number for the mark: from the loaded snapshot, else the session's `mcpProblems`. */
export const markCount = (view: McpSessionView | null | undefined, sessionCount: number | undefined) => (view ? problemCount(view.servers) : (sessionCount ?? 0));

/**
 * The status a row shows: «подключается» while a reconnect or an enable is on the way (Requirement «Переподключение
 * MCP-сервера»: until the next snapshot), the snapshot's status otherwise.
 */
export function shownStatus(s: McpServerView): McpServerStatus {
  if (s.pendingAction === 'reconnect' || s.pendingAction === 'enable') return 'pending';
  return s.status;
}

/** The line under a row's name while the hub works on it; null — nothing in flight. */
export function pendingText(s: McpServerView): string | null {
  switch (s.pendingAction) {
    case 'reconnect':
      return 'Переподключение…';
    case 'enable':
      return 'Включение…';
    case 'disable':
      return 'Выключение…';
    case 'auth':
      return 'Готовим вход…';
    case 'wake':
      return 'Сессия просыпается…';
    case 'logout':
      return 'Выход…';
    default:
      return null;
  }
}

export const TRANSPORT_LABEL: Record<string, string> = {
  stdio: 'stdio',
  http: 'http',
  sse: 'sse',
  sdk: 'sdk',
  'claudeai-proxy': 'claude.ai',
  // UI review L1: an unknown transport is not named («другой» said nothing)
  other: '',
};

const SCOPE_LABEL: Record<string, string> = {
  user: 'пользовательский',
  project: 'проект (.mcp.json)',
  local: 'локальный',
  plugin: 'плагин',
  managed: 'управляемый',
  dynamic: 'добавлен процессом',
  enterprise: 'управляемый',
  claudeai: 'claude.ai',
};

/** The source of the server's definition; unknown values of the CLI as is. */
export const scopeLabel = (scope: string | undefined) => (scope ? (SCOPE_LABEL[scope] ?? scope) : null);

/** «http · пользовательский». */
export function kindLine(s: McpServerView): string {
  return [TRANSPORT_LABEL[s.transport] ?? s.transport, scopeLabel(s.scope)].filter(Boolean).join(' · ');
}

/** «notion 1.2.0 · 14 инструментов» for a connected server; null otherwise. */
export function infoLine(s: McpServerView): string | null {
  if (s.status !== 'connected') return null;
  const tools = `${s.toolCount} ${plural(s.toolCount, 'инструмент', 'инструмента', 'инструментов')}`;
  return s.serverInfo ? `${s.serverInfo.name} ${s.serverInfo.version} · ${tools}` : tools;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/**
 * The caption of a disabled server (Requirement «Включение и выключение MCP-сервера»): kept in the machine's config for
 * the project, or only for this process (dynamic/sdk servers). The web does not know the git root of the session's
 * directory: it names the directory of the session.
 */
/**
 * `projectRoot` — where the CLI keeps the disable (the git root of the session directory, agent 0.2.5+); an older agent
 * does not send it, so no path is named rather than the session directory, which may be a subfolder (QA fix 3).
 */
export function disabledCaption(s: McpServerView, projectRoot: string | undefined, machine: string): string {
  if (s.persistence === 'process') return 'выключен только в этом процессе';
  return projectRoot ? `выключен для проекта ${projectRoot} на ${machine}` : 'выключен для проекта этой сессии';
}

export interface RowActions {
  /**
   * «Переподключить»: a failed, connected or unknown server. Not for a disabled one, not while it connects (UI review
   * M2), not for `needs-auth` (M3: «Войти» and «Выключить» only) and not while a sign-in attempt is open (H1).
   */
  reconnect: boolean;
  /** Both buttons of a connected row are quiet (ghost, UI review M3). */
  quiet: boolean;
  /** «Выключить» / «Включить». */
  toggle: 'enable' | 'disable';
  /**
   * mcp-auth-controls A6: `signin` — «Войти» (primary): http/sse in `needs-auth` or in `failed` with an auth error;
   * `resignin` — «Войти заново» (ghost): an OAuth server in `connected`/`failed` of an agent 1.8+; null — none.
   */
  auth: 'signin' | 'resignin' | null;
  /** A6: «Выйти» — an OAuth server of an agent 1.8+, not disabled or pending, nothing in flight. */
  logout: boolean;
  /** Every button of the row is disabled (an action in flight, the session waking up, no actions at all). */
  locked: boolean;
}

/** «Войти» / «Войти заново» of a server (A6); `authControls` — the agent is 1.8+. */
export function authAction(s: McpServerView, authControls: boolean): 'signin' | 'resignin' | null {
  if (!s.canAuth || s.transport === 'stdio' || s.transport === 'claudeai-proxy') return null;
  if (s.status === 'needs-auth' || (s.status === 'failed' && s.authError)) return 'signin';
  if (authControls && s.oauth && (s.status === 'connected' || s.status === 'failed')) return 'resignin';
  return null;
}

/** «Выйти» of a server (A6). */
export const canLogout = (s: McpServerView, authControls: boolean) =>
  authControls && s.oauth && s.canAuth && (s.transport === 'http' || s.transport === 'sse') && s.status !== 'disabled' && s.status !== 'pending' && !s.pendingAction;

/** Which buttons a row offers and whether they can be pressed now. */
export function rowActions(s: McpServerView, view: Pick<McpSessionView, 'available' | 'waking'> & { authControls?: boolean }, signingIn = false): RowActions {
  const shown = shownStatus(s);
  const controls = view.authControls === true;
  return {
    reconnect: !signingIn && shown !== 'disabled' && shown !== 'pending' && shown !== 'needs-auth',
    quiet: shown === 'connected',
    toggle: s.status === 'disabled' ? 'enable' : 'disable',
    auth: authAction(s, controls),
    logout: canLogout(s, controls),
    locked: !view.available || view.waking || !!s.pendingAction,
  };
}

/** A button of a server row. */
export type RowButton = 'signin' | 'resignin' | 'reconnect' | 'toggle' | 'logout';

/**
 * UI review H1/M3/M4 (mcp-auth-controls): which buttons stay in the row and which go to its «⋯» menu. A row without
 * «Войти заново», «Выйти» or an auth error keeps the layout of mcp-management (everything visible). An OAuth row:
 * «Переподключить», «Войти заново» visible; «Выключить», «Выйти» in the menu. A server failed with an auth error: only
 * «Войти» visible; «Переподключить», «Выключить», «Выйти» (when the machine has a token) in the menu.
 */
export function rowLayout(s: McpServerView, a: RowActions): { visible: RowButton[]; menu: RowButton[] } {
  const reconnect: RowButton[] = a.reconnect ? ['reconnect'] : [];
  const logout: RowButton[] = a.logout ? ['logout'] : [];
  if (a.auth === 'signin' && s.status === 'failed') return { visible: ['signin'], menu: [...reconnect, 'toggle', ...logout] };
  if (a.auth === 'resignin' || a.logout)
    return { visible: [...(a.auth === 'signin' ? (['signin'] as RowButton[]) : []), ...reconnect, ...(a.auth === 'resignin' ? (['resignin'] as RowButton[]) : [])], menu: ['toggle', ...logout] };
  return { visible: [...(a.auth === 'signin' ? (['signin'] as RowButton[]) : []), ...reconnect, 'toggle'], menu: [] };
}

/** The confirmation of «Выйти» (Requirement «Выход из удалённого MCP»; UI review H2: the machine named twice). */
export const logoutConfirmText = (server: string, machine: string) =>
  `Выйти из ${server} на ${machine}? Вход сбросится во всех сессиях ${machine} и в новых сессиях; токен будет отозван у провайдера.`;

/**
 * A6: the hint of an attempt that dropped a sign-in — the CLI resets the saved one at the start of any attempt; the
 * server was not in `needs-auth` («Войти заново», or «Войти» of a failed one).
 */
export const resigninHint = (s: Pick<McpServerView, 'status'>) => (s.status !== 'needs-auth' ? MCP_TEXTS.resigninHint : null);

/** Is the panel only a list (no buttons at all): an outdated agent or a process outside the hub. */
export const actionsOff = (view: McpSessionView) => !view.available;

/** The text in place of the actions or the list (Requirement «Совместимость…», «MCP спящей сессии»). */
export function reasonText(view: McpSessionView): string | null {
  switch (view.reason) {
    case 'agent_outdated':
      return MCP_TEXTS.agentOutdated;
    case 'not_hub_managed':
      return MCP_TEXTS.notHubManaged;
    case 'no_snapshot':
      return view.live ? 'Статус MCP ещё не получен — нажмите «Обновить».' : 'Статус MCP ещё не получен. Он появится, когда сессия проснётся.';
    default:
      return null;
  }
}

/** The line under the panel's title: «Статус на 14:05» (UI review M7/L5; a sleeping session has its own note). */
export function snapshotLine(view: McpSessionView, clock: (iso: string | null) => string): string {
  if (view.waking) return 'Сессия просыпается…';
  return view.observedAt ? `Статус на ${clock(view.observedAt)}` : 'Статуса ещё нет';
}

/** The note of a sleeping session (UI review M7); null — the process is live or the session wakes up. */
export function sleepingNote(view: McpSessionView): string | null {
  if (view.live || view.waking) return null;
  return view.available ? 'Сессия спит. Любое действие разбудит её.' : 'Сессия спит.';
}

/**
 * UI review H3: the web's own verdict on the machine's agent for MCP, the same for the panel and «Машины». The hub
 * refuses MCP below protocol 1.7 (`agent_outdated`); `RunnerView.outdated` compares the agent with the build the hub
 * serves, so the two disagree when that build is older than 1.7 — then the agent will not update by itself.
 */
export interface AgentMcpVerdict {
  /** The agent speaks a protocol older than MCP needs (or the hub said `agent_outdated`). */
  outdated: boolean;
  /** «Агент на X1 сейчас 0.2.0 (протокол 1.6), для управления MCP нужен протокол 1.7 или новее.» */
  line: string;
  /** What happens next: updates by itself after the current turn / is updating / no such build on the hub. */
  next: string;
}

export function agentMcpVerdict(r: Pick<RunnerView, 'name' | 'agentVersion' | 'protocolVersion' | 'outdated' | 'update'> | undefined, hubSaysOutdated: boolean): AgentMcpVerdict {
  const byProtocol = !!r?.protocolVersion && !protocolAtLeast(r.protocolVersion, MCP_PROTOCOL);
  const outdated = hubSaysOutdated || byProtocol;
  const name = r?.name ?? 'машине';
  const ver = r?.agentVersion ? `${r.agentVersion}${r.protocolVersion ? ` (протокол ${r.protocolVersion})` : ''}` : 'неизвестной версии';
  const line = `Агент на ${name} сейчас ${ver}, для управления MCP нужен протокол ${MCP_PROTOCOL} или новее.`;
  let next: string;
  if (r?.update && r.update.status !== 'failed') next = `Агент обновляется до ${r.update.version}.`;
  else if (r?.update?.status === 'failed') next = 'Обновление агента не удалось — подробности на экране «Машины».';
  else if (r?.outdated) next = 'Агент обновится сам после текущего хода.';
  else next = `На хабе нет сборки агента с протоколом ${MCP_PROTOCOL}: сам агент не обновится, нужна новая сборка агента на хабе.`;
  return { outdated, line, next };
}

/** «4:59» until the attempt ends; null — it has ended. */
export function flowLeft(flow: Pick<McpAuthFlowView, 'expiresAt'>, now: number): string | null {
  const ms = Date.parse(flow.expiresAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const sec = Math.ceil(ms / 1000);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/** The text of an ended attempt (WS mcp.auth `result`) when the hub sent none. */
export function authResultText(result: string | undefined): string {
  switch (result) {
    case 'expired':
      return 'Время попытки входа вышло — нажмите «Войти» ещё раз';
    case 'process_exited':
      return MCP_TEXTS.processExited;
    default:
      return 'Вход не выполнен';
  }
}

/**
 * The paste fallback (Requirement «Вход в удалённый MCP…»): a first check in the browser that the text is an address;
 * the hub checks the host, the port and the state (400 bad_callback_url with the text of the spec).
 */
export function pasteProblem(text: string): string | null {
  const t = text.trim();
  if (!t) return 'Вставьте адрес из строки браузера';
  try {
    const u = new URL(t);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Это не адрес страницы — скопируйте всю строку из адресной строки браузера';
  } catch {
    return 'Это не адрес страницы — скопируйте всю строку из адресной строки браузера';
  }
  return null;
}

export const authKey = (sessionId: string, server: string) => `${sessionId}/${server}`;
