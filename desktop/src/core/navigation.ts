/**
 * Navigation policy of the window (design D3). Requirements: Навигация и внешние ссылки; Изоляция окна.
 * Used for `will-navigate`, `will-redirect` and `setWindowOpenHandler` (all initiated by the page; `loadURL`/`loadFile`
 * of the main process do not pass through it).
 */

export type NavigationDecision =
  | { kind: 'allow' }
  /** `<PUBLIC_URL>/auth/login?return=…` → sign-in through the system browser with this return path. */
  | { kind: 'login'; returnPath: string }
  | { kind: 'external'; url: string }
  | { kind: 'deny' };

/**
 * A return path inside the hub: only a path of its own origin (starting with a single `/`), never `/auth/*`
 * (the hub's `safeReturnPath` rule), otherwise `/`.
 */
export function safeReturnPath(value: string | null | undefined): string {
  if (!value || typeof value !== 'string' || value.length > 2048) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  let u: URL;
  try {
    u = new URL(value, 'http://x');
  } catch {
    return '/';
  }
  if (u.origin !== 'http://x') return '/';
  const path = u.pathname;
  if (path === '/auth' || path.startsWith('/auth/')) return '/';
  return `${path}${u.search}${u.hash}`;
}

export function decideNavigation(raw: string, publicOrigin: string): NavigationDecision {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { kind: 'deny' };
  }
  if (u.protocol === 'http:' || u.protocol === 'https:') {
    if (u.origin === publicOrigin) {
      if (u.pathname === '/auth/login') return { kind: 'login', returnPath: safeReturnPath(u.searchParams.get('return')) };
      return { kind: 'allow' };
    }
    return { kind: 'external', url: u.href };
  }
  // javascript:, data:, file: from the page, agenthub: (handled by the OS, not by the window), anything else.
  return { kind: 'deny' };
}

/**
 * «Открыть оригинал» of the lightbox (change image-viewer, D4): a stored image of the hub, `/api/blobs/<hex>` of its own
 * origin. It opens in a window of its own instead of replacing the app in the main window.
 */
export function isImageViewerUrl(raw: string, publicOrigin: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return u.origin === publicOrigin && /^\/api\/blobs\/[0-9a-f]+$/i.test(u.pathname);
}

/** Permissions the page may get (D2): everything else — including `notifications` — is refused. */
export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write', 'fullscreen']);

/** What Electron tells about a permission request (request handler) or check (check handler). */
export interface PermissionDetails {
  /** Request handler, `media`: the media types asked for (`audio`, `video`). */
  mediaTypes?: readonly string[];
  /** Check handler, `media`: the media type being checked (`audio`, `video`, `unknown`). */
  mediaType?: string;
  /** URL or origin of the asking page (`requestingUrl` / `requestingOrigin`). */
  requestingUrl?: string;
  /** Origin of the hub (PUBLIC_URL): only its pages may record sound. */
  hubOrigin?: string;
}

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Change voice-input (design D8, Requirement: Микрофон в десктоп-приложении): `media` only for sound alone
 * (`mediaTypes` ⊆ {audio}, non-empty, or `mediaType === 'audio'`) asked by a page of the hub's origin. Camera, screen
 * capture and anything else stays refused; the other permissions follow `ALLOWED_PERMISSIONS`.
 */
export function isPermissionAllowed(permission: string, details?: PermissionDetails): boolean {
  if (permission === 'media') {
    if (!details?.hubOrigin || originOf(details.requestingUrl) !== details.hubOrigin) return false;
    if (details.mediaTypes !== undefined) return details.mediaTypes.length > 0 && details.mediaTypes.every(t => t === 'audio');
    return details.mediaType === 'audio';
  }
  return ALLOWED_PERMISSIONS.has(permission);
}

/**
 * Check handler (`setPermissionCheckHandler`). Chromium also checks `media` without a type after the request was
 * granted, so for the hub's origin `media` passes when `mediaType` is not set or is `audio`; `video`, `unknown` and a
 * foreign origin stay refused. The capture itself is decided by the request handler (`isPermissionAllowed`: sound only).
 */
export function isPermissionCheckAllowed(permission: string, details?: Omit<PermissionDetails, 'mediaTypes'>): boolean {
  if (permission === 'media') {
    if (!details?.hubOrigin || originOf(details.requestingUrl) !== details.hubOrigin) return false;
    return details.mediaType === undefined || details.mediaType === 'audio';
  }
  return ALLOWED_PERMISSIONS.has(permission);
}

/** URL of a hub path: `hubUrl` + path starting with `/`. */
export function hubPath(hubUrl: string, path: string): string {
  return `${hubUrl}${path.startsWith('/') ? path : `/${path}`}`;
}
