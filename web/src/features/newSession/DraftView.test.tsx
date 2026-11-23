// Component tests of the new-session draft tab (change new-session-draft-tab, spec new-session-draft).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useStore } from '../../store';
import type { UserProjectView } from '../../api/types';
import type { ProjectItem } from '../projects/projects';
import { RUNNERS, mockFetch, resetStore, runner, session } from '../../test/factories';
import { allTabs, isDraftTab } from '../layout/layout';
import { loadWorkspace, openDraft } from '../workspace/actions';
import { writeWindow } from '../workspace/windowState';
import { useDrafts } from './draftStore';
import { DraftView } from './DraftView';

const AH = 'ef6c84c5-9850-4aa6-84d1-43010a68266f';
const DIR = [{ id: AH, kind: 'project', title: 'agent-hub', path: '', areaPath: null, colorKey: 'personal', archived: false }] as ProjectItem[];
const CATALOG: UserProjectView[] = [{ id: AH, name: 'agent-hub', description: '', remote: null, archived: false, lastEventAt: null, folder: 'agent-hub', colorKey: 'personal' }];

/** The focused pane's active tab, rendered as the workspace does for a draft. */
function Host() {
  const ws = useStore(s => s.ws);
  const sid = ws.panes[ws.focus]?.active;
  return sid && isDraftTab(sid) ? <DraftView draftId={sid} paneId={ws.focus} /> : <div data-testid="tab">{sid}</div>;
}

function routes(extra: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    'GET /api/catalog/projects': () => ({ status: 200, body: CATALOG }),
    'GET /api/preferences/launch': () => ({ status: 200, body: { runnerId: null, provider: null } }),
    '/api/projects': () => ({ status: 200, body: DIR }),
    ...extra,
  });
}

function show(runners = RUNNERS) {
  useStore.setState({
    runners,
    models: [
      { value: 'opus', displayName: 'Opus 5.5' },
      { value: 'haiku', displayName: 'Haiku 5.5' },
    ],
  });
  render(<Host />);
  act(() => openDraft());
}

const chip = (name: RegExp) => screen.getByRole('button', { name });
const field = () => screen.getByLabelText('Первое сообщение');
const posted = (calls: ReturnType<typeof mockFetch>) => calls.find(c => c.url === '/api/sessions' && c.method === 'POST');

describe('DraftView', () => {
  beforeEach(resetStore);
  afterEach(() => vi.unstubAllGlobals());

  it('defaults: the first online machine, Claude Code, «Определить по сообщению», bypassPermissions, the first model; focus in the composer', async () => {
    routes();
    show();
    expect(chip(/^Машина: X1$/)).toBeInTheDocument();
    expect(chip(/^Агент: Claude$/)).toBeInTheDocument();
    expect(chip(/^Проект: ✦ Определить по сообщению$/)).toBeInTheDocument();
    expect(chip(/^Модель: Opus 5.5$/)).toBeInTheDocument();
    expect(chip(/^Режим прав: bypassPermissions$/)).toBeInTheDocument();
    expect(field()).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Запустить' })).toBeDisabled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('session-effort: the effort chip shows the levels of a model that has them, resets on a model without, and the launch sends the level', async () => {
    const calls = routes({ 'POST /api/sessions': () => ({ status: 201, body: session() }) });
    show();
    act(() =>
      useStore.setState({
        models: [
          { value: 'opus', displayName: 'Opus 5.5', efforts: ['low', 'high'] },
          { value: 'haiku', displayName: 'Haiku 5.5' },
        ],
      }),
    );
    await userEvent.click(chip(/^Effort:/));
    expect(screen.getAllByRole('menuitemradio').map(o => o.textContent)).toEqual([expect.any(String), 'low', 'high']);
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'high' }));
    expect(chip(/^Effort: high$/)).toBeInTheDocument();
    await userEvent.click(chip(/^Модель:/));
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'Haiku 5.5' }));
    expect(screen.queryByRole('button', { name: /^Effort:/ })).not.toBeInTheDocument();
    await userEvent.click(chip(/^Модель:/));
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'Opus 5.5' }));
    expect(chip(/^Effort: /)).not.toHaveTextContent('high');
    await userEvent.click(chip(/^Effort:/));
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'low' }));
    await userEvent.type(field(), 'привет{Enter}');
    expect(posted(calls)?.body).toMatchObject({ model: 'opus', effort: 'low' });
  });

  it('an offline machine is listed as «не в сети» and cannot be picked', async () => {
    routes();
    show();
    await userEvent.click(chip(/^Машина:/));
    const hp = screen.getByRole('menuitemradio', { name: /HP/ });
    expect(hp).toBeDisabled();
    expect(hp).toHaveTextContent('не в сети');
    await userEvent.click(screen.getByRole('menuitemradio', { name: /ВМ .3/ }));
    expect(chip(/^Машина: ВМ .3$/)).toBeInTheDocument();
  });

  it('a root machine: the mode chip shows acceptEdits, bypassPermissions is disabled, the launch sends acceptEdits', async () => {
    const calls = routes({ 'POST /api/sessions': () => ({ status: 201, body: session({ runnerId: 'c' }) }) });
    show([runner({ id: 'x1', name: 'X1' }), runner({ id: 'c', name: 'Контейнер', os: 'Ubuntu 24.04', homeDir: '/root', defaultDir: null, runsAsRoot: true })]);
    await userEvent.click(chip(/^Машина:/));
    await userEvent.click(screen.getByRole('menuitemradio', { name: /Контейнер/ }));
    expect(chip(/^Режим прав: acceptEdits$/)).toBeInTheDocument();
    await userEvent.click(chip(/^Режим прав:/));
    expect(screen.getByRole('menuitemradio', { name: 'bypassPermissions — недоступен под root' })).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    await userEvent.type(field(), 'привет{Enter}');
    expect(posted(calls)?.body).toMatchObject({ runnerId: 'c', permissionMode: 'acceptEdits' });
  });

  it('Shift+Enter adds a line, Enter launches with the text and the chosen parameters; the tab becomes the session tab in place', async () => {
    const created = session({ title: 'hostname', status: 'working' });
    const calls = routes({
      'POST /api/sessions': () => ({ status: 201, body: created }),
      '/api/sessions/': () => ({ status: 200, body: { events: [], before: null } }),
      '/api/sidebar': () => ({ status: 200, body: { now: [], projects: [], runners: RUNNERS } }),
    });
    show();
    const draftId = useStore.getState().ws.panes[useStore.getState().ws.focus]!.active!;
    await userEvent.click(chip(/^Модель:/));
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'Haiku 5.5' }));
    await userEvent.click(chip(/^Режим прав:/));
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'default' }));
    await userEvent.type(field(), 'Скажи{Shift>}{Enter}{/Shift}hostname');
    expect(field()).toHaveValue('Скажи\nhostname');
    expect(posted(calls)).toBeUndefined();
    await userEvent.keyboard('{Enter}');
    expect(posted(calls)?.body).toMatchObject({ runnerId: 'x1', permissionMode: 'default', model: 'haiku', prompt: 'Скажи\nhostname' });
    expect(posted(calls)?.body).not.toHaveProperty('projectId');
    await screen.findByTestId('tab');
    const pane = useStore.getState().ws.panes[useStore.getState().ws.focus]!;
    expect(pane.active).toBe(created.id);
    expect(pane.tabs).not.toContain(draftId);
    expect(pane.tabs.filter(t => t === created.id)).toHaveLength(1);
  });

  it('a project from the chip: the hint shows its folder, the launch sends projectId', async () => {
    const calls = routes({ 'POST /api/sessions': () => ({ status: 201, body: session() }) });
    show();
    await userEvent.click(chip(/^Проект:/));
    expect(screen.getByRole('combobox', { name: 'Найти проект' })).toHaveFocus();
    await userEvent.click(await screen.findByRole('option', { name: /agent-hub/ }));
    expect(chip(/^Проект: agent-hub$/)).toBeInTheDocument();
    await userEvent.click(chip(/^Проект:/));
    expect(screen.getByText('Сессия начнётся в C:\\Users\\alice\\vault\\agent-hub')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await userEvent.type(field(), 'Проверь проект{Enter}');
    expect(posted(calls)?.body).toMatchObject({ projectId: AH });
    expect(posted(calls)?.body).not.toHaveProperty('cwd');
  });

  it('creates a project from the search and picks it', async () => {
    const id = '0b2b8d6e-1c1a-4c2e-9f61-3c6c2f1d5a10';
    const calls = routes({ 'POST /api/catalog/projects': () => ({ status: 201, body: { ...CATALOG[0], id, name: 'Blog', folder: null } }) });
    show();
    await userEvent.click(chip(/^Проект:/));
    await screen.findByRole('option', { name: /agent-hub/ });
    await userEvent.type(screen.getByRole('combobox', { name: 'Найти проект' }), 'Blog');
    await userEvent.click(screen.getByRole('option', { name: /Создать проект «Blog»/ }));
    expect(calls.find(c => c.url === '/api/catalog/projects' && c.method === 'POST')?.body).toEqual({ name: 'Blog' });
    expect(await screen.findByRole('button', { name: /^Проект: Blog$/ })).toBeInTheDocument();
  });

  it('«Без проекта» pins the launched session without a project', async () => {
    const created = session();
    const calls = routes({
      'POST /api/sessions': () => ({ status: 201, body: created }),
      'PUT /api/sessions/': () => ({ status: 200, body: created }),
      '/api/sessions/': () => ({ status: 200, body: { events: [], before: null } }),
    });
    show();
    await userEvent.click(chip(/^Проект:/));
    await userEvent.click(await screen.findByRole('option', { name: /Без проекта/ }));
    await userEvent.type(field(), 'привет{Enter}');
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PUT' && c.url.startsWith(`/api/sessions/${created.id}/project`))?.body).toEqual({ projectId: 'none' }));
    expect(posted(calls)?.body).not.toHaveProperty('projectId');
  });

  it('restores the last Codex agent and HP when that machine is online', async () => {
    const codex = {
      id: 'codex' as const,
      version: '0.166.0',
      login: 'ok' as const,
      account: { email: 'ivan@example.com', plan: 'pro' },
      models: [{ value: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol' }],
    };
    routes({ 'GET /api/preferences/launch': () => ({ status: 200, body: { runnerId: 'hp', provider: 'codex' } }) });
    show([runner(), runner({ id: 'hp', name: 'HP', providers: [codex] })]);
    expect(await screen.findByRole('button', { name: /^Машина: HP$/ })).toBeInTheDocument();
    expect(chip(/^Агент: Codex$/)).toBeInTheDocument();
    expect(chip(/^Модель: GPT-6.1-Sol$/)).toBeInTheDocument();
  });

  it('a draft tab restored by a reload starts from the defaults instead of an empty pane', async () => {
    routes();
    show();
    const draftId = allTabs(useStore.getState().ws).find(isDraftTab)!;
    writeWindow('desktop', useStore.getState().ws, {});
    // the reload: the window keeps its tabs, the launch choices were in memory only
    act(() => useDrafts.setState({ byId: {} }));
    await act(() => loadWorkspace('desktop'));
    expect(allTabs(useStore.getState().ws)).toContain(draftId);
    expect(useDrafts.getState().byId[draftId]).toBeDefined();
    expect(chip(/^Машина: X1$/)).toBeInTheDocument();
    expect(field()).toBeInTheDocument();
  });

  it('409 runner_offline: the text stays, the machine chip is highlighted, the banner shows the reason; a new choice clears the highlight', async () => {
    routes({ 'POST /api/sessions': () => ({ status: 409, body: { error: 'runner_offline' } }) });
    show();
    await userEvent.type(field(), 'hostname{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('X1 не в сети');
    expect(field()).toHaveValue('hostname');
    expect(chip(/^Машина:/)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByRole('button', { name: 'Повторить' })).not.toBeInTheDocument();
    await userEvent.click(chip(/^Машина:/));
    await userEvent.click(screen.getByRole('menuitemradio', { name: /ВМ .3/ }));
    expect(chip(/^Машина:/)).not.toHaveAttribute('aria-invalid');
  });

  it('502 attachment_delivery_failed: «Повторить» repeats the launch with the same text', async () => {
    let n = 0;
    const calls = routes({
      'POST /api/sessions': () => (++n === 1 ? { status: 502, body: { error: 'attachment_delivery_failed', message: 'Вложения не доставлены' } } : { status: 201, body: session() }),
      '/api/sessions/': () => ({ status: 200, body: { events: [], before: null } }),
    });
    show();
    await userEvent.type(field(), 'ещё раз{Enter}');
    await userEvent.click(await screen.findByRole('button', { name: 'Повторить' }));
    await screen.findByTestId('tab');
    expect(calls.filter(c => c.url === '/api/sessions' && c.method === 'POST').map(c => (c.body as { prompt: string }).prompt)).toEqual(['ещё раз', 'ещё раз']);
  });
});
