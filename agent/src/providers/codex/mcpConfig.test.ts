// One set of MCP servers for Claude Code and Codex (change agent-providers, design D8).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexMcpServers, expandVars, toCodex } from './mcpConfig.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('toCodex', () => {
  it('stdio and http with variables', () => {
    const env = { TOKEN: 't0k', HOME: '/h' };
    expect(toCodex({ type: 'stdio', command: 'npx', args: ['-y', 'pkg', '${HOME}/x'], env: { KEY: '${TOKEN}' } }, env)).toEqual({
      command: 'npx',
      args: ['-y', 'pkg', '/h/x'],
      env: { KEY: 't0k' },
      startup_timeout_sec: 30,
    });
    expect(toCodex({ type: 'http', url: 'https://m/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } }, env)).toEqual({
      url: 'https://m/mcp',
      http_headers: { Authorization: 'Bearer t0k' },
      startup_timeout_sec: 30,
    });
    expect(toCodex({ url: 'https://m/sse', type: 'sse' }, env)).toEqual({ url: 'https://m/sse', startup_timeout_sec: 30 });
    expect(toCodex({ type: 'sdk', name: 'x' }, env)).toBeNull();
    expect(toCodex({ type: 'stdio' }, env)).toBeNull();
  });
  it('expandVars default', () => {
    expect(expandVars('${NOPE:-d}/${NOPE}', {})).toBe('d/');
  });
});

describe('codexMcpServers', () => {
  it('user + local + approved project servers, minus disabled; local wins', () => {
    const root = mkdtempSync(join(tmpdir(), 'ah-mcp-'));
    dirs.push(root);
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { proj: { command: 'p' }, unapproved: { command: 'u' } } }));
    const key = process.platform === 'win32' ? root.replaceAll('\\', '/').toLowerCase() : root;
    const configPath = join(root, 'claude.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: { a: { type: 'stdio', command: 'a' }, same: { type: 'stdio', command: 'user' }, off: { type: 'stdio', command: 'off' }, weird: { type: 'ws', url: 'ws://x' } },
        projects: { [key]: { mcpServers: { same: { type: 'stdio', command: 'local' } }, disabledMcpServers: ['off'], enabledMcpjsonServers: ['proj'] } },
      }),
    );
    const r = codexMcpServers(join(root, 'sub'), { configPath, env: {}, exclude: ['agent-hub'] });
    expect(Object.keys(r.servers).sort()).toEqual(['a', 'proj', 'same']);
    expect(r.servers.same).toMatchObject({ command: 'local' });
    expect(r.skipped).toEqual(['weird']);
  });
  it('no config: empty', () => {
    expect(codexMcpServers(tmpdir(), { configPath: join(tmpdir(), 'nope-' + Date.now() + '.json'), env: {} }).servers).toEqual({});
  });
});
