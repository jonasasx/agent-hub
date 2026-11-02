// Secrets of an MCP configuration never leave the machine (mcp-management design M5).
// Requirement: Секреты в снимке MCP — the snapshot carries no env, no headers, no OAuth tokens or clientSecret; URLs
// without userinfo, query and fragment; secret-looking arguments of a stdio command and of an error text as •••.
import type { McpServerSnapshot, McpTransport } from '@agent-hub/shared';
import { MCP_TRANSPORTS } from '@agent-hub/shared';

export const MASK = '•••';
export const TARGET_MAX = 500;
export const ERROR_MAX = 1000;

/** A flag or a variable name that names a secret: --api-key, -token, PASSWORD, client_secret, X-Auth… */
const SECRET_NAME = /(token|key|secret|passw(or)?d|auth|bearer|credential)/i;
/** A flag whose value is the next argument: `--api-key`, `-p`-like short flags are not secret by name. */
const SECRET_FLAG = /^--?[\w-]*(token|key|secret|passw(or)?d|auth|bearer|credential)[\w-]*$/i;
/** `--api-key=value` / `API_TOKEN=value`. */
const NAME_VALUE = /^(--?)?([\w.-]+)=(.*)$/s;
/** 24+ characters of a base64/hex alphabet. */
const LONG_TOKEN = /^[A-Za-z0-9+/=_-]{24,}$/;

/**
 * A token, not a path or a name: 24+ characters of the alphabet, no / \ : (a path), at least one digit and one letter —
 * `mcp-server-for-the-whole-team` (a package or folder name) stays, `sk-live-…01`, hex and base64 are masked.
 */
function looksLikeToken(arg: string): boolean {
  return LONG_TOKEN.test(arg) && !/[/\\:]/.test(arg) && /\d/.test(arg) && /[A-Za-z]/.test(arg);
}

function cut(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A flag whose value (the next argument) is an HTTP header: `--header "Authorization: Bearer …"`, `-H …`. */
const HEADER_FLAG = /^(--header|-H)$/;
/** The header in the same argument: `--header=…`, `-H=…`, `-HAuthorization:…`. */
const HEADER_INLINE = /^(--header=|-H=?)(.+)$/s;
/** `Name: value` with a secret name (`X-Api-Key: …`, `Authorization: …`) outside a header flag. */
const HEADER_VALUE = /^([\w-]+):\s*(.+)$/s;

/**
 * One argument of a command (the previous one decides whether this is a flag's value). After the flag checks every
 * argument passes the pipeline of redactText: a URL inside it loses userinfo, query and fragment; `Bearer|Basic <x>`,
 * `NAME=secret` and long tokens become •••.
 */
function redactArg(arg: string, prev: string | undefined): string {
  if (prev !== undefined && (SECRET_FLAG.test(prev) || HEADER_FLAG.test(prev))) return MASK;
  const hi = HEADER_INLINE.exec(arg);
  if (hi && (hi[1] !== '-H' || hi[2]!.includes(':'))) return `${hi[1]}${MASK}`;
  const nv = NAME_VALUE.exec(arg);
  if (nv && SECRET_NAME.test(nv[2]!)) return `${nv[1] ?? ''}${nv[2]}=${MASK}`;
  const hv = HEADER_VALUE.exec(arg);
  if (hv && SECRET_NAME.test(hv[1]!)) return `${hv[1]}: ${MASK}`;
  if (looksLikeToken(arg)) return MASK;
  return redactText(arg, Number.MAX_SAFE_INTEGER);
}

/** `command args…` with secrets as •••, ≤ 500 characters. */
export function redactCommand(command: string, args: readonly string[] = []): string {
  const all = [command, ...args];
  return cut(all.map((a, i) => (i === 0 ? a : redactArg(a, all[i - 1]))).join(' '), TARGET_MAX);
}

/**
 * scheme://host[:port]/path: no userinfo, query or fragment; not a URL — undefined. Any scheme: `postgresql://`,
 * `mongodb://`, `redis://` have no origin in WHATWG URL (`null`), so the base is built from protocol and host.
 */
export function redactUrl(raw: string): string | undefined {
  try {
    const u = new URL(raw);
    const base = u.origin !== 'null' ? u.origin : `${u.protocol}//${u.host}`;
    return cut(`${base}${u.pathname}`, TARGET_MAX);
  } catch {
    return undefined;
  }
}

/** A URL of any scheme in a text: `https://…`, `postgresql://…`, `mongodb+srv://…`, `redis://…`, `amqp://…`. */
const URL_IN_TEXT = /\b[a-z][\w+.-]*:\/\/[^\s"'<>)\]]+/gi;

/** URLs of a text without userinfo/query/fragment; an unparsable one (a multi-host DSN) — ••• whole. */
function redactUrlsIn(text: string): string {
  return text.replace(URL_IN_TEXT, m => redactUrl(m) ?? MASK);
}

/**
 * The text of a CLI error (or of an SDK exception): URLs without query, `Bearer …` → `Bearer •••`, `NAME=value` with a
 * secret name → `NAME=•••`, long tokens → •••; ≤ 1000 characters.
 */
export function redactText(text: string, max = ERROR_MAX): string {
  let t = redactUrlsIn(text);
  t = t.replace(/\b(Bearer|Basic)\s+[^\s"',;]+/gi, `$1 ${MASK}`);
  t = t.replace(/\b([\w.-]+)=("[^"]*"|'[^']*'|[^\s"',;&]+)/g, (m, name: string) => (SECRET_NAME.test(name) ? `${name}=${MASK}` : m));
  // a run inside a path (C:\x\<run>, /a/<run>/b) is part of the path, not a token
  t = t.replace(/[A-Za-z0-9+=_-]{24,}/g, (m: string, at: number, all: string) => (/[/\\:]/.test(all[at - 1] ?? '') || /[/\\]/.test(all[at + m.length] ?? '') || !looksLikeToken(m) ? m : MASK));
  return cut(t, max);
}

/** The SDK's McpServerStatus as far as the agent reads it (the type is part of the SDK's unstable interface). */
export interface SdkMcpStatus {
  name: string;
  status: string;
  error?: string;
  serverInfo?: { name?: unknown; version?: unknown };
  config?: { type?: unknown; url?: unknown; command?: unknown; args?: unknown; oauth?: unknown };
  scope?: string;
  source?: string;
  tools?: unknown[];
}

export function transportOf(config: SdkMcpStatus['config']): McpTransport {
  const t = config?.type;
  if (typeof t === 'string') return (MCP_TRANSPORTS as readonly string[]).includes(t) ? (t as McpTransport) : 'other';
  return typeof config?.command === 'string' ? 'stdio' : 'other';
}

/** One snapshot row: only the fields of the protocol, the secrets replaced. env, headers and the rest are never read. */
export function redactServer(s: SdkMcpStatus): McpServerSnapshot {
  const transport = transportOf(s.config);
  let target: string | undefined;
  const c = s.config;
  if ((transport === 'http' || transport === 'sse') && typeof c?.url === 'string') target = redactUrl(c.url);
  else if (transport === 'stdio' && typeof c?.command === 'string') {
    const args = Array.isArray(c.args) ? c.args.filter((a): a is string => typeof a === 'string') : [];
    target = redactCommand(c.command, args);
  }
  // claudeai-proxy: the URL carries the organisation's and the server's ids — no target
  const scope = s.source ?? s.scope;
  const info =
    s.serverInfo && typeof s.serverInfo.name === 'string' && typeof s.serverInfo.version === 'string' ? { name: cut(s.serverInfo.name, 200), version: cut(s.serverInfo.version, 100) } : undefined;
  return {
    name: cut(s.name, 200),
    // the protocol schema maps an unknown status to `unknown` on the hub; the agent sends what the CLI said
    status: s.status as McpServerSnapshot['status'],
    ...(s.error ? { error: redactText(s.error) } : {}),
    transport,
    ...(target ? { target } : {}),
    ...(typeof scope === 'string' && scope ? { scope: cut(scope, 32) } : {}),
    ...(info ? { serverInfo: info } : {}),
    toolCount: Array.isArray(s.tools) ? s.tools.length : 0,
  };
}
