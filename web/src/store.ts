// Client state (zustand, design.md D11). Side effects (API calls, persistence) live in features/*/actions.ts.
import { create } from 'zustand';
import type {
  BackgroundTaskView,
  Device,
  EnrollStage,
  HubEvent,
  HubSubagentView,
  MeResponse,
  ModelOption,
  RunnerView,
  SessionView,
  SidebarProject,
  SubagentView,
  SubscriptionsResponse,
} from './api/types';
import { emptyWorkspace, type Workspace } from './features/layout/layout';
import { regroup, type ProjectItem } from './features/projects/projects';
import type { McpSessionView, SubscriptionLimitsResponse } from './api/types';

export interface Toast {
  id: number;
  title: string;
  text: string;
  /** CSS color of the left border, e.g. var(--ok). */
  color?: string;
}

export type AuthState = { kind: 'loading' } | { kind: 'signed_in'; me: MeResponse } | { kind: 'signed_out' } | { kind: 'error'; message: string };

export interface ChatLog {
  events: HubEvent[];
  /** Cursor of the older page; null — the beginning is loaded. */
  before: string | null;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** Loaded earlier, then left the screen (not subscribed): reload and join with the newest page when shown. */
  stale?: boolean;
}

/** A resume that the hub refused with 409 concurrent_external, waiting for «Продолжить всё равно». */
export type PendingResume = { kind: 'send'; text: string; clientUuid: string; attachments?: { sha256: string }[] } | { kind: 'wake' };

/**
 * `new` may come preset by «Начать первую сессию» (runner-enrollment «Окно подключения машины»): the machine is chosen,
 * the directory is its home, `first` shows the one-line hint about projects.
 * `enroll` — «Подключить машину»; with `runnerId` — «Переподключить» / the command of a pending machine (a new code).
 */
export type Modal =
  | null
  | { type: 'new'; runnerId?: string; cwd?: string; first?: boolean }
  | { type: 'search' }
  | { type: 'fork'; sessionId: string; mode?: 'copy' | 'handoff' }
  | { type: 'enroll'; runnerId?: string };

/**
 * «Настройки» (change `multi-user`): `/settings/<tab>`; «Пользователи» — only for role admin. claude-subscriptions P12:
 * «Подписки» and «Расход» for every user, absent when the hub has no subscriptions API.
 */
export type SettingsTab = 'machines' | 'subscriptions' | 'usage' | 'users' | 'security';

/** A runner of the user that can run sessions: connected at least once and not disabled. */
export const usableRunner = (r: RunnerView) => r.state !== 'pending' && r.state !== 'disabled';

/** A switch of the subscription the hub refused with 409 turn_in_progress, waiting for «Прервать и переключить». */
export interface PendingSwitch {
  sessionId: string;
  subscriptionId: string;
  repeatLast: boolean;
}

export const projectKey = (id: string | null) => id ?? 'none';

interface State {
  auth: AuthState;
  runners: RunnerView[];
  toasts: Toast[];
  /** Every session the client knows about, by id. */
  sessions: Record<string, SessionView>;
  projects: SidebarProject[];
  /** Sessions beyond the first five, loaded by «ещё N», by project key. */
  moreSessions: Record<string, SessionView[]>;
  openProjects: Record<string, boolean>;
  /** GET /api/projects (D10), loaded when «Перенести в…» opens; null — not loaded yet. */
  projectDir: ProjectItem[] | null;
  /** A tree row that had focus and moved to another project: the tree focuses it again in its new place. */
  refocusSid: string | null;
  /** «ещё N» in flight, by project key: the tree shows skeleton rows. */
  moreLoading: Record<string, boolean>;
  showCron: boolean;
  models: ModelOption[];
  device: Device;
  ws: Workspace;
  layoutLoaded: boolean;
  /** epoch ms of the last opening of each tab in this window (eviction, D11). */
  openedAt: Record<string, number>;
  logs: Record<string, ChatLog>;
  partial: Record<string, { messageId: string; text: string } | undefined>;
  drafts: Record<string, string>;
  pendingResume: Record<string, PendingResume | undefined>;
  /** Phone: the chat is shown over the left panel. */
  inChat: boolean;
  modal: Modal;
  dragSid: string | null;
  /** Change `subagents` (design S9): registry rows by id, the rows of each session in the hub's order. */
  subagents: Record<string, SubagentView>;
  subagentLists: Record<string, string[] | undefined>;
  /** Change `background-tasks`: monitors and background commands of a session, loaded with its subagents. */
  backgroundLists: Record<string, BackgroundTaskView[] | undefined>;
  /** hub-subagents D7: child hub sessions (session_spawn) of a session, loaded with its subagents. */
  hubLists: Record<string, HubSubagentView[] | undefined>;
  /** Tabs of this window that are not sessions: `{<subagent row id>: 'subagent'}`. */
  tabKinds: Record<string, 'subagent'>;
  /** The settings screen in place of the work area; null — the work area. */
  settings: SettingsTab | null;
  /** WS runner.enroll: the last stage of each runner being connected (the enrollment window follows it). */
  enroll: Record<string, { stage: EnrollStage; runner: RunnerView } | undefined>;
  /**
   * claude-subscriptions: GET /api/subscriptions (no token inside, only `tokenHint`); null — not loaded or the hub has
   * no subscriptions API: no subscription UI at all.
   */
  subs: SubscriptionsResponse | null;
  /** GET /api/subscriptions answered 404: the hub has no subscriptions API (no sections in «Настройки»). */
  subsMissing: boolean;
  /** GET /api/subscriptions failed otherwise (network, 5xx) and nothing is loaded: «Не удалось загрузить подписки». */
  subsError: boolean;
  /** claude-subscriptions P12: the subscription whose token form «Настройки → Подписки» opens (from the `auth` note). */
  settingsTokenFor: string | null;
  pendingSwitch: PendingSwitch | null;
  /**
   * subscription-limits: GET /api/subscriptions/limits; null — not loaded or the hub has no limits API (404): no block,
   * no chip.
   */
  limits: SubscriptionLimitsResponse | null;
  /** serverTime − the browser's clock at the last load (ms): the model counts resets and cooldowns on the hub's clock. */
  limitsSkew: number;
  /** The open limits card: the subscription and what opened it (the focus goes back there). */
  limitCard: { subscriptionId: string; from: 'row' | 'chip' | 'summary' } | null;
  /** The block folded by hand; null — by the number of subscriptions (3 on the phone, 4 on the desktop). */
  limitsCollapsed: boolean | null;
  /**
   * mcp-management (design M8, M10): GET /api/sessions/:id/mcp by session, kept current by WS session.mcp / mcp.auth;
   * null — the hub answered 404 (no MCP API or not this user's session): no button, no panel.
   */
  mcp: Record<string, McpSessionView | null | undefined>;
  /** The text of the last failed sign-in or paste by `<session id>/<server>` (WS mcp.auth `error`). */
  mcpAuthErrors: Record<string, string | undefined>;
  /** The session whose MCP panel is open (the head button, the phone's «⋯», `/s/<id>?mcp=1`). */
  mcpPanel: string | null;

  setAuth(a: AuthState): void;
  setRunners(list: RunnerView[]): void;
  /** Applies a runner.status update; announces a runner that came back online. */
  upsertRunner(r: RunnerView): void;
  pushToast(t: Omit<Toast, 'id'>): void;
  dismissToast(id: number): void;
  upsertSessions(list: SessionView[]): void;
  setWs(ws: Workspace): void;
}

let toastSeq = 0;

export const useStore = create<State>()((set, get) => ({
  auth: { kind: 'loading' },
  runners: [],
  toasts: [],
  sessions: {},
  projects: [],
  moreSessions: {},
  openProjects: {},
  projectDir: null,
  refocusSid: null,
  moreLoading: {},
  showCron: false,
  models: [],
  device: 'desktop',
  ws: emptyWorkspace(),
  layoutLoaded: false,
  openedAt: {},
  logs: {},
  partial: {},
  drafts: {},
  pendingResume: {},
  inChat: false,
  modal: null,
  dragSid: null,
  subagents: {},
  subagentLists: {},
  backgroundLists: {},
  hubLists: {},
  tabKinds: {},
  settings: null,
  enroll: {},
  subs: null,
  subsMissing: false,
  subsError: false,
  settingsTokenFor: null,
  pendingSwitch: null,
  limits: null,
  limitsSkew: 0,
  limitCard: null,
  limitsCollapsed: null,
  mcp: {},
  mcpAuthErrors: {},
  mcpPanel: null,

  setAuth: auth => set({ auth }),
  // a pending machine (no agent yet) is not a machine of the panel: it lives in the enrollment window and «Машины»
  setRunners: runners => set({ runners: runners.filter(r => r.kind === 'machine' && r.state !== 'pending') }),
  upsertRunner: r => {
    if (r.kind !== 'machine') return;
    const prev = get().runners.find(x => x.id === r.id);
    if (r.state === 'pending') {
      if (prev) set({ runners: get().runners.filter(x => x.id !== r.id) });
      return;
    }
    set({ runners: prev ? get().runners.map(x => (x.id === r.id ? r : x)) : [...get().runners, r] });
    // Requirement: Онлайн-статус и переподключение — scenario «Машина возвращается».
    if (prev && !prev.online && r.online) {
      get().pushToast({ title: `${r.name} снова в сети`, text: `Сессии на ${r.name} можно продолжать`, color: 'var(--ok)' });
    }
  },
  pushToast: t => set({ toasts: [...get().toasts, { ...t, id: ++toastSeq }] }),
  dismissToast: id => set({ toasts: get().toasts.filter(t => t.id !== id) }),
  upsertSessions: list => {
    if (!list.length) return;
    const sessions = { ...get().sessions };
    let { projects, moreSessions: more } = get();
    let refocusSid = get().refocusSid;
    let openProjects = get().openProjects;
    for (const s of list) {
      const prev = sessions[s.id];
      // reclassified, moved or unpinned: the row moves to its new project in the tree now (design.md D9, D11)
      if (prev && prev.project.id !== s.project.id && (get().showCron || !s.isCron)) {
        ({ projects, more } = regroup(projects, more, prev, s));
        const focused = typeof document !== 'undefined' ? document.activeElement : null;
        if (focused instanceof HTMLElement && focused.closest('.side') && focused.dataset.sid === s.id) {
          refocusSid = s.id;
          openProjects = { ...openProjects, [projectKey(s.project.id)]: true };
        }
      }
      sessions[s.id] = s;
    }
    set({ sessions, projects, moreSessions: more, refocusSid, openProjects });
  },
  setWs: ws => set({ ws }),
}));
