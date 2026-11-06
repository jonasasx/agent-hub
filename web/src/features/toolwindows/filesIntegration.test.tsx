// Requirements (tool-windows-file-explorer): Окно «Файлы» и источники — one click from a machine menu or from the chat header
// opens the «Файлы» window on the right source; a hidden window or an inactive tab of its slot comes back.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../store';
import { RUNNERS, resetStore, session } from '../../test/factories';
import { Chat } from '../chat/Chat';
import { Sidebar } from '../sidebar/Sidebar';
import { openFileTab, openSession } from '../workspace/actions';
import { resetFiles, useFiles } from '../files/filesStore';
import { setOpenFilesWindow } from '../files/toolWindowBridge';
import { stubFs } from '../files/testkit';
import { Column } from './Column';
import { defaultDock, hide, isOpen } from './dock';
import { openToolWindow } from './open';
import { Rail } from './Rail';
import { useDock } from './useDock';

const filesBodyShown = () => document.querySelector('.tw-head .tw-title')?.textContent === 'Файлы' || [...document.querySelectorAll('.tw-title')].some(e => e.textContent === 'Файлы');

describe('«Файлы» opened from outside the window', () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
    resetFiles();
    stubFs({ list: {}, files: {} });
    useDock.setState({ dock: defaultDock(), phoneWin: null });
    setOpenFilesWindow(() => openToolWindow('files'));
    useStore.setState({ runners: RUNNERS });
  });
  afterEach(() => {
    setOpenFilesWindow(() => {});
    vi.unstubAllGlobals();
  });

  async function pickMachineItem(name: string) {
    await userEvent.click(screen.getByRole('button', { name }));
    await userEvent.click(screen.getByRole('menuitem', { name: /Файлы машины/ }));
  }

  it('«Файлы машины»: the window, which is an inactive tab of the slot with «Сессии», comes forward in one click on the machine source', async () => {
    render(<Column side="left" />);
    expect(filesBodyShown()).toBe(false);
    await pickMachineItem('ВМ .3');
    expect(filesBodyShown()).toBe(true);
    expect(useFiles.getState().choice).toEqual({ kind: 'machine', runnerId: 'vm' });
    expect(screen.getByRole('group', { name: 'Источник файлов' })).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Источник файлов' })).getByRole('button', { name: 'ВМ .3' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('«Файлы машины» with the window hidden restores it', async () => {
    useDock.setState({ dock: hide(useDock.getState().dock, 'files') });
    render(<Column side="left" />);
    expect(isOpen(useDock.getState().dock, 'files')).toBe(false);
    await pickMachineItem('X1');
    expect(isOpen(useDock.getState().dock, 'files')).toBe(true);
    expect(filesBodyShown()).toBe(true);
    expect(within(screen.getByRole('group', { name: 'Источник файлов' })).getByRole('button', { name: 'X1' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('the folder in the chat header opens the window on the session source, also when the window is hidden', async () => {
    const s = session();
    useStore.getState().upsertSessions([s]);
    useStore.setState({ logs: { [s.id]: { events: [], before: null, loaded: true, loading: false, error: null } } });
    openSession(s.id);
    useDock.setState({ dock: hide(useDock.getState().dock, 'files') });
    useFiles.setState({ choice: { kind: 'machine', runnerId: 'vm' } });
    render(
      <>
        <Rail side="left" />
        <Column side="left" />
        <Chat session={s} paneId={useStore.getState().ws.focus} />
      </>,
    );
    await userEvent.click(screen.getByRole('button', { name: s.cwd ?? '' }));
    expect(isOpen(useDock.getState().dock, 'files')).toBe(true);
    expect(filesBodyShown()).toBe(true);
    expect(useFiles.getState().choice).toEqual({ kind: 'session' });
    expect(within(screen.getByRole('group', { name: 'Источник файлов' })).getByRole('button', { name: /^Сессия/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('on the phone the window opens over the home screen', () => {
    useStore.setState({ device: 'phone' });
    setOpenFilesWindow(() => openToolWindow('files'));
    // jsdom has no matchMedia: the device of the store decides
    openToolWindow('files');
    expect(useDock.getState().phoneWin).toBe('files');
  });

  it('the phone list «Сессии» has the group «Файлы» with the open file; the desktop list has not', () => {
    openFileTab('x1', '/a/one.txt', { pin: true });
    useStore.setState({ device: 'phone' });
    const { unmount } = render(<Sidebar onLogout={() => {}} />);
    expect(within(screen.getByRole('region', { name: 'Файлы' })).getByText('one.txt')).toBeInTheDocument();
    unmount();
    useStore.setState({ device: 'desktop' });
    render(<Sidebar onLogout={() => {}} />);
    expect(screen.queryByRole('region', { name: 'Файлы' })).not.toBeInTheDocument();
  });
});
