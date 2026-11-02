/**
 * Workspace layout operations ported from docs/prototype.html («layout operations» and drag & drop helpers) as pure
 * functions: every operation takes a workspace and returns a new one, the input is never mutated.
 * Requirements (spec workspace-ui): Мои вкладки; Сплит перетаскиванием; Место вставки на полосе вкладок;
 * Разделитель и закрытие панели; Одно окно и Вернуть разделение.
 */

export const TAB_LIMIT = 8;
export const PANE_LIMIT = 4;
export const RATIO_MIN = 0.2;
export const RATIO_MAX = 0.8;

export type PaneId = string;
export type SessionId = string;

export interface Pane {
  id: PaneId;
  tabs: SessionId[];
  active: SessionId | null;
}

export type LayoutNode = { type: 'leaf'; pane: PaneId } | { type: 'split'; dir: 'row' | 'col'; ratio: number; a: LayoutNode; b: LayoutNode };

export interface Snapshot {
  layout: LayoutNode;
  panes: Record<PaneId, Pane>;
  focus: PaneId;
}

export interface Workspace extends Snapshot {
  /** Layout remembered by «Одно окно», restored by «Вернуть разделение». */
  saved: Snapshot | null;
  /** Counter for new pane ids (keeps the functions pure). */
  seq: number;
}

export type Zone = 'left' | 'right' | 'top' | 'bottom' | 'center';
export type SplitError = 'nothing_to_split' | 'pane_limit';

const clone = <T>(v: T): T => structuredClone(v);

export function emptyWorkspace(tabs: SessionId[] = []): Workspace {
  return { panes: { p1: { id: 'p1', tabs: [...tabs], active: tabs[0] ?? null } }, layout: { type: 'leaf', pane: 'p1' }, focus: 'p1', saved: null, seq: 1 };
}

// ---------- queries ----------

export function leaves(n: LayoutNode): PaneId[] {
  return n.type === 'leaf' ? [n.pane] : [...leaves(n.a), ...leaves(n.b)];
}

export function paneOf(ws: Snapshot, sid: SessionId): Pane | undefined {
  return Object.values(ws.panes).find(p => p.tabs.includes(sid));
}

/** The session is the active tab of some pane. */
export function shownIn(ws: Snapshot, sid: SessionId): boolean {
  return Object.values(ws.panes).some(p => p.active === sid);
}

export function allTabs(ws: Snapshot): SessionId[] {
  return leaves(ws.layout).flatMap(pid => ws.panes[pid]?.tabs ?? []);
}

export function activeSession(ws: Snapshot): SessionId | null {
  return ws.panes[ws.focus]?.active ?? null;
}

/** Pane in the top-right corner of the layout — fixed place of the «Одно окно» button. */
export function topRight(n: LayoutNode): PaneId {
  return n.type === 'leaf' ? n.pane : topRight(n.dir === 'row' ? n.b : n.a);
}

function findParent(node: LayoutNode, pid: PaneId): { parent: Extract<LayoutNode, { type: 'split' }>; side: 'a' | 'b' } | null {
  if (node.type !== 'split') return null;
  if (node.a.type === 'leaf' && node.a.pane === pid) return { parent: node, side: 'a' };
  if (node.b.type === 'leaf' && node.b.pane === pid) return { parent: node, side: 'b' };
  return findParent(node.a, pid) ?? findParent(node.b, pid);
}

function replaceLeaf(node: LayoutNode, pid: PaneId, repl: LayoutNode): LayoutNode {
  if (node.type === 'leaf') return node.pane === pid ? repl : node;
  return { ...node, a: replaceLeaf(node.a, pid, repl), b: replaceLeaf(node.b, pid, repl) };
}

function replaceNode(node: LayoutNode, target: LayoutNode, repl: LayoutNode): LayoutNode {
  if (node === target) return repl;
  if (node.type === 'leaf') return node;
  return { ...node, a: replaceNode(node.a, target, repl), b: replaceNode(node.b, target, repl) };
}

// ---------- mutating helpers (operate on a private clone) ----------

function detachIn(ws: Workspace, sid: SessionId): Pane | null {
  const p = paneOf(ws, sid);
  if (!p) return null;
  const i = p.tabs.indexOf(sid);
  p.tabs.splice(i, 1);
  if (p.active === sid) p.active = p.tabs[Math.max(0, i - 1)] ?? null;
  return p;
}

function removePaneIfEmptyIn(ws: Workspace, pid: PaneId): void {
  const p = ws.panes[pid];
  if (!p || p.tabs.length || leaves(ws.layout).length === 1) return;
  const hit = findParent(ws.layout, pid);
  if (!hit) return;
  const sibling = hit.side === 'a' ? hit.parent.b : hit.parent.a;
  ws.layout = replaceNode(ws.layout, hit.parent, sibling);
  delete ws.panes[pid];
  if (ws.focus === pid) ws.focus = leaves(sibling)[0]!;
}

function newPaneIn(ws: Workspace, tabs: SessionId[]): Pane {
  ws.seq += 1;
  let id = `p${ws.seq}`;
  while (ws.panes[id]) id = `p${++ws.seq}`;
  const p: Pane = { id, tabs, active: tabs[0] ?? null };
  ws.panes[id] = p;
  return p;
}

// ---------- operations ----------

/** Removes an empty pane (not the last one); its sibling takes its place. */
export function removePaneIfEmpty(ws: Workspace, pid: PaneId): Workspace {
  const w = clone(ws);
  removePaneIfEmptyIn(w, pid);
  return w;
}

/** Removes a tab from its strip; the session itself is not touched. An emptied pane closes. */
export function closeTab(ws: Workspace, sid: SessionId): Workspace {
  const w = clone(ws);
  const p = detachIn(w, sid);
  if (p) removePaneIfEmptyIn(w, p.id);
  return w;
}

/** Makes the tab active in its pane and focuses the pane. */
export function activateTab(ws: Workspace, pid: PaneId, sid: SessionId): Workspace {
  const w = clone(ws);
  const p = w.panes[pid];
  if (!p || !p.tabs.includes(sid)) return ws;
  p.active = sid;
  w.focus = pid;
  return w;
}

export function focusPane(ws: Workspace, pid: PaneId): Workspace {
  if (ws.focus === pid || !ws.panes[pid]) return ws;
  return { ...ws, focus: pid };
}

/**
 * Opens a session from the left panel: active in the pane where it is already open, otherwise inserted right of the
 * active tab of the focused pane.
 */
export function openSession(ws: Workspace, sid: SessionId): Workspace {
  const w = clone(ws);
  const p = paneOf(w, sid);
  if (p) {
    p.active = sid;
    w.focus = p.id;
    return w;
  }
  const f = w.panes[w.focus]!;
  const at = f.active ? f.tabs.indexOf(f.active) : f.tabs.length - 1;
  f.tabs.splice(at + 1, 0, sid);
  f.active = sid;
  return w;
}

const activeIn = (s: Snapshot | null | undefined) => Object.values(s?.panes ?? {}).flatMap(p => (p.active ? [p.active] : []));

/**
 * Tab to remove when the window has more than TAB_LIMIT tabs: the one opened longest ago in this window that is not
 * `keep` and not active in any pane — of the layout after opening, of the layout before opening (`before`; a tab the
 * new one displaced in its pane was on screen a moment ago) and of the layout remembered by «Одно окно» (`saved`).
 * `openedAt` — epoch ms of the last opening in this window (missing = never).
 */
export function evictionCandidate(ws: Snapshot & { saved?: Snapshot | null }, keep: SessionId, openedAt: Record<SessionId, number>, before?: Snapshot | null): SessionId | null {
  const tabs = allTabs(ws);
  if (tabs.length <= TAB_LIMIT) return null;
  const kept = new Set([...activeIn(ws), ...activeIn(ws.saved), ...activeIn(before)]);
  const candidates = tabs.filter(id => id !== keep && !kept.has(id));
  candidates.sort((a, b) => (openedAt[a] ?? 0) - (openedAt[b] ?? 0));
  return candidates[0] ?? null;
}

/**
 * Applies the 8-tab limit of the window after `keep` was opened. `full` — nobody can be evicted (all other tabs are
 * active in panes): the caller takes the new tab back and tells the user.
 */
export function enforceLimit(ws: Workspace, keep: SessionId, openedAt: Record<SessionId, number>, before?: Snapshot | null): { ws: Workspace; evicted: SessionId | null; full: boolean } {
  if (allTabs(ws).length <= TAB_LIMIT) return { ws, evicted: null, full: false };
  const victim = evictionCandidate(ws, keep, openedAt, before);
  if (!victim) return { ws, evicted: null, full: true };
  return { ws: closeTab(ws, victim), evicted: victim, full: false };
}

/** Moves a tab into a pane before `beforeSid` (null — to the end) and makes it active there. */
export function moveToPane(ws: Workspace, sid: SessionId, pid: PaneId, beforeSid: SessionId | null = null): Workspace {
  if (!ws.panes[pid]) return ws;
  const w = clone(ws);
  const src = detachIn(w, sid);
  const p = w.panes[pid]!;
  const at = beforeSid ? p.tabs.indexOf(beforeSid) : -1;
  if (at >= 0) p.tabs.splice(at, 0, sid);
  else p.tabs.push(sid);
  p.active = sid;
  w.focus = pid;
  if (src && src.id !== pid) removePaneIfEmptyIn(w, src.id);
  return w;
}

/**
 * Splits pane `pid` at `zone` with session `sid` in the new half. The new pane becomes focused; the remembered
 * «Одно окно» layout is dropped.
 */
export function split(ws: Workspace, sid: SessionId, pid: PaneId, zone: Exclude<Zone, 'center'>): { ws: Workspace; error?: SplitError } {
  const src = paneOf(ws, sid);
  if (src && src.id === pid && src.tabs.length === 1) return { ws, error: 'nothing_to_split' };
  if (leaves(ws.layout).length >= PANE_LIMIT) return { ws, error: 'pane_limit' };
  if (!ws.panes[pid]) return { ws };
  const w = clone(ws);
  if (src) detachIn(w, sid);
  w.saved = null;
  const np = newPaneIn(w, [sid]);
  const fresh: LayoutNode = { type: 'leaf', pane: np.id };
  const old: LayoutNode = { type: 'leaf', pane: pid };
  const first = zone === 'left' || zone === 'top';
  const node: LayoutNode = { type: 'split', dir: zone === 'left' || zone === 'right' ? 'row' : 'col', ratio: 0.5, a: first ? fresh : old, b: first ? old : fresh };
  w.layout = replaceLeaf(w.layout, pid, node);
  w.focus = np.id;
  if (src && src.id !== pid) removePaneIfEmptyIn(w, src.id);
  return { ws: w };
}

/**
 * Closes a pane of several: its tabs go to the end of the neighbouring pane in the tree — the nearest leaf of its
 * sibling (UI review M6) — which becomes focused.
 */
export function closePane(ws: Workspace, pid: PaneId): Workspace {
  const hit = findParent(ws.layout, pid);
  if (!hit || !ws.panes[pid]) return ws;
  const sibling = hit.side === 'a' ? hit.parent.b : hit.parent.a;
  const near = hit.side === 'a' ? leaves(sibling)[0]! : leaves(sibling).at(-1)!;
  const w = clone(ws);
  const target = w.panes[near]!;
  target.tabs.push(...w.panes[pid]!.tabs.filter(t => !target.tabs.includes(t)));
  if (!target.active) target.active = target.tabs[0] ?? null;
  w.panes[pid]!.tabs = [];
  removePaneIfEmptyIn(w, pid);
  w.focus = target.id;
  return w;
}

/** «Одно окно»: all tabs in one pane (focused pane first), the active tab stays active, the layout is remembered. */
export function mergeAll(ws: Workspace): Workspace {
  const ids = leaves(ws.layout);
  if (ids.length < 2) return ws;
  const w = clone(ws);
  const order = [w.focus, ...ids.filter(x => x !== w.focus)];
  const active = w.panes[w.focus]?.active ?? null;
  const saved: Snapshot = clone({ layout: w.layout, panes: w.panes, focus: w.focus });
  const tabs = order.flatMap(pid => w.panes[pid]?.tabs ?? []);
  w.panes = {};
  const np = newPaneIn(w, tabs);
  np.active = active ?? tabs[0] ?? null;
  w.layout = { type: 'leaf', pane: np.id };
  w.focus = np.id;
  w.saved = saved;
  return w;
}

/**
 * «Вернуть разделение»: panes, ratios and tabs back in place. Tabs closed since the merge do not return; tabs opened
 * since go to the pane that was focused; the active tab stays active.
 */
export function restoreSplit(ws: Workspace): Workspace {
  if (!ws.saved) return ws;
  const w = clone(ws);
  const snap = w.saved!;
  const cur = w.panes[w.focus]!;
  const open = new Set(cur.tabs);
  const active = cur.active;
  const placed = new Set<SessionId>();
  for (const p of Object.values(snap.panes)) {
    p.tabs = p.tabs.filter(id => open.has(id));
    p.tabs.forEach(id => placed.add(id));
    if (!p.active || !p.tabs.includes(p.active)) p.active = p.tabs[0] ?? null;
  }
  const home = snap.panes[snap.focus] ?? Object.values(snap.panes)[0]!;
  for (const id of cur.tabs) if (!placed.has(id)) home.tabs.push(id);
  if (!home.active) home.active = home.tabs[0] ?? null;
  w.panes = snap.panes;
  w.layout = snap.layout;
  w.focus = snap.focus;
  w.saved = null;
  for (const pid of Object.keys(w.panes)) removePaneIfEmptyIn(w, pid);
  const withActive = active ? paneOf(w, active) : undefined;
  if (withActive) {
    withActive.active = active;
    w.focus = withActive.id;
  } else if (!w.panes[w.focus]) w.focus = leaves(w.layout)[0]!;
  // keep the pane counter ahead of restored ids
  w.seq = Math.max(w.seq, ...Object.keys(w.panes).map(id => Number(id.slice(1)) || 0));
  return w;
}

/** Ctrl+\\: merge when several panes, restore when one pane and a remembered layout, otherwise nothing. */
export function toggleSingle(ws: Workspace): { ws: Workspace; action: 'merged' | 'restored' | null } {
  if (leaves(ws.layout).length > 1) return { ws: mergeAll(ws), action: 'merged' };
  if (ws.saved) return { ws: restoreSplit(ws), action: 'restored' };
  return { ws, action: null };
}

export function clampRatio(r: number): number {
  return Math.min(RATIO_MAX, Math.max(RATIO_MIN, r));
}

/** Sets the ratio of the split at `path` ('' — root, 'a'/'b' steps down). */
export function setRatio(ws: Workspace, path: string, ratio: number): Workspace {
  const w = clone(ws);
  let n: LayoutNode = w.layout;
  for (const step of path) {
    if (n.type !== 'split') return ws;
    n = step === 'a' ? n.a : n.b;
  }
  if (n.type !== 'split') return ws;
  n.ratio = clampRatio(ratio);
  return w;
}

// ---------- drag & drop geometry ----------

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Nearest edge if the pointer is closer than 25% of the pane size to it, otherwise the centre. */
export function zoneOf(rect: RectLike, x: number, y: number): Zone {
  const fx = (x - rect.left) / rect.width;
  const fy = (y - rect.top) / rect.height;
  const d: [Zone, number][] = [
    ['left', fx],
    ['right', 1 - fx],
    ['top', fy],
    ['bottom', 1 - fy],
  ];
  d.sort((a, b) => a[1] - b[1]);
  const [z, v] = d[0]!;
  return v < 0.25 ? z : 'center';
}

/** Highlighted part of the pane for a zone, in percent: [left, top, width, height]. */
export function zoneBox(zone: Zone): [number, number, number, number] {
  return { left: [0, 0, 50, 100], right: [50, 0, 50, 100], top: [0, 0, 100, 50], bottom: [0, 50, 100, 50], center: [3, 3, 94, 94] }[zone] as [number, number, number, number];
}

export function zoneHint(zone: Zone, paneCount: number): string {
  if (zone === 'center') return 'Переместить в эту панель';
  if (paneCount >= PANE_LIMIT) return 'Не больше четырёх панелей';
  return `Разделить: ${{ left: 'слева', right: 'справа', top: 'сверху', bottom: 'снизу' }[zone]}`;
}

export type InsertSlot = { kind: 'before'; sessionId: SessionId } | { kind: 'after'; sessionId: SessionId } | { kind: 'empty' };

/**
 * Insertion place on a tab strip: before the first tab whose middle is right of the pointer; after the last tab when
 * the pointer is right of its middle; the whole strip when there are no tabs. The dragged tab does not count.
 */
export function insertSlot(tabs: { sessionId: SessionId; left: number; width: number }[], x: number, dragged: SessionId | null): InsertSlot {
  const rest = tabs.filter(t => t.sessionId !== dragged);
  const before = rest.find(t => x < t.left + t.width / 2);
  if (before) return { kind: 'before', sessionId: before.sessionId };
  const last = rest.at(-1);
  if (last) return { kind: 'after', sessionId: last.sessionId };
  return { kind: 'empty' };
}

/** `beforeSid` argument of moveToPane for a slot. */
export function slotTarget(slot: InsertSlot): SessionId | null {
  return slot.kind === 'before' ? slot.sessionId : null;
}

// ---------- reconciliation with «Мои вкладки» ----------

/**
 * Brings the layout in line with the server tab list: drops tabs that are no longer open, appends open tabs missing
 * from the layout (opened on another device) to the focused pane, removes emptied panes.
 */
export function reconcileTabs(ws: Workspace, open: SessionId[]): Workspace {
  const set = new Set(open);
  const w = clone(ws);
  for (const p of Object.values(w.panes)) {
    const before = p.tabs;
    p.tabs = p.tabs.filter(t => set.has(t));
    if (p.active && !p.tabs.includes(p.active)) {
      const i = before.indexOf(p.active);
      p.active = p.tabs[Math.min(Math.max(0, i - 1), p.tabs.length - 1)] ?? null;
    }
  }
  const present = new Set(allTabs(w));
  const focused = w.panes[w.focus]!;
  for (const id of open) if (!present.has(id)) focused.tabs.push(id);
  if (!focused.active) focused.active = focused.tabs[0] ?? null;
  for (const pid of Object.keys(w.panes)) removePaneIfEmptyIn(w, pid);
  // the remembered «Одно окно» layout stays as is: restoreSplit drops closed tabs itself
  // nothing changed → the same object, so subscribers (layout persistence) see no change
  return JSON.stringify(w) === JSON.stringify(ws) ? ws : w;
}

/** Validates a layout from the server; null when it is broken (then the client starts from scratch). */
export function parseWorkspace(raw: unknown): Workspace | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as Partial<Workspace>;
  if (!w.layout || !w.panes || typeof w.focus !== 'string') return null;
  const ids = (function walk(n: unknown): string[] | null {
    if (!n || typeof n !== 'object') return null;
    const node = n as LayoutNode;
    if (node.type === 'leaf') return typeof node.pane === 'string' ? [node.pane] : null;
    if (node.type === 'split') {
      const a = walk(node.a);
      const b = walk(node.b);
      return a && b && (node.dir === 'row' || node.dir === 'col') && typeof node.ratio === 'number' ? [...a, ...b] : null;
    }
    return null;
  })(w.layout);
  if (!ids || !ids.length || ids.some(id => !w.panes![id] || !Array.isArray(w.panes![id]!.tabs))) return null;
  const focus = w.panes[w.focus] ? w.focus : ids[0]!;
  return { layout: w.layout, panes: w.panes, focus, saved: w.saved ?? null, seq: typeof w.seq === 'number' ? w.seq : ids.length + 1 };
}
