/**
 * `agenthub://` links and command-line arguments (design D11, D13).
 * Requirements: Один экземпляр и deep links; Приём кода приложением; Автозапуск.
 */

export const PROTOCOL = 'agenthub';
export const MAX_LINK_LENGTH = 2048;
export const HIDDEN_FLAG = '--hidden';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DeepLink = { kind: 'session'; id: string } | { kind: 'auth'; code: string; state: string };

export function parseDeepLink(raw: string): DeepLink | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_LINK_LENGTH) return null;
  // Path traversal is checked on the raw text: URL normalises `..` away.
  if (/\.\.|%2e%2e|%2f|%5c|\\/i.test(raw.split('?')[0] ?? '')) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== `${PROTOCOL}:`) return null;
  if (u.username || u.password || u.port) return null;
  if (u.host === 's') {
    const m = /^\/([^/]+)\/?$/.exec(u.pathname);
    const id = m?.[1];
    if (!id || !UUID_RE.test(id) || u.search || u.hash) return null;
    return { kind: 'session', id: id.toLowerCase() };
  }
  if (u.host === 'auth') {
    if (u.pathname !== '' && u.pathname !== '/') return null;
    const code = u.searchParams.get('code');
    const state = u.searchParams.get('state');
    if (!code || !state || code.length > 512 || state.length > 128) return null;
    return { kind: 'auth', code, state };
  }
  return null;
}

/** The first `agenthub:` argument of a command line (Windows passes the link as an argument). */
export function findDeepLinkArg(argv: readonly string[]): string | null {
  for (const a of argv) {
    if (typeof a === 'string' && a.toLowerCase().startsWith(`${PROTOCOL}:`)) return a;
  }
  return null;
}

/** Started by the autostart entry: stay in the tray. */
export function hasHiddenFlag(argv: readonly string[]): boolean {
  return argv.includes(HIDDEN_FLAG);
}

/** What a (first or second) instance should do with its command line. */
export type LaunchAction = { kind: 'link'; link: DeepLink } | { kind: 'ignoredLink' } | { kind: 'show' } | { kind: 'hidden' };

export function launchAction(argv: readonly string[]): LaunchAction {
  const raw = findDeepLinkArg(argv);
  if (raw !== null) {
    const link = parseDeepLink(raw);
    return link ? { kind: 'link', link } : { kind: 'ignoredLink' };
  }
  return hasHiddenFlag(argv) ? { kind: 'hidden' } : { kind: 'show' };
}
