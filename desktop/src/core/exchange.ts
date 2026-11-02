/**
 * Code exchange (design D10, spec desktop-auth «Обмен кода на сессию», «Приём кода приложением»).
 * `POST /auth/desktop/exchange` from the main process with `Origin` = PUBLIC_URL (the existing guard, no exemption).
 */
import type { DesktopExchangeError, DesktopExchangeRequest, DesktopExchangeResponse } from '@agent-hub/shared';

export type ExchangeResult = { ok: true; sessionToken: string; expiresAt: string } | { ok: false; error: DesktopExchangeError | 'network' | 'bad_response'; status: number };

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

const KNOWN_ERRORS: ReadonlySet<string> = new Set(['invalid_request', 'invalid_grant', 'forbidden_account', 'forbidden_origin']);

export async function exchangeCode(fetchFn: FetchLike, hubUrl: string, userAgent: string, req: DesktopExchangeRequest): Promise<ExchangeResult> {
  let status: number;
  let body: unknown;
  try {
    const r = await fetchFn(`${hubUrl}/auth/desktop/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: new URL(hubUrl).origin, 'User-Agent': userAgent },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(15_000),
    });
    status = r.status;
    body = await r.json().catch(() => null);
  } catch {
    return { ok: false, error: 'network', status: 0 };
  }
  const b = body as Partial<DesktopExchangeResponse> & { error?: unknown };
  if (status === 200) {
    if (b && typeof b.sessionToken === 'string' && b.sessionToken && typeof b.expiresAt === 'string' && !Number.isNaN(Date.parse(b.expiresAt))) {
      return { ok: true, sessionToken: b.sessionToken, expiresAt: b.expiresAt };
    }
    return { ok: false, error: 'bad_response', status };
  }
  const err = b && typeof b.error === 'string' && KNOWN_ERRORS.has(b.error) ? (b.error as DesktopExchangeError) : 'bad_response';
  return { ok: false, error: err, status };
}

export function exchangeErrorText(r: Extract<ExchangeResult, { ok: false }>): string {
  switch (r.error) {
    case 'invalid_grant':
      return 'Код входа истёк или уже использован.';
    case 'forbidden_account':
      return 'Этот аккаунт не допущен к хабу.';
    case 'forbidden_origin':
      return 'Хаб отклонил запрос приложения (Origin).';
    case 'invalid_request':
      return 'Хаб не принял запрос входа.';
    case 'network':
      return 'Нет связи с хабом.';
    default:
      return `Неожиданный ответ хаба (HTTP ${r.status}).`;
  }
}

/** The `ah_session` cookie for the app's storage (D10): HttpOnly, Secure on https, SameSite=Lax, expiry from the hub. */
export function sessionCookie(hubUrl: string, token: string, expiresAt: string) {
  return {
    url: hubUrl,
    name: 'ah_session',
    value: token,
    path: '/',
    httpOnly: true,
    secure: hubUrl.startsWith('https:'),
    sameSite: 'lax' as const,
    expirationDate: Math.floor(Date.parse(expiresAt) / 1000),
  };
}

/**
 * Re-login: the previous `ah_session` of the app is ended on the hub (`POST /auth/logout` with that cookie and
 * `Origin` = PUBLIC_URL) before the new token is stored, so old server sessions do not pile up. Errors are ignored:
 * an expired or already deleted session is the normal case. Returns the HTTP status (0 — network error).
 */
export async function logoutPreviousSession(fetchFn: FetchLike, hubUrl: string, userAgent: string, oldToken: string): Promise<number> {
  try {
    const r = await fetchFn(`${hubUrl}/auth/logout`, {
      method: 'POST',
      headers: { Origin: new URL(hubUrl).origin, Cookie: `ah_session=${oldToken}`, 'User-Agent': userAgent },
      body: '',
      signal: AbortSignal.timeout(5_000),
    });
    return r.status;
  } catch {
    return 0;
  }
}
