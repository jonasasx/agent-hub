// Component tests of links to sessions (change session-links). Requirement (session-links): Ссылки на сессии.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SessionRefView } from '@agent-hub/shared';
import type { HubEvent, SessionView } from '../../api/types';
import { useStore } from '../../store';
import { RUNNERS, resetStore, session } from '../../test/factories';
import { allTabs } from '../layout/layout';
import { resetSessionRefs } from '../sessions/sessionLinks';
import { Chat } from './Chat';

const CLAUDE = '5f8ed526-b9a8-4aae-aef5-44a16ab8a693';
const TARGET = '0f0e0d0c-0b0a-4000-8000-000000000001';
const UNKNOWN = '11111111-1111-4111-8111-111111111111';

const answer = (text: string): HubEvent[] => [{ kind: 'line', id: 'a1', ts: '', line: { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text }] } } }];

function show(s: SessionView, text: string) {
  useStore.setState({ runners: RUNNERS, models: [{ value: 'opus', displayName: 'Opus 5.5' }] });
  useStore.getState().upsertSessions([s]);
  useStore.setState({ logs: { [s.id]: { events: answer(text), before: null, loaded: true, loading: false, error: null } } });
  return render(<Chat session={s} paneId="p1" />);
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** The hub knows CLAUDE and TARGET as one session «Причина падения»; every other UUID is unknown. */
function hub(target: SessionView) {
  const resolve = vi.fn((ids: string[]) => ({
    sessions: ids.filter(id => id === CLAUDE || id === TARGET).map((ref): SessionRefView => ({ ref, id: TARGET, title: 'Причина падения', runnerName: 'HP' })),
  }));
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/sessions/resolve') return ok(resolve((JSON.parse(String(init?.body)) as { ids: string[] }).ids));
    if (url === `/api/sessions/${TARGET}`) return ok(target);
    if (url.startsWith(`/api/sessions/${TARGET}/events`)) return ok({ events: [], before: null });
    return ok({});
  });
  vi.stubGlobal('fetch', fetch);
  return resolve;
}

const tabs = () => allTabs(useStore.getState().ws);

describe('links to sessions in the feed', () => {
  beforeEach(() => {
    resetStore();
    resetSessionRefs();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('a Claude Code id in inline code becomes a link titled by the session; a click opens its tab', async () => {
    hub(session({ id: TARGET, title: 'Причина падения', runnerId: 'hp' }));
    show(session(), `Сессия \`${CLAUDE}\` на HP.`);
    const link = await screen.findByRole('link', { name: /Причина падения/ });
    expect(link).toHaveAttribute('title', `HP · ${CLAUDE}`);
    expect(link).toHaveAttribute('href', `/s/${TARGET}`);
    await userEvent.click(link);
    await vi.waitFor(() => expect(tabs()).toContain(TARGET));
  });

  it('the label follows a rename of the session in the store', async () => {
    hub(session({ id: TARGET, title: 'Причина падения', runnerId: 'hp' }));
    show(session(), `См. ${TARGET}`);
    await screen.findByRole('link', { name: /Причина падения/ });
    useStore.getState().upsertSessions([session({ id: TARGET, title: 'Новое имя', runnerId: 'hp' })]);
    expect(await screen.findByRole('link', { name: /Новое имя/ })).toBeInTheDocument();
  });

  it('several UUIDs go to the hub in one request; an unknown UUID stays text', async () => {
    const resolve = hub(session({ id: TARGET, runnerId: 'hp' }));
    show(session(), `${CLAUDE} и ${UNKNOWN}`);
    await screen.findByRole('link', { name: /Причина падения/ });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]![0].sort()).toEqual([CLAUDE, UNKNOWN].sort());
    expect(screen.getByText(new RegExp(UNKNOWN))).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: new RegExp(UNKNOWN) })).toBeNull();
  });

  it('a UUID inside a code block is left alone', async () => {
    const resolve = hub(session({ id: TARGET, runnerId: 'hp' }));
    show(session(), '```\n' + CLAUDE + '\n```');
    await new Promise(r => setTimeout(r, 80));
    expect(resolve).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: /Причина падения/ })).toBeNull();
  });

  it('an explicit link to session:<uuid> shows the title of the session', async () => {
    hub(session({ id: TARGET, runnerId: 'hp' }));
    show(session(), `[вот эта](session:${CLAUDE})`);
    expect(await screen.findByRole('link', { name: /Причина падения/ })).toHaveAttribute('href', `/s/${TARGET}`);
  });
});
