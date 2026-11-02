// Windows task launcher: a crashed agent is restarted; terminating the supervisor (what Task Scheduler
// does on Stop-ScheduledTask) takes the agent down with it.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DIR = fileURLToPath(new URL(`../../node_modules/.cache/agent-hub-test-supervisor/${process.pid}`, import.meta.url));
const LOG = `${DIR}/agent.log`;
const FIXTURE = `${DIR}/fake-agent.mjs`;
const SUP_ARGS = ['--experimental-strip-types', '--no-warnings'];
const SUPERVISOR = fileURLToPath(new URL('./supervisor.ts', import.meta.url));

// Same parent-death handling as main.ts.
const FIXTURE_SRC = `
import { writeFileSync } from 'node:fs';
if (process.send) process.on('disconnect', () => process.exit(0));
if (process.env.FAKE_PID_FILE) writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
console.log(JSON.stringify({ msg: 'fake agent up', pid: process.pid }));
const noise = 'x'.repeat(Number(process.env.FAKE_NOISE_BYTES ?? 0));
setInterval(() => { if (noise) console.log(noise); }, 50);
`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function childPids(): number[] {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, 'utf8')
    .split('\n')
    .filter(l => l.includes('supervisor: agent started'))
    .map(l => (JSON.parse(l) as { pid: number }).pid);
}

async function until<T>(fn: () => T | undefined | false, ms: number): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 50));
  }
}

describe('supervisor', () => {
  let sup: ChildProcess;
  beforeAll(() => {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(FIXTURE, FIXTURE_SRC);
    sup = spawn(process.execPath, [...SUP_ARGS, SUPERVISOR], {
      env: { ...process.env, SUPERVISOR_ENTRY: FIXTURE, AGENT_LOG_FILE: LOG, SUPERVISOR_RESTART_DELAY_MS: '300' },
      stdio: 'ignore',
    });
  });
  afterAll(() => {
    if (sup.exitCode === null) sup.kill('SIGKILL');
    rmSync(DIR, { recursive: true, force: true });
  });

  it('starts the agent and logs its output', async () => {
    const [pid] = await until(() => (childPids().length ? childPids() : false), 10_000);
    expect(alive(pid!)).toBe(true);
    await until(() => readFileSync(LOG, 'utf8').includes('fake agent up'), 5000);
  });

  it('restarts a killed agent after the pause', async () => {
    const first = childPids()[0]!;
    process.kill(first, 'SIGKILL');
    const second = await until(() => childPids().find(p => p !== first), 5000);
    expect(alive(second)).toBe(true);
    expect(readFileSync(LOG, 'utf8')).toContain('agent exited, restarting');
  });

  it('a hard-terminated supervisor takes the agent down (no orphan)', async () => {
    const current = childPids().at(-1)!;
    expect(alive(current)).toBe(true);
    sup.kill('SIGKILL'); // TerminateProcess on Windows, like Stop-ScheduledTask
    await until(() => !alive(current), 5000);
    await new Promise(r => setTimeout(r, 700)); // longer than the restart pause
    expect(childPids().at(-1)).toBe(current); // nothing was restarted
  });
});

describe('supervisor log handling', () => {
  const procs: ChildProcess[] = [];
  const startSup = (env: Record<string, string>) => {
    const p = spawn(process.execPath, [...SUP_ARGS, SUPERVISOR], {
      env: { ...process.env, SUPERVISOR_ENTRY: FIXTURE, SUPERVISOR_RESTART_DELAY_MS: '300', ...env },
      stdio: 'ignore',
    });
    procs.push(p);
    return p;
  };
  beforeAll(() => {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(FIXTURE, FIXTURE_SRC);
  });
  afterAll(() => {
    for (const p of procs) if (p.exitCode === null) p.kill('SIGKILL');
  });

  it('rotates the log on a timer while the agent keeps running (no restart needed)', async () => {
    const log = `${DIR}/rot/agent.log`;
    const pidFile = `${DIR}/rot/pid`;
    mkdirSync(`${DIR}/rot`, { recursive: true });
    startSup({ AGENT_LOG_FILE: log, FAKE_PID_FILE: pidFile, FAKE_NOISE_BYTES: '400', SUPERVISOR_ROTATE_BYTES: '4000', SUPERVISOR_ROTATE_CHECK_MS: '100' });
    const pid = Number(await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8'), 10_000));
    await until(() => existsSync(`${log}.1`), 10_000);
    // The same agent process keeps writing into the fresh file after rotation.
    await until(() => existsSync(log) && readFileSync(log, 'utf8').includes('xxxx'), 5000);
    expect(alive(pid)).toBe(true);
    expect(Number(readFileSync(pidFile, 'utf8'))).toBe(pid);
  });

  it('starts the agent even when the log cannot be opened', async () => {
    const blocked = `${DIR}/blocked`;
    mkdirSync(blocked, { recursive: true }); // a directory where the log file should be: open fails
    const pidFile = `${DIR}/blocked-pid`;
    startSup({ AGENT_LOG_FILE: blocked, FAKE_PID_FILE: pidFile, SUPERVISOR_ROTATE_CHECK_MS: '100' });
    const pid = Number(await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8'), 10_000));
    expect(alive(pid)).toBe(true);
  });
});

// change `multi-user` 5.2: a staged version (app/next) is started once and becomes current on {type:'ready'};
// an exit before ready rolls back to current and leaves update-result.json for the old agent.
describe('supervisor self-update', () => {
  const procs: ChildProcess[] = [];
  const AGENT_SRC = (name: string, behaviour: 'ready' | 'crash' | 'silent') => `
import { appendFileSync } from 'node:fs';
if (process.send) process.on('disconnect', () => process.exit(0));
appendFileSync(process.env.RUNS_FILE, '${name} ' + (process.env.AGENT_HUB_APP_DIR ? 'appdir' : 'noappdir') + String.fromCharCode(10));
${behaviour === 'crash' ? 'process.exit(1);' : ''}
${behaviour === 'ready' ? "setTimeout(() => process.send && process.send({ type: 'ready' }), 100);" : ''}
setInterval(() => undefined, 1000);
`;
  const layout = (root: string, next: { v: string; behaviour: 'ready' | 'crash' | 'silent' }) => {
    for (const [v, b] of [
      ['0.1.0', 'ready'],
      [next.v, next.behaviour],
    ] as const) {
      mkdirSync(`${root}/versions/${v}`, { recursive: true });
      writeFileSync(`${root}/versions/${v}/agent.mjs`, AGENT_SRC(v, b));
      writeFileSync(`${root}/versions/${v}/cli.mjs`, `// cli ${v}`);
    }
    mkdirSync(`${root}/versions/0.0.9`, { recursive: true });
    writeFileSync(`${root}/current`, '0.1.0');
    writeFileSync(`${root}/next`, next.v);
  };
  const startSup = (root: string, extra: Record<string, string> = {}) => {
    const p = spawn(process.execPath, [...SUP_ARGS, SUPERVISOR], {
      env: {
        ...process.env,
        SUPERVISOR_ENTRY: '',
        SUPERVISOR_APP_DIR: root,
        AGENT_LOG_FILE: `${root}/agent.log`,
        RUNS_FILE: `${root}/runs`,
        SUPERVISOR_RESTART_DELAY_MS: '200',
        ...extra,
      },
      stdio: 'ignore',
    });
    procs.push(p);
    return p;
  };
  const runs = (root: string) => (existsSync(`${root}/runs`) ? readFileSync(`${root}/runs`, 'utf8').trim().split('\n') : []);
  afterAll(() => {
    for (const p of procs) if (p.exitCode === null) p.kill('SIGKILL');
  });

  it('a ready new version becomes current; old versions except the previous are pruned; cli.mjs is refreshed', async () => {
    const root = `${DIR}/upd-ok`;
    layout(root, { v: '0.2.0', behaviour: 'ready' });
    startSup(root);
    await until(() => existsSync(`${root}/current`) && readFileSync(`${root}/current`, 'utf8') === '0.2.0', 25_000).catch((e: Error) => {
      throw new Error(`${e.message}; supervisor log: ${existsSync(`${root}/agent.log`) ? readFileSync(`${root}/agent.log`, 'utf8') : '(none)'}`);
    });
    expect(existsSync(`${root}/next`)).toBe(false);
    expect(existsSync(`${root}/versions/0.1.0`)).toBe(true);
    expect(existsSync(`${root}/versions/0.0.9`)).toBe(false);
    expect(readFileSync(`${root}/cli.mjs`, 'utf8')).toBe('// cli 0.2.0');
    expect(runs(root)).toEqual(['0.2.0 appdir']);
    expect(existsSync(`${root}/update-result.json`)).toBe(false);
  });

  it('a new version that exits before ready is rolled back: the old one runs, the failure is left for the hub', async () => {
    const root = `${DIR}/upd-crash`;
    layout(root, { v: '0.2.0', behaviour: 'crash' });
    startSup(root);
    await until(() => runs(root).includes('0.1.0 appdir'), 25_000);
    expect(runs(root)[0]).toBe('0.2.0 appdir');
    expect(readFileSync(`${root}/current`, 'utf8')).toBe('0.1.0');
    expect(existsSync(`${root}/next`)).toBe(false);
    expect(existsSync(`${root}/versions/0.2.0`)).toBe(false);
    const r = JSON.parse(readFileSync(`${root}/update-result.json`, 'utf8')) as { version: string; status: string; error: string };
    expect(r).toMatchObject({ version: '0.2.0', status: 'failed' });
    expect(r.error).toMatch(/^start_failed/);
  });

  it('a staged name «..» is not a version: dropped, current runs, app/agent.mjs (versions/..) is never started', async () => {
    const root = `${DIR}/upd-dotdot`;
    layout(root, { v: '0.2.0', behaviour: 'ready' });
    writeFileSync(`${root}/agent.mjs`, AGENT_SRC('dotdot', 'ready'));
    writeFileSync(`${root}/next`, '..');
    startSup(root);
    await until(() => runs(root).includes('0.1.0 appdir'), 25_000);
    expect(runs(root)).toEqual(['0.1.0 appdir']);
    expect(existsSync(`${root}/next`)).toBe(false);
    expect(readFileSync(`${root}/current`, 'utf8')).toBe('0.1.0');
  });

  it('a new version that never says ready is killed after the timeout and rolled back', async () => {
    const root = `${DIR}/upd-silent`;
    layout(root, { v: '0.2.0', behaviour: 'silent' });
    startSup(root, { SUPERVISOR_READY_TIMEOUT_MS: '700' });
    await until(() => runs(root).includes('0.1.0 appdir'), 25_000);
    expect(readFileSync(`${root}/current`, 'utf8')).toBe('0.1.0');
    expect(readFileSync(`${root}/update-result.json`, 'utf8')).toContain('no ready within the timeout');
  });
});
