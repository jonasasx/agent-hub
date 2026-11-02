// Tasks 2.2, 2.3: `?client=desktop` on /ws/ui, hasClient, activeVisible in session.upsert
// (Requirement: Вид клиента и признак видимости в хабе).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { SessionView } from '@agent-hub/shared';
import { PUBLIC_URL, agentSend, autoReply, connectFakeAgent, connectUi, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';

const VAULT = 'C:\\Users\\alice\\vault';

function connectDesktop(wsBase: string, session: string, query = '?client=desktop') {
  const ws = new WebSocket(`${wsBase}/ws/ui${query}`, { headers: { Origin: PUBLIC_URL, Cookie: `ah_session=${session}` } });
  const received: Array<{ type: string } & Record<string, unknown>> = [];
  ws.on('message', d => received.push(JSON.parse(d.toString()) as { type: string }));
  const open = new Promise<void>(r => ws.on('open', () => r()));
  const closed = new Promise<void>(r => ws.on('close', () => r()));
  return { ws, received, open, closed, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

describe('/ws/ui client kind (integration)', () => {
  let t: TestHub;
  let cookie: string;
  let userId: string;
  let agent: FakeAgent;

  const api = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    t.hub.app.inject({ method, url, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const getS = async (id: string) => (await api('GET', `/api/sessions/${id}`)).json() as SessionView;
  async function newSession(): Promise<SessionView> {
    const r = await api('POST', '/api/sessions', { runnerId: 'hp', cwd: VAULT, model: 'haiku', prompt: 'hostname' });
    expect(r.statusCode).toBe(201);
    return r.json() as SessionView;
  }
  const result = (id: string) => agentSend(agent, 'session.result', { sessionId: id, subtype: 'success', isError: false, durationMs: 1, costUsd: 0 });
  const upserts = (received: Array<{ type: string } & Record<string, unknown>>, id: string) =>
    received.filter(m => m.type === 'session.upsert' && (m.session as SessionView).id === id) as Array<{ type: string; session: SessionView; activeVisible?: boolean }>;

  beforeAll(async () => {
    t = await startTestHub({ sessions: { idleCheckMs: 0 } });
    const token = await t.addRunner('hp', 'HP');
    cookie = await t.login();
    userId = ((await api('GET', '/api/me')).json() as { user: { id: string } }).user.id;
    agent = connectFakeAgent(t.wsBase, token);
    autoReply(agent, type => (type === 'fs.stat' ? { exists: true, isDir: true } : type === 'session.start' ? { models: [] } : {}));
    await agent.next('welcome');
  });
  afterAll(async () => t.close());

  it('Соединение desktop не делает сессию видимой: only a desktop socket → unread, activeVisible false', async () => {
    const d = connectDesktop(t.wsBase, cookie);
    await d.open;
    try {
      const s = await newSession();
      result(s.id);
      await waitFor(async () => (await getS(s.id)).status === 'waiting');
      expect((await getS(s.id)).unread).toBe(true);
      const last = await waitFor(() => upserts(d.received, s.id).find(m => m.session.status === 'waiting'));
      expect(last.activeVisible).toBe(false);
      expect(last.session.unread).toBe(true);
    } finally {
      d.ws.close();
    }
  });

  it('presence {visible:true} from desktop is ignored: unread stays, the next result is unread too', async () => {
    const d = connectDesktop(t.wsBase, cookie);
    await d.open;
    try {
      const s = await newSession();
      result(s.id);
      await waitFor(async () => (await getS(s.id)).unread);
      d.send({ type: 'presence', visible: true, activeSessionIds: [s.id] });
      await new Promise(r => setTimeout(r, 300));
      expect((await getS(s.id)).unread).toBe(true);
      expect(t.hub.ui.isActiveVisible(userId, s.id)).toBe(false);
      // subscribe is still allowed.
      d.send({ type: 'subscribe', sessionIds: [s.id] });
    } finally {
      d.ws.close();
    }
  });

  it('an unknown ?client= is a web client (visible until presence)', async () => {
    const w = connectDesktop(t.wsBase, cookie, '?client=x');
    await w.open;
    try {
      const s = await newSession();
      w.send({ type: 'presence', visible: true, activeSessionIds: [s.id] });
      await waitFor(() => t.hub.ui.isActiveVisible(userId, s.id));
      expect(t.hub.ui.hasClient(userId, 'desktop')).toBe(false);
      expect(t.hub.ui.hasClient(userId, 'web')).toBe(true);
    } finally {
      w.ws.close();
    }
  });

  it('hasClient(desktop): false → true while the socket is open → false after close', async () => {
    await waitFor(() => !t.hub.ui.hasClient(userId, 'desktop'));
    const d = connectDesktop(t.wsBase, cookie);
    await d.open;
    expect(t.hub.ui.hasClient(userId, 'desktop')).toBe(true);
    expect(t.hub.ui.hasClient(randomUUID(), 'desktop')).toBe(false);
    d.ws.close();
    await d.closed;
    await waitFor(() => !t.hub.ui.hasClient(userId, 'desktop'));
  });

  it('Сессия на экране в окне: permission with a visible web window → activeVisible true; hidden → false', async () => {
    const w = connectUi(t.wsBase, cookie);
    const d = connectDesktop(t.wsBase, cookie);
    await Promise.all([w.open, d.open]);
    try {
      const s = await newSession();
      w.send({ type: 'presence', visible: true, activeSessionIds: [s.id] });
      await waitFor(() => t.hub.ui.isActiveVisible(userId, s.id));
      agentSend(agent, 'permission.request', { requestId: randomUUID(), sessionId: s.id, toolName: 'Bash', toolUseId: 't1', input: {}, suggestions: [] });
      const shown = await waitFor(() => upserts(d.received, s.id).find(m => m.session.status === 'permission'));
      expect(shown.activeVisible).toBe(true);

      w.send({ type: 'presence', visible: false, activeSessionIds: [] });
      await waitFor(() => !t.hub.ui.isActiveVisible(userId, s.id));
      const n = upserts(d.received, s.id).length;
      agentSend(agent, 'permission.request', { requestId: randomUUID(), sessionId: s.id, toolName: 'Bash', toolUseId: 't2', input: {}, suggestions: [] });
      const hidden = await waitFor(() =>
        upserts(d.received, s.id)
          .slice(n)
          .find(m => m.session.status === 'permission'),
      );
      expect(hidden.activeVisible).toBe(false);
    } finally {
      w.ws.close();
      d.ws.close();
    }
  });

  it('a web window without presence counts as visible for its sessions only after presence (unchanged)', async () => {
    const w = connectUi(t.wsBase, cookie);
    await w.open;
    try {
      const s = await newSession();
      expect(t.hub.ui.isActiveVisible(userId, s.id)).toBe(false);
      const up = await waitFor(() => upserts(w.received, s.id)[0]);
      expect(up.activeVisible).toBe(false);
    } finally {
      w.ws.close();
    }
  });
});
