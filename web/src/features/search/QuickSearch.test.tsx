// Ctrl+K over the whole history (task 3.9 web). Requirement (workspace-ui): Быстрый поиск Ctrl+K.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useStore } from '../../store';
import { RUNNERS, mockFetch, resetStore, session } from '../../test/factories';
import { QuickSearch } from './QuickSearch';
import { hitsOf, snippetParts } from './snippet';

describe('snippet parts', () => {
  it('offsets of the matches', () => {
    expect(
      snippetParts({
        text: 'сводка тайминги очереди DZI',
        highlights: [
          [7, 15],
          [16, 23],
        ],
      }),
    ).toEqual([
      { text: 'сводка ', hit: false },
      { text: 'тайминги', hit: true },
      { text: ' ', hit: false },
      { text: 'очереди', hit: true },
      { text: ' DZI', hit: false },
    ]);
  });
  it('\\u0001…\\u0002 markers', () => {
    expect(snippetParts('a \u0001перезапуск\u0002 b')).toEqual([
      { text: 'a ', hit: false },
      { text: 'перезапуск', hit: true },
      { text: ' b', hit: false },
    ]);
  });
  it('<b> markers of ts_headline: other markup stays text, entities are decoded', () => {
    expect(snippetParts('x <b>deploy</b> <img src=x onerror=alert(1)> &lt;y&gt;')).toEqual([
      { text: 'x ', hit: false },
      { text: 'deploy', hit: true },
      { text: ' <img src=x onerror=alert(1)> <y>', hit: false },
    ]);
  });
  it('hits from an array or {results}', () => {
    const s = session();
    expect(hitsOf([{ session: s, snippet: null }])).toHaveLength(1);
    expect(hitsOf({ results: [{ session: s, snippet: 'x' }, { nope: 1 }] })).toHaveLength(1);
    expect(hitsOf(null)).toEqual([]);
  });
});

describe('QuickSearch', () => {
  beforeEach(() => {
    resetStore();
    useStore.setState({ runners: RUNNERS });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('Поиск по тексту реплики: the query goes to /api/search, the fragment is highlighted, Enter opens the session (unknown to the window) in the active pane', async () => {
    const found = session({ title: 'Постмортем: тайминги очереди DZI', runnerId: 'hp' });
    const calls = mockFetch({
      '/api/search': (_i, url) =>
        url!.includes('q=%D1%82%D0%B0%D0%B9%D0%BC%D0%B8%D0%BD%D0%B3%D0%B8')
          ? { status: 200, body: [{ session: found, snippet: { text: 'Сведи тайминги очереди DZI за 05–09.10', highlights: [[6, 14]] }, match: 'text' }] }
          : { status: 200, body: [] },
      '/api/sessions/': () => ({ status: 200, body: { events: [], before: null } }),
    });
    const onClose = vi.fn();
    render(<QuickSearch onClose={onClose} />);
    await userEvent.type(screen.getByRole('combobox', { name: 'Сессия или проект' }), 'тайминги');
    const row = await screen.findByRole('option', { name: /Постмортем/ });
    expect(within(row).getByText('тайминги').tagName).toBe('MARK');
    expect(calls.some(c => c.url.startsWith('/api/search?q=') && c.url.includes('&limit=12&cron=0'))).toBe(true);
    await userEvent.keyboard('{Enter}');
    expect(onClose).toHaveBeenCalled();
    const ws = useStore.getState().ws;
    expect(ws.panes[ws.focus]!.active).toBe(found.id);
    expect(useStore.getState().sessions[found.id]?.title).toBe('Постмортем: тайминги очереди DZI');
  });

  it('cron: the switch goes to the hub; arrows move the selection', async () => {
    useStore.setState({ showCron: true });
    const list = [session({ title: 'Первая' }), session({ title: 'Вторая' })];
    const calls = mockFetch({ '/api/search': () => ({ status: 200, body: { results: list.map(s => ({ session: s, snippet: null })) } }) });
    render(<QuickSearch onClose={() => undefined} />);
    await screen.findByRole('option', { name: /Вторая/ });
    expect(calls[0]!.url).toBe('/api/search?q=&limit=12&cron=1');
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('option', { name: /Вторая/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('nothing found; a hub error falls back to the known sessions with a note', async () => {
    useStore.getState().upsertSessions([session({ title: 'Импорт выписки' })]);
    let fail = false;
    mockFetch({ '/api/search': () => (fail ? { status: 502, body: {} } : { status: 200, body: [] }) });
    const view = render(<QuickSearch onClose={() => undefined} />);
    await userEvent.type(screen.getByRole('combobox'), 'zzz');
    expect(await screen.findByText('Ничего не найдено')).toBeInTheDocument();
    view.unmount();
    fail = true;
    render(<QuickSearch onClose={() => undefined} />);
    await userEvent.type(screen.getByRole('combobox'), 'импорт');
    expect(await screen.findByText(/Поиск по истории недоступен/)).toHaveAttribute('role', 'status');
    await waitFor(() => expect(screen.getByRole('option', { name: /Импорт выписки/ })).toBeInTheDocument());
  });

  it('the placeholder names the text of the replies', () => {
    mockFetch({ '/api/search': () => ({ status: 200, body: [] }) });
    render(<QuickSearch onClose={() => undefined} />);
    expect(screen.getByRole('combobox')).toHaveAttribute('placeholder', 'Название, проект или текст реплики…');
  });
});
