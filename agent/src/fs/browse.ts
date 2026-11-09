// Read-only file explorer on the machine: fs.list and fs.read (change `tool-windows-file-explorer`, design D1-D2).
// Requirement: Безопасный доступ к файлам машины; Ленивое дерево; Просмотрщик файлов.
// Nothing here changes the file system. Paths and file contents are never put into messages or logs.
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  FS_LIST_LIMIT,
  fsMaxBytes,
  isLocalPosixPath,
  isLocalWindowsPath,
  isRestrictedPath,
  type FsAgentErrorCode,
  type FsBlocked,
  type FsEntry,
  type FsFileKind,
  type FsKind,
  type FsListResult,
  type FsReadChunkResult,
  type FsReadResult,
} from '@agent-hub/shared';

/** A refusal of fs.list / fs.read with a code of the protocol; the message never carries a path. */
export class FsError extends Error {
  constructor(
    readonly code: FsAgentErrorCode,
    message?: string,
  ) {
    super(message ?? code);
  }
}

const HEAD_BYTES = 8192;
const STAT_CONCURRENCY = 32;

type PathApi = typeof path.posix;

export interface BrowseOptions {
  /** Windows compares names case-insensitively; tests set it to check both. */
  win32?: boolean;
}

function isWin(o?: BrowseOptions): boolean {
  return o?.win32 ?? process.platform === 'win32';
}

/** Whether `target` is `root` or lies under it by whole path segments (no `/a/proj2` for `/a/proj`); case-insensitive on Windows. */
export function isInsideRoot(root: string, target: string, win32: boolean): boolean {
  const api: PathApi = win32 ? path.win32 : path.posix;
  const fold = (p: string) => (win32 ? p.toLowerCase() : p);
  const rel = api.relative(fold(api.resolve(root)), fold(api.resolve(target)));
  if (rel === '') return true;
  if (api.isAbsolute(rel)) return false; // another drive
  return rel !== '..' && !rel.startsWith('..' + api.sep);
}

/** An absolute local path of this platform with no `..` segment and no NUL; anything else is invalid_path. */
export function assertBrowsablePath(p: string, o?: BrowseOptions): void {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096 || p.includes('\u0000')) throw new FsError('invalid_path');
  const ok = isWin(o) ? isLocalWindowsPath(p) : isLocalPosixPath(p);
  if (!ok) throw new FsError('invalid_path');
  if (p.split(/[\\/]+/).some(s => s === '..')) throw new FsError('invalid_path');
}

function fsFailure(error: unknown, fallback: FsAgentErrorCode = 'io_error'): FsError {
  if (error instanceof FsError) return error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return new FsError('not_found');
  if (code === 'EACCES' || code === 'EPERM') return new FsError('permission_denied');
  if (code === 'ELOOP' || code === 'ENAMETOOLONG' || code === 'EINVAL') return new FsError('invalid_path');
  return new FsError(fallback);
}

/**
 * Checks the requested path against the root and the secret list and returns its realpath. Order: syntax, secret
 * (on the path as asked, so the answer does not reveal whether a secret exists), realpath of the root and of the path,
 * containment by segment, secret again (a link may lead to one).
 */
export async function resolveInside(requested: string, root: string, o?: BrowseOptions): Promise<{ real: string; rootReal: string }> {
  assertBrowsablePath(requested, o);
  assertBrowsablePath(root, o);
  if (isRestrictedPath(requested)) throw new FsError('restricted');
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch (error) {
    throw fsFailure(error);
  }
  let real: string;
  try {
    real = await realpath(requested);
  } catch (error) {
    throw fsFailure(error);
  }
  if (!isInsideRoot(rootReal, real, isWin(o))) throw new FsError('outside_root');
  if (isRestrictedPath(real)) throw new FsError('restricted');
  return { real, rootReal };
}

function kindOf(entry: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }): FsKind {
  if (entry.isSymbolicLink()) return 'symlink';
  if (entry.isDirectory()) return 'dir';
  if (entry.isFile()) return 'file';
  return 'other';
}

const compareNames = (a: string, b: string): number => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

/** fs.list: one level of a folder, folders first, case-insensitive, cut at FS_LIST_LIMIT. */
export async function listFolder(requested: string, root: string, showHidden: boolean, o?: BrowseOptions): Promise<FsListResult> {
  const { real, rootReal } = await resolveInside(requested, root, o);
  let info;
  try {
    info = await stat(real);
  } catch (error) {
    throw fsFailure(error);
  }
  if (!info.isDirectory()) throw new FsError('not_directory');
  let dirents;
  try {
    dirents = await readdir(real, { withFileTypes: true });
  } catch (error) {
    throw fsFailure(error);
  }
  const visible = dirents.filter(d => showHidden || !d.name.startsWith('.'));
  const rank = (d: { isDirectory(): boolean }) => (d.isDirectory() ? 0 : 1);
  visible.sort((a, b) => rank(a) - rank(b) || compareNames(a.name, b.name));
  const total = visible.length;
  const cut = visible.slice(0, FS_LIST_LIMIT);
  const entries: FsEntry[] = new Array<FsEntry>(cut.length);
  const describe = async (i: number): Promise<void> => {
    const d = cut[i]!;
    const kind = kindOf(d);
    const full = path.join(real, d.name);
    if (isRestrictedPath(full)) {
      entries[i] = { name: d.name, kind, blocked: 'restricted' };
      return;
    }
    if (kind === 'symlink') {
      entries[i] = await describeLink(d.name, full, rootReal, o);
      return;
    }
    try {
      const st = await lstat(full);
      entries[i] = { name: d.name, kind, mtimeMs: Math.floor(st.mtimeMs), ...(kind === 'file' ? { size: st.size } : {}) };
    } catch (error) {
      entries[i] = { name: d.name, kind, ...(fsFailure(error).code === 'permission_denied' ? { blocked: 'permission_denied' as const } : {}) };
    }
  };
  for (let from = 0; from < cut.length; from += STAT_CONCURRENCY) {
    const batch: Promise<void>[] = [];
    for (let i = from; i < Math.min(cut.length, from + STAT_CONCURRENCY); i += 1) batch.push(describe(i));
    await Promise.all(batch);
  }
  return { path: real, entries, truncated: total > cut.length, total };
}

/** A symlink is listed as it is; it is blocked when its target leaves the root or is a secret. A broken link stays open (it answers not_found). */
async function describeLink(name: string, full: string, rootReal: string, o?: BrowseOptions): Promise<FsEntry> {
  let target: string;
  try {
    target = await realpath(full);
  } catch {
    return { name, kind: 'symlink' };
  }
  let blocked: FsBlocked | undefined;
  if (!isInsideRoot(rootReal, target, isWin(o))) blocked = 'outside_root';
  else if (isRestrictedPath(target)) blocked = 'restricted';
  return { name, kind: 'symlink', ...(blocked ? { blocked } : {}) };
}

const IMAGE_BY_EXT: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

function sniffRaster(b: Buffer): string | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

function looksLikeSvg(head: Buffer): boolean {
  const s = stripBom(head.toString('utf8')).trimStart();
  return /^(<\?xml|<!--|<!DOCTYPE|<svg)/i.test(s) && /<svg[\s>]/i.test(s);
}

/** True when the bytes are UTF-8 (a character cut by the end of `b` is tolerated when `partial`). */
function isUtf8(b: Buffer, partial: boolean): boolean {
  if (b.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b, { stream: partial });
    return true;
  } catch {
    return false;
  }
}

interface Classified {
  kind: FsFileKind;
  mime: string;
}

/** The class of a file by extension and signature; what is not a known media type is text when UTF-8 without NUL, else binary. */
/** Drops a leading byte order mark. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function classifyFile(name: string, head: Buffer): Classified {
  const ext = path.extname(name).toLowerCase();
  const raster = IMAGE_BY_EXT[ext] ? sniffRaster(head) : null;
  if (raster) return { kind: 'image', mime: raster };
  if (ext === '.pdf' && head.subarray(0, 5).toString('latin1') === '%PDF-') return { kind: 'pdf', mime: 'application/pdf' };
  if (ext === '.svg' && looksLikeSvg(head)) return { kind: 'image', mime: 'image/svg+xml' };
  if (isUtf8(head, true)) return ext === '.md' || ext === '.markdown' ? { kind: 'markdown', mime: 'text/markdown' } : { kind: 'text', mime: 'text/plain' };
  return { kind: 'binary', mime: 'application/octet-stream' };
}

export interface FsReadAnswer {
  result: FsReadResult;
  /** image / pdf bytes, sent as a binary frame after cmd.ok {binary: true} */
  data?: Buffer;
}

type FileHandle = Awaited<ReturnType<typeof open>>;

/**
 * Opens a plain file of the root for reading: resolveInside, then the opened file is checked once more (the path may
 * have been swapped for a link between realpath and open). The caller closes the handle.
 */
async function openInside(requested: string, root: string, o?: BrowseOptions): Promise<{ real: string; handle: FileHandle }> {
  const { real, rootReal } = await resolveInside(requested, root, o);
  // a FIFO or a device would block open(): a plain file is required before the descriptor is taken
  try {
    if (!(await stat(real)).isFile()) throw new FsError('not_file');
  } catch (error) {
    throw fsFailure(error);
  }
  let handle: FileHandle;
  try {
    handle = await open(real, 'r');
  } catch (error) {
    throw fsFailure(error);
  }
  try {
    let again: string;
    try {
      again = await realpath(real);
    } catch (error) {
      throw fsFailure(error);
    }
    if (!isInsideRoot(rootReal, again, isWin(o))) throw new FsError('outside_root');
    if (isRestrictedPath(again)) throw new FsError('restricted');
    return { real, handle };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/** fs.read: a file of the root, whole, within the limit of its class. The size is taken from the open descriptor. */
export async function readFileForView(requested: string, root: string, o?: BrowseOptions): Promise<FsReadAnswer> {
  const { real, handle } = await openInside(requested, root, o);
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new FsError('not_file');
    const head = Buffer.alloc(Math.min(HEAD_BYTES, st.size));
    const headRead = head.length ? (await handle.read(head, 0, head.length, 0)).bytesRead : 0;
    const { kind, mime } = classifyFile(real, head.subarray(0, headRead));
    const mtimeMs = Math.floor(st.mtimeMs);
    const max = fsMaxBytes(kind);
    if (max === null) return { result: { path: real, kind, mime, size: st.size, mtimeMs } };
    if (st.size > max) throw new FsError('too_large');
    // read at most max + 1 bytes: a file that grew after fstat is cut by the limit, not read whole
    const chunks: Buffer[] = [];
    let got = 0;
    for (;;) {
      const buf = Buffer.alloc(Math.min(1024 * 1024, max + 1 - got));
      if (buf.length === 0) break;
      const { bytesRead } = await handle.read(buf, 0, buf.length, got);
      if (bytesRead === 0) break;
      chunks.push(buf.subarray(0, bytesRead));
      got += bytesRead;
    }
    if (got > max) throw new FsError('too_large');
    const data = Buffer.concat(chunks, got);
    if (kind === 'text' || kind === 'markdown') {
      if (!isUtf8(data, false)) return { result: { path: real, kind: 'binary', mime: 'application/octet-stream', size: got, mtimeMs } };
      return { result: { path: real, kind, mime, size: got, mtimeMs, text: data.toString('utf8') } };
    }
    return { result: { path: real, kind, mime, size: got, mtimeMs, binary: true }, data };
  } catch (error) {
    throw fsFailure(error);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export interface FsChunkAnswer {
  result: FsReadChunkResult;
  /** the bytes, sent as a binary frame after cmd.ok {binary: true}; none for length 0 */
  data?: Buffer;
}

/**
 * fs.read_chunk (file-download D1, D3): bytes [offset, offset + length) of a file of the root, cut at its end, any class
 * and size. Stateless — every piece passes the same checks as fs.read; length 0 reads no content.
 */
export async function readFileChunk(requested: string, root: string, offset: number, length: number, o?: BrowseOptions): Promise<FsChunkAnswer> {
  const { real, handle } = await openInside(requested, root, o);
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new FsError('not_file');
    const meta = { path: real, size: st.size, mtimeMs: Math.floor(st.mtimeMs), offset };
    const want = Math.max(0, Math.min(length, st.size - offset));
    if (want === 0) return { result: { ...meta, bytes: 0 } };
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const { bytesRead } = await handle.read(buf, got, want - got, offset + got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    return { result: { ...meta, bytes: got, binary: true }, data: buf.subarray(0, got) };
  } catch (error) {
    throw fsFailure(error);
  } finally {
    await handle.close().catch(() => undefined);
  }
}
