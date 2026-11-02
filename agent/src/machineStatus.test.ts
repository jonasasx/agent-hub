// change `multi-user` 5.1, 5.3: Claude login check, macOS protected folders, caffeinate during a turn.
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { checkClaude, isAuthError, type RunFn } from './claudeStatus.js';
import { Caffeinator, checkProtectedDirs } from './macos.js';
import { buildHello, runsAsRoot } from './machine.js';
import { TurnTracker } from './turns.js';

const fakeClaude =
  (loggedIn: boolean | 'garbage', calls: string[][] = []): RunFn =>
  async (_f, args) => {
    calls.push(args);
    if (args[0] === '--version') return { code: 0, stdout: '2.1.311 (Claude Code)\n' };
    if (loggedIn === 'garbage') return { code: 1, stdout: 'Error: something\n' };
    return { code: loggedIn ? 0 : 1, stdout: JSON.stringify({ loggedIn, authMethod: loggedIn ? 'claude.ai' : 'none' }) };
  };

describe('checkClaude (Requirement: Установщик — «Нет входа в Claude»)', () => {
  it('logged in claude → ok with the version', async () => {
    expect(await checkClaude({ claudePath: '/x/claude', env: {}, run: fakeClaude(true) })).toEqual({ login: 'ok', version: '2.1.311' });
  });
  it('a machine without login → missing', async () => {
    expect(await checkClaude({ claudePath: '/x/claude', env: {}, run: fakeClaude(false) })).toEqual({ login: 'missing', version: '2.1.311' });
  });
  it('unparsable status → missing', async () => {
    expect((await checkClaude({ claudePath: '/x/claude', env: {}, run: fakeClaude('garbage') })).login).toBe('missing');
  });
  it('CLAUDE_CODE_OAUTH_TOKEN from agent.env → ok without asking auth status', async () => {
    const calls: string[][] = [];
    const s = await checkClaude({ claudePath: '/x/claude', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x' }, run: fakeClaude(false, calls) });
    expect(s.login).toBe('ok');
    expect(calls).toEqual([['--version']]);
  });
  it('no claude at all → missing, version null (ok with a token)', async () => {
    expect(await checkClaude({ claudePath: null, env: {} })).toEqual({ login: 'missing', version: null });
    expect(await checkClaude({ claudePath: null, env: { CLAUDE_CODE_OAUTH_TOKEN: 't' } })).toEqual({ login: 'ok', version: null });
  });
  it('recognises authorization failures of a turn', () => {
    expect(isAuthError('Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error"}}')).toBe(true);
    expect(isAuthError('OAuth token has expired. Please run /login')).toBe(true);
    expect(isAuthError('Invalid API key · Please run /login')).toBe(true);
    expect(isAuthError('error_max_turns')).toBe(false);
    expect(isAuthError('Read 401 lines')).toBe(false);
    expect(isAuthError(undefined)).toBe(false);
  });
});

describe('checkProtectedDirs (Requirement: macOS — «Mac без полного доступа к диску»)', () => {
  const eperm = () => {
    throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
  };
  it('n/a outside macOS', () => expect(checkProtectedDirs({ platform: 'linux', readdir: eperm })).toBe('n/a'));
  it('denied when ~/Documents is not readable', () => expect(checkProtectedDirs({ platform: 'darwin', home: '/Users/k', readdir: p => (p.includes('Documents') ? eperm() : []) })).toBe('denied'));
  it('ok when readable; a missing folder does not count', () =>
    expect(
      checkProtectedDirs({
        platform: 'darwin',
        home: '/Users/k',
        readdir: p => {
          if (p.includes('Desktop')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          return [];
        },
      }),
    ).toBe('ok'));
});

describe('hello 1.5 fields (protocol 1.9, version of agent/package.json)', () => {
  it('carries agent hello fields for protocol 1.13 and supported features', () => {
    const h = buildHello({ vaultRoot: null, status: { claude: { login: 'missing', version: null }, protectedDirs: 'n/a' } });
    expect(h.protocol).toBe('1.13');
    expect(h.capabilities).toContain('fs.list-dirs');
    expect(h.agentVersion).toBe('0.4.2');
    expect(h.claude).toEqual({ login: 'missing', version: null });
    expect(h.protectedDirs).toBe('n/a');
    expect(h.arch).toBe(process.arch);
    expect(h.root).toBe(runsAsRoot());
  });

  // Requirement (runner-enrollment): Запуск под root — the rule of Claude Code (isRootOutsideDeliberateSandbox)
  it('root: uid 0 outside a sandbox, never on Windows', () => {
    expect(runsAsRoot({}, 'linux', 0)).toBe(true);
    expect(runsAsRoot({}, 'darwin', 0)).toBe(true);
    expect(runsAsRoot({}, 'linux', 1000)).toBe(false);
    expect(runsAsRoot({}, 'win32', 0)).toBe(false);
    expect(runsAsRoot({}, 'win32', undefined)).toBe(false);
    expect(runsAsRoot({ IS_SANDBOX: '1' }, 'linux', 0)).toBe(false);
    expect(runsAsRoot({ CLAUDE_CODE_BUBBLEWRAP: '1' }, 'linux', 0)).toBe(false);
  });
});

class FakeProc extends EventEmitter {
  killed = false;
  kill(): boolean {
    this.killed = true;
    this.emit('exit', 0, null);
    return true;
  }
}

describe('caffeinate during a turn (Requirement: macOS — «Mac засыпает посреди хода»)', () => {
  const setup = (platform: NodeJS.Platform) => {
    const spawned: { cmd: string; args: string[]; proc: FakeProc }[] = [];
    const caf = new Caffeinator({
      platform,
      pid: 4242,
      spawn: (cmd, args) => {
        const proc = new FakeProc();
        spawned.push({ cmd, args, proc });
        return proc as unknown as ChildProcess;
      },
    });
    const turns = new TurnTracker();
    turns.onChange(b => caf.setBusy(b));
    return { spawned, caf, turns };
  };

  it('holds caffeinate -i -w <agent pid> while any turn runs and releases after the last one', () => {
    const { spawned, caf, turns } = setup('darwin');
    turns.observe('session.state', { sessionId: 'a', state: 'working', processAlive: true });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.cmd).toBe('/usr/bin/caffeinate');
    expect(spawned[0]!.args).toEqual(['-i', '-w', '4242']);
    turns.observe('session.state', { sessionId: 'b', state: 'permission', processAlive: true });
    turns.observe('session.state', { sessionId: 'a', state: 'waiting', processAlive: true });
    expect(caf.active).toBe(true);
    expect(spawned).toHaveLength(1);
    turns.observe('session.exited', { sessionId: 'b', code: 0, reason: 'stopped' });
    expect(caf.active).toBe(false);
    expect(spawned[0]!.proc.killed).toBe(true);
    turns.observe('session.state', { sessionId: 'a', state: 'working', processAlive: true });
    expect(spawned).toHaveLength(2);
  });

  it('does nothing on Linux and Windows', () => {
    const { spawned, turns } = setup('linux');
    turns.observe('session.state', { sessionId: 'a', state: 'working', processAlive: true });
    expect(spawned).toHaveLength(0);
  });
});
