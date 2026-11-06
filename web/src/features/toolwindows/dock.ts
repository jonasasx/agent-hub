/**
 * Layout model of the tool windows (change tool-windows-file-explorer, design D5): pure functions over `Dock`.
 * Each side is a column of slots; a slot holds one or more windows as tabs, one of them is active. A window sits in
 * exactly one slot (a hidden window is a closed slot: its icon stays in the rail); an empty slot disappears; `act ∈ ids`.
 */
import { SIDE_DEFAULT } from '../sidebar/sideWidth';

export type WinId = 'sessions' | 'files' | 'machines' | 'subs';
export type Side = 'left' | 'right';

export interface Slot {
  ids: WinId[];
  act: WinId;
  closed: boolean;
  /** Height in px set by hand with the splitter; none — by content (`fit` windows) or flexible. */
  h?: number;
}

export interface Dock {
  v: 1;
  left: Slot[];
  right: Slot[];
  width: { left: number; right: number };
}

export const WIN_IDS: readonly WinId[] = ['sessions', 'files', 'machines', 'subs'];
export const SIDES: readonly Side[] = ['left', 'right'];
export const WIN_TITLE: Record<WinId, string> = { sessions: 'Сессии', files: 'Файлы', machines: 'Машины', subs: 'Подписки' };
/** The minimal height of a slot, px. */
export const SLOT_MIN = 64;

export const isWinId = (x: unknown): x is WinId => typeof x === 'string' && (WIN_IDS as readonly string[]).includes(x);

const slot = (ids: WinId[], act: WinId = ids[0]!): Slot => ({ ids, act, closed: false });

export function defaultDock(leftWidth = SIDE_DEFAULT): Dock {
  return {
    v: 1,
    left: [slot(['sessions', 'files'], 'sessions'), slot(['machines']), slot(['subs'])],
    right: [],
    width: { left: leftWidth, right: SIDE_DEFAULT },
  };
}

const clone = (d: Dock): Dock => JSON.parse(JSON.stringify(d)) as Dock;

export interface Where {
  side: Side;
  si: number;
  i: number;
  slot: Slot;
}

export function where(d: Dock, id: WinId): Where | null {
  for (const side of SIDES) {
    const si = d[side].findIndex(s => s.ids.includes(id));
    if (si >= 0) {
      const s = d[side][si]!;
      return { side, si, i: s.ids.indexOf(id), slot: s };
    }
  }
  return null;
}

/** The window a slot shows now; null — the slot is closed. */
export const openOf = (s: Slot): WinId | null => (s.closed ? null : s.ids.includes(s.act) ? s.act : s.ids[0]!);

export function isOpen(d: Dock, id: WinId): boolean {
  const w = where(d, id);
  return !!w && openOf(w.slot) === id;
}

/** Slots of a side that show a window, with their indices in the column. */
export function openSlots(d: Dock, side: Side): { id: WinId; si: number; slot: Slot }[] {
  return d[side].flatMap((s, si) => {
    const id = openOf(s);
    return id ? [{ id, si, slot: s }] : [];
  });
}

export const sideOpen = (d: Dock, side: Side): boolean => openSlots(d, side).length > 0;

/** A click on a rail icon: open the window, or close it when it is the one shown. */
export function toggle(d: Dock, id: WinId): Dock {
  const n = clone(d);
  const w = where(n, id);
  if (!w) return d;
  if (openOf(w.slot) === id) w.slot.closed = true;
  else {
    w.slot.act = id;
    w.slot.closed = false;
  }
  return n;
}

/** Shows the window (restores a hidden one, activates its tab); an open window stays as it is. */
export function show(d: Dock, id: WinId): Dock {
  return isOpen(d, id) ? d : toggle(d, id);
}

/** «Скрыть окно»: the slot closes, its icons stay in the rail. */
export function hide(d: Dock, id: WinId): Dock {
  const n = clone(d);
  const w = where(n, id);
  if (!w) return d;
  w.slot.closed = true;
  return n;
}

/** Where a window goes: into slot `si` of a side (at tab position `idx`), or as a new slot inserted at position `si`. */
export interface Target {
  side: Side;
  si: number;
  idx?: number | null;
  asNew?: boolean;
}

/** Moves a window to a target (ported from the prototype `move`). */
export function move(d: Dock, id: WinId, t: Target): Dock {
  const n = clone(d);
  const from = where(n, id);
  if (!from) return d;
  const col = n[t.side];
  const target = t.asNew ? null : (col[t.si] ?? null);
  const before = t.asNew ? (col[t.si] ?? null) : null;
  if (target && target === from.slot && target.ids.length === 1) return d;
  let idx = t.idx ?? null;
  if (target === from.slot && idx != null && idx > from.i) idx--;
  from.slot.ids.splice(from.i, 1);
  let removedAt = -1;
  if (!from.slot.ids.length) {
    removedAt = n[from.side].indexOf(from.slot);
    n[from.side].splice(removedAt, 1);
  } else {
    delete from.slot.h;
  }
  if (target) {
    target.ids.splice(idx == null ? target.ids.length : Math.min(idx, target.ids.length), 0, id);
    target.act = id;
    target.closed = false;
    delete target.h;
  } else {
    let at = col.length;
    if (before) at = col.includes(before) ? col.indexOf(before) : removedAt;
    col.splice(at, 0, slot([id]));
  }
  return n;
}

export const moveToSlot = (d: Dock, id: WinId, side: Side, si: number, idx: number | null = null): Dock => move(d, id, { side, si, idx });
export const moveToNewSlot = (d: Dock, id: WinId, side: Side, at: number): Dock => move(d, id, { side, si: at, asNew: true });

/** Moves a window to another tab position inside its own slot. */
export function reorder(d: Dock, id: WinId, idx: number): Dock {
  const w = where(d, id);
  if (!w) return d;
  return move(d, id, { side: w.side, si: w.si, idx });
}

/** The pair of heights after dragging the splitter by `dy` px: none of them gets below `SLOT_MIN`. */
export function clampPair(ha: number, hb: number, dy: number): [number, number] {
  const d = Math.max(SLOT_MIN - ha, Math.min(hb - SLOT_MIN, dy));
  return [Math.round(ha + d), Math.round(hb - d)];
}

/** Sets the heights of two open slots of a side from their heights `ha`, `hb` at the start and the shift `dy`. */
export function resize(d: Dock, side: Side, a: number, b: number, ha: number, hb: number, dy: number): Dock {
  const n = clone(d);
  const sa = n[side][a];
  const sb = n[side][b];
  if (!sa || !sb) return d;
  const [na, nb] = clampPair(ha, hb, dy);
  sa.h = na;
  sb.h = nb;
  return n;
}

export function setWidth(d: Dock, side: Side, w: number): Dock {
  if (d.width[side] === w) return d;
  return { ...clone(d), width: { ...d.width, [side]: w } };
}

export function reset(): Dock {
  return defaultDock();
}

/**
 * A stored value to a valid dock: unknown windows are dropped, duplicates keep their first place, the windows of the
 * four that are missing are added hidden (a closed slot at the end of the left column), `act` is repaired. A wrong
 * shape or version — null.
 */
export function parseDock(raw: unknown, clampWidth: (w: number) => number = w => w): Dock | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { v?: unknown; left?: unknown; right?: unknown; width?: unknown };
  if (o.v !== 1 || !Array.isArray(o.left) || !Array.isArray(o.right)) return null;
  const seen = new Set<WinId>();
  const side = (list: unknown[]): Slot[] => {
    const out: Slot[] = [];
    for (const x of list) {
      if (!x || typeof x !== 'object') continue;
      const s = x as { ids?: unknown; act?: unknown; closed?: unknown; h?: unknown };
      if (!Array.isArray(s.ids)) continue;
      const ids = s.ids.filter(isWinId).filter(id => !seen.has(id));
      for (const id of ids) seen.add(id);
      if (!ids.length) continue;
      const item: Slot = { ids, act: isWinId(s.act) && ids.includes(s.act) ? s.act : ids[0]!, closed: s.closed === true };
      if (typeof s.h === 'number' && Number.isFinite(s.h) && s.h >= SLOT_MIN) item.h = Math.round(s.h);
      out.push(item);
    }
    return out;
  };
  const left = side(o.left);
  const right = side(o.right);
  for (const id of WIN_IDS) if (!seen.has(id)) left.push({ ids: [id], act: id, closed: true });
  const w = (o.width ?? {}) as { left?: unknown; right?: unknown };
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? clampWidth(x) : SIDE_DEFAULT);
  return { v: 1, left, right, width: { left: num(w.left), right: num(w.right) } };
}
