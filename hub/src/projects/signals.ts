// Path signals of a session (design D9 p. 2, 5; task 4.4): tool calls of transcript lines → vault-relative paths with
// an op (edit/read), the start directory (cwd) and its git remote. Normalisation: separators '/', the runner's vault
// root dropped (Windows — case-insensitive), '~/' → home, relative → from cwd; a runner without vault_root —
// the vault found by the pattern …/vault/<NN-…|.claude>/. Requirement (project-grouping): Сигналы путей.

export type Op = 'edit' | 'read' | 'cwd' | 'remote';

export interface RunnerPaths {
  windows: boolean;
  homeDir: string | null;
  vaultRoot: string | null;
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
/** No signal: scratch and service directories of the vault (D9 p. 4). */
const IGNORED_TOP = new Set(['.tmp', '.playwright-mcp', '.venv', '01-inbox', '99-archive', '.git', '.obsidian']);

const slashes = (p: string) => p.replace(/\\/g, '/');

/** Git Bash style `/c/Users/…` → `C:/Users/…`. */
function msysDrive(p: string): string {
  const m = /^\/([a-zA-Z])\/(.*)$/.exec(p);
  return m ? `${m[1]!.toUpperCase()}:/${m[2]}` : p;
}

function isAbs(p: string, windows: boolean): boolean {
  return windows ? /^[a-zA-Z]:\//.test(p) || p.startsWith('/') : p.startsWith('/');
}

/** `.` and `..` resolved, no trailing slash. */
function clean(p: string): string {
  const drive = /^[a-zA-Z]:/.exec(p)?.[0] ?? '';
  const rest = p.slice(drive.length);
  const lead = rest.startsWith('/') ? '/' : '';
  const out: string[] = [];
  for (const seg of rest.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return `${drive}${lead}${out.join('/')}`;
}

const VAULT_PATTERN = /(?:^|\/)vault\/((?:\d\d-[^/]+|\.claude)(?:\/.*)?)$/i;

/**
 * The path relative to the vault root ('' for the root itself), or null when the path is outside the vault. `cwd` is
 * the session's start directory (for relative paths).
 */
export function toVaultRelative(raw: string, cwd: string | null, r: RunnerPaths): string | null {
  let p = raw.trim();
  if (!p) return null;
  if ((p === '~' || p.startsWith('~/') || p.startsWith('~\\')) && r.homeDir) p = `${r.homeDir}${p.slice(1)}`;
  p = slashes(p);
  if (r.windows) p = msysDrive(p);
  if (!isAbs(p, r.windows)) {
    if (!cwd) return null;
    let c = slashes(cwd);
    if (r.windows) c = msysDrive(c);
    p = `${c.replace(/\/+$/, '')}/${p}`;
  }
  p = clean(p);
  if (r.vaultRoot) {
    let root = clean(slashes(r.vaultRoot));
    if (r.windows) root = msysDrive(root);
    const a = r.windows ? p.toLowerCase() : p;
    const b = r.windows ? root.toLowerCase() : root;
    if (a === b) return '';
    if (a.startsWith(`${b}/`)) return p.slice(root.length + 1);
    return null;
  }
  // No vault root known (unknown-<host> of the Drive import, X1 before its hello): the vault by its shape.
  if (/(?:^|\/)vault$/i.test(p)) return '';
  const m = VAULT_PATTERN.exec(p);
  return m ? m[1]! : null;
}

/** A vault path that gives a signal: not the root, not scratch/service directories. */
export function signalPath(rel: string | null): string | null {
  if (rel === null || rel === '') return null;
  const top = rel.split('/')[0]!;
  if (IGNORED_TOP.has(top)) return null;
  return rel.replace(/\/+$/, '');
}

/**
 * Tokens of a shell command that are paths: absolute (`C:\…`, `/…`, `~/…`) or from a vault top directory `NN-…/`.
 * After a leading `cd <dir> &&` (or `;`) the relative paths are taken from that directory, not from the transcript's
 * cwd (prod: `cd /c/Users/me/vault && python 07-automation/…` from a subdirectory counted the script under
 * another system).
 */
export function shellPaths(command: string, windows: boolean): string[] {
  const out = new Set<string>();
  const cd = /^\s*(?:cd|pushd|Set-Location|sl)\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*(?:&&|;|\|\|)/i.exec(command);
  const base = cd ? slashes(cd[1] ?? cd[2] ?? cd[3] ?? '').replace(/\/+$/, '') : null;
  for (let tok of command.split(/[\s;|&()<>`"'=,]+/)) {
    tok = tok.replace(/[:.]+$/, '');
    if (!tok || tok.length < 3) continue;
    const abs = windows ? /^[a-zA-Z]:[\\/]/.test(tok) || /^\/[^/]/.test(tok) : tok.startsWith('/');
    if (abs || tok.startsWith('~/')) out.add(tok);
    else if (/^\d\d-[^/\\]+[/\\]/.test(tok)) out.add(base && slashes(tok) !== base && !slashes(tok).startsWith(`${base}/`) ? `${base}/${tok}` : tok);
  }
  return [...out];
}

/** Tool calls of one transcript line: [{op, raw path}] (one per path and op). */
export function toolPaths(line: Record<string, unknown>, windows: boolean): Array<{ op: 'edit' | 'read'; path: string }> {
  if (line.type !== 'assistant') return [];
  const content = (line.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  const out: Array<{ op: 'edit' | 'read'; path: string }> = [];
  const seen = new Set<string>();
  const add = (op: 'edit' | 'read', p: unknown) => {
    if (typeof p !== 'string' || !p) return;
    const k = `${op}\u0000${p}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ op, path: p });
  };
  for (const b of content as Array<{ type?: string; name?: string; input?: Record<string, unknown> }>) {
    if (!b || b.type !== 'tool_use' || !b.name || !b.input || typeof b.input !== 'object') continue;
    const name = b.name;
    const inp = b.input;
    if (EDIT_TOOLS.has(name)) add('edit', inp.file_path ?? inp.notebook_path);
    else if (READ_TOOLS.has(name)) add('read', name === 'Read' ? inp.file_path : inp.path);
    else if (SHELL_TOOLS.has(name) && typeof inp.command === 'string') for (const p of shellPaths(inp.command, windows || name === 'PowerShell')) add('read', p);
  }
  return out;
}
