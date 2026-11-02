// Task 4.3: limits.probe through the real Agent SDK (query, process spawn, stream-json) with a fake Claude Code CLI
// (fixtures/fake-claude.mjs): after the probe and after a timeout no child process stays alive, the token is not in
// argv, nothing is left in the scratch directory. No subscription is used: runs in every test run.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, describe, expect, it } from 'vitest';
import { createLogger } from '../log.js';
import { LimitsProber } from './probe.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const TOKEN = 'sk-ant-oat01-' + 'Fk3_-'.repeat(16) + 'SDKPROBE';
const SUB = { id: '3a7c1e2d-5b4f-4a6e-9c8d-7e6f5a4b3c2d', token: TOKEN };

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(fn: () => boolean, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return fn();
}

describe('limits.probe with the SDK and a fake CLI', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  function run(mode: 'ok' | 'hang' | 'limit' | 'auth', timeoutMs = 20_000) {
    const scratch = mkdtempSync(join(tmpdir(), 'agenthub-probe-'));
    const meta = mkdtempSync(join(tmpdir(), 'agenthub-probe-meta-'));
    dirs.push(scratch, meta);
    const pidFile = join(meta, 'pid');
    const lines: string[] = [];
    const prober = new LimitsProber({
      oneShotFn: p => query(p),
      log: createLogger({ level: 'debug', write: l => lines.push(l) }),
      extraOptions: { pathToClaudeCodeExecutable: FAKE, env: { ...process.env, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_PID_FILE: pidFile, AGENT_TOKEN: 'agent-secret-token-xyz' } },
      scratchDir: scratch,
      timeoutMs,
    });
    const child = () => {
      const [pid, argv, env] = readFileSync(pidFile, 'utf8').split('\n');
      return { pid: Number(pid), argv: argv!, env: env! };
    };
    return { prober, scratch, child, lines };
  }

  it('ok: the snapshot of the event; the process has ended; the token only in the env, not in argv nor logs', { timeout: 60_000 }, async () => {
    const t = run('ok');
    const r = await t.prober.probe({ subscription: SUB, model: 'haiku' });
    expect(r.outcome).toBe('ok');
    expect(r.snapshot!.windows.map(w => [w.type, w.utilization])).toEqual([
      ['five_hour', 11],
      ['seven_day', 34],
    ]);
    const c = t.child();
    expect(c.env).toBe('token-in-env');
    expect(c.argv).not.toContain(TOKEN);
    expect(c.argv).toContain('haiku');
    expect(await until(() => !alive(c.pid))).toBe(true);
    expect(readdirSync(t.scratch)).toEqual([]);
    expect(t.lines.join('\n')).not.toContain(TOKEN);
  });

  it('QA 10.2: an exhausted subscription — the CLI exits 1 after the error result, the SDK throws: still limit with the windows', { timeout: 60_000 }, async () => {
    const t = run('limit');
    const r = await t.prober.probe({ subscription: SUB, model: 'haiku' });
    expect(r).toMatchObject({ outcome: 'limit', resetsAt: new Date(1793264400_000).toISOString(), limitType: 'seven_day' });
    expect(r.message).toContain('weekly limit');
    expect(r.snapshot!.windows.map(w => [w.type, w.utilization])).toEqual([
      ['five_hour', 92],
      ['seven_day', 100],
    ]);
    expect(await until(() => !alive(t.child().pid))).toBe(true);
  });

  it('QA 10.2: a rejected token — 401, the CLI exits 1, the SDK throws: still auth_rejected', { timeout: 60_000 }, async () => {
    const t = run('auth');
    const r = await t.prober.probe({ subscription: SUB, model: 'haiku' });
    expect(r.outcome).toBe('auth_rejected');
    expect(t.lines.join('\n')).not.toContain(TOKEN);
  });

  it('a CLI that never answers: probe_timeout, the process is killed', { timeout: 60_000 }, async () => {
    const t = run('hang', 1500);
    await expect(t.prober.probe({ subscription: SUB, model: 'haiku' })).rejects.toMatchObject({ code: 'probe_timeout' });
    const c = t.child();
    expect(await until(() => !alive(c.pid))).toBe(true);
    expect(readdirSync(t.scratch)).toEqual([]);
  });
});
