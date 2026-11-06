// Change i18n: the profile language (D4) and the language of a request (D5).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PUBLIC_URL, startTestHub, type TestHub } from '../test/harness.js';
import { requestLocale } from '../i18n.js';

describe('requestLocale (D5 order)', () => {
  it('the web header wins over the profile and Accept-Language', () => {
    expect(requestLocale('ja', 'ru', 'de-DE,de;q=0.9', 'en')).toBe('ja');
  });

  it('an unknown header falls through to the profile', () => {
    expect(requestLocale('pl', 'ru', 'de', 'en')).toBe('ru');
  });

  it('without a profile — Accept-Language by q, base subtag', () => {
    expect(requestLocale(undefined, null, 'pl;q=1, pt-PT;q=0.8, en;q=0.5', 'en')).toBe('pt-BR');
    expect(requestLocale(undefined, null, 'fr', 'ru')).toBe('fr');
  });

  it('nothing known — the fallback', () => {
    expect(requestLocale(undefined, null, undefined, 'en')).toBe('en');
    expect(requestLocale(undefined, null, '', 'ru')).toBe('ru');
  });
});

describe('profile language (integration)', () => {
  let t: TestHub;
  let cookie: string;
  beforeAll(async () => {
    t = await startTestHub();
    cookie = await t.login();
  });
  afterAll(async () => t.close());

  const put = (locale: unknown) => t.hub.app.inject({ method: 'PUT', url: '/api/preferences/locale', cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, payload: { locale } });
  const me = async () => (await t.hub.app.inject({ method: 'GET', url: '/api/me', cookies: { ah_session: cookie } })).json() as { locale: string | null };

  it('a new user has no language: the browser decides', async () => {
    expect((await me()).locale).toBeNull();
  });

  it('PUT stores the language, /api/me returns it; null resets to the browser', async () => {
    expect((await put('de')).statusCode).toBe(204);
    expect((await me()).locale).toBe('de');
    expect((await put('ko')).statusCode).toBe(204);
    expect((await me()).locale).toBe('ko');
    expect((await put(null)).statusCode).toBe(204);
    expect((await me()).locale).toBeNull();
  });

  it('an unsupported language is 400 and the stored one stays', async () => {
    await put('fr');
    const res = await put('pl');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_request' });
    expect((await me()).locale).toBe('fr');
    await put(null);
  });

  it('the launch preferences are kept when the language changes', async () => {
    const userId = (await t.tdb.pool.query<{ id: string }>(`SELECT id FROM users WHERE email = 'jonasasx@gmail.com'`)).rows[0]!.id;
    await t.tdb.pool.query(`UPDATE user_preferences SET last_provider = 'codex' WHERE user_id = $1`, [userId]);
    await put('ja');
    const row = (await t.tdb.pool.query(`SELECT last_provider, locale FROM user_preferences WHERE user_id = $1`, [userId])).rows[0];
    expect(row).toEqual({ last_provider: 'codex', locale: 'ja' });
    await put(null);
  });
});

describe('keyed errors and pages follow the request language (integration)', () => {
  let t: TestHub;
  let cookie: string;
  beforeAll(async () => {
    t = await startTestHub();
    cookie = await t.login();
  });
  afterAll(async () => t.close());

  const notFound = (headers: Record<string, string> = {}) => t.hub.app.inject({ method: 'GET', url: '/api/sessions/no-such-session', cookies: { ah_session: cookie }, headers });
  const put = (locale: unknown) => t.hub.app.inject({ method: 'PUT', url: '/api/preferences/locale', cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, payload: { locale } });

  it('without a header or a profile the harness language (ru) answers; the code stays', async () => {
    const res = await notFound();
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found', message: 'Сессия не найдена' });
  });

  it('X-Agent-Hub-Locale: en translates a keyed HttpError', async () => {
    const res = await notFound({ 'x-agent-hub-locale': 'en' });
    expect(res.json()).toMatchObject({ error: 'not_found', message: 'Session not found' });
  });

  it('the profile language translates it without a header, the header wins over the profile', async () => {
    expect((await put('en')).statusCode).toBe(204);
    expect((await notFound()).json()).toMatchObject({ message: 'Session not found' });
    expect((await notFound({ 'x-agent-hub-locale': 'ru' })).json()).toMatchObject({ message: 'Сессия не найдена' });
    await put(null);
  });

  it('a translated language renders its own text, an unsupported one falls back to English', async () => {
    expect((await notFound({ 'x-agent-hub-locale': 'de' })).json()).toMatchObject({ message: 'Sitzung nicht gefunden' });
    expect((await notFound({ 'accept-language': 'it' })).json()).toMatchObject({ message: 'Session not found' });
    expect((await notFound({ 'accept-language': 'th-TH,en;q=0.5' })).json().message).toMatch(/[฀-๿]/);
  });

  it('/auth/disabled renders on Accept-Language and sets <html lang>', async () => {
    const res = await t.hub.app.inject({ method: 'GET', url: '/auth/disabled', headers: { 'accept-language': 'de' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<html lang="de"');
  });
});
