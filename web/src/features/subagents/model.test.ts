// Change `subagents` 5.1–5.3: the list tree, statuses with the session's liveness, links in the feed, feed items.
import { describe, expect, it } from 'vitest';
import type { HubEvent, SubagentView } from '../../api/types';
import { session } from '../../test/factories';
import { buildChat } from '../chat/transcript';
import { durationLabel, forCall, forTarget, subDurationMs, subStatus, subTree, subType } from './model';

const row = (over: Partial<SubagentView>): SubagentView => ({
  id: 'r',
  sessionId: 's1',
  agentId: null,
  toolUseId: null,
  parentAgentId: null,
  parentId: null,
  kind: 'subagent',
  description: 'd',
  agentType: 'general-purpose',
  name: null,
  model: null,
  background: true,
  status: 'completed',
  startedAt: '2026-10-26T10:00:00Z',
  lastEventAt: '2026-10-26T10:05:00Z',
  endedAt: '2026-10-26T10:05:00Z',
  durationMs: 300_000,
  totalTokens: null,
  toolUses: null,
  eventCount: 1,
  hasTranscript: true,
  session: { id: 's1', title: 'S' },
  ...over,
});

describe('subagents model', () => {
  it('tree: nested rows right under their parent (by parentId or parentAgentId), depth', () => {
    const list = [
      row({ id: 'a', agentId: 'A' }),
      row({ id: 'b', agentId: 'B' }),
      row({ id: 'c', agentId: 'C', parentId: 'a' }),
      row({ id: 'd', agentId: 'D', parentAgentId: 'C' }),
      row({ id: 'e', agentId: 'E' }),
    ];
    expect(subTree(list).map(x => `${x.v.id}${x.depth}`)).toEqual(['a0', 'c1', 'd2', 'b0', 'e0']);
  });

  it('status: running/idle of a dead session → interrupted; alive or finished as the hub says', () => {
    const dead = session({ processAlive: false, externalActive: false });
    const alive = session({ processAlive: true });
    expect(subStatus(row({ status: 'running' }), dead)).toBe('interrupted');
    expect(subStatus(row({ status: 'idle' }), dead)).toBe('interrupted');
    expect(subStatus(row({ status: 'running' }), alive)).toBe('running');
    expect(subStatus(row({ status: 'running' }), session({ processAlive: false, externalActive: true }))).toBe('running');
    expect(subStatus(row({ status: 'failed' }), dead)).toBe('failed');
  });

  it('links: a call by tool_use id, SendMessage by agentId then by name; types; durations', () => {
    const list = [row({ id: 'a', agentId: 'a85', toolUseId: 'tu1' }), row({ id: 't', kind: 'teammate', name: 'qa-m2', agentId: 'aqa' })];
    expect(forCall(list, 'tu1')?.id).toBe('a');
    expect(forTarget(list, 'qa-m2')?.id).toBe('t');
    expect(forTarget(list, 'a85')?.id).toBe('a');
    expect(forTarget(list, 'nobody')).toBeUndefined();
    expect(subType(list[1]!)).toBe('тиммейт qa-m2');
    expect(durationLabel(subDurationMs(row({}), 'completed'))).toBe('5 мин');
    const now = Date.parse('2026-10-26T10:01:30Z');
    expect(durationLabel(subDurationMs(row({ status: 'running', durationMs: null }), 'running', now))).toBe('1 мин 30 с');
  });
});

describe('feed items of subagents (5.3, design S6)', () => {
  const line = (id: string, l: Record<string, unknown>): HubEvent => ({ kind: 'line', id, ts: '', line: l }) as HubEvent;
  const user = (id: string, content: unknown) => line(id, { type: 'user', uuid: id, message: { role: 'user', content } });

  it('a teammate message to the lead is «Сообщение от X», not the user', () => {
    const items = buildChat([user('u1', '<teammate-message teammate_id="sa-m4" summary="spec">Спека готова</teammate-message>')]);
    expect(items).toEqual([expect.objectContaining({ kind: 'peer', from: 'sa-m4', text: 'Спека готова' })]);
  });

  it('queued_command: a peer message, a task notification note, the user text hidden when delivered later', () => {
    const q = (id: string, attachment: Record<string, unknown>) => line(id, { type: 'attachment', attachment });
    const items = buildChat([
      q('q1', { type: 'queued_command', prompt: 'x', origin: { kind: 'peer', name: 'qa-m2', body: 'Проверь' } }),
      q('q2', { type: 'queued_command', prompt: '<task-notification><task-id>a1</task-id><status>failed</status></task-notification>', origin: { kind: 'task-notification' } }),
      q('q3', { type: 'queued_command', prompt: 'ещё одно' }),
      user('u2', 'ещё одно'),
      q('q4', { type: 'queued_command', prompt: 'не доставлено' }),
      q('q5', { type: 'other', prompt: 'служебное' }),
    ]);
    expect(items.map(i => (i.kind === 'peer' ? `peer:${i.from}:${i.text}` : i.kind === 'note' ? `note:${i.text}` : i.kind === 'user' ? `user:${i.text}` : i.kind))).toEqual([
      'peer:qa-m2:Проверь',
      'note:Уведомление: задача failed',
      'user:ещё одно',
      'user:не доставлено',
    ]);
  });

  it('a task notification in a user line is a note with its summary', () => {
    const items = buildChat([user('u1', '<task-notification><task-id>a1</task-id><status>completed</status><summary>Agent "Ревью" completed</summary></task-notification>')]);
    expect(items).toEqual([expect.objectContaining({ kind: 'note', text: 'Уведомление: Agent "Ревью" completed' })]);
  });
});
