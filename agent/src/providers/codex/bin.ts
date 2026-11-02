// Where the Codex CLI is (change agent-providers, design D5): AGENT_CODEX_BIN, else the @openai/codex package installed
// next to the agent from its runtime manifest. No CLI — the machine reports no Codex.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export interface CodexBin {
  command: string;
  args: string[];
  /** `codex --version` of the package, or null when unknown. */
  version: string | null;
}

function fromPath(path: string): CodexBin {
  // the npm launcher is a JS file: run it with this Node (no PATH lookup, works on Windows without a .cmd shim)
  return /\.(c|m)?js$/i.test(path) ? { command: process.execPath, args: [path], version: null } : { command: path, args: [], version: null };
}

export function findCodexBin(env: NodeJS.ProcessEnv = process.env): CodexBin | null {
  const override = env.AGENT_CODEX_BIN?.trim();
  if (override) return existsSync(override) ? fromPath(override) : null;
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve('@openai/codex/package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string; bin?: { codex?: string } };
    const launcher = join(dirname(pkgPath), pkg.bin?.codex ?? 'bin/codex.js');
    if (!existsSync(launcher)) return null;
    return { ...fromPath(launcher), version: pkg.version ?? null };
  } catch {
    return null;
  }
}

/** `codex --version` → «0.166.0»; null when the CLI does not run (no platform binary). */
export function codexVersion(bin: CodexBin, timeoutMs = 20_000): Promise<string | null> {
  return new Promise(resolve => {
    execFile(bin.command, [...bin.args, '--version'], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const m = /(\d+\.\d+\.\d+\S*)/.exec(String(stdout));
      resolve(m ? m[1]! : null);
    });
  });
}
