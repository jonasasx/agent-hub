// Review B3: the hub sends session.events only to subscribed sessions (the ones on screen). A session that left the
// screen and came back must reload its chat, otherwise answers produced meanwhile are missing until a reload.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HubEvent } from '../../api/types';
import { useStore } from '../../store';
import { RUNNERS, mockFetch, resetStore, session } from '../../test/factories';
import { emptyWorkspace } from '../layout/layout';
import { attachSocket, ensureLog, refreshEvents, syncSocket, visibleSessionIds } from './actions';
import { Workspace } from './Workspace';

const note = (id: string, text: string): HubEvent => ({ kind: 'note', id, ts: '', text });
const user = (id: string, text: string): HubEvent => ({ kind: 'line', id, ts: '', line: { type: 'user', message: { role: 'user', content: text } } });
const answer = (id: string, text: string): HubEvent => ({ kind: 'line', id, ts: '', line: { type: 'assistant', message: { id: `m-${id}`, content: [{ type: 'text', text }] } } });

describe('refreshEvents', () => {
  it('keeps older known events before an overlapping newest page', () => {
    const cur = [note('a', '1'), note('b', '2'), note('c', '3')];
    const r = refreshEvents(cur, [note('b', '2'), note('c', '3!'), note('d', '4')]);
    expect(r.events.map(e => (e as { text: string }).text)).toEqual(['1', '2', '3!', '4']);
    expect(r.keepBefore).toBe(true);
  });
  it('replaces the log when more than a page was missed', () => {
    const r = refreshEvents([note('a', '1')], [note('x', '9')]);
    expect(r.events.map(e => e.id)).toEqual(['x']);
    expect(r.keepBefore).toBe(false);
  });
});

describe('a session coming back on screen reloads its chat', () => {
  beforeEach(resetStore);
  afterEach(() => {
    attachSocket(null);
    vi.unstubAllGlobals();
  });

  async function scenario(back: () => Promise<void> | void, leave: () => Promise<void> | void, subscribedAfterLeave: (b: string) => string[]) {
    const a = session({ title: 'A', status: 'working' });
    const b = session({ title: 'B' });
    useStore.setState({ runners: RUNNERS, ws: emptyWorkspace([a.id, b.id]) });
    useStore.getState().upsertSessions([a, b]);
    const hubEvents: Record<string, HubEvent[]> = { [a.id]: [user('a1', 'вопрос')], [b.id]: [] };
    const calls = mockFetch({
      '/api/sessions/': (_i, url) => ({ status: 200, body: { events: hubEvents[url!.split('/')[3]!] ?? [], before: null } }),
    });
    const sent: unknown[] = [];
    attachSocket({ send: m => sent.push(m), close: () => undefined });
    // what App does on every workspace change
    const unsub = useStore.subscribe((s, p) => {
      if (s.ws !== p.ws || s.inChat !== p.inChat || s.device !== p.device) {
        syncSocket();
        for (const id of visibleSessionIds()) ensureLog(id);
      }
    });
    syncSocket(true);
    ensureLog(a.id);
    render(<Workspace />);
    expect(await screen.findByText('вопрос')).toBeInTheDocument();
    await act(leave);
    expect(sent.filter(m => (m as { type: string }).type === 'subscribe').at(-1)).toEqual({ type: 'subscribe', sessionIds: subscribedAfterLeave(b.id), subagentIds: [] });
    // A answers while not subscribed: the hub does not send session.events to this client
    hubEvents[a.id] = [user('a1', 'вопрос'), answer('a2', 'ответ, пришедший без подписки')];
    await act(back);
    expect(await screen.findByText('ответ, пришедший без подписки')).toBeInTheDocument();
    expect(calls.filter(c => c.url.startsWith(`/api/sessions/${a.id}/events`))).toHaveLength(2);
    unsub();
  }

  it('desktop: switch to another tab and back', async () => {
    await scenario(
      () => userEvent.click(screen.getByRole('tab', { name: /^A/ })),
      () => userEvent.click(screen.getByRole('tab', { name: /^B/ })),
      b => [b],
    );
  });

  it('phone: «←» and open again', async () => {
    useStore.setState({ device: 'phone', inChat: true });
    await scenario(
      () => useStore.setState({ inChat: true }),
      () => useStore.setState({ inChat: false }),
      () => [],
    );
  });
});

describe('a session that leaves the screen while its first page is loading', () => {
  beforeEach(resetStore);
  afterEach(() => {
    attachSocket(null);
    vi.unstubAllGlobals();
  });

  async function run(backBeforeAnswer: boolean) {
    const a = session({ title: 'A', status: 'working' });
    const b = session({ title: 'B' });
    useStore.setState({ runners: RUNNERS, ws: emptyWorkspace([a.id, b.id]) });
    useStore.getState().upsertSessions([a, b]);
    // A's first page is held until released; it was built before A answered.
    let release!: () => void;
    const held = new Promise<void>(r => (release = r));
    let aCalls = 0;
    let hubA: HubEvent[] = [user('a1', 'вопрос')];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
        if (url.startsWith(`/api/sessions/${a.id}/events`)) {
          aCalls++;
          const snapshot = hubA;
          if (aCalls === 1) await held;
          return json({ events: snapshot, before: null });
        }
        if (url.startsWith('/api/sessions/')) return json({ events: [], before: null });
        return json({ tabs: [], evicted: null });
      }),
    );
    attachSocket({ send: () => undefined, close: () => undefined });
    const unsub = useStore.subscribe((s, p) => {
      if (s.ws !== p.ws) {
        syncSocket();
        for (const id of visibleSessionIds()) ensureLog(id);
      }
    });
    syncSocket(true);
    ensureLog(a.id);
    render(<Workspace />);
    await act(() => userEvent.click(screen.getByRole('tab', { name: /^B/ })));
    // A answers while off screen and unsubscribed.
    hubA = [user('a1', 'вопрос'), answer('a2', 'ответ во время загрузки')];
    if (backBeforeAnswer) {
      await act(() => userEvent.click(screen.getByRole('tab', { name: /^A/ })));
      await act(async () => release());
    } else {
      await act(async () => release());
      await act(() => userEvent.click(screen.getByRole('tab', { name: /^A/ })));
    }
    expect(await screen.findByText('ответ во время загрузки')).toBeInTheDocument();
    expect(aCalls).toBe(2);
    unsub();
  }

  it('comes back after the page arrived: the log is reloaded', async () => {
    await run(false);
  });

  it('comes back before the page arrived: the log is reloaded when it arrives', async () => {
    await run(true);
  });
});
