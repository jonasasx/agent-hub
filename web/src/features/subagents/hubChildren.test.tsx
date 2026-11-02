// Change `hub-subagents` (task 4.2): the sessions a hub session started — the counter on the button, the «Сессии хаба»
// section of the list, the link in the chat header, the cards of the task and of the report.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { wrapPeerMessage } from '@agent-hub/shared';
import type { HubEvent, HubSubagentView, SessionView } from '../../api/types';
import { useStore } from '../../store';
import { RUNNERS, mockFetch, resetStore, session } from '../../test/factories';
import { Chat } from '../chat/Chat';
import { buildChat } from '../chat/transcript';
import { SubagentList, SubagentsButton } from './SubagentViews';

const FROM = '0b3c1b3e-6b0a-4a52-9a4e-1d0a8d6f2f11';
const MSG = '5f1d8f7e-2b6f-4d3a-8a55-0c7a3c0b9e22';
const line = (id: string, l: Record<string, unknown>): HubEvent => ({ kind: 'line', id, ts: '', line: l }) as HubEvent;

function child(over: Partial<HubSubagentView> = {}): HubSubagentView {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Ревью миграции',
    provider: 'codex',
    runnerId: 'vm',
    machine: 'ВМ .3',
    status: 'working',
    processAlive: true,
    createdAt: new Date(Date.now() - 120_000).toISOString(),
    ...over,
  };
}

describe('hub subagents in the UI', () => {
  beforeEach(resetStore);
  afterEach(() => vi.unstubAllGlobals());

  it('the button counts the hub children: «Субагенты 2 · 1 работает»', () => {
    const parent = session({ subagents: { total: 0, running: 0, working: 0, background: 0, hub: { total: 2, working: 1 } } });
    useStore.setState({ runners: RUNNERS, subagentLists: { [parent.id]: [] }, hubLists: { [parent.id]: [child(), child({ id: '2', status: 'waiting' })] } });
    useStore.getState().upsertSessions([parent]);
    mockFetch({});
    render(<SubagentsButton s={parent} />);
    expect(screen.getByRole('button')).toHaveTextContent('Субагенты 2 · 1 работает');
  });

  it('the list has a «Сессии хаба» section: provider, machine, status; a click opens the child', () => {
    const parent = session({ subagents: { total: 0, running: 0, working: 0, background: 0, hub: { total: 1, working: 1 } } });
    const c = child();
    useStore.setState({ runners: RUNNERS, subagentLists: { [parent.id]: [] }, hubLists: { [parent.id]: [c] } });
    useStore.getState().upsertSessions([parent]);
    mockFetch({ [`/api/sessions/${parent.id}/subagents`]: () => ({ status: 200, body: { subagents: [], background: [], hubSessions: [c] } }) });
    const onClose = vi.fn();
    render(<SubagentList s={parent} onClose={onClose} />);
    const row = screen.getByText('Ревью миграции').closest('button')!;
    expect(row).toHaveTextContent('Codex');
    expect(row).toHaveTextContent('ВМ .3');
    expect(row).toHaveTextContent('работает');
    expect(within(row).getByRole('img', { name: 'работает' })).toBeInTheDocument();
    fireEvent.click(row);
    expect(onClose).toHaveBeenCalled();
  });

  it('a child waiting for permission comes first (UI review 5.6)', () => {
    const parent = session({ subagents: { total: 0, running: 0, working: 0, background: 0, hub: { total: 2, working: 1 } } });
    const kids = [child({ id: 'a', title: 'Работает' }), child({ id: 'c', title: 'Ждёт разрешения', status: 'permission' })];
    useStore.setState({ runners: RUNNERS, subagentLists: { [parent.id]: [] }, hubLists: { [parent.id]: kids } });
    useStore.getState().upsertSessions([parent]);
    mockFetch({ [`/api/sessions/${parent.id}/subagents`]: () => ({ status: 200, body: { subagents: [], background: [], hubSessions: kids } }) });
    render(<SubagentList s={parent} onClose={vi.fn()} />);
    const titles = screen.getAllByRole('listitem').map(li => li.textContent ?? '');
    expect(titles[0]).toContain('Ждёт разрешения');
    expect(titles[1]).toContain('Работает');
  });

  it('hub children and process subagents share one list, one «Сессии хаба» header is gone', () => {
    const parent = session({ subagents: { total: 1, running: 0, working: 0, background: 0, hub: { total: 1, working: 1 } } });
    const c = child({ title: 'Хабовый ребёнок' });
    const sub = { id: 's1', sessionId: parent.id, kind: 'subagent', description: 'Процессный', status: 'completed', startedAt: new Date().toISOString(), session: { title: parent.title } } as never;
    useStore.setState({ runners: RUNNERS, subagents: { s1: sub }, subagentLists: { [parent.id]: ['s1'] }, hubLists: { [parent.id]: [c] } });
    useStore.getState().upsertSessions([parent]);
    mockFetch({ [`/api/sessions/${parent.id}/subagents`]: () => ({ status: 200, body: { subagents: [sub], background: [], hubSessions: [c] } }) });
    render(<SubagentList s={parent} onClose={vi.fn()} />);
    expect(screen.queryByText('Сессии хаба')).toBeNull();
    const rows = screen.getAllByRole('listitem').map(li => li.textContent ?? '');
    expect(rows[0]).toContain('Хабовый ребёнок');
    expect(rows[1]).toContain('Процессный');
  });

  it('an empty list says so instead of showing a bare header', async () => {
    const parent = session();
    useStore.setState({ runners: RUNNERS, subagentLists: { [parent.id]: [] }, hubLists: { [parent.id]: [] }, backgroundLists: { [parent.id]: [] } });
    useStore.getState().upsertSessions([parent]);
    mockFetch({ [`/api/sessions/${parent.id}/subagents`]: () => ({ status: 200, body: { subagents: [], background: [], hubSessions: [] } }) });
    render(<SubagentList s={parent} onClose={vi.fn()} />);
    expect(screen.getByText('Дочерних сессий нет')).toBeInTheDocument();
  });

  it('the header of a child names the parent and a click opens it', () => {
    const s: SessionView = { ...session(), spawnedBy: { id: FROM, title: 'Главная сессия' } };
    useStore.setState({ runners: RUNNERS, models: [{ value: 'opus', displayName: 'Opus 5.5' }] });
    useStore.getState().upsertSessions([s]);
    useStore.setState({ logs: { [s.id]: { events: [], before: null, loaded: true, loading: false, error: null } } });
    render(<Chat session={s} paneId="p1" />);
    expect(screen.getByText(/субагент сессии/)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Главная сессия' });
    expect(link.getAttribute('href')).toBe(`/s/${FROM}`);
    expect(fireEvent.click(link)).toBe(false);
  });

  it('cards: the task of a parent and the report of a child have their own labels', () => {
    const ev = (id: string, kind: 'spawn' | 'report', text: string) =>
      line(id, { type: 'user', message: { content: wrapPeerMessage({ from: FROM, title: 'Родитель', machine: 'HP', id: MSG, kind }, text) } });
    const items = buildChat([ev('a', 'spawn', 'проверь'), ev('b', 'report', 'готово')]);
    expect(items[0]).toMatchObject({ kind: 'peer', session: { kind: 'spawn' } });
    expect(items[1]).toMatchObject({ kind: 'peer', session: { kind: 'report' } });
    const s = session();
    useStore.setState({ runners: RUNNERS, models: [{ value: 'opus', displayName: 'Opus 5.5' }] });
    useStore.getState().upsertSessions([s]);
    useStore.setState({ logs: { [s.id]: { events: [ev('a', 'spawn', 'проверь'), ev('b', 'report', 'готово')], before: null, loaded: true, loading: false, error: null } } });
    render(<Chat session={s} paneId="p1" />);
    expect(screen.getByText(/Задание от сессии/)).toBeInTheDocument();
    expect(screen.getByText(/Итог хода сессии/)).toBeInTheDocument();
  });
});
