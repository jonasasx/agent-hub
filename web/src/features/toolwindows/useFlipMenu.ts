/**
 * Places a fixed menu under its anchor, or above it when there is no room below (spec: меню окна и машины). Also keeps
 * the menu inside the viewport on the right edge. The menu element is positioned directly, so there is no flash.
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { useMenu } from '../ui/a11y';

export function useFlipMenu(open: boolean, anchor: RefObject<HTMLElement | null>, menu: RefObject<HTMLElement | null>, gap = 4): void {
  useLayoutEffect(() => {
    const a = anchor.current;
    const m = menu.current;
    if (!open || !a || !m) return;
    const r = a.getBoundingClientRect();
    const w = m.offsetWidth;
    const h = m.offsetHeight;
    let x = r.left;
    if (x + w > window.innerWidth - 4) x = Math.max(4, r.right - w);
    let y = r.bottom + gap;
    let up = false;
    if (y + h > window.innerHeight - 4 && r.top - gap - h >= 4) {
      y = r.top - gap - h;
      up = true;
    } else if (y + h > window.innerHeight - 4) {
      y = Math.max(4, window.innerHeight - 4 - h);
    }
    m.style.left = `${Math.round(x)}px`;
    m.style.top = `${Math.round(y)}px`;
    m.dataset.placement = up ? 'up' : 'down';
  }, [open, anchor, menu, gap]);
}

/** ↑/↓/Home/End move the focus over the items of a menu; Enter and Space are the buttons' own. */
export function menuKeys(e: { key: string; preventDefault: () => void; currentTarget: HTMLElement }): void {
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  if (!items.length) return;
  const at = items.indexOf(document.activeElement as HTMLElement);
  let next = -1;
  if (e.key === 'ArrowDown') next = (at + 1) % items.length;
  else if (e.key === 'ArrowUp') next = (at <= 0 ? items.length : at) - 1;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = items.length - 1;
  if (next < 0) return;
  e.preventDefault();
  items[next]?.focus();
}

/** A popup menu: Esc and a click outside close it, it opens under its trigger or above it, the focus enters the items. */
export function usePopupMenu(open: boolean, onClose: () => void) {
  const box = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useMenu(open, box, onClose);
  useFlipMenu(open, trigger, menu);
  // after `useMenu` (which puts the focus on the first focusable thing, the trigger): onto the first item that works
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
  }, [open]);
  return { box, trigger, menu };
}
