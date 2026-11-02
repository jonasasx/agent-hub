// QA of subagents on prod (d87b281): the «работают» count and the link name of SendMessage by agentId.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { SubagentView } from '../../api/types';
import { useStore } from '../../store';
import { RUNNERS, mockFetch, resetStore, session } from '../../test/factories';
import { SubagentLink, SubagentScope, SubagentsButton } from './SubagentViews';

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

describe('QA subagents', () => {
  beforeEach(resetStore);
  afterEach(() => vi.unstubAllGlobals());

  it('QA 2: «работают» counts only running subagents, not teammates waiting for messages', () => {
    const parent = session({ subagents: { total: 3, running: 2 } });
    const rows = [row({ sessionId: parent.id, status: 'running' }), row({ sessionId: parent.id, kind: 'teammate', name: 'sa-m4', status: 'idle' }), row({ sessionId: parent.id, status: 'completed' })];
    useStore.setState({ runners: RUNNERS, subagents: Object.fromEntries(rows.map(r => [r.id, r])), subagentLists: { [parent.id]: rows.map(r => r.id) } });
    useStore.getState().upsertSessions([{ ...parent, processAlive: true }]);
    mockFetch({});
    render(<SubagentsButton s={{ ...parent, processAlive: true }} />);
    expect(screen.getByRole('button', { name: /Субагенты/ })).toHaveTextContent('Субагенты 3 · 1 работает');
  });

  it('QA 3: SendMessage addressed by agentId links with the registry name', () => {
    const parent = session();
    const v = row({ sessionId: parent.id, agentId: 'a35752dc4061ea8b4', name: 'dev-m2-fe', kind: 'subagent' });
    useStore.setState({ runners: RUNNERS, subagents: { [v.id]: v }, subagentLists: { [parent.id]: [v.id] } });
    useStore.getState().upsertSessions([parent]);
    mockFetch({});
    render(
      <SubagentScope.Provider value={parent.id}>
        <SubagentLink target="a35752dc4061ea8b4" label="Чат a35752dc4061ea8b4" />
      </SubagentScope.Provider>,
    );
    expect(screen.getByRole('link')).toHaveTextContent('Чат dev-m2-fe');
  });
});
