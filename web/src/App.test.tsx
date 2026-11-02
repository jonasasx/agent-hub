// Component tests of the M1 shell: auth gate, sign-out, theme switch, live runner status.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RunnerView, SidebarResponse } from './api/types';
import { App } from './App';
import { useStore } from './store';

const runner = (over: Partial<RunnerView>): RunnerView => ({
  id: 'x1',
  name: 'X1',
  kind: 'machine',
  os: 'Windows 11 Pro',
  online: true,
  lastSeenAt: new Date().toISOString(),
  agentVersion: '0.1.0',
  claudeVersion: '2.1.310',
  protocolVersion: '1.0',
  incompatible: false,
  vaultRoot: null,
  homeDir: null,
  ...over,
});

const sidebar: SidebarResponse = {
  now: [],
  projects: [],
  runners: [runner({}), runner({ id: 'hp', name: 'HP', online: false }), runner({ id: 'vm', name: 'ВМ .3', os: 'Ubuntu 24.04' }), runner({ id: 'k', name: 'K8s', kind: 'k8s' })],
};

class FakeSocket {
  static last: FakeSocket | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  readyState = 1;
  sent: unknown[] = [];
  constructor(readonly url: string) {
    FakeSocket.last = this;
    setTimeout(() => this.onopen?.(), 0);
  }
  close() {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  emit(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

type Route = (init?: RequestInit) => { status: number; body?: unknown };

function mockFetch(routes: Record<string, Route>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const key = Object.keys(routes).find(k => url.startsWith(k));
      const r = key ? routes[key]!(init) : { status: 404, body: { error: 'not_found' } };
      return new Response(r.status === 204 ? null : JSON.stringify(r.body ?? {}), { status: r.status, headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}

const signedIn: Record<string, Route> = {
  '/api/me': () => ({ status: 200, body: { user: { id: 'u1', email: 'jonasasx@gmail.com' }, vapidPublicKey: null } }),
  '/api/sidebar': () => ({ status: 200, body: sidebar }),
  '/auth/logout': () => ({ status: 204 }),
};

describe('App', () => {
  beforeEach(() => {
    useStore.setState(useStore.getInitialState(), true);
    vi.stubGlobal('WebSocket', FakeSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('without a session redirects to Google login and back to the current address', async () => {
    mockFetch({ '/api/': () => ({ status: 401, body: { error: 'unauthenticated' } }) });
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, pathname: '/s/42', search: '?x=1', assign });
    render(<App />);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/auth/login?return=%2Fs%2F42%3Fx%3D1'));
  });

  it('signed in: left panel with empty sections and the three machines (k8s hidden)', async () => {
    mockFetch(signedIn);
    render(<App />);
    expect(await screen.findByRole('list', { name: 'Машины' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem').map(i => i.textContent)).toEqual(['X1', 'HP · не в сети', 'ВМ .3']);
    expect(screen.getByText('Ничего не ждёт ответа')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Сейчас/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^Проекты/ })).toBeInTheDocument();
    expect(FakeSocket.last?.url).toMatch(/\/ws\/ui$/);
  });

  it('«Выйти» calls POST /auth/logout and shows the signed-out screen; reload does not auto-login', async () => {
    const calls = mockFetch(signedIn);
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Профиль' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Выйти' }));
    expect(await screen.findByRole('heading', { name: 'Вы вышли' })).toBeInTheDocument();
    expect(calls.some(c => c.url === '/auth/logout' && c.init?.method === 'POST')).toBe(true);
    expect(screen.getByRole('link', { name: 'Войти' })).toHaveAttribute('href', '/auth/login?return=%2F');
    expect(sessionStorage.getItem('ah-signed-out')).toBe('1');
  });

  it('«Выйти» that fails on the server keeps the workspace and shows an error', async () => {
    mockFetch({ ...signedIn, '/auth/logout': () => ({ status: 502, body: {} }) });
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Профиль' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Выйти' }));
    expect(await screen.findByText('Не удалось выйти')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Вы вышли' })).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Машины' })).toBeInTheDocument();
    expect(sessionStorage.getItem('ah-signed-out')).toBeNull();
  });

  it('theme: dark by default, the switch makes it light and remembers the choice', async () => {
    mockFetch(signedIn);
    render(<App />);
    expect(document.documentElement.dataset.theme).toBe('dark');
    await userEvent.click(await screen.findByRole('button', { name: 'Светлая тема' }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('ah-theme')).toBe('light');
    expect(screen.getByRole('button', { name: 'Тёмная тема' })).toBeInTheDocument();
  });

  it('runner.status: HP goes online → dot turns green and «HP снова в сети» toast appears', async () => {
    mockFetch(signedIn);
    render(<App />);
    const hp = await screen.findByText('HP');
    expect(hp.querySelector('.dot')).toHaveClass('bad');
    await waitFor(() => expect(FakeSocket.last).not.toBeNull());
    act(() => FakeSocket.last!.emit({ type: 'runner.status', runner: runner({ id: 'hp', name: 'HP', online: true }) }));
    expect(screen.getByText('HP').querySelector('.dot')).toHaveClass('ok');
    expect(screen.getByText('HP снова в сети')).toBeInTheDocument();
    expect(screen.getByText('Сессии на HP можно продолжать')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
    expect(screen.queryByText('HP снова в сети')).not.toBeInTheDocument();
  });

  it('runner.status: a machine going offline turns red without a toast', async () => {
    mockFetch(signedIn);
    render(<App />);
    await screen.findByText('X1');
    await waitFor(() => expect(FakeSocket.last).not.toBeNull());
    act(() => FakeSocket.last!.emit({ type: 'runner.status', runner: runner({ online: false }) }));
    expect(screen.getByText('X1').querySelector('.dot')).toHaveClass('bad');
    expect(screen.queryByText(/снова в сети/)).not.toBeInTheDocument();
  });

  it('401 on an action while the app is open goes to login instead of an error toast', async () => {
    mockFetch(signedIn);
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, pathname: '/', search: '', assign });
    render(<App />);
    await screen.findByRole('list', { name: 'Машины' });
    mockFetch({ '/api/': () => ({ status: 401, body: { error: 'unauthenticated' } }) });
    const { sendMessage } = await import('./features/workspace/actions');
    await act(async () => {
      await sendMessage('00000000-0000-4000-8000-000000000001', 'привет');
    });
    expect(assign).toHaveBeenCalledWith('/auth/login?return=%2F');
    expect(useStore.getState().toasts.some(t => t.title === 'Не отправлено')).toBe(false);
  });

  it('shows a retry screen when the hub is unreachable', async () => {
    mockFetch({ '/api/': () => ({ status: 502, body: {} }) });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Хаб недоступен' })).toBeInTheDocument();
    mockFetch(signedIn);
    await userEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByRole('list', { name: 'Машины' })).toBeInTheDocument();
  });
});
