// pane-anchored-popovers: the place of a popover under its opener, kept inside the window.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { anchorBelow, shownRect, useScrimAnchor } from './anchor';

const rect = (left: number, right: number, bottom = 40) => ({ left, right, top: bottom - 30, bottom, width: right - left, height: 30, x: left, y: bottom - 30, toJSON: () => ({}) }) as DOMRect;

describe('anchorBelow', () => {
  beforeEach(() => vi.stubGlobal('innerWidth', 1600));
  afterEach(() => vi.unstubAllGlobals());

  it('the right edge under the button’s right edge, the top under its bottom', () => {
    expect(anchorBelow(rect(900, 1000), 420)).toEqual({ paddingTop: 46, paddingRight: 600 });
  });

  it('a button near the left edge: the popover shifts right only as far as the window needs', () => {
    expect(anchorBelow(rect(100, 200), 760)).toEqual({ paddingTop: 46, paddingRight: 1600 - 760 - 12 });
  });

  it('a button at the right edge keeps the window margin', () => {
    expect(anchorBelow(rect(1550, 1598), 420)).toEqual({ paddingTop: 46, paddingRight: 12 });
  });
});

describe('shownRect', () => {
  it('skips a hidden copy (zero width) and returns the shown one', () => {
    const root = document.createElement('div');
    root.innerHTML = '<button class="b"></button><button class="b"></button>';
    const [hidden, shown] = [...root.querySelectorAll<HTMLElement>('.b')] as [HTMLElement, HTMLElement];
    hidden.getBoundingClientRect = () => rect(0, 0);
    shown.getBoundingClientRect = () => rect(10, 50);
    expect(shownRect(root, '.b')?.right).toBe(50);
    expect(shownRect(root, '.none')).toBeUndefined();
  });
});

describe('useScrimAnchor', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('off → undefined; on → the place, computed again on resize', () => {
    let right = 1000;
    vi.stubGlobal('innerWidth', 1600);
    const { result, rerender } = renderHook(({ on }) => useScrimAnchor(on, () => anchorBelow(rect(right - 60, right), 420)), { initialProps: { on: false } });
    expect(result.current).toBeUndefined();
    rerender({ on: true });
    expect(result.current).toEqual({ paddingTop: 46, paddingRight: 600 });
    right = 1200;
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(result.current).toEqual({ paddingTop: 46, paddingRight: 400 });
    rerender({ on: false });
    expect(result.current).toBeUndefined();
  });
});
