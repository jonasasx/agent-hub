// change `multi-user` 5.1, 5.5: `agent-hub enroll | login | claude-status` used by the installers.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ENROLL_MESSAGES, findSetupToken, runCli, STOP_APP_NODES_PS, type CliEnv } from './cli.js';
import { readEnvFile } from './envFile.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CODE = 'abcdefghijklmnopqrstuvwxyz'; // 26 base32 characters
const TOKEN = `sk-ant-oat01-${'A1b2_C3-'.repeat(12)}AA`;

function ctx(o: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; secret?: string } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'agent-hub-cli-'));
  dirs.push(stateDir);
  const out: string[] = [];
  const err: string[] = [];
  const c: CliEnv = {
    stateDir,
    env: { ...process.env, ...o.env },
    ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
    io: { out: s => void out.push(s), err: s => void err.push(s), readSecret: async () => o.secret ?? '' },
  };
  return { c, stateDir, out, err };
}

const answer = (status: number, body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

describe('agent-hub enroll (Requirement: Код подключения; Установщик)', () => {
  it('«Обмен кода»: writes HUB_URL and the token to agent.env, never prints the token, keeps other settings', async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (url: string, init: RequestInit) => {
      expect(url).toBe('https://agents.example/enroll');
      expect(init.method).toBe('POST');
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ runnerId: 'r-1', token: 'runner-token-0123456789abcdef', hubUrl: 'wss://agents.example/ws/agent', agentVersion: '0.2.0', agentUrl: null, agentSha256: null }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const { c, stateDir, out, err } = ctx({ fetchImpl });
    writeFileSync(join(stateDir, 'agent.env'), 'VAULT_ROOT=/home/k/vault\nAGENT_TOKEN=old-old-old-old-old-old\n');
    const code = await runCli(['enroll', '--hub', 'https://agents.example/', '--code', CODE, '--os', 'linux', '--hostname', 'vm1', '--arch', 'x64'], c);
    expect(code).toBe(0);
    expect(body).toEqual({ code: CODE, hostname: 'vm1', os: 'linux', arch: 'x64' });
    expect(readEnvFile(join(stateDir, 'agent.env'))).toEqual({
      VAULT_ROOT: '/home/k/vault',
      AGENT_TOKEN: 'runner-token-0123456789abcdef',
      HUB_URL: 'wss://agents.example/ws/agent',
      AGENT_STATE_DIR: stateDir,
    });
    expect([...out, ...err].join('')).not.toContain('runner-token');
  });

  it.each([
    ['code_expired', 410, 2],
    ['code_used', 410, 2],
    ['code_invalid', 410, 2],
    ['too_many_requests', 429, 2],
  ])('«Истёкший код» and others: %s → the English message, exit %s', async (error, status, exit) => {
    const { c, stateDir, err } = ctx({ fetchImpl: answer(status, { error }) });
    expect(await runCli(['enroll', '--hub', 'https://h', '--code', CODE, '--os', 'macos'], c)).toBe(exit);
    expect(err.join('')).toContain(ENROLL_MESSAGES[error]);
    expect(readEnvFile(join(stateDir, 'agent.env'))).toEqual({});
  });

  it('the expired-code message is the one of the spec', () => {
    expect(ENROLL_MESSAGES.code_expired).toBe('The code has expired: click "New code" in the browser and run the command again');
  });

  it('«Машина не достаёт хаб»: a network error → «Нет связи с host:443 …», exit 3', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const { c, err } = ctx({ fetchImpl });
    expect(await runCli(['enroll', '--hub', 'https://hub.example.com', '--code', CODE, '--os', 'linux'], c)).toBe(3);
    expect(err.join('')).toContain('Cannot reach hub.example.com:443: check that the machine has internet access');
  });

  it('a malformed code is refused locally', async () => {
    const { c } = ctx({ fetchImpl: answer(200, {}) });
    expect(await runCli(['enroll', '--hub', 'https://h', '--code', 'short', '--os', 'linux'], c)).toBe(2);
  });

  it('a hub answer with a plain ws:// URL to another host is refused', async () => {
    const { c, stateDir } = ctx({ fetchImpl: answer(200, { runnerId: 'r', token: 'x'.repeat(30), hubUrl: 'ws://evil.example/ws/agent' }) });
    expect(await runCli(['enroll', '--hub', 'https://h', '--code', CODE, '--os', 'linux'], c)).toBe(1);
    expect(readEnvFile(join(stateDir, 'agent.env'))).toEqual({});
  });
});

/** A fake `claude`: prints like setup-token (ANSI, the token on its own line) or the auth status. */
function fakeClaude(dir: string, mode: 'token' | 'none' | 'loggedout'): string {
  const p = join(dir, 'fake-claude.mjs');
  writeFileSync(
    p,
    `const a = process.argv.slice(2).join(' ');
if (a === '--version') { console.log('2.1.311 (Claude Code)'); process.exit(0); }
if (a === 'auth status --json') { console.log(JSON.stringify({ loggedIn: ${mode !== 'loggedout'} })); process.exit(${mode === 'loggedout' ? 1 : 0}); }
if (a === 'setup-token') {
  process.stdout.write('\\x1b[32m✓ Long-lived authentication token created successfully!\\x1b[39m\\n\\n');
  ${mode === 'token' ? `process.stdout.write('Your OAuth token (valid for 1 year):\\n\\n\\x1b[1m${TOKEN}\\x1b[22m\\n\\nStore this token securely.\\n');` : ''}
  process.exit(0);
}
process.exit(2);
`,
  );
  return p;
}

describe('agent-hub login (Requirement: Экран «Машины» — «Нет входа в Claude»)', () => {
  it('reads the token printed by claude setup-token into agent.env as CLAUDE_CODE_OAUTH_TOKEN', async () => {
    const { c, stateDir } = ctx();
    c.env.AGENT_HUB_CLAUDE = fakeClaude(stateDir, 'token');
    expect(await runCli(['login', '--no-restart'], c)).toBe(0);
    expect(readEnvFile(join(stateDir, 'agent.env')).CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
  });

  it('falls back to a hidden paste when the output has no token', async () => {
    const { c, stateDir } = ctx({ secret: `  ${TOKEN}\n` });
    c.env.AGENT_HUB_CLAUDE = fakeClaude(stateDir, 'none');
    expect(await runCli(['login', '--no-restart'], c)).toBe(0);
    expect(readEnvFile(join(stateDir, 'agent.env')).CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
  });

  it('a paste broken across lines is joined back into the token', async () => {
    const { c, stateDir } = ctx({
      secret: `${TOKEN.slice(0, 40)}
  ${TOKEN.slice(40)}
`,
    });
    c.env.AGENT_HUB_CLAUDE = fakeClaude(stateDir, 'none');
    expect(await runCli(['login', '--no-restart'], c)).toBe(0);
    expect(readEnvFile(join(stateDir, 'agent.env')).CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
  });

  it('a truncated paste is refused with its length, agent.env untouched', async () => {
    const { c, stateDir, err } = ctx({ secret: TOKEN.slice(0, 50) });
    c.env.AGENT_HUB_CLAUDE = fakeClaude(stateDir, 'none');
    expect(await runCli(['login', '--no-restart'], c)).toBe(1);
    expect(err.join('')).toContain('The token is incomplete (50 characters');
    expect(err.join('')).toContain('agent-hub login');
    expect(readEnvFile(join(stateDir, 'agent.env'))).toEqual({});
  });

  it('nothing pasted → exit 1, agent.env untouched', async () => {
    const { c, stateDir, err } = ctx({ secret: '' });
    c.env.AGENT_HUB_CLAUDE = fakeClaude(stateDir, 'none');
    expect(await runCli(['login', '--no-restart'], c)).toBe(1);
    expect(err.join('')).toContain('agent-hub login');
    expect(readEnvFile(join(stateDir, 'agent.env'))).toEqual({});
  });

  it('claude-status: missing without login, ok once agent.env has the token', async () => {
    const { c, stateDir, out } = ctx();
    c.env.AGENT_HUB_CLAUDE = fakeClaude(stateDir, 'loggedout');
    delete c.env.CLAUDE_CODE_OAUTH_TOKEN;
    await runCli(['claude-status'], c);
    expect(JSON.parse(out.pop()!)).toEqual({ login: 'missing', version: '2.1.311' });
    writeFileSync(join(stateDir, 'agent.env'), `CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}\n`);
    await runCli(['claude-status'], c);
    expect(JSON.parse(out.pop()!)).toEqual({ login: 'ok', version: '2.1.311' });
  });

  it('findSetupToken ignores a too short (wrapped) token', () => {
    expect(findSetupToken('sk-ant-oat01-abc\ndef')).toBeNull();
    expect(findSetupToken(`\x1b[1m${TOKEN}\x1b[22m`)).toBe(TOKEN);
  });

  it('restart without an autostart entry tells what to do', async () => {
    const { c, err } = ctx();
    expect(await runCli(['restart'], c)).toBe(1);
    expect(err.join('')).toContain('Autostart is not set up');
  });

  it('restart of a task: /End, then kill the supervisor of the app dir except itself, then /Run (one supervisor)', async () => {
    const { c, stateDir, out, err } = ctx();
    writeFileSync(join(stateDir, 'autostart'), 'task Agent Hub Agent\n');
    const calls: { file: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
    c.run = (file, args, env) => (calls.push({ file, args, ...(env ? { env } : {}) }), file !== 'powershell.exe');
    expect(await runCli(['restart'], c)).toBe(0);
    expect(calls.map(x => `${x.file} ${x.args[0]}`)).toEqual(['schtasks /End', 'powershell.exe -NoProfile', 'schtasks /Run']);
    expect(calls[1]!.args).toContain(STOP_APP_NODES_PS);
    expect(calls[1]!.env?.AGENT_HUB_APP).toBe(join(stateDir, 'app'));
    expect(calls[1]!.env?.AGENT_HUB_SELF).toBe(String(process.pid));
    expect(out.join('')).toContain('The agent has been restarted');
    expect(err.join('')).toContain('may keep running'); // the kill step failed: warned, /Run still ran
  });

  it.skipIf(process.platform !== 'win32')(
    'STOP_APP_NODES_PS kills the supervisor of the app dir, keeps the agent and the excluded pid',
    async () => {
      const { stateDir } = ctx();
      const app = join(stateDir, "x y'Кир", 'app'); // a quote and Cyrillic in the path must not break the script
      const start = (...f: string[]) => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)', join(app, ...f)], { stdio: 'ignore' });
      const victim = start('supervisor.mjs');
      const self = start('supervisor.mjs');
      const agent = start('versions', '0.1.1', 'agent.mjs');
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      try {
        await new Promise(r => setTimeout(r, 500));
        const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', STOP_APP_NODES_PS], {
          env: { ...process.env, AGENT_HUB_APP: app.toUpperCase(), AGENT_HUB_SELF: String(self.pid) },
        });
        expect(r.status).toBe(0);
        await new Promise(r => setTimeout(r, 500));
        expect(alive(victim.pid!)).toBe(false);
        expect(alive(self.pid!)).toBe(true);
        expect(alive(agent.pid!)).toBe(true);
      } finally {
        victim.kill();
        self.kill();
        agent.kill();
      }
    },
    30_000,
  );
});
