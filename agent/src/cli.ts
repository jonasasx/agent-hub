// `agent-hub` command (change `multi-user`): ~/.agent-hub/bin/agent-hub → node ~/.agent-hub/app/cli.mjs <command>.
// The installers use the same commands, so the logic is tested here and not in shell.
//   login [--no-restart]   claude setup-token → CLAUDE_CODE_OAUTH_TOKEN in agent.env, then restart the agent
//   claude-status          {"login":"ok|missing","version":…} of this machine
//   enroll --hub <https://host> --code <code> --os <linux|macos|windows> [--hostname h] [--arch a]
//                          one-time code → runner token in agent.env (never printed)
//   restart                restart the autostart entry the installer created (~/.agent-hub/autostart)
// Requirements: Установщик; Экран «Машины» («Нет входа в Claude»: `~/.agent-hub/bin/agent-hub login`).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir, hostname as osHostname } from 'node:os';
import { join } from 'node:path';
import { checkClaude, findClaude } from './claudeStatus.js';
import { isAllowedHubUrl } from './config.js';
import { readEnvFile, updateEnvFile } from './envFile.js';

export interface CliIo {
  out: (s: string) => void;
  err: (s: string) => void;
  /** Hidden line input (the pasted token). */
  readSecret: (prompt: string) => Promise<string>;
}

export interface CliEnv {
  stateDir: string;
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  io: CliIo;
  /** Runs a command, true on exit code 0 (tests record the calls). */
  run?: (file: string, args: string[], env?: NodeJS.ProcessEnv) => boolean;
}

// The supervisor: node.exe whose command line contains AGENT_HUB_APP and supervisor.mjs, except AGENT_HUB_SELF (this
// CLI runs node from the app dir too). Not the agent: it exits by itself on the IPC disconnect and shuts its sessions
// down gracefully. The values come through env: no quoting of paths.
export const STOP_APP_NODES_PS =
  '$a = $env:AGENT_HUB_APP; $me = [int]$env:AGENT_HUB_SELF; Get-CimInstance Win32_Process -Filter "Name = \'node.exe\'" | ' +
  'Where-Object { $_.ProcessId -ne $me -and $_.CommandLine -and $_.CommandLine.IndexOf($a, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.CommandLine.IndexOf("supervisor.mjs", [StringComparison]::OrdinalIgnoreCase) -ge 0 } | ' +
  'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';

export function stateDirFrom(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_HUB_HOME || join(homedir(), '.agent-hub');
}

/** `claude` to run: AGENT_HUB_CLAUDE (tests: a .mjs script runs on this node) or the machine's claude. */
export function claudeCommand(env: NodeJS.ProcessEnv): { file: string; args: string[] } | null {
  const p = env.AGENT_HUB_CLAUDE || findClaude(env);
  if (!p) return null;
  return /\.(mjs|cjs|js)$/.test(p) ? { file: process.execPath, args: [p] } : { file: p, args: [] };
}

const ANSI = new RegExp(String.raw`\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[@-Z\\-_]`, 'g');
const TOKEN_RE = /sk-ant-oat\d*-[A-Za-z0-9_-]+/g;
const TOKEN_OK = /^sk-ant-[A-Za-z0-9_-]+$/;
const TOKEN_MIN = 80;

/** The long-lived token printed by `claude setup-token` (≥ 80 characters; a wrapped, broken one is not accepted). */
export function findSetupToken(output: string): string | null {
  const text = output.replace(ANSI, '');
  const all = [...text.matchAll(TOKEN_RE)].map(m => m[0]).filter(t => t.length >= TOKEN_MIN);
  return all.at(-1) ?? null;
}

function parseArgs(argv: string[]): { flags: Record<string, string | true>; rest: string[] } {
  const flags: Record<string, string | true> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--') && !['no-restart'].includes(key)) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else rest.push(a);
  }
  return { flags, rest };
}

const envPath = (c: CliEnv) => join(c.stateDir, 'agent.env');

export async function cmdClaudeStatus(c: CliEnv): Promise<number> {
  const env = { ...c.env, ...readEnvFile(envPath(c)) };
  const cmd = claudeCommand(env);
  const status = await checkClaude({
    claudePath: cmd ? cmd.file : null,
    env,
    ...(cmd && cmd.args.length
      ? {
          run: (_f, args, e) =>
            new Promise(resolve => {
              const r = spawnSync(cmd.file, [...cmd.args, ...args], { env: e, encoding: 'utf8', timeout: 20_000 });
              resolve({ code: r.status, stdout: r.stdout ?? '' });
            }),
        }
      : {}),
  });
  c.io.out(JSON.stringify(status) + '\n');
  return 0;
}

export async function cmdLogin(c: CliEnv, o: { restart: boolean }): Promise<number> {
  const cmd = claudeCommand(c.env);
  if (!cmd) {
    c.io.err('claude not found. Install it: curl -fsSL https://claude.ai/install.sh | bash\n');
    return 1;
  }
  c.io.out('Claude subscription sign-in: a link will open, sign in in the browser.\n');
  let output = '';
  const code = await new Promise<number | null>(resolve => {
    const p = spawn(cmd.file, [...cmd.args, 'setup-token'], { stdio: ['inherit', 'pipe', 'inherit'], env: c.env });
    p.stdout!.on('data', (d: Buffer) => {
      output += d.toString('utf8');
      c.io.out(d.toString('utf8'));
    });
    p.on('error', err => {
      c.io.err(`claude setup-token failed to start: ${err.message}\n`);
      resolve(null);
    });
    p.on('close', status => resolve(status));
  });
  let token = findSetupToken(output);
  if (!token) {
    if (code !== 0 && code !== null) c.io.err(`claude setup-token exited with code ${code}.\n`);
    // A token copied from a wrapped terminal line arrives with spaces or line breaks inside.
    token = (await c.io.readSecret('Paste the token that claude showed (input is hidden): ')).replace(/\s+/g, '');
  }
  if (!token) {
    c.io.err('No token received. Try again: ~/.agent-hub/bin/agent-hub login\n');
    return 1;
  }
  if (!TOKEN_OK.test(token) || token.length < TOKEN_MIN) {
    c.io.err(`The token is incomplete (${token.length} characters, a full one is ${TOKEN_MIN}+ and starts with sk-ant-): copy it whole. ` + 'Try again: ~/.agent-hub/bin/agent-hub login\n');
    return 1;
  }
  mkdirSync(c.stateDir, { recursive: true });
  updateEnvFile(envPath(c), { CLAUDE_CODE_OAUTH_TOKEN: token });
  c.io.out('Claude sign-in saved.\n');
  return o.restart ? cmdRestart(c) : 0;
}

export const ENROLL_MESSAGES: Record<string, string> = {
  code_expired: 'The code has expired: click "New code" in the browser and run the command again',
  code_used: 'The code has already been used: click "New code" in the browser and run the command again',
  code_invalid: 'The code was not accepted: copy the command from the browser again',
  invalid_request: 'The code was not accepted: copy the command from the browser again',
  too_many_requests: 'Too many attempts: wait a minute and run the command again',
};

export function noConnectionMessage(hub: string): string {
  const u = new URL(hub);
  return `Cannot reach ${u.hostname}:${u.port || (u.protocol === 'http:' ? '80' : '443')}: check that the machine has internet access`;
}

/** Exit codes: 0 — enrolled; 2 — the code was refused; 3 — no connection; 1 — anything else. */
export async function cmdEnroll(c: CliEnv, f: Record<string, string | true>): Promise<number> {
  const hub = typeof f.hub === 'string' ? f.hub.replace(/\/+$/, '') : '';
  const code = typeof f.code === 'string' ? f.code.trim() : '';
  const os = typeof f.os === 'string' ? f.os : '';
  if (!/^https?:\/\//.test(hub) || !code || !['linux', 'macos', 'windows'].includes(os)) {
    c.io.err('usage: agent-hub enroll --hub <https://host> --code <code> --os <linux|macos|windows>\n');
    return 1;
  }
  if (!/^[A-Za-z2-7]{26}$/.test(code)) {
    c.io.err(`${ENROLL_MESSAGES.code_invalid}\n`);
    return 2;
  }
  const body = {
    code,
    hostname: (typeof f.hostname === 'string' ? f.hostname : osHostname()).slice(0, 253),
    os,
    arch: typeof f.arch === 'string' ? f.arch : process.arch,
  };
  let res: Response;
  try {
    res = await (c.fetchImpl ?? fetch)(`${hub}/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    c.io.err(`${noConnectionMessage(hub)}\n`);
    return 3;
  }
  let json: Record<string, unknown>;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = {};
  }
  if (!res.ok) {
    const err = typeof json.error === 'string' ? json.error : '';
    const msg = ENROLL_MESSAGES[err] ?? (res.status === 429 ? ENROLL_MESSAGES.too_many_requests : `The hub answered ${res.status}${err ? ` (${err})` : ''}`);
    c.io.err(`${msg}\n`);
    return res.status === 410 || res.status === 400 || res.status === 429 ? 2 : 1;
  }
  const token = json.token;
  const hubUrl = json.hubUrl;
  if (typeof token !== 'string' || token.length < 20 || typeof hubUrl !== 'string' || !isAllowedHubUrl(hubUrl)) {
    c.io.err('The hub returned an unexpected response to the enrollment.\n');
    return 1;
  }
  mkdirSync(c.stateDir, { recursive: true });
  // AGENT_STATE_DIR: replication state next to agent.env (a trial install with another state dir keeps its own).
  updateEnvFile(envPath(c), { HUB_URL: hubUrl, AGENT_TOKEN: token, AGENT_STATE_DIR: c.stateDir });
  c.io.out(`The machine is connected to the hub (runner ${String(json.runnerId)}).\n`);
  return 0;
}

/** Restarts what ~/.agent-hub/autostart names (written by the installer: `<kind> <name>`). */
export async function cmdRestart(c: CliEnv): Promise<number> {
  const file = join(c.stateDir, 'autostart');
  const line = existsSync(file) ? readFileSync(file, 'utf8').trim() : 'none';
  const sp = line.indexOf(' ');
  const kind = sp < 0 ? line : line.slice(0, sp);
  const name = sp < 0 ? '' : line.slice(sp + 1);
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  const run = c.run ?? ((file: string, args: string[], env?: NodeJS.ProcessEnv) => spawnSync(file, args, { stdio: 'inherit', ...(env ? { env } : {}) }).status === 0);
  const sudo = (args: string[]) => (uid === 0 ? run(args[0]!, args.slice(1)) : run('sudo', args));
  let ok: boolean;
  switch (kind) {
    case 'systemd-system':
      ok = sudo(['systemctl', 'restart', name]);
      break;
    case 'systemd-user':
      ok = run('systemctl', ['--user', 'restart', name]);
      break;
    case 'launchd-agent':
      ok = run('launchctl', ['kickstart', '-k', `gui/${uid}/${name}`]);
      break;
    case 'launchd-daemon':
      ok = sudo(['launchctl', 'kickstart', '-k', `system/${name}`]);
      break;
    case 'task': {
      run('schtasks', ['/End', '/TN', name]);
      // An Interactive task runs conhost --headless node: /End kills only conhost, the supervisor would survive and
      // /Run would start a second one with the same token.
      const stopped = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', STOP_APP_NODES_PS], {
        ...process.env,
        AGENT_HUB_APP: join(c.stateDir, 'app'),
        AGENT_HUB_SELF: String(process.pid),
      });
      if (!stopped) c.io.err('Could not stop the previous agent supervisor: it may keep running.\n');
      ok = run('schtasks', ['/Run', '/TN', name]);
      break;
    }
    default:
      c.io.err('Autostart is not set up: start the agent again (see the installer output).\n');
      return 1;
  }
  if (!ok) {
    c.io.err('Could not restart the agent: reboot the machine or run the installer again.\n');
    return 1;
  }
  c.io.out('The agent has been restarted.\n');
  return 0;
}

export async function runCli(argv: string[], c: CliEnv): Promise<number> {
  const [command, ...tail] = argv;
  const { flags } = parseArgs(tail);
  switch (command) {
    case 'login':
      return cmdLogin(c, { restart: flags['no-restart'] !== true });
    case 'claude-status':
      return cmdClaudeStatus(c);
    case 'enroll':
      return cmdEnroll(c, flags);
    case 'restart':
      return cmdRestart(c);
    default:
      c.io.err('usage: agent-hub <login|claude-status|enroll|restart>\n');
      return command ? 1 : 0;
  }
}

/** Hidden input from the terminal (raw mode); a plain line when stdin is not a TTY. */
export function readSecretFromTty(prompt: string): Promise<string> {
  return new Promise(resolve => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    let buf = '';
    if (!stdin.isTTY) {
      stdin.setEncoding('utf8');
      const onData = (d: string) => {
        buf += d;
        const nl = buf.indexOf('\n');
        if (nl >= 0) {
          stdin.off('data', onData);
          stdin.pause();
          resolve(buf.slice(0, nl).replace(/\r$/, ''));
        }
      };
      stdin.on('data', onData);
      stdin.once('end', () => resolve(buf));
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (d: string) => {
      for (const ch of d) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.off('data', onData);
          stdin.pause();
          process.stderr.write('\n');
          resolve(buf);
          return;
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.stderr.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}
