/**
 * State of the «Файлы» window and of the file tabs (change tool-windows-file-explorer, design D5/D6).
 * Requirements (file-explorer): Окно «Файлы» и источники; Ленивое дерево; Файловые вкладки; Машина не в сети и ошибки.
 * - the source is a session or a machine; the session chip follows the last active session, «↑» lifts the root;
 * - expanded folders, the selection and the lifted root are kept per source;
 * - listings are loaded one folder at a time and cached by (machine, session, hidden, path);
 * - the pinned file tabs and the session that opened a file live here and in sessionStorage (they are local to the window).
 */
import { create } from 'zustand';
import type { FsListResponse } from '@agent-hub/shared';
import type { RunnerView, SessionView } from '../../api/types';
import { useStore } from '../../store';
import { isFileTab, type Workspace } from '../layout/layout';
import { FsError, fsList } from './filesApi';
import { isInside, pathKey } from './paths';
import { resolveSource, type Source, type SourceChoice } from './source';

export const FILES_KEY = 'agenthub.files.v1';

export type Listing = { status: 'loading' } | { status: 'ok'; data: FsListResponse } | { status: 'error'; code: FsError['code']; text: string };

interface Persisted {
  choice: SourceChoice;
  rootUp: Record<string, string>;
  expanded: Record<string, string[]>;
  selected: Record<string, string | null>;
  hidden: boolean;
  pinned: string[];
  tabSession: Record<string, string>;
}

export interface FilesState extends Persisted {
  listings: Record<string, Listing>;
  /** Machines that answered `capability_unavailable`. */
  outdated: Record<string, boolean>;
  /** Grows when a machine comes online: the viewers of its files reload. */
  connectNonce: number;
  /** «Показать в дереве» and the crumb: the tree expands to the path, selects it and scrolls. */
  reveal: { runnerId: string; sessionId?: string; path: string; dir: boolean; nonce: number } | null;
  setChoice: (c: SourceChoice) => void;
  liftRoot: (src: Source) => void;
  toggleExpanded: (src: Source, path: string) => void;
  setExpanded: (src: Source, paths: string[]) => void;
  select: (src: Source, path: string | null) => void;
  setHidden: (v: boolean) => void;
  refresh: (src: Source) => void;
  pin: (tabId: string) => void;
  unpin: (tabId: string) => void;
  rememberSession: (tabId: string, sessionId: string | undefined) => void;
  requestReveal: (r: { runnerId: string; sessionId?: string; path: string; dir?: boolean }) => void;
}

const DEFAULTS: Persisted = { choice: { kind: 'session' }, rootUp: {}, expanded: {}, selected: {}, hidden: false, pinned: [], tabSession: {} };

function readPersisted(): Persisted {
  try {
    const raw = sessionStorage.getItem(FILES_KEY);
    if (!raw) return DEFAULTS;
    const o = JSON.parse(raw) as Partial<Persisted>;
    return {
      choice: o.choice?.kind === 'machine' && typeof o.choice.runnerId === 'string' ? o.choice : DEFAULTS.choice,
      rootUp: o.rootUp && typeof o.rootUp === 'object' ? o.rootUp : {},
      expanded: o.expanded && typeof o.expanded === 'object' ? o.expanded : {},
      selected: o.selected && typeof o.selected === 'object' ? o.selected : {},
      hidden: o.hidden === true,
      pinned: Array.isArray(o.pinned) ? o.pinned.filter((x): x is string => typeof x === 'string') : [],
      tabSession: o.tabSession && typeof o.tabSession === 'object' ? o.tabSession : {},
    };
  } catch {
    return DEFAULTS;
  }
}

function persist(s: Persisted) {
  try {
    const { choice, rootUp, expanded, selected, hidden, pinned, tabSession } = s;
    sessionStorage.setItem(FILES_KEY, JSON.stringify({ choice, rootUp, expanded, selected, hidden, pinned, tabSession }));
  } catch {
    // blocked storage: the memory state works
  }
}

/** The key of a cached listing. */
export function listingKey(runnerId: string, sessionId: string | undefined, hidden: boolean, path: string): string {
  return `${runnerId}|${sessionId ?? ''}|${hidden ? 1 : 0}|${pathKey(path)}`;
}

/**
 * The session to send with a request for `path`: the hub takes the cwd as the root of a session. A path that the root
 * lifted by «↑» opened (above the cwd) goes without the session, with the home folder as the root.
 */
export function sessionFor(src: Pick<Source, 'sessionId' | 'base'>, path: string): string | undefined {
  if (!src.sessionId) return undefined;
  return src.base && isInside(src.base, path) ? src.sessionId : undefined;
}

export const useFiles = create<FilesState>((set, get) => ({
  ...readPersisted(),
  listings: {},
  outdated: {},
  connectNonce: 0,
  reveal: null,
  setChoice: choice => set({ choice }),
  liftRoot: src => {
    if (src.up) set({ rootUp: { ...get().rootUp, [src.key]: src.up } });
  },
  toggleExpanded: (src, path) => {
    const cur = get().expanded[src.key] ?? [];
    const k = pathKey(path);
    const next = cur.some(p => pathKey(p) === k) ? cur.filter(p => pathKey(p) !== k) : [...cur, path];
    set({ expanded: { ...get().expanded, [src.key]: next } });
  },
  setExpanded: (src, paths) => {
    const cur = get().expanded[src.key] ?? [];
    const known = new Set(cur.map(pathKey));
    const add = paths.filter(p => !known.has(pathKey(p)));
    if (add.length) set({ expanded: { ...get().expanded, [src.key]: [...cur, ...add] } });
  },
  select: (src, path) => set({ selected: { ...get().selected, [src.key]: path } }),
  setHidden: hidden => set({ hidden }),
  refresh: src => {
    const prefix = `${src.runnerId}|`;
    const listings = Object.fromEntries(Object.entries(get().listings).filter(([k]) => !k.startsWith(prefix)));
    const outdated = { ...get().outdated };
    delete outdated[src.runnerId];
    set({ listings, outdated });
  },
  pin: id => {
    if (!get().pinned.includes(id)) set({ pinned: [...get().pinned, id] });
  },
  unpin: id => {
    if (get().pinned.includes(id)) set({ pinned: get().pinned.filter(x => x !== id) });
  },
  rememberSession: (id, sessionId) => {
    const next = { ...get().tabSession };
    if (sessionId) next[id] = sessionId;
    else delete next[id];
    set({ tabSession: next });
  },
  requestReveal: r => set({ reveal: { ...r, dir: r.dir === true, nonce: (get().reveal?.nonce ?? 0) + 1 } }),
}));

useFiles.subscribe(s => persist(s));

const inflight = new Map<string, Promise<void>>();

/** Loads one level of a folder into the cache. No-op when it is cached, failed or on its way; `force` (a retry) loads again. */
export function loadDir(runnerId: string, path: string | undefined, sessionId: string | undefined, force = false): Promise<void> {
  const hidden = useFiles.getState().hidden;
  const key = listingKey(runnerId, sessionId, hidden, path ?? '');
  const cur = useFiles.getState().listings[key];
  if (!force && cur) return inflight.get(key) ?? Promise.resolve();
  const put = (l: Listing) => useFiles.setState(s => ({ listings: { ...s.listings, [key]: l } }));
  put({ status: 'loading' });
  const p = fsList(runnerId, { path, sessionId, hidden })
    .then(data => put({ status: 'ok', data }))
    .catch((err: unknown) => {
      const e = err instanceof FsError ? err : new FsError('network');
      if (e.code === 'capability_unavailable') useFiles.setState(s => ({ outdated: { ...s.outdated, [runnerId]: true } }));
      put({ status: 'error', code: e.code, text: e.text('dir') });
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ---------- the session the window follows ----------

/**
 * The last active session of the window: the active tab of the focused pane when it is a session, else the session tab
 * opened last. Null — the window has no session tab.
 */
export function lastActiveSession(ws: Workspace, openedAt: Record<string, number>, tabKinds: Record<string, string>, sessions: Record<string, SessionView>): string | null {
  const isSession = (id: string) => !isFileTab(id) && !tabKinds[id] && !!sessions[id];
  const active = ws.panes[ws.focus]?.active;
  if (active && isSession(active)) return active;
  const all = Object.values(ws.panes).flatMap(p => p.tabs.filter(isSession));
  all.sort((a, b) => (openedAt[b] ?? 0) - (openedAt[a] ?? 0));
  return all[0] ?? null;
}

/** The source of the window right now (components subscribe to the parts they need and call this). */
export function currentSource(): Source | null {
  const st = useStore.getState();
  const f = useFiles.getState();
  return resolveSource({
    choice: f.choice,
    sessionId: lastActiveSession(st.ws, st.openedAt, st.tabKinds, st.sessions),
    sessions: st.sessions,
    runners: st.runners,
    rootUp: f.rootUp,
    outdated: f.outdated,
  });
}

// ---------- a machine comes online ----------

function onlineSet(runners: RunnerView[]): Set<string> {
  return new Set(runners.filter(r => r.online).map(r => r.id));
}

/**
 * A machine that went online: its error listings go away (the tree loads them again) and the viewers reload their file
 * (Requirement: Машина не в сети и ошибки — «Машина вернулась в сеть»).
 */
export function startOnlineWatch(): () => void {
  let was = onlineSet(useStore.getState().runners);
  return useStore.subscribe(s => {
    if (s.runners === undefined) return;
    const now = onlineSet(s.runners);
    const came = [...now].filter(id => !was.has(id));
    was = now;
    if (!came.length) return;
    useFiles.setState(f => {
      const prefixes = came.map(id => `${id}|`);
      const listings = Object.fromEntries(Object.entries(f.listings).filter(([k]) => !prefixes.some(p => k.startsWith(p))));
      const outdated = { ...f.outdated };
      for (const id of came) delete outdated[id];
      return { listings, outdated, connectNonce: f.connectNonce + 1 };
    });
  });
}

startOnlineWatch();

/** Tests: back to the clean state. */
export function resetFiles(): void {
  inflight.clear();
  useFiles.setState({ ...DEFAULTS, listings: {}, outdated: {}, connectNonce: 0, reveal: null });
}
