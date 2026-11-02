// Component tests of «Настройки → Пользователи» (change `multi-user`, spec users «Приглашение», «Отключение
// пользователя», «Администратор не видит чужие сессии»).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AdminUserView, InviteView, MeResponse } from '../../api/types';
import { useStore } from '../../store';
import { mockFetch, resetStore } from '../../test/factories';
import { UsersPage, machinesText, termLeft } from './UsersPage';

const me: MeResponse = { user: { id: 'u-ivan', email: 'jonasasx@gmail.com', role: 'admin', name: 'Иван Волынкин', provider: 'google' }, vapidPublicKey: null, voiceInput: false };
const user = (over: Partial<AdminUserView>): AdminUserView => ({
  id: 'u-ivan',
  email: 'jonasasx@gmail.com',
  name: 'Иван Волынкин',
  provider: 'google',
  role: 'admin',
  status: 'active',
  invitedAt: null,
  lastLoginAt: '2026-10-27T05:00:00Z',
  createdAt: '2026-10-01T00:00:00Z',
  machines: { total: 3, online: 2 },
  ...over,
});
const invite = (over: Partial<InviteView>): InviteView => ({
  id: 'i1',
  email: 'colleague@example.com',
  provider: 'keycloak',
  status: 'active',
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  usedAt: null,
  revokedAt: null,
  ...over,
});

const USERS = [user({}), user({ id: 'u-ks', email: 'bob@example.com', name: 'Борис', role: 'user', invitedAt: '2026-10-27T06:00:00Z', machines: { total: 2, online: 1 } })];

describe('UsersPage', () => {
  beforeEach(() => {
    resetStore();
    useStore.setState({ auth: { kind: 'signed_in', me } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('helpers', () => {
    expect(machinesText({ total: 2, online: 1 })).toBe('2 машины, 1 в сети');
    expect(machinesText({ total: 0, online: 0 })).toBe('нет машин');
    expect(termLeft(new Date(Date.now() + 7 * 86_400_000).toISOString())).toBe('7 дней');
    expect(termLeft(new Date(Date.now() + 3 * 3_600_000).toISOString())).toBe('3 часа');
  });

  it('scenario «Иван открывает «Пользователи»»: aggregates only, no disabling himself', async () => {
    mockFetch({
      'GET /api/admin/users': () => ({ status: 200, body: { users: USERS } }),
      'GET /api/admin/invites': () => ({ status: 200, body: { invites: [invite({ status: 'used', usedAt: '2026-10-27T06:10:00Z', email: 'bob@example.com', provider: 'google' })] } }),
    });
    render(<UsersPage />);
    const ks = await screen.findByRole('listitem', { name: 'bob@example.com' });
    expect(within(ks).getByText('2 машины, 1 в сети')).toBeInTheDocument();
    expect(within(ks).getByRole('button', { name: 'Отключить' })).toBeInTheDocument();
    const ivan = screen.getByRole('listitem', { name: 'jonasasx@gmail.com' });
    expect(within(ivan).getByText('это вы')).toBeInTheDocument();
    expect(within(ivan).queryByRole('button', { name: 'Отключить' })).not.toBeInTheDocument();
    expect(screen.getByText(/использовано/)).toBeInTheDocument();
  });

  it('scenario «Создание приглашения»: the link with «Скопировать», the invite in the list for 7 days', async () => {
    const created = invite({ id: 'i2', email: 'bob@example.com', provider: 'google' });
    let invites: InviteView[] = [];
    const calls = mockFetch({
      'GET /api/admin/users': () => ({ status: 200, body: { users: USERS } }),
      'GET /api/admin/invites': () => ({ status: 200, body: { invites } }),
      'POST /api/admin/invites': () => {
        invites = [created];
        return { status: 201, body: { invite: created, url: 'https://hub.example.com/invite/abc' } };
      },
    });
    const u = userEvent.setup();
    // user-event puts its own clipboard on navigator: spy on it
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    render(<UsersPage />);
    expect(await screen.findByText('Приглашений пока нет.')).toBeInTheDocument();
    await u.type(screen.getByLabelText('Почта'), 'bob@example.com');
    await u.click(screen.getByRole('radio', { name: 'Google' }));
    await u.click(screen.getByRole('button', { name: 'Пригласить' }));
    expect(calls.find(c => c.method === 'POST')?.body).toEqual({ email: 'bob@example.com', provider: 'google' });
    expect(await screen.findByText('https://hub.example.com/invite/abc')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Скопировать' }));
    expect(writeText).toHaveBeenCalledWith('https://hub.example.com/invite/abc');
    expect(await screen.findByText('действует ещё 7 дней')).toBeInTheDocument();
  });

  it('scenario «Приглашение на адрес существующего пользователя»: «Пользователь уже есть»', async () => {
    mockFetch({
      'GET /api/admin/users': () => ({ status: 200, body: { users: USERS } }),
      'GET /api/admin/invites': () => ({ status: 200, body: { invites: [] } }),
      'POST /api/admin/invites': () => ({ status: 409, body: { error: 'user_exists' } }),
    });
    const u = userEvent.setup();
    render(<UsersPage />);
    await u.type(screen.getByLabelText('Почта'), 'bob@example.com');
    await u.click(screen.getByRole('button', { name: 'Пригласить' }));
    expect(await screen.findByText('Пользователь уже есть')).toBeInTheDocument();
    // a malformed address does not leave the browser
    await u.clear(screen.getByLabelText('Почта'));
    await u.type(screen.getByLabelText('Почта'), 'bob');
    await u.click(screen.getByRole('button', { name: 'Пригласить' }));
    expect(await screen.findByText('Введите адрес почты')).toBeInTheDocument();
  });

  it('revokes an active invite; a used one answers «уже использовано»', async () => {
    let used = false;
    mockFetch({
      'GET /api/admin/users': () => ({ status: 200, body: { users: USERS } }),
      'GET /api/admin/invites': () => ({ status: 200, body: { invites: [invite({})] } }),
      'DELETE /api/admin/invites/i1': () => (used ? { status: 409, body: { error: 'invite_used' } } : { status: 204 }),
    });
    const u = userEvent.setup();
    render(<UsersPage />);
    used = true;
    await u.click(await screen.findByRole('button', { name: 'Отозвать приглашение colleague@example.com' }));
    expect(await screen.findByText('Приглашение уже использовано')).toBeInTheDocument();
    used = false;
    await u.click(screen.getByRole('button', { name: 'Отозвать приглашение colleague@example.com' }));
    expect(await screen.findByText('отозвано')).toBeInTheDocument();
  });

  it('scenario «Отключение коллеги»: confirm → «отключён», then «Включить»', async () => {
    const calls = mockFetch({
      'GET /api/admin/users': () => ({ status: 200, body: { users: USERS } }),
      'GET /api/admin/invites': () => ({ status: 200, body: { invites: [] } }),
      'POST /api/admin/users/u-ks/disable': () => ({ status: 200, body: { ...USERS[1], status: 'disabled' } }),
      'POST /api/admin/users/u-ks/enable': () => ({ status: 200, body: USERS[1] }),
    });
    const u = userEvent.setup();
    render(<UsersPage />);
    const ks = await screen.findByRole('listitem', { name: 'bob@example.com' });
    await u.click(within(ks).getByRole('button', { name: 'Отключить' }));
    await u.click(within(screen.getByRole('alertdialog', { name: 'Отключить bob@example.com?' })).getByRole('button', { name: 'Отключить' }));
    expect(await within(ks).findByText('отключён')).toBeInTheDocument();
    await u.click(within(ks).getByRole('button', { name: 'Включить' }));
    expect(await within(ks).findByRole('button', { name: 'Отключить' })).toBeInTheDocument();
    expect(calls.map(c => c.url)).toEqual(expect.arrayContaining(['/api/admin/users/u-ks/disable', '/api/admin/users/u-ks/enable']));
  });

  it('a load error offers «Повторить»', async () => {
    mockFetch({ 'GET /api/admin/users': () => ({ status: 500, body: {} }) });
    render(<UsersPage />);
    expect(await screen.findByText(/Список не загружен/)).toBeInTheDocument();
  });
});
