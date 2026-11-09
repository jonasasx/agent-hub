// push-voice-fixes D1: Android reports «hidden» seconds after the app is minimized, so the presence says how long ago it was.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../store';
import { resetStore, session } from '../../test/factories';
import { emptyWorkspace } from '../layout/layout';
import { attachSocket, noteHidden, noteShown, syncSocket } from './actions';

type Presence = { type: 'presence'; visible: boolean; activeSessionIds: string[]; hiddenForMs?: number };

describe('presence of a hidden tab', () => {
  let sent: unknown[];
  let state: DocumentVisibilityState;

  beforeEach(() => {
    resetStore();
    vi.useFakeTimers({ now: 1_000_000 });
    state = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => state);
    const a = session({ title: 'A' });
    useStore.setState({ ws: emptyWorkspace([a.id]) });
    useStore.getState().upsertSessions([a]);
    sent = [];
    attachSocket({ send: m => sent.push(m), close: () => undefined });
    syncSocket(true);
  });
  afterEach(() => {
    attachSocket(null);
    noteShown();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const lastPresence = () => sent.filter((m): m is Presence => (m as Presence).type === 'presence').at(-1)!;

  it('counts the hiding from the loss of focus', () => {
    noteHidden();
    vi.advanceTimersByTime(4_000);
    state = 'hidden';
    syncSocket();
    expect(lastPresence()).toEqual({ type: 'presence', visible: false, activeSessionIds: [], hiddenForMs: 4_000 });
  });

  it('a visible tab sends no hiddenForMs and a regained focus resets the count', () => {
    expect(lastPresence()).toEqual({ type: 'presence', visible: true, activeSessionIds: [expect.any(String)] });
    noteHidden();
    vi.advanceTimersByTime(4_000);
    noteShown();
    vi.advanceTimersByTime(2_000);
    state = 'hidden';
    syncSocket();
    expect(lastPresence().hiddenForMs).toBe(0);
  });

  it('caps the count at ten minutes', () => {
    noteHidden();
    vi.advanceTimersByTime(3_600_000);
    state = 'hidden';
    syncSocket();
    expect(lastPresence().hiddenForMs).toBe(600_000);
  });
});
