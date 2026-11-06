// Read-only file explorer contracts: agent commands fs.list / fs.read (change `tool-windows-file-explorer`, design D1-D2).
// Requirement: Безопасный доступ к файлам машины; Ленивое дерево; Просмотрщик файлов.
import { z } from 'zod';

/** Entries of one fs.list answer; the rest is cut after sorting and reported through `truncated` / `total`. */
export const FS_LIST_LIMIT = 1000;
/** Largest text / markdown file fs.read returns. */
export const FS_TEXT_MAX = 2 * 1024 * 1024;
/** Largest image / pdf file fs.read returns. */
export const FS_MEDIA_MAX = 20 * 1024 * 1024;

export const FS_ERROR_CODES = ['invalid_path', 'outside_root', 'restricted', 'not_found', 'not_directory', 'not_file', 'permission_denied', 'too_large', 'unsupported', 'io_error'] as const;
/** Code of a failed fs.list / fs.read (cmd.error.code). */
export type FsAgentErrorCode = (typeof FS_ERROR_CODES)[number];
export const fsAgentErrorCodeSchema = z.enum(FS_ERROR_CODES);

export const FS_ENTRY_KINDS = ['dir', 'file', 'symlink', 'other'] as const;
/** What a directory entry is; a symlink is reported as is, never followed by the list. */
export type FsKind = (typeof FS_ENTRY_KINDS)[number];
export const FS_BLOCKED_REASONS = ['outside_root', 'restricted', 'permission_denied'] as const;
/** Why an entry cannot be opened: a symlink out of the root, a secret path, no rights. */
export type FsBlocked = (typeof FS_BLOCKED_REASONS)[number];

export const fsEntrySchema = z.object({
  name: z.string().min(1).max(1024),
  kind: z.enum(FS_ENTRY_KINDS),
  size: z.number().int().nonnegative().optional(),
  mtimeMs: z.number().nonnegative().optional(),
  blocked: z.enum(FS_BLOCKED_REASONS).optional(),
});
export type FsEntry = z.infer<typeof fsEntrySchema>;

const fsPath = z.string().min(1).max(4096);

/** Hub → agent. `root` is set by the hub (session cwd or machine home), never by the browser. */
export const fsListPayload = z.object({ path: fsPath, root: fsPath, showHidden: z.boolean().optional() });
export type FsListPayload = z.infer<typeof fsListPayload>;
export const fsReadPayload = z.object({ path: fsPath, root: fsPath });
export type FsReadPayload = z.infer<typeof fsReadPayload>;

/** cmd.ok.result of fs.list; `path` is the realpath. Entries: folders first, then files, case-insensitive, cut at FS_LIST_LIMIT. */
export const fsListResultSchema = z.object({
  path: fsPath,
  entries: z.array(fsEntrySchema).max(FS_LIST_LIMIT),
  truncated: z.boolean(),
  total: z.number().int().nonnegative(),
});
export type FsListResult = z.infer<typeof fsListResultSchema>;

export const FS_FILE_KINDS = ['text', 'markdown', 'image', 'pdf', 'binary'] as const;
/** The class of a file by extension and signature; `binary` is metadata only («Нельзя показать»). */
export type FsFileKind = (typeof FS_FILE_KINDS)[number];

/**
 * cmd.ok.result of fs.read. text / markdown: `text` is in the answer (UTF-8, ≤ FS_TEXT_MAX). image / pdf: `binary: true`
 * and a binary frame follows (like fs.read_image), ≤ FS_MEDIA_MAX. binary: neither.
 */
export const fsReadResultSchema = z.object({
  path: fsPath,
  kind: z.enum(FS_FILE_KINDS),
  mime: z.string().min(1).max(200),
  size: z.number().int().nonnegative(),
  mtimeMs: z.number().nonnegative(),
  text: z.string().optional(),
  binary: z.literal(true).optional(),
});
export type FsReadResult = z.infer<typeof fsReadResultSchema>;

/** Largest size of a file of this class, null for `binary` (nothing is read). */
export function fsMaxBytes(kind: FsFileKind): number | null {
  if (kind === 'text' || kind === 'markdown') return FS_TEXT_MAX;
  if (kind === 'image' || kind === 'pdf') return FS_MEDIA_MAX;
  return null;
}

// Secret paths (design D2): matched by the agent on the realpath, case-insensitively, by path segments.
/** Any path with such a segment is closed, the folder itself and everything under it. */
export const FS_RESTRICTED_DIRS = ['.ssh', '.gnupg', '.aws', '.kube', '.agent-hub'] as const;
/** Closed consecutive segments: `.config/gh`, `.docker/config.json`, `.claude/.credentials.json`, `.codex/auth.json`. */
export const FS_RESTRICTED_SEQUENCES = [
  ['.config', 'gh'],
  ['.docker', 'config.json'],
  ['.claude', '.credentials.json'],
  ['.codex', 'auth.json'],
] as const;
/** Closed names of a segment: `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `id_ecdsa*`, `.npmrc`, `.netrc`, `.git-credentials`, `.pgpass`, `.claude.json`. */
export const FS_RESTRICTED_NAME = /^(\.env(\..*)?|.*\.(pem|key)|id_(rsa|ed25519|ecdsa).*|\.npmrc|\.netrc|\.git-credentials|\.pgpass|\.claude\.json)$/;
export const FS_RESTRICTED = {
  dirs: FS_RESTRICTED_DIRS,
  sequences: FS_RESTRICTED_SEQUENCES,
  name: FS_RESTRICTED_NAME,
} as const;

/** True when the path (either slash style) is a secret or lies inside a secret folder. */
export function isRestrictedPath(path: string): boolean {
  const segments = path
    .split(/[\\/]+/)
    .filter(Boolean)
    .map(s => s.toLowerCase());
  for (let i = 0; i < segments.length; i += 1) {
    const s = segments[i]!;
    if ((FS_RESTRICTED_DIRS as readonly string[]).includes(s)) return true;
    if (FS_RESTRICTED_NAME.test(s)) return true;
    if (FS_RESTRICTED_SEQUENCES.some(seq => seq[0] === s && seq[1] === segments[i + 1])) return true;
  }
  return false;
}
