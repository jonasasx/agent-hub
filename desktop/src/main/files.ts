/** Files of `%APPDATA%\Agent Hub` (userData): config, window state, log. */
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app } from 'electron';

export function userFile(name: string): string {
  return join(app.getPath('userData'), name);
}

export function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Atomic write: temp file next to the target, then rename. */
export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}

const LOG_LIMIT = 1024 * 1024;
let logPath: string | null = null;

/** `main.log` in userData; restarted when larger than 1 MB. Never logs cookies or codes. */
export function log(line: string): void {
  try {
    if (!logPath) {
      logPath = userFile('main.log');
      mkdirSync(dirname(logPath), { recursive: true });
      try {
        if (statSync(logPath).size > LOG_LIMIT) writeFileSync(logPath, '');
      } catch {
        /* no file yet */
      }
    }
    appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* logging must never break the app */
  }
  if (!app.isPackaged) console.log(line);
}
