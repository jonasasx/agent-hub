// Task 4.15. Requirements (session-fork): Форма форка; Полная копия; Handoff; Пометка и размещение форка.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SessionView } from '../../api/types';
import { useStore } from '../../store';
import { RUNNERS, mockFetch, resetStore, session } from '../../test/factories';
import * as L from '../layout/layout';
import { handleServerMessage } from '../workspace/actions';
import { useDrafts } from './drafts';
import { ForkModal, copyUnavailable, handoffTarget } from './ForkModal';

type Call = { url: string; method: string; body: unknown };

function setup(s: SessionView, opts: { mode?: 'copy' | 'handoff'; draft?: 'ready' | 'pending' | 'error'; fork?: (body: Record<string, unknown>) => { status: number; body?: unknown } } = {}) {
  useStore.setState({ runners: RUNNERS, device: 'desktop', ws: L.emptyWorkspace([s.id]), layoutLoaded: true });
  useStore.getState().upsertSessions([s]);
  let drafts = 0;
  const calls: Call[] = mockFetch({
    'POST /api/sessions/': (init, url) => {
      if (url!.endsWith('/handoff-drafts')) {
        drafts++;
        return { status: 202, body: { id: `d${drafts}`, status: 'pending' } };
      }
      const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
      if (opts.fork) return opts.fork(body);
      return { status: 201, body: session({ title: body.mode === 'copy' ? s.title : 'Handoff', forkOf: { id: s.id, title: s.title }, runnerId: String(body.runnerId ?? s.runnerId) }) };
    },
    'GET /api/handoff-drafts/': () => ({ status: 200, body: { id: 'd1', status: 'pending' } }),
    'GET /api/sessions/': () => ({ status: 200, body: { events: [], before: null } }),
  });
  render(<ForkModal sessionId={s.id} initialMode={opts.mode} onClose={() => useStore.setState({ modal: null })} />);
  return calls;
}
const forkCalls = (calls: Call[]) => calls.filter(c => c.method === 'POST' && c.url.endsWith('/fork'));

describe('fork form', () => {
  beforeEach(() => {
    resetStore();
    useDrafts.setState({ byId: {} });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('copy unavailable with the reason: offline machine, cron, no directory or unknown machine', () => {
    expect(copyUnavailable(session({ runnerId: 'hp' }), RUNNERS)).toBe('Недоступно: машина офлайн');
    expect(copyUnavailable(session({ isCron: true, readOnlyReason: 'cron' }), RUNNERS)).toBe('Недоступно: cron-сессия');
    expect(copyUnavailable(session({ readOnlyReason: 'cwd_missing' }), RUNNERS)).toBe('Недоступно: нет каталога на машине');
    expect(copyUnavailable(session({ runnerId: 'gone' }), RUNNERS)).toBe('Недоступно: нет каталога на машине');
    expect(copyUnavailable(session(), RUNNERS)).toBeNull();
    // handoff defaults: the source's runner and directory, or the first online runner and its vault root
    expect(handoffTarget(session({ runnerId: 'vm', cwd: '/home/ubuntu/vault/x' }), RUNNERS)).toEqual({ runnerId: 'vm', cwd: '/home/ubuntu/vault/x' });
    expect(handoffTarget(session({ runnerId: 'hp' }), RUNNERS)).toEqual({ runnerId: 'x1', cwd: 'C:\\Users\\alice\\vault' });
  });

  it('Полная копия: POST fork {mode:"copy"}, the copy opens in a new pane right of the source', async () => {
    const s = session({ title: 'Число 4817' });
    const calls = setup(s);
    expect(screen.getByRole('radio', { name: /Полная копия/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('checkbox', { name: 'Открыть справа, рядом с исходной' })).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'Создать копию' }));
    await waitFor(() => expect(forkCalls(calls)).toHaveLength(1));
    expect(forkCalls(calls)[0]!.body).toEqual({ mode: 'copy' });
    const ws = useStore.getState().ws;
    await waitFor(() => expect(L.leaves(useStore.getState().ws.layout)).toHaveLength(2));
    const [left, right] = L.leaves(useStore.getState().ws.layout).map(p => useStore.getState().ws.panes[p]!);
    expect(left!.tabs).toEqual([s.id]);
    expect(useStore.getState().sessions[right!.tabs[0]!]!.forkOf).toEqual({ id: s.id, title: 'Число 4817' });
    expect(ws).toBeDefined();
  });

  it('without «Открыть справа» the copy is a tab of the active pane', async () => {
    const s = session();
    setup(s);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Открыть справа, рядом с исходной' }));
    await userEvent.click(screen.getByRole('button', { name: 'Создать копию' }));
    await waitFor(() => expect(L.allTabs(useStore.getState().ws)).toHaveLength(2));
    expect(L.leaves(useStore.getState().ws.layout)).toHaveLength(1);
  });

  it('Офлайн-машина: Handoff chosen, copy disabled with «машина офлайн»; the draft fills the prompt; launch on the chosen runner', async () => {
    const s = session({ runnerId: 'hp', title: 'Сессия HP' });
    const calls = setup(s);
    expect(screen.getByRole('radio', { name: /Полная копия/ })).toBeDisabled();
    expect(screen.getByText(/машина офлайн/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Handoff/ })).toHaveAttribute('aria-checked', 'true');
    expect(await screen.findByText(/Хаб готовит промпт/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /X1/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('Каталог')).toHaveValue('C:\\Users\\alice\\vault');
    await waitFor(() => expect(useDrafts.getState().byId.d1).toBeDefined());
    act(() => handleServerMessage({ type: 'handoff.draft', draft: { id: 'd1', sessionId: 's', status: 'ready', text: '## Цель\nдоделать', error: null, createdAt: '', finishedAt: '' } }));
    await waitFor(() => expect(screen.getByLabelText('Промпт для новой сессии')).toHaveValue('## Цель\nдоделать'));
    expect(screen.queryByText(/Хаб готовит промпт/)).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Промпт для новой сессии'), ' сегодня');
    await userEvent.click(screen.getByRole('radio', { name: /ВМ \.3/ }));
    expect(screen.getByLabelText('Каталог')).toHaveValue('/home/ubuntu/vault');
    await userEvent.click(screen.getByRole('button', { name: 'Запустить handoff' }));
    await waitFor(() => expect(forkCalls(calls)).toHaveLength(1));
    expect(forkCalls(calls)[0]!.body).toEqual({ mode: 'handoff', prompt: '## Цель\nдоделать сегодня', runnerId: 'vm', cwd: '/home/ubuntu/vault', draftId: 'd1' });
  });

  it('Cron-сессия: only Handoff', () => {
    setup(session({ isCron: true, readOnlyReason: 'cron', status: 'closed', source: 'cron' }));
    expect(screen.getByRole('radio', { name: /Полная копия/ })).toBeDisabled();
    expect(screen.getByText(/cron-сессия/)).toBeInTheDocument();
  });

  it('a draft that failed: the message and «Повторить» asks for a new one', async () => {
    const s = session();
    const calls = setup(s, { mode: 'handoff' });
    await waitFor(() => expect(useDrafts.getState().byId.d1).toBeDefined());
    act(() => handleServerMessage({ type: 'handoff.draft', draft: { id: 'd1', sessionId: 's', status: 'error', text: null, error: 'Модель не ответила за 120 с', createdAt: '', finishedAt: '' } }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Модель не ответила за 120 с');
    await userEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await waitFor(() => expect(calls.filter(c => c.url.endsWith('/handoff-drafts'))).toHaveLength(2));
    expect(await screen.findByText(/Хаб готовит промпт/)).toBeInTheDocument();
  });

  it('cwd_not_found keeps the form open with the text under «Каталог»', async () => {
    const s = session();
    setup(s, { mode: 'handoff', fork: () => ({ status: 422, body: { error: 'cwd_not_found', message: 'Каталог не найден на X1' } }) });
    await screen.findByText(/Хаб готовит промпт/);
    await userEvent.type(screen.getByLabelText('Промпт для новой сессии'), 'свой промпт');
    await userEvent.click(screen.getByRole('button', { name: 'Запустить handoff' }));
    expect(await screen.findByText('Каталог не найден на X1')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
