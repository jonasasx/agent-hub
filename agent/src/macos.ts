// macOS specifics (change `multi-user`, requirement «macOS»): TCC-protected folders and sleep during a turn.
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProtectedDirs } from '@agent-hub/shared';
import type { Logger } from './log.js';

export const PROTECTED_DIRS = ['Documents', 'Desktop', 'Downloads'];

/**
 * `denied` when any of ~/Documents, ~/Desktop, ~/Downloads cannot be listed (no Full Disk Access for the agent's node);
 * a missing folder does not count. `n/a` outside macOS.
 */
export function checkProtectedDirs(o: { platform?: NodeJS.Platform; home?: string; readdir?: (p: string) => unknown } = {}): ProtectedDirs {
  if ((o.platform ?? process.platform) !== 'darwin') return 'n/a';
  const home = o.home ?? homedir();
  const readdir = o.readdir ?? ((p: string) => readdirSync(p));
  for (const d of PROTECTED_DIRS) {
    try {
      readdir(join(home, d));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') return 'denied';
    }
  }
  return 'ok';
}

export type SpawnFn = (cmd: string, args: string[]) => ChildProcess;

/**
 * Holds `caffeinate -i` while the agent is busy: a turn or background work of a session process (specs/agent-busy of
 * change update-waits-background-tasks; requirement «Mac засыпает посреди хода»): the idle sleep is prevented, the
 * display may still turn off. `-w <pid>` ends caffeinate with the agent, so a crashed agent never keeps the Mac awake.
 * Does nothing outside macOS.
 */
export class Caffeinator {
  private child: ChildProcess | null = null;
  private readonly enabled: boolean;
  private readonly spawnFn: SpawnFn;
  private readonly pid: number;
  private readonly log: Logger | undefined;

  constructor(o: { platform?: NodeJS.Platform; spawn?: SpawnFn; pid?: number; log?: Logger } = {}) {
    this.enabled = (o.platform ?? process.platform) === 'darwin';
    this.spawnFn = o.spawn ?? ((cmd, args) => nodeSpawn(cmd, args, { stdio: 'ignore' }));
    this.pid = o.pid ?? process.pid;
    this.log = o.log;
  }

  get active(): boolean {
    return this.child !== null;
  }

  setBusy(busy: boolean): void {
    if (!this.enabled) return;
    if (busy && !this.child) {
      try {
        const c = this.spawnFn('/usr/bin/caffeinate', ['-i', '-w', String(this.pid)]);
        this.child = c;
        c.on('error', err => {
          this.log?.warn('caffeinate failed', { error: err.message });
          if (this.child === c) this.child = null;
        });
        c.on('exit', () => {
          if (this.child === c) this.child = null;
        });
      } catch (err) {
        this.log?.warn('caffeinate failed', { error: (err as Error).message });
        this.child = null;
      }
    } else if (!busy && this.child) {
      const c = this.child;
      this.child = null;
      c.kill();
    }
  }
}
