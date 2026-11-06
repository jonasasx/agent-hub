// Tasks 4.8 and 4.9 web. Requirements: workspace-ui «Дерево „Проекты“», «Строка проекта под шапкой чата»;
// project-grouping «Ручной перенос и закрепление». API per design.md D10.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SessionView, SidebarProject } from '../../api/types';
import { useStore } from '../../store';
import { RUNNERS, mockFetch, resetStore, session } from '../../test/factories';
import { Chat } from '../chat/Chat';
import { Sidebar } from '../sidebar/Sidebar';
import { handleServerMessage } from '../workspace/actions';
import { emptyWorkspace } from '../layout/layout';
import { evidenceText, filterProjects, projectItems, regroup, sortProjects, type ProjectItem } from './projects';

const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const NONE = { id: null, title: 'Без проекта', colorKey: 'none' as const, path: '' };
const LEDGER = { id: 'p-ledger', title: '01-ledger', colorKey: 'personal' as const, path: '20-personal/01-finance/systems/01-ledger', kind: 'system' as const };
const HUB = { id: 'p-hub', title: '05-agent-hub', colorKey: 'personal' as const, path: '20-personal/05-pos/systems/05-agent-hub', kind: 'system' as const };
const SMS = { id: 'p-sms', title: '03-mm-sms-bridge', colorKey: 'support' as const, path: '10-work/04-support/systems/03-mm-sms-bridge', kind: 'system' as const };
const DIR: ProjectItem[] = [
  { id: 'a-support', kind: 'area', title: 'Поддержка', path: '10-work/04-support', areaPath: '10-work/04-support', colorKey: 'support', archived: false },
  { id: 'p-sms', kind: 'system', title: '03-mm-sms-bridge', path: SMS.path, areaPath: '10-work/04-support', colorKey: 'support', archived: false },
  { id: 'p-ledger', kind: 'system', title: '01-ledger', path: LEDGER.path, areaPath: '20-personal/01-finance', colorKey: 'personal', archived: false },
  { id: 'p-crm', kind: 'project', title: '04-twenty-crm', path: '10-work/05-infra/projects/99-archive/04-twenty-crm', areaPath: '10-work/05-infra', colorKey: 'infra', archived: true },
  { id: 'b-vault', kind: 'builtin', title: 'Vault', path: '00-meta', areaPath: null, colorKey: 'personal', archived: false },
];
const group = (project: SidebarProject['project'], sessions: SessionView[], live = 0): SidebarProject => ({
  project,
  live,
  total: sessions.length,
  lastActivityAt: sessions[0]?.lastEventAt ?? null,
  sessions,
});

describe('projects (pure)', () => {
  it('evidence by source', () => {
    expect(evidenceText(session({ projectSource: 'auto', projectEvidence: '3 правки в 05-agent-hub' }))).toBe('определено по путям: 3 правки в 05-agent-hub');
    expect(evidenceText(session({ projectSource: 'manual' }))).toBe('закреплено вручную');
    expect(evidenceText(session({ projectSource: 'manual', projectEvidence: 'проект удалён из справочника' }))).toBe('проект удалён из справочника');
    expect(evidenceText(session({ projectSource: 'inherited', projectEvidence: 'унаследовано от родителя' }))).toBe('унаследовано от родителя');
    expect(evidenceText(session({ projectSource: 'inherited' }))).toBe('унаследовано от родителя');
    expect(evidenceText(session({ projectSource: 'none' }))).toBe('проект пока не определён');
  });

  it('directory: the hub order is kept, «Без проекта» added last when missing, search by title and path', () => {
    const items = projectItems(DIR);
    expect(items.at(-1)!.id).toBe('none');
    const all = filterProjects(items, '');
    expect(all.map(p => p.id)).toEqual([...DIR.map(p => p.id), 'none']);
    expect(filterProjects(items, 'SMS').map(p => p.id)).toEqual(['p-sms']);
    expect(filterProjects(items, '04-support').map(p => p.id)).toEqual(['a-support', 'p-sms']);
  });

  it('projects by freshness, «Без проекта» last', () => {
    const list = sortProjects([group(NONE, [session({ lastEventAt: ago(0) })]), group(LEDGER, [session({ lastEventAt: ago(50) })]), group(HUB, [session({ lastEventAt: ago(5) })])]);
    expect(list.map(p => p.project.title)).toEqual(['05-agent-hub', '01-ledger', 'Без проекта']);
  });

  it('regroup: the row moves with its counters, a new group appears, an emptied one goes away', () => {
    const a = session({ title: 'A', status: 'working', lastEventAt: ago(1) });
    const b = session({ title: 'B', lastEventAt: ago(3), status: 'closed' });
    const projects = [group(NONE, [a, b], 1)];
    const moved = { ...a, project: LEDGER, projectSource: 'auto' as const };
    const r = regroup(projects, { none: [b] }, a, moved);
    expect(r.projects.map(p => [p.project.title, p.total, p.live, p.sessions.map(s => s.title)])).toEqual([
      ['01-ledger', 1, 1, ['A']],
      ['Без проекта', 1, 0, ['B']],
    ]);
    const back = regroup(r.projects, r.more, moved, { ...moved, project: NONE });
    expect(back.projects.map(p => [p.project.title, p.total])).toEqual([['Без проекта', 2]]);
  });
});

/** The chat of a session as the work area shows it: the card from the store. */
function Live({ id }: { id: string }) {
  const s = useStore(st => st.sessions[id])!;
  return <Chat session={s} paneId="p1" />;
}

function chat(s: SessionView) {
  useStore.setState({ runners: RUNNERS, models: [{ value: 'opus', displayName: 'Opus 5.5' }] });
  useStore.getState().upsertSessions([s]);
  useStore.setState({ logs: { [s.id]: { events: [], before: null, loaded: true, loading: false, error: null } } });
  return render(<Live id={s.id} />);
}

describe('project line under the chat head (4.9)', () => {
  beforeEach(resetStore);
  afterEach(() => vi.unstubAllGlobals());

  it('Основание классификации: «05-agent-hub ▾ · определено по путям: 3 правки…», menu «Перенести в…» and «Закрепить»; the second project is a label', async () => {
    const s = session({ project: HUB, projectSource: 'auto', projectEvidence: '3 правки в 05-agent-hub', ...{ secondaryProject: { ...SMS } } } as Partial<SessionView>);
    mockFetch({});
    chat(s);
    const btn = screen.getByRole('button', { name: 'Проект: 05-agent-hub' });
    expect(btn).toHaveAttribute('title', HUB.path);
    expect(screen.getByText('определено по путям: 3 правки в 05-agent-hub')).toBeInTheDocument();
    expect(screen.getByText('+ 03-mm-sms-bridge')).toHaveAttribute('title', `Второй проект: ${SMS.path}`);
    await userEvent.click(btn);
    const menu = screen.getByRole('menu', { name: 'Проект сессии' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map(b => b.textContent),
    ).toEqual(['Перенести в…', 'Закрепить']);
    expect(within(menu).getByRole('menuitem', { name: 'Перенести в…' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(btn).toHaveFocus();
  });

  it('a catalog project chosen by hand says «закреплено вручную», one from the classifier offers «изменить»', () => {
    const pinned = session({ project: HUB, projectSource: 'none', catalogProject: { id: 'cook', name: 'Кулинария' }, catalogProjectSource: 'manual' } as Partial<SessionView>);
    mockFetch({});
    const view = chat(pinned);
    expect(screen.getByText('закреплено вручную')).toBeInTheDocument();
    expect(screen.queryByText('проект пока не определён')).not.toBeInTheDocument();
    view.unmount();
    const auto = session({ project: HUB, catalogProject: { id: 'hub', name: 'agent-hub' }, catalogProjectSource: 'auto', catalogProjectReason: 'classifier' } as Partial<SessionView>);
    chat(auto);
    expect(screen.getByText('Определено по первому сообщению')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'изменить' })).toBeInTheDocument();
  });

  it('Перенос закрепляется: «Перенести в…» searches the directory, Enter sends PUT …/project, the line says «закреплено вручную»', async () => {
    const s = session({ project: LEDGER, projectSource: 'auto', projectEvidence: '1 чтение в 01-ledger' });
    const calls = mockFetch({
      '/api/projects': () => ({ status: 200, body: DIR }),
      'PUT /api/sessions/': () => ({ status: 200, body: { ...s, project: SMS, projectSource: 'manual', projectEvidence: null } }),
    });
    chat(s);
    await userEvent.click(screen.getByRole('button', { name: 'Проект: 01-ledger' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Перенести в…' }));
    const q = screen.getByRole('combobox', { name: 'Найти проект' });
    expect(q).toHaveFocus();
    expect(await screen.findByRole('option', { name: /Без проекта/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^04-twenty-crm/ })).toHaveTextContent('архив');
    await userEvent.type(q, 'sms');
    expect(within(screen.getByRole('listbox', { name: 'Проекты' })).getAllByRole('option')).toHaveLength(1);
    await userEvent.keyboard('{Enter}');
    const put = calls.find(c => c.method === 'PUT')!;
    expect(put.url).toBe(`/api/sessions/${s.id}/project`);
    expect(put.body).toEqual({ projectId: 'p-sms' });
    expect(await screen.findByText('закреплено вручную')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Проект: 03-mm-sms-bridge, закреплён' })).toBeInTheDocument();
  });

  it('Закрепить and Открепить: POST and DELETE …/pin; the toast project_pinned says «Проект закреплён»', async () => {
    const s = session({ project: LEDGER, projectSource: 'auto', projectEvidence: '2 правки в 01-ledger' });
    const pinned = { ...s, projectSource: 'manual' as const };
    const calls = mockFetch({
      'POST /api/sessions/': () => ({ status: 200, body: pinned }),
      'DELETE /api/sessions/': () => ({ status: 200, body: s }),
    });
    chat(s);
    await userEvent.click(screen.getByRole('button', { name: 'Проект: 01-ledger' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Закрепить' }));
    expect(calls.at(-1)).toMatchObject({ method: 'POST', url: `/api/sessions/${s.id}/pin` });
    expect(await screen.findByText('закреплено вручную')).toBeInTheDocument();
    act(() => handleServerMessage({ type: 'toast', kind: 'project_pinned' as never, sessionId: s.id, text: `${s.title} → 01-ledger` }));
    expect(useStore.getState().toasts.at(-1)).toMatchObject({ title: 'Проект закреплён' });
    await userEvent.click(screen.getByRole('button', { name: 'Проект: 01-ledger, закреплён' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Открепить' }));
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: `/api/sessions/${s.id}/pin` });
    expect(await screen.findByText('определено по путям: 2 правки в 01-ledger')).toBeInTheDocument();
  });

  it('unknown_project: the error is shown, the directory is loaded again next time', async () => {
    const s = session({ project: LEDGER, projectSource: 'auto' });
    mockFetch({
      '/api/projects': () => ({ status: 200, body: DIR }),
      'PUT /api/sessions/': () => ({ status: 422, body: { error: 'unknown_project', message: 'Проекта нет в справочнике' } }),
    });
    chat(s);
    await userEvent.click(screen.getByRole('button', { name: /Проект: 01-ledger/ }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Перенести в…' }));
    await userEvent.click(await screen.findByRole('option', { name: /Vault/ }));
    await vi.waitFor(() => expect(useStore.getState().toasts.at(-1)).toMatchObject({ title: 'Сессия не перенесена', text: 'Проекта нет в справочнике' }));
    expect(useStore.getState().projectDir).toBeNull();
  });
});

describe('tree «Проекты» (4.8)', () => {
  beforeEach(resetStore);
  afterEach(() => vi.unstubAllGlobals());

  it('Проект определён: the focused row moves to its project without losing the focus; counters follow; «Без проекта» stays last', async () => {
    const a = session({ title: 'Правка агента', status: 'waiting', lastEventAt: ago(1) });
    const b = session({ title: 'Другая', status: 'closed', lastEventAt: ago(4) });
    const c = session({ title: 'Бухгалтерия', status: 'closed', lastEventAt: ago(30), project: LEDGER });
    useStore.setState({ runners: RUNNERS, projects: [group(NONE, [a, b], 1), group(LEDGER, [c])], openProjects: { none: true, 'p-ledger': true } });
    useStore.getState().upsertSessions([a, b, c]);
    mockFetch({ '/api/sidebar': () => ({ status: 200, body: { now: [], projects: useStore.getState().projects, runners: RUNNERS } }) });
    render(<Sidebar onLogout={() => undefined} />);
    const row = document.querySelector<HTMLElement>(`.pchildren [data-sid="${a.id}"]`)!;
    row.focus();
    act(() => handleServerMessage({ type: 'session.upsert', session: { ...a, project: HUB, projectSource: 'auto', projectEvidence: '2 правки в 05-agent-hub' } }));
    act(() => handleServerMessage({ type: 'toast', kind: 'project_auto', sessionId: a.id, text: 'Правка агента → 05-agent-hub' }));
    const names = [...document.querySelectorAll('.prow .pname')].map(n => n.textContent);
    expect(names).toEqual(['05-agent-hub', '01-ledger', 'Без проекта']);
    const moved = document.activeElement as HTMLElement;
    expect(moved.dataset.sid).toBe(a.id);
    expect(moved.closest('.pchildren')!.previousElementSibling).toHaveTextContent('05-agent-hub');
    expect(screen.getByRole('button', { name: /Без проекта/ })).toHaveAccessibleName(/всего 1/);
    expect(useStore.getState().toasts.at(-1)).toMatchObject({ title: 'Проект определён', text: 'Правка агента → 05-agent-hub' });
  });

  it('projects.changed (the catalogue changed): the sidebar, the directory and the sessions of open tabs are fetched again', async () => {
    const open = session({ title: 'Открытая', status: 'closed', project: LEDGER, lastEventAt: ago(1) });
    useStore.setState({ runners: RUNNERS, projects: [group(LEDGER, [open])], ws: emptyWorkspace([open.id]), projectDir: [] as never });
    useStore.getState().upsertSessions([open]);
    const moved = { ...open, project: HUB, projectEvidence: '2 правки в 05-agent-hub' };
    const calls = mockFetch({
      '/api/sidebar': () => ({ status: 200, body: { now: [], projects: [group(HUB, [moved])], runners: RUNNERS } }),
      [`/api/sessions/${open.id}`]: () => ({ status: 200, body: moved }),
    });
    act(() => handleServerMessage({ type: 'projects.changed' }));
    expect(useStore.getState().projectDir).toBeNull();
    await vi.waitFor(() => expect(calls.some(c => c.url.startsWith('/api/sidebar'))).toBe(true), { timeout: 2000 });
    expect(calls.some(c => c.url === `/api/sessions/${open.id}`)).toBe(true);
    await vi.waitFor(() => expect(useStore.getState().sessions[open.id]!.project.id).toBe(HUB.id));
  });

  it('the project of the session open in a pane opens by itself; archived projects are muted, the path is the tooltip', () => {
    const shown = session({ title: 'Открытая', status: 'closed', project: LEDGER, lastEventAt: ago(1) });
    const old = session({
      title: 'CRM',
      status: 'closed',
      project: { id: 'p-crm', title: '04-twenty-crm', colorKey: 'infra', path: '10-work/05-infra/projects/99-archive/04-twenty-crm', archived: true } as never,
      lastEventAt: ago(90),
    });
    useStore.setState({ runners: RUNNERS, projects: [group(LEDGER, [shown]), group(old.project, [old]), group(NONE, [session({ title: 'Без', status: 'closed' })])], ws: emptyWorkspace([shown.id]) });
    useStore.getState().upsertSessions([shown, old]);
    render(<Sidebar onLogout={() => undefined} />);
    expect(screen.getByRole('button', { name: /01-ledger/, expanded: true })).toHaveAttribute('aria-expanded', 'true');
    const crm = screen.getByRole('button', { name: /^04-twenty-crm/ });
    expect(crm).toHaveClass('archived');
    expect(crm).toHaveAttribute('title', '10-work/05-infra/projects/99-archive/04-twenty-crm · в архиве');
    expect(crm).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('session running outside the hub (externalActive, M4a contract)', () => {
  beforeEach(resetStore);
  afterEach(() => vi.unstubAllGlobals());

  it('«работает в терминале» instead of «Завершённая сессия»; without the flag — as before', () => {
    mockFetch({});
    const s = session({ status: 'closed', source: 'terminal', originSource: 'terminal', isHubManaged: false, ...{ externalActive: true, externalSince: ago(1) } } as Partial<SessionView>);
    const v = chat(s);
    expect(screen.getByRole('status')).toHaveTextContent('Сессия работает в терминале на X1');
    expect(screen.queryByText('Завершённая сессия')).not.toBeInTheDocument();
    v.unmount();
    act(() => useStore.getState().upsertSessions([{ ...s, ...{ externalActive: false } } as SessionView]));
    chat({ ...s, ...{ externalActive: false } } as SessionView);
    expect(screen.getByText('Завершённая сессия')).toBeInTheDocument();
  });
});
