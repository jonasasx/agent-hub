// Preloaders (Ivan, M4a): the history skeleton, the spinner of «Показать раньше», «доставляется…» of a sent message,
// the live turn label, skeleton rows of «ещё N».
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HubEvent, SessionView } from '../../api/types';
import { useStore } from '../../store';
import { RUNNERS, mockFetch, resetStore, session } from '../../test/factories';
import { Sidebar } from '../sidebar/Sidebar';
import { Chat, turnLabel } from './Chat';
import { buildChat } from './transcript';

const line = (id: string, l: Record<string, unknown>): HubEvent => ({ kind: 'line', id, ts: '', line: l }) as HubEvent;
const user = (id: string, text: string) => line(id, { type: 'user', uuid: id, message: { role: 'user', content: text } });
const toolUse = (id: string, name: string) => line(id, { type: 'assistant', message: { id: `m-${id}`, content: [{ type: 'tool_use', id: `t-${id}`, name, input: {} }] } });
const note = (id: string, text: string): HubEvent => ({ kind: 'note', id, ts: '', text });

function Live({ id }: { id: string }) {
  const s = useStore(st => st.sessions[id])!;
  return <Chat session={s} paneId="p1" />;
}
function show(s: SessionView, log: Partial<{ events: HubEvent[]; loading: boolean; before: string | null }>) {
  useStore.setState({ runners: RUNNERS, models: [] });
  useStore.getState().upsertSessions([s]);
  useStore.setState({ logs: { [s.id]: { events: [], before: null, loaded: true, loading: false, error: null, ...log } } });
  return render(<Live id={s.id} />);
}

describe('turn label', () => {
  it('by what the chat already has', () => {
    expect(turnLabel(buildChat([]), false, 'HP')).toBe('Запускаем на HP');
    expect(turnLabel(buildChat([user('u1', 'привет')]), false, 'HP')).toBe('Запускаем на HP');
    expect(turnLabel(buildChat([user('u1', 'a'), toolUse('a1', 'Bash'), note('n1', 'Поднята через resume')]), false, 'HP')).toBe('Поднимаем через resume');
    expect(turnLabel(buildChat([user('u1', 'a'), toolUse('a1', 'Bash')]), false, 'HP')).toBe('Выполняет Bash');
    expect(turnLabel(buildChat([user('u1', 'a'), toolUse('a1', 'Bash')]), true, 'HP')).toBe('Claude пишет');
    expect(
      turnLabel(
        buildChat([user('u1', 'a'), toolUse('a1', 'Bash'), line('r1', { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't-a1', content: 'ok' }] } }), user('u2', 'ещё')]),
        false,
        'HP',
      ),
    ).toBe('Claude думает');
  });

  it('names the agent of a Codex session (provider-parity)', () => {
    expect(turnLabel(buildChat([user('u1', 'a'), toolUse('a1', 'Bash')]), true, 'HP', 'Codex')).toBe('Codex пишет');
    expect(
      turnLabel(buildChat([user('u1', 'a'), line('a2', { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'Смотрю' }] } }), user('u2', 'ещё')]), false, 'HP', 'Codex'),
    ).toBe('Codex думает');
  });
});

describe('agent name in the feed (provider-parity)', () => {
  beforeEach(resetStore);
  const answer = line('a1', { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Посмотрю файлы' }] } });

  it('a Codex session: answers, the turn label and the composer say Codex', () => {
    show(session({ provider: 'codex', status: 'working', processAlive: true }), { events: [user('u1', 'привет'), answer] });
    expect(document.querySelector('.msg.assistant .who svg')?.getAttribute('aria-label')).toBe('Codex');
    expect(document.querySelector('.chat-title .provider-icon.codex')).not.toBeNull();
    expect(screen.getByText('Codex думает')).toBeInTheDocument();
    expect(screen.queryByText(/Claude/)).toBeNull();
  });

  it('a Claude session keeps «Claude»', () => {
    show(session({ status: 'working', processAlive: true }), { events: [user('u1', 'привет'), answer] });
    expect(document.querySelector('.msg.assistant .who svg')?.getAttribute('aria-label')).toBe('Claude');
    expect(document.querySelector('.chat-title .provider-icon.claude')).not.toBeNull();
    expect(screen.getByText('Claude думает')).toBeInTheDocument();
  });
});

describe('preloaders', () => {
  beforeEach(resetStore);
  afterEach(() => vi.unstubAllGlobals());

  it('the first page: a skeleton of messages instead of text; «Показать раньше» spins while loading', () => {
    const s = session();
    const v = show(s, { loading: true, events: [] });
    expect(screen.getByRole('status', { name: 'Загрузка истории' }).querySelectorAll('.skeleton').length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByText('Загрузка истории…')).not.toBeInTheDocument();
    v.unmount();
    show(s, { loading: true, events: [user('u1', 'старое')], before: 'c1' });
    const older = screen.getByRole('button', { name: 'Показать раньше' });
    expect(older).toHaveAttribute('aria-busy', 'true');
    expect(older.querySelector('.spinner')).not.toBeNull();
  });

  it('a sent text: «доставляется…» with dots until its line comes back', async () => {
    const s = session({ status: 'waiting', processAlive: true });
    let uuid = '';
    mockFetch({
      'POST /api/sessions/': init => {
        uuid = (JSON.parse(String(init!.body)) as { clientUuid: string }).clientUuid;
        return { status: 202, body: { session: { ...s, status: 'working' } } };
      },
    });
    show(s, { events: [user('u0', 'раньше')] });
    await userEvent.type(screen.getByRole('textbox', { name: 'Сообщение' }), 'проверь{Enter}');
    const pending = await screen.findByText('доставляется…');
    expect(pending.closest('.msg.user')).toHaveTextContent('проверь');
    expect(pending.querySelector('.dots')).not.toBeNull();
    act(() => useStore.setState({ logs: { [s.id]: { ...useStore.getState().logs[s.id]!, events: [user('u0', 'раньше'), user(uuid, 'проверь')] } } }));
    expect(screen.queryByText('доставляется…')).not.toBeInTheDocument();
  });

  it('«ещё N»: skeleton rows and a spinner while the rest loads', async () => {
    const list = Array.from({ length: 5 }, (_, i) => session({ title: `S${i}`, status: 'closed' }));
    useStore.setState({
      runners: RUNNERS,
      projects: [{ project: { id: null, title: 'Без проекта', colorKey: 'none', path: '' }, live: 0, total: 9, lastActivityAt: null, sessions: list }],
      openProjects: { none: true },
    });
    useStore.getState().upsertSessions(list);
    let release!: () => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(r => (release = () => r(new Response(JSON.stringify({ sessions: [], total: 9 }), { status: 200 }))))),
    );
    render(<Sidebar onLogout={() => undefined} />);
    await userEvent.click(screen.getByRole('button', { name: /ещё 4/ }));
    expect(screen.getByRole('status', { name: 'Загрузка списка' }).querySelectorAll('.skeleton')).toHaveLength(3);
    expect(screen.getByRole('button', { name: /ещё 4/ })).toHaveAttribute('aria-busy', 'true');
    await act(async () => release());
    expect(screen.queryByRole('status', { name: 'Загрузка списка' })).not.toBeInTheDocument();
  });
});
