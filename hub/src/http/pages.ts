// Server-rendered pages shown outside the SPA: access denied and login errors.
// Colors and fonts follow docs/prototype.html (dark theme tokens).

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function page(title: string, body: string, head = ''): string {
  return `<!doctype html>
<html lang="ru" data-theme="dark">
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

/** Requirement: Вход через Google OIDC — scenario «Вход чужим аккаунтом отклоняется». */
export function forbiddenPage(email: string | null): string {
  const who = email ? `Вход выполнен под <b>${esc(email)}</b>. ` : '';
  return page(
    'Доступ запрещён',
    `<h1>Доступ запрещён</h1><p>${who}Этому аккаунту вход в Agent Hub не разрешён.</p>
<a class="btn" href="/auth/login?prompt=select_account">Войти другим аккаунтом</a>`,
  );
}

export function loginErrorPage(message: string): string {
  return page('Ошибка входа', `<h1>Не удалось войти</h1><p>${esc(message)}</p><a class="btn" href="/auth/login">Попробовать снова</a>`);
}

/** Requirement: Старт входа приложения — 400 on a bad /auth/desktop/start link. */
export function desktopBadLinkPage(): string {
  return page('Ссылка входа приложения неверна', `<h1>Ссылка входа приложения неверна</h1><p>Начните вход заново из приложения Agent Hub.</p>`);
}

/**
 * Requirement: Одноразовый код входа — hands the code back to the desktop app: meta refresh to `agenthub://auth?…`
 * and a button with the same link. No inline script (CSP script-src 'self' stays as is).
 */
export function desktopReturnPage(link: string): string {
  const href = esc(link);
  return page(
    'Вход выполнен',
    `<h1>Вход выполнен</h1><p>Вход выполнен. Вкладку можно закрыть.</p>
<a class="btn" href="${href}">Открыть Agent Hub</a>`,
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

/** Button text of a provider: «Войти через <OIDC_KEYCLOAK_LABEL>» for Keycloak. */
export function providerLabel(p: ProviderId): string {
  return p === 'keycloak' ? keycloakLabel : 'Google';
}

function loginButton(p: ProviderId, extra = ''): string {
  return `<a class="btn" href="${esc(`/auth/login?provider=${p}${extra}`)}">Войти через ${esc(providerLabel(p))}</a>`;
}

/** /auth/login without a provider when both are configured: «страница входа и выбора провайдера». */
export function chooseProviderPage(providers: ProviderId[], returnQuery: string): string {
  const q = returnQuery ? `&${returnQuery}` : '';
  return page(
    'Вход',
    `<h1>Вход в Agent Hub</h1><p>Вход только по приглашению. Выберите способ входа из приглашения.</p>
<p>${providers.map(p => loginButton(p, q)).join(' ')}</p>`,
  );
}

/** /invite/<код> of a valid invite: the provider of the invite only. */
export function invitePage(email: string, provider: ProviderId, code: string): string {
  return page(
    'Приглашение',
    `<h1>Приглашение в Agent Hub</h1><p>Приглашение выписано на <b>${esc(email)}</b>. Войдите этим адресом через ${esc(providerLabel(provider))}.</p>
${loginButton(provider, `&invite=${encodeURIComponent(code)}`)}`,
  );
}

/** Scenario «Истёкшее приглашение»: no login button. */
export function inviteExpiredPage(): string {
  return page('Приглашение истекло', `<h1>Приглашение истекло</h1><p>Приглашение истекло, попросите новое у Ивана.</p>`);
}

/** A used, revoked or unknown invite code. */
export function inviteInvalidPage(): string {
  return page('Приглашение недействительно', `<h1>Приглашение недействительно</h1><p>Ссылка уже использована или отозвана. Попросите новое приглашение у Ивана.</p>`);
}

/** Scenario «Вход под другим адресом»: the invite stays valid, the user can log in again with the right account. */
export function inviteMismatchPage(invitedEmail: string, provider: ProviderId, code: string | null, actual: string | null): string {
  const who = actual ? `Вход выполнен под <b>${esc(actual)}</b>. ` : '';
  const again = code ? loginButton(provider, `&invite=${encodeURIComponent(code)}&prompt=select_account`) : '';
  return page(
    'Приглашение на другой адрес',
    `<h1>Приглашение выписано на ${esc(invitedEmail)}</h1><p>${who}Войдите через ${esc(providerLabel(provider))} под адресом <b>${esc(invitedEmail)}</b>.</p>${again}`,
  );
}

/** Scenario «Вход без приглашения» (also an unverified address). */
export function inviteOnlyPage(email: string | null): string {
  const who = email ? `Вход выполнен под <b>${esc(email)}</b>. ` : '';
  return page(
    'Доступ только по приглашению',
    `<h1>Доступ только по приглашению</h1><p>${who}Этому аккаунту вход в Agent Hub не разрешён. Попросите приглашение у Ивана.</p>
<a class="btn" href="/auth/login?prompt=select_account">Войти другим аккаунтом</a>`,
  );
}

/** Scenario «Отключение коллеги»: login of a disabled user, and the page /auth/disabled the windows go to (ws 4403). */
export function disabledPage(): string {
  return page('Доступ отключён', `<h1>Доступ отключён</h1><p>Администратор отключил ваш доступ к Agent Hub.</p>`);
}

/** /auth/desktop/start without a provider when both are configured. */
export function desktopChooseProviderPage(providers: ProviderId[], href: (p: ProviderId) => string): string {
  return page(
    'Вход в приложение',
    `<h1>Вход в приложение Agent Hub</h1><p>Выберите способ входа.</p>
<p>${providers.map(p => `<a class="btn" href="${esc(href(p))}">Войти через ${esc(providerLabel(p))}</a>`).join(' ')}</p>`,
  );
}

// ---------- MCP sign-in (mcp-management M8) ----------

/** The browser came back from the provider and the server connected: a link (and a refresh) into the session. */
export function mcpSignedInPage(server: string, sessionHref: string): string {
  const href = esc(sessionHref);
  return page(
    'Вход выполнен',
    `<h1>Вход выполнен</h1><p>Сервер <b>${esc(server)}</b> подключён.</p><a class="btn" href="${href}">Перейти в сессию</a>`,
    `<meta http-equiv="refresh" content="2;url=${href}">\n`,
  );
}

/** The provider refused or the server did not connect: the reason, the way back to the session. */
export function mcpSignInFailedPage(reason: string, sessionHref: string | null): string {
  return page(
    'Вход не выполнен',
    `<h1>Вход не выполнен: ${esc(reason)}</h1><p>Нажмите «Войти» в панели MCP ещё раз.</p>${sessionHref ? `<a class="btn" href="${esc(sessionHref)}">Перейти в сессию</a>` : ''}`,
  );
}

/** The same callback is being passed to the process: the page reloads itself until the result is known. */
export function mcpSignInWaitingPage(server: string): string {
  return page(
    'Вход выполняется',
    `<h1>Вход выполняется</h1><p>Сервер <b>${esc(server)}</b> принимает вход. Страница обновится сама.</p>`,
    `<meta http-equiv="refresh" content="3">
`,
  );
}

/** Unknown, expired or another user's `state`: nothing is passed to the machine. */
export function mcpFlowNotFoundPage(): string {
  return page(
    'Попытка входа не найдена',
    `<h1>Попытка входа не найдена</h1><p>Она истекла, уже завершена или начата другим пользователем. Нажмите «Войти» в панели MCP ещё раз.</p><a class="btn" href="/">Открыть Agent Hub</a>`,
  );
}
