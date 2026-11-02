// Tasks 1.3–1.6: /auth/desktop/* against a real hub, Postgres and the fake OIDC provider (capability desktop-auth).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALLOWED_EMAIL, PUBLIC_URL, cookieValue, startTestHub, type TestHub } from '../test/harness.js';
import { pkceChallenge } from '../auth/desktopCodes.js';
import { desktopReturnPage } from './pages.js';

const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = pkceChallenge(VERIFIER);
const STATE = 'app-state-0123456789abcdef';
const UA = 'AgentHubDesktop/0.1.0';
const startUrl = (over: Record<string, string> = {}) => `/auth/desktop/start?${new URLSearchParams({ code_challenge: CHALLENGE, code_challenge_method: 'S256', state: STATE, ...over })}`;

/** agenthub://auth?code=…&state=… from the return page. */
function linkOf(html: string): URL {
  const m = /content="0;url=([^"]+)"/.exec(html);
  if (!m) throw new Error(`no refresh link in ${html.slice(0, 200)}`);
  return new URL(m[1]!.replace(/&amp;/g, '&'));
}

describe('/auth/desktop/* (integration)', () => {
  let t: TestHub;
  beforeAll(async () => {
    t = await startTestHub();
  });
  afterAll(async () => t.close());

  const exchange = (body: unknown, headers: Record<string, string> = { origin: PUBLIC_URL }) =>
    t.hub.app.inject({ method: 'POST', url: '/auth/desktop/exchange', headers: { 'user-agent': UA, ...headers }, payload: body as object });

  /** Browser without ah_session: start → fake Google → callback; returns the callback response. */
  async function googleFlow(email = ALLOWED_EMAIL, opts: { state?: string } = {}) {
    const start = await t.hub.app.inject({ method: 'GET', url: startUrl(opts.state ? { state: opts.state } : {}) });
    expect(start.statusCode).toBe(302);
    const dc = cookieValue(start.headers['set-cookie'], 'ah_desktop');
    const { code, state } = t.oidc.authorize(start.headers.location as string, { email });
    return t.hub.app.inject({ method: 'GET', url: `/auth/desktop/callback?code=${code}&state=${state}`, cookies: { ah_desktop: decodeURIComponent(dc!) } });
  }

  describe('1.3 start', () => {
    it('Браузер не вошёл: 302 to the provider with redirect_uri /auth/desktop/callback; signed cookie on /auth/desktop, 600 s', async () => {
      const r = await t.hub.app.inject({ method: 'GET', url: startUrl() });
      expect(r.statusCode).toBe(302);
      const loc = new URL(r.headers.location as string);
      expect(loc.origin).toBe(t.oidc.issuer);
      expect(loc.searchParams.get('redirect_uri')).toBe(`${PUBLIC_URL}/auth/desktop/callback`);
      expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
      // The hub's own PKCE and state, not the app's.
      expect(loc.searchParams.get('code_challenge')).not.toBe(CHALLENGE);
      expect(loc.searchParams.get('state')).not.toBe(STATE);
      expect(loc.searchParams.get('nonce')).toBeTruthy();
      const set = ([] as string[]).concat(r.headers['set-cookie'] ?? []).find(c => c.startsWith('ah_desktop='))!;
      expect(set).toMatch(/Path=\/auth\/desktop/);
      expect(set).toMatch(/Max-Age=600/);
      expect(set).toMatch(/HttpOnly/);
      expect(set).toMatch(/Secure/);
      expect(set).toMatch(/SameSite=Lax/);
      expect(cookieValue(r.headers['set-cookie'], 'ah_session')).toBeUndefined();
    });

    it('Браузер уже вошёл в хаб: 200 return page with agenthub://auth and the same state, no Google', async () => {
      const session = await t.login();
      const r = await t.hub.app.inject({ method: 'GET', url: startUrl(), cookies: { ah_session: session } });
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toMatch(/^text\/html/);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
      const link = linkOf(r.body);
      expect(link.protocol).toBe('agenthub:');
      expect(link.host).toBe('auth');
      expect(link.searchParams.get('state')).toBe(STATE);
      expect(link.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(r.body).toContain('Открыть Agent Hub');
      expect(r.body).toContain('Вход выполнен. Вкладку можно закрыть.');
      expect(r.body).not.toMatch(/<script/i);
    });

    it.each([
      ['plain method', { code_challenge_method: 'plain' }],
      ['20-char challenge', { code_challenge: 'a'.repeat(20) }],
      ['44-char challenge', { code_challenge: 'a'.repeat(44) }],
      ['challenge with +', { code_challenge: `${'a'.repeat(42)}+` }],
      ['short state', { state: 'a'.repeat(21) }],
      ['state with a dot', { state: `${'a'.repeat(22)}.` }],
    ])('Неверный challenge (%s) → 400, no redirect', async (_n, over) => {
      const r = await t.hub.app.inject({ method: 'GET', url: startUrl(over) });
      expect(r.statusCode).toBe(400);
      expect(r.headers.location).toBeUndefined();
      expect(r.body).toContain('Ссылка входа приложения неверна');
    });

    it('missing parameters → 400', async () => {
      expect((await t.hub.app.inject({ method: 'GET', url: '/auth/desktop/start' })).statusCode).toBe(400);
      expect((await t.hub.app.inject({ method: 'GET', url: `/auth/desktop/start?code_challenge=${CHALLENGE}&state=${STATE}` })).statusCode).toBe(400);
    });
  });

  describe('1.4 callback', () => {
    it('Разрешённый аккаунт: return page with a code, no ah_session cookie', async () => {
      const r = await googleFlow();
      expect(r.statusCode).toBe(200);
      expect(cookieValue(r.headers['set-cookie'], 'ah_session')).toBeUndefined();
      expect(r.headers['cache-control']).toBe('no-store');
      const link = linkOf(r.body);
      expect(link.searchParams.get('state')).toBe(STATE);
      // The login cookie is consumed.
      expect(([] as string[]).concat(r.headers['set-cookie'] ?? []).some(c => c.startsWith('ah_desktop=;'))).toBe(true);
    });

    it('Чужой аккаунт: 403 with the address, no code, the browser session is kept', async () => {
      const session = await t.login();
      const start = await t.hub.app.inject({ method: 'GET', url: startUrl() });
      const dc = cookieValue(start.headers['set-cookie'], 'ah_desktop');
      const { code, state } = t.oidc.authorize(start.headers.location as string, { email: 'stranger@example.com' });
      const r = await t.hub.app.inject({
        method: 'GET',
        url: `/auth/desktop/callback?code=${code}&state=${state}`,
        cookies: { ah_desktop: decodeURIComponent(dc!), ah_session: session },
      });
      expect(r.statusCode).toBe(403);
      expect(r.body).toContain('stranger@example.com');
      expect(r.body).toContain('Доступ только по приглашению');
      expect(r.body).not.toContain('agenthub://');
      expect(([] as string[]).concat(r.headers['set-cookie'] ?? []).some(c => c.startsWith('ah_session='))).toBe(false);
      expect((await t.hub.app.inject({ method: 'GET', url: '/api/me', cookies: { ah_session: session } })).statusCode).toBe(200);
    });

    it('unverified e-mail → 403', async () => {
      const start = await t.hub.app.inject({ method: 'GET', url: startUrl() });
      const dc = cookieValue(start.headers['set-cookie'], 'ah_desktop');
      const { code, state } = t.oidc.authorize(start.headers.location as string, { email: ALLOWED_EMAIL, emailVerified: false });
      const r = await t.hub.app.inject({ method: 'GET', url: `/auth/desktop/callback?code=${code}&state=${state}`, cookies: { ah_desktop: decodeURIComponent(dc!) } });
      expect(r.statusCode).toBe(403);
    });

    it('Подмена state: other state or no cookie → 400, no code', async () => {
      const start = await t.hub.app.inject({ method: 'GET', url: startUrl() });
      const dc = cookieValue(start.headers['set-cookie'], 'ah_desktop');
      const { code } = t.oidc.authorize(start.headers.location as string, { email: ALLOWED_EMAIL });
      const bad = await t.hub.app.inject({ method: 'GET', url: `/auth/desktop/callback?code=${code}&state=forged`, cookies: { ah_desktop: decodeURIComponent(dc!) } });
      expect(bad.statusCode).toBe(400);
      expect(bad.body).not.toContain('agenthub://');
      const noCookie = await t.hub.app.inject({ method: 'GET', url: `/auth/desktop/callback?code=${code}&state=whatever` });
      expect(noCookie.statusCode).toBe(400);
      // The browser login cookie ah_oidc (path /auth) is not accepted instead of ah_desktop.
      const browserStart = await t.hub.app.inject({ method: 'GET', url: '/auth/login' });
      const oc = cookieValue(browserStart.headers['set-cookie'], 'ah_oidc');
      const g = t.oidc.authorize(browserStart.headers.location as string, { email: ALLOWED_EMAIL });
      const mixed = await t.hub.app.inject({ method: 'GET', url: `/auth/desktop/callback?code=${g.code}&state=${g.state}`, cookies: { ah_desktop: decodeURIComponent(oc!) } });
      expect(mixed.statusCode).toBe(400);
    });
    it.each([
      ['no challenge', (c: Record<string, unknown>) => delete c.cc],
      ['bad challenge', (c: Record<string, unknown>) => (c.cc = 'short')],
      ['no app state', (c: Record<string, unknown>) => delete c.as],
      ['bad app state', (c: Record<string, unknown>) => (c.as = 'a.b')],
    ])('a signed ah_desktop cookie with %s → 400, no code', async (_n, mutate) => {
      const start = await t.hub.app.inject({ method: 'GET', url: startUrl() });
      const raw = decodeURIComponent(cookieValue(start.headers['set-cookie'], 'ah_desktop')!);
      const value = JSON.parse(t.hub.app.unsignCookie(raw).value!) as Record<string, unknown>;
      mutate(value);
      const forged = t.hub.app.signCookie(JSON.stringify(value));
      const { code, state } = t.oidc.authorize(start.headers.location as string, { email: ALLOWED_EMAIL });
      const r = await t.hub.app.inject({ method: 'GET', url: `/auth/desktop/callback?code=${code}&state=${state}`, cookies: { ah_desktop: forged } });
      expect(r.statusCode).toBe(400);
      expect(r.body).not.toContain('agenthub://');
    });
  });

  describe('1.5 return page', () => {
    it('escapes the link in HTML attributes', () => {
      const html = desktopReturnPage('agenthub://auth?code=a"b<c&state=x');
      expect(html).toContain('content="0;url=agenthub://auth?code=a&quot;b&lt;c&amp;state=x"');
      expect(html).toContain('href="agenthub://auth?code=a&quot;b&lt;c&amp;state=x"');
      expect(html).not.toContain('a"b<c');
    });
  });

  describe('1.6 exchange', () => {
    it('Успешный обмен: full flow start → callback → exchange; GET /api/me with the token → 200', async () => {
      const cb = await googleFlow();
      const code = linkOf(cb.body).searchParams.get('code')!;
      const before = Date.now();
      const r = await exchange({ code, codeVerifier: VERIFIER, state: STATE });
      expect(r.statusCode).toBe(200);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['set-cookie']).toBeUndefined();
      const body = r.json() as { sessionToken: string; expiresAt: string };
      expect(Object.keys(body).sort()).toEqual(['expiresAt', 'sessionToken']);
      const ttl = Date.parse(body.expiresAt) - before;
      expect(ttl).toBeGreaterThan(30 * 86400_000 - 60_000);
      expect(ttl).toBeLessThan(30 * 86400_000 + 60_000);
      const me = await t.hub.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `ah_session=${body.sessionToken}` } });
      expect(me.statusCode).toBe(200);
      expect((me.json() as { user: { email: string } }).user.email).toBe(ALLOWED_EMAIL);
      const row = await t.tdb.pool.query<{ user_agent: string }>(`SELECT user_agent FROM auth_sessions ORDER BY created_at DESC LIMIT 1`);
      expect(row.rows[0]!.user_agent).toBe(UA);
      // Повторный обмен.
      const again = await exchange({ code, codeVerifier: VERIFIER, state: STATE });
      expect(again.statusCode).toBe(400);
      expect(again.json()).toEqual({ error: 'invalid_grant' });
    });

    it('the «already signed in» branch exchanges too', async () => {
      const session = await t.login();
      const r = await t.hub.app.inject({ method: 'GET', url: startUrl(), cookies: { ah_session: session } });
      const code = linkOf(r.body).searchParams.get('code')!;
      expect((await exchange({ code, codeVerifier: VERIFIER, state: STATE })).statusCode).toBe(200);
    });

    it('Обмен без Origin: 403 forbidden_origin and the code stays usable', async () => {
      const code = linkOf((await googleFlow()).body).searchParams.get('code')!;
      const none = await exchange({ code, codeVerifier: VERIFIER, state: STATE }, {});
      expect(none.statusCode).toBe(403);
      expect(none.json()).toEqual({ error: 'forbidden_origin' });
      const foreign = await exchange({ code, codeVerifier: VERIFIER, state: STATE }, { origin: 'https://evil.example' });
      expect(foreign.statusCode).toBe(403);
      expect((await exchange({ code, codeVerifier: VERIFIER, state: STATE })).statusCode).toBe(200);
    });

    it('Код без verifier бесполезен: a wrong verifier → invalid_grant and burns the code', async () => {
      const code = linkOf((await googleFlow()).body).searchParams.get('code')!;
      const wrong = await exchange({ code, codeVerifier: 'x'.repeat(43), state: STATE });
      expect(wrong.statusCode).toBe(400);
      expect(wrong.json()).toEqual({ error: 'invalid_grant' });
      const right = await exchange({ code, codeVerifier: VERIFIER, state: STATE });
      expect(right.json()).toEqual({ error: 'invalid_grant' });
    });

    it('a wrong state → invalid_grant', async () => {
      const code = linkOf((await googleFlow()).body).searchParams.get('code')!;
      const r = await exchange({ code, codeVerifier: VERIFIER, state: 'another-state-0123456789' });
      expect(r.json()).toEqual({ error: 'invalid_grant' });
    });

    it('unknown code (e.g. after a hub restart) → invalid_grant', async () => {
      const r = await exchange({ code: 'A'.repeat(43), codeVerifier: VERIFIER, state: STATE });
      expect(r.statusCode).toBe(400);
      expect(r.json()).toEqual({ error: 'invalid_grant' });
    });

    it.each([
      ['empty body', undefined],
      ['no verifier', { code: 'x', state: STATE }],
      ['short verifier', { code: 'x', codeVerifier: 'short', state: STATE }],
      ['a string', 'code=x'],
    ])('invalid_request: %s', async (_n, body) => {
      const r = await t.hub.app.inject({
        method: 'POST',
        url: '/auth/desktop/exchange',
        headers: { origin: PUBLIC_URL, ...(typeof body === 'string' ? { 'content-type': 'text/plain' } : {}) },
        ...(body !== undefined ? { payload: body as object } : {}),
      });
      expect(r.statusCode).toBe(400);
      expect(r.json()).toEqual({ error: 'invalid_request' });
    });

    it('forbidden_account: the user was disabled between the code and the exchange (multi-user)', async () => {
      const code = linkOf((await googleFlow()).body).searchParams.get('code')!;
      await t.tdb.pool.query(`UPDATE users SET status = 'disabled' WHERE email = $1`, [ALLOWED_EMAIL]);
      try {
        const r = await exchange({ code, codeVerifier: VERIFIER, state: STATE });
        expect(r.statusCode).toBe(403);
        expect(r.json()).toEqual({ error: 'forbidden_account' });
      } finally {
        await t.tdb.pool.query(`UPDATE users SET status = 'active' WHERE email = $1`, [ALLOWED_EMAIL]);
      }
    });
  });

  describe('Вход браузера не меняется', () => {
    it('/auth/login still redirects with the browser redirect URI', async () => {
      const r = await t.hub.app.inject({ method: 'GET', url: '/auth/login?return=/s/x' });
      expect(r.statusCode).toBe(302);
      expect(new URL(r.headers.location as string).searchParams.get('redirect_uri')).toBe(`${PUBLIC_URL}/auth/callback`);
    });
  });
});

// Change multi-user, task 2.2: the desktop app through Keycloak for an invited user; the same admission as the browser.
describe('/auth/desktop/* with Keycloak (multi-user)', () => {
  let t: TestHub;
  beforeAll(async () => {
    t = await startTestHub({ keycloak: true });
  });
  afterAll(async () => t.close());

  it('without a provider: the choice page; with provider=keycloak: the invited user gets a code and a session', async () => {
    const choice = await t.hub.app.inject({ method: 'GET', url: startUrl() });
    expect(choice.statusCode).toBe(200);
    expect(choice.body).toContain('Войти через Acme');
    expect(choice.body).toContain('provider=keycloak');
    // A colleague who accepted his invite in the browser (provider keycloak, his sub).
    await t.tdb.pool.query(`INSERT INTO users (email, provider, subject) VALUES ('colleague@example.com', 'keycloak', 'kc-1')`);
    const start = await t.hub.app.inject({ method: 'GET', url: startUrl({ provider: 'keycloak' }) });
    expect(start.statusCode).toBe(302);
    expect((start.headers.location as string).startsWith(`${t.keycloak!.issuer}/`)).toBe(true);
    const dc = cookieValue(start.headers['set-cookie'], 'ah_desktop');
    const { code, state } = t.keycloak!.authorize(start.headers.location as string, { email: 'colleague@example.com', sub: 'kc-1' });
    const cb = await t.hub.app.inject({ method: 'GET', url: `/auth/desktop/callback?code=${code}&state=${state}`, cookies: { ah_desktop: decodeURIComponent(dc!) } });
    expect(cb.statusCode).toBe(200);
    const appCode = linkOf(cb.body).searchParams.get('code')!;
    const r = await t.hub.app.inject({ method: 'POST', url: '/auth/desktop/exchange', headers: { origin: PUBLIC_URL }, payload: { code: appCode, codeVerifier: VERIFIER, state: STATE } });
    expect(r.statusCode).toBe(200);
    const me = await t.hub.app.inject({ method: 'GET', url: '/api/me', cookies: { ah_session: r.json().sessionToken } });
    expect(me.json().user).toMatchObject({ email: 'colleague@example.com', role: 'user', provider: 'keycloak' });
  });

  it('a person without an invite through Keycloak: 403 «Доступ только по приглашению», no user', async () => {
    const start = await t.hub.app.inject({ method: 'GET', url: startUrl({ provider: 'keycloak' }) });
    const dc = cookieValue(start.headers['set-cookie'], 'ah_desktop');
    const { code, state } = t.keycloak!.authorize(start.headers.location as string, { email: 'stranger@example.com' });
    const cb = await t.hub.app.inject({ method: 'GET', url: `/auth/desktop/callback?code=${code}&state=${state}`, cookies: { ah_desktop: decodeURIComponent(dc!) } });
    expect(cb.statusCode).toBe(403);
    expect(cb.body).toContain('Доступ только по приглашению');
    expect((await t.tdb.pool.query(`SELECT 1 FROM users WHERE email = 'stranger@example.com'`)).rowCount).toBe(0);
  });
});
