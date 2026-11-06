/**
 * The inner edge of a column of tool windows: drag to resize, double click resets, ←/→ step by 16 px (Shift — 64 px).
 * Requirements (sidebar-resize): Ширина левой панели; (tool-windows-file-explorer): Ширина столбика с каждой стороны.
 * The handle belongs to a side with an open window, so a side without one has none. The right column grows to the left.
 */
import { useState, type KeyboardEvent, type PointerEvent } from 'react';
import { sideOpen } from '../toolwindows/dock';
import { useDock } from '../toolwindows/useDock';
import { SIDE_DEFAULT, SIDE_MAX, SIDE_MIN, clampSideWidth, reservedFor, type WidthSide } from './sideWidth';

const STEP = 16;
const LABEL: Record<WidthSide, string> = { left: 'Ширина панели', right: 'Ширина правой панели' };

export function SideResizer({ side = 'left' }: { side?: WidthSide }) {
  const dock = useDock(s => s.dock);
  const setWidth = useDock(s => s.setWidth);
  const [dragging, setDragging] = useState(false);
  const other: WidthSide = side === 'left' ? 'right' : 'left';
  const room = () => reservedFor(dock.width[other], sideOpen(dock, other));
  const fit = (w: number) => clampSideWidth(w, window.innerWidth, room());
  const width = fit(dock.width[side]);
  // the left edge of the right column is dragged to the left to widen it
  const sign = side === 'left' ? 1 : -1;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    setDragging(true);
    document.body.classList.add('side-resizing');
    let last = startW;
    const move = (ev: globalThis.PointerEvent) => {
      last = fit(startW + sign * (ev.clientX - startX));
      setWidth(side, last, false);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      document.body.classList.remove('side-resizing');
      setDragging(false);
      setWidth(side, last, true);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? STEP * 4 : STEP;
    if (e.key === 'ArrowLeft') setWidth(side, fit(width - sign * step));
    else if (e.key === 'ArrowRight') setWidth(side, fit(width + sign * step));
    else if (e.key === 'Home') setWidth(side, SIDE_MIN);
    else if (e.key === 'End') setWidth(side, fit(SIDE_MAX));
    else return;
    e.preventDefault();
  };

  return (
    <div
      className={`side-resizer ${side}${dragging ? ' dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={LABEL[side]}
      aria-valuemin={SIDE_MIN}
      aria-valuemax={SIDE_MAX}
      aria-valuenow={width}
      tabIndex={0}
      title="Потяните, чтобы изменить ширину. Двойной клик — по умолчанию"
      onPointerDown={onPointerDown}
      onDoubleClick={() => setWidth(side, SIDE_DEFAULT)}
      onKeyDown={onKeyDown}
    />
  );
}
