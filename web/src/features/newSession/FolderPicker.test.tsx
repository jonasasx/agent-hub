import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { api } from '../../api/client';
import { directoryBreadcrumbs, FolderPicker } from './FolderPicker';

vi.mock('../../api/client', () => ({ api: { runnerDirectories: vi.fn() } }));
const browse = vi.mocked(api.runnerDirectories);

describe('FolderPicker', () => {
  beforeEach(() => {
    browse.mockReset();
  });
  it('builds Windows breadcrumb targets from accumulated path segments', () => {
    expect(directoryBreadcrumbs('C:\\Users\\Alice\\work')).toEqual([
      { label: 'C:', target: 'C:\\' },
      { label: 'Users', target: 'C:\\Users' },
      { label: 'Alice', target: 'C:\\Users\\Alice' },
      { label: 'work', target: 'C:\\Users\\Alice\\work' },
    ]);
  });
  it('focuses the picker and Escape closes only it, restoring focus to its opener', async () => {
    browse.mockResolvedValue({ path: 'C:\\Users\\Alice\\work', parent: 'C:\\Users\\Alice', directories: [] });
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Choose…
          </button>
          {open && <FolderPicker runnerId="r1" initialPath="C:\\Users\\Alice\\work" onChoose={vi.fn()} onClose={() => setOpen(false)} />}
          <div data-testid="parent-form">Parent form</div>
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Choose…' });
    opener.focus();
    fireEvent.click(opener);
    const close = await screen.findByRole('button', { name: 'Закрыть' });
    await waitFor(() => expect(close).toHaveFocus());
    fireEvent.keyDown(close, { key: 'Escape' });
    expect(await screen.findByRole('button', { name: 'Choose…' })).toHaveFocus();
    expect(screen.getByTestId('parent-form')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('loads, navigates, toggles hidden directories, and returns the selected canonical folder', async () => {
    browse.mockImplementation(async (_runner, path, hidden) => ({
      path: path ?? '/home/me',
      parent: path ? '/home' : '/',
      directories: hidden ? [{ name: '.cache', path: '/home/me/.cache' }] : [{ name: 'work', path: '/home/me/work' }],
    }));
    const onChoose = vi.fn();
    render(<FolderPicker runnerId="r1" initialPath="" onChoose={onChoose} onClose={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'work' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'work' }));
    await waitFor(() => expect(browse).toHaveBeenLastCalledWith('r1', '/home/me/work', false));
    await screen.findByText('/home/me/work');
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(browse).toHaveBeenLastCalledWith('r1', '/home/me/work', true));
    fireEvent.click(screen.getByRole('button', { name: 'Выбрать эту папку' }));
    expect(onChoose).toHaveBeenCalledWith('/home/me/work');
  });
  it('with a root it does not leave it: no breadcrumbs above the root, «Вверх» stops at the root', async () => {
    browse.mockImplementation(async (_runner, path) => ({
      path: path ?? '/home/me',
      parent: path === '/home/me/vault/work' ? '/home/me/vault' : '/home/me',
      directories: [],
    }));
    render(<FolderPicker runnerId="r1" initialPath="/home/me/vault/work" root="/home/me/vault" onChoose={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'work' })).toBeInTheDocument();
    const crumbs = screen.getByRole('navigation').querySelectorAll('button');
    expect([...crumbs].map(b => b.textContent)).toEqual(['vault', 'work']);
    fireEvent.click(screen.getByRole('button', { name: '↑ Вверх' }));
    await waitFor(() => expect(browse).toHaveBeenLastCalledWith('r1', '/home/me/vault', false));
    await screen.findByText('/home/me/vault');
    expect(screen.getByRole('button', { name: '↑ Вверх' })).toBeDisabled();
  });
  it('keeps the dialog open with a manual-entry fallback when the agent cannot browse', async () => {
    browse.mockRejectedValue(new Error('Agent does not support directory browsing'));
    render(<FolderPicker runnerId="old" initialPath="C:\\work" onChoose={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Можно ввести путь вручную');
    expect(screen.getByRole('button', { name: 'Выбрать эту папку' })).toBeDisabled();
  });
});
