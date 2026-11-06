// Self-update (change `multi-user`, requirement «Самообновление агента», design M5).
//
// Layout of the app directory (~/.agent-hub/app), shared with supervisor.ts:
//   versions/<version>/   agent.mjs, cli.mjs, supervisor.mjs, package.json, node_modules (one dir per build)
//   current               name of the version the supervisor starts (absent: legacy app/agent.mjs)
//   next                  version staged by this updater; the supervisor tries it once
//   update-result.json    written by the supervisor after a rollback; reported by the agent after welcome
//
// agent.update → wait until the agent is not busy — turns and background tasks, specs/agent-busy (≤ 2 h) → download → SHA-256 → extract → npm install → `next` →
// agent.update.result `installing` → stop and exit. The supervisor starts `next`; the new agent sends {type:'ready'}
// over IPC after welcome and becomes `current`; an exit or no ready within the timeout rolls back to `current`.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { HubMessage, PayloadOf } from '@agent-hub/shared';
import type { Logger } from './log.js';
import { extractTgz } from './tar.js';

export type UpdatePayload = PayloadOf<HubMessage, 'agent.update'>;
export type UpdateResult = { version: string; status: 'waiting' | 'installing' | 'failed'; error?: string };

export const UPDATE_MAX_WAIT_MS = 2 * 3600_000;
export const RESULT_FILE = 'update-result.json';

export interface UpdaterOptions {
  /** ~/.agent-hub/app; null — not started by the supervisor (legacy systemd unit): updates are refused. */
  appDir: string | null;
  /** https://host (httpBase of HUB_URL). */
  hubHttp: string;
  currentVersion: string;
  send: (type: string, payload: unknown) => boolean;
  isBusy: () => boolean;
  /** Stops sessions and the connection, then ends the process (the supervisor starts `next`). */
  restart: () => Promise<void>;
  log: Logger;
  fetchImpl?: typeof fetch;
  /** npm install --omit=dev in the new version dir. */
  npmInstall?: (dir: string) => Promise<void>;
  pollMs?: number;
  maxWaitMs?: number;
}

/** npm-cli.js next to the running node (official archives: lib/node_modules/npm on unix, node_modules/npm on Windows). */
export function npmCli(execPath = process.execPath): string | null {
  const d = dirname(execPath);
  for (const p of [join(d, 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(d, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]) {
    if (existsSync(p)) return p;
  }
  return null;
}

export const defaultNpmInstall = (dir: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const cli = npmCli();
    const [file, args] = cli
      ? [process.execPath, [cli, 'install', '--omit=dev', '--no-audit', '--no-fund']]
      : [process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund']];
    execFile(file, args, { cwd: dir, timeout: 15 * 60_000, windowsHide: true, shell: !cli && process.platform === 'win32', maxBuffer: 8 << 20 }, (err, _o, stderr) =>
      err ? reject(new Error(`npm install failed: ${String(stderr).slice(-400) || err.message}`)) : resolve(),
    );
  });

export class Updater {
  private running: string | null = null;
  private pending: UpdatePayload | null = null;
  private acceptingReplacement = false;
  private readonly o: UpdaterOptions;

  constructor(o: UpdaterOptions) {
    this.o = o;
  }

  get inProgress(): string | null {
    return this.running;
  }

  /** After welcome: a rollback the supervisor did before this start is reported to the hub. */
  reportPending(): void {
    if (!this.o.appDir) return;
    const f = join(this.o.appDir, RESULT_FILE);
    if (!existsSync(f)) return;
    try {
      const r = JSON.parse(readFileSync(f, 'utf8')) as UpdateResult;
      if (r && typeof r.version === 'string' && this.o.send('agent.update.result', { version: r.version, status: 'failed', error: String(r.error ?? 'start_failed').slice(0, 500) })) {
        rmSync(f, { force: true });
      }
    } catch {
      rmSync(f, { force: true });
    }
  }

  /** Handles agent.update; resolves when the attempt ended (restart requested or failed). */
  async handle(p: UpdatePayload): Promise<void> {
    const { log } = this.o;
    if (this.running) {
      if (this.acceptingReplacement) this.pending = p;
      return;
    }
    if (p.version === this.o.currentVersion) return;
    this.running = p.version;
    this.acceptingReplacement = true;
    let offer = p;
    const fail = (error: string, detail?: string) => {
      log.warn('agent update failed', { version: offer.version, error, detail });
      this.o.send('agent.update.result', { version: offer.version, status: 'failed', error: detail ? `${error}: ${detail}`.slice(0, 500) : error });
    };
    try {
      if (!this.o.appDir) return fail('not_supervised', 'the agent is not started by supervisor.mjs; re-run the installer');
      // One deadline for both waits (before the download and before the restart): ≤ 2 h in total.
      const deadline = Date.now() + (this.o.maxWaitMs ?? UPDATE_MAX_WAIT_MS);
      let waitingSent = false;
      const idle = async (): Promise<boolean> => {
        if (!this.o.isBusy()) return true;
        if (!waitingSent) this.o.send('agent.update.result', { version: offer.version, status: 'waiting' });
        waitingSent = true;
        while (this.o.isBusy()) {
          if (Date.now() > deadline) return false;
          await new Promise(r => setTimeout(r, this.o.pollMs ?? 5000));
        }
        if (this.pending) {
          offer = this.pending;
          this.pending = null;
          this.running = offer.version;
        }
        return true;
      };
      if (!(await idle())) return fail('busy_timeout');
      this.acceptingReplacement = false;
      let body: Buffer;
      try {
        const res = await (this.o.fetchImpl ?? fetch)(`${this.o.hubHttp}${offer.url}`);
        if (!res.ok) return fail('download_failed', `hub answered ${res.status}`);
        body = Buffer.from(await res.arrayBuffer());
      } catch (err) {
        return fail('download_failed', (err as Error).message);
      }
      const sha = createHash('sha256').update(body).digest('hex');
      if (sha !== offer.sha256) return fail('sha_mismatch', `expected ${offer.sha256}, got ${sha}`);

      const versions = join(this.o.appDir, 'versions');
      const tmp = join(versions, `${offer.version}.tmp`);
      const dir = join(versions, offer.version);
      try {
        rmSync(tmp, { recursive: true, force: true });
        const files = extractTgz(body, tmp);
        if (!files.includes('agent.mjs') || !files.includes('package.json')) throw new Error('agent.mjs or package.json missing in the build');
        await (this.o.npmInstall ?? defaultNpmInstall)(tmp);
        rmSync(dir, { recursive: true, force: true });
        renameSync(tmp, dir);
      } catch (err) {
        rmSync(tmp, { recursive: true, force: true });
        return fail('install_failed', (err as Error).message);
      }
      // A turn may have started during the download and npm install: the restart would cut it off. Not staged then:
      // versions/<v> goes (it is not `current` — p.version differs), the next offer downloads it again.
      if (!(await idle())) {
        rmSync(dir, { recursive: true, force: true });
        return fail('busy_timeout');
      }
      writeFileSync(join(this.o.appDir, 'next'), offer.version);
      this.o.send('agent.update.result', { version: offer.version, status: 'installing' });
      log.info('agent update staged, restarting', { version: offer.version });
      await this.o.restart();
    } finally {
      this.running = null;
      this.pending = null;
      this.acceptingReplacement = false;
    }
  }
}
