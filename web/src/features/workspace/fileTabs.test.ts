// Tests of the file tabs in the workspace actions. Requirement (file-explorer): Файловые вкладки.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../store';
import { RUNNERS, mockFetch, resetStore, session } from '../../test/factories';
import { resetFiles, useFiles } from '../files/filesStore';
import { allTabs } from '../layout/layout';
import { closeTab, loadWorkspace, openFileTab, openSession, pinFileTab, saveLayout, startLayoutPersistence } from './actions';

const files = () => allTabs(useStore.getState().ws).filter(t => t.startsWith('file:'));

describe('file tabs', () => {
  beforeEach(() => {
    resetStore();
    resetFiles();
    useStore.setState({ runners: RUNNERS });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('a single click makes a preview that the next preview replaces', () => {
    openFileTab('x1', '/a.txt');
    openFileTab('x1', '/b.txt');
    expect(files()).toEqual(['file:x1:/b.txt']);
  });

  it('a pinned tab stays when a new preview comes', () => {
    openFileTab('x1', '/a.txt', { pin: true });
    openFileTab('x1', '/b.txt');
    openFileTab('x1', '/c.txt');
    expect(files()).toEqual(['file:x1:/a.txt', 'file:x1:/c.txt']);
  });

  it('pinning a preview keeps it; a file open already is activated, not duplicated', () => {
    openFileTab('x1', '/a.txt');
    pinFileTab('file:x1:/a.txt');
    openFileTab('x1', '/b.txt');
    openFileTab('x1', '/a.txt');
    expect(files()).toEqual(['file:x1:/a.txt', 'file:x1:/b.txt']);
    const ws = useStore.getState().ws;
    expect(ws.panes[ws.focus]!.active).toBe('file:x1:/a.txt');
  });

  it('the session that opened the file is remembered', () => {
    openFileTab('x1', '/a.txt', { sessionId: 's1' });
    expect(useFiles.getState().tabSession['file:x1:/a.txt']).toBe('s1');
  });

  it('the layout sent to the hub has no file tabs, the window keeps them', async () => {
    const s = session();
    useStore.getState().upsertSessions([s]);
    const calls = mockFetch({ 'PUT /api/layout': () => ({ status: 200, body: {} }) });
    useStore.setState({ layoutLoaded: true });
    const stop = startLayoutPersistence();
    openFileTab('x1', '/a.txt', { pin: true });
    await saveLayout();
    stop();
    const put = calls.find(c => c.method === 'PUT' && c.url.startsWith('/api/layout'));
    expect(put).toBeDefined();
    expect(JSON.stringify(put!.body)).not.toContain('file:');
    expect(files()).toEqual(['file:x1:/a.txt']);
  });

  it('closing a file tab removes it', () => {
    openFileTab('x1', '/a.txt', { pin: true });
    closeTab('file:x1:/a.txt');
    expect(files()).toEqual([]);
  });

  it('a file opened while the layout loads waits and opens after it, without a session fetch', async () => {
    const calls = mockFetch({ 'GET /api/layout': () => ({ status: 200, body: {} }) });
    const loaded = loadWorkspace('desktop');
    openFileTab('x1', '/a.txt', { pin: true, sessionId: 's1' });
    expect(files()).toEqual([]);
    await loaded;
    expect(files()).toEqual(['file:x1:/a.txt']);
    expect(useFiles.getState().pinned).toEqual(['file:x1:/a.txt']);
    expect(useFiles.getState().tabSession['file:x1:/a.txt']).toBe('s1');
    expect(calls.filter(c => c.url.includes('/api/sessions/file'))).toEqual([]);
  });

  it('a file tab id is never fetched as a session (a 404 there would close the tab)', async () => {
    const calls = mockFetch({});
    openSession('file:x1:/a.txt');
    await Promise.resolve();
    expect(calls.filter(c => c.url.includes('/api/sessions/'))).toEqual([]);
  });

  it('a file evicted by the limit loses its pin and session: opened by a click again it is a preview', () => {
    const list = Array.from({ length: 9 }, (_, i) => session({ id: `s${i}`, title: `S${i}` }));
    useStore.getState().upsertSessions(list);
    mockFetch({});
    openFileTab('x1', '/a.txt', { pin: true, sessionId: 's0' });
    for (let i = 0; i < 8; i += 1) openSession(`s${i}`);
    expect(files()).toEqual([]);
    expect(useFiles.getState().pinned).toEqual([]);
    expect(useFiles.getState().tabSession).toEqual({});
    openFileTab('x1', '/a.txt');
    expect(useFiles.getState().pinned).toEqual([]);
    openFileTab('x1', '/b.txt');
    expect(files()).toEqual(['file:x1:/b.txt']);
  });

  it('closing a file tab forgets its pin and session', () => {
    openFileTab('x1', '/a.txt', { pin: true, sessionId: 's1' });
    closeTab('file:x1:/a.txt');
    expect(useFiles.getState().pinned).toEqual([]);
    expect(useFiles.getState().tabSession).toEqual({});
  });
});
