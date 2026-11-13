import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAllowedHubUrl, loadAgentConfig } from './config.js';
import { createLogger } from './log.js';
import { buildHello, osName } from './machine.js';

const TOKEN = 'fake-token-for-tests-0123456789abcdefghij';

describe('agent config', () => {
  it('applies defaults from the home directory', () => {
    const c = loadAgentConfig({ HUB_URL: 'wss://hub.internal.example.com/ws/agent', AGENT_TOKEN: TOKEN });
    expect(c.claudeProjectsDir).toBe(join(homedir(), '.claude', 'projects'));
    expect(c.stateDir).toBe(join(homedir(), '.agent-hub'));
    expect(c.vaultRoot).toBeNull();
    expect(c.replMaxBytesPerSec).toBe(2097152);
  });

  it('rejects a missing token and a non-WebSocket URL without echoing the token', () => {
    expect(() => loadAgentConfig({ HUB_URL: 'wss://x/ws/agent' })).toThrow(/AGENT_TOKEN/);
    try {
      loadAgentConfig({ HUB_URL: 'https://x/ws/agent', AGENT_TOKEN: TOKEN });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toMatch(/HUB_URL/);
      expect((err as Error).message).not.toContain(TOKEN);
    }
  });
});

describe('HUB_URL scheme', () => {
  it.each([
    ['wss://hub.internal.example.com/ws/agent', true],
    ['ws://127.0.0.1:8787/ws/agent', true],
    ['ws://localhost:8787/ws/agent', true],
    ['ws://[::1]:8787/ws/agent', true],
    ['ws://hub.internal.example.com/ws/agent', false],
    ['ws://10.0.0.3/ws/agent', false],
    ['https://hub.internal.example.com/ws/agent', false],
  ])('%s → %s', (url, ok) => expect(isAllowedHubUrl(url)).toBe(ok));
});

describe('logger', () => {
  it('writes JSON lines, filters by level and redacts the token', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'info', redact: [TOKEN], write: l => lines.push(l) });
    log.debug('hidden');
    log.info('header', { auth: `Bearer ${TOKEN}` });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(TOKEN);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'info', msg: 'header', auth: 'Bearer [redacted]' });
  });
});

describe('hello payload', () => {
  it('describes this machine with protocol and versions', () => {
    const h = buildHello({ vaultRoot: 'C:\\vault' });
    expect(h.protocol).toBe('1.19');
    expect(h.capabilities).toContain('fs.list-dirs');
    expect(h.agentVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(h.sdkVersion).toBe('0.3.310');
    expect(h.claudeCodeVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(h.hostname.length).toBeGreaterThan(0);
    expect(h.homeDir).toBe(homedir());
    expect(h.os).toBe(osName());
    if (process.platform === 'win32') expect(h.os).toMatch(/^Windows/);
  });
  it('REPL_HISTORY_INFLIGHT: 8 by default, 2 when set, 0 refused', () => {
    const env = { HUB_URL: 'wss://hub.internal.example.com/ws/agent', AGENT_TOKEN: 'x'.repeat(40) };
    expect(loadAgentConfig(env).replHistoryInflight).toBe(8);
    expect(loadAgentConfig({ ...env, REPL_HISTORY_INFLIGHT: '2' }).replHistoryInflight).toBe(2);
    expect(() => loadAgentConfig({ ...env, REPL_HISTORY_INFLIGHT: '0' })).toThrow(/REPL_HISTORY_INFLIGHT/);
  });
});
