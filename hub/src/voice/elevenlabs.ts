// ElevenLabs Scribe batch client (change voice-input, design D2, D3).
// Requirements: Эндпоинт распознавания; Приватность диктовки.
// The key goes only into the `xi-api-key` header of outgoing requests; error messages never carry the audio or the text.

import { EnvHttpProxyAgent } from 'undici';

/** Why a transcription failed (mapped to the hub's error codes by the route). */
export type ScribeErrorKind = 'quota' | 'key' | 'upstream' | 'timeout' | 'aborted';

export class ScribeError extends Error {
  constructor(
    readonly kind: ScribeErrorKind,
    message: string,
    /** HTTP status of ElevenLabs, absent for network errors and timeouts. */
    readonly upstreamStatus?: number,
  ) {
    super(message);
    this.name = 'ScribeError';
  }
}

export interface ScribeOptions {
  apiKey: string;
  /** Base URL without the trailing slash, e.g. https://api.elevenlabs.io. */
  apiUrl: string;
  model: string;
  language: string;
  timeoutMs: number;
  /** Timeout of GET /v1/user/subscription (default 3 s). */
  subscriptionTimeoutMs?: number;
  fetch?: typeof fetch;
}

let proxyFetch: typeof fetch | undefined;

/**
 * fetch through the proxy of the environment (HTTPS_PROXY / NO_PROXY): on a PaaS the egress gateway reaches
 * ElevenLabs, which geo-blocks the cluster NAT. Node's fetch ignores these variables without NODE_USE_ENV_PROXY,
 * so the proxy goes in as a dispatcher. Without the variables — plain fetch.
 */
export function envFetch(env: NodeJS.ProcessEnv = process.env): typeof fetch {
  if (!env.HTTPS_PROXY && !env.https_proxy) return fetch;
  if (!proxyFetch) {
    const dispatcher = new EnvHttpProxyAgent();
    proxyFetch = (input, init) => fetch(input, { ...init, dispatcher } as RequestInit);
  }
  return proxyFetch;
}

/** `detail.status` / `detail.code` values of ElevenLabs that mean «no credits left», whatever the HTTP status. */
const QUOTA_CODES = new Set(['quota_exceeded', 'insufficient_credits']);

const EXT: Record<string, string> = { 'audio/webm': 'webm', 'audio/mp4': 'mp4', 'audio/ogg': 'ogg' };

/** `audio/webm;codecs=opus` → `audio/webm`. */
export function baseMime(contentType: string | undefined): string {
  return (contentType ?? '').split(';')[0]!.trim().toLowerCase();
}

function detailCodes(body: unknown): string[] {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return [];
  const d = detail as { status?: unknown; code?: unknown };
  return [d.status, d.code].filter((x): x is string => typeof x === 'string');
}

/**
 * A signed URL of a conversation with an ElevenLabs agent (change voice-conversation, D1):
 * GET /v1/convai/conversation/get-signed-url?agent_id=…. Throws ScribeError (`key`, `upstream`, `timeout`).
 */
export async function conversationSignedUrl(o: { apiKey: string; apiUrl: string; agentId: string; timeoutMs?: number; fetch?: typeof fetch }): Promise<string> {
  const f = o.fetch ?? envFetch();
  const timeout = AbortSignal.timeout(o.timeoutMs ?? 10_000);
  let res: Response;
  try {
    res = await f(`${o.apiUrl}/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(o.agentId)}`, {
      headers: { 'xi-api-key': o.apiKey, accept: 'application/json' },
      signal: timeout,
    });
  } catch (err) {
    if (timeout.aborted) throw new ScribeError('timeout', 'ElevenLabs did not answer the signed URL request');
    throw new ScribeError('upstream', `ElevenLabs request failed: ${(err as Error).name}`);
  }
  if (res.status === 401 || res.status === 403) throw new ScribeError('key', `ElevenLabs rejected the key (${res.status})`, res.status);
  if (!res.ok) throw new ScribeError('upstream', `ElevenLabs answered ${res.status}`, res.status);
  let url: unknown;
  try {
    url = ((await res.json()) as { signed_url?: unknown } | null)?.signed_url;
  } catch {
    url = undefined;
  }
  if (typeof url !== 'string' || !url.startsWith('wss://')) throw new ScribeError('upstream', 'ElevenLabs answer has no signed_url', res.status);
  return url;
}

export class ScribeClient {
  private readonly fetch: typeof fetch;

  constructor(private readonly o: ScribeOptions) {
    this.fetch = o.fetch ?? envFetch();
  }

  /**
   * POST /v1/speech-to-text (multipart): `model_id`, `language_code`, `tag_audio_events=false`,
   * `timestamps_granularity=none`, `file`. `enable_logging` is not sent (false is Enterprise-only, D3).
   * `signal` — the client went away; the request is aborted and the promise rejects with kind `aborted`.
   */
  async transcribe(audio: Buffer, contentType: string, signal?: AbortSignal): Promise<{ text: string }> {
    const mime = baseMime(contentType);
    const form = new FormData();
    form.append('model_id', this.o.model);
    form.append('language_code', this.o.language);
    form.append('tag_audio_events', 'false');
    form.append('timestamps_granularity', 'none');
    form.append('file', new Blob([new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength)], { type: contentType }), `voice.${EXT[mime] ?? 'webm'}`);

    const timeout = AbortSignal.timeout(this.o.timeoutMs);
    const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
    const fail = (err: unknown): never => {
      if (err instanceof ScribeError) throw err;
      if (timeout.aborted) throw new ScribeError('timeout', `ElevenLabs did not answer within ${this.o.timeoutMs} ms`);
      if (signal?.aborted) throw new ScribeError('aborted', 'client closed the connection');
      throw new ScribeError('upstream', `ElevenLabs request failed: ${(err as Error).name}`);
    };

    let res: Response;
    try {
      res = await this.fetch(`${this.o.apiUrl}/v1/speech-to-text`, {
        method: 'POST',
        headers: { 'xi-api-key': this.o.apiKey, accept: 'application/json' },
        body: form,
        signal: combined,
      });
    } catch (err) {
      return fail(err);
    }

    let body: unknown = null;
    try {
      const raw = await res.text();
      body = raw ? JSON.parse(raw) : null;
    } catch (err) {
      // An aborted read is a timeout or a gone client; a non-JSON body is judged by the status below.
      if (timeout.aborted || signal?.aborted) return fail(err);
    }

    const codes = detailCodes(body);
    if (res.status === 402 || codes.some(c => QUOTA_CODES.has(c))) throw new ScribeError('quota', 'ElevenLabs quota exceeded', res.status);
    if (res.status === 401 || res.status === 403) throw new ScribeError('key', `ElevenLabs rejected the key (${codes.join(',') || res.status})`, res.status);
    if (!res.ok) throw new ScribeError('upstream', `ElevenLabs answered ${res.status}`, res.status);
    const text = (body as { text?: unknown } | null)?.text;
    if (typeof text !== 'string') throw new ScribeError('upstream', 'ElevenLabs answer has no text', res.status);
    return { text };
  }

  /**
   * When the quota renews: GET /v1/user/subscription → `next_character_count_reset_unix` as ISO 8601.
   * Any failure (network, status, format, 3 s timeout) → undefined.
   */
  async subscriptionResetAt(): Promise<string | undefined> {
    try {
      const res = await this.fetch(`${this.o.apiUrl}/v1/user/subscription`, {
        headers: { 'xi-api-key': this.o.apiKey, accept: 'application/json' },
        signal: AbortSignal.timeout(this.o.subscriptionTimeoutMs ?? 3000),
      });
      if (!res.ok) return undefined;
      const unix = ((await res.json()) as { next_character_count_reset_unix?: unknown } | null)?.next_character_count_reset_unix;
      if (typeof unix !== 'number' || !Number.isFinite(unix) || unix <= 0) return undefined;
      return new Date(unix * 1000).toISOString();
    } catch {
      return undefined;
    }
  }
}
