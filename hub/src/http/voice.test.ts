// Task 2.4 (change voice-input, D2, D5, D6): POST /api/voice/transcribe and /api/me.voiceInput on a mocked ElevenLabs.
// Requirements: Включение диктовки; Эндпоинт распознавания; Приватность диктовки.
import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VOICE_UPLOAD_LIMIT } from '@agent-hub/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../config.js';
import { PUBLIC_URL, startTestHub, waitFor, type TestHub } from '../test/harness.js';
import { registerVoice } from './voice.js';

const KEY = 'sk_voice_test_key_0123456789';
const SECRET_TEXT = 'секретная фраза диктовки';
const audio = Buffer.from('fake-webm-opus-bytes');

type Handler = (url: string, init: RequestInit) => Promise<Response>;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('voice transcribe (integration)', () => {
  let t: TestHub;
  let cookie: string;
  const logs: string[] = [];
  const calls: Array<{ url: string; signal: AbortSignal | null }> = [];
  let handler: Handler = async () => json(200, { text: '' });
  const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), signal: init.signal ?? null });
    return handler(String(input), init);
  }) as typeof fetch;

  const post = (payload: Buffer, type = 'audio/webm;codecs=opus', headers: Record<string, string> = {}, c: string | null = cookie) =>
    t.hub.app.inject({
      method: 'POST',
      url: '/api/voice/transcribe',
      ...(c ? { cookies: { ah_session: c } } : {}),
      headers: { origin: PUBLIC_URL, 'content-type': type, ...headers },
      payload,
    });

  beforeAll(async () => {
    t = await startTestHub({
      env: { ELEVENLABS_API_KEY: KEY, ELEVENLABS_API_URL: 'https://el.mock', VOICE_TIMEOUT_MS: '300', VOICE_CONCURRENCY: '2' },
      voice: { fetch: fakeFetch },
      logStream: { write: line => void logs.push(line) },
    });
    cookie = await t.login();
  });
  afterAll(async () => t.close());

  it('/api/me says voiceInput: true when the key is set, and never carries the key', async () => {
    const r = await t.hub.app.inject({ method: 'GET', url: '/api/me', cookies: { ah_session: cookie } });
    expect(r.json()).toMatchObject({ voiceInput: true });
    expect(r.body).not.toContain(KEY);
  });

  it('200: the text is trimmed; the request goes to ElevenLabs speech-to-text', async () => {
    calls.length = 0;
    handler = async () => json(200, { text: `  ${SECRET_TEXT}  \n` });
    const r = await post(audio);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ text: SECRET_TEXT });
    expect(calls.map(c => c.url)).toEqual(['https://el.mock/v1/speech-to-text']);
    // mp4 and ogg are accepted too
    expect((await post(audio, 'audio/mp4')).statusCode).toBe(200);
    expect((await post(audio, 'audio/ogg')).statusCode).toBe(200);
  });

  it('401 without the cookie, 403 with a foreign Origin — ElevenLabs is not called', async () => {
    calls.length = 0;
    const r401 = await post(audio, 'audio/webm', {}, null);
    expect(r401.statusCode).toBe(401);
    expect(r401.json()).toMatchObject({ error: 'unauthenticated' });
    const r403 = await post(audio, 'audio/webm', { origin: 'https://evil.example' });
    expect(r403.statusCode).toBe(403);
    expect(r403.json()).toMatchObject({ error: 'forbidden_origin' });
    // the type check runs before the body is read, but after the auth hook: no cookie + image/png is still 401
    expect((await post(audio, 'image/png', {}, null)).statusCode).toBe(401);
    expect((await post(audio, 'image/png', { origin: 'https://evil.example' })).statusCode).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('no Content-Type: 415 unsupported_audio of the endpoint, not the generic 415 of Fastify', async () => {
    calls.length = 0;
    const r = await t.hub.app.inject({ method: 'POST', url: '/api/voice/transcribe', cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, payload: audio });
    expect(r.statusCode).toBe(415);
    expect(r.json()).toMatchObject({ error: 'unsupported_audio', message: 'Пришлите запись audio/webm, audio/mp4 или audio/ogg' });
    expect(calls).toHaveLength(0);
  });

  it('415 is answered before the body is read: a wrong type over the 12 MiB limit is 415, not 413', async () => {
    calls.length = 0;
    const r = await post(Buffer.alloc(VOICE_UPLOAD_LIMIT + 1), 'image/png');
    expect(r.statusCode).toBe(415);
    expect(r.json()).toMatchObject({ error: 'unsupported_audio' });
    expect(calls).toHaveLength(0);
  });

  it('400 empty_audio, 415 unsupported_audio (image/png, JSON), 413 too_large at 12 MiB + 1 byte', async () => {
    calls.length = 0;
    const empty = await post(Buffer.alloc(0));
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toMatchObject({ error: 'empty_audio' });
    const png = await post(audio, 'image/png');
    expect(png.statusCode).toBe(415);
    expect(png.json()).toMatchObject({ error: 'unsupported_audio' });
    const js = await post(Buffer.from('{"a":1}'), 'application/json');
    expect(js.statusCode).toBe(415);
    expect(js.json()).toMatchObject({ error: 'unsupported_audio' });
    const big = await post(Buffer.alloc(VOICE_UPLOAD_LIMIT + 1));
    expect(big.statusCode).toBe(413);
    expect(big.json()).toMatchObject({ error: 'too_large' });
    expect(calls).toHaveLength(0);
    // exactly the limit passes
    handler = async () => json(200, { text: 'ok' });
    expect((await post(Buffer.alloc(VOICE_UPLOAD_LIMIT))).statusCode).toBe(200);
  });

  it('402 voice_quota_exceeded with resetAt from /v1/user/subscription', async () => {
    handler = async url => (url.endsWith('/v1/user/subscription') ? json(200, { next_character_count_reset_unix: 1795046400 }) : json(401, { detail: { status: 'quota_exceeded', message: 'quota' } }));
    const r = await post(audio);
    expect(r.statusCode).toBe(402);
    expect(r.json()).toEqual({ error: 'voice_quota_exceeded', message: 'Закончилась квота ElevenLabs', resetAt: new Date(1795046400 * 1000).toISOString() });
  });

  it('402 without resetAt when the subscription request fails', async () => {
    handler = async url => (url.endsWith('/v1/user/subscription') ? json(500, {}) : json(402, { detail: { status: 'payment_required' } }));
    const r = await post(audio);
    expect(r.statusCode).toBe(402);
    expect(r.json()).toEqual({ error: 'voice_quota_exceeded', message: 'Закончилась квота ElevenLabs' });
  });

  it('502 voice_key_rejected and voice_upstream_error', async () => {
    handler = async () => json(401, { detail: { status: 'invalid_api_key' } });
    const key = await post(audio);
    expect(key.statusCode).toBe(502);
    expect(key.json()).toMatchObject({ error: 'voice_key_rejected', message: 'ElevenLabs отклонил ключ хаба' });
    for (const h of [async () => json(500, {}), async () => json(422, { detail: [] }), async () => json(200, {}), () => Promise.reject(new TypeError('fetch failed'))] as Handler[]) {
      handler = h;
      const r = await post(audio);
      expect(r.statusCode).toBe(502);
      expect(r.json()).toMatchObject({ error: 'voice_upstream_error' });
    }
  });

  it('504 voice_timeout when ElevenLabs does not answer within VOICE_TIMEOUT_MS', async () => {
    handler = (_url, init) => new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(init.signal!.reason as Error)));
    const r = await post(audio);
    expect(r.statusCode).toBe(504);
    expect(r.json()).toMatchObject({ error: 'voice_timeout' });
  });

  it('429 voice_busy with Retry-After: 5 for the third simultaneous request; slots are freed afterwards', async () => {
    calls.length = 0;
    const release: Array<() => void> = [];
    handler = () => new Promise(res => release.push(() => res(json(200, { text: 'готово' }))));
    const a = post(audio);
    const b = post(audio);
    await waitFor(() => (calls.length === 2 ? true : undefined));
    const c = await post(audio);
    expect(c.statusCode).toBe(429);
    expect(c.headers['retry-after']).toBe('5');
    expect(c.json()).toMatchObject({ error: 'voice_busy' });
    release.forEach(f => f());
    expect((await a).statusCode).toBe(200);
    expect((await b).statusCode).toBe(200);
    handler = async () => json(200, { text: 'снова' });
    expect((await post(audio)).json()).toEqual({ text: 'снова' });
  });

  it('the ElevenLabs request is aborted when the client closes the connection', async () => {
    calls.length = 0;
    handler = (_url, init) => new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(init.signal!.reason as Error)));
    const port = Number(new URL(t.wsBase.replace('ws:', 'http:')).port);
    const req = request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/api/voice/transcribe',
      headers: { origin: PUBLIC_URL, cookie: `ah_session=${cookie}`, 'content-type': 'audio/webm', 'content-length': audio.length },
    });
    req.on('error', () => undefined);
    req.end(audio);
    const call = await waitFor(() => calls[0]);
    expect(call.signal!.aborted).toBe(false);
    req.destroy();
    await waitFor(() => (call.signal!.aborted ? true : undefined));
    await waitFor(() => (logs.some(l => l.includes('"result":"client_closed"')) ? true : undefined));
  });

  it('the log has «voice transcribe» lines with bytes, ms, result — never the text or the key', async () => {
    const lines = logs.filter(l => l.includes('voice transcribe')).map(l => JSON.parse(l) as Record<string, unknown>);
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.find(l => l.result === 'ok')).toMatchObject({ bytes: audio.length, ms: expect.any(Number) });
    expect(new Set(lines.map(l => l.result))).toEqual(
      new Set(['ok', 'empty_audio', 'unsupported_audio', 'voice_quota_exceeded', 'voice_key_rejected', 'voice_upstream_error', 'voice_timeout', 'voice_busy', 'client_closed']),
    );
    const all = logs.join('\n');
    expect(all).not.toContain(SECRET_TEXT);
    expect(all).not.toContain(KEY);
    expect(all).not.toContain('готово');
  });
});

describe('voice transcribe without the key (integration)', () => {
  let t: TestHub;
  let cookie: string;
  let called = 0;

  beforeAll(async () => {
    t = await startTestHub({ voice: { fetch: (async () => (called++, json(200, { text: 'x' }))) as typeof fetch } });
    cookie = await t.login();
  });
  afterAll(async () => t.close());

  it('/api/me says voiceInput: false; POST answers 503 voice_disabled without calling ElevenLabs', async () => {
    const me = await t.hub.app.inject({ method: 'GET', url: '/api/me', cookies: { ah_session: cookie } });
    expect(me.json()).toMatchObject({ voiceInput: false });
    const r = await t.hub.app.inject({
      method: 'POST',
      url: '/api/voice/transcribe',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL, 'content-type': 'audio/webm' },
      payload: audio,
    });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ error: 'voice_disabled', message: expect.any(String) });
    // before the body is read: a body over the limit is 503 too, not 413; without the cookie — 401 first
    const big = await t.hub.app.inject({
      method: 'POST',
      url: '/api/voice/transcribe',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL, 'content-type': 'image/png' },
      payload: Buffer.alloc(VOICE_UPLOAD_LIMIT + 1),
    });
    expect(big.statusCode).toBe(503);
    const anon = await t.hub.app.inject({ method: 'POST', url: '/api/voice/transcribe', headers: { origin: PUBLIC_URL, 'content-type': 'audio/webm' }, payload: audio });
    expect(anon.statusCode).toBe(401);
    expect(called).toBe(0);
  });

  it('other routes still refuse raw audio (the parser lives in the voice scope only)', async () => {
    const r = await t.hub.app.inject({
      method: 'POST',
      url: '/api/sessions',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL, 'content-type': 'audio/webm' },
      payload: audio,
    });
    expect(r.statusCode).toBe(415);
  });
});

// On a real socket with an async preHandler in the scope: the request stream is destroyed by Node itself once its body
// has been read, so only a closed connection — not a read body — may count as «client gone».
describe('voice transcribe over a real socket with an async preHandler', () => {
  const lines: string[] = [];
  let called = 0;
  let app: FastifyInstance;
  let port = 0;
  /** preHandler: reports that the body is read, then waits for the gate (a test may close the client meanwhile). */
  let reached: () => void = () => undefined;
  let gate: Promise<void> = Promise.resolve();

  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      PUBLIC_URL,
      DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/x',
      COOKIE_SECRET: 'test-cookie-secret-0123456789abcdef0123',
      OIDC_ISSUER: 'https://id.example',
      OIDC_CLIENT_ID: 'c',
      OIDC_CLIENT_SECRET: 's',
      OIDC_ALLOWED_EMAILS: 'a@example.com',
      ELEVENLABS_API_KEY: KEY,
      ELEVENLABS_API_URL: 'https://el.mock',
    });
    app = Fastify({ logger: { level: 'info', stream: { write: (l: string) => void lines.push(l) } } });
    app.addHook('preHandler', async () => {
      reached();
      await gate;
    });
    registerVoice(app, { config, fetch: (async () => (called++, json(200, { text: ` ${SECRET_TEXT} ` }))) as typeof fetch });
    await app.listen({ host: '127.0.0.1', port: 0 });
    port = (app.server.address() as AddressInfo).port;
  });
  afterAll(async () => app.close());

  const send = () => {
    const req = request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/api/voice/transcribe',
      headers: { 'content-type': 'audio/webm;codecs=opus', 'content-length': audio.length },
    });
    const answer = new Promise<{ status: number; body: string }>((res, rej) => {
      req.on('response', r => {
        let b = '';
        r.setEncoding('utf8');
        r.on('data', (c: string) => (b += c));
        r.on('end', () => res({ status: r.statusCode ?? 0, body: b }));
      });
      req.on('error', rej);
    });
    answer.catch(() => undefined);
    req.end(audio);
    return { req, answer };
  };

  it('a normal request passes the async preHandler, reaches ElevenLabs and gets 200', async () => {
    called = 0;
    gate = Promise.resolve();
    const { answer } = send();
    const r = await answer;
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ text: SECRET_TEXT });
    expect(called).toBe(1);
  });

  it('the client closes after sending the body: ElevenLabs is not called, the log says client_closed', async () => {
    called = 0;
    lines.length = 0;
    let open: () => void = () => undefined;
    gate = new Promise(r => (open = r));
    const inHook = new Promise<void>(r => (reached = r));
    const { req } = send();
    await inHook;
    req.destroy();
    // the server notices the closed socket before the handler runs
    await new Promise(r => setTimeout(r, 100));
    open();
    await waitFor(() => (lines.some(l => l.includes('voice transcribe')) ? true : undefined));
    expect(called).toBe(0);
    expect(lines.find(l => l.includes('voice transcribe'))).toContain('"result":"client_closed"');
    reached = () => undefined;
  });
});
