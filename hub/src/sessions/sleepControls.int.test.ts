// change session-sleep-controls: the user's default idle timeout (Settings → Sessions), manual sleep and the awake
// sessions in «Сейчас». Real hub, Postgres, a scripted agent and a fake clock.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionPreferences, SessionView, SidebarResponse } from '@agent-hub/shared';
import { PUBLIC_URL, autoReply, connectFakeAgent, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';

const VAULT = 'C:\\Users\\alice\\vault';
const MIN = 60_000;
let offsetMs = 0;
const clock = () => new Date(Date.now() + offsetMs);

describe('session sleep controls (integration)', () => {
  let t: TestHub;
  let cookie: string;
  let agent: FakeAgent;
  const got: Array<{ type: string; payload: Record<string, unknown> }> = [];

  const api = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown, who = cookie) =>
    t.hub.app.inject({ method, url, cookies: { ah_session: who }, headers: { origin: PUBLIC_URL }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const view = async (id: string) => (await api('GET', `/api/sessions/${id}`)).json() as SessionView;
  const stops = (id: string) => got.filter(m => m.type === 'session.stop' && m.payload.sessionId === id).length;
  const ago = (min: number) => new Date(clock().getTime() - min * MIN);
  const setDefault = (idleTimeoutMin: number | null) => api('PUT', '/api/preferences/sessions', { idleTimeoutMin });

  /** A live session that finished its turn `quietMin` minutes ago (status waiting, process alive, read). */
  async function waitingSession(quietMin: number): Promise<string> {
    offsetMs = 0;
    const r = await api('POST', '/api/sessions', { runnerId: 'hp', cwd: VAULT, model: 'haiku', prompt: 'привет' });
    expect(r.statusCode).toBe(201);
    const id = (r.json() as SessionView).id;
    await waitFor(() => got.some(m => m.type === 'session.start' && m.payload.sessionId === id), 20_000);
    const at = ago(quietMin);
    await t.tdb.pool.query(`UPDATE sessions SET status = 'waiting', process_alive = true, unread = false, last_turn_end_at = $2, last_input_at = $2, last_event_at = $2 WHERE id = $1`, [id, at]);
    return id;
  }

  async function after(min: number): Promise<void> {
    offsetMs = min * MIN;
    await t.hub.sessions.checkIdle();
  }

  beforeAll(async () => {
    t = await startTestHub({ sessions: { now: clock, idleCheckMs: 0, initTimeoutMs: 2000 } });
    const token = await t.addRunner('hp', 'HP');
    cookie = await t.login();
    agent = connectFakeAgent(t.wsBase, token);
    agent.ws.on('message', d => got.push(JSON.parse(d.toString()) as (typeof got)[number]));
    autoReply(agent, type => {
      if (type === 'fs.stat') return { exists: true, isDir: true };
      if (type === 'session.start' || type === 'session.resume') return { models: [] };
      return {};
    });
    await agent.next('welcome');
  });
  afterAll(async () => {
    offsetMs = 0;
    await t.close();
  });

  describe('default idle timeout of the user', () => {
    afterAll(async () => {
      expect((await setDefault(null)).statusCode).toBe(200);
    });

    it('GET without a choice: null and the hub value', async () => {
      const r = await api('GET', '/api/preferences/sessions');
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ idleTimeoutMin: null, hubIdleTimeoutMin: 30 } satisfies SessionPreferences);
    });

    it('PUT with a value outside the list: 400, nothing saved', async () => {
      expect((await setDefault(45)).statusCode).toBe(400);
      expect((await api('PUT', '/api/preferences/sessions', {})).statusCode).toBe(400);
      expect(((await api('GET', '/api/preferences/sessions')).json() as SessionPreferences).idleTimeoutMin).toBeNull();
    });

    it('PUT 15: the countdown of an awake session moves at once, the scheduler sleeps it after 15 min', async () => {
      const id = await waitingSession(0);
      const before = await view(id);
      expect(Date.parse(before.sleepsAt!) - Date.parse(before.lastTurnEndAt!)).toBe(30 * MIN);
      const r = await setDefault(15);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ idleTimeoutMin: 15, hubIdleTimeoutMin: 30 });
      const v = await view(id);
      expect(Date.parse(v.sleepsAt!) - Date.parse(v.lastTurnEndAt!)).toBe(15 * MIN);
      await after(14);
      expect(stops(id)).toBe(0);
      await after(16);
      expect(stops(id)).toBe(1);
      expect((await view(id)).status).toBe('sleeping');
    });

    it('the session own timeout wins over the user default', async () => {
      const id = await waitingSession(0);
      expect((await api('PATCH', `/api/sessions/${id}`, { idleTimeoutMin: 60 })).statusCode).toBeLessThan(300);
      const v = await view(id);
      expect(Date.parse(v.sleepsAt!) - Date.parse(v.lastTurnEndAt!)).toBe(60 * MIN);
      await after(31);
      expect(stops(id)).toBe(0);
      await after(61);
      expect(stops(id)).toBe(1);
    });

    it('0 — never: no countdown, the scheduler does not sleep the session', async () => {
      expect((await setDefault(0)).statusCode).toBe(200);
      const id = await waitingSession(0);
      expect((await view(id)).sleepsAt).toBeNull();
      await after(600);
      expect(stops(id)).toBe(0);
      // tidy up: the next tests count their own sleep
      expect((await api('POST', `/api/sessions/${id}/sleep`)).statusCode).toBe(202);
    });
  });

  describe('manual sleep', () => {
    it('waiting: 202, session.stop with reason sleep, the session is asleep', async () => {
      const id = await waitingSession(1);
      const r = await api('POST', `/api/sessions/${id}/sleep`);
      expect(r.statusCode).toBe(202);
      expect((r.json() as { session: SessionView }).session.status).toBe('sleeping');
      const stop = got.find(m => m.type === 'session.stop' && m.payload.sessionId === id);
      expect(stop?.payload.reason).toBe('sleep');
      const v = await view(id);
      expect(v.status).toBe('sleeping');
      expect(v.processAlive).toBe(false);
      expect(v.sleptAt).not.toBeNull();
    });

    it('permission: the open request is denied, the session is asleep', async () => {
      const id = await waitingSession(1);
      const requestId = randomUUID();
      await t.tdb.pool.query(`INSERT INTO permission_requests (request_id, session_id, tool_name, tool_use_id, input, suggestions) VALUES ($1, $2, 'Bash', 'toolu_sleep', '{"command":"ls"}', '[]')`, [
        requestId,
        id,
      ]);
      await t.tdb.pool.query(`UPDATE sessions SET status = 'permission' WHERE id = $1`, [id]);
      expect((await api('POST', `/api/sessions/${id}/sleep`)).statusCode).toBe(202);
      const deny = got.find(m => m.type === 'permission.response' && m.payload.requestId === requestId);
      expect(deny?.payload.behavior).toBe('deny');
      expect((await view(id)).status).toBe('sleeping');
    });

    it('working: 409 turn_running, the process is not stopped', async () => {
      const id = await waitingSession(1);
      await t.tdb.pool.query(`UPDATE sessions SET status = 'working' WHERE id = $1`, [id]);
      const r = await api('POST', `/api/sessions/${id}/sleep`);
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toBe('turn_running');
      expect(stops(id)).toBe(0);
    });

    it('waiting with a background command: 409 turn_running', async () => {
      const id = await waitingSession(1);
      await t.tdb.pool.query(`UPDATE sessions SET process_started_at = $2 WHERE id = $1`, [id, ago(5)]);
      await t.tdb.pool.query(`INSERT INTO background_tasks (session_id, tool_use_id, task_id, started_at) VALUES ($1, 'toolu_sleep_bg', 'sb1', $2)`, [id, ago(1)]);
      expect((await view(id)).subagents?.working).toBe(1);
      const r = await api('POST', `/api/sessions/${id}/sleep`);
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toBe('turn_running');
      expect(stops(id)).toBe(0);
    });

    it('already asleep: 409 not_running', async () => {
      const id = await waitingSession(1);
      expect((await api('POST', `/api/sessions/${id}/sleep`)).statusCode).toBe(202);
      const r = await api('POST', `/api/sessions/${id}/sleep`);
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toBe('not_running');
    });

    it('a session of another user: 404', async () => {
      const id = await waitingSession(1);
      const inv = await api('POST', '/api/admin/invites', { email: 'kate@example.com', provider: 'google' });
      expect(inv.statusCode).toBe(201);
      const kate = await t.login({ email: 'kate@example.com' }, { invite: (inv.json().url as string).split('/invite/')[1]! });
      expect((await api('POST', `/api/sessions/${id}/sleep`, undefined, kate)).statusCode).toBe(404);
      expect(stops(id)).toBe(0);
    });
  });

  describe('«Сейчас» lists the awake sessions', () => {
    it('awake read waiting sessions are in, sleeping are not; order: permission/unread → working → waiting', async () => {
      // the earlier tests left their sessions in various states: put them all to rest
      await t.tdb.pool.query(`UPDATE sessions SET status = 'sleeping', process_alive = false, unread = false`);
      const waiting = await waitingSession(1);
      const working = await waitingSession(2);
      const unread = await waitingSession(3);
      const asleep = await waitingSession(4);
      await t.tdb.pool.query(`UPDATE sessions SET status = 'working' WHERE id = $1`, [working]);
      await t.tdb.pool.query(`UPDATE sessions SET unread = true WHERE id = $1`, [unread]);
      expect((await api('POST', `/api/sessions/${asleep}/sleep`)).statusCode).toBe(202);
      const r = await api('GET', '/api/sidebar');
      expect(r.statusCode).toBe(200);
      const ids = (r.json() as SidebarResponse).now.map(s => s.id);
      expect(ids).toEqual([unread, working, waiting]);
    });
  });
});
