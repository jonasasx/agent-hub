// MCP management through the session manager with the real SDK 0.3.310 and the real CLI of the platform package
// (mcp-management design M9, task 2.6): a fake OAuth provider and an MCP server behind Bearer on 127.0.0.1, a temporary
// CLAUDE_CONFIG_DIR — the machine's ~/.claude.json and ~/.claude/.credentials.json are not touched. No model call, no
// network: runs whenever the platform binary is installed.
// Requirements: Вход в удалённый MCP с любого устройства; Защита потока входа MCP; Включение и выключение MCP-сервера;
// MCP машины; Совместимость управления MCP с агентом.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HubMessage, McpSnapshot, PayloadOf } from '@agent-hub/shared';
import { createLogger } from '../log.js';
import { CmdError, SessionManager } from './manager.js';
import { startFakeProvider, type FakeProvider } from './fixtures/fakeOAuthMcp.js';

const require = createRequire(import.meta.url);
function platformBinary(): boolean {
  try {
    require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
    return true;
  } catch {
    return false;
  }
}
const RUN = platformBinary() && process.env.AGENT_HUB_SKIP_REAL_CLI !== '1';
const ECHO = fileURLToPath(new URL('./fixtures/echo-mcp.mjs', import.meta.url));
const HUB_URI = 'https://hub.example.com/mcp/oauth/callback';
const STATIC = 'static-SECRET-0123456789abcdef';
const cmd = <T extends HubMessage['type']>(type: T, payload: PayloadOf<HubMessage, T>): HubMessage => ({ v: 1, ts: Date.now(), id: randomUUID(), type, payload }) as HubMessage;

function fileHash(p: string): string {
  return existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : 'absent';
}
const MACHINE_FILES = [join(homedir(), '.claude.json'), join(homedir(), '.claude', '.credentials.json')];

describe.skipIf(!RUN)('MCP management with the real CLI and a fake OAuth provider', { timeout: 240_000 }, () => {
  let hub: FakeProvider;
  let preset: FakeProvider;
  let cfg: string;
  let project: string;
  let before: string[];
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const logs: string[] = [];
  let mgr: SessionManager;
  const sessions: string[] = [];

  beforeAll(async () => {
    before = MACHINE_FILES.map(fileHash);
    hub = await startFakeProvider('fake-hub-mcp');
    hub.tokens.add(STATIC);
    preset = await startFakeProvider('fake-preset-mcp');
    cfg = mkdtempSync(join(tmpdir(), 'agenthub-mcp-cfg-'));
    project = mkdtempSync(join(tmpdir(), 'agenthub-mcp-proj-'));
    writeFileSync(
      join(cfg, '.claude.json'),
      JSON.stringify({
        hasCompletedOnboarding: true,
        mcpServers: {
          'oauth-hub': { type: 'http', url: hub.mcpUrl },
          'oauth-preset': { type: 'http', url: preset.mcpUrl, oauth: { clientId: 'preset-client' } },
          echo: { type: 'stdio', command: process.execPath, args: [ECHO], env: { ECHO_TOKEN: 'echo-SECRET-1234567890abcdef' } },
          // mcp-auth-controls A7 (c): a static Authorization header the provider accepts — not an OAuth server
          'static-hdr': { type: 'http', url: hub.mcpUrl, headers: { Authorization: `Bearer ${STATIC}` } },
        },
      }),
    );
    mgr = new SessionManager({
      send: (type, payload) => void sent.push({ type, payload: payload as Record<string, unknown> }),
      log: createLogger({ level: 'debug', write: l => void logs.push(l) }),
      queryFn: p => query(p),
      stopGraceMs: 10_000,
      root: false,
      hubProtocol: () => '1.7',
      extraOptions: { env: { ...process.env, CLAUDE_CONFIG_DIR: cfg } },
    });
  });

  afterAll(async () => {
    await mgr?.stopAll(10_000);
    await hub?.close();
    await preset?.close();
    for (const d of [cfg, project]) if (d) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  });

  async function startSession(): Promise<string> {
    const sessionId = randomUUID();
    sessions.push(sessionId);
    await mgr.handle(cmd('session.start', { sessionId, cwd: project, permissionMode: 'default', model: 'haiku', prompt: '', promptUuid: randomUUID() }));
    return sessionId;
  }

  /** mcp.status.get until no server is pending (≤ 30 s). */
  async function settled(sessionId: string): Promise<McpSnapshot> {
    const end = Date.now() + 30_000;
    for (;;) {
      const { snapshot } = (await mgr.handle(cmd('mcp.status.get', { sessionId }))) as { snapshot: McpSnapshot };
      if (!snapshot.servers.some(s => s.status === 'pending') || Date.now() > end) return snapshot;
      await new Promise(r => setTimeout(r, 500));
    }
  }
  const row = (s: McpSnapshot, name: string) => s.servers.find(x => x.name === name);

  /** The «browser»: follows /authorize and returns the Location the provider redirects to. */
  async function browse(authUrl: string): Promise<string> {
    const r = await fetch(authUrl, { redirect: 'manual' });
    expect(r.status).toBe(302);
    return r.headers.get('location')!;
  }

  it('hub redirect: needs-auth → start (hub) → wrong state refused → callback → connected with serverInfo; snapshot redacted', async () => {
    const s1 = await startSession();
    const snap = await settled(s1);
    expect(row(snap, 'oauth-hub')).toMatchObject({ status: 'needs-auth', transport: 'http', target: hub.mcpUrl });
    expect(row(snap, 'echo')).toMatchObject({ status: 'connected', transport: 'stdio', serverInfo: { name: 'echo-mcp', version: '0.0.1' }, toolCount: 1 });
    expect(JSON.stringify(sent)).not.toContain('echo-SECRET');

    const start = (await mgr.handle(cmd('mcp.auth.start', { sessionId: s1, server: 'oauth-hub', redirectUri: HUB_URI }))) as { authUrl: string; redirect: string; state: string };
    expect(start.redirect).toBe('hub');
    const back = await browse(start.authUrl);
    expect(back.startsWith(`${HUB_URI}?`)).toBe(true);
    expect(hub.redirects).toEqual([HUB_URI]);

    const wrong = new URL(back);
    wrong.searchParams.set('state', 'not-this-attempt');
    const err = (await mgr.handle(cmd('mcp.auth.callback', { sessionId: s1, server: 'oauth-hub', callbackUrl: wrong.toString() })).catch((e: unknown) => e)) as CmdError;
    expect(err).toBeInstanceOf(CmdError);
    expect(err.code).toBe('mcp_auth_state_mismatch');

    const done = (await mgr.handle(cmd('mcp.auth.callback', { sessionId: s1, server: 'oauth-hub', callbackUrl: back }))) as { snapshot: McpSnapshot };
    expect(row(done.snapshot, 'oauth-hub')).toMatchObject({ status: 'connected', serverInfo: { name: 'fake-hub-mcp', version: '1.0.0' }, toolCount: 1 });
    expect(sent.filter(m => m.type === 'mcp.auth.done').at(-1)!.payload).toEqual({ sessionId: s1, server: 'oauth-hub', ok: true });
    // the token is in the temporary config, keyed mcpOAuth["<name>|<hash>"]
    const creds = JSON.parse(readFileSync(join(cfg, '.credentials.json'), 'utf8')) as { mcpOAuth?: Record<string, unknown> };
    expect(Object.keys(creds.mcpOAuth ?? {}).some(k => k.startsWith('oauth-hub|'))).toBe(true);
    const code = new URL(back).searchParams.get('code')!;
    expect(logs.join('\n')).not.toContain(code);
  });

  it('localhost fallback (a configured clientId): the pasted address → connected', async () => {
    const s = sessions[0]!;
    const start = (await mgr.handle(cmd('mcp.auth.start', { sessionId: s, server: 'oauth-preset', redirectUri: HUB_URI }))) as { authUrl: string; redirect: string; callbackPort?: number };
    expect(start.redirect).toBe('localhost');
    expect(start.callbackPort).toBeGreaterThan(0);
    const back = await browse(start.authUrl);
    expect(back).toMatch(new RegExp(`^http://localhost:${start.callbackPort}/callback\\?`));
    const done = (await mgr.handle(cmd('mcp.auth.callback', { sessionId: s, server: 'oauth-preset', callbackUrl: back }))) as { snapshot: McpSnapshot };
    expect(row(done.snapshot, 'oauth-preset')).toMatchObject({ status: 'connected', serverInfo: { name: 'fake-preset-mcp' } });
  });

  it('stdio has no sign-in: mcp_auth_unsupported', async () => {
    await expect(mgr.handle(cmd('mcp.auth.start', { sessionId: sessions[0]!, server: 'echo', redirectUri: HUB_URI }))).rejects.toMatchObject({ code: 'mcp_auth_unsupported' });
  });

  it('disable of a user server is kept like /mcp (projects[<dir>].disabledMcpServers); a new process sees it disabled and signed in; enable returns it', async () => {
    const s = sessions[0]!;
    const off = (await mgr.handle(cmd('mcp.action', { sessionId: s, server: 'echo', action: 'disable' }))) as { snapshot: McpSnapshot };
    expect(row(off.snapshot, 'echo')!.status).toBe('disabled');
    // the CLI writes the config asynchronously (seen under a parallel test run): wait for the file (≤ 10 s)
    const disabledIn = (): string[] | null => {
      let c: { projects?: Record<string, { disabledMcpServers?: string[] }> };
      try {
        c = JSON.parse(readFileSync(join(cfg, '.claude.json'), 'utf8')) as typeof c;
      } catch {
        return null; // being written
      }
      return Object.entries(c.projects ?? {})
        .filter(([, v]) => v.disabledMcpServers?.includes('echo'))
        .map(([k]) => k);
    };
    const until = async (pred: () => boolean) => {
      const end = Date.now() + 10_000;
      while (!pred() && Date.now() < end) await new Promise(r => setTimeout(r, 200));
    };
    await until(() => (disabledIn()?.length ?? 0) > 0);
    const keys = disabledIn() ?? [];
    expect(keys).toHaveLength(1);
    expect(keys[0]!.endsWith(basename(project))).toBe(true);

    const s2 = await startSession();
    const snap2 = await settled(s2);
    expect(row(snap2, 'echo')!.status).toBe('disabled');
    // the sign-in of the first session is the machine's: the new process connects without one
    expect(row(snap2, 'oauth-hub')!.status).toBe('connected');

    const on = (await mgr.handle(cmd('mcp.action', { sessionId: s2, server: 'echo', action: 'enable' }))) as { snapshot: McpSnapshot };
    expect(['pending', 'connected']).toContain(row(on.snapshot, 'echo')!.status);
    expect(row(await settled(s2), 'echo')!.status).toBe('connected');
    await until(() => disabledIn()?.length === 0);
    expect(disabledIn()).toEqual([]);
  });

  it('reconnect of a live stdio server keeps the process', async () => {
    const s = sessions[1]!;
    const r = (await mgr.handle(cmd('mcp.action', { sessionId: s, server: 'echo', action: 'reconnect' }))) as { snapshot: McpSnapshot };
    expect(row(r.snapshot, 'echo')!.status).toBe('connected');
    expect(mgr.has(s)).toBe(true);
  });

  // mcp-auth-controls A7 (c): the OAuth mark — yes/no only, no token in any message or log line
  it('the snapshot marks OAuth servers: a saved sign-in yes, a static header and stdio no; no token leaves', async () => {
    const snap = await settled(sessions[0]!);
    expect(row(snap, 'static-hdr')).toMatchObject({ status: 'connected', oauth: false });
    expect(row(snap, 'oauth-hub')).toMatchObject({ status: 'connected', oauth: true });
    expect(row(snap, 'oauth-preset')).toMatchObject({ status: 'connected', oauth: true });
    expect(row(snap, 'echo')).toMatchObject({ oauth: false });
    const out = JSON.stringify(sent) + logs.join('\n') + JSON.stringify(snap);
    for (const t of [...hub.tokens, ...preset.tokens]) expect(out).not.toContain(t);
    expect(out).not.toContain('preset-client');
  });

  // A7 (b): «Войти заново» of a connected server — the CLI drops the local tokens and gives a sign-in page
  it('re-sign-in of a connected server: start gives an authUrl, the callback connects it; the other session reconnects and stays connected', async () => {
    const [s0, s1] = [sessions[0]!, sessions[1]!];
    expect(row(await settled(s1), 'oauth-hub')!.status).toBe('connected');
    const start = (await mgr.handle(cmd('mcp.auth.start', { sessionId: s0, server: 'oauth-hub', redirectUri: HUB_URI }))) as { authUrl: string; redirect: string };
    expect(start.redirect).toBe('hub');
    const back = await browse(start.authUrl);
    const done = (await mgr.handle(cmd('mcp.auth.callback', { sessionId: s0, server: 'oauth-hub', callbackUrl: back }))) as { snapshot: McpSnapshot };
    expect(row(done.snapshot, 'oauth-hub')!.status).toBe('connected');
    const end = Date.now() + 15_000;
    while (!sent.some(m => m.type === 'mcp.auth.done' && m.payload.sessionId === s1) && Date.now() < end) await new Promise(r => setTimeout(r, 200));
    expect(sent.filter(m => m.type === 'mcp.auth.done' && m.payload.sessionId === s1).at(-1)!.payload).toEqual({ sessionId: s1, server: 'oauth-hub', ok: true });
    expect(row(await settled(s1), 'oauth-hub')!.status).toBe('connected');
  });

  // A7 (a): «Выйти» — revoked at the provider, deleted from .credentials.json, needs-auth in both sessions and a new one
  it('sign-out: needs-auth in this and the other live session, the saved sign-in is gone, the provider got a revocation; a new session starts in needs-auth', async () => {
    const [s0, s1] = [sessions[0]!, sessions[1]!];
    const revokedBefore = hub.revocations;
    const r = (await mgr.handle(cmd('mcp.auth.logout', { sessionId: s0, server: 'oauth-hub' }))) as { snapshot: McpSnapshot };
    expect(row(r.snapshot, 'oauth-hub')).toMatchObject({ status: 'needs-auth', oauth: false });
    // the other session reconnects in the background, after cmd.ok
    const until = Date.now() + 20_000;
    while (row(await settled(s1), 'oauth-hub')!.status !== 'needs-auth' && Date.now() < until) await new Promise(res => setTimeout(res, 300));
    expect(row(await settled(s1), 'oauth-hub')!.status).toBe('needs-auth');
    // the other servers keep their sign-in
    expect(row(await settled(s0), 'oauth-preset')!.status).toBe('connected');
    // the reconnect after the clear lets the CLI write back the discovery state with an empty token: no sign-in there
    const creds = JSON.parse(readFileSync(join(cfg, '.credentials.json'), 'utf8')) as { mcpOAuth?: Record<string, { accessToken?: string; refreshToken?: string }> };
    const signedIn = (name: string) => Object.entries(creds.mcpOAuth ?? {}).some(([k, v]) => k.startsWith(`${name}|`) && !!(v.accessToken || v.refreshToken));
    expect(signedIn('oauth-hub')).toBe(false);
    expect(signedIn('oauth-preset')).toBe(true);
    expect(hub.revocations).toBeGreaterThan(revokedBefore);
    const s2 = await startSession();
    expect(row(await settled(s2), 'oauth-hub')).toMatchObject({ status: 'needs-auth', oauth: false });
    expect(logs.join('\n')).toMatch(/mcp sign-out/);
  });

  // QA (prod): the CLI takes the localhost callback itself (a browser of this machine) — the other live sessions connect too
  it('a sign-in finished by the CLI itself (localhost): the other live session reconnects the server', async () => {
    const [s0, s1] = [sessions[0]!, sessions[1]!];
    await mgr.handle(cmd('mcp.auth.logout', { sessionId: s0, server: 'oauth-preset' }));
    const until = async (sid: string, status: string) => {
      const end = Date.now() + 30_000;
      while (row(await settled(sid), 'oauth-preset')!.status !== status && Date.now() < end) await new Promise(res => setTimeout(res, 300));
      return row(await settled(sid), 'oauth-preset')!.status;
    };
    expect(await until(s1, 'needs-auth')).toBe('needs-auth');
    const start = (await mgr.handle(cmd('mcp.auth.start', { sessionId: s0, server: 'oauth-preset', redirectUri: HUB_URI }))) as { authUrl: string; redirect: string };
    expect(start.redirect).toBe('localhost');
    // the «browser» of the machine follows the provider's redirect to the CLI's own listener
    const back = await browse(start.authUrl);
    await fetch(back).catch(() => undefined);
    expect(await until(s0, 'connected')).toBe('connected');
    expect(await until(s1, 'connected')).toBe('connected');
    expect(logs.join('\n')).toMatch(/mcp sign-in ended without the hub/);
  });

  it('sign-out of a stdio server is refused: mcp_auth_unsupported', async () => {
    await expect(mgr.handle(cmd('mcp.auth.logout', { sessionId: sessions[0]!, server: 'echo' }))).rejects.toMatchObject({ code: 'mcp_auth_unsupported' });
  });

  it('the machine files did not change', () => {
    expect(MACHINE_FILES.map(fileHash)).toEqual(before);
  });
});
