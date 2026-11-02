/**
 * Dialog and menu behaviour (UI review 2.15, H3/H4): a dialog keeps Tab inside itself, makes the app behind it inert
 * and gives the focus back to the element that opened it; a menu closes on Esc and on a click outside.
 */
import { useEffect, useLayoutEffect, useReducer, useRef, useState, type RefObject } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusables(root: HTMLElement): HTMLElement[] {
  const all = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => !el.closest('[inert]'));
  const shown = all.filter(el => el.getClientRects().length > 0);
  // without layout (jsdom) nothing has client rects: then every focusable element counts
  return shown.length ? shown : all;
}

const inertCounts = new WeakMap<HTMLElement, { count: number; wasInert: boolean }>();
const dialogStack: HTMLElement[] = [];

/**
 * Modal dialog: Tab/Shift+Tab cycle inside `ref`, `.app` is inert while the dialog is open, Esc calls `onClose`,
 * the opener gets the focus back on unmount.
 */
export function useDialog(ref: RefObject<HTMLElement | null>, onClose: () => void, initialFocus?: RefObject<HTMLElement | null>): void {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const app = document.querySelector<HTMLElement>('.app');
    if (app) {
      const state = inertCounts.get(app);
      if (state) state.count += 1;
      else inertCounts.set(app, { count: 1, wasInert: app.hasAttribute('inert') });
      app.setAttribute('inert', '');
    }
    const root = ref.current;
    if (root) dialogStack.push(root);
    initialFocus?.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      const root = ref.current;
      if (!root) return;
      if (dialogStack.at(-1) !== root) return;
      if (e.key === 'Escape') {
        // a part of the dialog with its own Escape (the confirmation of «Выйти» in the MCP panel) closes only itself
        const ownEscape = e.target instanceof Element ? e.target.closest('[data-own-escape]') : null;
        if (ownEscape && ownEscape !== root) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        close.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const list = focusables(root);
      if (!list.length) {
        e.preventDefault();
        return;
      }
      const first = list[0]!;
      const last = list.at(-1)!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !root.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !root.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      const index = dialogStack.lastIndexOf(root!);
      if (index >= 0) dialogStack.splice(index, 1);
      if (app) {
        const state = inertCounts.get(app);
        if (state && --state.count === 0) {
          if (!state.wasInert) app.removeAttribute('inert');
          inertCounts.delete(app);
        }
      }
      // the opener was on screen when the dialog opened: returning the focus must not scroll the content under it (a
      // preview button a few pixels below the edge moved the chat feed on closing the lightbox)
      if (opener && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [ref, initialFocus]);
}

/** Menu: Esc (before any dialog) and a pointer press outside `ref` close it; the focus goes to the checked item (or the first one). */
export function useMenu(open: boolean, ref: RefObject<HTMLElement | null>, onClose: () => void): void {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const root = ref.current;
    const target = root?.querySelector<HTMLElement>('[aria-checked="true"]') ?? (root ? focusables(root)[0] : undefined);
    target?.focus();
    // Esc closes the open menu only: the listener is on `window` in the capture phase, so it runs before a dialog's
    // (document, capture) and the hotkeys, and nothing behind it sees the key (6.6 re-review N1: Esc in the row menu
    // closed the whole subscriptions window). The focus goes back to the menu's button.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const trigger = ref.current?.querySelector<HTMLElement>('[aria-haspopup="menu"]');
      close.current();
      trigger?.focus({ preventScroll: true });
    };
    const onDown = (e: PointerEvent | MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close.current();
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [open, ref]);
}

/** The visible box an element is clipped by: its nearest scrolling ancestor, intersected with the viewport. */
function clipBox(el: HTMLElement): { top: number; bottom: number } {
  let top = 0;
  let bottom = window.innerHeight;
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === 'auto' || o === 'scroll' || o === 'hidden') {
      const r = p.getBoundingClientRect();
      top = Math.max(top, r.top);
      bottom = Math.min(bottom, r.bottom);
      break;
    }
  }
  return { top, bottom };
}

/**
 * Where a menu under `anchor` opens: below it, or above when the scroll container (the chat feed, a modal body) or the
 * viewport has no room below and more room above (claude-subscriptions UI review C2: the note «Продолжить под
 * подпиской» is usually the last item, its menu went under the composer). The menu carries the class `up` then.
 */
export function useMenuPlacement(open: boolean, anchor: RefObject<HTMLElement | null>, menu: RefObject<HTMLElement | null>): 'down' | 'up' {
  const [place, setPlace] = useState<'down' | 'up'>('down');
  useLayoutEffect(() => {
    if (!open) {
      setPlace('down');
      return;
    }
    const a = anchor.current;
    const m = menu.current;
    if (!a || !m) return;
    const r = a.getBoundingClientRect();
    const box = clipBox(a);
    const need = m.offsetHeight + 8;
    const below = box.bottom - r.bottom;
    const above = r.top - box.top;
    setPlace(below < need && above > below ? 'up' : 'down');
  }, [open, anchor, menu]);
  return place;
}

/** Current time for «N мин назад» labels: re-renders every `period` ms and when the page becomes visible (M1). */
export function useNow(period = 60_000): number {
  const [, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const t = setInterval(tick, period);
    const onVisible = () => tick();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [period]);
  return Date.now();
}

/** `data-ctrl` on <html> while Ctrl/Cmd is held: tab numbers are shown only then (H6). */
export function trackCtrlKey(): () => void {
  const root = document.documentElement;
  const set = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey) root.dataset.ctrl = '1';
    else delete root.dataset.ctrl;
  };
  const clear = () => delete root.dataset.ctrl;
  window.addEventListener('keydown', set);
  window.addEventListener('keyup', set);
  window.addEventListener('blur', clear);
  return () => {
    window.removeEventListener('keydown', set);
    window.removeEventListener('keyup', set);
    window.removeEventListener('blur', clear);
    clear();
  };
}
