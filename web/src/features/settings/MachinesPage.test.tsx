// Component tests of «Настройки → Машины» (change `multi-user`, spec runner-enrollment «Экран «Машины»»).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RunnerView } from '../../api/types';
import { useStore } from '../../store';
import { mockFetch, resetStore, runner } from '../../test/factories';
import { MachinesPage } from './MachinesPage';

const machines = (): RunnerView[] => [
  runner({ id: 'x1', name: 'X1', state: 'active', claudeLogin: 'ok', agentVersion: '0.3.0', outdated: false }),
  runner({ id: 'hp', name: 'HP', os: 'Ubuntu 24.04', online: false, lastSeenAt: '2026-10-25T06:41:00Z', state: 'active', claudeLogin: 'missing', agentVersion: '0.2.0', outdated: true }),
  runner({ id: 'mac', name: 'MacBook', os: 'macOS 15.1', state: 'active', claudeLogin: 'ok', protectedDirsOk: false, update: { version: '0.3.0', status: 'failed', error: 'sha_mismatch', at: '' } }),
  runner({ id: 'r-new', name: 'Моя машина', os: null, online: false, lastSeenAt: null, state: 'pending' }),
  runner({ id: 'old', name: 'Старый', os: 'Ubuntu 24.04', online: false, state: 'disabled' }),
];

const card = (name: string) => screen.getByRole('listitem', { name });

describe('MachinesPage', () => {
  beforeEach(() => {
    resetStore();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('lists the machines with status, version, Claude login and warnings', async () => {
    mockFetch({ 'GET /api/runners': () => ({ status: 200, body: { runners: machines(), agentVersion: '0.3.0' } }) });
    render(<MachinesPage />);
    expect(screen.getByRole('status')).toHaveTextContent('Загрузка');
    await screen.findByRole('listitem', { name: 'X1' });
    expect(within(card('X1')).getByText('в сети')).toBeInTheDocument();
    expect(within(card('X1')).getByText('вход есть')).toBeInTheDocument();
    expect(within(card('HP')).getByText(/не в сети с/)).toBeInTheDocument();
    expect(within(card('HP')).getByText('устарела')).toBeInTheDocument();
    // scenario «Нет входа в Claude»: the plaque with the command
    expect(within(card('HP')).getByText('нет входа')).toBeInTheDocument();
    expect(within(card('HP')).getByText('~/.agent-hub/bin/agent-hub login')).toBeInTheDocument();
    expect(within(card('MacBook')).getByText('Нет доступа к защищённым папкам macOS.')).toBeInTheDocument();
    expect(within(card('MacBook')).getByText('обновление не удалось')).toBeInTheDocument();
    expect(within(card('Моя машина')).getByText('ожидает подключения')).toBeInTheDocument();
    expect(within(card('Моя машина')).getByRole('button', { name: 'Показать команду' })).toBeInTheDocument();
    expect(within(card('Старый')).getByText('отключена')).toBeInTheDocument();
    expect(within(card('Старый')).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('Отключённые')).toBeInTheDocument();
  });

  // Requirement (runner-enrollment): Запуск под root
  it('a machine whose agent runs as root shows the bypassPermissions warning; others do not', async () => {
    mockFetch({
      'GET /api/runners': () => ({
        status: 200,
        body: {
          runners: [runner({ id: 'c', name: 'Контейнер', os: 'Ubuntu 24.04', state: 'active', runsAsRoot: true }), runner({ id: 'x1', name: 'X1', state: 'active', runsAsRoot: false })],
          agentVersion: null,
        },
      }),
    });
    render(<MachinesPage />);
    await screen.findByRole('listitem', { name: 'Контейнер' });
    expect(within(card('Контейнер')).getByText('Работает под root — режим bypassPermissions недоступен.')).toBeInTheDocument();
    expect(within(card('X1')).queryByText(/Работает под root/)).not.toBeInTheDocument();
  });

  it('empty list and a load error with «Повторить»', async () => {
    let fail = true;
    mockFetch({ 'GET /api/runners': () => (fail ? { status: 500, body: {} } : { status: 200, body: { runners: [], agentVersion: null } }) });
    const user = userEvent.setup();
    render(<MachinesPage />);
    expect(await screen.findByText(/Список машин не загружен/)).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByText('Машин пока нет. Нажмите «Добавить машину».')).toBeInTheDocument();
  });

  it('«Переименовать»: saved name, and «уже есть» for a taken one', async () => {
    let taken = true;
    const calls = mockFetch({
      'GET /api/runners': () => ({ status: 200, body: { runners: machines(), agentVersion: '0.3.0' } }),
      'PATCH /api/runners/x1': () => (taken ? { status: 409, body: { error: 'name_taken' } } : { status: 200, body: runner({ id: 'x1', name: 'Рабочий', state: 'active' }) }),
    });
    const user = userEvent.setup();
    render(<MachinesPage />);
    await screen.findByRole('listitem', { name: 'X1' });
    await user.click(within(card('X1')).getByRole('button', { name: 'Переименовать' }));
    const input = screen.getByLabelText('Новое имя для X1');
    await user.clear(input);
    await user.type(input, 'HP');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('Машина с таким именем уже есть')).toBeInTheDocument();
    taken = false;
    await user.clear(input);
    await user.type(input, 'Рабочий');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByRole('heading', { name: 'Рабочий' })).toBeInTheDocument();
    expect(calls.filter(c => c.method === 'PATCH').at(-1)?.body).toEqual({ name: 'Рабочий' });
  });

  it('scenario «Отключение машины»: confirm → the uninstall command, the card stays', async () => {
    const calls = mockFetch({
      'GET /api/runners': () => ({ status: 200, body: { runners: machines(), agentVersion: '0.3.0' } }),
      'POST /api/runners/x1/disable': () => ({
        status: 200,
        body: {
          ...runner({ id: 'x1', name: 'X1', online: false, state: 'disabled' }),
          hostname: 'x1',
          createdAt: '',
          enroll: null,
          uninstallCommand: { unix: '~/.agent-hub/uninstall.sh', windows: 'Uninstall-AgentHub' },
        },
      }),
    });
    const user = userEvent.setup();
    render(<MachinesPage />);
    await screen.findByRole('listitem', { name: 'X1' });
    await user.click(within(card('X1')).getByRole('button', { name: 'Отключить' }));
    expect(screen.getByRole('alertdialog', { name: 'Отключить X1?' })).toBeInTheDocument();
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Отключить' }));
    // X1 runs Windows: the PowerShell command
    expect(await screen.findByText('Uninstall-AgentHub')).toBeInTheDocument();
    expect(within(card('X1')).getByText('отключена')).toBeInTheDocument();
    expect(calls.some(c => c.url === '/api/runners/x1/disable')).toBe(true);
  });

  it('«Переподключить» and «Добавить машину» open the enrollment window', async () => {
    mockFetch({ 'GET /api/runners': () => ({ status: 200, body: { runners: machines(), agentVersion: '0.3.0' } }) });
    const user = userEvent.setup();
    render(<MachinesPage />);
    await screen.findByRole('listitem', { name: 'HP' });
    await user.click(within(card('HP')).getByRole('button', { name: 'Переподключить' }));
    expect(useStore.getState().modal).toEqual({ type: 'enroll', runnerId: 'hp' });
    await user.click(screen.getByRole('button', { name: 'Добавить машину' }));
    expect(useStore.getState().modal).toEqual({ type: 'enroll' });
  });

  // change client-versions: spec «Версии агентов на экране «Машины»», design D8
  it('«Список машин»: «Актуальная версия агента 0.3.0» over the list, the agent and protocol in each card', async () => {
    mockFetch({
      'GET /api/runners': () => ({
        status: 200,
        body: {
          runners: [
            runner({ id: 'x1', name: 'X1', state: 'active', agentVersion: '0.3.0', protocolVersion: '1.6' }),
            runner({ id: 'hp', name: 'HP', state: 'active', agentVersion: '0.1.2', protocolVersion: '1.5', outdated: true }),
          ],
          agentVersion: '0.3.0',
        },
      }),
    });
    render(<MachinesPage />);
    await screen.findByRole('listitem', { name: 'X1' });
    expect(screen.getByText(/Актуальная версия агента/)).toHaveTextContent('Актуальная версия агента 0.3.0');
    expect(card('X1').querySelector('.mc-ver')).toHaveTextContent('0.3.0 · протокол 1.6');
    expect(card('HP').querySelector('.mc-ver')).toHaveTextContent('0.1.2 · протокол 1.5');
    expect(within(card('HP')).getByText('устарела')).toBeInTheDocument();
  });

  it('«Сборки агента нет»: no line of the current version, no «устарела»', async () => {
    mockFetch({
      'GET /api/runners': () => ({
        status: 200,
        body: { runners: [runner({ id: 'x1', name: 'X1', state: 'active', agentVersion: '0.1.2', protocolVersion: '1.5', outdated: false })], agentVersion: null },
      }),
    });
    render(<MachinesPage />);
    await screen.findByRole('listitem', { name: 'X1' });
    expect(screen.queryByText(/Актуальная версия агента/)).not.toBeInTheDocument();
    expect(within(card('X1')).queryByText('устарела')).not.toBeInTheDocument();
  });
});
