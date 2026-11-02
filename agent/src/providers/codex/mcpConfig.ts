// One set of MCP servers for Claude Code and Codex (change agent-providers, design D8): the servers Claude Code uses in
// the session's directory become `mcp_servers` of the Codex thread. Sources as in Claude Code: ~/.claude.json
// `mcpServers` (user), `projects[<git root>].mcpServers` (local), `.mcp.json` of the project (project, approved ones),
// minus `disabledMcpServers`; local > project > user on a name clash. Plugin servers are not included.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { projectRootOf } from '../../sessions/mcp.js';

type Json = Record<string, unknown>;

/** A Codex `[mcp_servers.<name>]` table. */
export type CodexMcpServer = Json;

/** ~/.claude.json, or $CLAUDE_CONFIG_DIR/.claude.json. */
export function claudeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(homedir(), '.claude.json');
}

function readJson(file: string): Json | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Json;
  } catch {
    return null;
  }
}

/** `${VAR}` and `${VAR:-default}` as Claude Code expands them in MCP configs; an unknown variable without a default — ''. */
export function expandVars(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, def: string | undefined) => env[name] ?? def ?? '');
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const record = (v: unknown): Record<string, string> => (v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Json).filter((e): e is [string, string] => typeof e[1] === 'string')) : {});

/** One Claude server → a Codex server; null — a type Codex cannot run (sdk, ws) or a broken entry. */
export function toCodex(cfg: unknown, env: NodeJS.ProcessEnv): CodexMcpServer | null {
  if (!cfg || typeof cfg !== 'object') return null;
  const c = cfg as Json;
  const type = typeof c.type === 'string' ? c.type : typeof c.url === 'string' ? 'http' : 'stdio';
  const x = (s: string) => expandVars(s, env);
  if (type === 'stdio') {
    if (typeof c.command !== 'string' || !c.command) return null;
    const vars = Object.fromEntries(Object.entries(record(c.env)).map(([k, v]) => [k, x(v)]));
    return { command: x(c.command), args: strings(c.args).map(x), ...(Object.keys(vars).length ? { env: vars } : {}), startup_timeout_sec: 30 };
  }
  if (type === 'http' || type === 'sse') {
    if (typeof c.url !== 'string' || !c.url) return null;
    const headers = Object.fromEntries(Object.entries(record(c.headers)).map(([k, v]) => [k, x(v)]));
    return { url: x(c.url), ...(Object.keys(headers).length ? { http_headers: headers } : {}), startup_timeout_sec: 30 };
  }
  return null;
}

/** The projects entry of ~/.claude.json for a root (Windows: the key's case may differ). */
function projectEntry(config: Json, root: string, platform: NodeJS.Platform): Json {
  const projects = (config.projects ?? {}) as Record<string, Json>;
  if (projects[root]) return projects[root]!;
  if (platform === 'win32') {
    const low = root.toLowerCase();
    const key = Object.keys(projects).find(k => k.replaceAll('\\', '/').toLowerCase() === low);
    if (key) return projects[key]!;
  }
  return {};
}

/** Settings of Claude Code that approve project servers (.mcp.json). */
function projectApproval(root: string, entry: Json): { all: boolean; enabled: Set<string>; disabled: Set<string> } {
  const files = [path.join(homedir(), '.claude', 'settings.json'), path.join(root, '.claude', 'settings.json'), path.join(root, '.claude', 'settings.local.json')];
  let all = entry.enableAllProjectMcpServers === true;
  const enabled = new Set(strings(entry.enabledMcpjsonServers));
  const disabled = new Set(strings(entry.disabledMcpjsonServers));
  for (const f of files) {
    const s = readJson(f);
    if (!s) continue;
    if (s.enableAllProjectMcpServers === true) all = true;
    for (const n of strings(s.enabledMcpjsonServers)) enabled.add(n);
    for (const n of strings(s.disabledMcpjsonServers)) disabled.add(n);
  }
  return { all, enabled, disabled };
}

export interface McpBuild {
  servers: Record<string, CodexMcpServer>;
  /** Names left out (unsupported type, broken entry) — for the log. */
  skipped: string[];
}

/** The MCP servers of Claude Code for `cwd`, as Codex `mcp_servers`. */
export function codexMcpServers(cwd: string, o: { env?: NodeJS.ProcessEnv; configPath?: string; platform?: NodeJS.Platform; exclude?: string[] } = {}): McpBuild {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const config = readJson(o.configPath ?? claudeConfigPath(env)) ?? {};
  const root = projectRootOf(cwd, platform);
  const entry = projectEntry(config, root, platform);
  const merged = new Map<string, unknown>();
  for (const [n, c] of Object.entries((config.mcpServers ?? {}) as Json)) merged.set(n, c);
  const mcpJson = path.join(root, '.mcp.json');
  if (existsSync(mcpJson)) {
    const approval = projectApproval(root, entry);
    for (const [n, c] of Object.entries(((readJson(mcpJson) ?? {}).mcpServers ?? {}) as Json)) {
      if (approval.disabled.has(n)) continue;
      if (approval.all || approval.enabled.has(n)) merged.set(n, c);
    }
  }
  for (const [n, c] of Object.entries((entry.mcpServers ?? {}) as Json)) merged.set(n, c);
  const disabled = new Set([...strings(entry.disabledMcpServers), ...(o.exclude ?? [])]);
  const servers: Record<string, CodexMcpServer> = {};
  const skipped: string[] = [];
  for (const [name, cfg] of merged) {
    if (disabled.has(name)) continue;
    // Codex names a server by a TOML key: the names of Claude Code (letters, digits, -, _) fit as they are
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
      skipped.push(name);
      continue;
    }
    const c = toCodex(cfg, env);
    if (c) servers[name] = c;
    else skipped.push(name);
  }
  return { servers, skipped };
}
