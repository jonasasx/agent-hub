// Component test of the «⋯» profile menu (change profile-menu-grouping, spec profile-menu): the header with the role,
// the groups «Настройки» and «Рабочее место», «Выйти» apart, the layout reset confirmation, no «Скачать приложение».
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '../../api/types';
import { useStore } from '../../store';
import { mockFetch, resetStore } from '../../test/factories';
import { defaultDock } from '../toolwindows/dock';
import { useDock } from '../toolwindows/useDock';
import { ProfileMenu } from './ProfileMenu';

const me = (role: 'admin' | 'user'): MeResponse => ({
  user: { id: 'u-1', email: 'alice@example.com', role, name: 'Алиса Смит', provider: 'google' },
  vapidPublicKey: null,
  voiceInput: false,
  voiceTalk: false,
  locale: null,
  accountUrl: null,
  singleProvider: null,
});

const SUBS = { subscriptions: [] };

function signIn(role: 'admin' | 'user', subs: boolean) {
  useStore.setState({ auth: { kind: 'signed_in', me: me(role) } as never, subs: subs ? (SUBS as never) : null });
}

async function openMenu() {
  await userEvent.click(screen.getByRole('button', { name: 'Профиль' }));
  return screen.getByRole('menu', { name: 'Профиль' });
}

const items = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole('menuitem')
    .map(b => b.textContent);

describe('ProfileMenu', () => {
  let calls: Array<{ url: string }>;
  beforeEach(() => {
    resetStore();
    useDock.setState({ dock: defaultDock(), phoneWin: null });
    calls = mockFetch({});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('Администратор с подписками: header with the role, both groups and a red «Выйти»', async () => {
    signIn('admin', true);
    render(<ProfileMenu onLogout={() => {}} />);
    const menu = await openMenu();
    expect(within(menu).getByText('alice@example.com')).toBeInTheDocument();
    expect(within(menu).getByText('администратор')).toBeInTheDocument();
    expect(within(menu).getByText('Настройки')).toBeInTheDocument();
    expect(within(menu).getByText('Рабочее место')).toBeInTheDocument();
    expect(items(menu)).toEqual(['Машины', 'Подписки', 'Расход', 'Пользователи', 'Безопасность', 'Все настройки8', 'Показать скрытые', 'Сбросить раскладку окон', 'Выйти']);
    expect(within(menu).getByRole('menuitem', { name: 'Выйти' })).toHaveClass('m-out');
  });

  it('Обычный пользователь без подписок: no «Подписки», «Расход», «Пользователи»; role «пользователь»', async () => {
    signIn('user', false);
    render(<ProfileMenu onLogout={() => {}} />);
    const menu = await openMenu();
    expect(within(menu).getByText('пользователь')).toBeInTheDocument();
    expect(items(menu)).toEqual(['Машины', 'Безопасность', 'Все настройки5', 'Показать скрытые', 'Сбросить раскладку окон', 'Выйти']);
  });

  it('Все настройки: the menu closes and /settings opens', async () => {
    signIn('user', false);
    render(<ProfileMenu onLogout={() => {}} />);
    const menu = await openMenu();
    await userEvent.click(within(menu).getByRole('menuitem', { name: /Все настройки/ }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(useStore.getState().settings).toBe('index');
    expect(window.location.pathname).toBe('/settings');
  });

  it('Пункт настроек: «Безопасность» opens /settings/security', async () => {
    signIn('user', false);
    render(<ProfileMenu onLogout={() => {}} />);
    const menu = await openMenu();
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Безопасность' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(useStore.getState().settings).toBe('security');
    expect(window.location.pathname).toBe('/settings/security');
  });

  it('Скачать приложение не в меню: no entry and no request to /api/desktop/info', async () => {
    signIn('admin', true);
    render(<ProfileMenu onLogout={() => {}} />);
    const menu = await openMenu();
    expect(within(menu).queryByRole('menuitem', { name: /Скачать приложение/ })).toBeNull();
    expect(calls.some(c => c.url.startsWith('/api/desktop/info'))).toBe(false);
  });

  it('Подтверждение: «Сбросить» resets the layout and closes the menu', async () => {
    useDock.getState().toggle('sessions');
    render(<ProfileMenu onLogout={() => {}} />);
    const menu = await openMenu();
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Сбросить раскладку окон' }));
    expect(within(menu).getByText('Сбросить раскладку?')).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Отмена' })).toHaveFocus();
    expect(useDock.getState().dock).not.toEqual(defaultDock());
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Сбросить' }));
    expect(useDock.getState().dock).toEqual(defaultDock());
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Отмена: the layout stays, the entry comes back', async () => {
    useDock.getState().toggle('sessions');
    const before = JSON.stringify(useDock.getState().dock);
    render(<ProfileMenu onLogout={() => {}} />);
    const menu = await openMenu();
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Сбросить раскладку окон' }));
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Отмена' }));
    expect(JSON.stringify(useDock.getState().dock)).toBe(before);
    expect(within(menu).getByRole('menuitem', { name: 'Сбросить раскладку окон' })).toBeInTheDocument();
  });

  it('«Выйти» closes the menu and signs out', async () => {
    const onLogout = vi.fn();
    render(<ProfileMenu onLogout={onLogout} />);
    const menu = await openMenu();
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Выйти' }));
    expect(onLogout).toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
