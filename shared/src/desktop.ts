// Desktop app contracts (change desktop-app, design.md D7, D9, D10): the kind of a /ws/ui client and the
// code exchange of the desktop login.
import { z } from 'zod';

/**
 * Kind of a /ws/ui connection (`?client=`). Not to be confused with `SessionSource 'desktop'` — Claude Desktop as the
 * origin of a session: UiClientKind is who is connected to the hub, SessionSource is where a session was started.
 */
export const UI_CLIENT_KINDS = ['web', 'desktop'] as const;
export type UiClientKind = (typeof UI_CLIENT_KINDS)[number];

/** Requirement: Вид клиента и признак видимости в хабе — anything but `desktop` (absent, unknown) is `web`. */
export function parseUiClientKind(value: string | null | undefined): UiClientKind {
  return value === 'desktop' ? 'desktop' : 'web';
}

/** POST /auth/desktop/exchange (Requirement: Обмен кода на сессию). */
export const desktopExchangeRequestSchema = z.object({
  code: z.string().min(1).max(256),
  codeVerifier: z.string().regex(/^[A-Za-z0-9\-._~]{43,128}$/),
  state: z.string().regex(/^[A-Za-z0-9_-]{22,128}$/),
});
export type DesktopExchangeRequest = z.infer<typeof desktopExchangeRequestSchema>;

/** 200 of POST /auth/desktop/exchange: the value of the `ah_session` cookie and its expiry (ISO). */
export interface DesktopExchangeResponse {
  sessionToken: string;
  expiresAt: string;
}

/** Errors of POST /auth/desktop/exchange: 400 invalid_request / invalid_grant, 403 forbidden_account (forbidden_origin — the guard). */
export type DesktopExchangeError = 'invalid_request' | 'invalid_grant' | 'forbidden_account' | 'forbidden_origin';
