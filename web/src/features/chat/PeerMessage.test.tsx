// Change session-peers (design D8): a message of another hub session is a card «От сессии <заголовок> · <машина>» with a
// link that opens the sender, not the user's bubble; the sender's session_send call is the usual tool row.
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { wrapPeerMessage } from '@agent-hub/shared';
import type { HubEvent, SessionView } from '../../api/types';
import { useStore } from '../../store';
import { RUNNERS, resetStore, session } from '../../test/factories';
import { Chat } from './Chat';
import { buildChat } from './transcript';

const FROM = '0b3c1b3e-6b0a-4a52-9a4e-1d0a8d6f2f11';
const MSG = '5f1d8f7e-2b6f-4d3a-8a55-0c7a3c0b9e22';
const line = (id: string, l: Record<string, unknown>): HubEvent => ({ kind: 'line', id, ts: '', line: l }) as HubEvent;
const wrapped = (text: string, over: Partial<{ title: string; machine: string; inReplyTo: string }> = {}) =>
  wrapPeerMessage({ from: FROM, title: over.title ?? 'Деплой хаба', machine: over.machine ?? 'X1', id: MSG, ...(over.inReplyTo ? { inReplyTo: over.inReplyTo } : {}) }, text);

function show(s: SessionView, events: HubEvent[]) {
  useStore.setState({ runners: RUNNERS, models: [{ value: 'opus', displayName: 'Opus 5.5' }] });
  useStore.getState().upsertSessions([s]);
  useStore.setState({ logs: { [s.id]: { events, before: null, loaded: true, loading: false, error: null } } });
  return render(<Chat session={s} paneId="p1" />);
}

describe('buildChat: peer messages of hub sessions', () => {
  it('a wrapped user turn is a peer item with the sender, not a user message', () => {
    const items = buildChat([line('a', { type: 'user', uuid: 'u1', message: { content: wrapped('проверь миграцию\nи ответь') } })]);
    expect(items).toEqual([{ kind: 'peer', id: 'a', from: 'Деплой хаба', text: 'проверь миграцию\nи ответь', session: { id: FROM, title: 'Деплой хаба', machine: 'X1' } }]);
  });

  it('the same inside content blocks (the CLI writes text blocks) and in-reply-to is kept', () => {
    const items = buildChat([line('a', { type: 'user', message: { content: [{ type: 'text', text: wrapped('готово', { inReplyTo: MSG }) }] } })]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'peer', text: 'готово', session: { id: FROM, inReplyTo: MSG } });
  });

  it('a user text that only mentions the tag stays the user message', () => {
    const items = buildChat([line('a', { type: 'user', message: { content: `как выглядит ${wrapped('x')} в логе?` } })]);
    expect(items[0]).toMatchObject({ kind: 'user' });
  });
});

describe('the card in the chat', () => {
  beforeEach(resetStore);

  it('shows the sender with its machine, the text, and no user bubble', () => {
    show(session(), [line('a', { type: 'user', message: { content: wrapped('привет с **X1**') } })]);
    expect(screen.getByText(/От сессии/)).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Деплой хаба' });
    expect(link.getAttribute('href')).toBe(`/s/${FROM}`);
    expect(screen.getByText(/· X1/)).toBeTruthy();
    expect(document.querySelector('.msg.peer .bubble')?.textContent).toContain('привет с');
    expect(document.querySelector('.msg.user')).toBeNull();
  });

  it('a click on the sender opens its session instead of navigating', () => {
    show(session(), [line('a', { type: 'user', message: { content: wrapped('x') } })]);
    const link = screen.getByRole('link', { name: 'Деплой хаба' });
    const notPrevented = fireEvent.click(link);
    expect(notPrevented).toBe(false);
    expect(useStore.getState().inChat).toBe(true);
  });
});
