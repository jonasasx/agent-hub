import { describe, expect, it } from 'vitest';
import * as D from './dock';
import type { Dock, WinId } from './dock';

const ids = (d: Dock): WinId[] => [...d.left, ...d.right].flatMap(s => s.ids);

function invariants(d: Dock) {
  const all = ids(d);
  expect(new Set(all).size).toBe(all.length);
  expect([...all].sort()).toEqual([...D.WIN_IDS].sort());
  for (const s of [...d.left, ...d.right]) {
    expect(s.ids.length).toBeGreaterThan(0);
    expect(s.ids).toContain(s.act);
  }
}

describe('dock model', () => {
  it('the default layout', () => {
    const d = D.defaultDock();
    expect(d.left.map(s => s.ids)).toEqual([['sessions', 'files'], ['machines'], ['subs']]);
    expect(d.left[0]!.act).toBe('sessions');
    expect(d.right).toEqual([]);
    invariants(d);
  });

  it('toggle closes the open window and reopens it; a tab click switches the slot', () => {
    let d = D.defaultDock();
    d = D.toggle(d, 'sessions');
    expect(D.isOpen(d, 'sessions')).toBe(false);
    d = D.toggle(d, 'files');
    expect(D.isOpen(d, 'files')).toBe(true);
    expect(D.isOpen(d, 'sessions')).toBe(false);
    d = D.toggle(d, 'files');
    expect(D.openSlots(d, 'left').map(x => x.id)).toEqual(['machines', 'subs']);
  });

  it('hide closes the slot, show restores it', () => {
    let d = D.hide(D.defaultDock(), 'machines');
    expect(D.isOpen(d, 'machines')).toBe(false);
    expect(D.where(d, 'machines')).not.toBeNull();
    d = D.show(d, 'machines');
    expect(D.isOpen(d, 'machines')).toBe(true);
    expect(D.show(d, 'machines')).toBe(d);
  });

  it('move to a new slot on the right, the empty slot disappears', () => {
    let d = D.defaultDock();
    d = D.moveToNewSlot(d, 'machines', 'right', 0);
    expect(d.right.map(s => s.ids)).toEqual([['machines']]);
    expect(d.left.map(s => s.ids)).toEqual([['sessions', 'files'], ['subs']]);
    invariants(d);
    expect(D.sideOpen(d, 'right')).toBe(true);
  });

  it('move as a tab opens the target and activates the window', () => {
    let d = D.hide(D.defaultDock(), 'subs');
    d = D.moveToSlot(d, 'subs', 'left', 1);
    expect(d.left[1]!.ids).toEqual(['machines', 'subs']);
    expect(d.left[1]!.act).toBe('subs');
    expect(d.left[1]!.closed).toBe(false);
    invariants(d);
  });

  it('a tab position inside the same slot is corrected after the removal', () => {
    let d = D.defaultDock();
    d = D.reorder(d, 'sessions', 2);
    expect(d.left[0]!.ids).toEqual(['files', 'sessions']);
    d = D.reorder(d, 'sessions', 0);
    expect(d.left[0]!.ids).toEqual(['sessions', 'files']);
  });

  it('moving the only window of a slot onto itself is a no-op', () => {
    const d = D.defaultDock();
    expect(D.moveToSlot(d, 'machines', 'left', 1)).toBe(d);
  });

  it('a new slot inserted before the source slot keeps the position when the source disappears', () => {
    let d = D.defaultDock();
    d = D.moveToNewSlot(d, 'subs', 'left', 2);
    expect(d.left.map(s => s.ids)).toEqual([['sessions', 'files'], ['machines'], ['subs']]);
    d = D.moveToNewSlot(d, 'subs', 'left', 0);
    expect(d.left.map(s => s.ids)).toEqual([['subs'], ['sessions', 'files'], ['machines']]);
  });

  it('heights are cleared on the touched slots, pair resize keeps the minimum', () => {
    let d = D.defaultDock();
    d = D.resize(d, 'left', 0, 1, 300, 200, 5000);
    expect(d.left[0]!.h).toBe(300 + 200 - D.SLOT_MIN);
    expect(d.left[1]!.h).toBe(D.SLOT_MIN);
    d = D.moveToSlot(d, 'files', 'left', 1);
    expect(d.left[0]!.h).toBeUndefined();
    expect(d.left[1]!.h).toBeUndefined();
    expect(D.clampPair(100, 100, -5000)).toEqual([D.SLOT_MIN, 200 - D.SLOT_MIN]);
  });

  it('setWidth is immutable and a no-op for the same value', () => {
    const d = D.defaultDock();
    const n = D.setWidth(d, 'right', 400);
    expect(n.width.right).toBe(400);
    expect(d.width.right).toBe(320);
    expect(D.setWidth(n, 'right', 400)).toBe(n);
  });

  it('parseDock: a wrong shape or version is null', () => {
    expect(D.parseDock(null)).toBeNull();
    expect(D.parseDock({ v: 2, left: [], right: [] })).toBeNull();
    expect(D.parseDock({ v: 1, left: 'x', right: [] })).toBeNull();
  });

  it('parseDock drops unknown windows and duplicates, adds missing ones hidden, repairs act', () => {
    const d = D.parseDock({
      v: 1,
      left: [
        { ids: ['sessions', 'ghost', 'files'], act: 'machines', closed: false, h: 10 },
        { ids: ['ghost'], act: 'ghost' },
      ],
      right: [{ ids: ['files', 'subs'], act: 'subs', closed: false, h: 200 }],
      width: { left: 400, right: 'x' },
    })!;
    expect(d.left[0]).toEqual({ ids: ['sessions', 'files'], act: 'sessions', closed: false });
    expect(d.right[0]).toEqual({ ids: ['subs'], act: 'subs', closed: false, h: 200 });
    expect(d.left[1]).toEqual({ ids: ['machines'], act: 'machines', closed: true });
    expect(d.width).toEqual({ left: 400, right: D.defaultDock().width.right });
    invariants(d);
  });
});
