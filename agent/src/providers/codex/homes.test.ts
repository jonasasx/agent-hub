// provider-parity D2, D4, D5: CODEX_HOME per subscription, the write-back of rotated tokens, the limits mapping.
import { mkdtemp, readFile, rm, writeFile, mkdir, lstat, readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexHomes, fileCredentialStore, stripMcpServers } from './homes.js';
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
    expect(await readFile(join(legacyHome, 'config.toml'), 'utf8')).toBe(`cli_auth_credentials_store = "file"\n${config}`);
    const registryHome = await homes.prepare('registry', '{"v":1}', true);
    const registryConfig = await readFile(join(registryHome, 'config.toml'), 'utf8');
    expect(registryConfig).not.toContain('[mcp_servers.legacy]');
    expect(registryConfig).toContain('[features]');
  });

  it('an unreadable machine config gives the home the credential store line only', async () => {
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
    expect(await readFile(join(home, 'config.toml'), 'utf8')).toBe('cli_auth_credentials_store = "file"\n');
    expect(warnings).toEqual(['Codex config could not be read; the home gets the credential store only']);
  });

  it('logs a failed config write and still prepares the home', async () => {
    const home = join(dir, 'write-state', 'codex-homes', 'write-error');
    await mkdir(join(home, 'config.toml'), { recursive: true });
    const warnings: string[] = [];
    const guardedHomes = new CodexHomes({
      stateDir: join(dir, 'write-state'),
      baseHome: join(dir, 'base'),
      log: { warn: message => warnings.push(message) },
    });
    await expect(guardedHomes.prepare('write-error', '{"v":1}', true)).resolves.toBe(home);
    expect(warnings).toEqual(['Codex config copy failed']);
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
    const old = '{"last_refresh":"2026-10-31T10:00:00Z","tokens":{"account_id":"acc-1"},"n":1}';
    const fresh = '{"last_refresh":"2026-10-31T11:00:00Z","tokens":{"account_id":"acc-1"},"n":2}';
    const h = await homes.prepare('s1', old);
    await writeFile(join(h, 'auth.json'), fresh);
    expect(await homes.changed('s1')).toBe(fresh);
    expect(await homes.changed('s1')).toBe(fresh); // not confirmed: the send failed
    const restarted = new CodexHomes({ stateDir: join(dir, 'state'), baseHome: join(dir, 'base') });
    await restarted.prepare('s1', old);
    expect(await readFile(join(h, 'auth.json'), 'utf8')).toBe(fresh);
    expect(await restarted.changed('s1')).toBe(fresh);
  });

  it('R3: a newer file of another ChatGPT account does not win over the hub copy', async () => {
    const other = '{"last_refresh":"2026-10-31T12:00:00Z","tokens":{"account_id":"acc-old"}}';
    const relogin = '{"last_refresh":"2026-10-31T10:00:00Z","tokens":{"account_id":"acc-new"}}';
    const h = await homes.prepare('s1', other);
    const restarted = new CodexHomes({ stateDir: join(dir, 'state'), baseHome: join(dir, 'base') });
    await restarted.prepare('s1', relogin);
    expect(await readFile(join(h, 'auth.json'), 'utf8')).toBe(relogin);
  });

  it('R3: sync removes homes not in keep, only auth.json of forget, defers busy homes until release', async () => {
    const keep = '11111111-1111-4111-8111-111111111111';
    const gone = '22222222-2222-4222-8222-222222222222';
    const busy = '33333333-3333-4333-8333-333333333333';
    const kept = await homes.prepare(keep, '{"v":1}');
    const goneHome = await homes.prepare(gone, '{"v":1}');
    const busyHome = await homes.prepare(busy, '{"v":1}');
    await writeFile(join(dir, 'base', 'sessions', 'rollout.jsonl'), 'x');
    const login = await homes.tempHome();
    const r = await homes.sync([keep.toUpperCase()], [keep], id => id === busy);
    expect(r).toEqual({ removed: [gone], deferred: [busy] });
    await expect(lstat(goneHome)).rejects.toThrow();
    await expect(lstat(join(kept, 'auth.json'))).rejects.toThrow();
    expect((await lstat(join(kept, 'sessions'))).isSymbolicLink()).toBe(true);
    expect((await lstat(busyHome)).isDirectory()).toBe(true);
    expect((await lstat(login)).isDirectory()).toBe(true);
    // the link was removed, never its target: the machine's Codex threads stay
    expect(await readFile(join(dir, 'base', 'sessions', 'rollout.jsonl'), 'utf8')).toBe('x');
    // a launch after forget writes the hub copy again
    await homes.prepare(keep, '{"v":1}');
    expect(await readFile(join(kept, 'auth.json'), 'utf8')).toBe('{"v":1}');
    expect(await homes.release(keep)).toBe(false);
    expect(await homes.release(busy)).toBe(true);
    await expect(lstat(busyHome)).rejects.toThrow();
  });

  it('R3: a busy home keeps its auth.json on forget and is not removed on release after a bring-back', async () => {
    const id = '44444444-4444-4444-8444-444444444444';
    const home = await homes.prepare(id, '{"v":1}');
    expect(await homes.sync([id], [id], () => true)).toEqual({ removed: [], deferred: [] });
    expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe('{"v":1}');
    expect(await homes.sync([], [], () => true)).toEqual({ removed: [], deferred: [id] });
    await homes.sync([id], [], () => true);
    expect(await homes.release(id)).toBe(false);
    expect((await lstat(home)).isDirectory()).toBe(true);
  });

  it('R6: sweepTemp removes sign-in homes older than the limit only', async () => {
    const now = Date.now();
    const timed = new CodexHomes({ stateDir: join(dir, 'state'), baseHome: join(dir, 'base'), now: () => now });
    const old = await timed.tempHome();
    const fresh = await timed.tempHome();
    const past = new Date(now - 31 * 60_000);
    await utimes(old, past, past);
    expect(await timed.sweepTemp(30 * 60_000)).toBe(1);
    expect((await readdir(join(dir, 'state', 'codex-homes'))).sort()).toEqual([basename(fresh)]);
  });

  it('R12: the credential store is forced to file, other root keys and tables kept', () => {
    expect(fileCredentialStore('')).toBe('cli_auth_credentials_store = "file"\n');
    const toml = 'model = "x"\ncli_auth_credentials_store = "keyring"\n[profiles.a]\ncli_auth_credentials_store = "auto"\n';
    expect(fileCredentialStore(toml)).toBe('cli_auth_credentials_store = "file"\nmodel = "x"\n[profiles.a]\ncli_auth_credentials_store = "auto"\n');
  });

  it('an auth.json removed between turns is written again on the next start (codex-auth-restore)', async () => {
    const token = '{"last_refresh":"2026-11-08T07:00:00Z","n":1}';
    const h = await homes.prepare('s1', token);
    await rm(join(h, 'auth.json'));
    await homes.prepare('s1', token);
    expect(await readFile(join(h, 'auth.json'), 'utf8')).toBe(token);
    // the whole home wiped: recreated with the token
    await rm(h, { recursive: true, force: true });
    await homes.prepare('s1', token);
    expect(await readFile(join(h, 'auth.json'), 'utf8')).toBe(token);
    // an empty or broken file is replaced too
    await writeFile(join(h, 'auth.json'), '');
    await homes.prepare('s1', token);
    expect(await readFile(join(h, 'auth.json'), 'utf8')).toBe(token);
    await writeFile(join(h, 'auth.json'), '{"tok');
    await homes.prepare('s1', token);
    expect(await readFile(join(h, 'auth.json'), 'utf8')).toBe(token);
    expect(await homes.changed('s1')).toBeNull();
  });

  it('a broken auth.json gives way to a changed hub copy', async () => {
    const h = await homes.prepare('s1', '{"last_refresh":"2026-11-08T07:00:00Z","n":1}');
    await writeFile(join(h, 'auth.json'), '{"tok');
    await homes.prepare('s1', '{"last_refresh":"2026-11-08T09:00:00Z","n":3}');
    expect(await readFile(join(h, 'auth.json'), 'utf8')).toBe('{"last_refresh":"2026-11-08T09:00:00Z","n":3}');
  });

  it('a file the CLI rotated after the last start is kept when the hub copy is the same as before', async () => {
    const token = '{"last_refresh":"2026-11-08T07:00:00Z","n":1}';
    const rotated = '{"last_refresh":"2026-11-08T08:00:00Z","n":2}';
    const h = await homes.prepare('s1', token);
    await writeFile(join(h, 'auth.json'), rotated);
    await homes.prepare('s1', token);
    expect(await readFile(join(h, 'auth.json'), 'utf8')).toBe(rotated);
    expect(await homes.changed('s1')).toBe(rotated);
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
