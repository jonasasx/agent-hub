// Component test of «Настройки → Приложение» (change desktop-download, task 2.1; Requirement: Кнопка скачивания в веб-интерфейсе).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useStore } from '../../store';
import { mockFetch, resetStore } from '../../test/factories';
import { Settings } from './Settings';

const INFO = { available: true, version: '0.1.8', size: 104857600, fileName: 'Agent-Hub-Setup-0.1.8 [agents.example.org].exe' };

describe('Settings → Приложение', () => {
  beforeEach(() => resetStore());
  afterEach(() => vi.unstubAllGlobals());

  it('Установщик есть: the tab, the version and a link to /api/desktop/download', async () => {
    mockFetch({ '/api/desktop/info': () => ({ status: 200, body: INFO }) });
    useStore.setState({ settings: 'desktop' });
    render(<Settings />);
    expect(await screen.findByRole('button', { name: 'Приложение' })).toHaveAttribute('aria-current', 'page');
    const link = await screen.findByRole('link', { name: 'Скачать для Windows' });
    expect(link).toHaveAttribute('href', '/api/desktop/download');
    expect(link).toHaveAttribute('download', INFO.fileName);
    expect(screen.getByText(/Версия 0\.1\.8/)).toBeInTheDocument();
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
