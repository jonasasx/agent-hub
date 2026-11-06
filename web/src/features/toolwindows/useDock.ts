/**
 * The layout of the tool windows as a store, kept on the device (Requirement «Хранение раскладки на устройстве»):
 * `localStorage['ah-tool-windows.v1']`. A broken or unknown-version value gives the default layout without a message
 * (it is overwritten by the first change); the left width of a first start comes from the old `ah-side-width`.
 */
import { create } from 'zustand';
import { applySideWidth, clampSideWidth, storedSideWidth } from '../sidebar/sideWidth';
import * as D from './dock';
import type { Dock, Side, Target, WinId } from './dock';

export const DOCK_KEY = 'ah-tool-windows.v1';

export function loadDock(): Dock {
  let text: string | null;
  try {
    text = localStorage.getItem(DOCK_KEY);
  } catch {
    text = null;
  }
  if (text === null) return D.defaultDock(storedSideWidth());
  try {
    const parsed = D.parseDock(JSON.parse(text) as unknown, w => clampSideWidth(w, Infinity));
    if (parsed) return parsed;
  } catch {
    // a broken value: the default below
  }
  return D.defaultDock();
}

function saveDock(d: Dock): void {
  try {
    localStorage.setItem(DOCK_KEY, JSON.stringify(d));
  } catch {
    // private mode: the layout still applies for this page
  }
}

interface DockState {
  dock: Dock;
  /** The window shown over the home screen on the phone (≤760 px); null — the home screen (Сессии). */
  phoneWin: WinId | null;
  toggle: (id: WinId) => void;
  show: (id: WinId) => void;
  hide: (id: WinId) => void;
  move: (id: WinId, t: Target) => void;
  resize: (side: Side, a: number, b: number, ha: number, hb: number, dy: number) => void;
  /** `persist: false` while the edge is being dragged; the final value is stored with `true`. */
  setWidth: (side: Side, w: number, persist?: boolean) => void;
  reset: () => void;
  setPhoneWin: (id: WinId | null) => void;
}

export const useDock = create<DockState>((set, get) => {
  const commit = (dock: Dock, persist = true) => {
    // a final width after a drag was applied already (persist false), only the saving is left
    if (dock === get().dock) {
      if (persist) saveDock(dock);
      return;
    }
    set({ dock });
    applySideWidth('left', dock.width.left);
    applySideWidth('right', dock.width.right);
    if (persist) saveDock(dock);
  };
  return {
    dock: loadDock(),
    phoneWin: null,
    toggle: id => commit(D.toggle(get().dock, id)),
    show: id => commit(D.show(get().dock, id)),
    hide: id => commit(D.hide(get().dock, id)),
    move: (id, t) => commit(D.move(get().dock, id, t)),
    resize: (side, a, b, ha, hb, dy) => commit(D.resize(get().dock, side, a, b, ha, hb, dy)),
    setWidth: (side, w, persist = true) => commit(D.setWidth(get().dock, side, w), persist),
    reset: () => {
      const dock = D.reset();
      set({ dock });
      applySideWidth('left', dock.width.left);
      applySideWidth('right', dock.width.right);
      saveDock(dock);
    },
    setPhoneWin: id => set({ phoneWin: id }),
  };
});

/** Puts the stored widths on the root before the first render (the boot skeleton and the columns share them). */
export function applyStoredWidths(): void {
  const { dock } = useDock.getState();
  applySideWidth('left', dock.width.left);
  applySideWidth('right', dock.width.right);
}
