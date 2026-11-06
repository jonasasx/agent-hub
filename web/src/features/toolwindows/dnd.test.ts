// Requirement (tool-windows-file-explorer): Перетаскивание окон — the drop zones as a table of points.
import { describe, expect, it } from 'vitest';
import { defaultDock, hide, moveToNewSlot, type Dock } from './dock';
import { EDGE_ZONE, dropTarget, edgeShare, type Box, type Geo } from './dnd';

const box = (left: number, top: number, right: number, bottom: number): Box => ({ left, top, right, bottom });

/** The default layout in a 1400x800 app: a rail of 44 px, a column of 320 px, sessions/files, machines, subs. */
function geo(withRight = false): Geo {
  return {
    app: box(0, 0, 1400, 800),
    rails: [
      {
        side: 'left',
        box: box(0, 0, 44, 800),
        groups: [
          {
            si: 0,
            box: box(4, 50, 40, 130),
            icons: [
              { id: 'sessions', box: box(4, 50, 40, 86) },
              { id: 'files', box: box(4, 90, 40, 126) },
            ],
          },
          { si: 1, box: box(4, 140, 40, 176), icons: [{ id: 'machines', box: box(4, 140, 40, 176) }] },
          { si: 2, box: box(4, 190, 40, 226), icons: [{ id: 'subs', box: box(4, 190, 40, 226) }] },
        ],
      },
      { side: 'right', box: box(1356, 0, 1400, 800), groups: [] },
    ],
    panels: [
      { side: 'left', si: 0, id: 'sessions', box: box(44, 0, 364, 400) },
      { side: 'left', si: 1, id: 'machines', box: box(44, 400, 364, 480) },
      { side: 'left', si: 2, id: 'subs', box: box(44, 480, 364, 800) },
      ...(withRight ? [{ side: 'right' as const, si: 0, id: 'files' as const, box: box(1036, 0, 1356, 800) }] : []),
    ],
  };
}

describe('dropTarget', () => {
  const d = defaultDock();

  it('the edge share is 30 % of a tall window and 70 px of a short one', () => {
    expect(edgeShare(1000)).toBeCloseTo(0.07);
    expect(edgeShare(100)).toBe(0.3);
  });

  it('onto the icons of a group: a tab there, the half of an icon sets the place', () => {
    const lower = dropTarget(d, 'subs', 20, 120, geo())!;
    expect(lower).toMatchObject({ side: 'left', si: 0, idx: 2, line: true, rt: false, label: 'Вкладкой к окнам «Сессии», «Файлы»' });
    const upper = dropTarget(d, 'subs', 20, 60, geo())!;
    expect(upper).toMatchObject({ side: 'left', si: 0, idx: 0, line: true });
    const between = dropTarget(d, 'subs', 20, 100, geo())!;
    expect(between.idx).toBe(1);
  });

  it('onto its own single-window group: nothing', () => {
    expect(dropTarget(d, 'subs', 20, 200, geo())).toBeNull();
  });

  it('onto a gap between groups: a new window in the column at that place', () => {
    expect(dropTarget(d, 'subs', 20, 134, geo())).toMatchObject({ side: 'left', si: 1, asNew: true, line: true, label: 'Слева · новое окно в столбике' });
    expect(dropTarget(d, 'subs', 20, 60 + 600, geo())).toMatchObject({ side: 'left', si: 3, asNew: true });
  });

  it('onto the empty right rail: a new window on the right', () => {
    expect(dropTarget(d, 'subs', 1380, 300, geo())).toMatchObject({ side: 'right', si: 0, asNew: true, line: true, rt: true, label: 'Справа · новое окно в столбике' });
  });

  it('the top and the bottom edge of an open window: a new window above or below', () => {
    expect(dropTarget(d, 'subs', 200, 410, geo())).toMatchObject({ side: 'left', si: 1, asNew: true, label: 'Над «Машины»' });
    expect(dropTarget(d, 'subs', 200, 470, geo())).toMatchObject({ side: 'left', si: 2, asNew: true, label: 'Под «Машины»' });
    const top = dropTarget(d, 'subs', 200, 5, geo())!;
    expect(top).toMatchObject({ si: 0, asNew: true, label: 'Над «Сессии»' });
    expect(top.rect).toEqual({ l: 44, t: 0, w: 320, h: 120 });
  });

  it('the middle of an open window: a tab to it; the middle of its own single window: nothing', () => {
    expect(dropTarget(d, 'subs', 200, 200, geo())).toMatchObject({ side: 'left', si: 0, idx: null, label: 'Вкладкой к окну «Сессии»' });
    expect(dropTarget(d, 'machines', 200, 440, geo())).toBeNull();
  });

  it('the right edge of the app while the right side is not used: a new window on the right', () => {
    const t = dropTarget(d, 'subs', 1400 - EDGE_ZONE + 10, 700, { ...geo(), rails: [] }, 320)!;
    expect(t).toMatchObject({ side: 'right', si: 0, asNew: true, label: 'Новое окно справа' });
    expect(t.rect).toEqual({ l: 1080, t: 0, w: 320, h: 800 });
    expect(dropTarget(d, 'subs', 1400 - EDGE_ZONE - 10, 700, { ...geo(), panels: [], rails: [] })).toBeNull();
  });

  it('with an open window on the right the edge offers nothing', () => {
    const dock: Dock = moveToNewSlot(d, 'files', 'right', 0);
    expect(dropTarget(dock, 'subs', 1390, 700, { ...geo(true), rails: [] })).toBeNull();
  });

  it('a right side that only holds a hidden window is used: the edge offers nothing', () => {
    const dock: Dock = hide(moveToNewSlot(d, 'files', 'right', 0), 'files');
    expect(dropTarget(dock, 'subs', 1390, 700, { ...geo(), panels: [], rails: [] })).toBeNull();
  });
});
