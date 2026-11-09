// Component tests of the multi-user shell (change `multi-user`): the welcome screen, «Настройки» in the profile menu
// by role, `/settings/<tab>` addresses, «Доступ отключён» on /ws/ui close 4403, the «Нет входа в Claude» plaque in the
// session header and «Начать первую сессию» in the new-session form.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse, RunnerView, SidebarResponse } from '../../api/types';
import { App } from '../../App';
import { useStore } from '../../store';
import { mcpImportPreview, mockFetch, resetStore, runner, session } from '../../test/factories';
import { ClaudeLoginBanner } from '../chat/Chat';
import { NewSessionModal } from '../newSession/NewSessionModal';

class FakeSocket {
  static last: FakeSocket | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  readyState = 1;
  constructor(readonly url: string) {
    FakeSocket.last = this;
    setTimeout(() => this.onopen?.(), 0);
  }
  close() {}
  send() {}
  emit(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const me = (role: 'admin' | 'user'): MeResponse => ({
  user:
    role === 'admin'
      ? { id: 'u-ivan', email: 'alice@example.com', role, name: 'Алиса Смит', provider: 'google' }
      : { id: 'u-ks', email: 'bob@example.com', role, name: 'Борис Смит', provider: 'google' },
  vapidPublicKey: null,
  voiceInput: false,
  voiceTalk: false,
  locale: null,
  accountUrl: null,
  singleProvider: null,
});
const sidebar = (runners: RunnerView[]): SidebarResponse => ({ now: [], projects: [], runners });

function routes(role: 'admin' | 'user', runners: RunnerView[]) {
  return mockFetch({
    'GET /api/me': () => ({ status: 200, body: me(role) }),
    'GET /api/sidebar': () => ({ status: 200, body: sidebar(runners) }),
    'GET /api/models': () => ({ status: 200, body: [] }),
    'GET /api/layout': () => ({ status: 200, body: { layout: null, savedLayout: null, openedAt: {} } }),
    'PUT /api/layout': () => ({ status: 200, body: {} }),
    'GET /api/runners': () => ({ status: 200, body: { runners, agentVersion: '0.3.0' } }),
    'GET /api/security': () => ({ status: 200, body: { events: [], sessions: [] } }),
  });
}

describe('multi-user shell', () => {
  beforeEach(() => {
    resetStore();
    vi.stubGlobal('WebSocket', FakeSocket);
    window.history.replaceState(null, '', '/');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
  });

  it('scenario «Первый вход»: the welcome screen without the panel; the machine connected → the work area', async () => {
    routes('user', []);
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Борис, добро пожаловать' })).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Сессии и проекты' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Подключить машину' }));
    expect(screen.getByRole('dialog', { name: 'Подключить машину' })).toBeInTheDocument();
    // scenario «Окно закрыто до конца установки»: the window is closed, the machine comes online later
    await user.click(screen.getByRole('button', { name: 'Отмена' }));
    await waitFor(() => expect(FakeSocket.last?.onmessage).toBeTruthy());
    act(() => FakeSocket.last!.emit({ type: 'runner.status', runner: runner({ id: 'r-a', name: 'Ноутбук', state: 'active', defaultDir: null }) }));
    expect(await screen.findByRole('complementary', { name: 'Сессии и проекты' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Машины' })).toHaveTextContent('Ноутбук');
  });

  it('scenario «Успешное подключение» from the welcome screen: the window keeps its code while the work area appears', async () => {
    const pendingR = runner({ id: 'r-a', name: 'Моя машина', os: null, online: false, state: 'pending', homeDir: null, defaultDir: null });
    const calls = mockFetch({
      'GET /api/me': () => ({ status: 200, body: me('user') }),
      'GET /api/sidebar': () => ({ status: 200, body: sidebar([]) }),
      'GET /api/models': () => ({ status: 200, body: [] }),
      'GET /api/layout': () => ({ status: 200, body: { layout: null, savedLayout: null, openedAt: {} } }),
      'PUT /api/layout': () => ({ status: 200, body: {} }),
      'POST /api/runners': () => ({
        status: 201,
        body: {
          runner: pendingR,
          code: 'A'.repeat(26),
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          commands: { unix: 'curl -fsSL https://h/install.sh | bash -s -- AAA', windows: 'irm https://h/install.ps1 | iex; Install-AgentHub AAA' },
        },
      }),
      'POST /api/mcp/registry/import/preview': () => ({ status: 200, body: mcpImportPreview({ machineId: 'r-a' }) }),
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Подключить машину' }));
    await user.click(screen.getByRole('radio', { name: 'Linux' }));
    await user.click(screen.getByRole('button', { name: 'Получить команду' }));
    expect(await screen.findByText(/install\.sh/)).toBeInTheDocument();
    await waitFor(() => expect(FakeSocket.last?.onmessage).toBeTruthy());
    const active = { ...pendingR, state: 'active' as const, online: true, os: 'Ubuntu 24.04', homeDir: '/home/ubuntu', claudeLogin: 'ok' as const };
    act(() => FakeSocket.last!.emit({ type: 'runner.enroll', runnerId: 'r-a', stage: 'connected', runner: active }));
    // the panel appeared behind the window, the window is the same
    expect(await screen.findByRole('complementary', { name: 'Сессии и проекты' })).toBeInTheDocument();
    expect(screen.getByText('Машина подключилась')).toBeInTheDocument();
    act(() => FakeSocket.last!.emit({ type: 'runner.enroll', runnerId: 'r-a', stage: 'ready', runner: active }));
    await user.click(await screen.findByRole('button', { name: 'Начать первую сессию' }));
    expect(screen.getByRole('dialog', { name: 'Новая сессия' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Каталог')).not.toBeInTheDocument();
    expect(calls.filter(c => c.url === '/api/runners' && c.method === 'POST')).toHaveLength(1);
  });

  it('a pending machine does not count as connected', async () => {
    routes('user', []);
    render(<App />);
    await screen.findByRole('button', { name: 'Подключить машину' });
    await waitFor(() => expect(FakeSocket.last?.onmessage).toBeTruthy());
    act(() => FakeSocket.last!.emit({ type: 'runner.status', runner: runner({ id: 'r-a', name: 'Моя машина', online: false, state: 'pending' }) }));
    expect(screen.getByRole('button', { name: 'Подключить машину' })).toBeInTheDocument();
  });

  it('the profile menu: «Пользователи» only for admin; settings open as /settings/<tab>', async () => {
    routes('user', [runner({ state: 'active' })]);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Профиль' }));
    expect(screen.getByRole('menuitem', { name: 'Машины' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Безопасность' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Пользователи' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Безопасность' }));
    expect(window.location.pathname).toBe('/settings/security');
    expect(await screen.findByRole('heading', { name: 'Безопасность' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Пользователи' })).not.toBeInTheDocument();
    await user.click(within(screen.getByRole('region', { name: 'Настройки' })).getByRole('button', { name: 'Машины' }));
    expect(window.location.pathname).toBe('/settings/machines');
    expect(await screen.findByRole('heading', { name: 'Машины' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Закрыть настройки' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Настройки' })).not.toBeInTheDocument());
  });

  it('claude-subscriptions P12: role user sees «Подписки» and «Расход» in the menu and the navigation; /settings/usage opens the usage; no «⚙»', async () => {
    const subs = { enabled: true, subscriptions: [], lastChoiceId: null, defaultId: null, connectorsHint: false };
    mockFetch({
      'GET /api/me': () => ({ status: 200, body: me('user') }),
      'GET /api/sidebar': () => ({ status: 200, body: sidebar([runner({ state: 'active' })]) }),
      'GET /api/models': () => ({ status: 200, body: [] }),
      'GET /api/layout': () => ({ status: 200, body: { layout: null, savedLayout: null, openedAt: {} } }),
      'PUT /api/layout': () => ({ status: 200, body: {} }),
      'GET /api/runners': () => ({ status: 200, body: { runners: [runner({ state: 'active' })], agentVersion: '0.3.0' } }),
      'GET /api/subscriptions': () => ({ status: 200, body: subs }),
      'GET /api/subscriptions/usage': () => ({ status: 200, body: { from: new Date().toISOString(), to: new Date().toISOString(), rows: [] } }),
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Профиль' }));
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Подписки' })).toBeInTheDocument());
    expect(screen.getByRole('menuitem', { name: 'Расход' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Подписки Claude' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Подписки' }));
    expect(window.location.pathname).toBe('/settings/subscriptions');
    expect(await screen.findByRole('heading', { level: 2, name: 'Подписки' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Разделы настроек' });
    expect([...nav.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Машины', 'Подписки', 'Расход', 'Безопасность', 'Уведомления', 'Язык']);
    await user.click(screen.getByRole('button', { name: 'Расход' }));
    expect(window.location.pathname).toBe('/settings/usage');
    expect(await screen.findByRole('heading', { level: 2, name: 'Расход' })).toBeInTheDocument();
  });

  it('claude-subscriptions P12: a direct /settings/usage opens the usage section', async () => {
    window.history.replaceState(null, '', '/settings/usage');
    mockFetch({
      'GET /api/me': () => ({ status: 200, body: me('user') }),
      'GET /api/sidebar': () => ({ status: 200, body: sidebar([runner({ state: 'active' })]) }),
      'GET /api/models': () => ({ status: 200, body: [] }),
      'GET /api/layout': () => ({ status: 200, body: { layout: null, savedLayout: null, openedAt: {} } }),
      'PUT /api/layout': () => ({ status: 200, body: {} }),
      'GET /api/subscriptions': () => ({ status: 200, body: { enabled: true, subscriptions: [], lastChoiceId: null, defaultId: null, connectorsHint: false } }),
      'GET /api/subscriptions/usage': () => ({ status: 200, body: { from: new Date().toISOString(), to: new Date().toISOString(), rows: [] } }),
    });
    render(<App />);
    expect(await screen.findByRole('heading', { level: 2, name: 'Расход' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/settings/usage');
  });

  it('claude-subscriptions P12: a hub without the subscriptions API (404) — no sections, /settings/subscriptions answers «Страница не найдена»', async () => {
    window.history.replaceState(null, '', '/settings/subscriptions');
    routes('user', [runner({ state: 'active' })]);
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Страница не найдена' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Разделы настроек' });
    expect(nav).not.toHaveTextContent('Подписки');
    expect(nav).not.toHaveTextContent('Расход');
    await user.click(screen.getByRole('button', { name: 'Профиль' }));
    expect(screen.queryByRole('menuitem', { name: 'Подписки' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Расход' })).not.toBeInTheDocument();
  });

  it('admin sees «Пользователи» in the menu', async () => {
    routes('admin', [runner({ state: 'active' })]);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Профиль' }));
    expect(screen.getByRole('menuitem', { name: 'Пользователи' })).toBeInTheDocument();
  });

  it('/settings/users for role user: «Страница не найдена», no admin request', async () => {
    window.history.replaceState(null, '', '/settings/users');
    const calls = routes('user', [runner({ state: 'active' })]);
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Страница не найдена' })).toBeInTheDocument();
    expect(calls.some(c => c.url.startsWith('/api/admin/'))).toBe(false);
  });

  it('/ws/ui closed with 4403 → «Доступ отключён» (/auth/disabled)', async () => {
    routes('user', [runner({ state: 'active' })]);
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, pathname: '/', search: '', assign });
    render(<App />);
    await screen.findByRole('button', { name: 'Профиль' });
    await waitFor(() => expect(FakeSocket.last?.onclose).toBeTruthy());
    act(() => FakeSocket.last!.onclose!({ code: 4403 }));
    expect(assign).toHaveBeenCalledWith('/auth/disabled');
  });

  it('«Нет входа в Claude»: the plaque in the session header with the command', () => {
    useStore.setState({ runners: [runner({ id: 'vm', name: 'ВМ', os: 'Ubuntu 24.04', claudeLogin: 'rejected' })] });
    render(<ClaudeLoginBanner s={session({ runnerId: 'vm' })} />);
    expect(screen.getByText('Нет входа в Claude на ВМ.')).toBeInTheDocument();
    expect(screen.getByText('~/.agent-hub/bin/agent-hub login')).toBeInTheDocument();
  });

  it('no plaque when the login is there or unknown', () => {
    useStore.setState({ runners: [runner({ id: 'vm', claudeLogin: 'ok' }), runner({ id: 'x1', claudeLogin: null })] });
    const { container } = render(
      <>
        <ClaudeLoginBanner s={session({ runnerId: 'vm' })} />
        <ClaudeLoginBanner s={session({ runnerId: 'x1' })} />
      </>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('«Начать первую сессию»: the machine chosen, no folder field; a disabled machine is not offered', () => {
    useStore.setState({
      runners: [
        runner({ id: 'old', name: 'Старый', state: 'disabled', online: false }),
        runner({ id: 'x1', name: 'X1', online: true }),
        runner({ id: 'r-a', name: 'Ноутбук', os: 'macOS 15.1', defaultDir: null, homeDir: '/Users/bob', state: 'active' }),
      ],
    });
    render(<NewSessionModal preset={{ runnerId: 'r-a', first: true }} onClose={() => undefined} />);
    expect(screen.getByRole('radio', { name: /Ноутбук/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('radio', { name: /Старый/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Каталог')).not.toBeInTheDocument();
    expect(screen.getByText('Выберите машину и проект — каталог запуска задаёт проект.')).toBeInTheDocument();
    expect(screen.getByLabelText('Первое сообщение')).toHaveFocus();
  });
});
