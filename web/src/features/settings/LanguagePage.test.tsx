// Component test of «Настройки → Язык» (change i18n, task 3.2).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LOCALES } from '@agent-hub/shared';
import { chooseLocale, initLocale, useLocale } from '../../i18n';
import { useStore } from '../../store';
import { mockFetch, resetStore } from '../../test/factories';
import { LanguagePage } from './LanguagePage';

describe('LanguagePage', () => {
  beforeEach(async () => {
    resetStore();
    await chooseLocale(null);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    localStorage.clear();
    await initLocale('ru');
  });

  it('lists «as in browser» and every language with its own name', async () => {
    mockFetch({});
    render(<LanguagePage />);
    const radios = await screen.findAllByRole('radio');
    expect(radios).toHaveLength(LOCALES.length + 1);
    for (const l of LOCALES) expect(screen.getByRole('radio', { name: l.name })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup')).toBeInTheDocument();
    expect(radios[0]).toBeChecked();
  });

  it('choosing English saves it and switches the interface', async () => {
    const calls = mockFetch({ 'PUT /api/preferences/locale': () => ({ status: 204 }) });
    render(<LanguagePage />);
    await userEvent.click(await screen.findByRole('radio', { name: 'English' }));
    await waitFor(() => expect(calls.find(c => c.url.endsWith('/api/preferences/locale'))?.body).toEqual({ locale: 'en' }));
    expect(await screen.findByRole('heading', { name: 'Language' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'English' })).toBeChecked();
  });

  it('«as in browser» sends null', async () => {
    const calls = mockFetch({ 'PUT /api/preferences/locale': () => ({ status: 204 }) });
    await chooseLocale('en');
    render(<LanguagePage />);
    await userEvent.click(await screen.findByRole('radio', { name: /Same as browser/ }));
    await waitFor(() => expect(calls.some(c => c.method === 'PUT' && (c.body as { locale: unknown }).locale === null)).toBe(true));
    expect(screen.getByRole('radio', { name: /Same as browser/ })).toBeChecked();
  });

  it('a save error shows a toast and returns the previous language: the profile would switch it back anyway', async () => {
    mockFetch({ 'PUT /api/preferences/locale': () => ({ status: 500, body: { error: 'boom', message: 'Hub is down' } }) });
    render(<LanguagePage />);
    await userEvent.click(await screen.findByRole('radio', { name: 'English' }));
    await waitFor(() => expect(useStore.getState().toasts.some(x => x.text === 'Hub is down')).toBe(true));
    await waitFor(() => expect(useLocale.getState().chosen).toBeNull());
    expect(screen.getByRole('radio', { name: 'English' })).not.toBeChecked();
  });

  it('a second click while the save is in flight is ignored: an older failure cannot undo a newer choice', async () => {
    let release: () => void = () => {};
    const pending = new Promise<void>(resolve => {
      release = resolve;
    });
    const calls: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push(init?.body ? JSON.parse(String(init.body)) : undefined);
        await pending;
        return new Response(null, { status: 204 });
      }),
    );
    render(<LanguagePage />);
    await userEvent.click(await screen.findByRole('radio', { name: 'English' }));
    await waitFor(() => expect(screen.getByRole('radiogroup')).toHaveAttribute('aria-busy', 'true'));
    await userEvent.click(screen.getByRole('radio', { name: '日本語' }));
    release();
    await waitFor(() => expect(screen.getByRole('radiogroup')).toHaveAttribute('aria-busy', 'false'));
    expect(calls).toEqual([{ locale: 'en' }]);
    expect(screen.getByRole('radio', { name: 'English' })).toBeChecked();
  });
});
