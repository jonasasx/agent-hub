// Component tests of the left panel (task 2.9): «Сейчас» order and badges, project counters, «ещё N», cron switch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SidebarProject } from '../../api/types';
import { useStore } from '../../store';
import { RUNNERS, mockFetch, resetStore, session } from '../../test/factories';
import { nowList, runnerIndex } from '../sessions/status';
import { Sidebar } from './Sidebar';

const NONE = { id: null, title: 'Без проекта', colorKey: 'none' as const, path: '' };
const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function setup() {
  const working = session({ title: 'Работает', status: 'working', lastEventAt: ago(0) });
  const unread = session({ title: 'Непрочитанный', status: 'waiting', unread: true, lastEventAt: ago(9) });
  const perm = session({ title: 'Просит разрешение', status: 'permission', lastEventAt: ago(30) });
  const read = session({ title: 'Прочитанный', status: 'waiting', lastEventAt: ago(2) });
  const sleeping = session({ title: 'Спит', status: 'sleeping', lastEventAt: ago(60) });
  const offline = session({ title: 'На HP', runnerId: 'hp', status: 'working', lastEventAt: ago(1) });
  const closed = session({ title: 'Завершённая', status: 'closed', lastEventAt: ago(600) });
  const list = [working, offline, read, unread, perm, sleeping, closed];
  const project: SidebarProject = { project: NONE, live: 6, total: 12, lastActivityAt: ago(0), sessions: list.slice(0, 5) };
  useStore.setState({ runners: RUNNERS, projects: [project] });
  useStore.getState().upsertSessions(list);
  return { working, unread, perm, read, sleeping, offline, closed, list, project };
}

describe('Sidebar', () => {
  beforeEach(resetStore);
  afterEach(() => vi.unstubAllGlobals());

  it('a session with Remote Control has the «Remote Control» mark in the tree (D5)', () => {
    const rc = session({ title: 'Из терминала', status: 'closed', source: 'terminal', isHubManaged: false, remoteControl: true, lastEventAt: ago(1) });
    useStore.setState({ runners: RUNNERS, projects: [{ project: NONE, live: 0, total: 1, lastActivityAt: ago(1), sessions: [rc] }] });
    useStore.getState().upsertSessions([rc]);
    render(<Sidebar onLogout={() => undefined} />);
    const row = screen.getByText('Из терминала').closest('.srow')!;
    expect(within(row as HTMLElement).getByLabelText('Remote Control')).toHaveTextContent('RC');
  });

  it('Раздел «Сейчас»: waiting for the user first (by freshness), then working; offline, read, sleeping, closed are not there', () => {
    setup();
    render(<Sidebar onLogout={() => undefined} />);
    expect(screen.getByRole('heading', { name: /Сейчас/ })).toHaveTextContent('Сейчас 3');
    const rows = [...document.querySelectorAll('.side-scroll > .srow')].map(r => r.querySelector('.title')!.firstChild!.textContent);
    expect(rows).toEqual(['Непрочитанный', 'Просит разрешение', 'Работает']);
    expect(screen.getByText('Без проекта · X1 · ждёт разрешения')).toBeInTheDocument();
  });

  it('shows explicit catalog projects in the sidebar without rendering their directory paths', () => {
    const id = 'ef6c84c5-9850-4aa6-84d1-43010a68266f';
    const s = session({ title: 'Catalog session', project: { id, title: 'Agent Hub', colorKey: 'none', path: '' }, catalogProject: { id, name: 'Agent Hub' } });
    useStore.setState({ runners: RUNNERS, projects: [{ project: { id, title: 'Agent Hub', colorKey: 'none', path: '' }, live: 1, total: 1, lastActivityAt: ago(1), sessions: [s] }] });
    useStore.getState().upsertSessions([s]);
    render(<Sidebar onLogout={() => undefined} />);
    expect(screen.getByRole('button', { name: /Agent Hub/ })).toBeInTheDocument();
    expect(document.querySelector('.prow[title*="C:\\work"]')).toBeNull();
    expect(screen.getByText('Catalog session')).toBeInTheDocument();
  });

  it('Сессия просит разрешение: «!» glyph; a newer permission request goes above an older unread answer', () => {
    const s = setup();
    useStore.getState().upsertSessions([{ ...s.perm, lastEventAt: ago(0) }]);
    render(<Sidebar onLogout={() => undefined} />);
    const first = document.querySelector('.side-scroll > .srow')!;
    expect(first).toHaveTextContent('Просит разрешение');
    expect(first.querySelector('.g-perm')).toHaveTextContent('!');
  });

  it('nowList honours the cron switch', () => {
    const cron = session({ status: 'working', isCron: true });
    const idx = runnerIndex(RUNNERS);
    expect(nowList([cron], idx, false)).toHaveLength(0);
    expect(nowList([cron], idx, true)).toHaveLength(1);
  });

  it('empty «Сейчас» shows «Ничего не ждёт ответа»', () => {
    useStore.setState({ runners: RUNNERS });
    render(<Sidebar onLogout={() => undefined} />);
    expect(screen.getByText('Ничего не ждёт ответа')).toBeInTheDocument();
    expect(screen.getByText('Сессий пока нет')).toBeInTheDocument();
  });

  it('Дерево «Проекты»: counters, five rows, closed dimmed, path tooltip', () => {
    setup();
    render(<Sidebar onLogout={() => undefined} />);
    const proj = screen.getByRole('button', { name: /Без проекта/, expanded: true });
    expect(within(proj).getByTitle('активных')).toHaveTextContent('6');
    expect(within(proj).getByTitle('всего')).toHaveTextContent('12');
    expect(proj).toHaveAttribute('title', 'Проект не определён');
    expect(document.querySelectorAll('.pchildren .srow')).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'ещё 7' })).toBeInTheDocument();
  });

  it('Ещё N: loads the rest from /api/projects/none/sessions and shows them all', async () => {
    const s = setup();
    const calls = mockFetch({ '/api/projects/none/sessions': () => ({ status: 200, body: { sessions: s.list.slice(5), total: 12 } }) });
    render(<Sidebar onLogout={() => undefined} />);
    await userEvent.click(screen.getByRole('button', { name: 'ещё 7' }));
    expect(calls[0]!.url).toBe('/api/projects/none/sessions?offset=5&limit=200&cron=0');
    expect(calls).toHaveLength(1);
    expect(await screen.findByText('Завершённая')).toBeInTheDocument();
    expect(screen.getByText('Завершённая').closest('.srow')).toHaveClass('dim');
    expect(screen.queryByRole('button', { name: /^ещё/ })).not.toBeInTheDocument();
  });

  it('Ещё N over 200 sessions: pages of limit ≤ 200 (the hub refuses more) up to the total (QA: limit=500 → 400)', async () => {
    const s = setup();
    const many = Array.from({ length: 407 }, (_, i) => session({ title: `Старая ${i + 1}`, status: 'closed', lastEventAt: ago(1000 + i) }));
    useStore.setState({ projects: [{ ...s.project, total: 5 + many.length }] });
    const calls = mockFetch({
      '/api/projects/none/sessions': (_i, url) => {
        const q = new URL(url!, 'http://x').searchParams;
        const off = Number(q.get('offset'));
        const limit = Number(q.get('limit'));
        if (limit > 200) return { status: 400, body: { error: 'invalid_request', message: 'Too big' } };
        return { status: 200, body: { sessions: many.slice(off - 5, off - 5 + limit), total: 5 + many.length } };
      },
    });
    render(<Sidebar onLogout={() => undefined} />);
    await userEvent.click(screen.getByRole('button', { name: 'ещё 407' }));
    expect(await screen.findByText('Старая 407')).toBeInTheDocument();
    expect(calls.map(c => c.url)).toEqual([
      '/api/projects/none/sessions?offset=5&limit=200&cron=0',
      '/api/projects/none/sessions?offset=205&limit=200&cron=0',
      '/api/projects/none/sessions?offset=405&limit=200&cron=0',
    ]);
    expect(screen.queryByRole('button', { name: /^ещё/ })).not.toBeInTheDocument();
  });

  it('Ещё N when the hub refuses: a toast, the button stays, no unhandled rejection', async () => {
    setup();
    mockFetch({ '/api/projects/none/sessions': () => ({ status: 400, body: { error: 'invalid_request', message: 'Too big: expected number to be <=200 at limit' } }) });
    render(<Sidebar onLogout={() => undefined} />);
    await userEvent.click(screen.getByRole('button', { name: 'ещё 7' }));
    await vi.waitFor(() => expect(useStore.getState().toasts.map(t => t.title)).toContain('Список не загружен'));
    expect(screen.getByRole('button', { name: 'ещё 7' })).toBeInTheDocument();
  });

  it('collapsing a project hides its sessions', async () => {
    setup();
    render(<Sidebar onLogout={() => undefined} />);
    await userEvent.click(screen.getByRole('button', { name: /Без проекта/, expanded: true }));
    expect(document.querySelectorAll('.pchildren')).toHaveLength(0);
  });

  it('Cron скрыт по умолчанию: «показать cron» reloads the sidebar with cron=1', async () => {
    setup();
    const calls = mockFetch({ '/api/sidebar': () => ({ status: 200, body: { now: [], projects: [], runners: RUNNERS } }) });
    render(<Sidebar onLogout={() => undefined} />);
    await userEvent.click(screen.getByRole('button', { name: 'показать cron' }));
    expect(calls[0]!.url).toBe('/api/sidebar?cron=1');
    expect(await screen.findByRole('button', { name: 'скрыть cron' })).toBeInTheDocument();
  });

  it('clicking a row opens it as a tab of this window (no tab request to the hub, D11)', async () => {
    const s = setup();
    const calls = mockFetch({
      '/api/sessions/': () => ({ status: 200, body: { events: [], before: null } }),
    });
    render(<Sidebar onLogout={() => undefined} />);
    await userEvent.click(screen.getAllByText('Работает')[0]!);
    expect(useStore.getState().ws.panes.p1!.tabs).toEqual([s.working.id]);
    expect(calls.filter(c => c.method !== 'GET')).toEqual([]);
    expect(calls.some(c => c.url.startsWith('/api/tabs'))).toBe(false);
  });
});
