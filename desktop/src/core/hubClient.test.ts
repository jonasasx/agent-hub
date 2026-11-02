// Requirement: Соединение приложения с хабом (design D4). Fake socket, fetch and timers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SidebarResponse } from '@agent-hub/shared';
import { RUNNERS, session } from '../test/factories.js';
import { HubClient, PING_MS, wsUrl, type HubClientDeps, type HubConnState, type SocketHandlers } from './hubClient.js';
import { HubState } from './hubState.js';

interface FakeSocket {
  url: string;
  headers: Record<string, string>;
  h: SocketHandlers;
  sent: string[];
  closed: boolean;
}

function setup(opts: { cookie?: string | null; sidebarStatus?: number } = {}) {
  const sockets: FakeSocket[] = [];
  const states: HubConnState[] = [];
  const model = new HubState();
  const notes: string[] = [];
  let sidebarStatus = opts.sidebarStatus ?? 200;
  let sidebar: SidebarResponse = { now: [], projects: [], runners: [...RUNNERS.values()] };
  let healthStatus = 503;
  const fetchMock = vi.fn(async (url: string, _init: { headers: Record<string, string> }) =>
    url.endsWith('/healthz') ? { status: healthStatus, json: async () => ({}) } : { status: sidebarStatus, json: async () => structuredClone(sidebar) },
  );
  const sidebarCalls = () => fetchMock.mock.calls.filter(([u]) => u.endsWith('/api/sidebar')).length;
  const deps: HubClientDeps = {
    hubUrl: 'https://hub.example.com',
    userAgent: 'AgentHubDesktop/0.1.0',
    getCookie: async () => (opts.cookie === undefined ? 'tok' : opts.cookie),
    openSocket: (url, headers, h) => {
      const s: FakeSocket = { url, headers, h, sent: [], closed: false };
      sockets.push(s);
      return { send: d => s.sent.push(d), close: () => (s.closed = true) };
    },
    fetch: fetchMock,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: t => clearTimeout(t as ReturnType<typeof setTimeout>),
    onState: s => states.push(s),
    onSeed: sb => model.seed(sb),
    onMessage: m => {
      const r = model.handle(m, false);
      if (r.kind === 'changed' && r.notification) notes.push(r.notification.title);
      return r.kind === 'reseed';
    },
  };
  const client = new HubClient(deps);
  return {
    client,
    sockets,
    states,
    model,
    notes,
    fetchMock,
    setSidebar: (sb: Partial<SidebarResponse>) => (sidebar = { ...sidebar, ...sb }),
    setSidebarStatus: (s: number) => (sidebarStatus = s),
    setHealth: (s: number) => (healthStatus = s),
    sidebarCalls,
    last: () => sockets[sockets.length - 1]!,
  };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('HubClient', () => {
  it('connects to /ws/ui?client=desktop with Origin, Cookie, User-Agent; never sends presence/subscribe', async () => {
    const t = setup();
    t.client.start();
    await flush();
    const s = t.last();
    expect(s.url).toBe('wss://hub.example.com/ws/ui?client=desktop');
    expect(s.headers).toEqual({ Origin: 'https://hub.example.com', Cookie: 'ah_session=tok', 'User-Agent': 'AgentHubDesktop/0.1.0' });
    s.h.onOpen();
    await flush();
    expect(t.fetchMock.mock.calls[0]![0]).toBe('https://hub.example.com/api/sidebar');
    expect(t.states).toEqual(['online']);
    await vi.advanceTimersByTimeAsync(PING_MS * 3);
    expect(s.sent.every(m => JSON.parse(m).type === 'ping')).toBe(true);
    expect(s.sent.length).toBeGreaterThan(0);
    expect(wsUrl('http://localhost:8080')).toBe('ws://localhost:8080/ws/ui?client=desktop');
  });

  it('no cookie → signed_out without a socket', async () => {
    const t = setup({ cookie: null });
    t.client.start();
    await flush();
    expect(t.sockets).toHaveLength(0);
    expect(t.states).toEqual(['signed_out']);
  });

  it('sidebar seeds without notifications; messages during the seed are applied after it', async () => {
    const t = setup();
    const waiting = session({ status: 'permission' });
    const running = session({ status: 'working' });
    t.setSidebar({ now: [waiting, running] });
    t.client.start();
    await flush();
    const s = t.last();
    s.h.onOpen();
    // Before the sidebar resolves: the running session ends its turn.
    s.h.onMessage(JSON.stringify({ type: 'session.upsert', session: { ...running, status: 'waiting', unread: true }, activeVisible: false }));
    await flush();
    expect(t.model.waitingCount()).toBe(2);
    expect(t.notes).toEqual(['Ждёт ответа: Ревизия DNS']);
  });

  it('Переподключение без дублей: reconnect re-reads the sidebar, already waiting sessions do not notify', async () => {
    const t = setup();
    const a = session({ status: 'permission' });
    t.setSidebar({ now: [a] });
    t.client.start();
    await flush();
    t.last().h.onOpen();
    await flush();
    t.last().h.onClose(1006);
    expect(t.states.at(-1)).toBe('offline');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.sockets).toHaveLength(2);
    t.last().h.onOpen();
    await flush();
    t.last().h.onMessage(JSON.stringify({ type: 'session.upsert', session: a, activeVisible: false }));
    expect(t.notes).toEqual([]);
    expect(t.states.at(-1)).toBe('online');
    expect(t.sidebarCalls()).toBe(2);
  });

  it('backoff 1, 2, 5, 10, 30, 30 s while the hub is down; reset after a successful sidebar', async () => {
    const t = setup();
    t.client.start();
    await flush();
    const gaps = [1_000, 2_000, 5_000, 10_000, 30_000, 30_000];
    for (const gap of gaps) {
      const n = t.sockets.length;
      t.last().h.onError(new Error('ECONNREFUSED'));
      t.last().h.onClose(1006);
      await vi.advanceTimersByTimeAsync(gap - 1);
      expect(t.sockets).toHaveLength(n);
      await vi.advanceTimersByTimeAsync(1);
      expect(t.sockets).toHaveLength(n + 1);
    }
    t.last().h.onOpen();
    await flush();
    t.last().h.onClose(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.states.at(-1)).toBe('offline');
    expect(t.sockets).toHaveLength(gaps.length + 2);
  });

  it('offline: /healthz every 5 s, a 200 reconnects at once instead of waiting out the 30 s pause (VPN back ≤15 s)', async () => {
    const t = setup();
    t.client.start();
    await flush();
    // Drive the backoff up to the 30 s pause.
    for (const gap of [1_000, 2_000, 5_000, 10_000]) {
      t.last().h.onClose(1006);
      await vi.advanceTimersByTimeAsync(gap);
    }
    const n = t.sockets.length;
    t.last().h.onClose(1006); // next pause: 30 s
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.fetchMock.mock.calls.some(([u]) => u === 'https://hub.example.com/healthz')).toBe(true);
    expect(t.sockets).toHaveLength(n); // healthz 503: still waiting
    t.setHealth(200);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.sockets).toHaveLength(n + 1); // 10 s after the drop, not 30 s
    t.last().h.onOpen();
    await flush();
    expect(t.states.at(-1)).toBe('online');
    // Online: no more health polling.
    const polls = t.fetchMock.mock.calls.filter(([u]) => u.endsWith('/healthz')).length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.fetchMock.mock.calls.filter(([u]) => u.endsWith('/healthz')).length).toBe(polls);
  });

  it('close 4401 → signed_out, no retries until reconnectNow()', async () => {
    const t = setup();
    t.client.start();
    await flush();
    t.last().h.onOpen();
    await flush();
    t.last().h.onClose(4401);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.sockets).toHaveLength(1);
    expect(t.states.at(-1)).toBe('signed_out');
    t.client.reconnectNow();
    await flush();
    expect(t.sockets).toHaveLength(2);
  });

  it('401 on the handshake or on the sidebar → signed_out', async () => {
    const a = setup();
    a.client.start();
    await flush();
    a.last().h.onUnexpectedResponse(401);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(a.states.at(-1)).toBe('signed_out');
    expect(a.sockets).toHaveLength(1);

    const b = setup({ sidebarStatus: 401 });
    b.client.start();
    await flush();
    b.last().h.onOpen();
    await flush();
    expect(b.states.at(-1)).toBe('signed_out');
    expect(b.last().closed).toBe(true);
  });

  it('no pong for 2 intervals → reconnect; pongs keep it alive', async () => {
    const t = setup();
    t.client.start();
    await flush();
    const s = t.last();
    s.h.onOpen();
    await flush();
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(PING_MS);
      s.h.onMessage('{"type":"pong"}');
    }
    expect(t.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(PING_MS * 3);
    expect(s.closed).toBe(true);
    expect(t.states.at(-1)).toBe('offline');
  });

  it('B1: an upsert arriving while a reseed is in flight is applied after the (older) snapshot, not overwritten', async () => {
    const t = setup();
    const a = session({ status: 'waiting', unread: true, runnerId: 'hp' });
    const hpOff = RUNNERS.get('hp')!;
    t.setSidebar({ now: [], runners: [...RUNNERS.values()] });
    t.client.start();
    await flush();
    t.last().h.onOpen();
    await flush();
    // Runner back online → reseed. The snapshot (computed before the session fell asleep) still says waiting.
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const snapshot = { now: [a], projects: [], runners: [...RUNNERS.values()].map(r => (r.id === 'hp' ? { ...r, online: true } : r)) };
    t.fetchMock.mockImplementationOnce(async () => {
      await gate;
      return { status: 200, json: async () => structuredClone(snapshot) };
    });
    t.last().h.onMessage(JSON.stringify({ type: 'runner.status', runner: { ...hpOff, online: true } }));
    await flush();
    // During the read the hub puts the session to sleep.
    t.last().h.onMessage(JSON.stringify({ type: 'session.upsert', session: { ...a, status: 'sleeping', unread: false }, activeVisible: false }));
    release();
    await flush();
    expect(t.model.sessions.get(a.id)?.status).toBe('sleeping');
    expect(t.model.waitingCount()).toBe(0);
    expect(t.notes).toEqual([]);
  });

  it('a reseed asked for during a read runs again after it; a dropped socket discards the read in flight', async () => {
    const t = setup();
    t.client.start();
    await flush();
    t.last().h.onOpen();
    await flush();
    expect(t.sidebarCalls()).toBe(1);
    t.client.reseed();
    t.client.reseed();
    await flush();
    expect(t.sidebarCalls()).toBe(3);
    // Read in flight, then the socket drops: the late snapshot must not bring the state back to online.
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    t.fetchMock.mockImplementationOnce(async () => {
      await gate;
      return { status: 200, json: async () => ({ now: [], projects: [], runners: [] }) };
    });
    t.client.reseed();
    await flush();
    t.last().h.onClose(1006);
    release();
    await flush();
    expect(t.states.at(-1)).toBe('offline');
  });

  it('B2: a failing /healthz while offline is reported (the window shows «Нет связи» over the cached page)', async () => {
    const health: boolean[] = [];
    const t = setup();
    (t.client as unknown as { d: { onHealth?: (ok: boolean) => void } }).d.onHealth = ok => health.push(ok);
    t.client.start();
    await flush();
    t.last().h.onOpen();
    await flush();
    t.last().h.onClose(1006);
    await vi.advanceTimersByTimeAsync(1_000); // retry → new socket, still down
    t.last().h.onClose(1006);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(health).toContain(false);
    t.setHealth(200);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(health.at(-1)).toBe(true);
  });

  it('projects.changed re-reads the sidebar without notifications', async () => {
    const t = setup();
    t.client.start();
    await flush();
    t.last().h.onOpen();
    await flush();
    t.setSidebar({ now: [session({ status: 'permission' })] });
    t.last().h.onMessage('{"type":"projects.changed"}');
    await flush();
    expect(t.sidebarCalls()).toBe(2);
    expect(t.model.waitingCount()).toBe(1);
    expect(t.notes).toEqual([]);
  });
});
