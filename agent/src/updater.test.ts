// change `multi-user` 5.2: self-update — SHA-256, staging, wait for turns; tar and agent.env helpers.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { readEnvFile, updateEnvFile } from './envFile.js';
import { createLogger } from './log.js';
import { extractTgz } from './tar.js';
import { RESULT_FILE, Updater, type UpdateResult } from './updater.js';
import { TurnTracker, type BackgroundTask } from './turns.js';

/** Minimal ustar writer for fixtures. */
function makeTgz(files: Record<string, string>, prefix = ''): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const h = Buffer.alloc(512);
    h.write(prefix + name, 0, 100);
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write('0', 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'agent-hub-upd-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const log = createLogger({ level: 'error', write: () => undefined });
const BUILD = { 'agent.mjs': 'console.log("v2")', 'package.json': '{"name":"agent-hub-agent","version":"0.2.0"}', 'cli.mjs': '//cli' };

function setup(o: { tgz?: Buffer; busy?: () => boolean; appDir?: string | null; status?: number; onNpm?: () => void; onFetch?: () => void } = {}) {
  const appDir = o.appDir === undefined ? tmp() : o.appDir;
  const tgz = o.tgz ?? makeTgz(BUILD);
  const sent: UpdateResult[] = [];
  const restarts: number[] = [];
  const npm: string[] = [];
  const u = new Updater({
    appDir,
    hubHttp: 'https://hub.test',
    currentVersion: '0.1.0',
    send: (type, payload) => {
      if (type === 'agent.update.result') sent.push(payload as UpdateResult);
      return true;
    },
    isBusy: o.busy ?? (() => false),
    restart: async () => void restarts.push(Date.now()),
    log,
    fetchImpl: (async (url: string) => {
      expect(url).toBe('https://hub.test/agent/agent-0.2.0.tgz');
      o.onFetch?.();
      return new Response(new Uint8Array(tgz), { status: o.status ?? 200 });
    }) as typeof fetch,
    npmInstall: async dir => {
      npm.push(dir);
      writeFileSync(join(dir, 'node_modules.marker'), '');
      o.onNpm?.();
    },
    pollMs: 10,
    maxWaitMs: 200,
  });
  const sha = createHash('sha256').update(tgz).digest('hex');
  return { u, appDir, sent, restarts, npm, sha };
}

describe('Updater (Requirement: Самообновление агента)', () => {
  it('«Выход новой версии»: downloads, checks SHA-256, stages versions/<v> + next, reports installing, restarts', async () => {
    const { u, appDir, sent, restarts, npm, sha } = setup();
    await u.handle({ version: '0.2.0', sha256: sha, url: '/agent/agent-0.2.0.tgz' });
    expect(sent).toEqual([{ version: '0.2.0', status: 'installing' }]);
    expect(restarts).toHaveLength(1);
    expect(readFileSync(join(appDir!, 'next'), 'utf8')).toBe('0.2.0');
    expect(readFileSync(join(appDir!, 'versions', '0.2.0', 'agent.mjs'), 'utf8')).toContain('v2');
    expect(existsSync(join(appDir!, 'versions', '0.2.0', 'node_modules.marker'))).toBe(true);
    expect(npm).toHaveLength(1);
  });

  it('«Битая сборка»: SHA-256 mismatch → failed sha_mismatch, nothing staged, no restart', async () => {
    const { u, appDir, sent, restarts } = setup();
    await u.handle({ version: '0.2.0', sha256: 'a'.repeat(64), url: '/agent/agent-0.2.0.tgz' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.status).toBe('failed');
    expect(sent[0]!.error).toMatch(/^sha_mismatch/);
    expect(restarts).toHaveLength(0);
    expect(existsSync(join(appDir!, 'next'))).toBe(false);
    expect(existsSync(join(appDir!, 'versions', '0.2.0'))).toBe(false);
  });

  it('download error → failed download_failed', async () => {
    const { u, sent } = setup({ status: 404 });
    await u.handle({ version: '0.2.0', sha256: 'a'.repeat(64), url: '/agent/agent-0.2.0.tgz' });
    expect(sent[0]).toMatchObject({ status: 'failed' });
    expect(sent[0]!.error).toMatch(/^download_failed/);
  });

  it('a build without agent.mjs → install_failed', async () => {
    const tgz = makeTgz({ 'readme.txt': 'x' });
    const { u, sent, sha } = setup({ tgz });
    await u.handle({ version: '0.2.0', sha256: sha, url: '/agent/agent-0.2.0.tgz' });
    expect(sent[0]!.error).toMatch(/^install_failed/);
  });

  it('waits for the end of running turns (reports waiting once), then installs', async () => {
    let busy = true;
    const { u, sent, restarts, sha } = setup({ busy: () => busy });
    const p = u.handle({ version: '0.2.0', sha256: sha, url: '/agent/agent-0.2.0.tgz' });
    await new Promise(r => setTimeout(r, 50));
    expect(sent).toEqual([{ version: '0.2.0', status: 'waiting' }]);
    expect(restarts).toHaveLength(0);
    busy = false;
    await p;
    expect(sent.map(s => s.status)).toEqual(['waiting', 'installing']);
    expect(restarts).toHaveLength(1);
  });

  it('a turn started during the download/npm install: waits again before the restart, next is written after it', async () => {
    let busy = false;
    const { u, appDir, sent, restarts, sha } = setup({ busy: () => busy, onNpm: () => (busy = true) });
    const p = u.handle({ version: '0.2.0', sha256: sha, url: '/agent/agent-0.2.0.tgz' });
    await new Promise(r => setTimeout(r, 60));
    const busySeen = busy;
    expect(sent).toEqual([{ version: '0.2.0', status: 'waiting' }]);
    expect(restarts).toHaveLength(0);
    expect(existsSync(join(appDir!, 'next'))).toBe(false);
    busy = false;
    await p;
    expect(busySeen).toBe(true);
    expect(sent.map(s => s.status)).toEqual(['waiting', 'installing']);
    expect(restarts).toHaveLength(1);
    expect(readFileSync(join(appDir!, 'next'), 'utf8')).toBe('0.2.0');
  });

  it('a turn that starts during the install and never ends → busy_timeout, no restart, next not written, versions/<v> removed', async () => {
    let busy = false;
    const { u, appDir, sent, restarts, sha } = setup({ busy: () => busy, onNpm: () => (busy = true) });
    await u.handle({ version: '0.2.0', sha256: sha, url: '/agent/agent-0.2.0.tgz' });
    expect(sent.map(s => s.status)).toEqual(['waiting', 'failed']);
    expect(sent[1]!.error).toBe('busy_timeout');
    expect(restarts).toHaveLength(0);
    expect(existsSync(join(appDir!, 'next'))).toBe(false);
    expect(existsSync(join(appDir!, 'versions', '0.2.0'))).toBe(false);
    expect(existsSync(join(appDir!, 'versions', '0.2.0.tmp'))).toBe(false);
  });

  it('turns that never end → failed busy_timeout (limit is 2 h in production)', async () => {
    const { u, sent, restarts, sha } = setup({ busy: () => true });
    await u.handle({ version: '0.2.0', sha256: sha, url: '/agent/agent-0.2.0.tgz' });
    expect(sent.map(s => s.status)).toEqual(['waiting', 'failed']);
    expect(sent[1]!.error).toBe('busy_timeout');
    expect(restarts).toHaveLength(0);
  });

  it('an agent not started by the supervisor refuses (not_supervised)', async () => {
    const { u, sent } = setup({ appDir: null });
    await u.handle({ version: '0.2.0', sha256: 'a'.repeat(64), url: '/agent/agent-0.2.0.tgz' });
    expect(sent[0]!.error).toMatch(/^not_supervised/);
  });

  it('the same version is ignored', async () => {
    const { u, sent } = setup();
    await u.handle({ version: '0.1.0', sha256: 'a'.repeat(64), url: '/agent/agent-0.1.0.tgz' });
    expect(sent).toHaveLength(0);
  });

  it('reports a rollback left by the supervisor once, after welcome', () => {
    const { u, appDir, sent } = setup();
    writeFileSync(join(appDir!, RESULT_FILE), JSON.stringify({ version: '0.2.0', status: 'failed', error: 'start_failed: exited with 1' }));
    u.reportPending();
    u.reportPending();
    expect(sent).toEqual([{ version: '0.2.0', status: 'failed', error: 'start_failed: exited with 1' }]);
    expect(existsSync(join(appDir!, RESULT_FILE))).toBe(false);
  });
});

describe('Updater on the real TurnTracker (Requirement: Самообновление ждёт фоновую работу)', () => {
  const sub: BackgroundTask = { taskId: 't1', taskType: 'local_agent', ambient: false };
  const bash: BackgroundTask = { taskId: 'b1', taskType: 'local_bash', ambient: false };
  // the 30-s release hold, shortened to 80 ms here
  const HOLD = 80;
  const tracker = () => {
    const turns = new TurnTracker({ holdMs: HOLD });
    turns.observe('session.state', { sessionId: 's1', state: 'waiting', processAlive: true });
    return turns;
  };
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  it('«Ход окончен, фоновый сабагент гоняет тесты»: waiting once, no download, no restart; empty set → installs and restarts', async () => {
    const turns = tracker();
    turns.setBackground('s1', [sub], Date.now());
    let fetched = 0;
    const { u, appDir, sent, restarts, npm, sha } = setup({ busy: () => turns.busy, onFetch: () => void fetched++ });
    const p = u.handle({ version: '0.2.0', sha256: sha, url: '/agent/agent-0.2.0.tgz' });
    await sleep(60);
    expect(sent).toEqual([{ version: '0.2.0', status: 'waiting' }]);
    expect(fetched).toBe(0);
    expect(npm).toHaveLength(0);
    expect(restarts).toHaveLength(0);
    // «Фоновая задача завершилась — обновление идёт»
    turns.setBackground('s1', [], Date.now());
    const emptied = Date.now();
    await sleep(HOLD / 2);
    expect(fetched).toBe(0); // still within the hold
    await p;
    expect(Date.now() - emptied).toBeGreaterThanOrEqual(HOLD - 5);
    expect(fetched).toBe(1);
    expect(sent.map(s => s.status)).toEqual(['waiting', 'installing']);
    expect(readFileSync(join(appDir!, 'next'), 'utf8')).toBe('0.2.0');
    expect(restarts).toHaveLength(1);
  });

  it('«Фоновая задача появилась во время установки»: no restart until the set is empty', async () => {
    const turns = tracker();
    const { u, appDir, sent, restarts, sha } = setup({
      busy: () => turns.busy,
      onNpm: () => {
        // the turn ended with a background command started
        turns.setBackground('s1', [bash], Date.now());
      },
    });
    const p = u.handle({ version: '0.2.0', sha256: sha, url: '/agent/agent-0.2.0.tgz' });
    await sleep(60);
    expect(sent).toEqual([{ version: '0.2.0', status: 'waiting' }]);
    expect(restarts).toHaveLength(0);
    expect(existsSync(join(appDir!, 'next'))).toBe(false);
    turns.setBackground('s1', [], Date.now());
    await p;
    expect(sent.map(s => s.status)).toEqual(['waiting', 'installing']);
    expect(restarts).toHaveLength(1);
  });

  it('a background command started during the install that outlives maxWaitMs → busy_timeout, versions/<v> removed', async () => {
    const turns = tracker();
    const { u, appDir, sent, restarts, sha } = setup({ busy: () => turns.busy, onNpm: () => turns.setBackground('s1', [bash], Date.now()) });
    await u.handle({ version: '0.2.0', sha256: sha, url: '/agent/agent-0.2.0.tgz' });
    expect(sent.map(s => s.status)).toEqual(['waiting', 'failed']);
    expect(sent[1]!.error).toBe('busy_timeout');
    expect(restarts).toHaveLength(0);
    expect(existsSync(join(appDir!, 'next'))).toBe(false);
    expect(existsSync(join(appDir!, 'versions', '0.2.0'))).toBe(false);
  });

  it('«Фоновая задача дольше 2 часов»: a subagent sending messages past maxWaitMs → busy_timeout, no restart', async () => {
    const turns = tracker();
    turns.setBackground('s1', [sub], Date.now());
    const touching = setInterval(() => turns.touch('s1', Date.now()), 20);
    try {
      const { u, sent, restarts, npm, sha } = setup({ busy: () => turns.busy });
      await u.handle({ version: '0.2.0', sha256: sha, url: '/agent/agent-0.2.0.tgz' });
      expect(sent.map(s => s.status)).toEqual(['waiting', 'failed']);
      expect(sent[1]!.error).toBe('busy_timeout');
      expect(npm).toHaveLength(0);
      expect(restarts).toHaveLength(0);
      expect(turns.busy).toBe(true);
    } finally {
      clearInterval(touching);
      turns.dispose();
    }
  });

  it('ambient and teammate tasks do not hold the update', async () => {
    const turns = tracker();
    turns.setBackground(
      's1',
      [
        { taskId: 'a', taskType: 'local_agent', ambient: true },
        { taskId: 'm', taskType: 'in_process_teammate', ambient: false },
      ],
      Date.now(),
    );
    const { u, sent, restarts, sha } = setup({ busy: () => turns.busy });
    await u.handle({ version: '0.2.0', sha256: sha, url: '/agent/agent-0.2.0.tgz' });
    expect(sent).toEqual([{ version: '0.2.0', status: 'installing' }]);
    expect(restarts).toHaveLength(1);
  });
});

describe('extractTgz', () => {
  it('extracts files and strips a single top-level folder', () => {
    const d = tmp();
    expect(extractTgz(makeTgz({ 'a.txt': 'A', 'sub/b.txt': 'B' }, 'package/'), d).sort()).toEqual(['a.txt', 'sub/b.txt']);
    expect(readFileSync(join(d, 'sub', 'b.txt'), 'utf8')).toBe('B');
  });
  it('keeps ./-prefixed names of `tar -C dist .`', () => {
    const d = tmp();
    expect(extractTgz(makeTgz({ 'agent.mjs': '1', 'package.json': '{}' }, './'), d).sort()).toEqual(['agent.mjs', 'package.json']);
  });
  it('refuses paths leaving the target', () => {
    expect(() => extractTgz(makeTgz({ '../evil.txt': 'x', 'ok.txt': 'y' }), tmp())).toThrow(/unsafe path/);
  });
});

describe('agent.env updates (Requirement: Установщик — «Повторный запуск»)', () => {
  it('replaces the token and keeps the other settings; mode 600 on unix', () => {
    const d = tmp();
    const f = join(d, 'agent.env');
    mkdirSync(d, { recursive: true });
    writeFileSync(f, '# comment\nHUB_URL=wss://old/ws/agent\nAGENT_TOKEN=old-token-0000000000000\nVAULT_ROOT=/home/k/vault\n');
    updateEnvFile(f, { HUB_URL: 'wss://hub.example.com/ws/agent', AGENT_TOKEN: 'new-token-1111111111111', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x' });
    const text = readFileSync(f, 'utf8');
    expect(text.startsWith('# comment\n')).toBe(true);
    expect(readEnvFile(f)).toEqual({
      HUB_URL: 'wss://hub.example.com/ws/agent',
      AGENT_TOKEN: 'new-token-1111111111111',
      VAULT_ROOT: '/home/k/vault',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x',
    });
    if (process.platform !== 'win32') expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(() => updateEnvFile(f, { AGENT_TOKEN: 'a\nb' })).toThrow();
  });
});
