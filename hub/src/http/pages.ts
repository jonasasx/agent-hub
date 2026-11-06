// Server-rendered pages shown outside the SPA: access denied and login errors.
// Colors and fonts follow docs/prototype.html (dark theme tokens).
// Change i18n D5: every page is rendered in the language of the request (`hub.page.*`), `<html lang>` follows it.
import type { Locale } from '@agent-hub/shared';
import { tr } from '../i18n.js';

type Tx = ReturnType<typeof tr>;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function page(locale: Locale, title: string, body: string, head = ''): string {
  return `<!doctype html>
<html lang="${locale}" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Agent Hub</title>
${head}<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Onest:wght@400;500;600;700&display=swap">
<style>
  :root { --bg:#12151a; --surface:#1b1f27; --raised:#242a35; --line-strong:#3a4252; --fg:#e4e8ef; --muted:#8d96a7;
    --accent:#f2b544; --accent-fg:#1a1406; color-scheme: dark; }
  @media (prefers-color-scheme: light) { :root { --bg:#f3f4f6; --surface:#fff; --raised:#e8ebf0; --line-strong:#c7cdd8;
    --fg:#1b1f27; --muted:#5d6676; --accent:#b97806; --accent-fg:#fff; color-scheme: light; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:16px; background:var(--bg); color:var(--fg);
    font: 14px/1.5 "Onest","Segoe UI",system-ui,sans-serif; }
  .card { width:420px; max-width:100%; background:var(--surface); border:1px solid var(--line-strong); border-radius:14px; padding:24px; }
  .brand { display:flex; align-items:center; gap:8px; font-weight:700; margin-bottom:16px; }
  .mark { width:22px; height:22px; border-radius:6px; background:var(--accent); color:var(--accent-fg); display:grid; place-items:center;
    font: 600 12px "JetBrains Mono", ui-monospace, Consolas, monospace; }
  h1 { font-size:18px; margin:0 0 8px; }
  p { color:var(--muted); margin:0 0 16px; overflow-wrap:anywhere; }
  b { color:var(--fg); font-weight:600; }
  .btn { display:inline-flex; border:1px solid var(--accent); background:var(--accent); color:var(--accent-fg); border-radius:8px;
    padding:7px 14px; font-weight:500; text-decoration:none; }
  .btn:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
</style>
</head>
<body><main class="card"><div class="brand"><span class="mark">ah</span>Agent Hub</div>${body}</main></body>
</html>`;
}

/** The «Signed in as <email>.» lead of a page, with a space after it; none without an address. */
function signedInAs(t: Tx, email: string | null): string {
  return email ? `${t.text('hub.page.signedInAs', { email: esc(email) })} ` : '';
}

/** Requirement: Вход через Google OIDC — scenario «Вход чужим аккаунтом отклоняется». */
export function forbiddenPage(locale: Locale, email: string | null): string {
  const t = tr(locale);
  return page(
    locale,
    t.text('hub.page.forbidden.title'),
    `<h1>${esc(t.text('hub.page.forbidden.title'))}</h1><p>${signedInAs(t, email)}${esc(t.text('hub.page.forbidden.text'))}</p>
<a class="btn" href="/auth/login?prompt=select_account">${esc(t.text('hub.page.signInAnother'))}</a>`,
  );
}

export function loginErrorPage(locale: Locale, message: string): string {
  const t = tr(locale);
  return page(
    locale,
    t.text('hub.page.loginError.title'),
    `<h1>${esc(t.text('hub.page.loginError.h1'))}</h1><p>${esc(message)}</p><a class="btn" href="/auth/login">${esc(t.text('hub.page.tryAgain'))}</a>`,
  );
}

/** Requirement: Старт входа приложения — 400 on a bad /auth/desktop/start link. */
export function desktopBadLinkPage(locale: Locale): string {
  const t = tr(locale);
  return page(locale, t.text('hub.page.desktopBadLink.title'), `<h1>${esc(t.text('hub.page.desktopBadLink.title'))}</h1><p>${esc(t.text('hub.page.desktopBadLink.text'))}</p>`);
}

/**
 * Requirement: Одноразовый код входа — hands the code back to the desktop app: meta refresh to `agenthub://auth?…`
 * and a button with the same link. No inline script (CSP script-src 'self' stays as is).
 */
export function desktopReturnPage(locale: Locale, link: string): string {
  const t = tr(locale);
  const href = esc(link);
  return page(
    locale,
    t.text('hub.page.signedIn'),
    `<h1>${esc(t.text('hub.page.signedIn'))}</h1><p>${esc(t.text('hub.page.desktopReturn.text'))}</p>
<a class="btn" href="${href}">${esc(t.text('hub.page.openHub'))}</a>`,
    `<meta http-equiv="refresh" content="0;url=${href}">
<meta name="referrer" content="no-referrer">
`,
  );
}

// ---------- multi-user (spec users: «Вход по приглашению», «Отключение пользователя») ----------

export type ProviderId = 'google' | 'keycloak';

let keycloakLabel = 'Keycloak';
/** The name of the second provider on the pages (OIDC_KEYCLOAK_LABEL); set once by buildHub. */
export function setKeycloakLabel(label: string): void {
  keycloakLabel = label;
}

/** The name of a provider: OIDC_KEYCLOAK_LABEL for Keycloak. */
export function providerLabel(p: ProviderId): string {
  return p === 'keycloak' ? keycloakLabel : 'Google';
}

function loginButton(t: Tx, p: ProviderId, extra = ''): string {
  return `<a class="btn" href="${esc(`/auth/login?provider=${p}${extra}`)}">${esc(t.text('hub.page.signInWith', { provider: providerLabel(p) }))}</a>`;
}

/** /auth/login without a provider when both are configured: «страница входа и выбора провайдера». */
export function chooseProviderPage(locale: Locale, providers: ProviderId[], returnQuery: string): string {
  const t = tr(locale);
  const q = returnQuery ? `&${returnQuery}` : '';
  return page(
    locale,
    t.text('hub.page.choose.title'),
    `<h1>${esc(t.text('hub.page.choose.h1'))}</h1><p>${esc(t.text('hub.page.choose.text'))}</p>
<p>${providers.map(p => loginButton(t, p, q)).join(' ')}</p>`,
  );
}

/** /invite/<код> of a valid invite: the provider of the invite only. */
export function invitePage(locale: Locale, email: string, provider: ProviderId, code: string): string {
  const t = tr(locale);
  return page(
    locale,
    t.text('hub.page.invite.title'),
    `<h1>${esc(t.text('hub.page.invite.h1'))}</h1><p>${t.text('hub.page.invite.text', { email: esc(email), provider: esc(providerLabel(provider)) })}</p>
${loginButton(t, provider, `&invite=${encodeURIComponent(code)}`)}`,
  );
}

/** Scenario «Истёкшее приглашение»: no login button. */
export function inviteExpiredPage(locale: Locale): string {
  const t = tr(locale);
  return page(locale, t.text('hub.page.inviteExpired.title'), `<h1>${esc(t.text('hub.page.inviteExpired.title'))}</h1><p>${esc(t.text('hub.page.inviteExpired.text'))}</p>`);
}

/** A used, revoked or unknown invite code. */
export function inviteInvalidPage(locale: Locale): string {
  const t = tr(locale);
  return page(locale, t.text('hub.page.inviteInvalid.title'), `<h1>${esc(t.text('hub.page.inviteInvalid.title'))}</h1><p>${esc(t.text('hub.page.inviteInvalid.text'))}</p>`);
}

/** Scenario «Вход под другим адресом»: the invite stays valid, the user can log in again with the right account. */
export function inviteMismatchPage(locale: Locale, invitedEmail: string, provider: ProviderId, code: string | null, actual: string | null): string {
  const t = tr(locale);
  const again = code ? loginButton(t, provider, `&invite=${encodeURIComponent(code)}&prompt=select_account`) : '';
  const text = t.text('hub.page.inviteMismatch.text', { provider: esc(providerLabel(provider)), email: esc(invitedEmail) });
  return page(locale, t.text('hub.page.inviteMismatch.title'), `<h1>${t.text('hub.page.inviteMismatch.h1', { email: esc(invitedEmail) })}</h1><p>${signedInAs(t, actual)}${text}</p>${again}`);
}

/** Scenario «Вход без приглашения» (also an unverified address). */
export function inviteOnlyPage(locale: Locale, email: string | null): string {
  const t = tr(locale);
  return page(
    locale,
    t.text('hub.page.inviteOnly.title'),
    `<h1>${esc(t.text('hub.page.inviteOnly.title'))}</h1><p>${signedInAs(t, email)}${esc(t.text('hub.page.inviteOnly.text'))}</p>
<a class="btn" href="/auth/login?prompt=select_account">${esc(t.text('hub.page.signInAnother'))}</a>`,
  );
}

/** Scenario «Отключение коллеги»: login of a disabled user, and the page /auth/disabled the windows go to (ws 4403). */
export function disabledPage(locale: Locale): string {
  const t = tr(locale);
  return page(locale, t.text('hub.page.disabled.title'), `<h1>${esc(t.text('hub.page.disabled.title'))}</h1><p>${esc(t.text('hub.page.disabled.text'))}</p>`);
}

/** /auth/desktop/start without a provider when both are configured. */
export function desktopChooseProviderPage(locale: Locale, providers: ProviderId[], href: (p: ProviderId) => string): string {
  const t = tr(locale);
  return page(
    locale,
    t.text('hub.page.desktopChoose.title'),
    `<h1>${esc(t.text('hub.page.desktopChoose.h1'))}</h1><p>${esc(t.text('hub.page.desktopChoose.text'))}</p>
<p>${providers.map(p => `<a class="btn" href="${esc(href(p))}">${esc(t.text('hub.page.signInWith', { provider: providerLabel(p) }))}</a>`).join(' ')}</p>`,
  );
}

// ---------- MCP sign-in (mcp-management M8) ----------

/** The browser came back from the provider and the server connected: a link (and a refresh) into the session. */
export function mcpSignedInPage(locale: Locale, server: string, sessionHref: string): string {
  const t = tr(locale);
  const href = esc(sessionHref);
  return page(
    locale,
    t.text('hub.page.signedIn'),
    `<h1>${esc(t.text('hub.page.signedIn'))}</h1><p>${t.text('hub.page.mcpSignedIn.text', { server: esc(server) })}</p><a class="btn" href="${href}">${esc(t.text('hub.page.toSession'))}</a>`,
    `<meta http-equiv="refresh" content="2;url=${href}">\n`,
  );
}

/** The provider refused or the server did not connect: the reason, the way back to the session. */
export function mcpSignInFailedPage(locale: Locale, reason: string, sessionHref: string | null): string {
  const t = tr(locale);
  const back = sessionHref ? `<a class="btn" href="${esc(sessionHref)}">${esc(t.text('hub.page.toSession'))}</a>` : '';
  return page(locale, t.text('hub.page.mcpFailed.title'), `<h1>${t.text('hub.page.mcpFailed.h1', { reason: esc(reason) })}</h1><p>${esc(t.text('hub.page.mcpFailed.text'))}</p>${back}`);
}

/** The same callback is being passed to the process: the page reloads itself until the result is known. */
export function mcpSignInWaitingPage(locale: Locale, server: string): string {
  const t = tr(locale);
  return page(
    locale,
    t.text('hub.page.mcpWaiting.title'),
    `<h1>${esc(t.text('hub.page.mcpWaiting.title'))}</h1><p>${t.text('hub.page.mcpWaiting.text', { server: esc(server) })}</p>`,
    `<meta http-equiv="refresh" content="3">
`,
  );
}

/** Unknown, expired or another user's `state`: nothing is passed to the machine. */
export function mcpFlowNotFoundPage(locale: Locale): string {
  const t = tr(locale);
  return page(
    locale,
    t.text('hub.page.mcpFlowNotFound.title'),
    `<h1>${esc(t.text('hub.page.mcpFlowNotFound.title'))}</h1><p>${esc(t.text('hub.page.mcpFlowNotFound.text'))}</p><a class="btn" href="/">${esc(t.text('hub.page.openHub'))}</a>`,
  );
}
