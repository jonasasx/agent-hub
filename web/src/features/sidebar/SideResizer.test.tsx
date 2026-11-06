// Requirements (sidebar-resize): Ширина левой панели; (tool-windows-file-explorer): Ширина столбика с каждой стороны.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SideResizer } from './SideResizer';
import { SIDE_DEFAULT, SIDE_MAX, SIDE_MIN, clampSideWidth, fitWidths, storedSideWidth } from './sideWidth';
import { DOCK_KEY, loadDock, useDock } from '../toolwindows/useDock';
import { defaultDock, moveToNewSlot } from '../toolwindows/dock';

const LEGACY = 'ah-side-width';
const cssLeft = () => document.documentElement.style.getPropertyValue('--side-w');
const cssRight = () => document.documentElement.style.getPropertyValue('--side-w-r');
const stored = () => JSON.parse(localStorage.getItem(DOCK_KEY) ?? 'null') as { width: { left: number; right: number } } | null;

describe('SideResizer', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 });
    useDock.setState({ dock: defaultDock() });
  });
  afterEach(() => {
    for (const p of ['--side-w', '--side-w-l', '--side-w-r']) document.documentElement.style.removeProperty(p);
  });

  it('dragging the edge changes the width and stores it on pointer up', () => {
    render(<SideResizer />);
    const handle = screen.getByRole('separator', { name: 'Ширина панели' });
    handle.setPointerCapture = () => undefined;
    fireEvent.pointerDown(handle, { button: 0, clientX: 320, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 420, pointerId: 1 });
    expect(cssLeft()).toBe('420px');
    expect(localStorage.getItem(DOCK_KEY)).toBeNull();
    fireEvent.pointerUp(handle, { clientX: 420, pointerId: 1 });
    expect(stored()?.width.left).toBe(420);
    expect(handle).toHaveAttribute('aria-valuenow', '420');
  });

  it('the right edge works the other way round: dragging to the left widens the right column', () => {
    useDock.setState({ dock: moveToNewSlot(defaultDock(), 'subs', 'right', 0) });
    render(<SideResizer side="right" />);
    const handle = screen.getByRole('separator', { name: 'Ширина правой панели' });
    handle.setPointerCapture = () => undefined;
    fireEvent.pointerDown(handle, { button: 0, clientX: 1200, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 1100, pointerId: 1 });
    expect(cssRight()).toBe('420px');
    fireEvent.pointerUp(handle, { clientX: 1100, pointerId: 1 });
    expect(stored()?.width).toEqual({ left: SIDE_DEFAULT, right: 420 });
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(handle).toHaveAttribute('aria-valuenow', '436');
  });

  it('keys step the width, double click resets to the default', () => {
    useDock.setState({ dock: { ...defaultDock(), width: { left: 400, right: 320 } } });
    render(<SideResizer />);
    const handle = screen.getByRole('separator');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle).toHaveAttribute('aria-valuenow', '416');
    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true });
    expect(handle).toHaveAttribute('aria-valuenow', '352');
    fireEvent.doubleClick(handle);
    expect(handle).toHaveAttribute('aria-valuenow', String(SIDE_DEFAULT));
    expect(stored()?.width.left).toBe(SIDE_DEFAULT);
  });

  it('the width stays within the limits and leaves room for the work area', () => {
    expect(clampSideWidth(100, 1600)).toBe(SIDE_MIN);
    expect(clampSideWidth(900, 1600)).toBe(SIDE_MAX);
    expect(clampSideWidth(500, 900)).toBe(420);
    // two open columns and the rails share the window: the work area keeps 480 px
    const both = fitWidths({ left: 560, right: 560 }, { left: true, right: true }, 1400);
    expect(both.left + both.right + 88 + 480).toBeLessThanOrEqual(1400);
    expect(fitWidths({ left: 560, right: 560 }, { left: true, right: false }, 1400).left).toBe(560);
  });

  it('the width of the old key starts the left column; a broken value gives the default', () => {
    localStorage.setItem(LEGACY, '400');
    expect(loadDock().width.left).toBe(400);
    localStorage.setItem(LEGACY, 'junk');
    expect(storedSideWidth()).toBe(SIDE_DEFAULT);
    expect(loadDock().width.left).toBe(SIDE_DEFAULT);
  });
});
