// change client-versions D1/D3: /version.json checks, triggers, debounce, errors without a banner, silent reload hook.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildInfo } from './buildInfo';
import { checkNow, dismissUpdate, INTERVAL_MS, requestUpdate, resetUpdateForTests, startUpdates, trySilent, useUpdate } from './check';
import { nav, readRecord, resetSwForTests, STORAGE_KEY } from './sw';
import { useStore } from '../../store';
import { resetStore } from '../../test/factories';

const A: BuildInfo = { version: '0.1.0', commit: 'aaaaaaa', builtAt: '2026-10-28T04:00:00Z' };
const B: BuildInfo = { version: '0.1.0', commit: 'bbbbbbb', builtAt: '2026-10-28T05:00:00Z' };

let answer: () => Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn>;
let reload: ReturnType<typeof vi.fn>;
let stop: (() => void) | null = null;
const realReload = nav.reload;
const json =
  (b: unknown, status = 200) =>
  async () =>
    new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

function setVisibility(v: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: v, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers();
  resetStore();
  resetSwForTests();
  resetUpdateForTests(A);
  answer = json(A);
  fetchMock = vi.fn((..._args: unknown[]) => answer());
  vi.stubGlobal('fetch', fetchMock);
  reload = vi.fn();
  nav.reload = reload as unknown as () => void;
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});
afterEach(() => {
  stop?.();
  stop = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  nav.reload = realReload;
  Reflect.deleteProperty(document, 'visibilityState');
});

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('checkNow', () => {
  it('asks /version.json?t= past the HTTP cache', async () => {
    await checkNow();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/^\/version\.json\?t=\d+$/);
    expect(init.cache).toBe('no-store');
    expect(useUpdate.getState()).toMatchObject({ hub: A, available: false });
  });

  it('another commit on the hub — available', async () => {
    answer = json(B);
    await checkNow();
    expect(useUpdate.getState()).toMatchObject({ hub: B, available: true, dismissed: false });
  });

  it('5xx, a network error and a malformed answer change nothing (spec «Хаб недоступен»)', async () => {
    answer = json(B);
    await checkNow();
    for (const bad of [json({ error: 'x' }, 503), async () => Promise.reject(new TypeError('Failed to fetch')), json({ commit: 'zz' }), async () => new Response('<html>', { status: 200 })]) {
      answer = bad as () => Promise<Response>;
      await checkNow();
      expect(useUpdate.getState()).toMatchObject({ hub: B, available: true });
    }
    resetUpdateForTests(A);
    answer = json({}, 500);
    await checkNow();
    expect(useUpdate.getState()).toMatchObject({ hub: null, available: false });
    expect(reload).not.toHaveBeenCalled();
  });

  it('dev builds are compared by builtAt', async () => {
    const dev: BuildInfo = { version: '0.1.0', commit: 'dev', builtAt: '2026-10-28T04:00:00Z' };
    resetUpdateForTests(dev);
    answer = json(dev);
    await checkNow();
    expect(useUpdate.getState().available).toBe(false);
    answer = json({ ...dev, builtAt: '2026-10-28T04:05:00Z' });
    await checkNow();
    expect(useUpdate.getState().available).toBe(true);
  });
});

describe('triggers (design D3)', () => {
  it('start, visible, focus with a 5 s debounce, every 10 minutes, online', async () => {
    stop = startUpdates({ sw: false });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1); // start
    window.dispatchEvent(new Event('focus'));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1); // debounced: < 5 s after the start
    await vi.advanceTimersByTimeAsync(5_000);
    window.dispatchEvent(new Event('focus'));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    setVisibility('visible');
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2); // debounced again
    await vi.advanceTimersByTimeAsync(5_000);
    setVisibility('visible');
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    window.dispatchEvent(new Event('online'));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(4); // online is not debounced
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('«Окно в фокусе без переключений»: a new build is found within 10 minutes', async () => {
    stop = startUpdates({ sw: false });
    await flush();
    answer = json(B);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(useUpdate.getState().available).toBe(true);
  });
});

describe('silent reload hooks (design D4)', () => {
  it('a new build found while hidden and nothing to lose — reloads', async () => {
    stop = startUpdates({ sw: false });
    await flush();
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    answer = json(B);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a visible window never reloads by itself', async () => {
    stop = startUpdates({ sw: false });
    answer = json(B);
    await flush();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(useUpdate.getState().available).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });

  it('hiding with a known new build reloads; with a draft — not', async () => {
    answer = json(B);
    stop = startUpdates({ sw: false });
    await flush();
    useStore.setState({ drafts: { s1: 'недописано' } });
    setVisibility('hidden');
    await flush();
    expect(reload).not.toHaveBeenCalled();
    useStore.setState({ drafts: { s1: '  ' } });
    setVisibility('visible');
    setVisibility('hidden');
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('no loop: back on the old build after a reload to B — no automatic reload, the banner stays', async () => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ reloadTo: 'bbbbbbb' }));
    answer = json(B);
    await checkNow();
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    expect(trySilent()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(useUpdate.getState()).toMatchObject({ available: true, dismissed: false });
  });
});

describe('«Обновить» and «Позже»', () => {
  it('«Обновить» without input reloads onto the hub build', async () => {
    answer = json(B);
    await checkNow();
    expect(requestUpdate()).toBe(true);
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(readRecord().reloadTo).toBe('bbbbbbb');
  });

  it('with a draft asks first; refusing does not reload', async () => {
    answer = json(B);
    await checkNow();
    useStore.setState({ drafts: { s1: 'текст' } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    expect(requestUpdate()).toBe(false);
    expect(confirm).toHaveBeenCalledWith('Черновик пропадёт. Обновить сейчас?');
    await flush();
    expect(reload).not.toHaveBeenCalled();
  });

  it('«Позже» hides until the next build', async () => {
    answer = json(B);
    await checkNow();
    dismissUpdate();
    expect(useUpdate.getState().dismissed).toBe(true);
    await checkNow();
    expect(useUpdate.getState().dismissed).toBe(true);
    answer = json({ ...B, commit: 'ccccccc' });
    await checkNow();
    expect(useUpdate.getState()).toMatchObject({ available: true, dismissed: false });
  });
});
