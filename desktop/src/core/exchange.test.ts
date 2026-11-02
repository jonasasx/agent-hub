// Requirement: Обмен кода на сессию / Приём кода приложением (design D10).
import { describe, expect, it, vi } from 'vitest';
import { exchangeCode, exchangeErrorText, logoutPreviousSession, sessionCookie, type FetchLike } from './exchange.js';

const req = { code: 'c', codeVerifier: 'v'.repeat(43), state: 's'.repeat(22) };

function fetchReturning(status: number, body: unknown) {
  return vi.fn<FetchLike>(async () => ({ status, json: async () => body }));
}

describe('exchangeCode', () => {
  it('POSTs JSON with Origin = PUBLIC_URL and the desktop User-Agent', async () => {
    const f = fetchReturning(200, { sessionToken: 'tok', expiresAt: '2026-11-25T10:00:00.000Z' });
    const r = await exchangeCode(f, 'https://hub.example.com', 'AgentHubDesktop/0.1.0', req);
    expect(r).toEqual({ ok: true, sessionToken: 'tok', expiresAt: '2026-11-25T10:00:00.000Z' });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://hub.example.com/auth/desktop/exchange');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Origin: 'https://hub.example.com', 'Content-Type': 'application/json', 'User-Agent': 'AgentHubDesktop/0.1.0' });
    expect(JSON.parse(init.body)).toEqual(req);
  });
  it('maps hub errors', async () => {
    expect(await exchangeCode(fetchReturning(400, { error: 'invalid_grant' }), 'http://localhost:8080', 'UA', req)).toEqual({ ok: false, error: 'invalid_grant', status: 400 });
    expect(await exchangeCode(fetchReturning(403, { error: 'forbidden_account' }), 'http://localhost:8080', 'UA', req)).toMatchObject({ error: 'forbidden_account' });
    expect(await exchangeCode(fetchReturning(500, 'oops'), 'http://localhost:8080', 'UA', req)).toMatchObject({ error: 'bad_response', status: 500 });
    expect(await exchangeCode(fetchReturning(200, { sessionToken: 'x' }), 'http://localhost:8080', 'UA', req)).toMatchObject({ error: 'bad_response' });
    const fail = vi.fn<FetchLike>(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(await exchangeCode(fail, 'http://localhost:8080', 'UA', req)).toEqual({ ok: false, error: 'network', status: 0 });
    expect(exchangeErrorText({ ok: false, error: 'invalid_grant', status: 400 })).toBe('Код входа истёк или уже использован.');
  });
  it('cookie: HttpOnly, Lax, Secure only on https, expiry from the hub', () => {
    expect(sessionCookie('https://hub.example.com', 't', '2026-11-25T10:00:00.000Z')).toEqual({
      url: 'https://hub.example.com',
      name: 'ah_session',
      value: 't',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      expirationDate: Date.parse('2026-11-25T10:00:00.000Z') / 1000,
    });
    expect(sessionCookie('http://localhost:8080', 't', '2026-11-25T10:00:00.000Z').secure).toBe(false);
  });
});

describe('logoutPreviousSession (re-login)', () => {
  it('POST /auth/logout with the old cookie and Origin; errors ignored', async () => {
    const f = fetchReturning(204, null);
    expect(await logoutPreviousSession(f, 'https://hub.example.com', 'UA', 'old')).toBe(204);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://hub.example.com/auth/logout');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Origin: 'https://hub.example.com', Cookie: 'ah_session=old' });
    const fail = vi.fn<FetchLike>(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(await logoutPreviousSession(fail, 'https://hub.example.com', 'UA', 'old')).toBe(0);
  });
});
