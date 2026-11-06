// Requirement (sidebar-resize): Ширина левой панели — set by dragging the inner edge of a column of tool windows, stored
// per device. Two sides since the change tool-windows-file-explorer (design D8): the widths live in the dock
// (`ah-tool-windows.v1`); `ah-side-width` is only read once, to start the left column with the width it had.
export const SIDE_DEFAULT = 320;
export const SIDE_MIN = 220;
export const SIDE_MAX = 560;
/** The work area keeps at least this much room next to the open columns. */
export const PANE_MIN = 480;
/** The width of an icon rail, px: both rails sit outside the columns. */
export const RAIL_W = 44;
const LEGACY_KEY = 'ah-side-width';

export type WidthSide = 'left' | 'right';

/** `reserved` — what else takes the width (the rails, the other open column). */
export function clampSideWidth(w: number, viewport = window.innerWidth, reserved = 0): number {
  const max = Math.max(SIDE_MIN, Math.min(SIDE_MAX, viewport - PANE_MIN - reserved));
  return Math.round(Math.min(max, Math.max(SIDE_MIN, w)));
}

/** The width of the left panel before the tool windows (`ah-side-width`); the default when there is none. */
export function storedSideWidth(): number {
  try {
    const v = Number(localStorage.getItem(LEGACY_KEY));
    return Number.isFinite(v) && v > 0 ? clampSideWidth(v, Infinity) : SIDE_DEFAULT;
  } catch {
    return SIDE_DEFAULT;
  }
}

/** What the sides of the work area reserve besides their own column: the rails (always shown on the desktop). */
export const RAILS_W = RAIL_W * 2;

/**
 * The widths the columns get: each limited to 220–560, and the work area keeps 480 px beside the open sides. A side
 * without an open window has no column, so it takes no room.
 */
export function fitWidths(width: { left: number; right: number }, open: { left: boolean; right: boolean }, viewport = window.innerWidth): { left: number; right: number } {
  const left = clampSideWidth(width.left, viewport, RAILS_W + (open.right ? SIDE_MIN : 0));
  const right = clampSideWidth(width.right, viewport, RAILS_W + (open.left ? left : 0));
  return { left, right };
}

/** The room a side can take when the user drags it: what is left after the rails and the other open column. */
export function reservedFor(other: number, otherOpen: boolean): number {
  return RAILS_W + (otherOpen ? other : 0);
}

/** The widths live in `--side-w-l` / `--side-w-r` on the root (`--side-w` stays the left one for the boot skeleton). */
export function applySideWidth(side: WidthSide, w: number): void {
  const root = document.documentElement.style;
  root.setProperty(side === 'left' ? '--side-w-l' : '--side-w-r', `${w}px`);
  if (side === 'left') root.setProperty('--side-w', `${w}px`);
}
