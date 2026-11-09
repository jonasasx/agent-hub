// Task 1.10: /ws/ui broadcasts runner.status; /api/me; /api/sidebar (runners only in M1).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { RunnerView, UiServerMessage } from '@agent-hub/shared';
import { PUBLIC_URL, connectFakeAgent, startTestHub, waitFor, type TestHub } from '../test/harness.js';

function connectUi(t: TestHub, session: string) {
  const ws = new WebSocket(`${t.wsBase}/ws/ui`, { headers: { Origin: PUBLIC_URL, Cookie: `ah_session=${session}` } });
  const received: Array<{ at: number; msg: UiServerMessage }> = [];
  ws.on('message', d => received.push({ at: Date.now(), msg: JSON.parse(d.toString()) as UiServerMessage }));
  const open = new Promise<void>(r => ws.on('open', () => r()));
  return { ws, received, open };
}

describe('/ws/ui and sidebar (integration)', () => {
  let t: TestHub;
  let session: string;
  let token: string;

  beforeAll(async () => {
    t = await startTestHub();
    token = await t.addRunner('hp', 'HP');
    await t.addRunner('vm', 'ВМ .3');
    session = await t.login();
  });
  afterAll(async () => t.close());

  it('GET /api/me returns the user', async () => {
    const r = await t.hub.app.inject({ method: 'GET', url: '/api/me', cookies: { ah_session: session } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      user: { id: expect.any(String), email: 'alice@example.com', role: 'admin', name: null, provider: 'google' },
      vapidPublicKey: null,
      voiceInput: false,
      voiceTalk: false,
      locale: null,
      accountUrl: null,
      singleProvider: null,
    });
  });

  it('GET /api/sidebar lists runners with status, empty sessions until M2', async () => {
    const r = await t.hub.app.inject({ method: 'GET', url: '/api/sidebar?cron=0', cookies: { ah_session: session } });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { now: unknown[]; projects: unknown[]; runners: RunnerView[] };
    expect(body.now).toEqual([]);
    expect(body.projects).toEqual([]);
    expect(body.runners.map(x => [x.id, x.name, x.online])).toEqual([
      ['hp', 'HP', false],
      ['vm', 'ВМ .3', false],
    ]);
  });

  it('agent stop changes the status for a subscribed client within 5 s of the hub fixing it', async () => {
    const ui = connectUi(t, session);
    await ui.open;

    const agent = connectFakeAgent(t.wsBase, token);
    await agent.next('welcome');
    const online = await waitFor(() => ui.received.find(r => r.msg.type === 'runner.status' && r.msg.runner.online));
    expect(online.msg).toMatchObject({ type: 'runner.status', runner: { id: 'hp', os: 'Windows 11 Pro', online: true } });

    agent.ws.close();
    const offline = await waitFor(() => ui.received.find(r => r.msg.type === 'runner.status' && !r.msg.runner.online), 5000);
    const row = await t.tdb.pool.query<{ last_seen_at: Date; online: boolean }>(`SELECT online, last_seen_at FROM runners WHERE id = 'hp'`);
    expect(row.rows[0]!.online).toBe(false);
    // last_seen_at is written when the hub fixes the disconnect; the UI message follows it.
    const lag = offline.at - row.rows[0]!.last_seen_at.getTime();
    expect(lag).toBeGreaterThanOrEqual(-50);
    expect(lag).toBeLessThan(5000);
    expect(offline.msg).toMatchObject({ runner: { id: 'hp', online: false, lastSeenAt: expect.any(String) } });

    ui.ws.send(JSON.stringify({ type: 'ping' }));
    await waitFor(() => ui.received.find(r => r.msg.type === 'pong'));
    ui.ws.close();
  });

  it('status of one user is not sent to another user', async () => {
    const otherHub = t.hub;
    const received: UiServerMessage[] = [];
    otherHub.ui.broadcast('00000000-0000-4000-8000-000000000000', { type: 'pong' });
    const ui = connectUi(t, session);
    await ui.open;
    ui.ws.on('message', d => received.push(JSON.parse(d.toString()) as UiServerMessage));
    otherHub.ui.broadcast('00000000-0000-4000-8000-000000000000', { type: 'pong' });
    await new Promise(r => setTimeout(r, 100));
    expect(received).toEqual([]);
    ui.ws.close();
  });
});
