/**
 * Detection of a new build (design D1, D3): `/version.json?t=` past every cache, compared with the embedded build — at
 * start, on `visibilitychange → visible` and `focus` (5 s debounce), every 10 minutes and on `online`. A failed
 * request changes nothing. A new build found while hidden, or hiding with a new build known, tries a silent reload (D4).
 */
import { create } from 'zustand';
import { buildKey, isBuildInfo, sameBuild, type BuildInfo } from './buildInfo';
import { CLIENT_BUILD } from './currentBuild';
import { canReloadSilently, hasUnsavedInput } from './silent';
import { applyUpdate, autoReloadBlocked, checkSw, readRecord, registerSw, writeRecord } from './sw';

export const DEBOUNCE_MS = 5_000;
export const INTERVAL_MS = 10 * 60_000;

interface UpdateState {
  client: BuildInfo;
  /** The hub's build, last known; null — not received yet. */
  hub: BuildInfo | null;
  /** The hub's build differs from this client's. */
  available: boolean;
  /** «Позже» for the hub's current build. */
  dismissed: boolean;
}

export const useUpdate = create<UpdateState>()(() => ({ client: CLIENT_BUILD, hub: null, available: false, dismissed: false }));

let lastCheck = -Infinity;
let inflight: Promise<void> | null = null;

/** One request of `/version.json`; errors and malformed answers leave the state as it was (D1, spec «Хаб недоступен»). */
export function checkNow(): Promise<void> {
  if (inflight) return inflight;
  lastCheck = Date.now();
  inflight = (async () => {
    try {
      const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok) return;
      const body: unknown = await res.json();
      if (!isBuildInfo(body)) return;
      const { client } = useUpdate.getState();
      const available = !sameBuild(body, client);
      useUpdate.setState({ hub: body, available, dismissed: available && readRecord().later === buildKey(body) });
      if (available) {
        void checkSw();
        if (document.visibilityState === 'hidden') trySilent();
      }
    } catch {
      // network error: the next trigger repeats the check
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** focus / visible: at most one request per 5 s. */
function debounced(): void {
  if (Date.now() - lastCheck < DEBOUNCE_MS) return;
  void checkNow();
}

/** A silent reload onto the known new build if the window is hidden and nothing would be lost (D4). */
export function trySilent(): boolean {
  const { hub, client, available } = useUpdate.getState();
  if (!available || !hub || autoReloadBlocked(hub, client) || !canReloadSilently()) return false;
  void applyUpdate(hub, { auto: true, guard: canReloadSilently });
  return true;
}

/** «Обновить» of the banner and the profile menu: confirmation when input would be lost (D5). */
export function requestUpdate(): boolean {
  const { hub } = useUpdate.getState();
  if (!hub) return false;
  if (hasUnsavedInput() && !window.confirm('Черновик пропадёт. Обновить сейчас?')) return false;
  void applyUpdate(hub);
  return true;
}

/** «Позже»: the banner hides until the next build (the menu item stays). */
export function dismissUpdate(): void {
  const { hub } = useUpdate.getState();
  if (!hub) return;
  writeRecord({ later: buildKey(hub) });
  useUpdate.setState({ dismissed: true });
}

/** Starts the SW and the checks once, after the first render (design D3). Returns the stop function (tests). */
export function startUpdates(opts: { sw?: boolean } = {}): () => void {
  // the dev server has no /sw.js (vite-plugin-pwa devOptions are off)
  if (opts.sw ?? import.meta.env.PROD) void registerSw();
  const onVisibility = () => {
    if (document.visibilityState === 'visible') debounced();
    else trySilent();
  };
  const onOnline = () => void checkNow();
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', debounced);
  window.addEventListener('online', onOnline);
  const timer = setInterval(() => void checkNow(), INTERVAL_MS);
  void checkNow();
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', debounced);
    window.removeEventListener('online', onOnline);
    clearInterval(timer);
  };
}

/** Tests: a fresh state with the given client build. */
export function resetUpdateForTests(client: BuildInfo = CLIENT_BUILD): void {
  lastCheck = -Infinity;
  inflight = null;
  useUpdate.setState({ client, hub: null, available: false, dismissed: false });
}
