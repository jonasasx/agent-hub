// Tests of the state of the «Файлы» window. Requirements (file-explorer): Окно «Файлы» и источники; Ленивое дерево; Машина не в сети и ошибки.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import { useStore } from '../../store';
import { RUNNERS, resetStore, runner } from '../../test/factories';
import { FILES_KEY, listingKey, loadDir, resetFiles, sessionFor, useFiles } from './filesStore';
import { resolveSource } from './source';
import { dir, stubFs } from './testkit';

const src = () =>
  resolveSource({
    choice: { kind: 'machine', runnerId: 'vm' },
    sessionId: null,
    sessions: {},
    runners: [runner({ id: 'vm', homeDir: '/home/u', protocolVersion: '1.14' })],
    rootUp: {},
    outdated: {},
  })!;

describe('filesStore', () => {
  beforeEach(() => {
    resetStore();
    resetFiles();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('expanded folders and the selection are kept per source and persisted', () => {
    const a = src();
    const b = { ...a, key: 'session:s1' };
    useFiles.getState().toggleExpanded(a, '/home/u/docs');
    useFiles.getState().select(a, '/home/u/docs/a.md');
    expect(useFiles.getState().expanded[a.key]).toEqual(['/home/u/docs']);
    expect(useFiles.getState().expanded[b.key]).toBeUndefined();
    useFiles.getState().toggleExpanded(a, '/home/u/docs');
    expect(useFiles.getState().expanded[a.key]).toEqual([]);
    expect(JSON.parse(sessionStorage.getItem(FILES_KEY)!).selected[a.key]).toBe('/home/u/docs/a.md');
  });

  it('pin and unpin of a file tab; the session of a tab is remembered', () => {
    useFiles.getState().pin('file:x1:/a');
    useFiles.getState().pin('file:x1:/a');
    expect(useFiles.getState().pinned).toEqual(['file:x1:/a']);
    useFiles.getState().unpin('file:x1:/a');
    expect(useFiles.getState().pinned).toEqual([]);
    useFiles.getState().rememberSession('file:x1:/a', 's1');
    expect(useFiles.getState().tabSession['file:x1:/a']).toBe('s1');
    useFiles.getState().rememberSession('file:x1:/a', undefined);
    expect(useFiles.getState().tabSession['file:x1:/a']).toBeUndefined();
  });

  it('loads one level, caches it and does not load twice', async () => {
    const calls = stubFs({ list: { '/home/u': dir('/home/u', ['a.md', 'docs']) }, files: {} });
    await loadDir('vm', '/home/u', undefined);
    await loadDir('vm', '/home/u', undefined);
    expect(calls).toHaveLength(1);
    const l = useFiles.getState().listings[listingKey('vm', undefined, false, '/home/u')];
    expect(l?.status).toBe('ok');
  });

  it('an error is kept with its text and «Повторить» (force) loads again', async () => {
    stubFs({ list: { '/p': { error: 'permission_denied', status: 403 } }, files: {} });
    await loadDir('vm', '/p', undefined);
    const key = listingKey('vm', undefined, false, '/p');
    expect(useFiles.getState().listings[key]).toMatchObject({ status: 'error', code: 'permission_denied' });
    stubFs({ list: { '/p': dir('/p', ['x.txt']) }, files: {} });
    await loadDir('vm', '/p', undefined, true);
    expect(useFiles.getState().listings[key]?.status).toBe('ok');
  });

  it('capability_unavailable marks the machine as outdated', async () => {
    stubFs({ list: { '/p': { error: 'capability_unavailable', status: 409 } }, files: {} });
    await loadDir('vm', '/p', undefined);
    expect(useFiles.getState().outdated.vm).toBe(true);
  });

  it('a machine that comes online drops its error listings and wakes the viewers', async () => {
    useStore.setState({ runners: [runner({ id: 'x1', online: false })] });
    useFiles.setState({ listings: { 'x1|||0|/a': { status: 'error', code: 'runner_offline', text: 'Машина не в сети' }, 'hp|||0|/a': { status: 'loading' } }, outdated: { x1: true } });
    const n = useFiles.getState().connectNonce;
    act(() => useStore.setState({ runners: [runner({ id: 'x1', online: true })] }));
    expect(Object.keys(useFiles.getState().listings)).toEqual(['hp|||0|/a']);
    expect(useFiles.getState().outdated.x1).toBeUndefined();
    expect(useFiles.getState().connectNonce).toBe(n + 1);
  });

  it('the session goes with a request only inside the cwd (not above the lifted root)', () => {
    const s = { sessionId: 's1', base: '/home/u/proj' };
    expect(sessionFor(s, '/home/u/proj/a')).toBe('s1');
    expect(sessionFor(s, '/home/u')).toBeUndefined();
    expect(RUNNERS.length).toBeGreaterThan(0);
  });
});
