// Change i18n, design D8: the language of the profile is read from /api/me on connect and on a poll while online.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Locale } from '@agent-hub/shared';
import { HubClient, LOCALE_POLL_MS, type HubClientDeps } from './hubClient.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('HubClient language', () => {
  it('reports me.locale after the seed and again when it changes in the web', async () => {
    let me: { locale: Locale | null } = { locale: 'de' };
    const got: (Locale | null)[] = [];
    const sockets: { h: Parameters<HubClientDeps['openSocket']>[2] }[] = [];
    const deps: HubClientDeps = {
      hubUrl: 'https://hub.example.com',
      userAgent: 'AgentHubDesktop/0.1.0',
      getCookie: async () => 'tok',
      openSocket: (_u, _h, h) => {
        sockets.push({ h });
        return { send: () => undefined, close: () => undefined };
      },
      fetch: async url => ({ status: 200, json: async () => (url.endsWith('/api/me') ? me : { now: [], projects: [], runners: [] }) }),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: t => clearTimeout(t as ReturnType<typeof setTimeout>),
      onState: () => undefined,
      onSeed: () => undefined,
      onMessage: () => false,
      onLocale: l => got.push(l),
    };
    const client = new HubClient(deps);
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.h.onOpen();
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toEqual(['de']);
    me = { locale: null };
    await vi.advanceTimersByTimeAsync(LOCALE_POLL_MS + 10);
    expect(got).toEqual(['de', null]);
    client.stop();
  });
});
