// Unit tests of the layout functions, one block per scenario of spec workspace-ui.
import { describe, expect, it } from 'vitest';
import {
  PANE_LIMIT,
  TAB_LIMIT,
  allTabs,
  clampRatio,
  closePane,
  closeTab,
  emptyWorkspace,
  enforceLimit,
  evictionCandidate,
  insertSlot,
  leaves,
  mergeAll,
  moveToPane,
  openSession,
  paneOf,
  parseWorkspace,
  reconcileTabs,
  removePaneIfEmpty,
  restoreSplit,
  setRatio,
  split,
  toggleSingle,
  topRight,
  zoneHint,
  zoneOf,
  type Workspace,
} from './layout';

const tabsOf = (ws: Workspace) => leaves(ws.layout).map(pid => ws.panes[pid]!.tabs);

/** Two panes side by side: left [a,b,c] (focused), right [d]. */
function twoPanes(): Workspace {
  const r = split(emptyWorkspace(['a', 'b', 'c', 'd']), 'd', 'p1', 'right');
  return { ...r.ws, focus: 'p1' };
}

describe('Мои вкладки', () => {
  it('opening from the left panel inserts right of the active tab of the focused pane', () => {
    let ws = emptyWorkspace(['a', 'b', 'c']);
    ws = { ...ws, panes: { p1: { ...ws.panes.p1!, active: 'b' } } };
    ws = openSession(ws, 'x');
    expect(ws.panes.p1!.tabs).toEqual(['a', 'b', 'x', 'c']);
    expect(ws.panes.p1!.active).toBe('x');
  });

  it('Повторное открытие: a session open in the second pane activates that pane, no new tab', () => {
    const ws = openSession(twoPanes(), 'd');
    expect(ws.focus).toBe('p2');
    expect(ws.panes.p2!.active).toBe('d');
    expect(allTabs(ws)).toHaveLength(4);
  });

  it('Вытеснение давно не открывавшейся: the ninth tab evicts the least recently opened one that is not shown', () => {
    let ws = emptyWorkspace(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']);
    ws = { ...ws, panes: { p1: { ...ws.panes.p1!, active: 's1' } } };
    // s1 is the oldest but active; s2 is the oldest of the rest
    const lastOpened = { s1: 1, s2: 2, s3: 3, s4: 4, s5: 5, s6: 6, s7: 7, s8: 8, s9: 9 };
    ws = openSession(ws, 's9');
    // s9 is active now; s1 is not shown any more → it is the oldest candidate
    const r = enforceLimit(ws, 's9', lastOpened);
    expect(r.evicted).toBe('s1');
    expect(allTabs(r.ws)).toHaveLength(TAB_LIMIT);
    expect(allTabs(r.ws)).toContain('s9');
  });

  it('eviction skips tabs active in any pane and the new tab', () => {
    const base = split(emptyWorkspace(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']), 's1', 'p1', 'right').ws;
    // panes: p1 [s2..s8], p2 [s1] (active)
    let ws = { ...base, focus: 'p1' };
    ws = openSession(ws, 's9');
    const lastOpened = { s1: 1, s2: 2, s3: 3, s4: 4, s5: 5, s6: 6, s7: 7, s8: 8 };
    // s1 is active in p2 and s9 is new → the oldest of the rest is s2
    expect(evictionCandidate(ws, 's9', lastOpened)).toBe('s2');
  });

  it('no eviction at 8 tabs', () => {
    const ws = emptyWorkspace(['1', '2', '3', '4', '5', '6', '7', '8']);
    expect(enforceLimit(ws, '8', {}).evicted).toBeNull();
  });

  it('Закрытие вкладки: the tab disappears, the neighbour on the left becomes active', () => {
    let ws = emptyWorkspace(['a', 'b', 'c']);
    ws = { ...ws, panes: { p1: { ...ws.panes.p1!, active: 'b' } } };
    ws = closeTab(ws, 'b');
    expect(ws.panes.p1!.tabs).toEqual(['a', 'c']);
    expect(ws.panes.p1!.active).toBe('a');
  });

  it('Закрытие вкладки колёсиком: closing an inactive tab keeps the active one', () => {
    let ws = emptyWorkspace(['a', 'b', 'c']);
    ws = { ...ws, panes: { p1: { ...ws.panes.p1!, active: 'c' } } };
    ws = closeTab(ws, 'a');
    expect(ws.panes.p1!.active).toBe('c');
  });

  it('operations do not mutate the input', () => {
    const ws = twoPanes();
    const copy = structuredClone(ws);
    closeTab(ws, 'a');
    moveToPane(ws, 'a', 'p2');
    mergeAll(ws);
    expect(ws).toEqual(copy);
  });
});

describe('Сплит перетаскиванием', () => {
  it('Деление справа: a new pane with the tab on the right, it becomes active', () => {
    const r = split(emptyWorkspace(['a', 'b']), 'b', 'p1', 'right');
    expect(r.error).toBeUndefined();
    expect(r.ws.layout).toMatchObject({ type: 'split', dir: 'row', ratio: 0.5, a: { pane: 'p1' }, b: { type: 'leaf' } });
    expect(tabsOf(r.ws)).toEqual([['a'], ['b']]);
    expect(r.ws.focus).toBe(leaves(r.ws.layout)[1]);
    expect(r.ws.panes[r.ws.focus]!.active).toBe('b');
  });

  it.each([
    ['left', 'row', 0],
    ['top', 'col', 0],
    ['bottom', 'col', 1],
  ] as const)('zone %s → %s split, new pane at index %i', (zone, dir, idx) => {
    const r = split(emptyWorkspace(['a', 'b']), 'b', 'p1', zone);
    expect(r.ws.layout).toMatchObject({ type: 'split', dir });
    expect(tabsOf(r.ws)[idx]).toEqual(['b']);
  });

  it('Нечего делить: the only tab of the pane cannot split it', () => {
    const ws = emptyWorkspace(['a']);
    const r = split(ws, 'a', 'p1', 'right');
    expect(r.error).toBe('nothing_to_split');
    expect(r.ws).toBe(ws);
  });

  it('a session row from the left panel (not a tab yet) splits even a one-tab pane', () => {
    const r = split(emptyWorkspace(['a']), 'x', 'p1', 'right');
    expect(tabsOf(r.ws)).toEqual([['a'], ['x']]);
  });

  it('Пятая панель: with 4 panes the split is refused, layout unchanged', () => {
    let ws = emptyWorkspace(['a', 'b', 'c', 'd', 'e']);
    ws = split(ws, 'b', 'p1', 'right').ws;
    ws = split(ws, 'c', 'p1', 'bottom').ws;
    ws = split(ws, 'd', leaves(ws.layout)[2]!, 'bottom').ws;
    expect(leaves(ws.layout)).toHaveLength(PANE_LIMIT);
    const r = split(ws, 'e', 'p1', 'left');
    expect(r.error).toBe('pane_limit');
    expect(r.ws).toBe(ws);
    expect(zoneHint('left', 4)).toBe('Не больше четырёх панелей');
  });

  it('moving the last tab of the source pane into a split closes the source pane', () => {
    const ws = twoPanes();
    const r = split(ws, 'd', 'p1', 'left');
    expect(leaves(r.ws.layout)).toHaveLength(2);
    expect(r.ws.panes.p2).toBeUndefined();
  });

  it('zoneOf: edge closer than 25% → that edge, otherwise centre', () => {
    const rect = { left: 0, top: 0, width: 400, height: 200 };
    expect(zoneOf(rect, 390, 100)).toBe('right');
    expect(zoneOf(rect, 10, 100)).toBe('left');
    expect(zoneOf(rect, 200, 10)).toBe('top');
    expect(zoneOf(rect, 200, 190)).toBe('bottom');
    expect(zoneOf(rect, 200, 100)).toBe('center');
    expect(zoneOf(rect, 101, 100)).toBe('center');
  });

  it('hints', () => {
    expect(zoneHint('right', 1)).toBe('Разделить: справа');
    expect(zoneHint('top', 2)).toBe('Разделить: сверху');
    expect(zoneHint('center', 4)).toBe('Переместить в эту панель');
  });
});

describe('Место вставки на полосе вкладок', () => {
  const strip = [
    { sessionId: 'a', left: 0, width: 100 },
    { sessionId: 'b', left: 100, width: 100 },
    { sessionId: 'c', left: 200, width: 100 },
  ];
  it('Вставка между вкладками: left of the middle of the second tab → before it', () => {
    expect(insertSlot(strip, 140, 'x')).toEqual({ kind: 'before', sessionId: 'b' });
    const ws = moveToPane(twoPanes(), 'd', 'p1', 'b');
    expect(ws.panes.p1!.tabs).toEqual(['a', 'd', 'b', 'c']);
    expect(ws.panes.p1!.active).toBe('d');
  });
  it('right of the middle of the last tab → after it', () => {
    expect(insertSlot(strip, 260, 'x')).toEqual({ kind: 'after', sessionId: 'c' });
  });
  it('the dragged tab does not count', () => {
    expect(insertSlot(strip, 140, 'b')).toEqual({ kind: 'before', sessionId: 'c' });
  });
  it('Пустая полоса: the whole strip', () => {
    expect(insertSlot([], 50, 'x')).toEqual({ kind: 'empty' });
  });
  it('move into another pane: active there, pane focused', () => {
    const ws = moveToPane(twoPanes(), 'a', 'p2');
    expect(ws.panes.p2!.tabs).toEqual(['d', 'a']);
    expect(ws.focus).toBe('p2');
  });
  it('reorder inside the same pane', () => {
    const ws = moveToPane(emptyWorkspace(['a', 'b', 'c']), 'c', 'p1', 'a');
    expect(ws.panes.p1!.tabs).toEqual(['c', 'a', 'b']);
  });
});

describe('Разделитель и закрытие панели', () => {
  it('Ограничение доли: ratio is clamped to 20–80%', () => {
    expect(clampRatio(0.01)).toBe(0.2);
    expect(clampRatio(0.99)).toBe(0.8);
    const ws = setRatio(twoPanes(), '', 0.05);
    expect(ws.layout).toMatchObject({ ratio: 0.2 });
  });

  it('Закрытие панели: closing the right of two panes appends its tabs to the end of the left one', () => {
    let ws = emptyWorkspace(['a', 'b', 'c', 'd']);
    ws = split(ws, 'b', 'p1', 'right').ws;
    ws = moveToPane(ws, 'c', leaves(ws.layout)[1]!);
    ws = moveToPane(ws, 'd', leaves(ws.layout)[1]!);
    expect(tabsOf(ws)).toEqual([['a'], ['b', 'c', 'd']]);
    ws = closePane(ws, leaves(ws.layout)[1]!);
    expect(tabsOf(ws)).toEqual([['a', 'b', 'c', 'd']]);
    expect(ws.focus).toBe('p1');
  });

  it('UI review M6: closing a pane moves its tabs to its neighbour in the tree, not to the first pane', () => {
    // p1 | (p2 / p3): closing p3 sends its tabs to p2 (its sibling), not to p1
    let ws = emptyWorkspace(['a', 'b', 'c']);
    ws = split(ws, 'b', 'p1', 'right').ws;
    ws = split(ws, 'c', leaves(ws.layout)[1]!, 'bottom').ws;
    const [p1, p2, p3] = leaves(ws.layout);
    ws = closePane(ws, p3!);
    expect(ws.panes[p2!]!.tabs).toEqual(['b', 'c']);
    expect(ws.panes[p1!]!.tabs).toEqual(['a']);
    expect(ws.focus).toBe(p2);
    // closing the left pane of a split goes to the nearest leaf of the right subtree
    let w2 = split(emptyWorkspace(['a', 'b', 'c']), 'b', 'p1', 'right').ws;
    w2 = split(w2, 'c', leaves(w2.layout)[1]!, 'bottom').ws;
    const [q1, q2] = leaves(w2.layout);
    w2 = closePane(w2, q1!);
    expect(w2.panes[q2!]!.tabs).toEqual(['b', 'a']);
  });

  it('Последняя вкладка панели: moving it out closes the pane', () => {
    const ws = moveToPane(twoPanes(), 'd', 'p1');
    expect(leaves(ws.layout)).toEqual(['p1']);
    expect(ws.layout).toEqual({ type: 'leaf', pane: 'p1' });
  });

  it('removePaneIfEmpty keeps the last pane', () => {
    const ws = closeTab(emptyWorkspace(['a']), 'a');
    expect(removePaneIfEmpty(ws, 'p1').panes.p1).toBeDefined();
  });

  it('closing the last tab of a non-last pane removes the pane and moves focus to the sibling', () => {
    let ws = twoPanes();
    ws = { ...ws, focus: 'p2' };
    ws = closeTab(ws, 'd');
    expect(leaves(ws.layout)).toEqual(['p1']);
    expect(ws.focus).toBe('p1');
  });
});

describe('Одно окно и Вернуть разделение', () => {
  /** Three panes: p1 [a,b] | (p2 [c] / p3 [d]); focus p2. */
  function three(): Workspace {
    let ws = emptyWorkspace(['a', 'b', 'c', 'd']);
    ws = split(ws, 'c', 'p1', 'right').ws;
    ws = split(ws, 'd', 'p2', 'bottom').ws;
    ws = setRatio(ws, '', 0.65);
    return { ...ws, focus: 'p2' };
  }

  it('mergeAll: focused pane tabs first, active tab stays active, layout remembered', () => {
    const ws = mergeAll(three());
    expect(leaves(ws.layout)).toHaveLength(1);
    expect(tabsOf(ws)).toEqual([['c', 'a', 'b', 'd']]);
    expect(ws.panes[ws.focus]!.active).toBe('c');
    expect(ws.saved).not.toBeNull();
  });

  it('Отключение монитора и возврат: merge, open a new session, restore → 3 panes, ratios back, new tab in the formerly focused pane', () => {
    const before = three();
    let ws = toggleSingle(before).ws;
    ws = openSession(ws, 'n');
    const r = toggleSingle(ws);
    expect(r.action).toBe('restored');
    ws = r.ws;
    expect(leaves(ws.layout)).toHaveLength(3);
    expect(ws.layout).toMatchObject({ ratio: 0.65 });
    expect(ws.panes.p1!.tabs).toEqual(['a', 'b']);
    expect(ws.panes.p2!.tabs).toEqual(['c', 'n']);
    expect(ws.panes.p3!.tabs).toEqual(['d']);
    expect(ws.panes[ws.focus]!.active).toBe('n');
    expect(ws.saved).toBeNull();
  });

  it('tabs closed after the merge do not return; a pane left empty is dropped', () => {
    let ws = mergeAll(three());
    ws = closeTab(ws, 'd');
    ws = restoreSplit(ws);
    expect(leaves(ws.layout)).toHaveLength(2);
    expect(allTabs(ws)).not.toContain('d');
  });

  it('the active tab after restore is active in its restored pane', () => {
    let ws = mergeAll(three());
    ws = { ...ws, panes: { [ws.focus]: { ...ws.panes[ws.focus]!, active: 'b' } } };
    ws = restoreSplit(ws);
    expect(paneOf(ws, 'b')!.id).toBe('p1');
    expect(ws.focus).toBe('p1');
    expect(ws.panes.p1!.active).toBe('b');
  });

  it('Новое разделение сбрасывает запомненное: after a drag split Ctrl+\\ with one pane does nothing', () => {
    let ws = mergeAll(three());
    ws = split(ws, 'a', ws.focus, 'right').ws;
    expect(ws.saved).toBeNull();
    ws = closeTab(ws, 'a');
    expect(leaves(ws.layout)).toHaveLength(1);
    expect(toggleSingle(ws).action).toBeNull();
  });

  it('topRight: the button lives in the top-right pane', () => {
    expect(topRight(three().layout)).toBe('p2');
  });

  it('new pane ids do not collide with restored ones', () => {
    let ws = restoreSplit(mergeAll(three()));
    ws = split(ws, 'a', 'p1', 'left').ws;
    expect(new Set(leaves(ws.layout)).size).toBe(4);
  });
});

describe('Раскладка хранится на сервере', () => {
  it('reconcileTabs drops closed tabs and appends tabs opened elsewhere to the focused pane', () => {
    const ws = reconcileTabs(twoPanes(), ['a', 'c', 'd', 'z']);
    expect(tabsOf(ws)).toEqual([['a', 'c', 'z'], ['d']]);
  });
  it('reconcileTabs returns the same workspace when the tabs already match (no save, QA: layout ping-pong)', () => {
    const ws = twoPanes();
    expect(reconcileTabs(ws, ['a', 'b', 'c', 'd'])).toBe(ws);
    expect(reconcileTabs(ws, ['d', 'c', 'b', 'a'])).toBe(ws);
    expect(reconcileTabs(ws, ['a', 'b', 'c', 'd', 'z'])).not.toBe(ws);
  });
  it('reconcileTabs closes a pane whose tabs are all gone', () => {
    const ws = reconcileTabs(twoPanes(), ['a']);
    expect(leaves(ws.layout)).toEqual(['p1']);
  });
  it('parseWorkspace accepts a stored workspace and rejects garbage', () => {
    const ws = twoPanes();
    expect(parseWorkspace(JSON.parse(JSON.stringify(ws)))).toEqual(ws);
    expect(parseWorkspace({ layout: { type: 'leaf', pane: 'p9' }, panes: {}, focus: 'p9' })).toBeNull();
    expect(parseWorkspace(null)).toBeNull();
  });
});
