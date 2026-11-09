// Component tests of «Настройки → Безопасность» (change `multi-user`, spec public-access «Журнал безопасности и выход везде»).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SecurityResponse } from '../../api/types';
import { useStore } from '../../store';
import { mockFetch, resetStore } from '../../test/factories';
import { SecurityPage, browserLabel } from './SecurityPage';

const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const SAFARI_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const data = (sessions = 2): SecurityResponse => ({
  events: [
    { id: 'e1', kind: 'runner_connected', at: '2026-10-27T06:20:00Z', ip: '203.0.113.7', userAgent: null, provider: null, runner: { id: 'r-a', name: 'Ноутбук' } },
    { id: 'e2', kind: 'enroll_code_issued', at: '2026-10-27T06:18:00Z', ip: null, userAgent: null, provider: null, runner: { id: 'r-a', name: 'Ноутбук' } },
    { id: 'e3', kind: 'login', at: '2026-10-27T06:15:00Z', ip: '198.51.100.2', userAgent: SAFARI_IOS, provider: 'google', runner: null },
    { id: 'e4', kind: 'login_denied', at: '2026-10-27T06:10:00Z', ip: '198.51.100.9', userAgent: CHROME_WIN, provider: 'keycloak', runner: null },
  ],
  sessions: [
    { id: 'aaaa', createdAt: '2026-10-27T06:00:00Z', expiresAt: '2026-11-26T06:00:00Z', userAgent: CHROME_WIN, current: true },
    ...(sessions > 1 ? [{ id: 'bbbb', createdAt: '2026-10-27T06:15:00Z', expiresAt: '2026-11-26T06:15:00Z', userAgent: SAFARI_IOS, current: false }] : []),
  ],
});

describe('SecurityPage', () => {
  beforeEach(() => resetStore());
  afterEach(() => vi.unstubAllGlobals());

  it('browserLabel', () => {
    expect(browserLabel(CHROME_WIN)).toBe('Chrome · Windows');
    expect(browserLabel(SAFARI_IOS)).toBe('Safari · iOS');
    expect(browserLabel(null)).toBe('неизвестный браузер');
  });

  it('scenario «Подключение машины в журнале»: the log and the active sessions', async () => {
    mockFetch({ 'GET /api/security': () => ({ status: 200, body: data() }) });
    render(<SecurityPage />);
    expect(await screen.findByText('Подключена машина Ноутбук с адреса 203.0.113.7')).toBeInTheDocument();
    expect(screen.getByText('Выдан код подключения для Ноутбук')).toBeInTheDocument();
    expect(screen.getByText('Вход через Google с адреса 198.51.100.2')).toBeInTheDocument();
    expect(screen.getByText('Отказ во входе с адреса 198.51.100.9')).toBeInTheDocument();
    expect(screen.getByText('это устройство')).toBeInTheDocument();
    expect(screen.getByText('Журнал за 90 дней')).toBeInTheDocument();
  });

  it('scenario «Выход на всех устройствах»: the other session ends, this one stays', async () => {
    let n = 2;
    const calls = mockFetch({
      'GET /api/security': () => ({ status: 200, body: data(n) }),
      'POST /api/auth/logout-all': () => {
        n = 1;
        return { status: 200, body: { ended: 1 } };
      },
    });
    const u = userEvent.setup();
    render(<SecurityPage />);
    await u.click(await screen.findByRole('button', { name: 'Выйти на всех устройствах' }));
    expect(calls.some(c => c.url === '/api/auth/logout-all' && c.method === 'POST')).toBe(true);
    expect(useStore.getState().toasts.at(-1)?.text).toBe('Завершено 1 сеанс на других устройствах');
    expect(await screen.findByText('Других активных сеансов нет.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Выйти на всех устройствах' })).toBeDisabled();
  });

  it('keycloak-auth D5: «Управление входом» opens the provider account page; a single-provider login is named by the hub', async () => {
    const me = { user: { id: 'u1', email: 'a@b.c', role: 'user' as const, name: null, provider: 'oidc' as const }, vapidPublicKey: null, voiceInput: false, voiceTalk: false, locale: null };
    useStore.setState({ auth: { kind: 'signed_in', me: { ...me, accountUrl: 'https://id.example/realms/agent-hub/account', singleProvider: 'Agent Hub ID' } } });
    const body = data(1);
    body.events = [
      { id: 'e5', kind: 'login', at: '2026-10-27T06:15:00Z', ip: null, userAgent: null, provider: 'oidc', runner: null },
      { ...body.events[0]!, id: 'e6', kind: 'signup', runner: null },
    ];
    mockFetch({ 'GET /api/security': () => ({ status: 200, body }) });
    render(<SecurityPage />);
    const link = screen.getByRole('link', { name: 'Управление входом' });
    expect(link).toHaveAttribute('href', 'https://id.example/realms/agent-hub/account');
    expect(link).toHaveAttribute('target', '_blank');
    expect(await screen.findByText('Вход через Agent Hub ID')).toBeInTheDocument();
    expect(screen.getByText('Регистрация')).toBeInTheDocument();
  });

  it('no «Управление входом» without an account page', async () => {
    mockFetch({ 'GET /api/security': () => ({ status: 200, body: data(1) }) });
    render(<SecurityPage />);
    await screen.findByText('Журнал за 90 дней');
    expect(screen.queryByRole('link', { name: 'Управление входом' })).not.toBeInTheDocument();
  });

  it('a load error offers «Повторить»', async () => {
    mockFetch({ 'GET /api/security': () => ({ status: 500, body: {} }) });
    render(<SecurityPage />);
    expect(await screen.findByText(/Журнал не загружен/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
  });
});
