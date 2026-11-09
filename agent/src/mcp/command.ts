// Resolves a stdio MCP server command the way a shell would (change `mcp-hub-only`): servers imported from Claude Code
// and Codex configs use bare names (`npx`, `codegraph`) and npm `.cmd` shims, which Node's spawn finds on neither.
import { statSync } from 'node:fs';
import { extname, join } from 'node:path';

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function envValue(env: NodeJS.ProcessEnv, name: string, windows: boolean): string | undefined {
  if (!windows) return env[name];
  const key = Object.keys(env).find(k => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/**
 * Full path of the command file, or null when there is none. A command with a directory is checked as is; a bare name is
 * looked up in PATH. On Windows a name without a PATHEXT extension gets one (`npx` → `npx.cmd`), and the extensionless
 * sh shim npm puts next to the `.cmd` is skipped.
 */
export function resolveCommand(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string | null {
  const windows = platform === 'win32';
  const pathExt = (envValue(env, 'PATHEXT', windows) ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const hasExt = pathExt.some(ext => ext.toLowerCase() === extname(command).toLowerCase());
  const exts = windows && !hasExt ? pathExt : [''];
  const dirs = /[\\/]/.test(command) ? [''] : (envValue(env, 'PATH', windows) ?? '').split(windows ? ';' : ':').filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = dir ? join(dir, command + ext) : command + ext;
      if (isFile(file)) return file;
    }
  }
  return null;
}
