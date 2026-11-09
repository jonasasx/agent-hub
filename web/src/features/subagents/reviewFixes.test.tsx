// Review of the subagents web part: each test fails without its fix.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HubEvent, SubagentView } from '../../api/types';
import { useStore } from '../../store';
import { RUNNERS, mockFetch, resetStore, session } from '../../test/factories';
import { emptyWorkspace } from '../layout/layout';
import { attachSocket, dropSubagentLists, handleServerMessage, joinSnapshot, loadSubagents, loadWorkspace, openSession, syncSocket, upsertSubagent } from '../workspace/actions';
import { Workspace } from '../workspace/Workspace';
import { SubagentChat } from '../chat/Chat';
import { SubagentsButton } from './SubagentViews';

let n = 0;
function row(over: Partial<SubagentView> = {}): SubagentView {
  n += 1;
  return {
    id: `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    sessionId: 'S',
    agentId: `a${n}`,
    toolUseId: `t${n}`,
    parentAgentId: null,
    parentId: null,
    kind: 'subagent',
    description: `Субагент ${n}`,
    agentType: 'general-purpose',
    name: null,
    model: null,
    background: false,
    status: 'running',
    startedAt: new Date(Date.now() - 600_000 + n * 1000).toISOString(),
    lastEventAt: new Date(Date.now() - 60_000).toISOString(),
    endedAt: null,
    durationMs: null,
    totalTokens: null,
    toolUses: null,
    eventCount: 3,
    hasTranscript: true,
    session: { id: 'S', title: 'Родитель' },
    ...over,
  };
}

const sentSocket = () => {
  const sent: Array<Record<string, unknown>> = [];
  attachSocket({ send: m => sent.push(m as Record<string, unknown>), close: () => undefined });
  return sent;
};
const fetchedUrls = () => (fetch as unknown as { mock: { calls: [string][] } }).mock.calls.map(([u]) => u);

describe('subagents web review fixes', () => {
  beforeEach(resetStore);
  afterEach(() => {
    attachSocket(null);
    vi.unstubAllGlobals();
  });

  it('finding 1: rows that come live while GET /subagents is in flight win over the older snapshot and are listed', async () => {
    const parent = session();
    const a = row({ sessionId: parent.id, status: 'running', lastEventAt: new Date(Date.now() - 60_000).toISOString() });
    let release!: (r: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(res => (release = res))),
    );
    const loading = loadSubagents(parent.id);
    // during the request: A completes, a new subagent B starts
    const aDone = { ...a, status: 'completed' as const, endedAt: new Date().toISOString(), lastEventAt: new Date().toISOString() };
    const b = row({ sessionId: parent.id });
    upsertSubagent(aDone);
    upsertSubagent(b);
    release(new Response(JSON.stringify({ subagents: [a] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await loading;
    expect(useStore.getState().subagentLists[parent.id]).toEqual([a.id, b.id]);
    expect(useStore.getState().subagents[a.id]!.status).toBe('completed');
  });

  it('joinSnapshot: a fresher snapshot row is kept over an older live one', () => {
    const a = row({ status: 'running', lastEventAt: '2026-10-26T10:00:00Z' });
    const done = { ...a, status: 'completed' as const, endedAt: '2026-10-26T10:05:00Z' };
    expect(joinSnapshot([done], [a])[0]!.status).toBe('completed');
  });

  it('finding 2: a session leaving the screen forgets its list; the button reloads when the count differs', async () => {
    const parent = session({ subagents: { total: 2, running: 1 } });
    const other = session();
    const a = row({ sessionId: parent.id });
    useStore.setState({ runners: RUNNERS, ws: emptyWorkspace([parent.id, other.id]) });
    useStore.getState().upsertSessions([parent, other]);
    useStore.setState({ subagents: { [a.id]: a }, subagentLists: { [parent.id]: [a.id] } });
    sentSocket();
    syncSocket(true);
    const ws = useStore.getState().ws;
    act(() => useStore.setState({ ws: { ...ws, panes: { p1: { ...ws.panes.p1!, active: other.id } } } }));
    syncSocket();
    expect(useStore.getState().subagentLists[parent.id]).toBeUndefined();
    // the button with a loaded list of 1 while the session says 2 → GET again
    const b = row({ sessionId: parent.id });
    mockFetch({ [`/api/sessions/${parent.id}/subagents`]: () => ({ status: 200, body: { subagents: [a, b] } }) });
    useStore.setState({ subagentLists: { [parent.id]: [a.id] } });
    render(<SubagentsButton s={parent} />);
    expect(await screen.findByRole('button', { name: /Субагенты 2/ })).toBeInTheDocument();
    expect(fetchedUrls()).toContain(`/api/sessions/${parent.id}/subagents`);
  });

  it('finding 3: a subagent tab restored after a reload puts its parent into the subscription', async () => {
    const parent = session();
    const v = row({ sessionId: parent.id });
    sessionStorage.setItem('agenthub.tabkinds.v1', JSON.stringify({ [v.id]: 'subagent' }));
    mockFetch({
      '/api/layout': () => ({
        status: 200,
        body: {
          layout: { layout: { type: 'leaf', pane: 'p1' }, panes: { p1: { id: 'p1', tabs: [v.id], active: v.id } }, focus: 'p1', seq: 1 },
          savedLayout: null,
          openedAt: null,
          tabKinds: { [v.id]: 'subagent' },
          version: 1,
        },
      }),
      [`/api/subagents/${v.id}`]: () => ({ status: 200, body: v }),
      '/api/subagents/': () => ({ status: 200, body: { events: [], before: null } }),
      '/api/sessions/': () => ({ status: 200, body: parent }),
    });
    const sent = sentSocket();
    useStore.setState({ device: 'desktop' });
    await act(() => loadWorkspace('desktop'));
    const subs = sent.filter(m => m.type === 'subscribe');
    expect(subs.at(-1)).toMatchObject({ sessionIds: expect.arrayContaining([parent.id]), subagentIds: [v.id] });
  });

  it('finding 4: the parent session coming alive again reloads its subagent list («прерван» does not stick)', async () => {
    const dead = session({ processAlive: false, status: 'sleeping' });
    const a = row({ sessionId: dead.id, status: 'running' });
    useStore.getState().upsertSessions([dead]);
    useStore.setState({ subagents: { [a.id]: a }, subagentLists: { [dead.id]: [a.id] } });
    mockFetch({ [`/api/sessions/${dead.id}/subagents`]: () => ({ status: 200, body: { subagents: [a] } }) });
    act(() => handleServerMessage({ type: 'session.upsert', session: { ...dead, processAlive: true, status: 'working' } }));
    await vi.waitFor(() => expect(fetchedUrls()).toContain(`/api/sessions/${dead.id}/subagents`));
  });

  it('finding 5: an image in a subagent chat is requested from the parent session; drafts/partial of the subagent id are not read', async () => {
    const parent = session();
    const v = row({ sessionId: parent.id });
    const line: HubEvent = { kind: 'line', id: 'l1', ts: '', line: { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: '![скрин](C:\\Users\\alice\\shot.png)' }] } } };
    useStore.setState({ runners: RUNNERS, subagents: { [v.id]: v }, logs: { [v.id]: { events: [line], before: null, loaded: true, loading: false, error: null } } });
    useStore.getState().upsertSessions([parent]);
    useStore.setState({ partial: { [v.id]: { messageId: 'mX', text: 'чужой поток' } } });
    const calls = mockFetch({ '/api/sessions/': () => ({ status: 404, body: { error: 'file_not_found' } }) });
    render(<SubagentChat id={v.id} />);
    expect(screen.queryByText('чужой поток')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Показать изображение' }));
    expect(calls.find(c => c.url.endsWith('/images'))?.url).toBe(`/api/sessions/${parent.id}/images`);
  });

  it('a subagent tab shows the subagent status icon and the parent project colour', () => {
    const parent = session({ project: { id: 'p', title: '05-agent-hub', colorKey: 'personal', path: 'x' } });
    const v = row({ sessionId: parent.id, status: 'running' });
    useStore.setState({ runners: RUNNERS, ws: emptyWorkspace([v.id]), tabKinds: { [v.id]: 'subagent' }, subagents: { [v.id]: v } });
    useStore.getState().upsertSessions([parent]);
    mockFetch({ '/api/': () => ({ status: 200, body: { events: [], before: null } }) });
    render(<Workspace />);
    const tab = screen.getByRole('tab', { name: /Субагент · .*работает/ });
    expect(tab.querySelector('.g-work')).not.toBeNull();
    expect(tab.getAttribute('style')).toContain('--g-personal');
  });

  it('a ninth tab next to a subagent tab: nothing is evicted, no toast (spec tab-strip)', () => {
    const list = Array.from({ length: 8 }, () => session());
    const v = row({ sessionId: list[0]!.id, description: 'Phase 3 Dev' });
    useStore.setState({
      runners: RUNNERS,
      ws: emptyWorkspace([v.id, ...list.slice(0, 7).map(s => s.id)]),
      tabKinds: { [v.id]: 'subagent' },
      subagents: { [v.id]: v },
    });
    useStore.getState().upsertSessions(list);
    mockFetch({ '/api/': () => ({ status: 200, body: { events: [], before: null } }) });
    act(() => openSession(list[7]!.id));
    expect(useStore.getState().ws.panes.p1!.tabs).toHaveLength(9);
    expect(useStore.getState().ws.panes.p1!.tabs).toEqual(expect.arrayContaining([v.id, ...list.map(s => s.id)]));
    expect(useStore.getState().toasts).toEqual([]);
  });

  it('no «Вы» over the user message in a session; «Лид» over the user lines of a subagent feed', async () => {
    const { Chat } = await import('../chat/Chat');
    const parent = session();
    const v = row({ sessionId: parent.id });
    const u: HubEvent = { kind: 'line', id: 'u1', ts: '', line: { type: 'user', message: { role: 'user', content: 'сделай это' } } };
    useStore.setState({
      runners: RUNNERS,
      subagents: { [v.id]: v },
      logs: { [parent.id]: { events: [u], before: null, loaded: true, loading: false, error: null }, [v.id]: { events: [u], before: null, loaded: true, loading: false, error: null } },
    });
    useStore.getState().upsertSessions([parent]);
    mockFetch({ '/api/': () => ({ status: 200, body: { events: [], before: null } }) });
    const one = render(<Chat session={parent} paneId="p1" />);
    const msg = one.container.querySelector('.msg.user')!;
    expect(msg.querySelector('.who')).toBeNull();
    expect(msg.textContent).not.toContain('Вы');
    one.unmount();
    const two = render(<SubagentChat id={v.id} />);
    expect(two.container.querySelector('.msg.user .who')).toHaveTextContent('Лид');
  });

  describe('re-review: the subagent chat header follows the hub after it was off screen', () => {
    function setupSub() {
      const parent = session();
      const other = session({ title: 'Другая' });
      const v = row({ sessionId: parent.id, status: 'running', description: 'Phase 3 Dev' });
      useStore.setState({ runners: RUNNERS, ws: emptyWorkspace([v.id, other.id]), tabKinds: { [v.id]: 'subagent' }, subagents: { [v.id]: v }, subagentLists: { [parent.id]: [v.id] } });
      useStore.getState().upsertSessions([parent, other]);
      const done = { ...v, status: 'completed' as const, endedAt: new Date().toISOString(), lastEventAt: new Date().toISOString(), durationMs: 60_000 };
      const calls = mockFetch({
        [`/api/sessions/${parent.id}/subagents`]: () => ({ status: 200, body: { subagents: [done] } }),
        '/api/': () => ({ status: 200, body: { events: [], before: null } }),
      });
      return { parent, other, v, calls };
    }
    const header = () => document.querySelector('.sub-chat')!;

    it('scenario 1: another tab shown meanwhile → back on the subagent, the list is fetched again, «завершён»', async () => {
      const { parent, other, v, calls } = setupSub();
      sentSocket();
      render(<Workspace />);
      syncSocket(true);
      expect(header()).toHaveTextContent('работает');
      const ws = useStore.getState().ws;
      act(() => useStore.setState({ ws: { ...ws, panes: { p1: { ...ws.panes.p1!, active: other.id } } } }));
      syncSocket();
      // the subagent finished while hidden; its upsert went only to the parent's subscribers
      act(() => useStore.setState({ ws: { ...ws, panes: { p1: { ...ws.panes.p1!, active: v.id } } } }));
      syncSocket();
      await vi.waitFor(() => expect(header()).toHaveTextContent('завершён'));
      expect(calls.some(c => c.url === `/api/sessions/${parent.id}/subagents`)).toBe(true);
    });

    it('scenario 2: a reconnect drops the lists → the mounted subagent chat loads its parent list again', async () => {
      const { parent, calls } = setupSub();
      render(<Workspace />);
      expect(header()).toHaveTextContent('работает');
      act(() => dropSubagentLists('all'));
      await vi.waitFor(() => expect(header()).toHaveTextContent('завершён'));
      expect(calls.some(c => c.url === `/api/sessions/${parent.id}/subagents`)).toBe(true);
    });
  });

  it('re-review: a forced reload asked while a load is in flight runs after it', async () => {
    const parent = session();
    const a = row({ sessionId: parent.id });
    const releases: Array<(r: Response) => void> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(res => releases.push(res))),
    );
    const first = loadSubagents(parent.id);
    void loadSubagents(parent.id, true);
    expect(releases).toHaveLength(1);
    releases[0]!(new Response(JSON.stringify({ subagents: [a] }), { status: 200 }));
    await first;
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]!(new Response(JSON.stringify({ subagents: [{ ...a, status: 'completed' }] }), { status: 200 }));
    await vi.waitFor(() => expect(useStore.getState().subagents[a.id]!.status).toBe('completed'));
  });
});
