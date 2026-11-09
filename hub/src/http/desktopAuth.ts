// Login of the desktop app through the system browser (change desktop-app, capability desktop-auth, design.md D9, D10).
// /auth/login, /auth/callback and /auth/logout (auth.ts) are untouched; every new route is under /auth/desktop/.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { desktopExchangeRequestSchema, type DesktopExchangeResponse, type Locale } from '@agent-hub/shared';
import { tr } from '../i18n.js';
import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import type { LoginProvider } from '@agent-hub/shared';
import type { OidcChecks } from '../auth/oidc.js';
import { SESSION_COOKIE, SESSION_TTL_MS, createSession, findSessionUser } from '../auth/sessions.js';
import { DesktopCodeStore } from '../auth/desktopCodes.js';
import { desktopBadLinkPage, desktopChooseProviderPage, desktopReturnPage, loginErrorPage, providerLabel, signInPage } from './pages.js';
import { hintsFor, providersFor, rememberDeniedLogin, requestPublicUrl, singleDeniedPage, singleProviderLabel, type OidcProviders } from './auth.js';
import { idTokenKey } from '../auth/idToken.js';
import { admit, admitSingle, logSecurity, type TwoProvider } from '../users/repo.js';
import type { HubLimits } from './limits.js';

export const DESKTOP_COOKIE = 'ah_desktop';
const DESKTOP_COOKIE_PATH = '/auth/desktop';
const DESKTOP_COOKIE_TTL_S = 600;

const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const STATE_RE = /^[A-Za-z0-9_-]{22,128}$/;

interface DesktopCookie extends OidcChecks {
  /** code_challenge of the app. */
  cc: string;
  /** state of the app. */
  as: string;
  /** Provider of this login (multi-user M2); absent — Google. */
  p?: LoginProvider;
}

/** agenthub://auth?code=…&state=… — the link the return page hands to the app. */
export function desktopReturnLink(code: string, state: string): string {
  return `agenthub://auth?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
}

export function registerDesktopAuth(app: FastifyInstance, deps: { config: Config; db: Db; oidc: OidcProviders; limits: HubLimits; codes?: DesktopCodeStore }): DesktopCodeStore {
  const { config, db, oidc, limits } = deps;
  const codes = deps.codes ?? new DesktopCodeStore();
  const idKey = idTokenKey(config.SUBSCRIPTION_TOKEN_KEY);
  const redirectUri = (req: FastifyRequest) => `${requestPublicUrl(req, config)}/auth/desktop/callback`;
  /** The user of a code is still active (disabled between the browser step and the exchange → forbidden_account). */
  const active = async (userId: string) => Boolean(await db.selectFrom('users').select('id').where('id', '=', userId).where('status', '=', 'active').executeTakeFirst());
  const html = (reply: FastifyReply, code: number, body: string) => reply.code(code).type('text/html; charset=utf-8').send(body);

  // Requirement: Одноразовый код входа — the page that carries the code is never cached and leaks no Referer.
  // A route-level onSend runs after the app-wide one that sets `Referrer-Policy: same-origin` on HTML.
  const noStore = {
    onSend: async (_req: unknown, reply: FastifyReply, payload: unknown) => {
      reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
      return payload;
    },
  };
  const returnPage = (reply: FastifyReply, locale: Locale, userId: string, email: string, cc: string, state: string) => {
    const code = codes.issue({ userId, email, challenge: cc, state });
    return html(reply, 200, desktopReturnPage(locale, desktopReturnLink(code, state)));
  };

  // Requirement: Старт входа приложения.
  app.get('/auth/desktop/start', noStore, async (req, reply) => {
    const q = req.query as { code_challenge?: unknown; code_challenge_method?: unknown; state?: unknown; provider?: unknown; hint?: unknown };
    const cc = typeof q.code_challenge === 'string' ? q.code_challenge : '';
    const as = typeof q.state === 'string' ? q.state : '';
    if (!CHALLENGE_RE.test(cc) || q.code_challenge_method !== 'S256' || !STATE_RE.test(as)) {
      return html(reply, 400, desktopBadLinkPage(req.locale));
    }

    // Scenario «Браузер уже вошёл в хаб»: the code right away, no Google.
    // findSessionUser skips disabled users: an active session of an admitted user is enough.
    const user = await findSessionUser(db, req.cookies[SESSION_COOKIE]);
    if (user) return returnPage(reply, req.locale, user.id, user.email, cc, as);

    if (!limits.loginStart.hit(req.ip)) return html(reply, 429, loginErrorPage(req.locale, tr(req.locale).text('hub.auth.tooManyAttempts')));
    if (config.singleProvider) return singleStart(req, reply, cc, as, q);
    // Change multi-user: `provider`; without it — the choice, when Keycloak is configured.
    const providers = providersFor(req, config, oidc);
    let provider: TwoProvider | null = q.provider === 'google' || q.provider === 'keycloak' ? q.provider : null;
    if (provider && !providers.includes(provider)) provider = null;
    if (!provider) {
      if (providers.length > 1) {
        const link = (p: TwoProvider) => `/auth/desktop/start?${new URLSearchParams({ code_challenge: cc, code_challenge_method: 'S256', state: as, provider: p }).toString()}`;
        return html(reply, 200, desktopChooseProviderPage(req.locale, providers, link));
      }
      provider = 'google';
    }
    const client = provider === 'keycloak' ? oidc.keycloak! : oidc.google;
    let started;
    try {
      started = await client.start({ redirectUri: redirectUri(req) });
    } catch (err) {
      req.log.error({ err, provider }, 'oidc discovery failed');
      return html(reply, 502, loginErrorPage(req.locale, tr(req.locale).text('hub.auth.providerDown', { provider: providerLabel(provider) })));
    }
    return toProvider(reply, { ...started.checks, cc, as, p: provider }, started.url);
  });

  const toProvider = (reply: FastifyReply, cookie: DesktopCookie, url: string) => {
    reply.setCookie(DESKTOP_COOKIE, JSON.stringify(cookie), {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: DESKTOP_COOKIE_PATH,
      maxAge: DESKTOP_COOKIE_TTL_S,
      signed: true,
    });
    return reply.redirect(url, 302);
  };

  /** keycloak-auth D5: the desktop start of the single provider — the hints page or the provider with kc_idp_hint. */
  async function singleStart(req: FastifyRequest, reply: FastifyReply, cc: string, as: string, q: { provider?: unknown; hint?: unknown }) {
    const hints = hintsFor(req, config);
    const hint = q.hint === undefined ? undefined : hints.find(h => h.id === q.hint);
    if (q.hint !== undefined && !hint) return html(reply, 400, loginErrorPage(req.locale, tr(req.locale).text('hub.auth.unknownHint')));
    if (!hint && q.provider !== 'oidc' && hints.length > 0) {
      const link = (extra: Record<string, string>) => `/auth/desktop/start?${new URLSearchParams({ code_challenge: cc, code_challenge_method: 'S256', state: as, ...extra }).toString()}`;
      const choices = hints.map(h => ({ label: h.label, href: link({ hint: h.id }) }));
      return html(reply, 200, signInPage(req.locale, link({ provider: 'oidc' }), config.OIDC_PROVIDER_LABEL ?? null, choices));
    }
    let started;
    try {
      started = await oidc.google.start({ redirectUri: redirectUri(req), uiLocales: req.locale, ...(hint ? { idpHint: hint.id } : {}) });
    } catch (err) {
      req.log.error({ err, provider: 'oidc' }, 'oidc discovery failed');
      return html(reply, 502, loginErrorPage(req.locale, tr(req.locale).text('hub.auth.providerDown', { provider: singleProviderLabel(config) })));
    }
    return toProvider(reply, { ...started.checks, cc, as, p: 'oidc' }, started.url);
  }

  /**
   * keycloak-auth D6: the desktop callback of the single provider — the admission of the browser login. The desktop
   * session keeps no id_token: «Выйти» in the app ends only the hub session.
   */
  async function singleCallback(req: FastifyRequest, reply: FastifyReply, q: { error?: string }, checks: DesktopCookie) {
    const label = singleProviderLabel(config);
    if (checks.p !== 'oidc') return html(reply, 400, loginErrorPage(req.locale, tr(req.locale).text('hub.auth.linkExpiredApp')));
    if (q.error) return html(reply, 400, loginErrorPage(req.locale, tr(req.locale).text('hub.auth.providerError', { provider: label, error: String(q.error) })));
    let identity;
    try {
      identity = await oidc.google.finish(new URL(req.url, requestPublicUrl(req, config)), checks);
    } catch (err) {
      req.log.warn({ err: (err as Error).message, provider: 'oidc' }, 'desktop oidc code exchange failed');
      return html(reply, 400, loginErrorPage(req.locale, tr(req.locale).text('hub.auth.notConfirmedApp', { provider: label })));
    }
    const security = { ip: req.ip, userAgent: req.headers['user-agent'] ?? null, provider: 'oidc' as const };
    const a = await admitSingle(db, identity, config.SIGNUP_MODE);
    if (!a.ok) {
      req.log.warn({ email: identity.email, emailVerified: identity.emailVerified, provider: 'oidc', reason: a.reason }, 'desktop login denied');
      void logSecurity(db, { ...security, userId: null, kind: 'login_denied', email: identity.email }).catch(() => undefined);
      // idtoken-at-rest-denied-logout D3: the refusal page in the system browser ends the provider session too.
      rememberDeniedLogin(reply, idKey, identity.idToken);
      const page = singleDeniedPage(req.locale, a.reason, identity.email);
      return html(reply, page.code, page.body);
    }
    req.log.info({ userId: a.user.id, provider: 'oidc', migrated: a.migrated }, 'desktop login code issued');
    if (a.signup) void logSecurity(db, { ...security, userId: a.user.id, kind: 'signup', email: a.user.email }).catch(() => undefined);
    void logSecurity(db, { ...security, userId: a.user.id, kind: 'login' }).catch(() => undefined);
    return returnPage(reply, req.locale, a.user.id, a.user.email, checks.cc, checks.as);
  }

  // Requirement: Завершение входа Google для приложения — the checks of /auth/callback, no work with ah_session.
  app.get('/auth/desktop/callback', noStore, async (req, reply) => {
    const q = req.query as { state?: string; code?: string; error?: string };
    const raw = req.cookies[DESKTOP_COOKIE];
    const unsigned = raw ? req.unsignCookie(raw) : null;
    reply.clearCookie(DESKTOP_COOKIE, { path: DESKTOP_COOKIE_PATH });
    let checks: DesktopCookie | null = null;
    if (unsigned?.valid && unsigned.value) {
      try {
        const parsed = JSON.parse(unsigned.value) as Partial<DesktopCookie>;
        // The app's challenge and state are re-checked: a code is never issued without a valid challenge.
        checks = typeof parsed.cc === 'string' && CHALLENGE_RE.test(parsed.cc) && typeof parsed.as === 'string' && STATE_RE.test(parsed.as) ? (parsed as DesktopCookie) : null;
      } catch {
        checks = null;
      }
    }

    // Scenario «Подмена state».
    if (!checks || !q.state || q.state !== checks.state) {
      req.log.warn('desktop oidc callback rejected: state mismatch or missing login cookie');
      return html(reply, 400, loginErrorPage(req.locale, tr(req.locale).text('hub.auth.linkExpiredApp')));
    }
    if (config.singleProvider) return singleCallback(req, reply, q, checks);
    if (checks.p === 'oidc') return html(reply, 400, loginErrorPage(req.locale, tr(req.locale).text('hub.auth.methodOff')));
    const provider: TwoProvider = checks.p === 'keycloak' ? 'keycloak' : 'google';
    const client = provider === 'keycloak' ? oidc.keycloak : oidc.google;
    if (!client) return html(reply, 400, loginErrorPage(req.locale, tr(req.locale).text('hub.auth.methodOff')));
    if (q.error) return html(reply, 400, loginErrorPage(req.locale, tr(req.locale).text('hub.auth.providerError', { provider: providerLabel(provider), error: String(q.error) })));

    let identity;
    try {
      identity = await client.finish(new URL(req.url, requestPublicUrl(req, config)), checks);
    } catch (err) {
      req.log.warn({ err: (err as Error).message, provider }, 'desktop oidc code exchange failed');
      return html(reply, 400, loginErrorPage(req.locale, tr(req.locale).text('hub.auth.notConfirmedApp', { provider: providerLabel(provider) })));
    }

    // The admission of the browser login (users/repo.ts admit) without an invite: the app enters as an existing user
    // (an invite is accepted in the browser). Scenario «Чужой аккаунт»: 403, no code; the browser session stays.
    const security = { ip: req.ip, userAgent: req.headers['user-agent'] ?? null, provider };
    const a = await admit(db, provider, identity, null);
    if (!a.ok) {
      req.log.warn({ email: identity.email, emailVerified: identity.emailVerified, provider, reason: a.reason }, 'desktop login denied');
      void logSecurity(db, { ...security, userId: null, kind: 'login_denied', email: identity.email }).catch(() => undefined);
      return app.deniedLoginPage(reply, req.locale, a, identity.email, null);
    }
    req.log.info({ userId: a.user.id, provider }, 'desktop login code issued');
    void logSecurity(db, { ...security, userId: a.user.id, kind: 'login' }).catch(() => undefined);
    return returnPage(reply, req.locale, a.user.id, a.user.email, checks.cc, checks.as);
  });

  // Requirement: Обмен кода на сессию. Passes the common Origin guard (auth.ts) with no new exception (D10).
  app.post('/auth/desktop/exchange', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body = desktopExchangeRequestSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
    const grant = codes.redeem(body.data.code, body.data.codeVerifier, body.data.state);
    if (!grant) return reply.code(400).send({ error: 'invalid_grant' });
    if (!(await active(grant.userId))) return reply.code(403).send({ error: 'forbidden_account' });
    const now = new Date();
    const sessionToken = await createSession(db, grant.userId, req.headers['user-agent'], now);
    req.log.info({ userId: grant.userId }, 'desktop login ok');
    const res: DesktopExchangeResponse = { sessionToken, expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString() };
    return reply.code(200).send(res);
  });

  return codes;
}
