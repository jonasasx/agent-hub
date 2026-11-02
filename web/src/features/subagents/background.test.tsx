// Change `background-tasks` (task 2.2): monitors and background commands next to the subagents — the button with only
// background tasks, the section of the list, the opened row, the status at the call. Requirement (background-tasks):
// Фоновые задачи в списке рядом с субагентами.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { BackgroundTaskView } from '../../api/types';
import { useStore } from '../../store';
import { RUNNERS, mockFetch, resetStore, session } from '../../test/factories';
import { BackgroundStatus, SubagentList, SubagentScope, SubagentsButton } from './SubagentViews';
import { bgStatus, bgTitle, expiresLabel, isBackgroundCall } from './background';

let n = 0;
function task(over: Partial<BackgroundTaskView> = {}): BackgroundTaskView {
  n += 1;
  return {
    id: `toolu_${n}`,
    sessionId: 'S',
    kind: 'monitor',
    description: `Монитор ${n}`,
    command: 'while true; do glab api pipelines/1; sleep 30; done',
    taskId: `b${n}`,
    status: 'running',
    startedAt: new Date(Date.now() - 300_000).toISOString(),
    endedAt: null,
    expiresAt: new Date(Date.now() + 25 * 60_000).toISOString(),
    lastEvent: 'build-api: success',
    lastEventAt: new Date(Date.now() - 20_000).toISOString(),
    ...over,
  };
}

describe('background tasks in the UI', () => {
  beforeEach(resetStore);
  afterEach(() => vi.unstubAllGlobals());

  it('the button shows with background tasks only: «Фоновые 3 · 1 работает»', () => {
    const parent = { ...session({ subagents: { total: 0, running: 0, working: 1, background: 3 } }), processAlive: true };
    const rows = [task({ sessionId: parent.id }), task({ sessionId: parent.id, status: 'completed' }), task({ sessionId: parent.id, kind: 'bash', status: 'stopped', expiresAt: null })];
    useStore.setState({ runners: RUNNERS, subagentLists: { [parent.id]: [] }, backgroundLists: { [parent.id]: rows } });
    useStore.getState().upsertSessions([parent]);
    mockFetch({});
    render(<SubagentsButton s={parent} />);
    expect(screen.getByRole('button', { name: /Фоновые/ })).toHaveTextContent('Фоновые 3 · 1 работает');
  });

  it('with subagents too: «Субагенты 2 · фоновые 1 · …»; no button without either', () => {
    const parent = { ...session({ subagents: { total: 2, running: 0, working: 0, background: 1 } }), processAlive: true };
    useStore.setState({ runners: RUNNERS });
    useStore.getState().upsertSessions([parent]);
    mockFetch({});
    const { unmount } = render(<SubagentsButton s={parent} />);
    expect(screen.getByRole('button')).toHaveTextContent('Субагенты 2 · фоновые 1');
    unmount();
    const none = session({ subagents: { total: 0, running: 0, working: 0, background: 0 } });
    render(<SubagentsButton s={none} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('the list: a section with status, kind, expiry and the last event; a row opens to the command', () => {
    const parent = { ...session({ subagents: { total: 0, running: 0, working: 1, background: 2 } }), processAlive: true };
    const rows = [
      task({ sessionId: parent.id, description: 'CI pipeline #92435' }),
      task({ sessionId: parent.id, kind: 'bash', description: null, command: 'npm test -- --run', status: 'completed', endedAt: new Date().toISOString(), expiresAt: null, lastEvent: null }),
    ];
    useStore.setState({ runners: RUNNERS, subagentLists: { [parent.id]: [] }, backgroundLists: { [parent.id]: rows } });
    useStore.getState().upsertSessions([parent]);
    mockFetch({ [`/api/sessions/${parent.id}/subagents`]: () => ({ status: 200, body: { subagents: [], background: rows } }) });
    render(<SubagentList s={parent} onClose={() => undefined} />);
    expect(screen.getByRole('heading', { name: 'Фоновые задачи сессии' })).toBeInTheDocument();
    const section = screen.getByRole('region', { name: 'Фоновые задачи' });
    const items = within(section).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('CI pipeline #92435');
    expect(items[0]).toHaveTextContent(/монитор · работает · .* · истекает через 25 мин/);
    expect(items[0]).toHaveTextContent('build-api: success');
    expect(items[1]).toHaveTextContent('npm test -- --run');
    expect(items[1]).toHaveTextContent('команда · завершена');
    const details = items[0]!.querySelector('details')!;
    expect(details.open).toBe(false);
    fireEvent.click(within(items[0]!).getByText('CI pipeline #92435'));
    expect(details.open).toBe(true);
    expect(within(items[0]!).getByText(/glab api pipelines/)).toBeVisible();
  });

  it('the status at a call: «монитор истекла» once its time has passed, though the hub still says running', () => {
    const parent = session({ subagents: { total: 0, running: 0, working: 1, background: 1 } });
    const t = task({ sessionId: parent.id, id: 'toolu_call', expiresAt: new Date(Date.now() - 1000).toISOString() });
    useStore.setState({ runners: RUNNERS, subagentLists: { [parent.id]: [] }, backgroundLists: { [parent.id]: [t] } });
    useStore.getState().upsertSessions([parent]);
    mockFetch({});
    render(
      <SubagentScope.Provider value={parent.id}>
        <BackgroundStatus toolUseId="toolu_call" />
      </SubagentScope.Provider>,
    );
    expect(screen.getByText('монитор истекла')).toBeInTheDocument();
  });

  it('helpers: which calls start a task, the title, the expiry label', () => {
    expect(isBackgroundCall('Monitor', {})).toBe(true);
    expect(isBackgroundCall('Bash', { run_in_background: true })).toBe(true);
    expect(isBackgroundCall('Bash', { command: 'ls' })).toBe(false);
    expect(isBackgroundCall('Read', { run_in_background: true })).toBe(false);
    expect(bgTitle(task({ description: null, command: 'a'.repeat(100) }))).toBe(`${'a'.repeat(80)}…`);
    const now = Date.now();
    const v = task({ expiresAt: new Date(now + 90 * 60_000).toISOString() });
    expect(expiresLabel(v, bgStatus(v, now), now)).toBe('истекает через 1 ч 30 мин');
    expect(expiresLabel(v, 'completed', now)).toBe('');
  });
});
