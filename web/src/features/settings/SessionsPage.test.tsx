// Component test of «Настройки → Сессии» (change session-sleep-controls, task 3.5).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useStore } from '../../store';
import { mockFetch, resetStore } from '../../test/factories';
import { SessionsPage } from './SessionsPage';

const prefs = (idleTimeoutMin: number | null) => ({ status: 200, body: { idleTimeoutMin, hubIdleTimeoutMin: 30 } });

describe('SessionsPage', () => {
  beforeEach(resetStore);
  afterEach(() => vi.unstubAllGlobals());

  it('lists «as in the hub» with the hub value and every timeout; the saved choice is checked', async () => {
    mockFetch({ 'GET /api/preferences/sessions': () => prefs(60) });
    render(<SessionsPage />);
    expect(await screen.findByRole('radio', { name: 'Как в хабе (30 мин)' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'через 1 ч' })).toBeChecked();
    expect(screen.getAllByRole('radio')).toHaveLength(7);
    expect(screen.getByRole('radio', { name: 'не усыплять' })).toBeInTheDocument();
  });

  it('a choice is saved at once; «as in the hub» sends null', async () => {
    const calls = mockFetch({
      'GET /api/preferences/sessions': () => prefs(null),
      'PUT /api/preferences/sessions': init => prefs(JSON.parse(String(init!.body)).idleTimeoutMin),
    });
    render(<SessionsPage />);
    await userEvent.click(await screen.findByRole('radio', { name: 'через 15 мин' }));
    await waitFor(() => expect(calls.filter(c => c.method === 'PUT').map(c => c.body)).toEqual([{ idleTimeoutMin: 15 }]));
    expect(screen.getByRole('radio', { name: 'через 15 мин' })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: 'Как в хабе (30 мин)' }));
    await waitFor(() => expect(calls.filter(c => c.method === 'PUT').map(c => c.body)).toEqual([{ idleTimeoutMin: 15 }, { idleTimeoutMin: null }]));
    expect(screen.getByRole('radio', { name: 'Как в хабе (30 мин)' })).toBeChecked();
  });

  it('a save error shows a toast and returns the previous choice', async () => {
    mockFetch({
      'GET /api/preferences/sessions': () => prefs(null),
      'PUT /api/preferences/sessions': () => ({ status: 500, body: { error: 'boom', message: 'Hub is down' } }),
    });
    render(<SessionsPage />);
    await userEvent.click(await screen.findByRole('radio', { name: 'через 2 ч' }));
    await waitFor(() => expect(useStore.getState().toasts.some(x => x.title === 'Таймаут не сохранён' && x.text === 'Hub is down')).toBe(true));
    expect(screen.getByRole('radio', { name: 'Как в хабе (30 мин)' })).toBeChecked();
  });

  it('a load error says so instead of the list', async () => {
    mockFetch({ 'GET /api/preferences/sessions': () => ({ status: 500, body: { error: 'boom' } }) });
    render(<SessionsPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось загрузить настройку');
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });
});
