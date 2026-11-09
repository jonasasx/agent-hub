// Change web-push-notifications, QA: the message of the service worker to the page (requirement «Переход по тапу»).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPEN_SESSION_MESSAGE, listenSwMessages, openSessionId } from './swMessages';

const SID = '11111111-2222-4333-8444-555555555555';

describe('openSessionId', () => {
  it('takes the id of an open-session message', () => {
    expect(openSessionId({ type: OPEN_SESSION_MESSAGE, sessionId: SID })).toBe(SID);
  });

  it.each([
    null,
    undefined,
    'x',
    5,
    {},
    { type: 'other', sessionId: SID },
    { type: OPEN_SESSION_MESSAGE },
    { type: OPEN_SESSION_MESSAGE, sessionId: 7 },
    { type: OPEN_SESSION_MESSAGE, sessionId: '../etc' },
  ])('ignores %j', data => {
    expect(openSessionId(data)).toBeNull();
  });
});

describe('listenSwMessages', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('without a service worker does nothing and returns a no-op', () => {
    vi.stubGlobal('navigator', {});
    expect(listenSwMessages(() => undefined)()).toBeUndefined();
  });

  it('calls back for valid messages only and stops after the unsubscribe', () => {
    const handlers = new Set<(e: MessageEvent) => void>();
    vi.stubGlobal('navigator', {
      serviceWorker: {
        addEventListener: (_: string, h: (e: MessageEvent) => void) => handlers.add(h),
        removeEventListener: (_: string, h: (e: MessageEvent) => void) => handlers.delete(h),
      },
    });
    const seen: string[] = [];
    const stop = listenSwMessages(id => seen.push(id));
    handlers.forEach(h => h({ data: { type: OPEN_SESSION_MESSAGE, sessionId: 'bad' } } as MessageEvent));
    handlers.forEach(h => h({ data: { type: OPEN_SESSION_MESSAGE, sessionId: SID } } as MessageEvent));
    expect(seen).toEqual([SID]);
    stop();
    expect(handlers.size).toBe(0);
  });
});
