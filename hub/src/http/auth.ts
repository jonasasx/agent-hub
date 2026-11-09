// Requirements: Вход через Google OIDC; Браузерная сессия 30 дней; Защита API и WebSocket UI.
// Change multi-user: Вход по приглашению (Google or Keycloak), Закрыто по умолчанию, Защита браузерных запросов,
// Лимиты запросов, Журнал безопасности и выход везде.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DEFAULT_LOCALE, type Locale, type LoginProvider, type LogoutAllResponse, type LogoutResponse } from '@agent-hub/shared';
import type { Config, IdpHint } from '../config.js';
import type { Db } from '../db/db.js';
import type { OidcChecks, OidcClient } from '../auth/oidc.js';
import { SESSION_COOKIE, SESSION_TTL_MS, createSession, deleteSession, deleteUserSessions, findSession, findSessionUser, upsertUser, type AuthUser } from '../auth/sessions.js';
import {
  accountMismatchPage,
  chooseProviderPage,
  disabledPage,
  inviteExpiredPage,
  inviteInvalidPage,
  inviteMismatchPage,
  inviteOnlyPage,
  invitePage,
  singleInviteMismatchPage,
  loginErrorPage,
  providerLabel,
  signInPage,
  PROVIDER_LOGOUT_HREF,
  SWITCH_ACCOUNT_HREF,
} from './pages.js';
import { hashSecret } from '../auth/secrets.js';
import { idTokenKey, openDeniedIdToken, sealDeniedIdToken } from '../auth/idToken.js';
import { admit, admitSingle, findInvite, inviteStatus, logSecurity, type Admission, type SingleAdmission, type TwoProvider } from '../users/repo.js';
import type { HubLimits } from './limits.js';
import { requestLocale, tr } from '../i18n.js';

interface LoginQuery {
  return?: string;
  prompt?: string;
  provider?: string;
  invite?: string;
  /** keycloak-auth D5: id of OIDC_IDP_HINTS, goes to the provider as kc_idp_hint. */
  hint?: string;
}

const OIDC_COOKIE = 'ah_oidc';
const OIDC_COOKIE_TTL_S = 600;
/** idtoken-at-rest-denied-logout D3: the encrypted id_token of a refused single-provider login, for /auth/provider-logout. */
export const DENIED_COOKIE = 'ah_denied';
const DENIED_COOKIE_TTL_S = 600;

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
    /** change i18n D5: the language of texts for a person in the answer. */
    locale: Locale;
  }
}

interface OidcCookie extends OidcChecks {
  /** Path to return to after login. */
  r: string;
  /** Provider of this login (absent in cookies of the old Google-only hub: Google); `oidc` — the OIDC_ISSUER provider. */
  p?: LoginProvider;
  /** Invite code of /invite/<code>. */
  i?: string;
}

/** OIDC clients by provider; Keycloak is absent when not configured. In single-provider mode `google` is the OIDC_ISSUER client. */
export interface OidcProviders {
  google: OidcClient;
  keycloak?: OidcClient | undefined;
}

export function enabledProviders(p: OidcProviders): TwoProvider[] {
  return p.keycloak ? ['google', 'keycloak'] : ['google'];
}

/** keycloak-auth D5: the hints (kc_idp_hint) offered on the public address of this request. */
export function hintsFor(req: FastifyRequest, config: Config): IdpHint[] {
  const origin = new URL(requestPublicUrl(req, config)).origin;
  return config.idpHints.filter(h => h.origins.length === 0 || h.origins.includes(origin));
}

/** The name of the single provider in error texts: OIDC_PROVIDER_LABEL, else «OIDC». */
export function singleProviderLabel(config: Config): string {
  return config.OIDC_PROVIDER_LABEL ?? 'OIDC';
}

/** keycloak-auth D6: the page of a refused single-provider login; `mismatch` there means another account with this address. */
/** idtoken-at-rest-denied-logout D3: the button of every page leads to /auth/provider-logout. */
export function singleDeniedPage(locale: Locale, reason: Extract<SingleAdmission, { ok: false }>['reason'], email: string | null): { code: number; body: string } {
  if (reason === 'disabled') return { code: 403, body: disabledPage(locale, PROVIDER_LOGOUT_HREF) };
  if (reason === 'mismatch') return { code: 403, body: accountMismatchPage(locale, email, PROVIDER_LOGOUT_HREF) };
  return { code: 403, body: inviteOnlyPage(locale, email, PROVIDER_LOGOUT_HREF) };
}

/**
 * idtoken-at-rest-denied-logout D3: keeps the id_token of a refused single-provider login (browser or desktop) for
 * 10 minutes in a signed cookie, encrypted with the hub's key; without a key or a token there is nothing to keep.
 */
export function rememberDeniedLogin(reply: FastifyReply, key: Buffer | null, idToken: string | null | undefined): void {
  if (!key || !idToken) return;
  const value = sealDeniedIdToken(key, idToken);
  if (!value) return;
  reply.setCookie(DENIED_COOKIE, value, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/auth',
    maxAge: DENIED_COOKIE_TTL_S,
    signed: true,
  });
}

/**
 * Post-login target: only a path on PUBLIC_URL's own origin (no open redirect). The value is resolved
 * like a browser would resolve it, so tricks such as "//host", "/\host" or control characters
 * that browsers strip ("/<TAB>/host") cannot leave the origin.
 */
export function safeReturnPath(value: unknown, publicUrl: string): string {
  // Control characters are matched on purpose: browsers strip them from URLs before resolving.
  // eslint-disable-next-line no-control-regex
  if (typeof value !== 'string' || !value.startsWith('/') || /[\x00-\x1f\x7f\\]/.test(value)) return '/';
  let u: URL;
  try {
    u = new URL(value, publicUrl);
  } catch {
    return '/';
  }
  if (u.origin !== new URL(publicUrl).origin) return '/';
  if (u.pathname === '/auth' || u.pathname.startsWith('/auth/')) return '/';
  const result = `${u.pathname}${u.search}`;
  // Dot segments can normalise to "//host" ("/..//evil", "/%2e%2e//evil"): a protocol-relative Location.
  if (result.startsWith('//') || new URL(result, publicUrl).origin !== u.origin) return '/';
  return result;
}

/** Mutating requests must carry Origin equal to one of the public origins. */
export function isAllowedOrigin(origin: string | undefined, publicOrigins: string[]): boolean {
  return origin !== undefined && publicOrigins.includes(origin);
}

/** The public address the request came to (Host, X-Forwarded-* only from TRUSTED_PROXIES); an unknown host — PUBLIC_URL. */
export function requestPublicUrl(req: FastifyRequest, config: Config): string {
  let origin: string;
  try {
    origin = new URL(`${req.protocol}://${req.host}`).origin;
  } catch {
    return config.PUBLIC_URL;
  }
  return config.publicUrls.find(u => new URL(u).origin === origin) ?? config.PUBLIC_URL;
}

/** Providers offered on the public address of this request. */
export function providersFor(req: FastifyRequest, config: Config, oidc: OidcProviders): TwoProvider[] {
  const providers = enabledProviders(oidc);
  if (config.keycloakOrigins.length === 0 || config.keycloakOrigins.includes(new URL(requestPublicUrl(req, config)).origin)) {
    return providers;
  }
  return providers.filter(provider => provider !== 'keycloak');
}

export function sessionCookieOptions() {
  return { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/', maxAge: SESSION_TTL_MS / 1000 };
}

export async function authenticate(db: Db, req: FastifyRequest): Promise<AuthUser | null> {
  return findSessionUser(db, req.cookies[SESSION_COOKIE]);
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** GET routes that give out machine data: a cross-site request is refused even though GET is safe (Sec-Fetch-Site, Origin). */
const FETCH_GUARDED_GETS = new Set(['/api/runners/:runnerId/directories', '/api/runners/:runnerId/fs/list', '/api/runners/:runnerId/fs/file', '/api/runners/:runnerId/fs/download']);

/**
 * Requirement: Защита браузерных запросов — paths called without a browser (installer, agent) and authenticated by an
 * enrollment code or a runner token; every other mutating request needs the hub's Origin.
 */
export function originExempt(path: string): boolean {
  return path === '/enroll' || path.startsWith('/agent-api/') || path.startsWith('/voice-llm/');
}

/**
 * Requirement: Закрыто по умолчанию — the route patterns open without a browser session. Everything else needs one
 * (401 `unauthenticated`). Files of the web build (a route without parameters whose last segment has an extension,
 * and `/`) are the UI statics, `manifest.webmanifest` and the service worker.
 */
export const PUBLIC_ROUTES = new Set([
  '/auth/login',
  '/auth/callback',
  '/auth/logout',
  '/auth/disabled',
  '/auth/provider-logout',
  '/auth/dev-login',
  '/auth/desktop/start',
  '/auth/desktop/callback',
  '/auth/desktop/exchange',
  '/invite/:code',
  '/healthz',
  '/install.sh',
  '/install.ps1',
  '/agent/latest.json',
  '/agent/:file',
  '/enroll',
  // token checked by the handler (METRICS_TOKEN, runner token)
  '/metrics',
  '/agent-api/restore/:token',
  '/agent-api/blobs/:token',
  // mcp-management M8: the handler checks the browser session itself (redirect to the login and back, not JSON 401)
  '/mcp/oauth/callback',
  // voice-conversation D1: called by ElevenLabs, the handler checks the Bearer key and the conversation token
  '/voice-llm/v1/chat/completions',
]);

export function isPublicRoute(route: string): boolean {
  if (PUBLIC_ROUTES.has(route)) return true;
  if (route === '/api' || route.startsWith('/api/')) return false;
  if (route === '/') return true;
  const last = route.split('/').pop() ?? '';
  return !/[:*]/.test(route) && /\.[A-Za-z0-9]+$/.test(last);
}

/** Route pattern of the matched route, or the percent-decoded path when no route matched. */
export function routePath(req: FastifyRequest): string {
  const route = req.routeOptions.url;
  if (route) return route;
  const raw = req.url.split('?')[0]!;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function registerAuth(
  app: FastifyInstance,
  deps: {
    config: Config;
    db: Db;
    oidc: OidcProviders;
    limits: HubLimits;
    /** A browser session ended: close its sockets (4401). */
    onSessionEnded?: (sessionHash: Buffer) => void;
    /** Tests: the language of a request without a header, a profile language or Accept-Language (default en). */
    defaultLocale?: Locale;
  },
): void {
  const { config, db, oidc, limits } = deps;
  /** idtoken-at-rest-denied-logout D1: the key of the id tokens kept by the hub (SUBSCRIPTION_TOKEN_KEY). */
  const idKey = idTokenKey(config.SUBSCRIPTION_TOKEN_KEY);
  /** Deletes the browser session and closes its live sockets. */
  const endSession = async (token: string | undefined): Promise<string | null> => {
    if (!token) return null;
    const idToken = await deleteSession(db, token, idKey);
    deps.onSessionEnded?.(hashSecret(token));
    return idToken;
  };
  const security = (req: FastifyRequest, e: Parameters<typeof logSecurity>[1]) =>
    logSecurity(db, { ip: req.ip, userAgent: req.headers['user-agent'] ?? null, ...e }).catch((err: unknown) => req.log.warn({ err }, 'security log write failed'));

  app.decorateRequest('user', null);
  app.decorateRequest('locale', DEFAULT_LOCALE);
  const localeOf = (req: FastifyRequest) => requestLocale(req.headers['x-agent-hub-locale'], req.user?.locale, req.headers['accept-language'], deps.defaultLocale);

  // Guard. Decisions use the matched route (or the percent-decoded path for unmatched URLs), never the raw
  // URL: "/%61pi/me" reaches the /api/me handler and must be treated as /api.
  app.addHook('onRequest', async (req, reply) => {
    req.locale = localeOf(req);
    const path = routePath(req);
    if (MUTATING.has(req.method) && !originExempt(path) && !isAllowedOrigin(req.headers.origin, config.publicOrigins)) {
      return reply.code(403).send({ error: 'forbidden_origin' });
    }
    if (
      req.method === 'GET' &&
      FETCH_GUARDED_GETS.has(path) &&
      ((req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin') ||
        (req.headers.origin !== undefined && !isAllowedOrigin(req.headers.origin, config.publicOrigins)))
    ) {
      return reply.code(403).send({ error: 'forbidden_origin' });
    }
    const matched = Boolean(req.routeOptions.url);
    const isApi = path === '/api' || path.startsWith('/api/');
    // An unmatched non-API path goes to the SPA fallback (index.html) or a 404 — no data either way.
    if ((matched && !isPublicRoute(path)) || (!matched && isApi)) {
      req.user = await authenticate(db, req);
      if (!req.user) return reply.code(401).send({ error: 'unauthenticated' });
      req.locale = localeOf(req);
    }
  });

  const html = (reply: FastifyReply, code: number, body: string) => reply.code(code).type('text/html; charset=utf-8').send(body);
  const tooMany = (req: FastifyRequest, reply: FastifyReply) => html(reply, 429, loginErrorPage(req.locale, tr(req.locale).text('hub.auth.tooManyAttempts')));

  app.get('/auth/login', async (req, reply) => {
    if (!limits.loginStart.hit(req.ip)) {
      req.log.warn({ ip: req.ip }, 'rate limit: login start');
      return tooMany(req, reply);
    }
    const q = req.query as LoginQuery;
    if (config.singleProvider) return singleLogin(req, reply, q);
    const providers = providersFor(req, config, oidc);
    const prompt = q.prompt === 'select_account' ? 'select_account' : undefined;
    let provider: TwoProvider | null = q.provider === 'google' || q.provider === 'keycloak' ? q.provider : null;
    let invite: string | undefined;
    if (typeof q.invite === 'string' && q.invite) {
      const row = await findInvite(db, q.invite);
      // A usable invite decides the provider; a stale one is explained before the provider is visited.
      if (!row) return html(reply, 404, inviteInvalidPage(req.locale));
      const st = inviteStatus(row);
      if (st === 'expired') return html(reply, 410, inviteExpiredPage(req.locale));
      if (st !== 'active') return html(reply, 410, inviteInvalidPage(req.locale));
      // An invite without a provider (issued in single-provider mode) leaves the choice to the person.
      if (row.provider === 'google' || row.provider === 'keycloak') provider = row.provider;
      invite = q.invite;
    }
    if (provider === 'keycloak' && oidc.keycloak && !providers.includes('keycloak')) {
      return reply.redirect(`${config.keycloakOrigins[0]}${req.url}`, 302);
    }
    if (provider && !providers.includes(provider)) provider = null;
    if (!provider) {
      const keep = new URLSearchParams();
      if (typeof q.return === 'string') keep.set('return', q.return);
      if (prompt) keep.set('prompt', prompt);
      return html(reply, 200, chooseProviderPage(req.locale, providers, keep.toString()));
    }
    const client = provider === 'keycloak' ? oidc.keycloak! : oidc.google;
    const base = requestPublicUrl(req, config);
    let started;
    try {
      started = await client.start({ redirectUri: `${base}/auth/callback`, ...(prompt ? { prompt } : {}) });
    } catch (err) {
      req.log.error({ err, provider }, 'oidc discovery failed');
      return html(reply, 502, loginErrorPage(req.locale, tr(req.locale).text('hub.auth.providerDown', { provider: providerLabel(provider) })));
    }
    const cookie: OidcCookie = { ...started.checks, r: safeReturnPath(q.return, base), p: provider, ...(invite ? { i: invite } : {}) };
    return toProvider(reply, cookie, started.url);
  });

  const toProvider = (reply: FastifyReply, cookie: OidcCookie, url: string) => {
    reply.setCookie(OIDC_COOKIE, JSON.stringify(cookie), {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/auth',
      maxAge: OIDC_COOKIE_TTL_S,
      signed: true,
    });
    return reply.redirect(url, 302);
  };

  /**
   * keycloak-auth D5: /auth/login of the single provider. An address without hints goes to the provider at once; with hints
   * and without `provider=oidc` or `hint` — the login page. `?hint=` becomes kc_idp_hint, a hint unknown on this address is
   * 400. An invite link is checked before the provider is visited; admission itself goes by address (D6).
   */
  async function singleLogin(req: FastifyRequest, reply: FastifyReply, q: LoginQuery) {
    // «Войти под другим аккаунтом»: the provider asks for the login again (Keycloak has no account chooser).
    const prompt = q.prompt === 'select_account' ? 'login' : undefined;
    let invite: string | undefined;
    if (typeof q.invite === 'string' && q.invite) {
      const row = await findInvite(db, q.invite);
      if (!row) return html(reply, 404, inviteInvalidPage(req.locale));
      const st = inviteStatus(row);
      if (st === 'expired') return html(reply, 410, inviteExpiredPage(req.locale));
      if (st !== 'active') return html(reply, 410, inviteInvalidPage(req.locale));
      invite = q.invite;
    }
    const hints = hintsFor(req, config);
    let hint: IdpHint | undefined;
    if (q.hint !== undefined) {
      hint = hints.find(h => h.id === q.hint);
      if (!hint) return html(reply, 400, loginErrorPage(req.locale, tr(req.locale).text('hub.auth.unknownHint')));
    }
    if (!hint && q.provider !== 'oidc' && hints.length > 0) {
      const keep: Record<string, string> = {};
      if (typeof q.return === 'string') keep.return = q.return;
      if (prompt) keep.prompt = 'select_account';
      if (invite) keep.invite = invite;
      const href = (extra: Record<string, string>) => `/auth/login?${new URLSearchParams({ ...extra, ...keep }).toString()}`;
      const choices = hints.map(h => ({ label: h.label, href: href({ hint: h.id }) }));
      return html(reply, 200, signInPage(req.locale, href({ provider: 'oidc' }), config.OIDC_PROVIDER_LABEL ?? null, choices));
    }
    const base = requestPublicUrl(req, config);
    let started;
    try {
      started = await oidc.google.start({
        redirectUri: `${base}/auth/callback`,
        uiLocales: req.locale,
        ...(prompt ? { prompt } : {}),
        ...(hint ? { idpHint: hint.id } : {}),
      });
    } catch (err) {
      req.log.error({ err, provider: 'oidc' }, 'oidc discovery failed');
      return html(reply, 502, loginErrorPage(req.locale, tr(req.locale).text('hub.auth.providerDown', { provider: singleProviderLabel(config) })));
    }
    const cookie: OidcCookie = { ...started.checks, r: safeReturnPath(q.return, base), p: 'oidc', ...(invite ? { i: invite } : {}) };
    return toProvider(reply, cookie, started.url);
  }

  /** keycloak-auth D6, D7: the callback of the single provider; the id_token is kept with the session for the logout. */
  async function singleCallback(req: FastifyRequest, reply: FastifyReply, q: { error?: string }, checks: OidcCookie) {
    const label = singleProviderLabel(config);
    // A login started before the switch to the single provider.
    if (checks.p !== 'oidc') return html(reply, 400, loginErrorPage(req.locale, tr(req.locale).text('hub.auth.linkExpired')));
    if (q.error) return html(reply, 400, loginErrorPage(req.locale, tr(req.locale).text('hub.auth.providerError', { provider: label, error: String(q.error) })));
    const base = requestPublicUrl(req, config);
    let identity;
    try {
      identity = await oidc.google.finish(new URL(req.url, base), checks);
    } catch (err) {
      req.log.warn({ err: (err as Error).message, provider: 'oidc' }, 'oidc code exchange failed');
      return html(reply, 400, loginErrorPage(req.locale, tr(req.locale).text('hub.auth.notConfirmed', { provider: label })));
    }
    const a = await admitSingle(db, identity, config.SIGNUP_MODE);
    if (!a.ok) {
      await endSession(req.cookies[SESSION_COOKIE]);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      req.log.warn({ email: identity.email, emailVerified: identity.emailVerified, provider: 'oidc', reason: a.reason }, 'login denied');
      void security(req, { userId: null, kind: 'login_denied', provider: 'oidc', email: identity.email });
      rememberDeniedLogin(reply, idKey, identity.idToken);
      // multi-user D6, scenario «Вход под другим адресом»: the login came from an invite link issued to another address
      const invited = a.reason === 'not_invited' && checks.i ? await findInvite(db, checks.i) : null;
      if (invited && inviteStatus(invited) === 'active' && invited.email.toLowerCase() !== identity.email?.toLowerCase())
        return html(reply, 403, singleInviteMismatchPage(req.locale, invited.email, label, identity.email));
      const page = singleDeniedPage(req.locale, a.reason, identity.email);
      return html(reply, page.code, page.body);
    }
    await endSession(req.cookies[SESSION_COOKIE]);
    const token = await createSession(db, a.user.id, req.headers['user-agent'], new Date(), identity.idToken, idKey);
    reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions());
    // a refusal of another account in this browser must not lend its id_token to a later provider logout
    if (req.cookies[DENIED_COOKIE]) reply.clearCookie(DENIED_COOKIE, { path: '/auth' });
    req.log.info({ userId: a.user.id, provider: 'oidc', created: a.created, migrated: a.migrated }, 'login ok');
    if (a.signup) void security(req, { userId: a.user.id, kind: 'signup', provider: 'oidc', email: a.user.email });
    void security(req, { userId: a.user.id, kind: 'login', provider: 'oidc' });
    return reply.redirect(a.created ? '/' : safeReturnPath(checks.r, base), 302);
  }

  app.get('/auth/callback', async (req, reply) => {
    const q = req.query as { state?: string; code?: string; error?: string };
    const raw = req.cookies[OIDC_COOKIE];
    const unsigned = raw ? req.unsignCookie(raw) : null;
    reply.clearCookie(OIDC_COOKIE, { path: '/auth' });
    let checks: OidcCookie | null = null;
    if (unsigned?.valid && unsigned.value) {
      try {
        checks = JSON.parse(unsigned.value) as OidcCookie;
      } catch {
        checks = null;
      }
    }

    // Scenario «Подмена state»: 400, no session.
    if (!checks || !q.state || q.state !== checks.state) {
      req.log.warn('oidc callback rejected: state mismatch or missing login cookie');
      return html(reply, 400, loginErrorPage(req.locale, tr(req.locale).text('hub.auth.linkExpired')));
    }
    if (config.singleProvider) return singleCallback(req, reply, q, checks);
    // A login started by the single-provider hub before a rollback to two providers.
    if (checks.p === 'oidc') return html(reply, 400, loginErrorPage(req.locale, tr(req.locale).text('hub.auth.linkExpired')));
    const provider: TwoProvider = checks.p === 'keycloak' ? 'keycloak' : 'google';
    const client = provider === 'keycloak' ? oidc.keycloak : oidc.google;
    if (!client) return html(reply, 400, loginErrorPage(req.locale, tr(req.locale).text('hub.auth.methodOff')));
    if (q.error) return html(reply, 400, loginErrorPage(req.locale, tr(req.locale).text('hub.auth.providerError', { provider: providerLabel(provider), error: String(q.error) })));

    const base = requestPublicUrl(req, config);
    let identity;
    try {
      identity = await client.finish(new URL(req.url, base), checks);
    } catch (err) {
      req.log.warn({ err: (err as Error).message, provider }, 'oidc code exchange failed');
      return html(reply, 400, loginErrorPage(req.locale, tr(req.locale).text('hub.auth.notConfirmed', { provider: providerLabel(provider) })));
    }

    const a = await admit(db, provider, identity, checks.i ?? null);
    if (!a.ok) {
      // Scenario «Вход без приглашения»: no session, and an existing one in this browser is dropped too.
      await endSession(req.cookies[SESSION_COOKIE]);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      req.log.warn({ email: identity.email, emailVerified: identity.emailVerified, provider, reason: a.reason }, 'login denied');
      void security(req, { userId: null, kind: 'login_denied', provider, email: identity.email });
      return deniedPage(reply, req.locale, a, identity.email, checks.i ?? null);
    }

    await endSession(req.cookies[SESSION_COOKIE]);
    const token = await createSession(db, a.user.id, req.headers['user-agent']);
    reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions());
    req.log.info({ userId: a.user.id, provider, created: a.created }, 'login ok');
    void security(req, { userId: a.user.id, kind: 'login', provider });
    // A new user starts at the welcome screen.
    return reply.redirect(a.created ? '/' : safeReturnPath(checks.r, base), 302);
  });

  /** The page of a refused login (browser and desktop app). */
  function deniedPage(reply: FastifyReply, locale: Locale, a: Extract<Admission, { ok: false }>, email: string | null, invite: string | null) {
    switch (a.reason) {
      case 'disabled':
        return html(reply, 403, disabledPage(locale));
      case 'mismatch':
      case 'wrong_provider':
        return html(reply, 403, inviteMismatchPage(locale, a.invite!.email, a.invite!.provider, invite, email));
      case 'expired':
        return html(reply, 410, inviteExpiredPage(locale));
      case 'used':
      case 'revoked':
        return html(reply, 410, inviteInvalidPage(locale));
      default:
        return html(reply, 403, inviteOnlyPage(locale, email));
    }
  }
  app.decorate('deniedLoginPage', deniedPage);

  // Requirement: Приглашение — the page of the link (no login needed), rate-limited.
  app.get('/invite/:code', async (req, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    if (!limits.invitePage.hit(req.ip)) {
      req.log.warn({ ip: req.ip }, 'rate limit: invite page');
      return html(reply, 429, loginErrorPage(req.locale, tr(req.locale).text('hub.auth.tooManyRequests')));
    }
    const code = (req.params as { code: string }).code;
    const row = await findInvite(db, code);
    if (!row) return html(reply, 404, inviteInvalidPage(req.locale));
    const st = inviteStatus(row);
    if (st === 'expired') return html(reply, 410, inviteExpiredPage(req.locale));
    if (st !== 'active') return html(reply, 410, inviteInvalidPage(req.locale));
    // keycloak-auth D6: in single-provider mode an invite is bound to the address only.
    if (config.singleProvider) return html(reply, 200, invitePage(req.locale, row.email, null, code));
    if (row.provider === 'keycloak' && oidc.keycloak && !providersFor(req, config, oidc).includes('keycloak')) {
      return reply.redirect(`${config.keycloakOrigins[0]}${req.url}`, 302);
    }
    return html(reply, 200, invitePage(req.locale, row.email, row.provider === 'keycloak' ? 'keycloak' : 'google', code));
  });

  // Scenario «Отключение коллеги»: windows closed with 4403 come here.
  app.get('/auth/disabled', async (req, reply) => html(reply, 200, disabledPage(req.locale, config.singleProvider ? PROVIDER_LOGOUT_HREF : undefined)));

  // idtoken-at-rest-denied-logout D3: «Войти другим аккаунтом» of a refusal page ends the session of the single provider
  // (its end_session_endpoint, back to the root of this address; upstream Google/Corp sessions stay). The id_token_hint
  // comes from the cookie of a refused login in this browser; without it the provider asks to confirm the logout.
  app.get('/auth/provider-logout', async (req, reply) => {
    // the same budget as the login start: both reach the provider's discovery
    if (!limits.loginStart.hit(req.ip)) {
      req.log.warn({ ip: req.ip }, 'rate limit: provider logout');
      return tooMany(req, reply);
    }
    const raw = req.cookies[DENIED_COOKIE];
    const unsigned = raw ? req.unsignCookie(raw) : null;
    reply.clearCookie(DENIED_COOKIE, { path: '/auth' });
    reply.header('Cache-Control', 'no-store');
    if (!config.singleProvider) return reply.redirect(SWITCH_ACCOUNT_HREF, 302);
    const idToken = unsigned?.valid && unsigned.value && idKey ? openDeniedIdToken(idKey, unsigned.value) : null;
    const url = await oidc.google.endSessionUrl({ idToken, postLogoutRedirectUri: `${requestPublicUrl(req, config)}/` });
    return reply.redirect(url ?? SWITCH_ACCOUNT_HREF, 302);
  });

  // keycloak-auth D7: the browser goes on to the end_session_endpoint of the single provider (its session ends, the upstream
  // Google/Corp sessions stay); without one, or with two providers — to the root.
  app.post('/auth/logout', async (req, reply): Promise<LogoutResponse> => {
    const idToken = await endSession(req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    let redirect = '/';
    if (config.singleProvider) {
      const url = await oidc.google.endSessionUrl({ idToken, postLogoutRedirectUri: `${requestPublicUrl(req, config)}/` });
      if (url) redirect = url;
    }
    return { redirect };
  });

  // Requirement: Журнал безопасности и выход везде — every other browser session of the user.
  app.post('/api/auth/logout-all', async (req): Promise<LogoutAllResponse> => {
    const current = await findSession(db, req.cookies[SESSION_COOKIE]);
    const ended = await deleteUserSessions(db, req.user!.id, current?.idHash);
    for (const h of ended) deps.onSessionEnded?.(h);
    void security(req, { userId: req.user!.id, kind: 'logout_all' });
    return { ended: ended.length };
  });

  if (config.AUTH_DEV_EMAIL) {
    // e2e only: loadConfig() refuses AUTH_DEV_EMAIL outside NODE_ENV=test and on the production host.
    const devEmail = config.AUTH_DEV_EMAIL;
    app.get('/auth/dev-login', async (req: FastifyRequest, reply: FastifyReply) => {
      const user = await upsertUser(db, devEmail);
      reply.setCookie(SESSION_COOKIE, await createSession(db, user.id, req.headers['user-agent']), sessionCookieOptions());
      return reply.redirect(safeReturnPath((req.query as { return?: string }).return, config.PUBLIC_URL), 302);
    });
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    /** The page of a refused login (registerAuth); the desktop login uses the same pages. */
    deniedLoginPage(reply: FastifyReply, locale: Locale, a: Extract<Admission, { ok: false }>, email: string | null, invite: string | null): FastifyReply;
  }
}
