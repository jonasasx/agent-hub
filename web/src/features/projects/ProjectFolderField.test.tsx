// session-folder D7: the project folder is chosen with the picker rooted at the default folder and stored relative to it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { mockFetch, runner } from '../../test/factories';
import { ProjectFolderField, startFolder } from './ProjectFolderField';

const x1 = runner();

describe('ProjectFolderField', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('startFolder joins the default folder and the project folder of the machine', () => {
    expect(startFolder(x1, 'work/blog')).toBe('C:\\Users\\alice\\vault\\work\\blog');
    expect(startFolder(x1, null)).toBe('C:\\Users\\alice\\vault');
    expect(startFolder(runner({ id: 'vm', defaultDir: '/home/ubuntu/vault' }), 'work/blog')).toBe('/home/ubuntu/vault/work/blog');
    expect(startFolder(x1, '../up')).toBeNull();
    expect(startFolder(undefined, 'work')).toBeNull();
  });

  it('the picker opens at the default folder and returns the chosen folder relative to it', async () => {
    const calls = mockFetch({
      'GET /api/runners/x1/directories': (_init, url) => {
        const path = new URL(url!, 'http://hub').searchParams.get('path') ?? 'C:\\Users\\alice';
        const directories = path === 'C:\\Users\\alice\\vault' ? [{ name: 'work', path: 'C:\\Users\\alice\\vault\\work' }] : [];
        return { status: 200, body: { path, parent: 'C:\\Users\\alice', directories } };
      },
    });
    function Harness() {
      const [folder, setFolder] = useState('');
      return <ProjectFolderField id="f" value={folder} runner={x1} onChange={setFolder} />;
    }
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Выбрать…' }));
    const picker = await screen.findByRole('dialog', { name: 'Выбрать папку' });
    expect(new URL(calls[0]!.url, 'http://hub').searchParams.get('path')).toBe('C:\\Users\\alice\\vault');
    expect(await within(picker).findByRole('button', { name: '↑ Вверх' })).toBeDisabled();
    await user.click(await within(picker).findByRole('button', { name: 'work' }));
    await within(picker).findByText('C:\\Users\\alice\\vault\\work');
    await user.click(within(picker).getByRole('button', { name: 'Выбрать эту папку' }));
    expect(screen.getByLabelText('Папка проекта')).toHaveValue('work');
    expect(screen.getByText('На X1 сессия начнётся в C:\\Users\\alice\\vault\\work')).toBeInTheDocument();
  });
});
