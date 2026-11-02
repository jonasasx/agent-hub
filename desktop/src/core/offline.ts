/** «Нет связи» detection (design D14). Requirement: Экран «Нет связи». */

/** Chromium net error codes of `did-fail-load` that mean «hub unreachable». */
export const OFFLINE_ERROR_CODES: ReadonlySet<number> = new Set([
  -105, // NAME_NOT_RESOLVED
  -102, // CONNECTION_REFUSED
  -118, // CONNECTION_TIMED_OUT
  -106, // INTERNET_DISCONNECTED
  -109, // ADDRESS_UNREACHABLE
  -7, // TIMED_OUT
  -21, // NETWORK_CHANGED
  -137, // NAME_RESOLUTION_FAILED (DNS of the VPN zone is down)
  -101, // CONNECTION_RESET
  -100, // CONNECTION_CLOSED
  -324, // EMPTY_RESPONSE
]);

export function isOfflineLoadError(errorCode: number): boolean {
  return OFFLINE_ERROR_CODES.has(errorCode);
}

/** HTTP status of the main frame that means the hub is down behind the proxy. */
export function isOfflineHttpStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

export const HEALTH_POLL_MS = 10_000;
export const HEALTH_TIMEOUT_MS = 5_000;

/**
 * The hub web registers a service worker (workbox), so with the hub down the window still loads the page from the
 * cache: `did-fail-load` never fires and the web shows its own «Хаб недоступен» (B2 of QA). The service worker is left
 * alone (web unchanged); the app decides by the hub connection instead (design D14):
 * - the socket is offline and `/healthz` fails → show the app's «Нет связи» over a hub page;
 * - the connection is back → return from «Нет связи», or reload a hub page that was loaded during the outage.
 */
export interface WindowOutageView {
  /** The window shows the app's «Нет связи». */
  offlineScreen: boolean;
  /** The window shows a page of the hub origin (not a sign-in or error screen of the app). */
  onHubPage: boolean;
  /** The current hub page finished loading while the hub was unreachable (served from the service worker cache). */
  loadedDuringOutage: boolean;
}

export function actionOnHubUnreachable(w: WindowOutageView): 'show_offline' | 'none' {
  return !w.offlineScreen && w.onHubPage ? 'show_offline' : 'none';
}

export function actionOnHubBack(w: WindowOutageView): 'return' | 'reload' | 'none' {
  if (w.offlineScreen) return 'return';
  return w.onHubPage && w.loadedDuringOutage ? 'reload' : 'none';
}
