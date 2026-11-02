/**
 * The workspace of this browser window (design.md D11 «Рабочая область окна», M2.1).
 * Requirements (workspace-ui): Независимые окна; Раскладка нового окна и перезагрузка.
 *
 * `sessionStorage['agenthub.workspace.v1'] = {desktop, phone}`: each entry is the window's Workspace of that device
 * class plus `openedAt` (ISO per tab). sessionStorage belongs to one browser tab, survives a reload and is copied by
 * «Duplicate». A memory mirror keeps the window working when the storage is blocked.
 */
import type { Device } from '../../api/types';
import { parseWorkspace, type Snapshot, type Workspace } from '../layout/layout';

export const WINDOW_KEY = 'agenthub.workspace.v1';

export type StoredWorkspace = Workspace & { openedAt: Record<string, string> };
export type StoredWindow = Record<Device, StoredWorkspace | null>;

let mirror: StoredWindow = { desktop: null, phone: null };
let loaded = false;

/** Validated «Одно окно» snapshot or null. */
export function parseSnapshot(raw: unknown): Snapshot | null {
  const w = parseWorkspace(raw);
  return w ? { layout: w.layout, panes: w.panes, focus: w.focus } : null;
}

function parseOpenedAt(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'));
}

function parseStored(raw: unknown): StoredWorkspace | null {
  const w = parseWorkspace(raw);
  if (!w) return null;
  const r = raw as { saved?: unknown; openedAt?: unknown };
  return { ...w, saved: parseSnapshot(r.saved), openedAt: parseOpenedAt(r.openedAt) };
}

/** The window's stored workspaces (read from sessionStorage once per page). */
export function readWindow(): StoredWindow {
  if (!loaded) {
    loaded = true;
    try {
      const raw = sessionStorage.getItem(WINDOW_KEY);
      if (raw) {
        const o = JSON.parse(raw) as Partial<Record<Device, unknown>>;
        mirror = { desktop: parseStored(o.desktop), phone: parseStored(o.phone) };
      }
    } catch {
      // blocked storage or a broken entry: the window starts from the template
    }
  }
  return mirror;
}

/** Stores the workspace of one device class of this window (synchronously, on every change). */
export function writeWindow(device: Device, ws: Workspace, openedAtMs: Record<string, number>): void {
  const tabs = new Set(Object.values(ws.panes).flatMap(p => p.tabs));
  const openedAt = Object.fromEntries(
    Object.entries(openedAtMs)
      .filter(([id]) => tabs.has(id))
      .map(([id, ms]) => [id, new Date(ms).toISOString()]),
  );
  mirror = { ...readWindow(), [device]: { ...ws, openedAt } };
  try {
    sessionStorage.setItem(WINDOW_KEY, JSON.stringify(mirror));
  } catch {
    // the memory mirror keeps the window working
  }
}

export function toMs(iso: Record<string, string> | null | undefined): Record<string, number> {
  return Object.fromEntries(Object.entries(iso ?? {}).map(([id, v]) => [id, Date.parse(v) || 0]));
}

export function toIso(ms: Record<string, number>, ids: string[]): Record<string, string> {
  return Object.fromEntries(ids.filter(id => ms[id] !== undefined).map(id => [id, new Date(ms[id]!).toISOString()]));
}

/** Tests: forget the memory mirror (as a new page would). */
export function resetWindowMirror(): void {
  mirror = { desktop: null, phone: null };
  loaded = false;
}
