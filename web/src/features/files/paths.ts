/**
 * Paths of a machine as strings, in the style of that machine (change tool-windows-file-explorer). The browser has no
 * `path` module and the machines differ: `/home/ivan/x` and `C:\Users\ivan\x`. Nothing here touches the disk.
 * Requirements (file-explorer): Окно «Файлы» и источники («↑» не выше домашней папки); Крошки и действия над файлом.
 */

const WIN_DRIVE = /^[A-Za-z]:/;

/** The separator of a path: a backslash for `C:\…`, `\\server\…` and anything with a backslash and no slash before it. */
export function sepOf(path: string): '/' | '\\' {
  if (WIN_DRIVE.test(path) || path.startsWith('\\\\')) return '\\';
  const slash = path.indexOf('/');
  const back = path.indexOf('\\');
  if (back >= 0 && (slash < 0 || back < slash)) return '\\';
  return '/';
}

const isWindows = (path: string) => sepOf(path) === '\\';

/** The root of a path: `/`, `C:\`, or empty. */
function rootOf(path: string): string {
  if (WIN_DRIVE.test(path)) return `${path.slice(0, 2)}\\`;
  if (path.startsWith('\\\\')) return '\\\\';
  return path.startsWith('/') ? '/' : '';
}

/** Without the trailing separators, except a root: `/` and `C:\` stay. */
export function trimPath(path: string): string {
  const root = rootOf(path);
  let out = path;
  while (out.length > root.length && /[\\/]$/.test(out)) out = out.slice(0, -1);
  return out;
}

/** A key to compare paths: Windows paths are case-insensitive and take either slash. */
export function pathKey(path: string): string {
  const t = trimPath(path);
  return isWindows(t) ? t.replace(/\//g, '\\').toLowerCase() : t;
}

export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/** The names of the path below its root: `/home/ivan/x` → `['home','ivan','x']`. */
export function segmentsOf(path: string): string[] {
  const t = trimPath(path);
  return t
    .slice(rootOf(t).length)
    .split(/[\\/]+/)
    .filter(Boolean);
}

/** The folder above; null for a root. */
export function parentOf(path: string): string | null {
  const t = trimPath(path);
  const root = rootOf(t);
  if (t.length <= root.length) return null;
  const cut = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
  if (cut < root.length) return root || null;
  if (cut === root.length - 1) return root;
  return t.slice(0, cut) || root || null;
}

export function joinPath(dir: string, name: string): string {
  const base = trimPath(dir);
  if (/[\\/]$/.test(base)) return `${base}${name}`;
  return `${base}${sepOf(base)}${name}`;
}

export function baseName(path: string): string {
  const segs = segmentsOf(path);
  return segs[segs.length - 1] ?? trimPath(path);
}

/** `path` is `root` or lies under it. */
export function isInside(root: string, path: string): boolean {
  const r = pathKey(root);
  const p = pathKey(path);
  if (p === r) return true;
  const sep = isWindows(r) ? '\\' : '/';
  const prefix = r.endsWith(sep) ? r : `${r}${sep}`;
  return p.startsWith(prefix);
}

/** The path of `path` below `root` with slashes; null when it is outside; '' for the root itself. */
export function relativeTo(root: string, path: string): string | null {
  if (!isInside(root, path)) return null;
  const rootSegs = segmentsOf(root).length;
  return segmentsOf(path).slice(rootSegs).join('/');
}

/**
 * The folders from `root` down to the parent of `path` (both ends included when they are folders of the chain):
 * `ancestorsOf('/a', '/a/b/c/f.ts')` → `['/a', '/a/b', '/a/b/c']`. Empty when `path` is outside `root`.
 */
export function ancestorsOf(root: string, path: string): string[] {
  if (!isInside(root, path) || samePath(root, path)) return [];
  const out: string[] = [];
  let dir = parentOf(path);
  while (dir && isInside(root, dir)) {
    out.unshift(dir);
    if (samePath(dir, root)) break;
    dir = parentOf(dir);
  }
  return out;
}

/**
 * The text of «@ В сообщение»: the path below the folder of the session as `@src/main.ts`, an absolute path for a file
 * outside the folder (Requirement: Крошки и действия над файлом, «Файл вне папки сессии»).
 */
export function mentionText(cwd: string | null, path: string): string {
  const rel = cwd ? relativeTo(cwd, path) : null;
  return `@${rel ? rel : path}`;
}

/**
 * A path written in a document (`img/a.png`, `../x.png`, `/abs/x.png`, `C:\x.png`) as an absolute path of the machine.
 * `dir` is the folder of the document. Percent-escapes are decoded, `.` and `..` are folded; null for an empty path.
 */
export function resolveRelative(dir: string, ref: string): string | null {
  let r = ref.trim().split(/[?#]/)[0] ?? '';
  try {
    r = decodeURIComponent(r);
  } catch {
    // keep as written
  }
  if (!r) return null;
  const abs = /^([A-Za-z]:[\\/]|[\\/])/.test(r);
  const base = abs ? r : `${trimPath(dir)}${sepOf(dir)}${r}`;
  const root = rootOf(base);
  const out: string[] = [];
  for (const seg of base.slice(root.length).split(/[\\/]+/)) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return `${root}${out.join(sepOf(base))}` || null;
}
