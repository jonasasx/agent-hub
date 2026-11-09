// Unit tests of file tabs in the workspace model. Requirement (file-explorer): Файловые вкладки.
import { describe, expect, it } from 'vitest';
import { allTabs, emptyWorkspace, fileTabId, isFileTab, openSession, paneBeside, parseFileTabId, split, stripFileTabs, type Workspace } from './layout';

describe('Файловые вкладки: идентификатор', () => {
  it('builds file:<runnerId>:<path> and parses it back, a path may contain colons', () => {
    const id = fileTabId('r1', '/home/ivan/a:b/readme.md');
    expect(id).toBe('file:r1:/home/ivan/a:b/readme.md');
    expect(parseFileTabId(id)).toEqual({ runnerId: 'r1', path: '/home/ivan/a:b/readme.md' });
  });

  it('keeps a drive path', () => {
    const id = fileTabId('r1', 'C:/Users/ivan/a.txt');
    expect(parseFileTabId(id)).toEqual({ runnerId: 'r1', path: 'C:/Users/ivan/a.txt' });
  });

  it('a session id is not a file tab', () => {
    expect(isFileTab('0b9f1f2a-0000-4000-8000-000000000000')).toBe(false);
    expect(parseFileTabId('0b9f1f2a')).toBeNull();
    expect(parseFileTabId('file:r1:')).toBeNull();
    expect(parseFileTabId('file::/x')).toBeNull();
  });
});

describe('Файловые вкладки: общий лимит', () => {
  it('there is no limit: a ninth tab opens next to eight session and file tabs, all of them stay', () => {
    const ids = ['s1', 's2', 'f-pin', 'f-prev', 's5', 's6', 's7', 's8'].map(id => (id.startsWith('f-') ? fileTabId('r', `/${id}`) : id));
    const ws = openSession(emptyWorkspace(ids), fileTabId('r', '/x.md'));
    expect(allTabs(ws)).toHaveLength(9);
    expect(allTabs(ws)).toEqual(expect.arrayContaining([...ids, fileTabId('r', '/x.md')]));
  });
});

describe('Файловые вкладки: раскладка на сервер', () => {
  it('strips file tabs from the layout and from the remembered one, emptied panes disappear', () => {
    const file = fileTabId('r', '/a.md');
    const base = split(emptyWorkspace(['s1', 's2', file]), file, 'p1', 'right').ws;
    const withSaved: Workspace = { ...base, saved: { layout: base.layout, panes: base.panes, focus: base.focus } };
    const out = stripFileTabs(withSaved);
    expect(allTabs(out)).toEqual(['s1', 's2']);
    expect(Object.keys(out.panes)).toHaveLength(1);
    expect(out.saved).not.toBeNull();
    expect(Object.values(out.saved!.panes).flatMap(p => p.tabs)).toEqual(['s1', 's2']);
  });

  it('a workspace without file tabs is returned as is', () => {
    const ws = emptyWorkspace(['s1']);
    expect(stripFileTabs(ws)).toBe(ws);
  });

  it('when the active tab was a file the neighbour becomes active', () => {
    const file = fileTabId('r', '/a.md');
    const ws = openSession(emptyWorkspace(['s1', 's2']), file);
    expect(ws.panes.p1!.active).toBe(file);
    const out = stripFileTabs(ws);
    expect(out.panes.p1!.active).toBe('s1');
  });
});

describe('Файловые вкладки: панель для ссылки из чата', () => {
  it('a single pane is the pane itself', () => {
    expect(paneBeside(emptyWorkspace(['a']), 'p1')).toBe('p1');
  });

  it('prefers another pane that already shows a file, otherwise the next one', () => {
    let ws = split(emptyWorkspace(['a', 'b', 'c']), 'b', 'p1', 'right').ws;
    ws = split(ws, 'c', 'p1', 'bottom').ws;
    const [first, second, third] = ws.layout.type === 'split' ? [...leavesOf(ws)] : [];
    expect(paneBeside(ws, first!)).toBe(second);
    const f = fileTabId('x1', '/a.md');
    ws.panes[third!]!.tabs.push(f);
    ws.panes[third!]!.active = f;
    expect(paneBeside(ws, first!)).toBe(third);
  });
});

function leavesOf(ws: Workspace): string[] {
  const walk = (n: Workspace['layout']): string[] => (n.type === 'leaf' ? [n.pane] : [...walk(n.a), ...walk(n.b)]);
  return walk(ws.layout);
}
