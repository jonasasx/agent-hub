/**
 * Drop zones of a dragged tool window (Requirement «Перетаскивание окон»), ported from the prototype `dropTarget`:
 * - a group of rail icons: a tab of that slot, the line shows the place among the icons;
 * - a gap between the groups: a new slot there;
 * - the top or bottom part of an open window (≤30 % of its height or 70 px): a new slot above or below;
 * - the middle of a window: a tab of its slot;
 * - the edge of the app (90 px) while the right side is not used (no window, not even a hidden one): a new slot on the right.
 * The geometry is read from the DOM into a plain `Geo` first, so the zones are plain functions of numbers.
 */
import { WIN_TITLE, openSlots, where, type Dock, type Side, type Target, type WinId } from './dock';

/** The pointer must move this far before a press becomes a drag. */
export const DRAG_THRESHOLD = 6;
/** The distance from the right edge of the app that offers a new window on the right, px. */
export const EDGE_ZONE = 90;

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Geo {
  app: Box;
  rails: { side: Side; box: Box; groups: { si: number; box: Box; icons: { id: WinId; box: Box }[] }[] }[];
  panels: { side: Side; si: number; id: WinId; box: Box }[];
}

/** Where the frame goes, relative to the app. */
export interface Rect {
  l: number;
  t: number;
  w: number;
  h: number;
}

export interface DropTarget extends Target {
  rect: Rect;
  label: string;
  /** The frame is a line between rail icons or groups. */
  line?: boolean;
  /** The line belongs to the right rail: its label is on the left of the line. */
  rt?: boolean;
}

const w = (b: Box) => b.right - b.left;
const h = (b: Box) => b.bottom - b.top;
const inside = (b: Box, x: number, y: number, pad = 0) => x >= b.left - pad && x <= b.right + pad && y >= b.top && y <= b.bottom;
const sideName = (side: Side) => (side === 'left' ? 'Слева' : 'Справа');
const names = (list: WinId[]) => list.map(id => `«${WIN_TITLE[id]}»`).join(', ');
const tabTo = (list: WinId[]) => `Вкладкой к ${list.length > 1 ? 'окнам' : 'окну'} ${names(list)}`;

/** The share of a window's height that counts as its top or bottom edge. */
export function edgeShare(height: number): number {
  return Math.min(0.3, 70 / height);
}

export function dropTarget(dock: Dock, dragId: WinId, x: number, y: number, geo: Geo, edgeWidth = 320): DropTarget | null {
  const ar = geo.app;
  // 1. a rail: onto a group's icons — a tab there; onto a gap between groups — a new window in the column
  for (const rail of geo.rails) {
    const rb = rail.box;
    if (!inside(rb, x, y, 6)) continue;
    const { side } = rail;
    const col = dock[side];
    const line = (ly: number, label: string): Pick<DropTarget, 'line' | 'rt' | 'rect' | 'label'> => ({
      line: true,
      rt: side === 'right',
      rect: { l: rb.left - ar.left + 6, t: ly - ar.top, w: w(rb) - 12, h: 2 },
      label,
    });
    for (const g of rail.groups) {
      if (y < g.box.top - 3 || y > g.box.bottom + 3) continue;
      const icons = g.icons.filter(i => i.id !== dragId);
      if (!icons.length) return null; // its own single-window group: nothing to change
      let k = icons.findIndex(i => y < i.box.top + h(i.box) / 2);
      if (k < 0) k = icons.length;
      const ly = k < icons.length ? icons[k]!.box.top - 3 : icons[icons.length - 1]!.box.bottom + 1;
      const slot = col[g.si];
      if (!slot) return null;
      const idx = k < icons.length ? slot.ids.indexOf(icons[k]!.id) : slot.ids.length;
      return { side, si: g.si, idx, ...line(ly, tabTo(slot.ids.filter(o => o !== dragId))) };
    }
    const si = rail.groups.filter(g => g.box.top + h(g.box) / 2 < y).length;
    const prev = rail.groups[si - 1]?.box;
    const next = rail.groups[si]?.box;
    const ly = prev && next ? (prev.bottom + next.top) / 2 : prev ? prev.bottom + 8 : next ? next.top - 8 : rb.top + 60;
    return { side, si, asNew: true, ...line(ly, `${sideName(side)} · новое окно в столбике`) };
  }
  // 2. an open window: its top or bottom edge — a new window above/below; the middle — a tab
  for (const p of geo.panels) {
    const b = p.box;
    if (!inside(b, x, y)) continue;
    const ry = (y - b.top) / h(b);
    const edge = edgeShare(h(b));
    const rect: Rect = { l: b.left - ar.left, t: b.top - ar.top, w: w(b), h: h(b) };
    if (ry < edge || ry > 1 - edge) {
      const below = ry > 0.5;
      rect.h = Math.max(28, Math.min(h(b) / 2, 120));
      if (below) rect.t += h(b) - rect.h;
      return { side: p.side, si: p.si + (below ? 1 : 0), asNew: true, rect, label: `${below ? 'Под' : 'Над'} «${WIN_TITLE[p.id]}»` };
    }
    const own = where(dock, dragId);
    if (p.id === dragId && own && own.slot.ids.length === 1) return null;
    return { side: p.side, si: p.si, idx: null, rect, label: `Вкладкой к окну «${WIN_TITLE[p.id]}»` };
  }
  // 3. the right edge while the right side is not used
  if (!dock.right.length && ar.right - x < EDGE_ZONE) {
    return { side: 'right', si: dock.right.length, asNew: true, rect: { l: w(ar) - edgeWidth, t: 0, w: edgeWidth, h: h(ar) }, label: 'Новое окно справа' };
  }
  return null;
}

const box = (el: Element): Box => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
};

/** The geometry of the rails and the open windows inside `root` (the element the frame is positioned in). */
export function readGeo(root: HTMLElement): Geo {
  const rails = [...root.querySelectorAll<HTMLElement>('.tw-rail')].map(r => ({
    side: r.dataset.side as Side,
    box: box(r),
    groups: [...r.querySelectorAll<HTMLElement>('.tw-rg')].map(g => ({
      si: Number(g.dataset.si),
      box: box(g),
      icons: [...g.querySelectorAll<HTMLElement>('.tw-ri[data-id]')].map(i => ({ id: i.dataset.id as WinId, box: box(i) })),
    })),
  }));
  const panels = [...root.querySelectorAll<HTMLElement>('.tw-pnl[data-si]')].map(p => ({ side: p.dataset.side as Side, si: Number(p.dataset.si), id: p.dataset.id as WinId, box: box(p) }));
  return { app: box(root), rails, panels };
}

/** True when the dock has a window open on the side: its column is on the screen. */
export const hasColumn = (dock: Dock, side: Side): boolean => openSlots(dock, side).length > 0;
