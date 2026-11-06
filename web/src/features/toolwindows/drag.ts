/**
 * Dragging a tool window by its rail icon, panel header or slot tab (Requirement «Перетаскивание окон»), on pointer
 * events. A press becomes a drag after 6 px (a shorter movement stays a click); Esc cancels; the click that follows a
 * real drag is swallowed. The state of the drag is a store, `DropOverlay` draws the ghost and the drop frame from it.
 */
import { create } from 'zustand';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { DRAG_THRESHOLD, dropTarget, readGeo, type DropTarget } from './dnd';
import type { WinId } from './dock';
import { useDock } from './useDock';

interface DragState {
  /** The window being dragged while the pointer moves past the threshold; null — no drag. */
  id: WinId | null;
  /** The pointer, relative to the app. */
  x: number;
  y: number;
  target: DropTarget | null;
}

export const useDrag = create<DragState>(() => ({ id: null, x: 0, y: 0, target: null }));

const SUPPRESS_MS = 300;

/** Swallows the click that ends a drag (the pointer was released over an icon or a header). */
function suppressNextClick(root: HTMLElement): void {
  const eat = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
  };
  root.addEventListener('click', eat, true);
  setTimeout(() => root.removeEventListener('click', eat, true), SUPPRESS_MS);
}

export function beginDrag(id: WinId, e: ReactPointerEvent<HTMLElement>): void {
  if (e.button !== 0) return;
  const root = e.currentTarget.closest<HTMLElement>('.app');
  if (!root) return;
  const x0 = e.clientX;
  const y0 = e.clientY;
  let on = false;

  const finish = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', cancel);
    window.removeEventListener('keydown', key, true);
    root.classList.remove('dragging');
    useDrag.setState({ id: null, target: null });
  };
  const move = (ev: PointerEvent) => {
    if (!on) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_THRESHOLD) return;
      on = true;
      root.classList.add('dragging');
    }
    ev.preventDefault();
    const ar = root.getBoundingClientRect();
    const dock = useDock.getState().dock;
    const target = dropTarget(dock, id, ev.clientX, ev.clientY, readGeo(root), dock.width.right);
    useDrag.setState({ id, x: ev.clientX - ar.left, y: ev.clientY - ar.top, target });
  };
  const up = () => {
    const target = useDrag.getState().target;
    const was = on;
    finish();
    if (!was) return;
    suppressNextClick(root);
    if (target) useDock.getState().move(id, target);
  };
  const cancel = () => {
    const was = on;
    finish();
    if (was) suppressNextClick(root);
  };
  const key = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape' || !on) return;
    ev.stopImmediatePropagation();
    ev.preventDefault();
    cancel();
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', cancel);
  window.addEventListener('keydown', key, true);
}
