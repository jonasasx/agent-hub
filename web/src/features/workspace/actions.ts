/**
 * Side effects of the workspace: hub API calls, the window's tabs and layout, /ws/ui messages.
 * Requirements (workspace-ui): Мои вкладки; Независимые окна; Раскладка нового окна и перезагрузка; Одно окно и
 * Вернуть разделение.
 * Requirements (sessions): Обмен сообщениями; Карточка разрешения; Прерывание хода; Смена режима прав и модели;
 * Продолжение (resume); Продолжение сессий, начатых вне хаба.
 * API (D10): /api/sidebar, /api/projects/:id/sessions, /api/models, /api/sessions*, /api/layout; WS /ws/ui.
 */
import type { Device, HubEvent, LayoutResponse, PermissionDecision, PatchSessionRequest, SessionView, UiServerMessage, CreateSessionRequest, SubagentView, ExtraProvider } from '../../api/types';
import { ApiError, api, type AttachmentRef } from '../../api/client';
import { sessionAlive } from '../../api/types';
import { readyRefs, sent as attachmentsSent, setNote, settleOptimistic, useAttachments } from '../images/attachments';
import type { UiSocket } from '../../api/uiSocket';
import { projectKey, useStore, type ChatLog, type PendingResume } from '../../store';
import * as L from '../layout/layout';
import { parseSnapshot, readWindow, toIso, toMs, writeWindow } from './windowState';
import { projectItems } from '../projects/projects';
import { draftArrived } from '../fork/drafts';
import { providerLoginArrived } from '../machines/ProviderLogin';
import { subTitle } from '../subagents/model';
import { loadSubscriptions } from '../subscriptions/actions';
import { loadLimits } from '../limits/actions';
import { handleMcpMessage } from '../mcp/actions';
import type { DecideExtra } from '../../api/client';

const get = () => useStore.getState();
const set = (p: Partial<ReturnType<typeof useStore.getState>>) => useStore.setState(p);

const FALLBACK_MODELS = [
  { value: 'opus', displayName: 'Opus' },
  { value: 'sonnet', displayName: 'Sonnet' },
  { value: 'haiku', displayName: 'Haiku' },
];

export const PHONE_QUERY = '(max-width: 760px)';
export function currentDevice(): Device {
  return typeof window !== 'undefined' && window.matchMedia?.(PHONE_QUERY).matches ? 'phone' : 'desktop';
}

function newUuid(): string {
  return crypto.randomUUID();
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError && err.serverMessage ? err.serverMessage : fallback;
}

function toastError(title: string, err: unknown, fallback: string) {
  // 401: the login redirect is already under way (api/client onUnauthorized)
  if (err instanceof ApiError && err.status === 401) return;
  get().pushToast({ title, text: errorText(err, fallback), color: 'var(--bad)' });
}

// ---------- sidebar ----------

export async function loadSidebar(): Promise<void> {
  const sb = await api.sidebar(get().showCron);
  const all = [...sb.now, ...sb.projects.flatMap(p => p.sessions)];
  get().setRunners(sb.runners);
  get().upsertSessions(all);
  set({ projects: sb.projects, moreSessions: {} });
}

let sidebarTimer: ReturnType<typeof setTimeout> | null = null;
/** Counters and project lists come from the hub: refresh them shortly after live changes. */
export function scheduleSidebarRefresh(delay = 1200) {
  if (sidebarTimer) clearTimeout(sidebarTimer);
  sidebarTimer = setTimeout(() => {
    sidebarTimer = null;
    loadSidebar().catch(() => undefined);
  }, delay);
}

/** Tests: a refresh scheduled by one test must not fire into the fetch mock of the next. */
export function cancelSidebarRefresh() {
  if (sidebarTimer) clearTimeout(sidebarTimer);
  sidebarTimer = null;
}

export async function toggleCron(): Promise<void> {
  set({ showCron: !get().showCron });
  await loadSidebar().catch(() => undefined);
}

/** `isOpen` — what the tree shows now (a project may be open by default). */
export function toggleProject(key: string, isOpen: boolean) {
  set({ openProjects: { ...get().openProjects, [key]: !isOpen } });
}

/** The hub accepts limit ≤ 200 on /api/projects/:id/sessions. */
export const PROJECT_PAGE = 200;

/** «ещё N»: loads the rest of the project, page by page up to the total. */
async function loadMoreInner(projectId: string | null): Promise<void> {
  const key = projectKey(projectId);
  const got: SessionView[] = [];
  set({ moreLoading: { ...get().moreLoading, [key]: true } });
  try {
    for (let offset = 5; ; offset += PROJECT_PAGE) {
      const page = await api.projectSessions(projectId, offset, PROJECT_PAGE, get().showCron);
      got.push(...page.sessions);
      if (page.sessions.length < PROJECT_PAGE || offset + PROJECT_PAGE >= page.total) break;
    }
  } catch (err) {
    toastError('Список не загружен', err, 'Хаб не ответил. Проверьте связь и попробуйте ещё раз.');
    if (!got.length) return;
  }
  get().upsertSessions(got);
  set({ moreSessions: { ...get().moreSessions, [key]: got } });
}

/** «ещё N»: loads the rest of the project, page by page up to the total; skeleton rows meanwhile. */
export async function loadMore(projectId: string | null): Promise<void> {
  const key = projectKey(projectId);
  try {
    await loadMoreInner(projectId);
  } finally {
    set({ moreLoading: { ...get().moreLoading, [key]: false } });
  }
}

/** «свернуть» after «ещё N»: back to the five freshest. */
export function collapseMore(projectId: string | null) {
  const more = { ...get().moreSessions };
  delete more[projectKey(projectId)];
  set({ moreSessions: more });
}

export async function loadModels(): Promise<void> {
  try {
    const m = await api.models();
    set({ models: m.length ? m : FALLBACK_MODELS });
  } catch {
    set({ models: FALLBACK_MODELS });
  }
}

// ---------- the window's tabs and layout (D11 «Рабочая область окна») ----------

/** A `set` of the workspace while loading it: not a change made in this window, so nothing is sent to the hub. */
let applyingLoaded = false;
/** The window changed its workspace and the hub has not got the snapshot yet. */
let dirty = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** loadWorkspace is waiting for the template: sessions opened meanwhile are applied on top of the loaded layout. */
let loading = false;
let openedWhileLoading: string[] = [];
/** Generation of loadWorkspace calls: only the result of the latest call is applied. */
let loadGen = 0;
/** Window clock (ms) of the last change in this window — `clientTs` of the PUT, so a late PUT cannot win (D10). */
let changedAt = 0;

function applyLoaded(patch: Partial<ReturnType<typeof useStore.getState>>) {
  applyingLoaded = true;
  try {
    set(patch);
  } finally {
    applyingLoaded = false;
  }
}

function snapshotBody() {
  const { device, ws, openedAt } = get();
  return {
    device,
    layout: { layout: ws.layout, panes: ws.panes, focus: ws.focus, seq: ws.seq },
    savedLayout: ws.saved,
    openedAt: toIso(openedAt, L.allTabs(ws)),
    clientTs: changedAt || Date.now(),
    ...(k => (k ? { tabKinds: k } : {}))(kindsOf(L.allTabs(ws))),
  };
}

/**
 * Start of a window or a change of its device class: the window's own copy from sessionStorage (reload) → the last
 * snapshot of this class from the hub (new window) → one empty pane. Then tabs of sessions the user no longer has are
 * dropped. On a class change the window keeps its set of tabs, the layout is the class's own.
 */
export async function loadWorkspace(device: Device = currentDevice()): Promise<void> {
  const gen = ++loadGen;
  const st = get();
  const classChange = st.layoutLoaded && st.device !== device;
  if (classChange) flushSave();
  const windowTabs = classChange ? L.allTabs(st.ws) : null;
  set({ device, layoutLoaded: false });
  // the kinds of the window's tabs survive a reload with the workspace (change `subagents` S9)
  if (!classChange) set({ tabKinds: { ...readTabKinds(), ...get().tabKinds } });
  loading = true;
  try {
    let ws: L.Workspace;
    let opened: Record<string, number> = classChange ? { ...st.openedAt } : {};
    const stored = readWindow()[device];
    if (stored) {
      const { openedAt: storedOpened, ...rest } = stored;
      ws = rest;
      opened = { ...toMs(storedOpened), ...opened };
    } else {
      let tpl: LayoutResponse | null = null;
      try {
        tpl = await api.layout(device);
      } catch {
        // no template: an empty pane
      }
      // a newer call (the window crossed 760 px again meanwhile) owns the result
      if (gen !== loadGen) return;
      const parsed = L.parseWorkspace(tpl?.layout);
      ws = parsed ? { ...parsed, saved: parseSnapshot(tpl?.savedLayout) } : L.emptyWorkspace();
      opened = { ...toMs(tpl?.openedAt), ...opened };
      if (tpl?.tabKinds) setTabKinds({ ...get().tabKinds, ...subagentKinds(tpl.tabKinds) });
    }
    if (windowTabs) ws = L.reconcileTabs(ws, windowTabs);
    applyLoaded({ ws, openedAt: opened, layoutLoaded: true });
    writeWindow(device, ws, opened);
  } finally {
    if (gen === loadGen) loading = false;
  }
  // a session opened (or dropped from the left panel) while the template was loading is not lost: it opens now, as a
  // change of this window
  const queued = openedWhileLoading;
  openedWhileLoading = [];
  for (const sid of queued) openSession(sid);
  await dropVanishedTabs();
}

/** The sessions of the open tabs fetched again (their project may have changed with the catalogue). */
async function refreshTabSessions() {
  const ids = L.allTabs(get().ws).filter(id => !get().tabKinds[id]);
  const got = await Promise.all(ids.map(id => api.session(id).catch(() => null)));
  get().upsertSessions(got.filter((s): s is SessionView => !!s));
}

/** Tabs whose session the hub no longer knows (404) are removed — an automatic change of this window. */
async function dropVanishedTabs() {
  const missing = L.allTabs(get().ws).filter(id => !get().sessions[id] && !get().subagents[id]);
  if (!missing.length) return;
  const gone = (err: unknown) => err instanceof ApiError && err.status === 404;
  // a subagent tab (change `subagents` S9): its row; a tab of unknown kind that is not a session may be a subagent too
  const asSubagent = (id: string) =>
    api.subagent(id).then(
      v => ({ id, s: null as SessionView | null, v: v as SubagentView | null, gone: false }),
      (err: unknown) => ({ id, s: null, v: null, gone: gone(err) }),
    );
  const res = await Promise.all(
    missing.map(id =>
      get().tabKinds[id] === 'subagent'
        ? asSubagent(id)
        : api.session(id).then(
            s => ({ id, s: s as SessionView | null, v: null as SubagentView | null, gone: false }),
            (err: unknown) => (gone(err) ? asSubagent(id) : { id, s: null, v: null, gone: false }),
          ),
    ),
  );
  get().upsertSessions(res.flatMap(r => (r.s ? [r.s] : [])));
  for (const r of res) if (r.v) upsertSubagent(r.v, true);
  // a restored subagent tab follows its parent session: the parent joins the subscription (review finding 3)
  if (res.some(r => r.v)) syncSocket();
  let ws = get().ws;
  for (const r of res) if (r.gone) ws = L.closeTab(ws, r.id);
  if (ws !== get().ws) set({ ws });
  for (const id of visibleSessionIds()) ensureLog(id);
}

/** PUT /api/layout: the snapshot of this window becomes the template for new windows of its class. */
/**
 * PUT /api/layout: the snapshot of this window becomes the template for new windows of its class. Always `keepalive`
 * (the body is far below the 64 KB keepalive limit), so a request in flight survives closing the page; a change made
 * after it was sent sets `dirty` again and leaves on the next timer or on pagehide. A network or 5xx failure is
 * retried with the next change or pagehide; a 4xx (the hub refuses this body) is logged and not retried.
 */
export async function saveLayout(): Promise<void> {
  if (!dirty) return;
  dirty = false;
  try {
    await api.putLayout(snapshotBody(), true);
  } catch (err) {
    if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
      console.warn(`PUT /api/layout refused: ${err.status} ${err.code}${err.serverMessage ? ` — ${err.serverMessage}` : ''}`);
      return;
    }
    dirty = true;
  }
}

function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  void saveLayout();
}

/**
 * Keeps sessionStorage in step with every change of the workspace and sends the snapshot to the hub 500 ms after a
 * change made in this window; on pagehide an unsent snapshot leaves with `keepalive`. Returns the stop function.
 */
export function startLayoutPersistence(): () => void {
  const unsub = useStore.subscribe((s, prev) => {
    if (!s.layoutLoaded || (s.ws === prev.ws && s.openedAt === prev.openedAt)) return;
    writeWindow(s.device, s.ws, s.openedAt);
    if (applyingLoaded || s.ws === prev.ws) return;
    changedAt = Date.now();
    dirty = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void saveLayout();
    }, 500);
  });
  const onHide = () => flushSave();
  window.addEventListener('pagehide', onHide);
  return () => {
    unsub();
    window.removeEventListener('pagehide', onHide);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    dirty = false;
  };
}

function clearUnread(sid: string) {
  const s = get().sessions[sid];
  if (s?.unread) get().upsertSessions([{ ...s, unread: false }]);
}

/** The toast names the evicted session; a card not loaded yet is fetched first (UI review M3b). */
function evictToast(sid: string) {
  // a subagent tab: its title from the registry, no session card fetch, and it is not in the left panel
  if (get().tabKinds[sid] === 'subagent') {
    const v = get().subagents[sid];
    const title = v ? subTitle(v) : 'Субагент';
    get().pushToast({ title: 'Вкладка убрана из полосы', text: `${title}, чат доступен из списка субагентов сессии`, color: 'var(--accent)' });
    return;
  }
  const show = (title: string) => get().pushToast({ title: 'Вкладка убрана из полосы', text: `${title}, она осталась в списке слева`, color: 'var(--accent)' });
  const known = get().sessions[sid]?.title;
  if (known) return show(known);
  api.session(sid).then(
    s => {
      get().upsertSessions([s]);
      show(s.title);
    },
    () => show(get().sessions[sid]?.title ?? 'Сессия'),
  );
}

function tabsFullToast() {
  get().pushToast({ title: 'Все 8 вкладок открыты в панелях — закройте одну', text: '', color: 'var(--warn)' });
}

/**
 * Applies a change that may add tab `sid` to the window under the 8-tab limit of this window (eviction by the
 * window's `openedAt`; active tabs of the layout and of «Одно окно» are kept). Returns false when the tab could not be
 * opened (all other tabs are active in panes).
 */
function commitWithTab(next: L.Workspace, sid: string, wasTab: boolean, extra: Partial<ReturnType<typeof useStore.getState>> = {}): boolean {
  const openedAt = { ...get().openedAt, [sid]: Date.now() };
  let ws = next;
  let evicted: string | null = null;
  if (!wasTab) {
    const lim = L.enforceLimit(next, sid, openedAt, get().ws);
    if (lim.full) {
      tabsFullToast();
      return false;
    }
    ws = lim.ws;
    evicted = lim.evicted;
  }
  if (evicted) delete openedAt[evicted];
  set({ ws, openedAt, ...extra });
  if (evicted) evictToast(evicted);
  clearUnread(sid);
  ensureLog(sid);
  return true;
}

/**
 * Opens a session from the left panel, search, a link or a toast in this window: active where it is already open,
 * otherwise a new tab right of the active one.
 */
/** While the layout is loading, a session the user opens or drops is queued and opened on top of the loaded layout. */
function queueWhileLoading(sid: string): boolean {
  if (!loading) return false;
  if (!openedWhileLoading.includes(sid)) openedWhileLoading.push(sid);
  return true;
}

const sessionInFlight = new Set<string>();

/**
 * The card of a session opened by id (a link `/s/<id>`, a notification, Ctrl+K of a session not in the panel) is
 * fetched here, whatever the socket does: before, only the end of loadWorkspace and the socket (re)open fetched the
 * cards of tabs, and a socket opened before the tab was added left «Загрузка сессии…» forever (QA M4a). A session the
 * hub does not know (404) loses its tab.
 */
// ---------- subagents (change `subagents`, design S9) ----------

const TAB_KINDS_KEY = 'agenthub.tabkinds.v1';

function subagentKinds(raw: Record<string, string> | null | undefined): Record<string, 'subagent'> {
  return Object.fromEntries(
    Object.entries(raw ?? {})
      .filter(([, k]) => k === 'subagent')
      .map(([id]) => [id, 'subagent' as const]),
  );
}

/** The kinds of this window's tabs: in the store and in sessionStorage (with the window's workspace). */
function setTabKinds(kinds: Record<string, 'subagent'>) {
  set({ tabKinds: kinds });
  try {
    sessionStorage.setItem(TAB_KINDS_KEY, JSON.stringify(kinds));
  } catch {
    // the store keeps them for this page
  }
}

export function readTabKinds(): Record<string, 'subagent'> {
  try {
    return subagentKinds(JSON.parse(sessionStorage.getItem(TAB_KINDS_KEY) ?? '{}') as Record<string, string>);
  } catch {
    return {};
  }
}

function kindsOf(tabs: string[]): Record<string, string> | null {
  const k = get().tabKinds;
  const out = Object.fromEntries(tabs.filter(id => k[id]).map(id => [id, k[id]!]));
  return Object.keys(out).length ? out : null;
}

const listsInFlight = new Set<string>();
/** Sessions whose list was asked to reload (force) while a load was in flight. */
const refetchAfter = new Set<string>();
/** Rows that came by `subagent.upsert` while the list of their session was being fetched, by session. */
const liveWhileLoading = new Map<string, Map<string, SubagentView>>();

/** The latest moment a row reflects: its last line or its end. */
const rowTime = (v: SubagentView) => Math.max(Date.parse(v.lastEventAt ?? '') || 0, Date.parse(v.endedAt ?? '') || 0);

/**
 * The GET snapshot joined with rows that came live during the request (review of subagents web, finding 1): a live
 * row not older than the snapshot's wins, a row missing from the snapshot is added, the list keeps the start order.
 */
export function joinSnapshot(snapshot: SubagentView[], live: SubagentView[]): SubagentView[] {
  const byId = new Map(snapshot.map(v => [v.id, v]));
  for (const v of live) {
    const old = byId.get(v.id);
    if (!old || rowTime(v) >= rowTime(old)) byId.set(v.id, v);
  }
  const ids = [...snapshot.map(v => v.id), ...live.filter(v => !snapshot.some(x => x.id === v.id)).map(v => v.id)];
  const rows = [...new Set(ids)].map(id => byId.get(id)!);
  return rows.sort((a, b) => byStart(a, b));
}

/** The registry of a session, loaded once per session; then `subagent.upsert` keeps it current. */
export async function loadSubagents(sessionId: string, force = false): Promise<void> {
  if (listsInFlight.has(sessionId)) {
    // a forced reload during a load (the session's liveness changed meanwhile) runs again once this one ends
    if (force) refetchAfter.add(sessionId);
    return;
  }
  if (!force && get().subagentLists[sessionId] !== undefined) return;
  listsInFlight.add(sessionId);
  liveWhileLoading.set(sessionId, new Map());
  try {
    const r = await api.subagents(sessionId);
    const rows = joinSnapshot(r.subagents, [...(liveWhileLoading.get(sessionId)?.values() ?? [])]);
    const subagents = { ...get().subagents };
    for (const v of rows) subagents[v.id] = v;
    set({
      subagents,
      subagentLists: { ...get().subagentLists, [sessionId]: rows.map(v => v.id) },
      backgroundLists: { ...get().backgroundLists, [sessionId]: r.background ?? [] },
      hubLists: { ...get().hubLists, [sessionId]: r.hubSessions ?? [] },
    });
  } catch {
    // the button shows the count from SessionView; the list tries again when opened
  } finally {
    listsInFlight.delete(sessionId);
    liveWhileLoading.delete(sessionId);
    if (refetchAfter.delete(sessionId)) void loadSubagents(sessionId, true);
  }
}

/** Forgets the list of these sessions: the next look loads it again (it is not kept current off screen). */
export function dropSubagentLists(sessionIds: string[] | 'all'): void {
  const lists = get().subagentLists;
  if (sessionIds === 'all') {
    if (Object.keys(lists).length) set({ subagentLists: {}, backgroundLists: {}, hubLists: {} });
    return;
  }
  const hit = sessionIds.filter(id => lists[id] !== undefined);
  if (!hit.length) return;
  const next = { ...lists };
  const bg = { ...get().backgroundLists };
  const hub = { ...get().hubLists };
  for (const id of hit) {
    delete next[id];
    delete bg[id];
    delete hub[id];
  }
  set({ subagentLists: next, backgroundLists: bg, hubLists: hub });
}

const byStart = (a: SubagentView | undefined, b: SubagentView | undefined) => {
  const ta = a?.startedAt ? Date.parse(a.startedAt) : Infinity;
  const tb = b?.startedAt ? Date.parse(b.startedAt) : Infinity;
  return ta - tb;
};

/** A registry row from the hub (`subagent.upsert`, GET): into the row map and, when loaded, the session's list. */
export function upsertSubagent(v: SubagentView, known = false): void {
  liveWhileLoading.get(v.sessionId)?.set(v.id, v);
  const subagents = { ...get().subagents, [v.id]: v };
  const list = get().subagentLists[v.sessionId];
  const lists = list && !list.includes(v.id) ? { ...get().subagentLists, [v.sessionId]: [...list, v.id].sort((a, b) => byStart(subagents[a], subagents[b])) } : get().subagentLists;
  set({ subagents, subagentLists: lists });
  if (known && !get().tabKinds[v.id] && L.allTabs(get().ws).includes(v.id)) setTabKinds({ ...get().tabKinds, [v.id]: 'subagent' });
}

/** The row of a subagent tab, fetched when not known; 404 (deleted with its session) drops the tab. */
export async function ensureSubagent(id: string): Promise<void> {
  if (get().subagents[id]) return;
  try {
    upsertSubagent(await api.subagent(id));
    syncSocket();
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      const ws = L.closeTab(get().ws, id);
      if (ws !== get().ws) set({ ws });
    }
  }
}

/**
 * The chat of a subagent as a tab of the active pane (spec subagents «Чат субагента только для чтения»): the same tab
 * rules as sessions (limit, eviction, split, reload); on the phone it opens over the parent's chat.
 */
export function openSubagent(v: SubagentView | string): void {
  const id = typeof v === 'string' ? v : v.id;
  if (typeof v !== 'string') upsertSubagent(v);
  if (get().tabKinds[id] !== 'subagent') setTabKinds({ ...get().tabKinds, [id]: 'subagent' });
  if (queueWhileLoading(id)) {
    set({ modal: null, inChat: true });
    return;
  }
  const wasTab = L.allTabs(get().ws).includes(id);
  set({ modal: null });
  commitWithTab(L.openSession(get().ws, id), id, wasTab, { inChat: true });
  void ensureSubagent(id);
  ensureLog(id);
}

export async function ensureSession(sid: string): Promise<void> {
  if (get().sessions[sid] || get().tabKinds[sid] || sessionInFlight.has(sid)) return;
  sessionInFlight.add(sid);
  try {
    const s = await api.session(sid);
    get().upsertSessions([s]);
    if (visibleSessionIds().includes(sid)) ensureLog(sid);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      const ws = L.closeTab(get().ws, sid);
      if (ws !== get().ws) set({ ws });
    }
  } finally {
    sessionInFlight.delete(sid);
  }
}

export function openSession(sid: string): void {
  void ensureSession(sid);
  if (queueWhileLoading(sid)) {
    set({ modal: null, inChat: true });
    return;
  }
  const wasTab = L.allTabs(get().ws).includes(sid);
  set({ modal: null });
  commitWithTab(L.openSession(get().ws, sid), sid, wasTab, { inChat: true });
}

/** Closing a tab does not stop the session and does not touch other windows. */
export function closeTab(sid: string) {
  set({ ws: L.closeTab(get().ws, sid) });
}

export function activateTab(pid: string, sid: string) {
  set({ ws: L.activateTab(get().ws, pid, sid), openedAt: { ...get().openedAt, [sid]: Date.now() }, inChat: true });
  clearUnread(sid);
  ensureLog(sid);
}

export function focusPane(pid: string) {
  const ws = L.focusPane(get().ws, pid);
  if (ws !== get().ws) set({ ws });
}

/** Drop on a tab strip or pane centre. A row dragged from the left panel becomes a tab. */
export function dropToPane(sid: string, pid: string, beforeSid: string | null) {
  // the panes of the loading layout are not known yet: the drop becomes an opening
  if (queueWhileLoading(sid)) return;
  const wasTab = L.allTabs(get().ws).includes(sid);
  commitWithTab(L.moveToPane(get().ws, sid, pid, beforeSid), sid, wasTab);
}

export function dropSplit(sid: string, pid: string, zone: Exclude<L.Zone, 'center'>) {
  if (queueWhileLoading(sid)) return;
  const wasTab = L.allTabs(get().ws).includes(sid);
  const r = L.split(get().ws, sid, pid, zone);
  if (r.error === 'nothing_to_split') return get().pushToast({ title: 'Нечего делить', text: 'В панели одна вкладка — перетащи другую' });
  if (r.error === 'pane_limit') return get().pushToast({ title: 'Не больше четырёх панелей', text: 'Перетащи вкладку в центр существующей панели' });
  commitWithTab(r.ws, sid, wasTab);
}

export function closePane(pid: string) {
  set({ ws: L.closePane(get().ws, pid) });
}

export function setRatio(path: string, ratio: number) {
  set({ ws: L.setRatio(get().ws, path, ratio) });
}

/** «Одно окно» / «Вернуть разделение» (icon or Ctrl+\\). */
export function toggleSingle() {
  const r = L.toggleSingle(get().ws);
  if (!r.action) return;
  set({ ws: r.ws });
  if (r.action === 'merged') get().pushToast({ title: 'Одно окно', text: 'Разделение запомнено — «Вернуть разделение» или Ctrl+\\' });
}

/** Ctrl+1…8: tab with this number in the focused pane. Returns false when there is no such tab. */
export function activateByNumber(n: number): boolean {
  const { ws } = get();
  const sid = ws.panes[ws.focus]?.tabs[n - 1];
  if (!sid) return false;
  activateTab(ws.focus, sid);
  return true;
}

// ---------- chat log ----------

const emptyLog = (): ChatLog => ({ events: [], before: null, loaded: false, loading: false, error: null, stale: false });

function setLog(sid: string, patch: Partial<ChatLog>) {
  const logs = get().logs;
  set({ logs: { ...logs, [sid]: { ...(logs[sid] ?? emptyLog()), ...patch } } });
}

/** Merges events by id (a resolved permission replaces the open one), keeps the order of arrival. */
export function mergeEvents(current: HubEvent[], incoming: HubEvent[], prepend = false): HubEvent[] {
  const byId = new Map(incoming.map(e => [e.id, e]));
  const kept = current.map(e => byId.get(e.id) ?? e);
  const known = new Set(current.map(e => e.id));
  const fresh = incoming.filter(e => !known.has(e.id));
  return prepend ? [...fresh, ...kept] : [...kept, ...fresh];
}

/**
 * Joins the newest page with a log that was loaded earlier and went stale while the session was off screen (the hub
 * sends session.events only to subscribers). The page overlaps the known tail → older known events stay before it;
 * no overlap (more than a page missed) → the page replaces the log and older pages are loaded again on demand.
 */
export function refreshEvents(cur: HubEvent[], page: HubEvent[]): { events: HubEvent[]; keepBefore: boolean } {
  if (!cur.length || !page.length) return { events: page.length ? page : cur, keepBefore: !page.length };
  const at = cur.findIndex(e => e.id === page[0]!.id);
  if (at < 0) return { events: page, keepBefore: false };
  // the page is authoritative (e.g. a permission resolved meanwhile); events that came over the socket during the
  // request and are not in the page stay at the end
  const inPage = new Set(page.map(e => e.id));
  return { events: [...cur.slice(0, at), ...page, ...cur.slice(at).filter(e => !inPage.has(e.id))], keepBefore: true };
}

/**
 * A page of history with retries: a long page (600 KB for a session with subagents) over a weak phone link can break
 * mid-transfer; the hub's own errors are not retried. Delays 1 s and 3 s.
 */
export async function eventsWithRetry(sid: string, before: string | null, delays = [1000, 3000]) {
  for (let i = 0; ; i++) {
    try {
      // a subagent's chat reads its own transcript (change `subagents` S7), by pages like a session's
      return await (get().tabKinds[sid] === 'subagent' ? api.subagentEvents(sid, before) : api.events(sid, before));
    } catch (err) {
      if (err instanceof ApiError || i >= delays.length) throw err;
      await new Promise(r => setTimeout(r, delays[i]));
    }
  }
}

function historyError(err: unknown): string {
  if (err instanceof ApiError) return err.serverMessage ? `Не удалось загрузить историю: ${err.serverMessage}` : `Не удалось загрузить историю (ошибка хаба ${err.status})`;
  return 'Не удалось загрузить историю: нет связи с хабом';
}

/** «Повторить» under the error of the history. */
export function retryLog(sid: string) {
  const log = get().logs[sid];
  if (!log) return;
  if (log.events.length && log.before) void loadOlder(sid);
  else {
    setLog(sid, { loaded: false, error: null });
    ensureLog(sid);
  }
}

export function ensureLog(sid: string) {
  const log = get().logs[sid];
  if (log?.loaded || log?.loading) return;
  const stale = log?.stale === true;
  // `stale` is reset here and set again by markStale if the session leaves the screen while the page loads.
  setLog(sid, { loading: true, error: null, stale: false });
  eventsWithRetry(sid, null)
    .then(page => {
      const cur = get().logs[sid]?.events ?? [];
      // Left the screen during the request: events of that gap may be neither in this page nor sent over the
      // socket (no subscription). Keep what came, but load again when shown.
      const leftMeanwhile = get().logs[sid]?.stale === true;
      const done = { loaded: !leftMeanwhile, loading: false, stale: leftMeanwhile };
      if (stale) {
        const r = refreshEvents(cur, page.events);
        setLog(sid, { events: r.events, before: r.keepBefore ? (get().logs[sid]?.before ?? null) : page.before, ...done });
      } else {
        // events that came over the socket while the page was loading are newer than the page or already in it
        setLog(sid, { events: mergeEvents(page.events, cur), before: page.before, ...done });
      }
      // Came back before the answer: ensureLog was skipped while loading, so reload now.
      if (leftMeanwhile && visibleSessionIds().includes(sid)) ensureLog(sid);
    })
    .catch((err: unknown) => {
      console.error('history of', sid, err);
      setLog(sid, { loading: false, error: historyError(err) });
    });
}

/** A session that left the screen is no longer subscribed: its log is reloaded when it is shown again. */
function markStale(ids: string[]) {
  const logs = { ...get().logs };
  let changed = false;
  for (const id of ids) {
    const l = logs[id];
    // A log still loading is marked too: its page may miss what happens while the session is off screen.
    if (l?.loaded || l?.loading) {
      logs[id] = { ...l, loaded: false, stale: true };
      changed = true;
    }
  }
  if (changed) set({ logs });
  // the subagent list of a session off screen is not kept current either (review of subagents web, finding 2)
  dropSubagentLists(ids);
}

export async function loadOlder(sid: string): Promise<void> {
  const log = get().logs[sid];
  if (!log?.before || log.loading) return;
  setLog(sid, { loading: true, error: null });
  try {
    const page = await eventsWithRetry(sid, log.before);
    setLog(sid, { events: mergeEvents(get().logs[sid]!.events, page.events, true), before: page.before, loading: false });
  } catch (err) {
    console.error('older history of', sid, err);
    setLog(sid, { loading: false, error: historyError(err) });
  }
}

// ---------- session commands ----------

function applySession(s: SessionView | undefined) {
  if (s) get().upsertSessions([s]);
  scheduleSidebarRefresh();
}

// ---------- projects (D9, D10) ----------

/** The directory for «Перенести в…»; loaded once per window, again after a failure. */
export async function loadProjectDir(): Promise<void> {
  if (get().projectDir) return;
  try {
    set({ projectDir: projectItems(await api.projects()) });
  } catch (err) {
    toastError('Список проектов не загружен', err, 'Хаб не ответил. Проверьте связь и попробуйте ещё раз.');
  }
}

/** «Перенести в…»: move = pin (`project_source = manual`); the hub sends the toast «Проект закреплён». */
export async function moveToProject(sid: string, projectId: string): Promise<void> {
  try {
    applySession(await api.setProject(sid, projectId));
  } catch (err) {
    if (err instanceof ApiError && err.code === 'unknown_project') set({ projectDir: null }); // the directory changed under us
    toastError('Сессия не перенесена', err, 'Хаб не ответил. Попробуйте ещё раз.');
  }
}

export async function setPinned(sid: string, pinned: boolean): Promise<void> {
  try {
    const before = get().sessions[sid]?.project.title;
    const next = await (pinned ? api.pin(sid) : api.unpin(sid));
    applySession(next);
    // the hub sends a toast for a pin only; unpinning says where the classifier put the session (QA M4a)
    if (!pinned && next) get().pushToast({ title: 'Проект откреплён', text: `${before ?? 'Без проекта'} → ${next.project.title}`, color: 'var(--accent)' });
  } catch (err) {
    toastError(pinned ? 'Проект не закреплён' : 'Проект не откреплён', err, 'Хаб не ответил. Попробуйте ещё раз.');
  }
}

function runnerName(sid: string): string {
  const s = get().sessions[sid];
  return (s && get().runners.find(r => r.id === s.runnerId)?.name) ?? 'машине';
}

function onResumeError(sid: string, err: unknown, pending: PendingResume) {
  if (err instanceof ApiError && err.status === 401) return;
  // images (D19): the text and the thumbnails stay in the composer, the reason goes under it
  if (err instanceof ApiError && err.code === 'agent_outdated') return setNote(sid, `Обновите агент на ${runnerName(sid)}: он не принимает изображения`);
  if (err instanceof ApiError && err.code === 'attachment_delivery_failed')
    // the text and the thumbnails stay; «Повторить» sends the same message with the same clientUuid
    return setNote(
      sid,
      `Изображения не дошли до ${runnerName(sid)} — сообщение не отправлено`,
      pending.kind === 'send'
        ? () => {
            setNote(sid, undefined);
            void sendMessage(sid, pending.text, false, pending.clientUuid, pending.attachments ?? []);
          }
        : undefined,
    );
  if (err instanceof ApiError && err.code === 'attachment_not_found') return setNote(sid, 'Хаб не нашёл загруженное изображение — уберите его и прикрепите снова');
  if (err instanceof ApiError && err.status === 413) return setNote(sid, 'Сообщение слишком большое');
  if (err instanceof ApiError && err.code === 'concurrent_external') {
    set({ pendingResume: { ...get().pendingResume, [sid]: pending } });
    return;
  }
  if (err instanceof ApiError && err.code === 'runner_offline') return toastError('Машина не в сети', err, 'Сессию можно будет продолжить, когда машина вернётся');
  if (err instanceof ApiError && err.code === 'read_only') return toastError('Только чтение', err, 'Эту сессию нельзя продолжить');
  toastError('Не отправлено', err, 'Хаб не ответил. Проверьте связь и попробуйте ещё раз.');
}

/** clientUuid of a message the hub has not accepted yet: a repeated «Отправить» reuses it (no double delivery, D19). */
const unsentUuid: Record<string, string> = {};

/**
 * Enter in the composer. A sleeping or closed session is resumed by the hub. With images (D19) the text may be empty;
 * `attachments` defaults to the uploaded images of the composer of this session.
 */
export async function sendMessage(sid: string, text: string, force = false, clientUuid = unsentUuid[sid] ?? newUuid(), attachments: AttachmentRef[] = readyRefs(sid)): Promise<boolean> {
  const t = text.trim();
  if (!t && !attachments.length) return false;
  unsentUuid[sid] = clientUuid;
  // the place of the «доставляется…» copy: after the last event known before sending (its line may even come first)
  const afterEventId = get().logs[sid]?.events.at(-1)?.id ?? null;
  try {
    const r = await api.sendMessage(sid, t, clientUuid, force, attachments);
    delete unsentUuid[sid];
    set({ drafts: { ...get().drafts, [sid]: '' }, pendingResume: { ...get().pendingResume, [sid]: undefined } });
    attachmentsSent(sid, sid, clientUuid, t, afterEventId);
    setTimeout(() => void verifyPending(sid, clientUuid), PENDING_CHECK_MS);
    applySession(r?.session);
    return true;
  } catch (err) {
    onResumeError(sid, err, { kind: 'send', text: t, clientUuid, attachments });
    return false;
  }
}

export const PENDING_CHECK_MS = 30_000;

/**
 * A copy still «доставляется…» after 30 s: the newest page of events is merged in (a missed socket message), and if the
 * session has answered since the copy was sent, the message was delivered — the copy goes away even when its line
 * could not be matched (M4b bug from Ivan).
 */
export async function verifyPending(sid: string, clientUuid: string): Promise<void> {
  const copy = useAttachments.getState().optimistic[sid]?.find(m => m.clientUuid === clientUuid);
  if (!copy) return;
  try {
    const page = await api.events(sid, null);
    const log = get().logs[sid];
    if (log) setLog(sid, { events: mergeEvents(log.events, page.events) });
  } catch {
    return; // the next send or reload settles it
  }
  const still = useAttachments.getState().optimistic[sid]?.find(m => m.clientUuid === clientUuid);
  if (!still) return;
  const events = get().logs[sid]?.events ?? [];
  const from = still.afterEventId ? events.findIndex(e => e.id === still.afterEventId) : -1;
  const answered = events.slice(from + 1).some(e => e.kind === 'line' && e.line.type === 'assistant');
  if (answered) settleOptimistic(sid, new Set([clientUuid]));
}

export async function wake(sid: string, force = false): Promise<void> {
  try {
    const r = await api.wake(sid, force);
    set({ pendingResume: { ...get().pendingResume, [sid]: undefined } });
    applySession(r?.session);
  } catch (err) {
    onResumeError(sid, err, { kind: 'wake' });
  }
}

/** «Продолжить всё равно» after the «открыта в терминале» warning. */
export async function confirmResume(sid: string): Promise<void> {
  const p = get().pendingResume[sid];
  if (!p) return;
  if (p.kind === 'send') await sendMessage(sid, p.text, true, p.clientUuid, p.attachments ?? []);
  else await wake(sid, true);
}

export function cancelResume(sid: string) {
  set({ pendingResume: { ...get().pendingResume, [sid]: undefined } });
}

export async function interrupt(sid: string): Promise<void> {
  try {
    const r = await api.interrupt(sid);
    applySession(r?.session);
  } catch (err) {
    if (!(err instanceof ApiError && err.code === 'not_running')) toastError('Не прервано', err, 'Хаб не ответил');
  }
}

export async function patchSession(sid: string, body: PatchSessionRequest): Promise<void> {
  try {
    const s = await api.patchSession(sid, body);
    applySession(s);
    // The hub broadcasts the mode toast for a live session itself (toast mode_changed).
    if (body.model) {
      const name = get().models.find(m => m.value === body.model)?.displayName ?? body.model;
      get().pushToast({ title: 'Модель изменена', text: `${name} — со следующего хода` });
    }
    if (body.idleTimeoutMin !== undefined)
      get().pushToast({ title: 'Таймаут простоя', text: body.idleTimeoutMin === 0 ? 'Сессия не будет усыпляться' : `Уснёт после ${idleLabel(body.idleTimeoutMin ?? 30)} простоя` });
  } catch (err) {
    toastError('Не изменено', err, 'Хаб не ответил');
  }
}

export function idleLabel(min: number): string {
  if (min === 0) return 'не усыплять';
  return min < 60 ? `${min} мин` : `${min / 60} ч`;
}

export async function decide(sid: string, requestId: string, decision: PermissionDecision, extra: DecideExtra = {}): Promise<void> {
  try {
    const r = await api.decide(sid, requestId, decision, extra);
    const log = get().logs[sid];
    if (log) setLog(sid, { events: mergeEvents(log.events, [{ kind: 'permission', id: `p:${r.request.requestId}`, ts: r.request.createdAt, request: r.request }]) });
  } catch (err) {
    if (err instanceof ApiError && err.code === 'already_resolved') return;
    toastError('Решение не отправлено', err, 'Хаб не ответил');
  }
}

/**
 * A fork opens next to its source (session-fork «Помета и размещение форка»): with «Открыть справа», the source in a
 * pane of this window, fewer than four panes and the desktop — a new pane right of the source's pane; otherwise a
 * tab in the active pane.
 */
export function openFork(sid: string, sourceId: string, right: boolean): void {
  scheduleSidebarRefresh(300); // the fork appears in the tree with «⑂»
  const { ws, device } = get();
  const src = L.paneOf(ws, sourceId);
  if (right && device === 'desktop' && src && L.leaves(ws.layout).length < 4 && !L.allTabs(ws).includes(sid)) {
    const r = L.split(ws, sid, src.id, 'right');
    if (!r.error && commitWithTab(r.ws, sid, false, { inChat: true, modal: null })) {
      ensureLog(sid);
      return;
    }
  }
  openSession(sid);
}

export type CreateResult = { ok: true; session: SessionView } | { ok: false; field: 'cwd' | 'runner' | 'form' | 'subscription'; message: string; retry?: boolean };

export async function createSession(body: CreateSessionRequest & { attachments?: AttachmentRef[] }, runnerName: string): Promise<CreateResult> {
  try {
    const s = await api.createSession(body);
    get().upsertSessions([s]);
    openSession(s.id);
    scheduleSidebarRefresh(300);
    return { ok: true, session: s };
  } catch (err) {
    // 422 bad_path: the path does not fit the runner's OS; the hub's Russian text goes under the field (D10)
    if (err instanceof ApiError && err.code === 'bad_path') return { ok: false, field: 'cwd', message: err.serverMessage ?? 'Путь не подходит для этой машины' };
    if (err instanceof ApiError && err.code === 'cwd_not_found') return { ok: false, field: 'cwd', message: err.serverMessage ?? `Каталог не найден на ${runnerName}` };
    if (err instanceof ApiError && err.code === 'runner_offline') return { ok: false, field: 'runner', message: `${runnerName} не в сети` };
    if (err instanceof ApiError && err.code === 'agent_outdated') return { ok: false, field: 'form', message: `Обновите агент на ${runnerName}: он не принимает изображения` };
    // claude-subscriptions: retired in another window meanwhile — the list is reloaded, the text goes under the field
    if (err instanceof ApiError && err.code === 'subscription_unavailable') {
      void loadSubscriptions();
      return { ok: false, field: 'subscription', message: 'Подписка недоступна — выберите другую' };
    }
    if (err instanceof ApiError && err.code === 'attachment_delivery_failed') return { ok: false, field: 'form', message: `Изображения не дошли до ${runnerName} — сессия не запущена`, retry: true };
    // agent-providers: the provider is not on the machine or not signed in (the hub's text names the machine)
    if (err instanceof ApiError && (err.code === 'provider_unavailable' || err.code === 'provider_login_required'))
      return { ok: false, field: 'form', message: err.serverMessage ?? `Агент недоступен на ${runnerName}` };
    return { ok: false, field: 'form', message: errorText(err, 'Хаб не ответил. Проверьте связь и попробуйте ещё раз.') };
  }
}

// ---------- /ws/ui ----------

let socket: UiSocket | null = null;
let lastSubscribe = '';
let lastPresence = '';

/** Sessions whose chat is on screen: active tab of every pane on desktop, of the focused pane on the phone. */
export function visibleSessionIds(): string[] {
  const { ws, device, inChat } = get();
  if (device === 'phone') {
    const a = L.activeSession(ws);
    return inChat && a ? [a] : [];
  }
  return L.leaves(ws.layout).flatMap(pid => (ws.panes[pid]?.active ? [ws.panes[pid]!.active!] : []));
}

/** Sends subscribe/presence when they change (and always after a reconnect). */
export function syncSocket(force = false) {
  if (!socket) return;
  const ids = visibleSessionIds();
  const { tabKinds, subagents } = get();
  const subIds = ids.filter(id => tabKinds[id] === 'subagent');
  const sessionIds = ids.filter(id => !tabKinds[id]);
  // a subagent's chat also follows its parent session: registry rows (status, time) come to the parent's subscribers
  const parents = subIds.flatMap(id => (subagents[id] ? [subagents[id]!.sessionId] : [])).filter(p => !sessionIds.includes(p));
  const sub = JSON.stringify([ids, parents]);
  if (force || sub !== lastSubscribe) {
    const [prev, prevParents]: [string[], string[]] = lastSubscribe ? (JSON.parse(lastSubscribe) as [string[], string[]]) : [[], []];
    markStale(prev.filter(id => !ids.includes(id)));
    // the parent of a subagent chat that left the screen is not subscribed any more: its list goes stale too
    dropSubagentLists((prevParents ?? []).filter(p => !parents.includes(p) && !sessionIds.includes(p)));
    // each subscribe replaces the whole set: subagentIds always go with sessionIds
    socket.send({ type: 'subscribe', sessionIds: [...sessionIds, ...parents], subagentIds: subIds });
    lastSubscribe = sub;
  }
  const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
  const pres = JSON.stringify([visible, sessionIds]);
  if (force || pres !== lastPresence) {
    socket.send({ type: 'presence', visible, activeSessionIds: visible ? sessionIds : [] });
    lastPresence = pres;
  }
}

export function attachSocket(s: UiSocket | null) {
  socket = s;
  lastSubscribe = '';
  lastPresence = '';
}

export function handleServerMessage(m: UiServerMessage) {
  // mcp-management: session.mcp and mcp.auth
  if (handleMcpMessage(m)) return;
  switch (m.type) {
    case 'runner.status':
      get().upsertRunner(m.runner);
      return;
    case 'runner.enroll':
      // change `multi-user` M4: the enrollment window follows the stages; the machine joins the panel when active
      set({ enroll: { ...get().enroll, [m.runnerId]: { stage: m.stage, runner: m.runner } } });
      get().upsertRunner(m.runner);
      return;
    case 'session.upsert': {
      const prev = get().sessions[m.session.id];
      get().upsertSessions([m.session]);
      if (m.session.status !== 'working' && get().partial[m.session.id]) set({ partial: { ...get().partial, [m.session.id]: undefined } });
      // The client can only lower a subagent's status by the session's liveness; when the session comes alive again
      // (or dies) the hub's rows are the truth: the loaded list is fetched again (review finding 4, «прерван» stuck).
      if (prev && get().subagentLists[m.session.id] !== undefined && (sessionAlive(prev) !== sessionAlive(m.session) || !!prev.externalActive !== !!m.session.externalActive)) {
        void loadSubagents(m.session.id, true);
      }
      if (!prev || prev.status !== m.session.status || prev.unread !== m.session.unread || prev.title !== m.session.title || prev.project.id !== m.session.project.id) scheduleSidebarRefresh();
      return;
    }
    case 'projects.changed':
      // The catalogue changed (M4a): many sessions may have moved; one event instead of a session.upsert each.
      set({ projectDir: null });
      scheduleSidebarRefresh(300);
      void refreshTabSessions().catch(() => undefined);
      return;
    case 'session.events': {
      const log = get().logs[m.sessionId];
      if (!log) return; // not loaded yet: the page request will bring them
      setLog(m.sessionId, { events: mergeEvents(log.events, m.events) });
      const p = get().partial[m.sessionId];
      if (p && m.events.some(e => e.kind === 'line' && (e.line.message as { id?: string } | undefined)?.id === p.messageId)) {
        set({ partial: { ...get().partial, [m.sessionId]: undefined } });
      }
      return;
    }
    case 'subagent.upsert':
      upsertSubagent(m.subagent);
      return;
    case 'subagent.events': {
      const log = get().logs[m.subagentId];
      if (log) setLog(m.subagentId, { events: mergeEvents(log.events, m.events) });
      return;
    }
    case 'session.partial': {
      const p = get().partial[m.sessionId];
      const text = p && p.messageId === m.messageId ? p.text + m.textDelta : m.textDelta;
      set({ partial: { ...get().partial, [m.sessionId]: { messageId: m.messageId, text } } });
      return;
    }
    case 'permission.request':
    case 'permission.resolved': {
      const log = get().logs[m.sessionId];
      if (!log) return;
      if (m.type === 'permission.request') {
        setLog(m.sessionId, { events: mergeEvents(log.events, [{ kind: 'permission', id: `p:${m.request.requestId}`, ts: m.request.createdAt, request: m.request }]) });
      } else {
        const events = log.events.map(e =>
          e.kind === 'permission' && e.request.requestId === m.requestId ? { ...e, request: { ...e.request, decision: m.decision, resolvedAt: e.request.resolvedAt ?? new Date().toISOString() } } : e,
        );
        setLog(m.sessionId, { events });
      }
      return;
    }
    case 'toast': {
      const kind: string = m.kind;
      const title = m.title ?? (kind === 'mode_changed' ? 'Режим прав изменён' : kind === 'project_auto' ? 'Проект определён' : kind === 'project_pinned' ? 'Проект закреплён' : 'Уведомление');
      get().pushToast({ title, text: m.text ?? '' });
      return;
    }
    case 'provider.login':
      // agent-providers: a device-code sign-in of a machine's provider ended
      providerLoginArrived({
        runnerId: m.runnerId,
        provider: m.provider as ExtraProvider,
        loginId: m.loginId,
        ok: m.ok,
        ...(m.error ? { error: m.error } : {}),
        ...(m.subscriptionId ? { subscriptionId: m.subscriptionId } : {}),
      });
      return;
    case 'handoff.draft':
      // M4b: the handoff prompt is ready or failed (D14)
      draftArrived({ id: m.draft.id, status: m.draft.status, text: m.draft.text, error: m.draft.error });
      return;
    case 'subscription_limits.changed':
      // subscription-limits (L6): no data in the message — reload GET /api/subscriptions/limits
      void loadLimits();
      return;
    case 'subscriptions.changed':
      // claude-subscriptions: the registry or the last choice changed in another window (no token in the message)
      void loadSubscriptions();
      void loadLimits(); // a retired subscription or a new token changes the snapshots too
      return;
    default:
  }
}
