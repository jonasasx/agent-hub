// Change session-folder (D2): the folder of a catalog project is relative to the default folder of a machine and the
// same on every machine; the hub joins the two into the working folder of a session.
// Requirements (session-folder): Папка проекта; Рабочая папка сессии.

export const PROJECT_FOLDER_MAX = 1000;

// eslint-disable-next-line no-control-regex
const FOLDER_BAD_CHARS = /[\u0000-\u001f<>"|?*:]/;

/**
 * The stored form of a project folder: '/' separators, no leading or trailing '/', no empty segments; '' → null.
 * Throws on an absolute path (`/…`, `C:…`, `\…`), a `.` or `..` segment, a forbidden character or a length over 1000.
 */
export function normalizeProjectFolder(input: string | null | undefined): string | null {
  const raw = (input ?? '').trim();
  if (!raw) return null;
  if (/^[\\/]/.test(raw) || /^[A-Za-z]:/.test(raw)) throw new Error('the project folder must be relative');
  const segments = raw.split(/[\\/]+/).filter(Boolean);
  if (segments.some(s => s === '.' || s === '..')) throw new Error('the project folder must not contain . or ..');
  if (segments.some(s => FOLDER_BAD_CHARS.test(s))) throw new Error('the project folder contains a forbidden character');
  const folder = segments.join('/');
  if (folder.length > PROJECT_FOLDER_MAX) throw new Error('the project folder is too long');
  return folder || null;
}

/** The project folder on a machine: its default folder plus the segments of `folder` with the machine's separator. */
export function projectDir(base: string, folder: string | null | undefined, windows: boolean): string {
  if (!folder) return base;
  const sep = windows ? '\\' : '/';
  const trimmed = base.endsWith('/') || base.endsWith('\\') ? base.slice(0, -1) : base;
  return [trimmed, ...folder.split('/').filter(Boolean)].join(sep);
}

/**
 * `path` inside `root` as a project folder ('' — the root itself); null outside the root. Windows compares without
 * case and with either separator.
 */
export function relativeFolder(root: string, path: string, windows: boolean): string | null {
  const norm = (p: string) => (windows ? p.replace(/\\/g, '/') : p).replace(/\/+$/, '');
  const r = norm(root);
  const p = norm(path);
  const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (same(p, r)) return '';
  if (!same(p.slice(0, r.length + 1), `${r}/`)) return null;
  return p.slice(r.length + 1);
}
