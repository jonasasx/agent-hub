/**
 * The line between two open windows of a column: drag or ↑/↓ (16 px, with Shift 64) changes their heights, neither goes
 * under 64 px. While dragging the panels are set directly; the final heights are stored on release.
 */
import type { KeyboardEvent, PointerEvent } from 'react';
import { SLOT_MIN, clampPair, type Side } from './dock';
import { useDock } from './useDock';

const STEP = 16;

interface Props {
  side: Side;
  /** Slot indices of the upper and the lower window. */
  a: number;
  b: number;
  idA: string;
  idB: string;
}

const panel = (from: HTMLElement, id: string): HTMLElement | null => from.closest('.tw-col')?.querySelector<HTMLElement>(`.tw-pnl[data-id="${id}"]`) ?? null;

export function SlotSplitter({ side, a, b, idA, idB }: Props) {
  const resize = useDock(s => s.resize);

  const measure = (el: HTMLElement) => {
    const pa = panel(el, idA);
    const pb = panel(el, idB);
    return pa && pb ? { pa, pb, ha: pa.getBoundingClientRect().height, hb: pb.getBoundingClientRect().height } : null;
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    const m = measure(el);
    if (!m) return;
    e.preventDefault();
    const { pa, pb, ha, hb } = m;
    const y0 = e.clientY;
    const root = el.closest('.app');
    el.setPointerCapture?.(e.pointerId);
    el.classList.add('act');
    root?.classList.add('resizing');
    let dy = 0;
    const move = (ev: globalThis.PointerEvent) => {
      dy = ev.clientY - y0;
      const [na, nb] = clampPair(ha, hb, dy);
      pa.style.flex = `0 1 ${na}px`;
      pb.style.flex = `0 1 ${nb}px`;
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.classList.remove('act');
      root?.classList.remove('resizing');
      resize(side, a, b, ha, hb, dy);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const m = measure(e.currentTarget);
    if (!m) return;
    e.preventDefault();
    const step = (e.shiftKey ? STEP * 4 : STEP) * (e.key === 'ArrowUp' ? -1 : 1);
    resize(side, a, b, m.ha, m.hb, step);
  };

  return (
    <div
      className="tw-vs"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Высота окон"
      aria-valuemin={SLOT_MIN}
      tabIndex={0}
      title="Потяните, чтобы поменять высоту"
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}
