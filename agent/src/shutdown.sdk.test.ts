// Review M2 item 9: stopping the Windows scheduled task (TerminateProcess on supervisor.mjs) must not leave
// Claude Code processes behind. Runs the built agent (npm run build -w agent) with the real SDK against an
// in-process hub. Opt-in, Windows only: AGENT_HUB_REAL_SDK=1.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionView } from '@agent-hub/shared';
import { PUBLIC_URL, startTestHub, waitFor, type TestHub } from '../../hub/src/test/harness.js';
import { encodeCwd } from './transcripts/tailer.js';

const RUN = process.env.AGENT_HUB_REAL_SDK === '1' && process.platform === 'win32';
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));

interface Proc {
  ProcessId: number;
  ParentProcessId: number;
  Name: string;
}

function processes(): Proc[] {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out) as Proc[];
}

function descendants(root: number): Proc[] {
  const all = processes();
  const out: Proc[] = [];
  const queue = [root];
  while (queue.length) {
    const pid = queue.shift()!;
    for (const p of all) {
      if (p.ParentProcessId === pid && !out.some(o => o.ProcessId === p.ProcessId)) {
        out.push(p);
        queue.push(p.ProcessId);
      }
    }
  }
  return out;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(!RUN)('stopping the task leaves no Claude Code processes (Windows)', () => {
  let t: TestHub;
  let sup: ChildProcess;
  let cwd: string;
  let cookie: string;
  beforeAll(async () => {
    if (!existsSync(join(DIST, 'supervisor.mjs'))) throw new Error('build the agent first: npm run build -w agent');
    t = await startTestHub();
    const token = await t.addRunner('hp', 'HP');
    cookie = await t.login();
    cwd = mkdtempSync(join(tmpdir(), 'agenthub-stop-'));
    sup = spawn(process.execPath, [join(DIST, 'supervisor.mjs')], {
      env: { ...process.env, HUB_URL: `${t.wsBase}/ws/agent`, AGENT_TOKEN: token, AGENT_LOG_FILE: join(cwd, 'agent.log'), SUPERVISOR_ENTRY: join(DIST, 'agent.mjs'), REPL_MAX_BYTES_PER_SEC: '1' },
      stdio: 'ignore',
    });
    await waitFor(() => t.hub.agents.isOnline('hp'), 20_000);
  });
  afterAll(async () => {
    if (sup.exitCode === null) sup.kill('SIGKILL');
    await t.close();
    for (const p of [cwd, join(homedir(), '.claude', 'projects', encodeCwd(cwd))]) {
      try {
        rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
      } catch {
        // left in %TEMP%
      }
    }
  });

  it('kill of the supervisor ends the agent and the session process within 10 s', { timeout: 180_000 }, async () => {
    const r = await t.hub.app.inject({
      method: 'POST',
      url: '/api/sessions',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { runnerId: 'hp', cwd, model: 'haiku', prompt: 'Ответь одним словом: да.' },
    });
    expect(r.statusCode).toBe(201);
    const s = r.json() as SessionView;
    await waitFor(async () => (await t.tdb.pool.query(`SELECT status FROM sessions WHERE id = $1`, [s.id])).rows[0]?.status === 'waiting', 120_000, 500);
    const tree = descendants(sup.pid!);
    const claude = tree.filter(p => /claude/i.test(p.Name));
    expect(claude.length).toBeGreaterThan(0); // the session process exists
    sup.kill('SIGKILL'); // TerminateProcess, like Stop-ScheduledTask
    await waitFor(() => tree.every(p => !alive(p.ProcessId)), 10_000, 200);
  });
});
