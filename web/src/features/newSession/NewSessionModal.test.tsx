// Component tests of «Новая сессия» (task 2.12). Requirement (sessions): Запуск сессии из UI.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useStore } from '../../store';
import { RUNNERS, mockFetch, resetStore, runner, session } from '../../test/factories';
import { NewSessionModal } from './NewSessionModal';

function show() {
  useStore.setState({
    runners: RUNNERS,
    models: [
      { value: 'opus', displayName: 'Opus 5.5' },
      { value: 'haiku', displayName: 'Haiku 5.5' },
    ],
  });
  const onClose = vi.fn();
  render(<NewSessionModal onClose={onClose} />);
  return onClose;
}

describe('NewSessionModal', () => {
  beforeEach(resetStore);
  afterEach(() => vi.unstubAllGlobals());

  it('defaults: first online runner, default agent and “Определи сам”; fields follow the approved order', () => {
    show();
    expect(screen.getByRole('radio', { name: /X1/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /HP/ })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /HP/ })).toHaveTextContent('не в сети');
    expect(screen.getByRole('button', { name: /✦ Определи сам/ })).toHaveClass('on');
    const fields = [...document.querySelectorAll('.modal-body .field label, .modal-body .field .lbl')].map(x => x.textContent?.trim());
    expect(fields.indexOf('Где запустить')).toBeLessThan(fields.indexOf('Агент'));
    expect(fields.indexOf('Агент')).toBeLessThan(fields.indexOf('Первое сообщение'));
    expect(fields.indexOf('Первое сообщение')).toBeLessThan(fields.findIndex(x => x?.startsWith('Проект')));
    expect(fields.findIndex(x => x?.startsWith('Проект'))).toBeLessThan(fields.indexOf('Режим прав'));
    expect(fields.indexOf('Режим прав')).toBeLessThan(fields.indexOf('Модель'));
    expect(screen.getByLabelText('Режим прав')).toHaveValue('bypassPermissions');
    expect(screen.getByLabelText('Модель')).toHaveValue('opus');
    expect(screen.queryByLabelText('Каталог')).not.toBeInTheDocument();
    expect(screen.getByText('Точное совпадение определит проект; предположение можно подтвердить в сессии.')).toBeInTheDocument();
    expect(screen.getAllByText(/Точное совпадение определит проект/)).toHaveLength(1);
    const sort = screen.getByRole('group', { name: 'Сортировка проектов' });
    expect(screen.getByRole('button', { name: 'по последнему событию' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(sort).getByRole('button', { name: 'по имени' })).toHaveAttribute('aria-pressed', 'false');
  });

  // Requirement (runner-enrollment): Запуск под root
  it('a root machine: bypassPermissions disabled with a hint, acceptEdits chosen; back to bypassPermissions elsewhere', async () => {
    const calls = mockFetch({ 'POST /api/sessions': () => ({ status: 201, body: session({ runnerId: 'c' }) }) });
    useStore.setState({
      runners: [runner({ id: 'c', name: 'Контейнер', os: 'Ubuntu 24.04', homeDir: '/root', vaultRoot: null, runsAsRoot: true }), runner({ id: 'x1', name: 'X1' })],
      models: [{ value: 'opus', displayName: 'Opus 5.5' }],
    });
    render(<NewSessionModal onClose={vi.fn()} />);
    const mode = screen.getByLabelText('Режим прав');
    expect(mode).toHaveValue('acceptEdits');
    expect(screen.getByRole('option', { name: 'bypassPermissions — недоступен под root' })).toBeDisabled();
    expect(mode).toHaveAccessibleDescription('Агент на Контейнер работает под root — bypassPermissions недоступен');
    await userEvent.type(screen.getByLabelText('Первое сообщение'), 'привет');
    await userEvent.click(screen.getByRole('button', { name: /Запустить/ }));
    expect(calls.find(c => c.url.includes('/api/sessions'))?.body).toMatchObject({ runnerId: 'c', permissionMode: 'acceptEdits' });
  });

  it('switching to a root machine moves bypassPermissions to acceptEdits', async () => {
    useStore.setState({
      runners: [runner({ id: 'x1', name: 'X1' }), runner({ id: 'c', name: 'Контейнер', os: 'Ubuntu 24.04', homeDir: '/root', vaultRoot: null, runsAsRoot: true })],
      models: [{ value: 'opus', displayName: 'Opus 5.5' }],
    });
    render(<NewSessionModal onClose={vi.fn()} />);
    expect(screen.getByLabelText('Режим прав')).toHaveValue('bypassPermissions');
    expect(screen.getByRole('option', { name: 'bypassPermissions' })).toBeEnabled();
    await userEvent.click(screen.getByRole('radio', { name: /Контейнер/ }));
    expect(screen.getByLabelText('Режим прав')).toHaveValue('acceptEdits');
  });

  it('the default mode follows the machine when runsAsRoot arrives later; a mode the user picked stays', async () => {
    useStore.setState({ runners: [runner({ id: 'c', name: 'Контейнер', os: 'Ubuntu 24.04', homeDir: '/root', vaultRoot: null })], models: [{ value: 'opus', displayName: 'Opus 5.5' }] });
    render(<NewSessionModal onClose={vi.fn()} />);
    expect(screen.getByLabelText('Режим прав')).toHaveValue('bypassPermissions');
    act(() => useStore.setState({ runners: [runner({ id: 'c', name: 'Контейнер', os: 'Ubuntu 24.04', homeDir: '/root', vaultRoot: null, runsAsRoot: true })] }));
    expect(screen.getByLabelText('Режим прав')).toHaveValue('acceptEdits');
    await userEvent.selectOptions(screen.getByLabelText('Режим прав'), 'plan');
    act(() => useStore.setState({ runners: [runner({ id: 'c', name: 'Контейнер', os: 'Ubuntu 24.04', homeDir: '/root', vaultRoot: null, runsAsRoot: false })] }));
    expect(screen.getByLabelText('Режим прав')).toHaveValue('plan');
  });

  it('UI review H3: Tab stays inside the dialog, the app behind is inert, Esc closes, the opener gets the focus back', async () => {
    const app = document.createElement('div');
    app.className = 'app';
    const opener = document.createElement('button');
    app.appendChild(opener);
    document.body.appendChild(app);
    opener.focus();
    useStore.setState({ runners: RUNNERS, models: [{ value: 'opus', displayName: 'Opus 5.5' }] });
    const onClose = vi.fn();
    const view = render(<NewSessionModal onClose={onClose} />);
    expect(app).toHaveAttribute('inert');
    const dialog = screen.getByRole('dialog', { name: 'Новая сессия' });
    for (let i = 0; i < 12; i++) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    for (let i = 0; i < 4; i++) {
      await userEvent.tab({ shift: true });
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
    view.unmount();
    expect(app).not.toHaveAttribute('inert');
    expect(opener).toHaveFocus();
    app.remove();
  });

  it('the required first message is validated and Ctrl+Enter submits', async () => {
    const calls = mockFetch({});
    show();
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    expect(calls.some(c => c.url === '/api/sessions')).toBe(false);
    expect(screen.getByLabelText('Первое сообщение')).toHaveAccessibleDescription('Напишите первое сообщение или прикрепите изображение');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByText('Ctrl+Enter — запустить')).toBeInTheDocument();
  });

  it('switching the runner preserves the no-project choice and machine selection', async () => {
    show();
    await userEvent.click(screen.getByRole('radio', { name: /ВМ \.3/ }));
    expect(screen.getByRole('radio', { name: /ВМ \.3/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: /✦ Определи сам/ })).toHaveClass('on');
  });

  it('sorts projects by name and requires a folder binding before launch', async () => {
    const zulu = { id: 'p-zulu', name: 'Zulu', description: '', remote: null, archived: false, lastEventAt: null, bindings: [] };
    const alpha = { id: 'p-alpha', name: 'Alpha', description: '', remote: null, archived: false, lastEventAt: null, bindings: [] };
    const calls = mockFetch({
      'GET /api/catalog/projects?sort=recent': () => ({ status: 200, body: [zulu, alpha] }),
      'GET /api/catalog/projects?sort=name': () => ({ status: 200, body: [alpha, zulu] }),
      'GET /api/preferences/launch': () => ({ status: 200, body: { runnerId: 'x1', provider: 'claude' } }),
      'PUT /api/catalog/projects/p-zulu/bindings/x1': () => ({ status: 200, body: { ok: true } }),
      'POST /api/sessions': () => ({ status: 201, body: session({ runnerId: 'x1', cwd: 'C:\\work\\zulu' }) }),
    });
    show();
    await userEvent.click(await screen.findByRole('button', { name: /Zulu/ }));
    expect(screen.getByRole('button', { name: /Zulu/ })).toHaveTextContent('нет каталога на X1 — привязать');
    await userEvent.click(screen.getByRole('button', { name: 'по имени' }));
    const rows = [...document.querySelectorAll('.project-list .seg-opt b')].map(el => el.textContent?.trim());
    expect(rows.indexOf('Alpha')).toBeLessThan(rows.indexOf('Zulu'));
    expect(screen.getByLabelText('Путь папки для привязки')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Первое сообщение'), 'Проверь папку');
    await userEvent.click(screen.getByRole('button', { name: 'Запустить' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Нет каталога на этой машине');
    expect(calls.some(c => c.url === '/api/sessions')).toBe(false);
    await userEvent.type(screen.getByLabelText('Путь папки для привязки'), 'C:\\work\\zulu');
    await userEvent.click(screen.getByRole('button', { name: 'Запустить' }));
    await vi.waitFor(() => expect(calls.find(c => c.url === '/api/sessions')?.body).toMatchObject({ projectId: 'p-zulu', cwd: 'C:\\work\\zulu' }));
    expect(calls.find(c => c.url === '/api/catalog/projects/p-zulu/bindings/x1')?.body).toEqual({ path: 'C:\\work\\zulu' });
  });

  it('keeps a long project list contained, hides archived projects, and exposes paths only as titles', async () => {
    const projects = Array.from({ length: 6 }, (_, i) => ({
      id: `project-${i}`,
      name: `Project ${i} with a long name that must wrap instead of stretching the dialog`,
      description: '',
      remote: null,
      archived: false,
      lastEventAt: null,
      bindings: [{ runnerId: 'x1', path: `C:\\work\\project-${i}` }],
    }));
    projects.push({ id: 'archived-project', name: 'Archived project', description: '', remote: null, archived: true, lastEventAt: null, bindings: [] });
    mockFetch({ 'GET /api/catalog/projects?sort=recent': () => ({ status: 200, body: projects }) });
    show();
    const first = await screen.findByRole('button', { name: /Project 0 with a long name/ });
    expect(first).toHaveAttribute('title', 'C:\\work\\project-0');
    expect(first).not.toHaveTextContent('C:\\work\\project-0');
    expect(screen.getAllByRole('button', { name: /Project [0-5] with a long name/ })).toHaveLength(6);
    expect(screen.queryByRole('button', { name: /Archived project/ })).not.toBeInTheDocument();
    expect(document.querySelector('.project-list')).toHaveClass('project-list');
    expect(document.querySelector('.project-sort')).toHaveClass('project-sort');
  });

  it('restores the last online machine and its default directory for the next launch', async () => {
    const created = session({ runnerId: 'vm', cwd: '/home/ubuntu/vault' });
    const calls = mockFetch({
      'GET /api/preferences/launch': () => ({ status: 200, body: { runnerId: 'vm', provider: 'claude' } }),
      'POST /api/sessions': () => ({ status: 201, body: created }),
      '/api/sessions/': () => ({ status: 200, body: { events: [], before: null } }),
      '/api/sidebar': () => ({ status: 200, body: { now: [], projects: [], runners: RUNNERS } }),
    });
    show();
    await vi.waitFor(() => expect(screen.getByRole('radio', { name: /ВМ \.3/ })).toHaveAttribute('aria-checked', 'true'));
    await userEvent.type(screen.getByLabelText('Первое сообщение'), 'привет');
    await userEvent.click(screen.getByRole('button', { name: 'Запустить' }));
    await vi.waitFor(() => expect(calls.find(c => c.url === '/api/sessions')?.body).toMatchObject({ runnerId: 'vm', cwd: '/home/ubuntu/vault' }));
  });

  it('restores the last Codex agent and HP when that machine is online', async () => {
    const codex = {
      id: 'codex' as const,
      version: '0.166.0',
      login: 'ok' as const,
      account: { email: 'ivan@example.com', plan: 'pro' },
      models: [{ value: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol' }],
    };
    useStore.setState({
      runners: [runner(), runner({ id: 'hp', name: 'HP', providers: [codex] })],
      models: [{ value: 'opus', displayName: 'Opus 5.5' }],
    });
    mockFetch({ 'GET /api/preferences/launch': () => ({ status: 200, body: { runnerId: 'hp', provider: 'codex' } }) });
    render(<NewSessionModal onClose={vi.fn()} />);
    await vi.waitFor(() => {
      expect(screen.getByRole('radio', { name: /HP/ })).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByRole('radio', { name: /Codex/ })).toHaveAttribute('aria-checked', 'true');
    });
    expect(screen.getByLabelText('Модель')).toHaveValue('gpt-6.1-sol');
  });

  it('an empty first message is not sent', async () => {
    const calls = mockFetch({});
    show();
    await userEvent.click(screen.getByRole('button', { name: 'Запустить' }));
    expect(screen.getByText('Напишите первое сообщение или прикрепите изображение')).toBeInTheDocument();
    expect(calls.some(c => c.url === '/api/sessions')).toBe(false);
  });

  it('explicit project launch uses its runner binding and does not show the path in the project row', async () => {
    const calls = mockFetch({
      'GET /api/catalog/projects': () => ({
        status: 200,
        body: [
          {
            id: 'ef6c84c5-9850-4aa6-84d1-43010a68266f',
            name: 'Agent Hub',
            description: '',
            remote: null,
            archived: false,
            lastEventAt: null,
            bindings: [{ runnerId: 'x1', path: 'C:\\work\\agent-hub' }],
          },
        ],
      }),
      'POST /api/sessions': () => ({ status: 201, body: session() }),
    });
    show();
    await userEvent.click(await screen.findByRole('button', { name: /Agent Hub/ }));
    expect(screen.getByRole('button', { name: /Agent Hub/ })).not.toHaveTextContent('C:\\work');
    await userEvent.type(screen.getByLabelText('Первое сообщение'), 'Проверь проект');
    await userEvent.click(screen.getByRole('button', { name: 'Запустить' }));
    expect(calls.find(c => c.url === '/api/sessions')?.body).toMatchObject({ cwd: 'C:\\work\\agent-hub', projectId: 'ef6c84c5-9850-4aa6-84d1-43010a68266f' });
  });

  it('creates a project with its runner binding, then launches the session in that folder', async () => {
    const id = 'ef6c84c5-9850-4aa6-84d1-43010a68266f';
    const calls = mockFetch({
      'POST /api/catalog/projects': () => ({
        status: 201,
        body: { id, name: 'Blog', description: 'site', remote: 'https://git.example/blog.git', archived: false, lastEventAt: null, bindings: [{ runnerId: 'x1', path: 'C:\\work\\blog' }] },
      }),
      'POST /api/sessions': () => ({ status: 201, body: session() }),
    });
    show();
    await userEvent.click(screen.getByRole('button', { name: /Создать новый проект/ }));
    await userEvent.type(screen.getByLabelText('Название'), 'Blog');
    await userEvent.type(screen.getByLabelText('Папка на X1'), 'C:\\work\\blog');
    await userEvent.type(screen.getByLabelText('Описание · необязательно'), 'site');
    await userEvent.type(screen.getByLabelText('Remote Git · необязательно'), 'https://git.example/blog.git');
    await userEvent.type(screen.getByLabelText('Первое сообщение'), 'Начни работу');
    await userEvent.click(screen.getByRole('button', { name: 'Запустить' }));
    expect(calls.find(c => c.url === '/api/catalog/projects')?.body).toMatchObject({
      name: 'Blog',
      path: 'C:\\work\\blog',
      description: 'site',
      remote: 'https://git.example/blog.git',
      runnerId: 'x1',
    });
    expect(calls.find(c => c.url === '/api/sessions')?.body).toMatchObject({ projectId: id, cwd: 'C:\\work\\blog', prompt: 'Начни работу' });
  });

  it('409 runner_offline is shown at the runner choice', async () => {
    mockFetch({ 'POST /api/sessions': () => ({ status: 409, body: { error: 'runner_offline' } }) });
    show();
    await userEvent.type(screen.getByLabelText('Первое сообщение'), 'hostname');
    await userEvent.click(screen.getByRole('button', { name: 'Запустить' }));
    expect(await screen.findByText('X1 не в сети')).toBeInTheDocument();
  });

  it('success: POST body, the form closes, the session opens as the active tab', async () => {
    const created = session({ title: 'hostname', status: 'working' });
    const calls = mockFetch({
      'POST /api/sessions': () => ({ status: 201, body: created }),
      '/api/sessions/': () => ({ status: 200, body: { events: [], before: null } }),
      '/api/sidebar': () => ({ status: 200, body: { now: [], projects: [], runners: RUNNERS } }),
    });
    const onClose = show();
    await userEvent.selectOptions(screen.getByLabelText('Режим прав'), 'default');
    await userEvent.selectOptions(screen.getByLabelText('Модель'), 'haiku');
    await userEvent.type(screen.getByLabelText('Первое сообщение'), 'Скажи hostname');
    await userEvent.click(screen.getByRole('button', { name: 'Запустить' }));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.find(c => c.url === '/api/sessions')).toMatchObject({
      method: 'POST',
      body: { runnerId: 'x1', cwd: 'C:\\Users\\alice\\vault', permissionMode: 'default', model: 'haiku', prompt: 'Скажи hostname' },
    });
    const ws = useStore.getState().ws;
    expect(ws.panes[ws.focus]!.active).toBe(created.id);
  });
});
