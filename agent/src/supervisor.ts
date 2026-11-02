// Windows launcher for the scheduled task (design.md D17): `node --env-file=agent.env supervisor.mjs`.
//
// Task Scheduler stops a task by terminating its action process only; children survive. So the agent is
// forked with an IPC channel: when this supervisor is terminated the channel breaks and the agent exits
// on 'disconnect' (handler in main.ts). When the agent exits, it is restarted after a pause.
//
// The agent's stdout/stderr come through pipes and are appended to the log here, so the log can be rotated
// at any moment (a timer checks the size), not only when the agent restarts: a file descriptor handed to
// the child would keep writing into the renamed file. A log that cannot be opened (locked, disk full) never
// stops the agent: its output is dropped and opening is retried on the next tick.
//
// Self-update (change `multi-user`, design M5; layout in updater.ts): the agent runs from app/versions/<current>/.
// A version staged in app/next is started once; it becomes current when it sends {type:'ready'} over IPC (after the
// hub's welcome). If it exits first or stays silent for SUPERVISOR_READY_TIMEOUT_MS, the supervisor rolls back to
// current and leaves app/update-result.json for the old agent to report. The supervisor itself never moves files
// it runs from (a directory with a running process cannot be renamed on Windows).
import { fork, type ChildProcess } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
/** Tests: a fixed entry, no versions. */
const FIXED_ENTRY = process.env.SUPERVISOR_ENTRY;
const APP = process.env.SUPERVISOR_APP_DIR ?? here;
const READY_TIMEOUT_MS = Number(process.env.SUPERVISOR_READY_TIMEOUT_MS ?? 180_000);
/** Copied from a promoted version into the app dir: the next supervisor start and `agent-hub` use them. */
const STABLE_FILES = ['supervisor.mjs', 'supervisor.mjs.map', 'cli.mjs', 'cli.mjs.map'];
// Default: <state>/agent.log next to <state>/app, where the installer puts this file.
const LOG = process.env.AGENT_LOG_FILE ?? join(here, '..', 'agent.log');
const RESTART_DELAY_MS = Number(process.env.SUPERVISOR_RESTART_DELAY_MS ?? 5000);
const ROTATE_BYTES = Number(process.env.SUPERVISOR_ROTATE_BYTES ?? 10 * 1024 * 1024);
const ROTATE_CHECK_MS = Number(process.env.SUPERVISOR_ROTATE_CHECK_MS ?? 60_000);

let child: ChildProcess | null = null;
let stopping = false;
let timer: NodeJS.Timeout | null = null;
/** The version from app/next being started now (not yet ready). */
let trying: string | null = null;
let readyTimer: NodeJS.Timeout | null = null;
let timedOut = false;

/**
 * Semver, the same as AGENT_VERSION_RE in shared/src/protocol.ts (copied: the supervisor has no dependencies). The
 * name becomes a path under app/versions/, so `..`, `/` and `\` never pass.
 */
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function readName(file: string): string | null {
  try {
    const v = readFileSync(join(APP, file), 'utf8').trim();
    return VERSION_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

function versionEntry(v: string | null): string | null {
  if (!v) return null;
  const p = join(APP, 'versions', v, 'agent.mjs');
  return existsSync(p) ? p : null;
}

/** Entry to start now: a staged update first, then current, then the layout before self-update (app/agent.mjs). */
function resolveEntry(): { entry: string; trying: string | null } {
  if (FIXED_ENTRY) return { entry: FIXED_ENTRY, trying: null };
  const next = readName('next');
  const nextEntry = versionEntry(next);
  if (next && nextEntry) return { entry: nextEntry, trying: next };
  // A staged name that is not a version or has no build: dropped, current runs.
  rmSync(join(APP, 'next'), { force: true });
  return { entry: versionEntry(readName('current')) ?? join(APP, 'agent.mjs'), trying: null };
}

/**
 * Atomic replace of app/current. On Windows the rename fails while another process has the file open (a reader of
 * `current`): retried, then written in place.
 */
function writeCurrent(v: string): void {
  const tmp = join(APP, 'current.tmp');
  writeFileSync(tmp, v);
  for (let i = 0; i < 20; i++) {
    try {
      renameSync(tmp, join(APP, 'current'));
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  writeFileSync(join(APP, 'current'), v);
  rmSync(tmp, { force: true });
}

/** The new version answered: it becomes current; older versions except the previous one are removed. */
function promote(v: string): void {
  const prev = readName('current');
  try {
    writeCurrent(v);
    rmSync(join(APP, 'next'), { force: true });
    rmSync(join(APP, 'update-result.json'), { force: true });
  } catch (err) {
    note('could not promote the update', { version: v, error: (err as Error).message });
    return;
  }
  for (const f of STABLE_FILES) {
    try {
      const src = join(APP, 'versions', v, f);
      if (existsSync(src)) copyFileSync(src, join(APP, f));
    } catch {
      // best effort: the previous copy keeps working
    }
  }
  try {
    for (const d of readdirSync(join(APP, 'versions'))) {
      if (d !== v && d !== prev) rmSync(join(APP, 'versions', d), { recursive: true, force: true });
    }
  } catch {
    // nothing to prune
  }
  note('update promoted', { version: v, previous: prev });
}

function rollback(v: string, why: string): void {
  rmSync(join(APP, 'next'), { force: true });
  try {
    writeFileSync(join(APP, 'update-result.json'), JSON.stringify({ version: v, status: 'failed', error: `start_failed: ${why}` }));
  } catch {
    // the hub will see the old version anyway
  }
  if (readName('current') !== v) rmSync(join(APP, 'versions', v), { recursive: true, force: true });
  note('update rolled back', { version: v, why });
}

/** Append-only log file with rotation; every failure degrades to dropping output, never to a crash. */
class LogSink {
  private fd: number | null = null;
  private written = 0;
  private readonly path: string;

  // No parameter properties: the test runs this file with node --experimental-strip-types.
  constructor(path: string) {
    this.path = path;
  }

  write(chunk: Buffer | string): void {
    if (this.fd === null) this.open();
    if (this.fd === null) return; // log unavailable: the output is dropped ('ignore'), retried on the next tick
    try {
      const n = typeof chunk === 'string' ? writeSync(this.fd, chunk) : writeSync(this.fd, chunk);
      this.written += n;
      if (this.written > ROTATE_BYTES) this.rotate();
    } catch {
      this.close();
    }
  }

  /** Called by the timer: rotates an oversized file and reopens a log that failed to open. */
  tick(): void {
    if (this.fd === null) this.open();
    else this.rotate();
  }

  rotate(): void {
    try {
      if (!existsSync(this.path) || statSync(this.path).size <= ROTATE_BYTES) return;
      this.close();
      renameSync(this.path, `${this.path}.1`);
    } catch {
      // keep appending to the current file
    }
    if (this.fd === null) this.open();
  }

  close(): void {
    if (this.fd === null) return;
    try {
      closeSync(this.fd);
    } catch {
      // already closed
    }
    this.fd = null;
  }

  private open(): void {
    try {
      this.fd = openSync(this.path, 'a');
      this.written = statSync(this.path).size;
    } catch {
      this.fd = null;
    }
  }
}

const sink = new LogSink(LOG);

function note(msg: string, fields: Record<string, unknown> = {}): void {
  sink.write(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: `supervisor: ${msg}`, ...fields }) + '\n');
}

function scheduleRestart(): void {
  if (stopping || timer) return;
  timer = setTimeout(start, RESTART_DELAY_MS);
}

function start(): void {
  timer = null;
  if (stopping) return;
  sink.rotate();
  const r = resolveEntry();
  trying = r.trying;
  timedOut = false;
  let c: ChildProcess;
  try {
    c = fork(r.entry, [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      execArgv: [],
      windowsHide: true,
      env: { ...process.env, AGENT_HUB_APP_DIR: APP },
    });
  } catch (err) {
    note('agent failed to start, retrying', { error: (err as Error).message, inMs: RESTART_DELAY_MS });
    if (trying) rollback(trying, (err as Error).message);
    trying = null;
    scheduleRestart();
    return;
  }
  child = c;
  if (trying) {
    note('starting a staged update', { version: trying, entry: r.entry });
    readyTimer = setTimeout(() => {
      readyTimer = null;
      if (child !== c || !trying) return;
      timedOut = true;
      note('the update did not become ready in time', { version: trying, ms: READY_TIMEOUT_MS });
      c.kill();
    }, READY_TIMEOUT_MS);
  }
  c.on('message', (m: unknown) => {
    if (child !== c || !m || typeof m !== 'object' || (m as { type?: unknown }).type !== 'ready') return;
    if (trying) {
      if (readyTimer) clearTimeout(readyTimer);
      readyTimer = null;
      promote(trying);
      trying = null;
    }
  });
  c.stdout?.on('data', (d: Buffer) => sink.write(d));
  c.stderr?.on('data', (d: Buffer) => sink.write(d));
  note('agent started', { pid: c.pid, supervisorPid: process.pid });
  // 'error' fires when spawning fails (missing entry, EMFILE) or a kill/send fails; without a listener it
  // would crash the supervisor. 'exit' may not follow a spawn failure, so the restart is scheduled here too.
  c.on('error', err => {
    note('agent process error', { error: err.message });
    if (c.exitCode === null && c.pid === undefined && child === c) {
      child = null;
      if (trying) rollback(trying, err.message);
      trying = null;
      scheduleRestart();
    }
  });
  c.on('exit', (code, signal) => {
    if (child === c) child = null;
    if (readyTimer) clearTimeout(readyTimer);
    readyTimer = null;
    if (trying) {
      rollback(trying, timedOut ? 'no ready within the timeout' : `exited with ${code ?? signal}`);
      trying = null;
    }
    if (stopping) return;
    note('agent exited, restarting', { code, signal, inMs: RESTART_DELAY_MS });
    scheduleRestart();
  });
}

function stop(signal: string): void {
  stopping = true;
  if (timer) clearTimeout(timer);
  note('stopping', { signal });
  const done = () => {
    sink.close();
    process.exit(0);
  };
  if (child) {
    child.once('exit', done);
    child.kill();
    setTimeout(done, 5000).unref();
  } else done();
}

try {
  mkdirSync(dirname(LOG), { recursive: true });
} catch {
  // the sink retries opening the log
}
setInterval(() => sink.tick(), ROTATE_CHECK_MS).unref();
// The supervisor stays alive through its child's pipes and IPC; this keeps it alive between restarts.
setInterval(() => undefined, 1 << 30);
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
start();
