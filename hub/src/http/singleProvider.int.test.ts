// Change keycloak-auth: the single-provider mode (D5 login and hints, D6 admission, D7 logout) against a real hub, Postgres
// and the fake OIDC provider.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALLOWED_EMAIL, PUBLIC_URL, cookieValue, startTestHub, waitFor, type TestHub } from '../test/harness.js';
import { pkceChallenge } from '../auth/desktopCodes.js';
import { admitSingle, createInvite } from '../users/repo.js';
import { hashSecret } from '../auth/secrets.js';
import { openSessionIdToken, sealLegacyIdTokens, sealSessionIdToken } from '../auth/idToken.js';

const ACCOUNT_URL = 'https://id.test.example/realms/agent-hub/account';
const ID_KEY = Buffer.alloc(32, 17);

async function userRow(t: TestHub, email: string) {
  const r = await t.tdb.pool.query(`SELECT id, provider, subject, source, status FROM users WHERE lower(email) = $1`, [email]);
  return r.rows[0] as { id: string; provider: string; subject: string | null; source: string; status: string } | undefined;
}

async function adminId(t: TestHub): Promise<string> {
  return (await userRow(t, ALLOWED_EMAIL))!.id;
}

/** Security events are written without waiting for them: polls until `count` events of the user exist; sorted kinds. */
async function eventKinds(t: TestHub, userId: string, count: number): Promise<string[]> {
  return waitFor(async () => {
    const r = await t.tdb.pool.query(`SELECT kind FROM security_events WHERE user_id = $1`, [userId]);
    return r.rows.length >= count ? r.rows.map(x => x.kind as string).sort() : null;
  });
}

describe('keycloak-auth: single provider with hints', () => {
  let t: TestHub;
  beforeAll(async () => {
    t = await startTestHub({
      single: true,
      env: {
        OIDC_PROVIDER_LABEL: 'Agent Hub ID',
        OIDC_IDP_HINTS: `corp:Corp@${PUBLIC_URL}`,
        OIDC_ACCOUNT_URL: ACCOUNT_URL,
        SUBSCRIPTION_TOKEN_KEY: ID_KEY.toString('base64'),
      },
    });
  });
  afterAll(async () => t.close());

  const app = () => t.hub.app;
  const get = (url: string, session?: string) => app().inject({ method: 'GET', url, ...(session ? { cookies: { ah_session: session } } : {}) });
  const post = (url: string, session: string, payload?: object) =>
    app().inject({ method: 'POST', url, headers: { origin: PUBLIC_URL }, cookies: { ah_session: session }, ...(payload ? { payload } : {}) });

  describe('D5: login page and hints', () => {
    it('an address with hints shows the main button and the hint buttons, keeping return and invite', async () => {
      const r = await get('/auth/login?return=%2Fs%2F1');
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('>Agent Hub ID</a>');
      expect(r.body).toContain('href="/auth/login?provider=oidc&amp;return=%2Fs%2F1"');
      expect(r.body).toContain('href="/auth/login?hint=corp&amp;return=%2Fs%2F1"');
      expect(r.body).toContain('Corp');
    });

    it('?hint=corp goes to the provider with kc_idp_hint and ui_locales', async () => {
      const r = await get('/auth/login?hint=corp');
      expect(r.statusCode).toBe(302);
      const loc = new URL(r.headers.location as string);
      expect(loc.origin).toBe(t.oidc.issuer);
      expect(loc.searchParams.get('kc_idp_hint')).toBe('corp');
      expect(loc.searchParams.get('ui_locales')).toBe('ru');
      expect(loc.searchParams.get('redirect_uri')).toBe(`${PUBLIC_URL}/auth/callback`);
    });

    it('the main button goes to the provider without kc_idp_hint', async () => {
      const r = await get('/auth/login?provider=oidc');
      expect(r.statusCode).toBe(302);
      expect(new URL(r.headers.location as string).searchParams.has('kc_idp_hint')).toBe(false);
    });

    it('an unknown hint is 400 and does not visit the provider', async () => {
      const r = await get('/auth/login?hint=google');
      expect(r.statusCode).toBe(400);
      expect(r.body).toContain('Этот способ входа на этом адресе недоступен.');
      expect(cookieValue(r.headers['set-cookie'], 'ah_oidc')).toBeUndefined();
    });

    it('«Войти под другим аккаунтом» asks the provider for the login again', async () => {
      const r = await get('/auth/login?provider=oidc&prompt=select_account');
      expect(new URL(r.headers.location as string).searchParams.get('prompt')).toBe('login');
    });
  });

  describe('D6: admission', () => {
    it('Перенос по почте: the bootstrap administrator keeps the account; provider oidc and sub are stored', async () => {
      const before = await adminId(t);
      const cb = await t.loginResponse({ sub: 'kc-admin' });
      expect(cb.statusCode).toBe(302);
      expect(cb.headers.location).toBe('/s/abc');
      const row = (await userRow(t, ALLOWED_EMAIL))!;
      expect(row).toMatchObject({ id: before, provider: 'oidc', subject: 'kc-admin' });
    });

    it('a returning user is found by sub even with a changed address', async () => {
      const id = await adminId(t);
      const session = await t.login({ sub: 'kc-admin', email: 'renamed@example.com' });
      const me = await get('/api/me', session);
      expect(me.json().user.id).toBe(id);
    });

    it('/api/me carries the account URL', async () => {
      const session = await t.login({ sub: 'kc-admin' });
      expect((await get('/api/me', session)).json()).toMatchObject({ accountUrl: ACCOUNT_URL, singleProvider: 'Agent Hub ID' });
    });

    it('an unverified address is refused', async () => {
      const cb = await t.loginResponse({ email: 'fresh@example.com', sub: 'kc-fresh', emailVerified: false });
      expect(cb.statusCode).toBe(403);
      expect(cb.session).toBeFalsy();
      expect(await userRow(t, 'fresh@example.com')).toBeUndefined();
    });

    it('Другой аккаунт провайдера: the address of an oidc user with another sub is refused', async () => {
      const cb = await t.loginResponse({ sub: 'kc-someone-else' });
      expect(cb.statusCode).toBe(403);
      expect(cb.body).toContain('Другой аккаунт');
      expect(cb.session).toBeFalsy();
      expect((await userRow(t, ALLOWED_EMAIL))!.subject).toBe('kc-admin');
    });

    it('SIGNUP_MODE=invite: a stranger is refused, no user is created', async () => {
      const cb = await t.loginResponse({ email: 'stranger@example.com', sub: 'kc-stranger' });
      expect(cb.statusCode).toBe(403);
      expect(cb.body).toContain('stranger@example.com');
      expect(await userRow(t, 'stranger@example.com')).toBeUndefined();
    });

    it('Приглашение по почте: an invite without a provider admits the address through any login button', async () => {
      await createInvite(t.tdb.db, await adminId(t), 'invited@example.com', null);
      const cb = await t.loginResponse({ email: 'Invited@Example.com', sub: 'kc-invited' }, { hint: 'corp' });
      expect(cb.statusCode).toBe(302);
      expect(cb.headers.location).toBe('/');
      const row = (await userRow(t, 'invited@example.com'))!;
      expect(row).toMatchObject({ provider: 'oidc', subject: 'kc-invited', source: 'invite' });
      const inv = await t.tdb.pool.query(`SELECT used_at, user_id FROM invites WHERE email = 'invited@example.com'`);
      expect(inv.rows[0].used_at).not.toBeNull();
      expect(inv.rows[0].user_id).toBe(row.id);
      expect(await eventKinds(t, row.id, 1)).toEqual(['login']);
    });

    it('a disabled user is refused', async () => {
      await t.tdb.pool.query(`UPDATE users SET status = 'disabled' WHERE email = 'invited@example.com'`);
      const cb = await t.loginResponse({ email: 'invited@example.com', sub: 'kc-invited' });
      expect(cb.statusCode).toBe(403);
      expect(cb.session).toBeFalsy();
    });
  });

  describe('invites', () => {
    it('POST /api/admin/invites without a provider; the invite page offers the address only', async () => {
      const admin = await t.login({ sub: 'kc-admin' });
      const r = await post('/api/admin/invites', admin, { email: 'nobind@example.com' });
      expect(r.statusCode).toBe(201);
      const row = await t.tdb.pool.query(`SELECT provider FROM invites WHERE email = 'nobind@example.com'`);
      expect(row.rows[0].provider).toBeNull();
      const code = (r.json().url as string).split('/invite/')[1]!;
      const page = await get(`/invite/${code}`);
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('Войдите или создайте аккаунт с этим адресом.');
      expect(page.body).toContain(`invite=${code}`);
    });

    it('Вход под другим адресом: the invite link with another account shows «Приглашение выписано на…», the invite stays valid', async () => {
      const admin = await t.login({ sub: 'kc-admin' });
      const r = await post('/api/admin/invites', admin, { email: 'meant@example.com' });
      const code = (r.json().url as string).split('/invite/')[1]!;
      const cb = await t.loginResponse({ email: 'other@example.com', sub: 'kc-other' }, { invite: code });
      expect(cb.statusCode).toBe(403);
      expect(cb.body).toContain('Приглашение выписано на meant@example.com');
      expect(cb.body).toContain('other@example.com');
      expect(cb.body).toContain('href="/auth/provider-logout"');
      expect(cb.body).not.toContain('Доступ только по приглашению');
      expect(cb.session).toBeFalsy();
      expect(await userRow(t, 'other@example.com')).toBeUndefined();
      const inv = await t.tdb.pool.query(`SELECT used_at FROM invites WHERE email = 'meant@example.com'`);
      expect(inv.rows[0].used_at).toBeNull();
      // without the invite link the same account sees «Доступ только по приглашению»
      const plain = await t.loginResponse({ email: 'other@example.com', sub: 'kc-other' });
      expect(plain.body).toContain('Доступ только по приглашению');
    });

    it('a provider sent by an old client is ignored', async () => {
      const admin = await t.login({ sub: 'kc-admin' });
      const r = await post('/api/admin/invites', admin, { email: 'oldclient@example.com', provider: 'keycloak' });
      expect(r.statusCode).toBe(201);
      const row = await t.tdb.pool.query(`SELECT provider FROM invites WHERE email = 'oldclient@example.com'`);
      expect(row.rows[0].provider).toBeNull();
    });
  });

  describe('D7: logout', () => {
    it('Выход: 200 with the end_session_endpoint, id_token_hint and the root of the address', async () => {
      const session = await t.login({ sub: 'kc-admin' });
      const out = await post('/auth/logout', session);
      expect(out.statusCode).toBe(200);
      const url = new URL(out.json().redirect as string);
      expect(`${url.origin}${url.pathname}`).toBe(`${t.oidc.issuer}/logout`);
      expect(url.searchParams.get('post_logout_redirect_uri')).toBe(`${PUBLIC_URL}/`);
      expect(url.searchParams.get('id_token_hint')).toMatch(/^ey/);
      expect((await get('/api/me', session)).statusCode).toBe(401);
    });

    it('logout-all does not involve the provider', async () => {
      const session = await t.login({ sub: 'kc-admin' });
      const out = await post('/api/auth/logout-all', session);
      expect(out.statusCode).toBe(200);
      expect(JSON.stringify(out.json())).not.toContain(t.oidc.issuer);
    });
  });

  describe('idtoken-at-rest: the id token at rest', () => {
    const sessionRow = async (session: string) => {
      const r = await t.tdb.pool.query(`SELECT id_token, id_token_enc FROM auth_sessions WHERE id_hash = $1`, [hashSecret(session)]);
      return r.rows[0] as { id_token: string | null; id_token_enc: Buffer | null };
    };
    const logoutUrl = async (session: string) => {
      const out = await post('/auth/logout', session);
      expect(out.statusCode).toBe(200);
      return new URL(out.json().redirect as string);
    };

    it('Вход сохраняет шифртекст: no plaintext in the row, logout gives back the issued token', async () => {
      const session = await t.login({ sub: 'kc-admin' });
      const row = await sessionRow(session);
      expect(row.id_token).toBeNull();
      expect(row.id_token_enc).not.toBeNull();
      const token = openSessionIdToken(ID_KEY, hashSecret(session), row.id_token_enc!);
      expect(token).toMatch(/^ey/);
      expect(row.id_token_enc!.toString('latin1')).not.toContain(token!.slice(0, 20));
      expect((await logoutUrl(session)).searchParams.get('id_token_hint')).toBe(token);
    });

    it('Старые сессии после обновления: a plaintext token is sealed, the session stays, logout keeps the hint', async () => {
      const session = await t.login({ sub: 'kc-admin' });
      const idHash = hashSecret(session);
      const token = openSessionIdToken(ID_KEY, idHash, (await sessionRow(session)).id_token_enc!)!;
      await t.tdb.pool.query(`UPDATE auth_sessions SET id_token = $2, id_token_enc = NULL WHERE id_hash = $1`, [idHash, token]);
      expect(await sealLegacyIdTokens(t.tdb.db, ID_KEY)).toBe(1);
      expect(await sealLegacyIdTokens(t.tdb.db, ID_KEY)).toBe(0);
      const row = await sessionRow(session);
      expect(row.id_token).toBeNull();
      expect(row.id_token_enc).not.toBeNull();
      expect((await get('/api/me', session)).statusCode).toBe(200);
      expect((await logoutUrl(session)).searchParams.get('id_token_hint')).toBe(token);
    });

    it('without a key a plaintext token is erased, the session stays', async () => {
      const session = await t.login({ sub: 'kc-admin' });
      await t.tdb.pool.query(`UPDATE auth_sessions SET id_token = 'plain', id_token_enc = NULL WHERE id_hash = $1`, [hashSecret(session)]);
      expect(await sealLegacyIdTokens(t.tdb.db, null)).toBe(1);
      expect((await sessionRow(session)).id_token).toBeNull();
      expect((await get('/api/me', session)).statusCode).toBe(200);
      expect((await logoutUrl(session)).searchParams.get('id_token_hint')).toBeNull();
    });

    it('Ключ сменили: a ciphertext of another key or another session gives logout without a hint', async () => {
      const moved = await t.login({ sub: 'kc-admin' });
      const other = await t.login({ sub: 'kc-admin' });
      const foreign = (await sessionRow(other)).id_token_enc;
      await t.tdb.pool.query(`UPDATE auth_sessions SET id_token_enc = $2 WHERE id_hash = $1`, [hashSecret(moved), foreign]);
      const movedUrl = await logoutUrl(moved);
      expect(`${movedUrl.origin}${movedUrl.pathname}`).toBe(`${t.oidc.issuer}/logout`);
      expect(movedUrl.searchParams.get('id_token_hint')).toBeNull();
      expect(movedUrl.searchParams.get('post_logout_redirect_uri')).toBe(`${PUBLIC_URL}/`);
      expect((await get('/api/me', moved)).statusCode).toBe(401);

      const rekeyed = sealSessionIdToken(Buffer.alloc(32, 99), hashSecret(other), 'eyJ.other-key');
      await t.tdb.pool.query(`UPDATE auth_sessions SET id_token_enc = $2 WHERE id_hash = $1`, [hashSecret(other), rekeyed]);
      expect((await logoutUrl(other)).searchParams.get('id_token_hint')).toBeNull();
      expect((await get('/api/me', other)).statusCode).toBe(401);
    });
  });

  describe('idtoken-at-rest: provider logout from a denied page', () => {
    const providerLogout = (cookie?: string) => app().inject({ method: 'GET', url: '/auth/provider-logout', ...(cookie ? { cookies: { ah_denied: cookie } } : {}) });
    const deniedCookie = (setCookie: unknown) => {
      const raw = cookieValue(setCookie as string[], 'ah_denied');
      return raw ? decodeURIComponent(raw) : undefined;
    };
    const expectEndSession = (location: unknown) => {
      const url = new URL(location as string);
      expect(`${url.origin}${url.pathname}`).toBe(`${t.oidc.issuer}/logout`);
      expect(url.searchParams.get('post_logout_redirect_uri')).toBe(`${PUBLIC_URL}/`);
      expect(url.searchParams.get('client_id')).toBe(t.oidc.clientId);
      return url;
    };

    it('Вход без приглашения: the refusal keeps the id token in a cookie, the button ends the provider session with the hint', async () => {
      const cb = await t.loginResponse({ email: 'denied@example.com', sub: 'kc-denied' });
      expect(cb.statusCode).toBe(403);
      expect(cb.body).toContain('href="/auth/provider-logout"');
      expect(cb.body).not.toContain('prompt=select_account');
      expect(cb.body).not.toContain('id_token_hint');
      const setCookie = String(cb.headers['set-cookie']);
      expect(setCookie).toMatch(/ah_denied=[^;]+;.*Path=\/auth/);
      expect(setCookie).toMatch(/HttpOnly/);
      const cookie = deniedCookie(cb.headers['set-cookie'])!;
      expect(cookie).not.toMatch(/^ey/);

      const out = await providerLogout(cookie);
      expect(out.statusCode).toBe(302);
      expect(out.headers['cache-control']).toBe('no-store');
      expect(expectEndSession(out.headers.location).searchParams.get('id_token_hint')).toMatch(/^ey/);
      expect(String(out.headers['set-cookie'])).toMatch(/ah_denied=;.*Path=\/auth/);
    });

    it('Другой аккаунт and a disabled user also lead to the provider logout', async () => {
      const mismatch = await t.loginResponse({ sub: 'kc-mismatch' });
      expect(mismatch.statusCode).toBe(403);
      expect(mismatch.body).toContain('href="/auth/provider-logout"');
      expect(deniedCookie(mismatch.headers['set-cookie'])).toBeTruthy();
      const disabled = await t.loginResponse({ email: 'invited@example.com', sub: 'kc-invited' });
      expect(disabled.statusCode).toBe(403);
      expect(disabled.body).toContain('href="/auth/provider-logout"');
      expect(deniedCookie(disabled.headers['set-cookie'])).toBeTruthy();
    });

    it('Отказ без id-токена: /auth/disabled offers the button, the provider logout goes without a hint', async () => {
      const page = await get('/auth/disabled');
      expect(page.body).toContain('href="/auth/provider-logout"');
      const out = await providerLogout();
      expect(out.statusCode).toBe(302);
      expect(expectEndSession(out.headers.location).searchParams.get('id_token_hint')).toBeNull();
    });

    it('a successful login clears the cookie of an earlier refusal', async () => {
      const start = await get('/auth/login?provider=oidc');
      const oidcCookie = cookieValue(start.headers['set-cookie'], 'ah_oidc')!;
      const { code, state } = t.oidc.authorize(start.headers.location as string, { email: ALLOWED_EMAIL, sub: 'kc-admin' });
      const cb = await app().inject({
        method: 'GET',
        url: `/auth/callback?code=${code}&state=${state}`,
        cookies: { ah_oidc: decodeURIComponent(oidcCookie), ah_denied: 'left-from-a-refusal' },
      });
      expect(cb.statusCode).toBe(302);
      expect(String(cb.headers['set-cookie'])).toMatch(/ah_denied=;.*Path=\/auth/);
    });

    it('a forged cookie gives the provider logout without a hint', async () => {
      const out = await providerLogout('forged-value');
      expect(out.statusCode).toBe(302);
      expect(expectEndSession(out.headers.location).searchParams.get('id_token_hint')).toBeNull();
    });
  });

  describe('desktop', () => {
    const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const startUrl = (over: Record<string, string> = {}) =>
      `/auth/desktop/start?${new URLSearchParams({ code_challenge: pkceChallenge(VERIFIER), code_challenge_method: 'S256', state: 'app-state-0123456789abcdef', ...over })}`;

    it('the start shows the hints page with desktop links; an unknown hint is 400', async () => {
      const r = await get(startUrl());
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('/auth/desktop/start?');
      expect(r.body).toContain('hint=corp');
      expect((await get(startUrl({ hint: 'nope' }))).statusCode).toBe(400);
    });

    it('?hint=corp → provider with kc_idp_hint → callback gives the app a code', async () => {
      const start = await get(startUrl({ hint: 'corp' }));
      expect(start.statusCode).toBe(302);
      const loc = start.headers.location as string;
      expect(new URL(loc).searchParams.get('kc_idp_hint')).toBe('corp');
      const dc = cookieValue(start.headers['set-cookie'], 'ah_desktop')!;
      const { code, state } = t.oidc.authorize(loc, { email: ALLOWED_EMAIL, sub: 'kc-admin' });
      const cb = await app().inject({ method: 'GET', url: `/auth/desktop/callback?code=${code}&state=${state}`, cookies: { ah_desktop: decodeURIComponent(dc) } });
      expect(cb.statusCode).toBe(200);
      expect(cb.body).toContain('agenthub://auth?code=');
    });

    it('a stranger is refused on the desktop too', async () => {
      const start = await get(startUrl({ provider: 'oidc' }));
      const dc = cookieValue(start.headers['set-cookie'], 'ah_desktop')!;
      const { code, state } = t.oidc.authorize(start.headers.location as string, { email: 'desk-stranger@example.com', sub: 'kc-desk' });
      const cb = await app().inject({ method: 'GET', url: `/auth/desktop/callback?code=${code}&state=${state}`, cookies: { ah_desktop: decodeURIComponent(dc) } });
      expect(cb.statusCode).toBe(403);
      expect(cb.body).not.toContain('agenthub://auth');
      expect(cb.body).toContain('href="/auth/provider-logout"');
      expect(String(cb.headers['set-cookie'])).toMatch(/ah_denied=[^;]+;/);
    });
  });
});

describe('keycloak-auth: single provider without hints, open signup', () => {
  let t: TestHub;
  beforeAll(async () => {
    t = await startTestHub({ single: true, env: { SIGNUP_MODE: 'open' } });
  });
  afterAll(async () => t.close());

  it('an address without hints goes to the provider at once', async () => {
    const r = await t.hub.app.inject({ method: 'GET', url: '/auth/login' });
    expect(r.statusCode).toBe(302);
    expect(new URL(r.headers.location as string).origin).toBe(t.oidc.issuer);
  });

  it('without SUBSCRIPTION_TOKEN_KEY no id token is kept, logout goes without a hint', async () => {
    const session = await t.login({ sub: 'kc-admin' });
    const r = await t.tdb.pool.query(`SELECT id_token, id_token_enc FROM auth_sessions WHERE id_hash = $1`, [hashSecret(session)]);
    expect(r.rows[0]).toEqual({ id_token: null, id_token_enc: null });
    const out = await t.hub.app.inject({ method: 'POST', url: '/auth/logout', headers: { origin: PUBLIC_URL }, cookies: { ah_session: session } });
    expect(new URL(out.json().redirect as string).searchParams.get('id_token_hint')).toBeNull();
  });

  it('?hint= is 400 when the address has no hints', async () => {
    expect((await t.hub.app.inject({ method: 'GET', url: '/auth/login?hint=corp' })).statusCode).toBe(400);
  });

  it('Самостоятельная регистрация: a new verified address gets an account, source signup and a signup event', async () => {
    const cb = await t.loginResponse({ email: 'newcomer@example.com', sub: 'kc-new', name: 'New Comer' });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe('/');
    const row = (await userRow(t, 'newcomer@example.com'))!;
    expect(row).toMatchObject({ provider: 'oidc', subject: 'kc-new', source: 'signup', status: 'active' });
    expect(await eventKinds(t, row.id, 2)).toEqual(['login', 'signup']);
  });

  it('two first logins of one user at once create one account (browser and desktop race)', async () => {
    const identity = { subject: 'kc-race', email: 'race@example.com', emailVerified: true, name: 'Race' };
    const [a, b] = await Promise.all([admitSingle(t.tdb.db, identity, 'open'), admitSingle(t.tdb.db, identity, 'open')]);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.user.id).toBe(b.user.id);
    const r = await t.tdb.pool.query(`SELECT count(*)::int AS n FROM users WHERE lower(email) = 'race@example.com'`);
    expect(r.rows[0].n).toBe(1);
  });

  it('an unverified address is still refused in the open mode', async () => {
    const cb = await t.loginResponse({ email: 'unverified@example.com', sub: 'kc-unv', emailVerified: false });
    expect(cb.statusCode).toBe(403);
    expect(await userRow(t, 'unverified@example.com')).toBeUndefined();
  });

  it('/api/me has no account URL for an issuer outside a Keycloak realm; the provider name falls back to OIDC', async () => {
    const session = await t.login({ sub: 'kc-admin' });
    const me = (await t.hub.app.inject({ method: 'GET', url: '/api/me', cookies: { ah_session: session } })).json();
    expect(me).toMatchObject({ accountUrl: null, singleProvider: 'OIDC' });
  });
});

describe('keycloak-auth: two-provider mode keeps the invite provider', () => {
  let t: TestHub;
  beforeAll(async () => {
    t = await startTestHub();
  });
  afterAll(async () => t.close());

  it('POST /api/admin/invites without a provider is 400', async () => {
    const admin = await t.login();
    const r = await t.hub.app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      headers: { origin: PUBLIC_URL },
      cookies: { ah_session: admin },
      payload: { email: 'x@example.com' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('invalid_request');
  });

  it('the denied pages and /auth/provider-logout keep the account choice', async () => {
    const cb = await t.loginResponse({ email: 'two-stranger@example.com', sub: 'g-stranger' });
    expect(cb.statusCode).toBe(403);
    expect(cb.body).toContain('prompt=select_account');
    expect(cb.body).not.toContain('/auth/provider-logout');
    expect(String(cb.headers['set-cookie'] ?? '')).not.toContain('ah_denied');
    const out = await t.hub.app.inject({ method: 'GET', url: '/auth/provider-logout' });
    expect(out.statusCode).toBe(302);
    expect(out.headers.location).toBe('/auth/login?prompt=select_account');
  });

  it('logout answers with the root', async () => {
    const session = await t.login();
    const out = await t.hub.app.inject({ method: 'POST', url: '/auth/logout', headers: { origin: PUBLIC_URL }, cookies: { ah_session: session } });
    expect(out.json()).toEqual({ redirect: '/' });
  });

  it('rollback: a user moved to oidc signs in with the old provider by the address and is bound to it again', async () => {
    await t.tdb.pool.query(`UPDATE users SET provider = 'oidc', subject = 'kc-sub-1' WHERE lower(email) = $1`, [ALLOWED_EMAIL]);
    const session = await t.login();
    const me = await t.hub.app.inject({ method: 'GET', url: '/api/me', cookies: { ah_session: session } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.role).toBe('admin');
    const row = await userRow(t, ALLOWED_EMAIL);
    expect(row?.provider).toBe('google');
    expect(row?.subject).not.toBe('kc-sub-1');
  });
});
