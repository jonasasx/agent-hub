// Settings navigation (change profile-menu-grouping, spec settings-navigation): grouped left nav on desktop,
// the root list `/settings` on the phone, «←» of a page back to the list.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '../../api/types';
import { useStore } from '../../store';
import { mockFetch, resetStore } from '../../test/factories';
import { openSettings, Settings } from './Settings';

const me = (role: 'admin' | 'user'): MeResponse => ({
  user: { id: 'u-1', email: 'alice@example.com', role, name: 'Алиса Смит', provider: 'google' },
  vapidPublicKey: null,
  voiceInput: false,
  voiceTalk: false,
  locale: null,
  accountUrl: null,
  singleProvider: null,
});

const signIn = (role: 'admin' | 'user') => useStore.setState({ auth: { kind: 'signed_in', me: me(role) } as never });

describe('Settings navigation', () => {
  beforeEach(() => {
    resetStore();
    mockFetch({ '/api/desktop/info': () => ({ status: 200, body: { available: false } }) });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    history.replaceState(null, '', '/');
  });

  it('Десктоп: groups in the left nav, «Машины» is current at /settings', async () => {
    signIn('admin');
    openSettings('index');
    render(<Settings />);
    const nav = screen.getByRole('navigation', { name: 'Разделы настроек' });
    const groups = within(nav)
      .getAllByRole('group')
      .map(g => g.getAttribute('aria-labelledby'));
    expect(groups).toEqual(['set-grp-infra', 'set-grp-prefs', 'set-grp-account', 'set-grp-admin']);
    expect(within(nav).getByRole('group', { name: /Инфраструктура/ })).toBeInTheDocument();
    expect(within(nav).getByRole('group', { name: /Администрирование/ })).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: 'Машины' })).toHaveAttribute('aria-current', 'page');
    expect(window.location.pathname).toBe('/settings');
  });

  it('Пользователь: no group «Администрирование», /settings/users is «Страница не найдена»', async () => {
    signIn('user');
    openSettings('users');
    render(<Settings />);
    const nav = screen.getByRole('navigation', { name: 'Разделы настроек' });
    expect(within(nav).queryByRole('group', { name: /Администрирование/ })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Страница не найдена' })).toBeInTheDocument();
  });

  it('Телефон: the root list, a page and «←» back to the list', async () => {
    signIn('user');
    useStore.setState({ device: 'phone' } as never);
    openSettings('index');
    render(<Settings />);
    expect(screen.getByRole('heading', { name: 'Предпочтения' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Сессии/ }));
    expect(window.location.pathname).toBe('/settings/sessions');
    expect(screen.getByRole('heading', { level: 1, name: 'Сессии' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'К списку настроек' }));
    expect(window.location.pathname).toBe('/settings');
    expect(useStore.getState().settings).toBe('index');
    expect(screen.getByRole('heading', { name: 'Аккаунт' })).toBeInTheDocument();
  });
});
