// «Не удалось загрузить историю» on a desktop session with subagents (Ivan, M4a): the history of that session parses
// and renders (checked on its real pages, here an anonymised fixture of the same line kinds); a broken item does not
// take the feed down; a page that breaks on a weak link is retried, then «Повторить».
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HubEvent } from '../../api/types';
import { useStore } from '../../store';
import { RUNNERS, resetStore, session } from '../../test/factories';
import { ensureLog, eventsWithRetry } from '../workspace/actions';
import { Chat } from './Chat';
import { ItemBoundary } from './ChatItems';
import { buildChat } from './transcript';

const line = (n: number, l: Record<string, unknown>): HubEvent => ({ kind: 'line', id: `l:1:0:${n}`, ts: '2026-10-26T05:00:00Z', line: l }) as HubEvent;

/** Line kinds of a Claude Desktop session with subagents and teammates (types and shapes only, texts invented). */
const DESKTOP: HubEvent[] = [
  line(1, { type: 'custom-title', customTitle: 'Мультиагент', sessionId: 's' }),
  line(2, { type: 'mode', mode: 'normal' }),
  line(3, { type: 'permission-mode', permissionMode: 'bypassPermissions' }),
  line(4, { type: 'bridge-session', url: 'https://example.invalid/bridge' }),
  line(5, { type: 'user', uuid: 'u1', message: { role: 'user', content: 'Раздай задачи агентам' } }),
  line(6, {
    type: 'assistant',
    uuid: 'a1',
    message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Task', input: { description: 'исследование', prompt: 'найди', subagent_type: 'general-purpose' } }] },
  }),
  line(7, {
    type: 'user',
    uuid: 'u2',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'готово' }] }] },
    toolUseResult: { status: 'completed', totalTokens: 10 },
  }),
  line(8, { type: 'system', subtype: 'stop_hook_summary', hookCount: 2, hookInfos: [{ command: 'x' }], hookErrors: [], preventedContinuation: false, level: 'suggestion' }),
  line(9, { type: 'user', uuid: 'u3', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>x</system-reminder>' }] } }),
  line(10, { type: 'queue-operation', operation: 'enqueue', content: 'ещё' }),
  line(11, { type: 'attachment', attachment: { type: 'teammate_message', from: 'agent-1', text: 'отчёт' } }),
  line(12, { type: 'user', uuid: 'u4', message: { role: 'user', content: [{ type: 'text', text: '<teammate-message from="agent-1">отчёт агента</teammate-message>' }] } }),
  line(13, {
    type: 'assistant',
    uuid: 'a2',
    message: {
      id: 'm2',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '…' },
        { type: 'text', text: 'Агенты закончили.' },
      ],
    },
  }),
  line(14, { type: 'assistant', uuid: 'a3', message: { id: 'm3', role: 'assistant', content: null } }),
  line(15, { type: 'user', uuid: 'u5', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'нет-такого', content: 'сирота' }] } }),
  line(16, { type: 'summary', summary: 'итог', leafUuid: 'a2' }),
];

function show(events: HubEvent[]) {
  const s = session({ title: 'Мультиагент' });
  useStore.setState({ runners: RUNNERS, models: [] });
  useStore.getState().upsertSessions([s]);
  useStore.setState({ logs: { [s.id]: { events, before: null, loaded: true, loading: false, error: null } } });
  return { s, ...render(<Chat session={s} paneId="p1" />) };
}

describe('history of a desktop session with subagents', () => {
  beforeEach(resetStore);
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('unknown and service lines are skipped, the conversation is shown', () => {
    expect(() => buildChat(DESKTOP)).not.toThrow();
    show(DESKTOP);
    expect(screen.getByText('Раздай задачи агентам')).toBeInTheDocument();
    expect(screen.getByText('Агенты закончили.')).toBeInTheDocument();
    expect(screen.queryByText(/Не удалось/)).not.toBeInTheDocument();
  });

  it('an item that throws while rendering is replaced by a note, the rest of the feed stays', () => {
    const Boom = () => {
      throw new Error('broken block');
    };
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <>
        <ItemBoundary id="x">
          <Boom />
        </ItemBoundary>
        <ItemBoundary id="y">
          <p>соседнее сообщение</p>
        </ItemBoundary>
      </>,
    );
    expect(screen.getByText('Не удалось показать сообщение')).toBeInTheDocument();
    expect(screen.getByText('соседнее сообщение')).toBeInTheDocument();
    err.mockRestore();
  });

  it('a page broken by the network is retried; the hub error is not', async () => {
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n++;
        if (n < 3) throw new TypeError('network error');
        return new Response(JSON.stringify({ events: DESKTOP, before: null }), { status: 200 });
      }),
    );
    const page = await eventsWithRetry('s', null, [0, 0]);
    expect(page.events).toHaveLength(DESKTOP.length);
    expect(n).toBe(3);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'not_found' }), { status: 404 })),
    );
    await expect(eventsWithRetry('s', null, [0, 0])).rejects.toMatchObject({ status: 404 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('after the retries: «Не удалось загрузить историю: нет связи с хабом» with «Повторить», which loads it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let up = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (!up) throw new TypeError('network error');
        return new Response(JSON.stringify({ events: DESKTOP, before: null }), { status: 200 });
      }),
    );
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { s } = show([]);
    useStore.setState({ logs: {} });
    ensureLog(s.id);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось загрузить историю: нет связи с хабом');
    up = true;
    await userEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByText('Раздай задачи агентам')).toBeInTheDocument();
    err.mockRestore();
  });
});
