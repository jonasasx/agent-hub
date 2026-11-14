// Component test of the welcome-screen link to the installers (change desktop-menu-entry; Requirement: Кнопка скачивания в веб-интерфейсе).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useStore } from '../../store';
import { mockFetch, resetStore } from '../../test/factories';
import { Welcome } from './Welcome';

const WIN = { platform: 'win', size: 104857600, fileName: 'Agent-Hub-Setup-0.1.10 [agents.example.org].exe' };
const INFO = { available: true, version: '0.1.10', size: WIN.size, fileName: WIN.fileName, downloads: [WIN] };
const LINK = 'Скачать приложение для компьютера';

describe('Welcome → Скачать приложение для компьютера', () => {
  beforeEach(() => resetStore());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('Вход с приветственного экрана: the link opens /settings/desktop', async () => {
    mockFetch({ '/api/desktop/info': () => ({ status: 200, body: INFO }) });
    render(<Welcome onLogout={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: LINK }));
    expect(useStore.getState().settings).toBe('desktop');
    expect(window.location.pathname).toBe('/settings/desktop');
  });

  it('Установщика нет: no link', async () => {
    mockFetch({ '/api/desktop/info': () => ({ status: 200, body: { available: false } }) });
    render(<Welcome onLogout={() => {}} />);
    await vi.waitFor(() => expect(useStore.getState().desktopInfo).toEqual({ available: false }));
    expect(screen.queryByRole('button', { name: LINK })).toBeNull();
  });

  it('Десктопное приложение: no link', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 AgentHub/0.1.10 Chrome/140.0 Electron/45.0.0 Safari/537.36');
    useStore.setState({ desktopInfo: INFO as never });
    render(<Welcome onLogout={() => {}} />);
    expect(screen.queryByRole('button', { name: LINK })).toBeNull();
  });
});
