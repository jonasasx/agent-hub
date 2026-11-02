// ~/.agent-hub/agent.env: KEY=VALUE lines read by `node --env-file`. Updates keep every other line (settings such as
// VAULT_ROOT survive a re-install with a new code). The file is rewritten in place so a Windows ACL set by the
// installer stays; on unix the mode is forced to 600.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!.trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

export function readEnvFile(path: string): Record<string, string> {
  return existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
}

/** Sets (string) or removes (null) keys; other lines are kept as they are. */
export function updateEnvFile(path: string, updates: Record<string, string | null>): void {
  for (const [k, v] of Object.entries(updates)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`bad env key ${k}`);
    if (v !== null && /[\r\n]/.test(v)) throw new Error(`bad env value for ${k}`);
  }
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const done = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    const key = m?.[1];
    if (key && key in updates) {
      if (done.has(key)) continue;
      done.add(key);
      const v = updates[key];
      if (v !== null && v !== undefined) out.push(`${key}=${v}`);
      continue;
    }
    out.push(line);
  }
  for (const [k, v] of Object.entries(updates)) if (!done.has(k) && v !== null) out.push(`${k}=${v}`);
  writeFileSync(path, out.join('\n') + '\n', { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}
