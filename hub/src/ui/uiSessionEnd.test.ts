// Code review M1: a browser socket lives no longer than its session (logout, expiry).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { PUBLIC_URL, startTestHub, type TestHub } from '../test/harness.js';
import { hashSecret } from '../auth/secrets.js';

function openUi(t: TestHub, session: string) {
  const ws = new WebSocket(`${t.wsBase}/ws/ui`, { headers: { Origin: PUBLIC_URL, Cookie: `ah_session=${session}` } });
  ws.on('error', () => undefined);
  const opened = new Promise<void>(r => ws.on('open', () => r()));
  const closed = new Promise<number>(r => ws.on('close', c => r(c)));
  return { ws, opened, closed };
}

describe('/ws/ui session end (integration)', () => {
  let t: TestHub;
  beforeAll(async () => {
    // The ping also drops sockets without a pong in one interval: 100 ms was too short for a loaded full run.
    t = await startTestHub({ uiPingIntervalMs: 400 });
  });
  afterAll(async () => t.close());

  it('logout closes the sockets of that session only', async () => {
    const s1 = await t.login();
    const s2 = await t.login();
    const a = openUi(t, s1);
    const b = openUi(t, s2);
    await Promise.all([a.opened, b.opened]);
    const out = await t.hub.app.inject({ method: 'POST', url: '/auth/logout', headers: { origin: PUBLIC_URL }, cookies: { ah_session: s1 } });
    expect(out.statusCode).toBe(200);
    expect(await a.closed).toBe(4401);
    expect(b.ws.readyState).toBe(WebSocket.OPEN);
    b.ws.close();
  });

  it('a socket whose session expired is closed by the periodic check', async () => {
    const s = await t.login();
    const a = openUi(t, s);
    await a.opened;
    // Expiry is read when the socket opens; reopen after moving it close to now.
    a.ws.close();
    await t.tdb.pool.query(`UPDATE auth_sessions SET expires_at = now() + interval '300 milliseconds' WHERE id_hash = $1`, [hashSecret(s)]);
    const b = openUi(t, s);
    await b.opened;
    const started = Date.now();
    expect(await b.closed).toBe(4401);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
