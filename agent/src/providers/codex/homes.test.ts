// provider-parity D2, D4, D5: CODEX_HOME per subscription, the write-back of rotated tokens, the limits mapping.
import { mkdtemp, readFile, rm, writeFile, mkdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexHomes, stripMcpServers } from './homes.js';
import { snapshotOfRateLimits } from './limits.js';

let dir: string;
let homes: CodexHomes;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'codex-homes-'));
  await mkdir(join(dir, 'base'), { recursive: true });
  await writeFile(join(dir, 'base', 'config.toml'), 'model = "x"\n');
  homes = new CodexHomes({ stateDir: join(dir, 'state'), baseHome: join(dir, 'base') });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('CodexHomes', () => {
  it('removes global and nested MCP tables while preserving unrelated config', () => {
    const input = 'model = "x"\n[mcp_servers.foo]\ncommand = "bad"\n[mcp_servers.foo.env]\nKEY = "secret"\n[features]\nfast = true\n';
    expect(stripMcpServers(input)).toBe('model = "x"\n[features]\nfast = true\n');
  });
  it('removes single-line and multi-line root inline mcp_servers tables', () => {
    const single = 'model = "x"\nmcp_servers = { foo = { command = "bad" } }\n[features]\nfast = true\n';
    const multi = 'model = "x"\nmcp_servers = {\n  foo = { command = "bad" },\n  bar = { args = ["x"] }\n}\n[features]\nfast = true\n';
    expect(stripMcpServers(single)).toBe('model = "x"\n[features]\nfast = true\n');
    expect(stripMcpServers(multi)).toBe('model = "x"\n[features]\nfast = true\n');
  });
  it('prepares a home: auth.json, config.toml copy, sessions link', async () => {
    const h = await homes.prepare('s1', '{"tokens":{"a":1}}');
    expect(await readFile(join(h, 'auth.json'), 'utf8')).toBe('{"tokens":{"a":1}}');
    expect(await readFile(join(h, 'config.toml'), 'utf8')).toContain('model');
    expect((await lstat(join(h, 'sessions'))).isSymbolicLink()).toBe(true);
  });

  it('preserves legacy MCP tables unless registry mode is enabled', async () => {
    const config = 'model = "x"\n[mcp_servers.legacy]\ncommand = "legacy-server"\n[features]\nfast = true\n';
    await writeFile(join(dir, 'base', 'config.toml'), config);
    const legacyHome = await homes.prepare('legacy', '{"v":1}');
    expect(await readFile(join(legacyHome, 'config.toml'), 'utf8')).toBe(config);
    const registryHome = await homes.prepare('registry', '{"v":1}', true);
    const registryConfig = await readFile(join(registryHome, 'config.toml'), 'utf8');
    expect(registryConfig).not.toContain('[mcp_servers.legacy]');
    expect(registryConfig).toContain('[features]');
  });

  it('does not replace a config with empty text after isolation read failure', async () => {
    const source = join(dir, 'base', 'config.toml');
    await rm(source);
    await mkdir(source);
    const warnings: string[] = [];
    const guardedHomes = new CodexHomes({
      stateDir: join(dir, 'guarded-state'),
      baseHome: join(dir, 'base'),
      log: { warn: message => warnings.push(message) },
    });
    const home = await guardedHomes.prepare('read-error', '{"v":1}', true);
    await expect(readFile(join(home, 'config.toml'), 'utf8')).rejects.toThrow();
    expect(warnings).toContain('Codex registry config isolation failed; copying source config');
    expect(warnings).toContain('Codex config fallback copy failed');
  });

  it('logs a failed registry-isolated write and attempts the source copy fallback', async () => {
    const home = join(dir, 'write-state', 'codex-homes', 'write-error');
    await mkdir(join(home, 'config.toml'), { recursive: true });
    const warnings: string[] = [];
    const guardedHomes = new CodexHomes({
      stateDir: join(dir, 'write-state'),
      baseHome: join(dir, 'base'),
      log: { warn: message => warnings.push(message) },
    });
    await expect(guardedHomes.prepare('write-error', '{"v":1}', true)).resolves.toBe(home);
    expect(warnings).toContain('Codex registry config isolation failed; copying source config');
    expect(warnings).toContain('Codex config fallback copy failed');
  });

  it('reports a rotated auth.json once; the hub copy does not overwrite a newer file', async () => {
    const h = await homes.prepare('s1', '{"v":1}');
    expect(await homes.changed('s1')).toBeNull();
    await writeFile(join(h, 'auth.json'), '{"v":2}');
    expect(await homes.changed('s1')).toBe('{"v":2}');
    homes.confirm('s1', '{"v":2}');
    expect(await homes.changed('s1')).toBeNull();
    await homes.prepare('s1', '{"v":2}');
    expect(await readFile(join(h, 'auth.json'), 'utf8')).toBe('{"v":2}');
  });

  it('a rotation the hub never got is reported again, and a restart does not overwrite it with the older hub copy', async () => {
    const old = '{"last_refresh":"2026-10-31T10:00:00Z","n":1}';
    const fresh = '{"last_refresh":"2026-10-31T11:00:00Z","n":2}';
    const h = await homes.prepare('s1', old);
    await writeFile(join(h, 'auth.json'), fresh);
    expect(await homes.changed('s1')).toBe(fresh);
    expect(await homes.changed('s1')).toBe(fresh); // not confirmed: the send failed
    const restarted = new CodexHomes({ stateDir: join(dir, 'state'), baseHome: join(dir, 'base') });
    await restarted.prepare('s1', old);
    expect(await readFile(join(h, 'auth.json'), 'utf8')).toBe(fresh);
    expect(await restarted.changed('s1')).toBe(fresh);
  });

  it('a login home gives its auth.json once and is removed', async () => {
    const h = await homes.tempHome();
    await writeFile(join(h, 'auth.json'), '{"ok":true}');
    expect(await homes.takeLogin(h)).toBe('{"ok":true}');
    await expect(lstat(h)).rejects.toThrow();
  });
});

describe('snapshotOfRateLimits', () => {
  it('names the windows by duration and marks a full one rejected', () => {
    const s = snapshotOfRateLimits({
      rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_800_000_000 }, secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: null } },
    });
    expect(s?.windows.map(w => [w.type, w.status])).toEqual([
      ['five_hour', 'rejected'],
      ['seven_day', 'allowed'],
    ]);
    expect(snapshotOfRateLimits({ rateLimits: { primary: null, secondary: null } })).toBeNull();
  });
});
