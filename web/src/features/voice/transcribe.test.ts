// `transcribe` of the API client (task 3.2, design D2, D7).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, onUnauthorized, transcribe } from '../../api/client';

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('transcribe', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    onUnauthorized(null);
  });

  it('POSTs the raw bytes with the recording type and returns the text', async () => {
    const f = stubFetch(async () => json(200, { text: 'Привет' }));
    const blob = new Blob(['abc'], { type: 'audio/webm;codecs=opus' });
    await expect(transcribe(blob, 'audio/webm;codecs=opus')).resolves.toEqual({ text: 'Привет' });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('/api/voice/transcribe');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(blob);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('audio/webm;codecs=opus');
    expect(init.credentials).toBe('same-origin');
  });

  it('a quota error carries resetAt in the body', async () => {
    stubFetch(async () => json(402, { error: 'voice_quota_exceeded', message: 'Закончилась квота ElevenLabs', resetAt: '2026-11-18T00:00:00Z' }));
    const err = (await transcribe(new Blob(['a']), 'audio/mp4').catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(402);
    expect(err.code).toBe('voice_quota_exceeded');
    expect(err.body?.resetAt).toBe('2026-11-18T00:00:00Z');
  });

  it('401 calls the unauthorized handler', async () => {
    const h = vi.fn();
    onUnauthorized(h);
    stubFetch(async () => json(401, { error: 'unauthenticated' }));
    await expect(transcribe(new Blob(['a']), 'audio/webm')).rejects.toMatchObject({ status: 401, code: 'unauthenticated' });
    expect(h).toHaveBeenCalledTimes(1);
  });

  it('a lost connection → ApiError(0, network_error); a non-JSON error page keeps the status', async () => {
    stubFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(transcribe(new Blob(['a']), 'audio/webm')).rejects.toMatchObject({ status: 0, code: 'network_error' });
    stubFetch(async () => new Response('<html>Bad gateway</html>', { status: 502 }));
    await expect(transcribe(new Blob(['a']), 'audio/webm')).rejects.toMatchObject({ status: 502, code: 'http_error' });
  });

  it('gives up after 75 s by itself (the hub answers 504 at 60 s first)', async () => {
    vi.useFakeTimers();
    stubFetch(
      (_u, init) =>
        new Promise((_res, rej) => {
          init.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
        }),
    );
    const p = transcribe(new Blob(['a']), 'audio/webm').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(74_999);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toMatchObject({ status: 0, code: 'timeout' });
  });

  it('«Отмена» aborts the request; the caller sees an AbortError, not an ApiError', async () => {
    let seen: AbortSignal | undefined;
    stubFetch(
      (_u, init) =>
        new Promise((_res, rej) => {
          seen = init.signal!;
          init.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
        }),
    );
    const ctl = new AbortController();
    const p = transcribe(new Blob(['a']), 'audio/webm', ctl.signal).catch((e: unknown) => e);
    await Promise.resolve();
    ctl.abort();
    const err = await p;
    expect(seen!.aborted).toBe(true);
    expect(err).not.toBeInstanceOf(ApiError);
    expect((err as DOMException).name).toBe('AbortError');
  });
});
