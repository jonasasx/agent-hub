/** Window size and position (design D2). Requirement: Окно с прод-вебом («Восстановление положения»). */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState extends Rect {
  maximized: boolean;
}

export const DEFAULT_SIZE = { width: 1280, height: 800 };
const MIN_SIZE = { width: 480, height: 360 };

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Parses `window-state.json`; anything broken → null. */
export function parseWindowState(text: string | null): WindowState | null {
  if (!text) return null;
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    if (!isNum(o.x) || !isNum(o.y) || !isNum(o.width) || !isNum(o.height)) return null;
    return { x: Math.round(o.x), y: Math.round(o.y), width: Math.round(o.width), height: Math.round(o.height), maximized: o.maximized === true };
  } catch {
    return null;
  }
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function centered(primary: Rect): Rect {
  const width = Math.min(DEFAULT_SIZE.width, primary.width);
  const height = Math.min(DEFAULT_SIZE.height, primary.height);
  return { x: primary.x + Math.round((primary.width - width) / 2), y: primary.y + Math.round((primary.height - height) / 2), width, height };
}

/**
 * Bounds to open the window with: the saved ones if they intersect the work area of one of the displays, otherwise
 * centred on the primary display at 1280×800 (not maximized).
 */
export function restoreWindowState(saved: WindowState | null, workAreas: Rect[], primary: Rect): WindowState {
  if (saved && saved.width >= MIN_SIZE.width && saved.height >= MIN_SIZE.height && workAreas.some(wa => intersects(saved, wa))) {
    return saved;
  }
  return { ...centered(primary), maximized: false };
}
