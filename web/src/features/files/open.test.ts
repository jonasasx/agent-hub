// Tests of the one-click entries into the «Файлы» window. Requirement (file-explorer): Окно «Файлы» и источники.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../store';
import { RUNNERS, resetStore, session } from '../../test/factories';
import { resetFiles, useFiles } from './filesStore';
import { openFilesForMachine, openFilesForSession } from './open';
import { setOpenFilesWindow } from './toolWindowBridge';

describe('open', () => {
  const show = vi.fn();
  beforeEach(() => {
    resetStore();
    resetFiles();
    show.mockClear();
    setOpenFilesWindow(show);
    useStore.setState({ runners: RUNNERS });
  });
  afterEach(() => setOpenFilesWindow(() => {}));

  it('a machine opens its home folder: the machine chip and exactly one call that shows the window', () => {
    openFilesForMachine('vm');
    expect(useFiles.getState().choice).toEqual({ kind: 'machine', runnerId: 'vm' });
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('a session opens its folder: the session chip, the lifted root is reset, the window is shown once', () => {
    const s = session();
    useStore.getState().upsertSessions([s]);
    useFiles.setState({ choice: { kind: 'machine', runnerId: 'vm' }, rootUp: { [`session:${s.id}`]: 'C:\\Users', other: 'x' } });
    openFilesForSession(s.id);
    expect(useFiles.getState().choice).toEqual({ kind: 'session' });
    expect(useFiles.getState().rootUp).toEqual({ other: 'x' });
    expect(show).toHaveBeenCalledTimes(1);
  });
});
