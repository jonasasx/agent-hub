/**
 * Links to files of the machine in Markdown (change chat-file-links). Requirement (file-explorer): Ссылки на файлы —
 * `[x](C:\…)`, `[x](/home/…)`, `[x](file:///…)` and relative paths open the file in the viewer, the tail of a line number
 * (`:42`, `:42:7`, `#L42`) is dropped. Links to folders (change chat-folder-links) — Requirement: Ссылки на папки.
 * Nothing here touches the disk.
 */
import { isInside, resolveRelative } from './paths';

const WIN_ABS = /^[A-Za-z]:[\\/]/;
// a scheme is two or more letters before `:` (one letter is a drive)
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]+:/;
// `INDEX.md:3`, `a.ts:42:7` look like a scheme to the URL parser: a name with a dot followed by a line number is a file
const NAME_WITH_LINE = /^[^/\\?#:]*\.[^/\\?#:]*:\d+(?::\d+)?(?:[?#].*)?$/;

/** A relative file name with a line tail (`INDEX.md:3`) — not a URL scheme. */
export function isNameWithLine(href: string): boolean {
  return NAME_WITH_LINE.test(href);
}

/** `file:///C:/x`, `file:///home/x`, `file://localhost/x` → the path; null for a file URL of another host. */
function fromFileUrl(href: string): string | null {
  const rest = href.replace(/^file:/i, '');
  if (!rest.startsWith('//')) return rest;
  const slash = rest.indexOf('/', 2);
  const host = slash < 0 ? rest.slice(2) : rest.slice(2, slash);
  if (host && host.toLowerCase() !== 'localhost') return null;
  const path = slash < 0 ? '' : rest.slice(slash);
  // `/C:/x` → `C:/x`
  return /^\/[A-Za-z]:[\\/]/.test(path) ? path.slice(1) : path;
}

/** Without `#L10`, `#L10-L20`, `?…` and a `:42` / `:42:7` tail after a file name. */
function stripTail(ref: string): string {
  let r = ref.split(/[?#]/)[0] ?? '';
  r = r.replace(/:\d+(?::\d+)?$/, '');
  return r;
}

/**
 * The absolute path a Markdown link points to, or null when the link is not a file of the machine (web address,
 * `mailto:`, anchor, hub path on a Windows machine). `base` is the folder relative paths start from; `unix` — the
 * machine has `/…` paths, so a leading `/` is a file and not an address of the hub.
 */
export function fileLinkTarget(href: string | undefined, base: string | null, unix: boolean): string | null {
  const raw = (href ?? '').trim();
  if (!raw || raw.startsWith('#') || raw.startsWith('?')) return null;
  let ref: string | null = raw;
  if (/^file:/i.test(raw)) ref = fromFileUrl(raw);
  else if (raw.startsWith('//') || raw.startsWith('\\\\')) return null;
  else if (SCHEME.test(raw) && !WIN_ABS.test(raw) && !isNameWithLine(raw)) return null;
  if (!ref) return null;
  ref = stripTail(ref);
  if (!ref) return null;
  const winAbs = WIN_ABS.test(ref);
  const unixAbs = !winAbs && /^[\\/]/.test(ref);
  if (unixAbs && !unix) return null;
  if (!winAbs && !unixAbs && !base) return null;
  return resolveRelative(base ?? ref, ref);
}

/** What a link points to by its look: `dir` ends with a slash, `file` has a line tail or an extension, `unknown` — ask the machine. */
export type FileLinkKind = 'file' | 'dir' | 'unknown';

export function fileLinkKind(href: string | undefined): FileLinkKind {
  const raw = (href ?? '').trim();
  if (/#L\d+/i.test(raw)) return 'file';
  const ref = raw.split(/[?#]/)[0] ?? '';
  if (/[\\/]$/.test(ref)) return 'dir';
  if (/:\d+(?::\d+)?$/.test(ref)) return 'file';
  const name = ref.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? 'file' : 'unknown';
}

/**
 * A file or a folder to open: its machine, path, the session whose folder is the root (none — the machine's home) and the pane of
 * the chat with the link (the file opens beside it).
 */
export interface FileLink {
  runnerId: string;
  path: string;
  kind: FileLinkKind;
  sessionId?: string;
  beside?: string;
}

export type FileLinkResolver = (href: string | undefined) => FileLink | null;

/**
 * The resolver of a feed or a document: relative links from `base`, the session root only for a file inside its `cwd`
 * (as the tree does, Requirement: Границы доступа к файлам).
 */
export function fileLinkResolver(o: { runnerId: string; base: string | null; cwd: string | null; sessionId?: string; pane?: string }): FileLinkResolver {
  const unix = !!(o.cwd ?? o.base)?.startsWith('/');
  return href => {
    const path = fileLinkTarget(href, o.base, unix);
    if (!path) return null;
    const link: FileLink = { runnerId: o.runnerId, path, kind: fileLinkKind(href) };
    if (o.sessionId && o.cwd && isInside(o.cwd, path)) link.sessionId = o.sessionId;
    if (o.pane) link.beside = o.pane;
    return link;
  };
}
