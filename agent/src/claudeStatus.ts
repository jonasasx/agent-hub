// Claude Code subscription login on this machine (change `multi-user`, design M4).
// Requirement: Установщик («Нет входа в Claude»); Экран «Машины» («Нет входа в Claude»).
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { ClaudeStatus } from '@agent-hub/shared';

export interface RunResult {
  code: number | null;
  stdout: string;
}
export type RunFn = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<RunResult>;

/** Runs a command without a shell (`.cmd` on Windows needs one), 20 s at most, stdin closed. */
export const runCommand: RunFn = (file, args, env) =>
  new Promise(resolve => {
    execFile(file, args, { env, timeout: 20_000, windowsHide: true, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(file), maxBuffer: 1 << 20 }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null) : 0;
      resolve({ code, stdout: String(stdout ?? '') });
    }).stdin?.end();
  });

/**
 * `claude` of the machine: PATH first, then the official installer's place (~/.local/bin). null — not installed
 * (sessions still run on the binary bundled with the Agent SDK, but the login cannot be checked).
 */
export function findClaude(env: NodeJS.ProcessEnv = process.env, home = homedir(), platform = process.platform): string | null {
  const names = platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean);
  dirs.push(join(home, '.local', 'bin'));
  for (const d of dirs) for (const n of names) if (existsSync(join(d, n))) return join(d, n);
  return null;
}

/**
 * `ok` — CLAUDE_CODE_OAUTH_TOKEN is set (the agent's sessions use it, design M5) or `claude auth status --json` says
 * loggedIn; `missing` otherwise. `version` from `claude --version`.
 */
export async function checkClaude(o: { claudePath: string | null; env?: NodeJS.ProcessEnv; run?: RunFn }): Promise<ClaudeStatus> {
  const env = o.env ?? process.env;
  const run = o.run ?? runCommand;
  const hasToken = Boolean(env.CLAUDE_CODE_OAUTH_TOKEN);
  if (!o.claudePath) return { login: hasToken ? 'ok' : 'missing', version: null };
  const v = await run(o.claudePath, ['--version'], env);
  const version = v.code === 0 ? (/(\d+\.\d+\.\d+\S*)/.exec(v.stdout)?.[1] ?? (v.stdout.trim().slice(0, 100) || null)) : null;
  if (hasToken) return { login: 'ok', version };
  const s = await run(o.claudePath, ['auth', 'status', '--json'], env);
  let loggedIn: boolean;
  try {
    loggedIn = (JSON.parse(s.stdout) as { loggedIn?: unknown }).loggedIn === true;
  } catch {
    loggedIn = false;
  }
  return { login: loggedIn ? 'ok' : 'missing', version };
}

/** An error text of a turn that means the subscription login is gone (expired token, logged out). */
export function isAuthError(text: string | undefined | null): boolean {
  if (!text) return false;
  return /authentication_error|authentication_failed|invalid api key|oauth token (has )?(expired|revoked)|not logged in|please run \/login|\b401\b.*(unauthori[sz]ed|authentication)|unauthori[sz]ed.*\b401\b/i.test(
    text,
  );
}
