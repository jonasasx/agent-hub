// Unit tests of file tabs in the workspace model. Requirement (file-explorer): Файловые вкладки.
import { describe, expect, it } from 'vitest';
import { TAB_LIMIT, allTabs, emptyWorkspace, enforceLimit, fileTabId, isFileTab, openSession, parseFileTabId, split, stripFileTabs, type Workspace } from './layout';

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
  const full = (): Workspace => {
    const ids = ['s1', 's2', 'f-pin', 'f-prev', 's5', 's6', 's7', 's8'].map(id => (id.startsWith('f-') ? fileTabId('r', `/${id}`) : id));
    return openSession(emptyWorkspace(ids), 'x');
  };
  const times = (ws: Workspace) => Object.fromEntries(allTabs(ws).map((id, i) => [id, i + 1]));

  it('a preview file tab is evicted before older session tabs', () => {
    const ws = full();
    const pinned = new Set([fileTabId('r', '/f-pin')]);
    const r = enforceLimit(ws, 'x', times(ws), null, pinned);
    expect(r.evicted).toBe(fileTabId('r', '/f-prev'));
    expect(allTabs(r.ws)).toHaveLength(TAB_LIMIT);
  });

  it('a pinned file tab is evicted by age like a session tab, after the previews', () => {
    const ws = full();
    const pinned = new Set([fileTabId('r', '/f-pin'), fileTabId('r', '/f-prev')]);
    const opened = times(ws);
    opened[fileTabId('r', '/f-pin')] = 0;
    const r = enforceLimit(ws, 'x', opened, null, pinned);
    expect(r.evicted).toBe(fileTabId('r', '/f-pin'));
  });

  it('without the pinned set file tabs are ordinary tabs', () => {
    const ws = full();
    const r = enforceLimit(ws, 'x', times(ws));
    expect(r.evicted).toBe('s1');
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
