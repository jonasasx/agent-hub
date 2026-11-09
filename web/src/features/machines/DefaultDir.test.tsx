// session-folder D2: the default folder of a machine is chosen in the enrollment wizard and from the machine menu.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useStore } from '../../store';
import { mockFetch, resetStore, runner } from '../../test/factories';
import { DefaultDirField } from './DefaultDir';
import { MachineChip } from './MachineMenu';

const vm = runner({ id: 'vm', name: 'ВМ .3', os: 'Ubuntu 24.04', defaultDir: '/home/ubuntu/vault', homeDir: '/home/ubuntu' });

function machineFetch() {
  return mockFetch({
    'GET /api/runners/vm/directories': (_init, url) => {
      const path = new URL(url!, 'http://hub').searchParams.get('path') ?? '/home/ubuntu';
      return { status: 200, body: { path, parent: '/home/ubuntu', directories: [{ name: 'code', path: '/home/ubuntu/code' }] } };
    },
    'PATCH /api/runners/vm': () => ({ status: 200, body: { ...vm, defaultDir: '/home/ubuntu/code' } }),
  });
}

async function chooseCode(user: ReturnType<typeof userEvent.setup>) {
  const picker = await screen.findByRole('dialog', { name: 'Выбрать папку' });
  await user.click(await within(picker).findByRole('button', { name: 'code' }));
  await within(picker).findByText('/home/ubuntu/code');
  await user.click(within(picker).getByRole('button', { name: 'Выбрать эту папку' }));
}

describe('default folder of a machine', () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    resetStore();
    useStore.setState({ runners: [vm] });
  });

  it('the wizard block shows the current folder and saves the chosen one with PATCH /api/runners/:id', async () => {
    const calls = machineFetch();
    const user = userEvent.setup();
    render(<DefaultDirField runner={vm} />);
    expect(screen.getByTestId('default-dir')).toHaveTextContent('/home/ubuntu/vault');
    await user.click(screen.getByRole('button', { name: 'Изменить…' }));
    await chooseCode(user);
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PATCH')?.body).toEqual({ defaultDir: '/home/ubuntu/code' }));
    await vi.waitFor(() => expect(useStore.getState().runners.find(r => r.id === 'vm')?.defaultDir).toBe('/home/ubuntu/code'));
    expect(screen.getByTestId('default-dir')).toHaveTextContent('/home/ubuntu/code');
  });

  it('«Изменить…» is disabled while the machine is offline', () => {
    useStore.setState({ runners: [{ ...vm, online: false }] });
    render(<DefaultDirField runner={vm} />);
    expect(screen.getByRole('button', { name: 'Изменить…' })).toBeDisabled();
  });

  it('the machine menu opens the picker and saves the folder', async () => {
    const calls = machineFetch();
    const user = userEvent.setup();
    render(<MachineChip r={vm} />);
    await user.click(screen.getByRole('button', { name: /ВМ \.3/ }));
    await user.click(screen.getByRole('menuitem', { name: /Папка по умолчанию/ }));
    await chooseCode(user);
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PATCH' && c.url === '/api/runners/vm')?.body).toEqual({ defaultDir: '/home/ubuntu/code' }));
  });
});
