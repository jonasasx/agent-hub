// Requirements (session-title): Ручное переименование сессии; Перегенерация названия.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SessionView } from '../../api/types';
import { useStore } from '../../store';
import { mockFetch, resetStore, session } from '../../test/factories';
import { SessionTitle } from './SessionTitle';

type Call = { url: string; method: string; body: unknown };

function setup(s: SessionView, routes: Parameters<typeof mockFetch>[0] = {}) {
  useStore.getState().upsertSessions([s]);
  const calls: Call[] = mockFetch({
    'PATCH /api/sessions/': init => {
      const body = JSON.parse(String(init!.body)) as { title: string };
      return { status: 200, body: session({ id: s.id, title: body.title }) };
    },
    'POST /api/sessions/': () => ({ status: 200, body: session({ id: s.id, title: 'Правки Agent Hub' }) }),
    ...routes,
  });
  // the chat head re-renders from the store, like in the app
  function Host() {
    const title = useStore(st => st.sessions[s.id]?.title ?? '');
    return <SessionTitle sessionId={s.id} title={title} />;
  }
  render(<Host />);
  return { calls };
}

const mutations = (calls: Call[]) => calls.filter(c => c.method !== 'GET');

describe('inline session title', () => {
  beforeEach(() => resetStore());
  afterEach(() => vi.unstubAllGlobals());

  it('a click turns the title into a field; Enter saves the trimmed title with PATCH {title}', async () => {
    const s = session({ title: 'Старое' });
    const { calls } = setup(s);
    await userEvent.click(screen.getByRole('button', { name: 'Старое' }));
    const input = screen.getByRole('textbox', { name: 'Название сессии' });
    expect(input).toHaveValue('Старое');
    await userEvent.clear(input);
    await userEvent.type(input, '  Релиз 0.5  {Enter}');
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    const patch = calls.find(c => c.method === 'PATCH');
    expect(patch?.url).toBe(`/api/sessions/${s.id}`);
    expect(patch?.body).toEqual({ title: 'Релиз 0.5' });
    expect(screen.getByRole('button', { name: 'Релиз 0.5' })).toBeInTheDocument();
    expect(useStore.getState().sessions[s.id]?.title).toBe('Релиз 0.5');
  });

  it('leaving the field saves it too', async () => {
    const s = session({ title: 'Старое' });
    const { calls } = setup(s);
    await userEvent.click(screen.getByRole('button', { name: 'Старое' }));
    await userEvent.type(screen.getByRole('textbox'), ' 2');
    await userEvent.tab();
    await waitFor(() => expect(calls.find(c => c.method === 'PATCH')?.body).toEqual({ title: 'Старое 2' }));
  });

  it('Esc, an empty title and an unchanged title send nothing and keep the old title', async () => {
    const s = session({ title: 'Старое' });
    const { calls } = setup(s);
    await userEvent.click(screen.getByRole('button', { name: 'Старое' }));
    await userEvent.type(screen.getByRole('textbox'), 'xyz{Escape}');
    expect(screen.queryByRole('textbox')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Старое' }));
    await userEvent.clear(screen.getByRole('textbox'));
    await userEvent.keyboard('{Enter}');
    expect(screen.queryByRole('textbox')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Старое' }));
    await userEvent.keyboard('{Enter}');
    expect(mutations(calls)).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Старое' })).toBeInTheDocument();
  });

  it('«✦» regenerates in place: POST …/title/regenerate, the new title appears without a dialog', async () => {
    const s = session({ title: 'Отчёт по Selectel (копия)' });
    const { calls } = setup(s);
    await userEvent.click(screen.getByRole('button', { name: 'Перегенерировать название' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Правки Agent Hub' })).toBeInTheDocument());
    expect(calls.find(c => c.method === 'POST')?.url).toBe(`/api/sessions/${s.id}/title/regenerate`);
    expect(useStore.getState().sessions[s.id]?.title).toBe('Правки Agent Hub');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a failed generation keeps the old title and shows the hub text in a toast', async () => {
    const s = session({ title: 'Старое' });
    setup(s, { 'POST /api/sessions/': () => ({ status: 409, body: { error: 'runner_offline', message: 'Нет машины в сети для генерации' } }) });
    await userEvent.click(screen.getByRole('button', { name: 'Перегенерировать название' }));
    await waitFor(() => expect(useStore.getState().toasts.some(t => t.text === 'Нет машины в сети для генерации')).toBe(true));
    expect(screen.getByRole('button', { name: 'Старое' })).toBeInTheDocument();
    expect(useStore.getState().sessions[s.id]?.title).toBe('Старое');
  });
});
