/**
 * Service worker of the shell, registered by the page itself (`injectRegister: false`, design D2): the generated SW calls
 * skipWaiting + clientsClaim itself (workbox options, `swLifecycle.ts`), the page decides when to reload. `applyUpdate()`
 * always asks `update()` first, then looks at the registration: a SW being installed or waiting — waits until it controls
 * the page (a waiting one, and an installing one once installed, also gets `{type:'SKIP_WAITING'}`: SWs of builds without
 * skipWaiting on install wait for that message), else the active SW is the latest one and the page reloads at once; one
 * deadline of 20 s for all of it. One automatic reload per target build (`sessionStorage['agenthub.update.v1']`).
 */
import { buildKey, type BuildInfo } from './buildInfo';

export const SW_WAIT_MS = 20_000;
export const STORAGE_KEY = 'agenthub.update.v1';

/**
 * What this tab remembers across reloads: the build of the last reload, the build put off by «Позже» and the build whose
 * wait for the new SW timed out (the next reload to it unregisters the SW).
 */
export interface UpdateRecord {
  reloadTo?: string;
  later?: string;
  timedOut?: string;
}

export function readRecord(): UpdateRecord {
  try {
    const v = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '{}') as unknown;
    return v && typeof v === 'object' ? (v as UpdateRecord) : {};
  } catch {
    return {};
  }
}

export function writeRecord(patch: UpdateRecord): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readRecord(), ...patch }));
  } catch {
    // private mode without storage: the guard lives in memory only (autoTried below)
  }
}

let registration: ServiceWorkerRegistration | null = null;
/** The registration in progress: `applyUpdate()` started before it finished waits for it (at most 20 s). */
let registering: Promise<ServiceWorkerRegistration | null> | null = null;
/** Targets whose wait for the new SW timed out (also in the record): the next reload to them drops the registration first. */
const timedOut = new Set<string>();
/** Targets reloaded to automatically in this page (the storage may be unavailable). */
const autoTried = new Set<string>();
/** The page is reloading already: a concurrent `applyUpdate()` does not reload again. */
let reloading = false;

/** Test seam: the page reloads through here. */
export const nav = { reload: () => location.reload() };

/** Registers `/sw.js` (scope `/`, the same registration as before the change is reused). No SW support — no-op. */
export async function registerSw(): Promise<void> {
  const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
  if (!sw) return;
  const p = sw.register('/sw.js', { scope: '/' }).then(
    r => (registration = r),
    () => (registration = null),
  );
  registering = p;
  await p;
}

/** Asks the SW to look for a new version (each check that found a new build, design D3). */
export async function checkSw(): Promise<void> {
  try {
    await registration?.update();
  } catch {
    // offline or the script is unreachable: the next check repeats it
  }
}

/** A reload to this build would repeat an automatic reload of this tab: only the banner then (D2). */
export function autoReloadBlocked(target: BuildInfo, client: BuildInfo): boolean {
  const key = buildKey(target);
  if (key === buildKey(client)) return true;
  return autoTried.has(key) || readRecord().reloadTo === key;
}

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise(resolve => setTimeout(() => resolve(value), ms));
}

/** The registration now, or the one being registered (at most `SW_WAIT_MS`); null — no SW. */
async function currentRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (registration || !registering) return registration;
  return Promise.race([registering, delay(SW_WAIT_MS, null)]);
}

/** A `controllerchange` after this call: `fired` and a promise of it; `stop()` removes the listener. */
function watchController(sw: ServiceWorkerContainer) {
  let resolve!: () => void;
  const w = { fired: false, changed: new Promise<void>(r => (resolve = r)), stop: () => sw.removeEventListener('controllerchange', on) };
  function on() {
    w.fired = true;
    resolve();
  }
  sw.addEventListener('controllerchange', on);
  return w;
}

/** How the wait for the SW of the new build ended. */
type SwWait = 'ready' | 'timeout' | 'updateFailed';

/**
 * Tells the SW that would take control next to skip waiting: the waiting one, or the installing one once installed (it
 * replaces the waiting one, so the waiting one is not told). SWs built before skipWaiting was on (f511613, 4f8b582) only
 * skip waiting on this message; the current ones skip by themselves and ignore it.
 */
function skipWaitingOfNewest(reg: ServiceWorkerRegistration): void {
  const tell = (w: ServiceWorker | null) => {
    try {
      w?.postMessage({ type: 'SKIP_WAITING' });
    } catch {
      // the worker became redundant meanwhile
    }
  };
  const inst = reg.installing;
  if (!inst) return tell(reg.waiting);
  const on = () => {
    if (inst.state === 'installed') tell(inst);
    if (inst.state !== 'installing') inst.removeEventListener('statechange', on);
  };
  inst.addEventListener('statechange', on);
}

/**
 * Waits for the newest SW of `reg` to control the page when there is one, all of it — `update()` included — within one
 * deadline of 20 s. `update()` runs even when a SW is waiting already: it may be the SW of an earlier build, and a newer
 * one replaces it. `ready` — the new SW controls the page or the active one is the latest; `timeout` — the deadline
 * passed; `updateFailed` — `update()` failed and nothing is being installed (offline, the script unreachable).
 */
async function waitNewSw(sw: ServiceWorkerContainer, reg: ServiceWorkerRegistration): Promise<SwWait> {
  const w = watchController(sw);
  const deadline = delay(SW_WAIT_MS, 'timeout' as const);
  const changed = w.changed.then(() => 'ready' as const);
  const pending = () => !!(reg.installing || reg.waiting);
  try {
    const r = await Promise.race([
      reg.update().then(
        () => 'updated' as const,
        () => 'failed' as const,
      ),
      changed,
      deadline,
    ]);
    if (w.fired) return 'ready';
    if (r === 'timeout') return 'timeout';
    if (!pending()) return r === 'failed' ? 'updateFailed' : 'ready'; // the active SW is the latest one
    skipWaitingOfNewest(reg);
    return await Promise.race([changed, deadline]);
  } finally {
    w.stop();
  }
}

/**
 * Reloads the page onto `target`: without a SW at once; with one — after the SW of the new build took control (or
 * 20 s). An automatic reload gives up when `update()` failed (the next check repeats it); a manual one to a target whose
 * wait timed out unregisters the SW first — a way out when it never takes control. `guard` is asked right before the
 * reload (a silent reload gives up when the window was shown or got input meanwhile). Concurrent calls (a click during
 * a silent wait) reload once. Returns whether the page reloads.
 */
export async function applyUpdate(target: BuildInfo, opts: { auto?: boolean; guard?: () => boolean } = {}): Promise<boolean> {
  const key = buildKey(target);
  const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
  const reg = sw ? await currentRegistration() : null;
  if (sw && reg) {
    if (!opts.auto && (timedOut.has(key) || readRecord().timedOut === key)) {
      try {
        await reg.unregister();
      } catch {
        // nothing more to try: the reload goes to the network or the old cache
      }
    } else {
      const r = await waitNewSw(sw, reg);
      if (r === 'updateFailed' && opts.auto) return false;
      if (r === 'timeout') {
        timedOut.add(key);
        writeRecord({ timedOut: key });
      }
    }
  }
  if (reloading) return true;
  if (opts.guard && !opts.guard()) return false;
  if (opts.auto) autoTried.add(key);
  writeRecord({ reloadTo: key });
  reloading = true;
  nav.reload();
  return true;
}

/** Tests: forget the registration and the guard of this page. */
export function resetSwForTests(reg: ServiceWorkerRegistration | null = null): void {
  registration = reg;
  registering = null;
  timedOut.clear();
  autoTried.clear();
  reloading = false;
}
