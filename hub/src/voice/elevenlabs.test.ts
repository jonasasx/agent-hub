// Task 2.2 (change voice-input, D2, D3): the ElevenLabs Scribe client on a mocked fetch — never the real API.
import { describe, expect, it } from 'vitest';
import { ScribeClient, ScribeError, baseMime, envFetch } from './elevenlabs.js';

const KEY = 'sk_unit_test_key';
const URL_BASE = 'https://el.mock';

interface Call {
  url: string;
  init: RequestInit;
}

function client(handler: (url: string, init: RequestInit) => Promise<Response> | Response, over: Partial<ConstructorParameters<typeof ScribeClient>[0]> = {}) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }) as typeof fetch;
  return { calls, c: new ScribeClient({ apiKey: KEY, apiUrl: URL_BASE, model: 'scribe_v2', language: 'ru', timeoutMs: 1000, fetch: f, ...over }) };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const audio = Buffer.from('fake-opus-bytes');

async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    expect(err).toBeInstanceOf(ScribeError);
    return (err as ScribeError).kind;
  }
}

/** A fetch that never answers until its signal aborts. */
const hanging = (_url: string, init: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason as Error));
  });

describe('ScribeClient.transcribe', () => {
  it('sends the multipart request: model, language, no audio events, no timestamps, the file; no enable_logging', async () => {
    const { c, calls } = client(() => json(200, { text: '  Привет  ', language_code: 'rus' }));
    expect(await c.transcribe(audio, 'audio/webm;codecs=opus')).toEqual({ text: '  Привет  ' });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe(`${URL_BASE}/v1/speech-to-text`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe(KEY);
    const form = init.body as FormData;
    expect(form.get('model_id')).toBe('scribe_v2');
    expect(form.get('language_code')).toBe('ru');
    expect(form.get('tag_audio_events')).toBe('false');
    expect(form.get('timestamps_granularity')).toBe('none');
    expect(form.has('enable_logging')).toBe(false);
    const file = form.get('file') as File;
    expect(file.name).toBe('voice.webm');
    expect(file.type).toBe('audio/webm;codecs=opus');
    expect(Buffer.from(await file.arrayBuffer()).equals(audio)).toBe(true);
    expect([...form.keys()].sort()).toEqual(['file', 'language_code', 'model_id', 'tag_audio_events', 'timestamps_granularity']);
  });

  it('names the file by the type: mp4, ogg', async () => {
    const { c, calls } = client(() => json(200, { text: '' }));
    await c.transcribe(audio, 'audio/mp4');
    await c.transcribe(audio, 'audio/ogg; codecs=opus');
    expect(((calls[0]!.init.body as FormData).get('file') as File).name).toBe('voice.mp4');
    expect(((calls[1]!.init.body as FormData).get('file') as File).name).toBe('voice.ogg');
  });

  it('quota: HTTP 402, or detail.status / detail.code quota_exceeded | insufficient_credits at any status', async () => {
    expect(await kindOf(client(() => json(402, { detail: { status: 'payment_required' } })).c.transcribe(audio, 'audio/webm'))).toBe('quota');
    expect(await kindOf(client(() => json(401, { detail: { status: 'quota_exceeded', message: 'This request exceeds your quota' } })).c.transcribe(audio, 'audio/webm'))).toBe('quota');
    expect(await kindOf(client(() => json(400, { detail: { code: 'insufficient_credits' } })).c.transcribe(audio, 'audio/webm'))).toBe('quota');
    expect(await kindOf(client(() => new Response('nope', { status: 402 })).c.transcribe(audio, 'audio/webm'))).toBe('quota');
  });

  it('key: 401/403 that are not about the quota', async () => {
    expect(await kindOf(client(() => json(401, { detail: { status: 'invalid_api_key' } })).c.transcribe(audio, 'audio/webm'))).toBe('key');
    expect(await kindOf(client(() => json(403, { detail: { status: 'missing_permissions' } })).c.transcribe(audio, 'audio/webm'))).toBe('key');
  });

  it('upstream: 400/422/429/5xx, network failure, an answer without text, a non-JSON answer', async () => {
    for (const s of [400, 422, 429, 500, 503]) expect(await kindOf(client(() => json(s, { detail: 'x' })).c.transcribe(audio, 'audio/webm'))).toBe('upstream');
    expect(await kindOf(client(() => Promise.reject(new TypeError('fetch failed'))).c.transcribe(audio, 'audio/webm'))).toBe('upstream');
    expect(await kindOf(client(() => json(200, { transcripts: [] })).c.transcribe(audio, 'audio/webm'))).toBe('upstream');
    expect(await kindOf(client(() => new Response('<html>', { status: 200 })).c.transcribe(audio, 'audio/webm'))).toBe('upstream');
  });

  it('timeout: no answer within timeoutMs', async () => {
    const t0 = Date.now();
    expect(await kindOf(client(hanging, { timeoutMs: 50 }).c.transcribe(audio, 'audio/webm'))).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(900);
  });

  it('aborted: the external signal (client gone) aborts the request', async () => {
    const ac = new AbortController();
    const p = client(hanging).c.transcribe(audio, 'audio/webm', ac.signal);
    ac.abort();
    expect(await kindOf(p)).toBe('aborted');
  });

  it('error messages carry neither the key nor the recognised text', async () => {
    const { c } = client(() => json(401, { detail: { status: 'invalid_api_key', message: `bad key ${KEY}` } }));
    const err = (await c.transcribe(audio, 'audio/webm').catch((e: unknown) => e)) as ScribeError;
    expect(err.message).not.toContain(KEY);
  });
});

describe('ScribeClient.subscriptionResetAt', () => {
  it('next_character_count_reset_unix → ISO, with the key header', async () => {
    const { c, calls } = client(() => json(200, { tier: 'starter', next_character_count_reset_unix: 1795046400 }));
    expect(await c.subscriptionResetAt()).toBe(new Date(1795046400 * 1000).toISOString());
    expect(calls[0]!.url).toBe(`${URL_BASE}/v1/user/subscription`);
    expect((calls[0]!.init.headers as Record<string, string>)['xi-api-key']).toBe(KEY);
  });

  it('any failure → undefined: status, format, network, 3 s timeout', async () => {
    expect(await client(() => json(401, {})).c.subscriptionResetAt()).toBeUndefined();
    expect(await client(() => json(200, { tier: 'starter' })).c.subscriptionResetAt()).toBeUndefined();
    expect(await client(() => Promise.reject(new TypeError('fetch failed'))).c.subscriptionResetAt()).toBeUndefined();
    expect(await client(hanging, { subscriptionTimeoutMs: 30 }).c.subscriptionResetAt()).toBeUndefined();
  });
});

describe('baseMime', () => {
  it('drops parameters and case', () => {
    expect(baseMime('Audio/WebM; codecs=opus')).toBe('audio/webm');
    expect(baseMime(undefined)).toBe('');
  });
});

describe('envFetch', () => {
  it('is plain fetch without a proxy in the environment', () => {
    expect(envFetch({})).toBe(fetch);
  });

  it('wraps fetch with a proxy dispatcher when HTTPS_PROXY is set', () => {
    const f = envFetch({ HTTPS_PROXY: 'http://proxy.mock:3128' });
    expect(f).not.toBe(fetch);
    expect(envFetch({ https_proxy: 'http://proxy.mock:3128' })).toBe(f);
  });
});
