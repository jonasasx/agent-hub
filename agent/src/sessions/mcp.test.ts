// MCP of a live session against a scripted SDK (mcp-management tasks 2.2–2.4); the real CLI — mcpAuth.sdk.test.ts.
// Requirements: Статус MCP сессии; Переподключение MCP-сервера; Включение и выключение MCP-сервера; Вход в удалённый MCP
// с любого устройства; Секреты в снимке MCP; Совместимость управления MCP с агентом.
import { randomUUID } from 'node:crypto';
import type { Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { HubMessage, PayloadOf } from '@agent-hub/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../log.js';
import { AsyncQueue } from './asyncQueue.js';
import { CmdError, SessionManager, type QueryFn } from './manager.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MCP_POLL_MS, McpWatch, projectRootOf } from './mcp.js';

interface Srv {
  name: string;
  status: string;
  error?: string;
  config?: Record<string, unknown>;
  scope?: string;
  serverInfo?: { name: string; version: string };
  tools?: unknown[];
}

/** A Query with the MCP control methods: the test sets `servers`, the methods record their calls. */
class McpFake {
  readonly out = new AsyncQueue<SDKMessage>();
  readonly calls: string[] = [];
  servers: Srv[] = [];
  /** Undefined → the method is absent (an older SDK runtime). */
  auth: { start?: (s: string, r?: string) => Promise<unknown>; submit?: (s: string, u: string) => Promise<unknown>; clear?: (s: string) => Promise<unknown> } = {};
  reconnectError: Error | null = null;
  statusError: Error | null = null;
  /** What reconnect does to a server (default: connected). */
  onReconnect: (s: Srv) => void = s => {
    s.status = 'connected';
    s.serverInfo = { name: s.name, version: '1.0.0' };
  };
  constructor(prompt: AsyncIterable<SDKUserMessage>) {
    void (async () => {
      for await (const m of prompt) void m;
      this.out.close();
    })();
  }
  emit(m: Record<string, unknown>): void {
    this.out.push(m as unknown as SDKMessage);
  }
  asQuery(): Query {
    const it = this.out[Symbol.asyncIterator]();
    const q: Record<string | symbol, unknown> = {
      next: () => it.next(),
      return: () => Promise.resolve({ value: undefined, done: true }),
      throw: (e: unknown) => Promise.reject(e),
      [Symbol.asyncIterator]: () => q,
      initializationResult: () => Promise.resolve({}),
      supportedModels: () => Promise.resolve([]),
      close: () => this.out.close(),
      mcpServerStatus: async () => {
        if (this.statusError) throw this.statusError;
        return this.servers.map(s => ({ ...s }));
      },
      reconnectMcpServer: async (n: string) => {
        this.calls.push(`reconnect:${n}`);
        if (this.reconnectError) throw this.reconnectError;
        const s = this.servers.find(x => x.name === n);
        if (s) this.onReconnect(s);
      },
      toggleMcpServer: async (n: string, e: boolean) => {
        this.calls.push(`toggle:${n}:${e}`);
        const s = this.servers.find(x => x.name === n)!;
        s.status = e ? 'pending' : 'disabled';
      },
    };
    if (this.auth.start) q.mcpAuthenticate = (s: string, r?: string) => (this.calls.push(`authenticate:${s}:${r}`), this.auth.start!(s, r));
    if (this.auth.submit) q.mcpSubmitOAuthCallbackUrl = (s: string, u: string) => (this.calls.push(`submit:${s}`), this.auth.submit!(s, u));
    if (this.auth.clear) q.mcpClearAuth = (s: string) => (this.calls.push(`clear:${s}`), this.auth.clear!(s));
    return q as unknown as Query;
  }
}

const HUB_URI = 'https://hub.example.com/mcp/oauth/callback';
const CWD = process.platform === 'win32' ? 'C:' + String.fromCharCode(92) + 'w' : '/w';
const cmd = <T extends HubMessage['type']>(type: T, payload: PayloadOf<HubMessage, T>): HubMessage => ({ v: 1, ts: Date.now(), id: randomUUID(), type, payload }) as HubMessage;
const tick = () => new Promise(r => setTimeout(r, 10));

/** An empty Claude config directory: the unit tests never read the machine's .credentials.json. */
const EMPTY_CFG = mkdtempSync(path.join(tmpdir(), 'mcp-cfg-empty-'));

function setup(o: { hub?: string | null; prepare?: (f: McpFake) => void; cfg?: string } = {}) {
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const logs: string[] = [];
  const fakes: McpFake[] = [];
  const queryFn: QueryFn = ({ prompt }) => {
    const f = new McpFake(prompt);
    o.prepare?.(f);
    fakes.push(f);
    return f.asQuery();
  };
  const mgr = new SessionManager({
    send: (type, payload) => void sent.push({ type, payload: payload as Record<string, unknown> }),
    log: createLogger({ level: 'debug', write: (line: string) => void logs.push(line) }),
    queryFn,
    stopGraceMs: 200,
    root: false,
    hubProtocol: () => (o.hub === undefined ? '1.7' : o.hub),
    extraOptions: { env: { CLAUDE_CONFIG_DIR: o.cfg ?? EMPTY_CFG } },
  });
  const start = async (cwd = CWD) => {
    const sessionId = randomUUID();
    await mgr.handle(cmd('session.start', { sessionId, cwd, permissionMode: 'default', model: 'haiku', prompt: '', promptUuid: randomUUID() }));
    await tick();
    return { sessionId, f: fakes[fakes.length - 1]! };
  };
  const mcpSent = (sessionId?: string) => sent.filter(m => m.type === 'mcp.status' && (!sessionId || m.payload.sessionId === sessionId));
  return { mgr, sent, logs, fakes, start, mcpSent };
}

const notion = (): Srv => ({ name: 'notion', status: 'needs-auth', config: { type: 'http', url: 'https://mcp.notion.com/mcp?k=1', headers: { Authorization: 'Bearer SECRET' } }, scope: 'user' });
const vw = (): Srv => ({
  name: 'vaultwarden',
  status: 'connected',
  config: { type: 'stdio', command: 'node', args: ['vw.js', '--token', 'tok-SECRET-123'], env: { BW_PASSWORD: 'SECRET' } },
  scope: 'user',
  serverInfo: { name: 'vw', version: '1.0.0' },
  tools: [{}, {}],
});

afterEach(() => {
  vi.useRealTimers();
});

describe('McpWatch (task 2.2)', () => {
  const log = createLogger({ level: 'error', write: () => undefined });
  function fakeQuery(servers: Srv[]) {
    return {
      servers,
      q: { mcpServerStatus: async () => servers.map(s => ({ ...s })), reconnectMcpServer: async () => undefined, toggleMcpServer: async () => undefined },
    };
  }

  it('pending → connected gives two messages; no change gives none; polling every 2 s stops when nothing is pending', async () => {
    vi.useFakeTimers();
    const { servers, q } = fakeQuery([{ name: 'a', status: 'pending', config: { command: 'x' } }]);
    const sent: unknown[] = [];
    const w = new McpWatch({ sessionId: 's', query: q, send: (t, p) => void sent.push([t, p]), hubProtocol: () => '1.7', log, now: () => Date.now() });
    await w.start();
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toHaveLength(1); // still pending, unchanged
    servers[0]!.status = 'connected';
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toHaveLength(2);
    expect((sent[1] as [string, { snapshot: { servers: Array<{ status: string }> } }])[1].snapshot.servers[0]!.status).toBe('connected');
    expect(w.timers()).toBe(1); // only the 60-s poll
    await vi.advanceTimersByTimeAsync(MCP_POLL_MS * 3);
    expect(sent).toHaveLength(2);
    w.stop();
  });

  it('the pending poll stops after 30 s; the 60-s poll sends a change', async () => {
    vi.useFakeTimers();
    const { servers, q } = fakeQuery([{ name: 'a', status: 'pending', config: { command: 'x' } }]);
    let reads = 0;
    const counted = { ...q, mcpServerStatus: async () => (reads++, q.mcpServerStatus()) };
    const sent: unknown[] = [];
    const w = new McpWatch({ sessionId: 's', query: counted, send: (t, p) => void sent.push([t, p]), hubProtocol: () => '1.7', log, now: () => Date.now() });
    await w.start();
    await vi.advanceTimersByTimeAsync(40_000);
    const afterWindow = reads;
    expect(afterWindow).toBeLessThanOrEqual(17);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads).toBe(afterWindow); // nothing until the 60-s poll
    servers[0]!.status = 'failed';
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sent).toHaveLength(2);
    w.stop();
  });

  it('a change while the hub link is down is sent after the reconnect (resync on welcome)', async () => {
    const { servers, q } = fakeQuery([{ name: 'a', status: 'connected', config: { command: 'x' } }]);
    const sent: unknown[] = [];
    let proto: string | null = '1.7';
    const w = new McpWatch({ sessionId: 's', query: q, send: (t, p) => void sent.push([t, p]), hubProtocol: () => proto, log });
    await w.start();
    expect(sent).toHaveLength(1);
    proto = null; // disconnected
    servers[0]!.status = 'failed';
    await w.poll();
    expect(sent).toHaveLength(1);
    proto = '1.7'; // welcome
    await w.poll();
    expect(sent).toHaveLength(1); // the hash already saw it: without resync the hub never learns
    await w.resync();
    expect(sent).toHaveLength(2);
    expect((sent[1] as [string, { snapshot: { servers: Array<{ status: string }> } }])[1].snapshot.servers[0]!.status).toBe('failed');
    w.stop();
  });

  it('a hub of 1.6 gets nothing; after stop no timers and no messages', async () => {
    vi.useFakeTimers();
    const { servers, q } = fakeQuery([{ name: 'a', status: 'pending', config: { command: 'x' } }]);
    const sent: unknown[] = [];
    const w = new McpWatch({ sessionId: 's', query: q, send: (t, p) => void sent.push([t, p]), hubProtocol: () => '1.6', log });
    await w.start();
    servers[0]!.status = 'connected';
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent).toHaveLength(0);
    expect(w.snapshot?.servers[0]!.status).toBe('connected');
    w.stop();
    expect(w.timers()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(await w.poll()).toBeNull();
  });
});

describe('SessionManager: MCP status and actions (tasks 2.2, 2.3)', () => {
  it('a snapshot right after start, redacted: no env, headers, token or query', async () => {
    const t = setup({ prepare: f => (f.servers = [vw(), notion()]) });
    const { sessionId } = await t.start();
    const msgs = t.mcpSent(sessionId);
    expect(msgs).toHaveLength(1);
    const snap = msgs[0]!.payload.snapshot as { servers: unknown[] };
    expect(snap.servers).toEqual([
      { name: 'vaultwarden', status: 'connected', transport: 'stdio', target: 'node vw.js --token •••', scope: 'user', serverInfo: { name: 'vw', version: '1.0.0' }, toolCount: 2, oauth: false },
      { name: 'notion', status: 'needs-auth', transport: 'http', target: 'https://mcp.notion.com/mcp', scope: 'user', toolCount: 0, oauth: false },
    ]);
    expect(JSON.stringify(t.sent)).not.toMatch(/SECRET|k=1/);
    expect(t.logs.join('\n')).not.toMatch(/SECRET/);
  });

  it('the built-in agent-hub server (session-peers) is not in the snapshot: «Выключить» cannot touch it', async () => {
    const t = setup({ prepare: f => (f.servers = [vw(), { name: 'agent-hub', status: 'connected', config: { type: 'sdk' }, tools: [{}, {}, {}] }]) });
    const { sessionId } = await t.start();
    const snap = t.mcpSent(sessionId)[0]!.payload.snapshot as { servers: Array<{ name: string }> };
    expect(snap.servers.map(s => s.name)).toEqual(['vaultwarden']);
  });

  it('a snapshot at the end of a turn, only when it changed', async () => {
    const t = setup({ prepare: f => (f.servers = [vw()]) });
    const { sessionId, f } = await t.start();
    f.emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, total_cost_usd: 0, usage: {}, result: 'ok' });
    await tick();
    expect(t.mcpSent(sessionId)).toHaveLength(1);
    f.servers[0]!.status = 'failed';
    f.servers[0]!.error = 'ECONNREFUSED';
    f.emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, total_cost_usd: 0, usage: {}, result: 'ok' });
    await tick();
    expect(t.mcpSent(sessionId)).toHaveLength(2);
  });

  it('a hub of 1.6: no mcp.status at all', async () => {
    const t = setup({ hub: '1.6', prepare: f => (f.servers = [vw()]) });
    await t.start();
    expect(t.mcpSent()).toHaveLength(0);
  });

  it('mcp.status.get → cmd.ok {snapshot}; no process → not_running', async () => {
    const t = setup({ prepare: f => (f.servers = [vw()]) });
    const { sessionId } = await t.start();
    const r = (await t.mgr.handle(cmd('mcp.status.get', { sessionId }))) as { snapshot: { servers: unknown[] } };
    expect(r.snapshot.servers).toHaveLength(1);
    await expect(t.mgr.handle(cmd('mcp.status.get', { sessionId: randomUUID() }))).rejects.toMatchObject({ code: 'not_running' });
  });

  it('reconnect → reconnectMcpServer; disable/enable → toggleMcpServer; the answer is a fresh snapshot', async () => {
    const t = setup({ prepare: f => (f.servers = [{ ...vw(), status: 'failed', error: 'x' }]) });
    const { sessionId, f } = await t.start();
    const r1 = (await t.mgr.handle(cmd('mcp.action', { sessionId, server: 'vaultwarden', action: 'reconnect' }))) as { snapshot: { servers: Array<{ status: string }> } };
    expect(r1.snapshot.servers[0]!.status).toBe('connected');
    const r2 = (await t.mgr.handle(cmd('mcp.action', { sessionId, server: 'vaultwarden', action: 'disable' }))) as { snapshot: { servers: Array<{ status: string }> } };
    expect(r2.snapshot.servers[0]!.status).toBe('disabled');
    await t.mgr.handle(cmd('mcp.action', { sessionId, server: 'vaultwarden', action: 'enable' }));
    expect(f.calls).toEqual(['reconnect:vaultwarden', 'toggle:vaultwarden:false', 'toggle:vaultwarden:true']);
  });

  it('an unknown server → mcp_unknown_server; an SDK error → mcp_action_failed with the text redacted', async () => {
    const t = setup({ prepare: f => (f.servers = [vw()]) });
    const { sessionId, f } = await t.start();
    await expect(t.mgr.handle(cmd('mcp.action', { sessionId, server: 'nope', action: 'reconnect' }))).rejects.toMatchObject({ code: 'mcp_unknown_server' });
    f.reconnectError = new Error('connect ECONNREFUSED https://x.example/mcp?api_key=SECRET with API_TOKEN=SECRET');
    const err = (await t.mgr.handle(cmd('mcp.action', { sessionId, server: 'vaultwarden', action: 'reconnect' })).catch((e: unknown) => e)) as CmdError;
    expect(err).toBeInstanceOf(CmdError);
    expect(err.code).toBe('mcp_action_failed');
    expect(err.message).toBe('connect ECONNREFUSED https://x.example/mcp with API_TOKEN=•••');
    expect(f.calls).toEqual(['reconnect:vaultwarden']);
  });

  it('after the process exits: not_running, the watch has no timers', async () => {
    const t = setup({ prepare: f => (f.servers = [vw()]) });
    const { sessionId } = await t.start();
    await t.mgr.handle(cmd('session.stop', { sessionId, reason: 'user' }));
    await expect(t.mgr.handle(cmd('mcp.action', { sessionId, server: 'vaultwarden', action: 'reconnect' }))).rejects.toMatchObject({ code: 'not_running' });
  });
});

describe('SessionManager: sign-in (task 2.4)', () => {
  const STATE = 'st-123';
  const hubAuth = (f: McpFake) => {
    f.auth.start = async () => ({ authUrl: 'https://mcp.notion.com/authorize?state=st-123', requiresUserAction: true, callbackExpected: true, redirectScheme: 'custom', state: STATE });
    f.auth.submit = async (_s, url) => {
      if (!url.includes(`state=${STATE}`)) throw new Error('Callback URL not accepted: it belongs to a different sign-in attempt (OAuth state mismatch). Paste the URL from this attempt.');
      return {};
    };
  };

  it('start → hub redirect with the state; callback → submit, then reconnect, then a snapshot; mcp.auth.done ok', async () => {
    const t = setup({ prepare: f => ((f.servers = [notion()]), hubAuth(f)) });
    const { sessionId, f } = await t.start();
    const r = await t.mgr.handle(cmd('mcp.auth.start', { sessionId, server: 'notion', redirectUri: HUB_URI }));
    expect(r).toEqual({ authUrl: 'https://mcp.notion.com/authorize?state=st-123', redirect: 'hub', state: STATE });
    const cb = `${HUB_URI}?code=CODE-SECRET-42&state=${STATE}`;
    const done = (await t.mgr.handle(cmd('mcp.auth.callback', { sessionId, server: 'notion', callbackUrl: cb }))) as { snapshot: { servers: Array<{ status: string }> } };
    expect(f.calls).toEqual([`authenticate:notion:${HUB_URI}`, 'submit:notion', 'reconnect:notion']);
    expect(done.snapshot.servers[0]!.status).toBe('connected');
    expect(t.sent.filter(m => m.type === 'mcp.auth.done')).toEqual([{ type: 'mcp.auth.done', payload: { sessionId, server: 'notion', ok: true } }]);
    // the address with the code is never logged
    expect(t.logs.join('\n')).not.toMatch(/code=|CODE-SECRET/);
  });

  it('localhost scheme → redirect localhost with the port', async () => {
    const t = setup({
      prepare: f => {
        f.servers = [notion()];
        f.auth.start = async () => ({ authUrl: 'https://p/authorize', redirectScheme: 'localhost', state: 's', callbackPort: 53412 });
      },
    });
    const { sessionId } = await t.start();
    expect(await t.mgr.handle(cmd('mcp.auth.start', { sessionId, server: 'notion', redirectUri: HUB_URI }))).toEqual({
      authUrl: 'https://p/authorize',
      redirect: 'localhost',
      state: 's',
      callbackPort: 53412,
    });
  });

  it('a wrong state → mcp_auth_state_mismatch, no reconnect; then the right one works', async () => {
    const t = setup({ prepare: f => ((f.servers = [notion()]), hubAuth(f)) });
    const { sessionId, f } = await t.start();
    await t.mgr.handle(cmd('mcp.auth.start', { sessionId, server: 'notion', redirectUri: HUB_URI }));
    await expect(t.mgr.handle(cmd('mcp.auth.callback', { sessionId, server: 'notion', callbackUrl: `${HUB_URI}?code=c&state=other` }))).rejects.toMatchObject({ code: 'mcp_auth_state_mismatch' });
    expect(f.calls).not.toContain('reconnect:notion');
    await t.mgr.handle(cmd('mcp.auth.callback', { sessionId, server: 'notion', callbackUrl: `${HUB_URI}?code=c&state=${STATE}` }));
    expect(f.calls).toContain('reconnect:notion');
  });

  it('mcp_auth_unsupported: no method in the runtime, a stdio server, a claudeai-proxy server', async () => {
    const t = setup({ prepare: f => (f.servers = [notion(), vw(), { name: 'c', status: 'needs-auth', config: { type: 'claudeai-proxy', url: 'https://x', id: 'i' } }]) });
    const { sessionId } = await t.start();
    await expect(t.mgr.handle(cmd('mcp.auth.start', { sessionId, server: 'notion', redirectUri: HUB_URI }))).rejects.toMatchObject({
      code: 'mcp_auth_unsupported',
      message: expect.stringContaining('run /mcp in a terminal'),
    });
    const t2 = setup({ prepare: f => ((f.servers = [vw(), { name: 'c', status: 'needs-auth', config: { type: 'claudeai-proxy', url: 'https://x', id: 'i' } }]), hubAuth(f)) });
    const s2 = await t2.start();
    await expect(t2.mgr.handle(cmd('mcp.auth.start', { sessionId: s2.sessionId, server: 'vaultwarden', redirectUri: HUB_URI }))).rejects.toMatchObject({ code: 'mcp_auth_unsupported' });
    await expect(t2.mgr.handle(cmd('mcp.auth.start', { sessionId: s2.sessionId, server: 'c', redirectUri: HUB_URI }))).rejects.toMatchObject({ code: 'mcp_auth_unsupported' });
    expect(s2.f.calls).toEqual([]);
  });

  it('mcp_auth_failed: the CLI throws, or returns no page', async () => {
    const t = setup({
      prepare: f => {
        f.servers = [notion()];
        f.auth.start = async () => {
          throw new Error('AS metadata fetch failed for https://x/.well-known?y=SECRET');
        };
      },
    });
    const { sessionId } = await t.start();
    const err = (await t.mgr.handle(cmd('mcp.auth.start', { sessionId, server: 'notion', redirectUri: HUB_URI })).catch((e: unknown) => e)) as CmdError;
    expect(err.code).toBe('mcp_auth_failed');
    expect(err.message).not.toContain('SECRET');
    const t2 = setup({ prepare: f => ((f.servers = [notion()]), (f.auth.start = async () => ({ requiresUserAction: false }))) });
    const s2 = await t2.start();
    await expect(t2.mgr.handle(cmd('mcp.auth.start', { sessionId: s2.sessionId, server: 'notion', redirectUri: HUB_URI }))).rejects.toMatchObject({ code: 'mcp_auth_failed' });
  });

  it('after a sign-in the same server of the other live sessions is reconnected and reported: needs-auth, and (1.8) failed/connected of the same address', async () => {
    const t = setup({ prepare: f => ((f.servers = [notion()]), hubAuth(f)) });
    const a = await t.start();
    const b = await t.start();
    const c = await t.start();
    const d = await t.start();
    const e = await t.start();
    const g = await t.start();
    c.f.servers = [{ ...notion(), status: 'connected' }];
    d.f.servers = [{ ...notion(), status: 'failed', error: 'HTTP 401' }];
    e.f.servers = [{ ...notion(), status: 'connected', config: { type: 'http', url: 'https://other.example/mcp' } }];
    g.f.servers = [{ ...notion(), status: 'disabled' }];
    for (const x of [c, d, e, g]) await t.mgr.handle(cmd('mcp.status.get', { sessionId: x.sessionId }));
    await t.mgr.handle(cmd('mcp.auth.start', { sessionId: a.sessionId, server: 'notion', redirectUri: HUB_URI }));
    await t.mgr.handle(cmd('mcp.auth.callback', { sessionId: a.sessionId, server: 'notion', callbackUrl: `${HUB_URI}?code=c&state=${STATE}` }));
    await tick();
    expect(b.f.calls).toEqual(['reconnect:notion']);
    expect(c.f.calls).toEqual(['reconnect:notion']); // its old sign-in was dropped by the attempt
    expect(d.f.calls).toEqual(['reconnect:notion']);
    expect(e.f.calls).toEqual([]); // another address: another sign-in
    expect(g.f.calls).toEqual([]); // disabled
    const last = t.mcpSent(b.sessionId).at(-1)!.payload.snapshot as { servers: Array<{ status: string }> };
    expect(last.servers[0]!.status).toBe('connected');
    expect(t.sent.filter(m => m.type === 'mcp.auth.done').map(m => m.payload)).toEqual([
      { sessionId: a.sessionId, server: 'notion', ok: true },
      { sessionId: b.sessionId, server: 'notion', ok: true },
      { sessionId: c.sessionId, server: 'notion', ok: true },
      { sessionId: d.sessionId, server: 'notion', ok: true },
    ]);
  });
});

describe('SessionManager: a sign-in ended without the hub (mcp-auth-controls, re-review)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const creds = (d: string, token: boolean) =>
    writeFileSync(path.join(d, '.credentials.json'), JSON.stringify({ mcpOAuth: token ? { 'fleet|ab': { serverUrl: 'https://fleet.example/mcp', accessToken: `at-${Date.now()}-1234567` } } : {} }));
  const fleet = (): Srv => ({ name: 'fleet', status: 'connected', config: { type: 'http', url: 'https://fleet.example/mcp', oauth: { clientId: 'c' } }, tools: [{}] });
  const local = (f: McpFake) => {
    f.servers = [fleet()];
    f.auth.start = async () => ({ authUrl: 'https://fleet.example/authorize', requiresUserAction: true, redirectScheme: 'localhost', state: 'st-l', callbackPort: 53412 });
    f.auth.submit = async () => ({});
  };
  const doneOf = (t: ReturnType<typeof setup>) => t.sent.filter(m => m.type === 'mcp.auth.done');

  it('«Войти заново» of a connected server, the CLI takes the localhost callback: token gone, then saved again while connected → mcp.auth.done ok once', async () => {
    const cfg = mkdtempSync(path.join(tmpdir(), 'mcp-cfg-si-'));
    dirs.push(cfg);
    creds(cfg, true);
    const t = setup({ cfg, prepare: local });
    const { sessionId } = await t.start();
    const poll = () => t.mgr.handle(cmd('mcp.status.get', { sessionId }));
    await t.mgr.handle(cmd('mcp.auth.start', { sessionId, server: 'fleet', redirectUri: HUB_URI }));
    creds(cfg, false); // the CLI dropped the local token at the start of the attempt; the process stays connected
    await poll();
    expect(doneOf(t)).toEqual([]);
    creds(cfg, true); // the CLI's own callback saved a new token
    await poll();
    expect(doneOf(t).map(m => m.payload)).toEqual([{ sessionId, server: 'fleet', ok: true }]);
    await poll();
    expect(doneOf(t)).toHaveLength(1);
  });

  it('no address of the server in the source session: nothing is reconnected elsewhere', async () => {
    const noUrl = (status: string): Srv => ({ name: 'fleet', status, config: { type: 'http' }, tools: [{}] });
    const t = setup({ prepare: f => ((f.servers = [noUrl('needs-auth')]), local(f), (f.servers = [noUrl('needs-auth')])) });
    const a = await t.start();
    const b = await t.start();
    const poll = () => t.mgr.handle(cmd('mcp.status.get', { sessionId: a.sessionId }));
    await t.mgr.handle(cmd('mcp.status.get', { sessionId: b.sessionId }));
    await t.mgr.handle(cmd('mcp.auth.start', { sessionId: a.sessionId, server: 'fleet', redirectUri: HUB_URI }));
    await poll();
    a.f.servers[0]!.status = 'connected';
    await poll();
    for (let i = 0; i < 10; i++) await tick();
    expect(doneOf(t).map(m => m.payload.sessionId)).toEqual([a.sessionId]);
    expect(b.f.calls).toEqual([]);
  });

  it('QA (prod): a sign-in the CLI finished itself reconnects the same server (name and address) in the other live sessions', async () => {
    const t = setup({ prepare: local });
    const a = await t.start();
    const b = await t.start();
    const c = await t.start();
    b.f.servers = [{ ...fleet(), status: 'needs-auth' }];
    c.f.servers = [{ ...fleet(), status: 'needs-auth', config: { type: 'http', url: 'https://other.example/mcp' } }];
    for (const x of [b, c]) await t.mgr.handle(cmd('mcp.status.get', { sessionId: x.sessionId }));
    const poll = () => t.mgr.handle(cmd('mcp.status.get', { sessionId: a.sessionId }));
    await t.mgr.handle(cmd('mcp.auth.start', { sessionId: a.sessionId, server: 'fleet', redirectUri: HUB_URI }));
    a.f.servers[0]!.status = 'needs-auth';
    await poll();
    a.f.servers[0]!.status = 'connected';
    await poll();
    for (let i = 0; i < 20 && !doneOf(t).some(m => m.payload.sessionId === b.sessionId); i++) await tick();
    expect(b.f.calls).toEqual(['reconnect:fleet']);
    expect(c.f.calls).toEqual([]); // another address
    expect(t.mcpSent(b.sessionId).at(-1)!.payload.snapshot).toMatchObject({ servers: [{ name: 'fleet', status: 'connected' }] });
    expect(doneOf(t).map(m => m.payload)).toEqual([
      { sessionId: a.sessionId, server: 'fleet', ok: true },
      { sessionId: b.sessionId, server: 'fleet', ok: true },
    ]);
  });

  it('a server that left connected and came back connected ends the attempt; the hub callback path does not report it twice', async () => {
    const t = setup({ prepare: local });
    const { sessionId, f } = await t.start();
    const poll = () => t.mgr.handle(cmd('mcp.status.get', { sessionId }));
    await t.mgr.handle(cmd('mcp.auth.start', { sessionId, server: 'fleet', redirectUri: HUB_URI }));
    await poll();
    expect(doneOf(t)).toEqual([]); // connected all along, no token known: not a sign-in yet
    f.servers[0]!.status = 'needs-auth';
    await poll();
    f.servers[0]!.status = 'connected';
    await poll();
    expect(doneOf(t).map(m => m.payload)).toEqual([{ sessionId, server: 'fleet', ok: true }]);

    // a hub-redirect attempt ended by mcp.auth.callback: one mcp.auth.done
    await t.mgr.handle(cmd('mcp.auth.start', { sessionId, server: 'fleet', redirectUri: HUB_URI }));
    f.servers[0]!.status = 'needs-auth';
    await poll();
    f.servers[0]!.status = 'connected';
    await t.mgr.handle(cmd('mcp.auth.callback', { sessionId, server: 'fleet', callbackUrl: `${HUB_URI}?code=c&state=st-l` }));
    await poll();
    expect(doneOf(t)).toHaveLength(2);
  });
});

describe('SessionManager: sign-out (mcp-auth-controls A3, task 2.2)', () => {
  const connected = (): Srv => ({ ...notion(), status: 'connected', tools: [{}] });
  /** The CLI after mcp_clear_auth: `failed: Authentication cleared`; a reconnect without a token → needs-auth. */
  const cli = (f: McpFake) => {
    f.servers = [connected(), vw()];
    f.auth.clear = async n => {
      const s = f.servers.find(x => x.name === n)!;
      s.status = 'failed';
      s.error = 'Authentication cleared';
      return {};
    };
    f.onReconnect = s => {
      s.status = 'needs-auth';
      delete s.error;
    };
  };

  it('clear → reconnect → snapshot (needs-auth); the other live sessions of the same address reconnect, a disabled or another-address one does not', async () => {
    const t = setup({ prepare: cli });
    const a = await t.start();
    const b = await t.start();
    const c = await t.start();
    const d = await t.start();
    c.f.servers = [{ ...connected(), status: 'disabled' }];
    d.f.servers = [{ ...connected(), config: { type: 'http', url: 'https://other.example/mcp' } }];
    const r = (await t.mgr.handle(cmd('mcp.auth.logout', { sessionId: a.sessionId, server: 'notion' }))) as { snapshot: { servers: Array<{ name: string; status: string }> } };
    expect(a.f.calls).toEqual(['clear:notion', 'reconnect:notion']);
    expect(r.snapshot.servers.find(x => x.name === 'notion')!.status).toBe('needs-auth');
    // the other sessions reconnect in the background, after cmd.ok
    for (let i = 0; i < 20 && !t.logs.join('\n').includes('mcp sign-out'); i++) await tick();
    expect(b.f.calls).toEqual(['reconnect:notion']);
    expect(t.mcpSent(b.sessionId).at(-1)!.payload.snapshot).toMatchObject({ servers: [{ name: 'notion', status: 'needs-auth' }, { name: 'vaultwarden' }] });
    expect(c.f.calls).toEqual([]);
    expect(d.f.calls).toEqual([]);
    expect(t.logs.join('\n')).toMatch(/mcp sign-out/);
  });

  it('a runtime without mcpClearAuth → mcp_auth_unsupported with the spec text naming the server; stdio → mcp_auth_unsupported; an SDK error → mcp_auth_failed', async () => {
    const t = setup({ prepare: f => (f.servers = [connected(), vw()]) });
    const a = await t.start();
    const err = (await t.mgr.handle(cmd('mcp.auth.logout', { sessionId: a.sessionId, server: 'notion' })).catch((e: unknown) => e)) as CmdError;
    expect(err).toBeInstanceOf(CmdError);
    expect(err.code).toBe('mcp_auth_unsupported');
    expect(err.message).toBe('Sign-out from the hub is not supported by this Claude Code version on the machine: run claude mcp logout notion in a terminal');
    expect(a.f.calls).toEqual([]);

    const t2 = setup({ prepare: cli });
    const b = await t2.start();
    await expect(t2.mgr.handle(cmd('mcp.auth.logout', { sessionId: b.sessionId, server: 'vaultwarden' }))).rejects.toMatchObject({ code: 'mcp_auth_unsupported' });
    await expect(t2.mgr.handle(cmd('mcp.auth.logout', { sessionId: b.sessionId, server: 'nope' }))).rejects.toMatchObject({ code: 'mcp_unknown_server' });
    b.f.auth.clear = async () => {
      throw new Error('revoke failed for https://p.example/revoke?token=SECRET-abc');
    };
    const e2 = (await t2.mgr.handle(cmd('mcp.auth.logout', { sessionId: b.sessionId, server: 'notion' })).catch((e: unknown) => e)) as CmdError;
    expect(e2.code).toBe('mcp_auth_failed');
    expect(e2.message).not.toContain('SECRET');
    expect(t2.logs.join('\n')).not.toContain('SECRET');
  });
});

describe('the OAuth mark of a snapshot (mcp-auth-controls A1, task 2.1)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function cfgWith(store: unknown): string {
    const d = mkdtempSync(path.join(tmpdir(), 'mcp-cfg-'));
    dirs.push(d);
    writeFileSync(path.join(d, '.credentials.json'), JSON.stringify(store));
    return d;
  }
  const TOKEN = 'at-SECRET-TOKEN-0123456789abcdef';

  it('true only with a saved non-empty token of the same name and address; false for an oauth block or needs-auth without one, static headers, stdio; no token in the message or the log', async () => {
    const cfg = cfgWith({
      claudeAiOauth: { accessToken: 'claude-SECRET' },
      mcpOAuth: {
        'saved|0a1b2c': { serverName: 'saved', serverUrl: 'https://saved.example/sse?x=1', accessToken: TOKEN, refreshToken: 'rt-SECRET', clientId: 'cid-SECRET', clientSecret: 'cs-SECRET' },
        'emptied|9f9f': { serverName: 'emptied', serverUrl: 'https://emptied.example/mcp', accessToken: '', clientId: 'cid' },
        'moved|1234': { serverName: 'moved', serverUrl: 'https://old.example/mcp', accessToken: 'at-1234567890' },
        'legacy|5678': { serverName: 'legacy', refreshToken: 'rt-1234567890' },
        'stdio-saved|0000': { serverName: 'stdio-saved', accessToken: 'at-1234567890' },
      },
    });
    const servers: Srv[] = [
      { name: 'preset', status: 'connected', config: { type: 'http', url: 'https://fleet.example/mcp', oauth: { clientId: 'cid-SECRET' } } },
      { name: 'notion', status: 'needs-auth', config: { type: 'http', url: 'https://mcp.notion.com/mcp' } },
      { name: 'saved', status: 'connected', config: { type: 'sse', url: 'https://saved.example/sse' } },
      { name: 'emptied', status: 'connected', config: { type: 'http', url: 'https://emptied.example/mcp' } },
      { name: 'moved', status: 'connected', config: { type: 'http', url: 'https://new.example/mcp' } },
      { name: 'legacy', status: 'connected', config: { type: 'http', url: 'https://legacy.example/mcp' } },
      { name: 'static', status: 'connected', config: { type: 'http', url: 'https://static.example/mcp', headers: { Authorization: 'Bearer SECRET' } } },
      { name: 'stdio-saved', status: 'connected', config: { command: 'node', args: ['x.js'] } },
    ];
    const t = setup({ cfg, prepare: f => (f.servers = servers) });
    const { sessionId } = await t.start();
    const snap = t.mcpSent(sessionId)[0]!.payload.snapshot as { servers: Array<{ name: string; oauth?: boolean }> };
    expect(Object.fromEntries(snap.servers.map(x => [x.name, x.oauth]))).toEqual({
      preset: false,
      notion: false,
      saved: true,
      emptied: false,
      moved: false,
      legacy: true,
      static: false,
      'stdio-saved': false,
    });
    const all = JSON.stringify(t.sent) + t.logs.join('\n');
    expect(all).not.toMatch(/SECRET/);
    expect(all).not.toContain(TOKEN);
  });

  it('the store is re-read when it changes; a missing or broken file → no saved sign-in', async () => {
    const cfg = cfgWith({ mcpOAuth: {} });
    const t = setup({ cfg, prepare: f => (f.servers = [{ name: 'saved', status: 'connected', config: { type: 'http', url: 'https://saved.example/mcp' } }]) });
    const { sessionId } = await t.start();
    const mark = async () => ((await t.mgr.handle(cmd('mcp.status.get', { sessionId }))) as { snapshot: { servers: Array<{ oauth?: boolean }> } }).snapshot.servers[0]!.oauth;
    expect(await mark()).toBe(false);
    writeFileSync(path.join(cfg, '.credentials.json'), JSON.stringify({ mcpOAuth: { 'saved|abc': { refreshToken: 'rt-1234567' } } }));
    expect(await mark()).toBe(true);
    writeFileSync(path.join(cfg, '.credentials.json'), '{ broken');
    expect(await mark()).toBe(false);
    rmSync(path.join(cfg, '.credentials.json'));
    expect(await mark()).toBe(false);
  });
});

// QA fix 3: the CLI keeps a disable under projects[<canonical git root>], not under the session directory.
describe('projectRoot of a snapshot', () => {
  const norm = (p: string) => (process.platform === 'win32' ? p.replaceAll(String.fromCharCode(92), '/') : p);
  let base = '';
  afterEach(() => {
    if (base) rmSync(base, { recursive: true, force: true });
    base = '';
  });
  function repo() {
    base = mkdtempSync(path.join(tmpdir(), 'mcp-root-'));
    const main = path.join(base, 'vault');
    mkdirSync(path.join(main, '.git', 'worktrees', 'wt'), { recursive: true });
    mkdirSync(path.join(main, '.tmp', 'mcp-qa'), { recursive: true });
    const wt = path.join(base, 'wt');
    mkdirSync(path.join(wt, 'sub'), { recursive: true });
    writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'wt')}\n`);
    writeFileSync(path.join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    const plain = path.join(base, 'plain', 'dir');
    mkdirSync(plain, { recursive: true });
    return { main, wt, plain };
  }

  it('a subfolder → the git root; a linked worktree → its main checkout; outside git → the folder itself', () => {
    const { main, wt, plain } = repo();
    expect(projectRootOf(path.join(main, '.tmp', 'mcp-qa'))).toBe(norm(main));
    expect(projectRootOf(main)).toBe(norm(main));
    expect(projectRootOf(path.join(wt, 'sub'))).toBe(norm(main));
    expect(projectRootOf(plain)).toBe(norm(plain));
    expect(projectRootOf('C:' + String.fromCharCode(92) + 'no-such-dir-mcp' + String.fromCharCode(92) + 'x', 'win32')).toBe('C:/no-such-dir-mcp/x');
  });

  it('a session in a subfolder of a repository sends the repository root in mcp.status', async () => {
    const { main } = repo();
    const { start, mcpSent } = setup({ prepare: f => (f.servers = [vw()]) });
    const { sessionId } = await start(path.join(main, '.tmp', 'mcp-qa'));
    const snap = mcpSent(sessionId)[0]!.payload.snapshot as { projectRoot?: string };
    expect(snap.projectRoot).toBe(norm(main));
  });
});
