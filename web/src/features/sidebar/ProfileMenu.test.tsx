// Component test of the «⋯» menu entry «Скачать приложение» (change desktop-menu-entry; Requirement: Кнопка скачивания в веб-интерфейсе).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useStore } from '../../store';
import { mockFetch, resetStore } from '../../test/factories';
import { ProfileMenu } from './ProfileMenu';

const WIN = { platform: 'win', size: 104857600, fileName: 'Agent-Hub-Setup-0.1.10 [agents.example.org].exe' };
const INFO = { available: true, version: '0.1.10', size: WIN.size, fileName: WIN.fileName, downloads: [WIN] };

describe('ProfileMenu → Скачать приложение', () => {
  beforeEach(() => resetStore());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('Вход из меню: the entry asks the hub and opens /settings/desktop', async () => {
    mockFetch({ '/api/desktop/info': () => ({ status: 200, body: INFO }) });
    render(<ProfileMenu onLogout={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Профиль' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Скачать приложение' }));
    expect(useStore.getState().settings).toBe('desktop');
    expect(window.location.pathname).toBe('/settings/desktop');
  });

  it('Установщика нет: no entry', async () => {
    mockFetch({ '/api/desktop/info': () => ({ status: 200, body: { available: false } }) });
    render(<ProfileMenu onLogout={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Профиль' }));
    await vi.waitFor(() => expect(useStore.getState().desktopInfo).toEqual({ available: false }));
    expect(screen.queryByRole('menuitem', { name: 'Скачать приложение' })).toBeNull();
  });

  it('Меню в десктопном приложении: no entry', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 AgentHub/0.1.10 Chrome/140.0 Electron/45.0.0 Safari/537.36');
    useStore.setState({ desktopInfo: INFO as never });
    render(<ProfileMenu onLogout={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Профиль' }));
    expect(screen.queryByRole('menuitem', { name: 'Скачать приложение' })).toBeNull();
  });
});
