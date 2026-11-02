// Spec «auth»: every scenario against a real hub, Postgres and a fake OIDC provider.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { ALLOWED_EMAIL, PUBLIC_URL, cookieValue, startTestHub, type TestHub } from '../test/harness.js';
import { hashSecret } from '../auth/secrets.js';
import { isAllowedOrigin, safeReturnPath } from './auth.js';
import { addRunner } from '../runners/repo.js';
import { upsertUser } from '../auth/sessions.js';

function wsHandshake(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise(resolve => {
    const ws = new WebSocket(url, { headers });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('open', () => {
      ws.close();
      resolve(101);
    });
    ws.on('error', () => undefined);
  });
}

describe('auth helpers', () => {
  it.each([
    ['/s/1', '/s/1'],
    ['/s/1?tab=2', '/s/1?tab=2'],
    ['/', '/'],
    ['//evil.example/x', '/'],
    ['/\\evil.example', '/'],
    ['/\t/evil.example/x', '/'],
    ['/\n/evil.example/x', '/'],
    ['/\x00x', '/'],
    ['/%2F/evil.example', '/%2F/evil.example'],
    ['https://evil.example', '/'],
    ['/auth/login', '/'],
    ['/./auth/login', '/'],
    ['/..//evil.example', '/'],
    ['/%2e%2e//evil.example', '/'],
    ['/a/../..//evil.example/x', '/'],
    [undefined, '/'],
  ])('safeReturnPath(%j) = %s', (input, out) => expect(safeReturnPath(input, PUBLIC_URL)).toBe(out));

  it('accepts only the exact public origin', () => {
    expect(isAllowedOrigin(PUBLIC_URL, PUBLIC_URL)).toBe(true);
    expect(isAllowedOrigin('https://evil.example', PUBLIC_URL)).toBe(false);
    expect(isAllowedOrigin(undefined, PUBLIC_URL)).toBe(false);
  });
});

describe('spec auth (integration)', () => {
  let t: TestHub;
  beforeAll(async () => {
    t = await startTestHub();
  });
  afterAll(async () => t.close());

  const app = () => t.hub.app;

  it('Вход разрешённым аккаунтом: returns to the original address with a 30-day session cookie', async () => {
    const start = await app().inject({ method: 'GET', url: '/auth/login?return=/s/abc' });
    expect(start.statusCode).toBe(302);
    const loc = new URL(start.headers.location as string);
    expect(loc.origin).toBe(t.oidc.issuer);
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
    expect(loc.searchParams.get('state')).toBeTruthy();
    expect(loc.searchParams.get('nonce')).toBeTruthy();
    expect(loc.searchParams.get('redirect_uri')).toBe(`${PUBLIC_URL}/auth/callback`);

    const oidcCookie = cookieValue(start.headers['set-cookie'], 'ah_oidc')!;
    const { code, state } = t.oidc.authorize(loc.href, { email: ALLOWED_EMAIL });
    const cb = await app().inject({ method: 'GET', url: `/auth/callback?code=${code}&state=${state}`, cookies: { ah_oidc: decodeURIComponent(oidcCookie) } });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe('/s/abc');
    const set = ([] as string[]).concat(cb.headers['set-cookie'] as string[]).find(c => c.startsWith('ah_session='))!;
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/Secure/i);
    expect(set).toMatch(/SameSite=Lax/i);
    expect(set).toMatch(/Path=\//);
    expect(set).toMatch(/Max-Age=2592000/);

    const me = await app().inject({ method: 'GET', url: '/api/me', cookies: { ah_session: cookieValue(set, 'ah_session')! } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ user: { email: ALLOWED_EMAIL } });
  });

  it('open redirect with a TAB is neutralised end to end: return=%2F%09%2Fevil.example → /', async () => {
    const start = await app().inject({ method: 'GET', url: '/auth/login?return=%2F%09%2Fevil.example' });
    const { code, state } = t.oidc.authorize(start.headers.location as string, { email: ALLOWED_EMAIL });
    const cb = await app().inject({
      method: 'GET',
      url: `/auth/callback?code=${code}&state=${state}`,
      cookies: { ah_oidc: decodeURIComponent(cookieValue(start.headers['set-cookie'], 'ah_oidc')!) },
    });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe('/');
  });

  it('ID token signed by a key outside the provider JWKS is rejected', async () => {
    await expect(t.login({ rogueSignature: true })).rejects.toThrow(/400/);
  });

  it('percent-encoded /api path cannot bypass the guard', async () => {
    const r = await app().inject({ method: 'GET', url: '/%61pi/me' });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: 'unauthenticated' });
    expect((await app().inject({ method: 'GET', url: '/%61pi/sidebar' })).statusCode).toBe(401);
    const session = await t.login();
    const post = await app().inject({ method: 'POST', url: '/%61pi/x', cookies: { ah_session: session }, payload: {} });
    expect(post.statusCode).toBe(403);
    expect((await app().inject({ method: 'POST', url: '/%61pi/x', payload: {} })).statusCode).toBe(403);
    const logout = await app().inject({ method: 'POST', url: '/%61uth/logout', cookies: { ah_session: session } });
    expect(logout.statusCode).toBe(403);
    expect((await app().inject({ method: 'GET', url: '/api/me', cookies: { ah_session: session } })).statusCode).toBe(200);
  });

  it('forwards prompt=select_account for «Войти другим аккаунтом»', async () => {
    const r = await app().inject({ method: 'GET', url: '/auth/login?prompt=select_account' });
    expect(new URL(r.headers.location as string).searchParams.get('prompt')).toBe('select_account');
  });

  it('Вход чужим аккаунтом отклоняется (multi-user: «Доступ только по приглашению»): 403 page with the address, no session', async () => {
    const before = await t.tdb.pool.query('SELECT count(*)::int AS n FROM auth_sessions');
    const start = await app().inject({ method: 'GET', url: '/auth/login' });
    const { code, state } = t.oidc.authorize(start.headers.location as string, { email: 'stranger@example.com' });
    const cb = await app().inject({
      method: 'GET',
      url: `/auth/callback?code=${code}&state=${state}`,
      cookies: { ah_oidc: decodeURIComponent(cookieValue(start.headers['set-cookie'], 'ah_oidc')!) },
    });
    expect(cb.statusCode).toBe(403);
    expect(cb.body).toContain('Доступ только по приглашению');
    expect(cb.body).toContain('stranger@example.com');
    expect(cb.body).toContain('Войти другим аккаунтом');
    expect(cb.body).toContain('/auth/login?prompt=select_account');
    expect(cookieValue(cb.headers['set-cookie'], 'ah_session') ?? '').toBe('');
    const after = await t.tdb.pool.query('SELECT count(*)::int AS n FROM auth_sessions');
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const users = await t.tdb.pool.query(`SELECT 1 FROM users WHERE email = 'stranger@example.com'`);
    expect(users.rowCount).toBe(0);
  });

  it('a denied login also drops an existing session in this browser', async () => {
    const session = await t.login();
    const start = await app().inject({ method: 'GET', url: '/auth/login' });
    const { code, state } = t.oidc.authorize(start.headers.location as string, { email: 'stranger@example.com' });
    await app().inject({
      method: 'GET',
      url: `/auth/callback?code=${code}&state=${state}`,
      cookies: { ah_oidc: decodeURIComponent(cookieValue(start.headers['set-cookie'], 'ah_oidc')!), ah_session: session },
    });
    const me = await app().inject({ method: 'GET', url: '/api/me', cookies: { ah_session: session } });
    expect(me.statusCode).toBe(401);
  });

  it('rejects an allowed address without email_verified', async () => {
    await expect(t.login({ emailVerified: false })).rejects.toThrow(/403/);
  });

  it('Подмена state: 400, no session', async () => {
    const before = await t.tdb.pool.query('SELECT count(*)::int AS n FROM auth_sessions');
    const start = await app().inject({ method: 'GET', url: '/auth/login' });
    const { code } = t.oidc.authorize(start.headers.location as string, { email: ALLOWED_EMAIL });
    const cb = await app().inject({
      method: 'GET',
      url: `/auth/callback?code=${code}&state=forged`,
      cookies: { ah_oidc: decodeURIComponent(cookieValue(start.headers['set-cookie'], 'ah_oidc')!) },
    });
    expect(cb.statusCode).toBe(400);
    expect(cookieValue(cb.headers['set-cookie'], 'ah_session')).toBeUndefined();
    // QA: the spec also requires that no server-side session record is created
    const after = await t.tdb.pool.query('SELECT count(*)::int AS n FROM auth_sessions');
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('rejects a callback without the login cookie and a tampered cookie', async () => {
    const start = await app().inject({ method: 'GET', url: '/auth/login' });
    const { code, state } = t.oidc.authorize(start.headers.location as string, { email: ALLOWED_EMAIL });
    const noCookie = await app().inject({ method: 'GET', url: `/auth/callback?code=${code}&state=${state}` });
    expect(noCookie.statusCode).toBe(400);
    const forged = JSON.stringify({ state, nonce: 'n', verifier: 'v', r: '/' });
    const tampered = await app().inject({ method: 'GET', url: `/auth/callback?code=${code}&state=${state}`, cookies: { ah_oidc: `${forged}.badsig` } });
    expect(tampered.statusCode).toBe(400);
  });

  it('rejects a nonce mismatch in the ID token', async () => {
    await expect(t.login({ nonce: 'other-nonce' })).rejects.toThrow(/400/);
  });

  it('API без cookie: 401 {"error":"unauthenticated"}', async () => {
    const r = await app().inject({ method: 'GET', url: '/api/sessions' });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: 'unauthenticated' });
  });

  it('Чужой Origin: 403 on a mutating request with a valid cookie', async () => {
    const session = await t.login();
    const evil = await app().inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { origin: 'https://evil.example' },
      cookies: { ah_session: session },
      payload: {},
    });
    expect(evil.statusCode).toBe(403);
    expect(evil.json()).toEqual({ error: 'forbidden_origin' });
    const noOrigin = await app().inject({ method: 'POST', url: '/api/sessions', cookies: { ah_session: session }, payload: {} });
    expect(noOrigin.statusCode).toBe(403);
    const ok = await app().inject({ method: 'POST', url: '/api/sessions', headers: { origin: PUBLIC_URL }, cookies: { ah_session: session }, payload: {} });
    expect(ok.statusCode).toBe(400); // passes the guard; the empty body fails validation
    expect(ok.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('Истёкшая сессия: 401 after 30 days', async () => {
    const session = await t.login();
    await t.tdb.pool.query(`UPDATE auth_sessions SET expires_at = now() - interval '1 second' WHERE id_hash = $1`, [hashSecret(session)]);
    const r = await app().inject({ method: 'GET', url: '/api/me', cookies: { ah_session: session } });
    expect(r.statusCode).toBe(401);
  });

  it('Повторное открытие в течение 30 дней: the session stays valid', async () => {
    const session = await t.login();
    const row = await t.tdb.pool.query(`SELECT expires_at - created_at AS ttl FROM auth_sessions WHERE id_hash = $1`, [hashSecret(session)]);
    expect(row.rows[0].ttl).toMatchObject({ days: 30 });
    await t.tdb.pool.query(`UPDATE auth_sessions SET created_at = now() - interval '10 days', expires_at = now() + interval '20 days' WHERE id_hash = $1`, [hashSecret(session)]);
    const r = await app().inject({ method: 'GET', url: '/api/me', cookies: { ah_session: session } });
    expect(r.statusCode).toBe(200);
  });

  it('Выход: cookie cleared, server record deleted, the old cookie gets 401', async () => {
    const session = await t.login();
    const out = await app().inject({ method: 'POST', url: '/auth/logout', headers: { origin: PUBLIC_URL }, cookies: { ah_session: session } });
    expect(out.statusCode).toBe(204);
    const cleared = ([] as string[]).concat(out.headers['set-cookie'] as string[]).find(c => c.startsWith('ah_session='))!;
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);
    const rows = await t.tdb.pool.query('SELECT 1 FROM auth_sessions WHERE id_hash = $1', [hashSecret(session)]);
    expect(rows.rowCount).toBe(0);
    const r = await app().inject({ method: 'GET', url: '/api/me', cookies: { ah_session: session } });
    expect(r.statusCode).toBe(401);
  });

  it('logout from a foreign Origin is refused', async () => {
    const session = await t.login();
    const out = await app().inject({ method: 'POST', url: '/auth/logout', headers: { origin: 'https://evil.example' }, cookies: { ah_session: session } });
    expect(out.statusCode).toBe(403);
    const r = await app().inject({ method: 'GET', url: '/api/me', cookies: { ah_session: session } });
    expect(r.statusCode).toBe(200);
  });

  it('/healthz is public', async () => {
    const r = await app().inject({ method: 'GET', url: '/healthz' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });

  it('dev login does not exist without AUTH_DEV_EMAIL', async () => {
    const r = await app().inject({ method: 'GET', url: '/auth/dev-login' });
    expect(r.statusCode).toBe(404);
  });

  it('Запрос чужих данных: the sidebar lists only the current user runners', async () => {
    const session = await t.login();
    const other = await upsertUser(t.tdb.db, 'someone@example.com');
    await addRunner(t.tdb.db, { id: 'foreign', userId: other.id, name: 'Foreign' });
    await t.addRunner('own', 'Own');
    const r = await app().inject({ method: 'GET', url: '/api/sidebar', cookies: { ah_session: session } });
    const ids = (r.json() as { runners: Array<{ id: string }> }).runners.map(x => x.id);
    expect(ids).toContain('own');
    expect(ids).not.toContain('foreign');
  });

  it('WebSocket UI без входа: handshake rejected with 401; foreign Origin with 403', async () => {
    expect(await wsHandshake(`${t.wsBase}/ws/ui`, { Origin: PUBLIC_URL })).toBe(401);
    expect(await wsHandshake(`${t.wsBase}/ws/ui`, {})).toBe(401);
    expect(await wsHandshake(`${t.wsBase}/ws/ui`, { Origin: 'https://evil.example' })).toBe(401);
    const session = await t.login();
    expect(await wsHandshake(`${t.wsBase}/ws/ui`, { Origin: 'https://evil.example', Cookie: `ah_session=${session}` })).toBe(403);
    expect(await wsHandshake(`${t.wsBase}/ws/ui`, { Origin: PUBLIC_URL, Cookie: `ah_session=${session}` })).toBe(101);
  });
});
