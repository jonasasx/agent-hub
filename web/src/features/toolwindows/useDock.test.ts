// Requirement (tool-windows-file-explorer): Хранение раскладки на устройстве.
import { beforeEach, describe, expect, it } from 'vitest';
import { DOCK_KEY, loadDock, useDock } from './useDock';
import { defaultDock, isOpen, where } from './dock';

const saved = () => JSON.parse(localStorage.getItem(DOCK_KEY) ?? 'null') as ReturnType<typeof defaultDock> | null;

describe('useDock storage', () => {
  beforeEach(() => {
    localStorage.clear();
    useDock.setState({ dock: defaultDock(), phoneWin: null });
  });

  it('a first start has the default layout and stores nothing until the first change', () => {
    expect(loadDock()).toEqual(defaultDock());
    expect(localStorage.getItem(DOCK_KEY)).toBeNull();
  });

  it('a change is stored and read back', () => {
    useDock.getState().move('subs', { side: 'right', si: 0, asNew: true });
    expect(saved()?.right.map(s => s.ids)).toEqual([['subs']]);
    expect(loadDock().right[0]?.ids).toEqual(['subs']);
  });

  it('a corrupt value and an unknown version give the default layout, the first change overwrites it', () => {
    localStorage.setItem(DOCK_KEY, '{not json');
    expect(loadDock()).toEqual(defaultDock());
    localStorage.setItem(DOCK_KEY, JSON.stringify({ v: 2, left: [], right: [] }));
    expect(loadDock()).toEqual(defaultDock());
    useDock.setState({ dock: loadDock() });
    useDock.getState().toggle('machines');
    expect(saved()?.v).toBe(1);
  });

  it('the width of the old key migrates into a first dock and the old key stays', () => {
    localStorage.setItem('ah-side-width', '400');
    expect(loadDock().width.left).toBe(400);
    expect(localStorage.getItem('ah-side-width')).toBe('400');
  });

  it('windows the build does not know are dropped, a missing one is added hidden', () => {
    localStorage.setItem(DOCK_KEY, JSON.stringify({ v: 1, left: [{ ids: ['sessions', 'ghost'], act: 'sessions', closed: false }], right: [] }));
    const d = loadDock();
    expect(d.left[0]?.ids).toEqual(['sessions']);
    expect(where(d, 'files')).not.toBeNull();
    expect(isOpen(d, 'files')).toBe(false);
    expect(isOpen(d, 'sessions')).toBe(true);
  });

  it('a width drag is stored only on the final value; reset gives the default and stores it', () => {
    useDock.getState().setWidth('left', 400, false);
    expect(localStorage.getItem(DOCK_KEY)).toBeNull();
    useDock.getState().setWidth('left', 400, true);
    expect(saved()?.width.left).toBe(400);
    useDock.getState().toggle('subs');
    useDock.getState().reset();
    expect(useDock.getState().dock).toEqual(defaultDock());
    expect(saved()).toEqual(defaultDock());
  });
});
