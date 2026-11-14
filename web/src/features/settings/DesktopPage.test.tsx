// Component test of «Настройки → Приложение» (change desktop-download, task 2.1; Requirement: Кнопка скачивания в веб-интерфейсе).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useStore } from '../../store';
import { mockFetch, resetStore } from '../../test/factories';
import { Settings } from './Settings';

const WIN = { platform: 'win', size: 104857600, fileName: 'Agent-Hub-Setup-0.1.8 [agents.example.org].exe' };
const LINUX = { platform: 'linux', size: 110000000, fileName: 'Agent-Hub-0.1.8 [agents.example.org].AppImage' };
const MAC = { platform: 'mac', size: 120000000, fileName: 'Agent-Hub-0.1.8.dmg' };
const INFO = { available: true, version: '0.1.8', size: WIN.size, fileName: WIN.fileName, downloads: [WIN] };
const INFO_ALL = { ...INFO, downloads: [WIN, LINUX, MAC] };

describe('Settings → Приложение', () => {
  beforeEach(() => resetStore());
  afterEach(() => vi.unstubAllGlobals());

  it('Установщик есть: the tab, the version and a link to /api/desktop/download', async () => {
    mockFetch({ '/api/desktop/info': () => ({ status: 200, body: INFO }) });
    useStore.setState({ settings: 'desktop' });
    render(<Settings />);
    expect(await screen.findByRole('button', { name: 'Приложение' })).toHaveAttribute('aria-current', 'page');
    const link = await screen.findByRole('link', { name: 'Скачать для Windows' });
    expect(link).toHaveAttribute('href', '/api/desktop/download?platform=win');
    expect(link).toHaveAttribute('download', WIN.fileName);
    expect(screen.getByText(/Версия 0\.1\.8/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Linux|macOS/ })).toBeNull();
    expect(screen.getByTestId('desktop-connect')).toBeInTheDocument();
    expect(screen.queryByText(/не подписана/)).toBeNull();
  });

  it('Linux и macOS: buttons per platform, the Gatekeeper hint and the connect link', async () => {
    mockFetch({ '/api/desktop/info': () => ({ status: 200, body: INFO_ALL }) });
    useStore.setState({ settings: 'desktop' });
    render(<Settings />);
    const linux = await screen.findByRole('link', { name: 'Скачать для Linux (AppImage)' });
    expect(linux).toHaveAttribute('href', '/api/desktop/download?platform=linux');
    expect(linux).toHaveAttribute('download', LINUX.fileName);
    const mac = screen.getByRole('link', { name: 'Скачать для macOS (dmg)' });
    expect(mac).toHaveAttribute('href', '/api/desktop/download?platform=mac');
    expect(mac).toHaveAttribute('download', MAC.fileName);
    expect(screen.getByText(/не подписана/)).toBeInTheDocument();
    expect(screen.getByTestId('desktop-connect')).toHaveAttribute('href', `agenthub://connect?hub=${encodeURIComponent(window.location.origin)}`);
  });

  it('Браузер на macOS: the macOS button is first and highlighted', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15');
    mockFetch({ '/api/desktop/info': () => ({ status: 200, body: INFO_ALL }) });
    useStore.setState({ settings: 'desktop' });
    render(<Settings />);
    await screen.findByTestId('desktop-download-mac');
    const buttons = screen.getAllByTestId(/desktop-download-/);
    expect(buttons.map(b => b.getAttribute('data-testid'))).toEqual(['desktop-download-mac', 'desktop-download-win', 'desktop-download-linux']);
    expect(buttons[0]).toHaveClass('primary');
    expect(buttons[1]).not.toHaveClass('primary');
    vi.restoreAllMocks();
  });

  it('Установщика нет: no tab, /settings/desktop is «Страница не найдена»', async () => {
    mockFetch({ '/api/desktop/info': () => ({ status: 200, body: { available: false } }) });
    useStore.setState({ settings: 'desktop' });
    render(<Settings />);
    expect(await screen.findByRole('heading', { name: 'Страница не найдена' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Приложение' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Скачать для Windows' })).toBeNull();
  });

  it('an old hub without the endpoint (404): no tab on other pages', async () => {
    mockFetch({});
    useStore.setState({ settings: 'language' });
    render(<Settings />);
    await vi.waitFor(() => expect(useStore.getState().desktopInfo).toEqual({ available: false }));
    expect(screen.queryByRole('button', { name: 'Приложение' })).toBeNull();
  });
});
