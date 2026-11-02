// change client-versions D2: own SW registration, waiting for the new SW, the loop guard.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildInfo } from './buildInfo';
import { applyUpdate, autoReloadBlocked, nav, readRecord, registerSw, resetSwForTests, STORAGE_KEY, SW_WAIT_MS } from './sw';

const A: BuildInfo = { version: '0.1.0', commit: 'aaaaaaa', builtAt: '2026-10-28T04:00:00Z' };
const B: BuildInfo = { version: '0.1.0', commit: 'bbbbbbb', builtAt: '2026-10-28T05:00:00Z' };
const C: BuildInfo = { version: '0.1.0', commit: 'ccccccc', builtAt: '2026-10-28T06:00:00Z' };

/** A SW: `postMessage` records messages; `install()` moves it from installing to installed (statechange). */
class FakeWorker extends EventTarget {
  state: ServiceWorkerState = 'installing';
  postMessage = vi.fn();
  install() {
    this.state = 'installed';
    this.dispatchEvent(new Event('statechange'));
  }
}

/** A SW container: `deploy()` puts a new build on the server, `update()` then starts installing it, `takeControl()`
 * activates it (skipWaiting + clientsClaim). */
class FakeSw extends EventTarget {
  private newOnServer = false;
  reg = {
    installing: null as FakeWorker | null,
    waiting: null as FakeWorker | null,
    update: vi.fn(async () => {
      if (this.newOnServer) {
        this.newOnServer = false;
        this.reg.installing = new FakeWorker();
      }
    }),
    unregister: vi.fn(async () => true),
  };
  register = vi.fn(async () => this.reg as unknown as ServiceWorkerRegistration);
  deploy() {
    this.newOnServer = true;
  }
  /** The installing SW finished installing and waits (a SW built without skipWaiting on install). */
  installed() {
    const w = this.reg.installing!;
    this.reg.installing = null;
    this.reg.waiting = w;
    w.install();
  }
  takeControl() {
    this.newOnServer = false;
    this.reg.installing = null;
    this.reg.waiting = null;
    this.dispatchEvent(new Event('controllerchange'));
  }
}

let reload: ReturnType<typeof vi.fn>;
const realReload = nav.reload;

beforeEach(() => {
  vi.useFakeTimers();
  resetSwForTests();
  reload = vi.fn();
  nav.reload = reload as unknown as () => void;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  nav.reload = realReload;
  Reflect.deleteProperty(navigator, 'serviceWorker');
});

function installSw(): FakeSw {
  const sw = new FakeSw();
  Object.defineProperty(navigator, 'serviceWorker', { value: sw, configurable: true });
  return sw;
}

describe('sw', () => {
  it('registers /sw.js with scope /', async () => {
    const sw = installSw();
    await registerSw();
    expect(sw.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });

  it('no SW (dev, private mode) — reloads at once and remembers the target', async () => {
    await expect(applyUpdate(B)).resolves.toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(readRecord().reloadTo).toBe('bbbbbbb');
  });

  it('the new SW installs after update() — reloads right after controllerchange', async () => {
    const sw = installSw();
    await registerSw();
    sw.deploy();
    const p = applyUpdate(B);
    await vi.advanceTimersByTimeAsync(1000);
    expect(reload).not.toHaveBeenCalled();
    expect(sw.reg.update).toHaveBeenCalled();
    sw.takeControl();
    await p;
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('two builds without a reload (B took control, then C) — waits for the SW of C, not the earlier change', async () => {
    const sw = installSw();
    await registerSw();
    sw.deploy();
    sw.takeControl(); // the SW of B took control, the window stayed on A («Позже» or a draft)
    sw.deploy();
    await sw.reg.update(); // checkSw() on finding C: the SW of C is installing
    const p = applyUpdate(C, { auto: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(reload).not.toHaveBeenCalled();
    sw.takeControl();
    await p;
    expect(reload).toHaveBeenCalledTimes(1);
    expect(readRecord().reloadTo).toBe('ccccccc');
  });

  it('first load with clientsClaim, then a deploy — waits for the new SW', async () => {
    const sw = installSw();
    await registerSw();
    sw.takeControl(); // the first SW claims the page
    sw.deploy();
    const p = applyUpdate(B);
    await vi.advanceTimersByTimeAsync(1000);
    expect(reload).not.toHaveBeenCalled();
    sw.takeControl();
    await p;
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a SW of an earlier build waits (built without skipWaiting), nothing newer — tells it SKIP_WAITING, reloads on control', async () => {
    const sw = installSw();
    await registerSw();
    sw.deploy();
    await sw.reg.update();
    sw.installed(); // old SW: stays waiting until told
    const waiting = sw.reg.waiting!;
    waiting.postMessage.mockImplementation(() => queueMicrotask(() => sw.takeControl()));
    const p = applyUpdate(B, { auto: true });
    await vi.advanceTimersByTimeAsync(0);
    await p;
    expect(sw.reg.update).toHaveBeenCalledTimes(2);
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sw.reg.unregister).not.toHaveBeenCalled();
  });

  it('a stale waiting SW and a newer build on the server — update() runs, the stale one is not told, the newer one is once installed', async () => {
    const sw = installSw();
    await registerSw();
    sw.deploy();
    await sw.reg.update();
    sw.installed(); // the SW of B waits since the previous deploy
    const stale = sw.reg.waiting!;
    sw.deploy(); // C on the server
    const p = applyUpdate(C);
    await vi.advanceTimersByTimeAsync(0);
    const fresh = sw.reg.installing!;
    expect(fresh).not.toBeNull();
    expect(stale.postMessage).not.toHaveBeenCalled();
    fresh.postMessage.mockImplementation(() => queueMicrotask(() => sw.takeControl()));
    sw.installed();
    await vi.advanceTimersByTimeAsync(0);
    await p;
    expect(fresh.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(stale.postMessage).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(readRecord().reloadTo).toBe('ccccccc');
  });

  it('a waiting SW and update() fails — still tells the waiting one and waits for it', async () => {
    const sw = installSw();
    await registerSw();
    sw.deploy();
    await sw.reg.update();
    sw.installed();
    sw.reg.update.mockRejectedValueOnce(new Error('offline'));
    const waiting = sw.reg.waiting!;
    const p = applyUpdate(B, { auto: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(reload).not.toHaveBeenCalled();
    sw.takeControl();
    await expect(p).resolves.toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('the active SW is already the latest (update() finds nothing) — reloads at once', async () => {
    const sw = installSw();
    await registerSw();
    await applyUpdate(B);
    expect(sw.reg.update).toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('the new SW takes control during update() — reloads without waiting 20 s', async () => {
    const sw = installSw();
    await registerSw();
    sw.reg.update.mockImplementationOnce(async () => sw.takeControl());
    const p = applyUpdate(B);
    await vi.advanceTimersByTimeAsync(0);
    await p;
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('started before the registration finished (hidden start) — waits for it, then for the new SW', async () => {
    const sw = installSw();
    let finish!: (r: ServiceWorkerRegistration) => void;
    sw.register.mockImplementationOnce(() => new Promise<ServiceWorkerRegistration>(r => (finish = r)));
    void registerSw();
    sw.deploy();
    const p = applyUpdate(B, { auto: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(reload).not.toHaveBeenCalled();
    finish(sw.reg as unknown as ServiceWorkerRegistration);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sw.reg.update).toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    sw.takeControl();
    await p;
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('the registration never finishes — reloads after 20 s', async () => {
    const sw = installSw();
    sw.register.mockImplementationOnce(() => new Promise<ServiceWorkerRegistration>(() => undefined));
    void registerSw();
    const p = applyUpdate(B);
    await vi.advanceTimersByTimeAsync(SW_WAIT_MS - 1);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('timeout of 20 s — reloads anyway', async () => {
    const sw = installSw();
    await registerSw();
    sw.deploy();
    const p = applyUpdate(B);
    await vi.advanceTimersByTimeAsync(SW_WAIT_MS - 1);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sw.reg.unregister).not.toHaveBeenCalled();
  });

  it('«Обновить» again to the same build after a timeout (the page reloaded) — unregisters the SW, then reloads', async () => {
    const sw = installSw();
    await registerSw();
    sw.deploy();
    const p = applyUpdate(B);
    await vi.advanceTimersByTimeAsync(SW_WAIT_MS);
    await p;
    resetSwForTests(); // the reload: a new page, the record stays in sessionStorage
    await registerSw();
    await applyUpdate(B);
    expect(sw.reg.unregister).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(2);
    const pc = applyUpdate(C); // another build: waits for its SW as usual
    await vi.advanceTimersByTimeAsync(SW_WAIT_MS);
    await pc;
    expect(sw.reg.unregister).toHaveBeenCalledTimes(1);
  });

  it('update() hangs — one deadline of 20 s for all of it, then reloads', async () => {
    const sw = installSw();
    await registerSw();
    sw.reg.update.mockImplementationOnce(() => new Promise<undefined>(() => undefined));
    const p = applyUpdate(B);
    await vi.advanceTimersByTimeAsync(SW_WAIT_MS - 1);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('update() fails on the automatic path — no reload and no record, the next check repeats it', async () => {
    const sw = installSw();
    await registerSw();
    sw.reg.update.mockRejectedValueOnce(new Error('offline'));
    await expect(applyUpdate(B, { auto: true })).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(readRecord().reloadTo).toBeUndefined();
    expect(autoReloadBlocked(B, A)).toBe(false);
  });

  it('update() fails on «Обновить» — reloads (the user asked)', async () => {
    const sw = installSw();
    await registerSw();
    sw.reg.update.mockRejectedValueOnce(new Error('offline'));
    await expect(applyUpdate(B)).resolves.toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('timeout with a failed guard, then an automatic retry — the registration stays', async () => {
    const sw = installSw();
    await registerSw();
    sw.deploy();
    const p = applyUpdate(B, { auto: true, guard: () => false });
    await vi.advanceTimersByTimeAsync(SW_WAIT_MS);
    await expect(p).resolves.toBe(false);
    expect(readRecord().timedOut).toBe('bbbbbbb');
    const p2 = applyUpdate(B, { auto: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(sw.reg.unregister).not.toHaveBeenCalled();
    sw.takeControl();
    await p2;
    expect(sw.reg.unregister).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('«Обновить» during a silent wait — both wait for the new SW, the page reloads once', async () => {
    const sw = installSw();
    await registerSw();
    sw.deploy();
    let hidden = true;
    const silent = applyUpdate(B, { auto: true, guard: () => hidden });
    await vi.advanceTimersByTimeAsync(1000);
    hidden = false; // the window was shown, the user clicks «Обновить»
    const manual = applyUpdate(B);
    await vi.advanceTimersByTimeAsync(1000);
    expect(reload).not.toHaveBeenCalled();
    sw.takeControl();
    await expect(silent).resolves.toBe(false);
    await expect(manual).resolves.toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('two calls that both may reload — nav.reload() runs once', async () => {
    const sw = installSw();
    await registerSw();
    sw.deploy();
    const p1 = applyUpdate(B, { auto: true });
    const p2 = applyUpdate(B);
    await vi.advanceTimersByTimeAsync(1000);
    sw.takeControl();
    await Promise.all([p1, p2]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a guard that fails at the moment of reload (the window was shown) — no reload, no record', async () => {
    await expect(applyUpdate(B, { auto: true, guard: () => false })).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('loaded again on the old build after a reload to B — automatic reload to B is forbidden, to C allowed', () => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ reloadTo: 'bbbbbbb' }));
    expect(autoReloadBlocked(B, A)).toBe(true);
    expect(autoReloadBlocked({ ...B, commit: 'ccccccc' }, A)).toBe(false);
  });

  it('one automatic reload per build in this page even without storage', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    await applyUpdate(B, { auto: true });
    expect(autoReloadBlocked(B, A)).toBe(true);
  });

  it('the same build as the client is never a reload target', () => {
    expect(autoReloadBlocked(A, A)).toBe(true);
  });
});
