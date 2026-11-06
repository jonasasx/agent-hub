// Dictation (change voice-input, design D2, D6): POST /api/voice/transcribe — raw audio bytes → ElevenLabs Scribe → text.
// Requirements: Включение диктовки; Эндпоинт распознавания; Приватность диктовки.
// Auth and the Origin check come from the common onRequest hook (http/auth.ts); errors go through the common handler.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { VOICE_AUDIO_TYPES, VOICE_UPLOAD_LIMIT, type I18nText, type TranscribeResponse, type VoiceErrorCode } from '@agent-hub/shared';
import type { Config } from '../config.js';
import { HttpError } from '../sessions/service.js';
import { tr } from '../i18n.js';
import { ScribeClient, ScribeError, baseMime } from '../voice/elevenlabs.js';

const AUDIO_TYPES: ReadonlySet<string> = new Set(VOICE_AUDIO_TYPES);

/** An error of the endpoint: the code is one of the contract's (design D2). */
class VoiceError extends HttpError {
  declare readonly code: VoiceErrorCode;
  constructor(status: number, code: VoiceErrorCode, message: I18nText, details?: Record<string, string>) {
    super(status, code, message, details);
  }
}

/** `result` of the log line: `ok`, a contract code, `client_closed` or `internal` (D6). */
type VoiceResult = 'ok' | VoiceErrorCode | 'client_closed' | 'internal';

/** D6: size, time and result only — never the text or the key. */
function logResult(req: FastifyRequest, bytes: number, started: number, result: VoiceResult) {
  req.log.info({ bytes, ms: Date.now() - started, result }, 'voice transcribe');
}

export interface VoiceDeps {
  config: Config;
  /** Tests: replaces the global fetch of the ElevenLabs client. */
  fetch?: typeof fetch;
}

export function registerVoice(app: FastifyInstance, deps: VoiceDeps): void {
  const { config } = deps;
  const client = config.ELEVENLABS_API_KEY
    ? new ScribeClient({
        apiKey: config.ELEVENLABS_API_KEY,
        apiUrl: config.ELEVENLABS_API_URL,
        model: config.VOICE_MODEL,
        language: config.VOICE_LANGUAGE,
        timeoutMs: config.VOICE_TIMEOUT_MS,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      })
    : null;
  /** Transcriptions in flight in this hub process (no queue: one more gets 429, D2). */
  let busy = 0;
  /** Request → aborted when the client closes the connection before the answer (set by the preParsing hook). */
  const clientGone = new WeakMap<object, AbortSignal>();

  // Raw bytes of any type are read in this encapsulated scope only (the type is judged by the preParsing hook, so a wrong
  // type answers unsupported_audio rather than the generic 415); other routes keep JSON and the 1 MB limit.
  void app.register(async scope => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: VOICE_UPLOAD_LIMIT }, (_req, body, done) => done(null, body));

    // 503 and 415 are answered before the body is read (up to 12 MiB): preParsing runs after the common onRequest
    // hook, so 401/403 still come first.
    scope.addHook('preParsing', async (req, reply, payload) => {
      const refused = !client
        ? new VoiceError(503, 'voice_disabled', { key: 'hub.voice.disabled' })
        : !AUDIO_TYPES.has(baseMime(req.headers['content-type']))
          ? new VoiceError(415, 'unsupported_audio', { key: 'hub.voice.unsupportedAudio' })
          : null;
      if (refused) {
        logResult(req, 0, Date.now(), refused.code);
        throw refused;
      }
      // The client closing the connection before the answer is watched from here on: while the body is read, in
      // later hooks and during the ElevenLabs request. Not `req.raw.destroyed` — Node destroys the request stream
      // itself once the body has been read.
      const gone = new AbortController();
      reply.raw.once('close', () => {
        if (!reply.raw.writableFinished) gone.abort();
      });
      clientGone.set(req.raw, gone.signal);
      return payload;
    });

    scope.post('/api/voice/transcribe', { bodyLimit: VOICE_UPLOAD_LIMIT }, async (req, reply): Promise<TranscribeResponse | undefined> => {
      const started = Date.now();
      const body = Buffer.isBuffer(req.body) ? req.body : null;
      let result: VoiceResult = 'ok';
      try {
        // checked by the preParsing hook: here only for the type of `client`
        if (!client) throw new VoiceError(503, 'voice_disabled', { key: 'hub.voice.disabled' });
        if (!body || body.length === 0) throw new VoiceError(400, 'empty_audio', { key: 'hub.voice.emptyAudio' });
        if (busy >= config.VOICE_CONCURRENCY) {
          result = 'voice_busy';
          return reply
            .code(429)
            .header('Retry-After', '5')
            .send({ error: 'voice_busy' satisfies VoiceErrorCode, message: tr(req.locale).text('hub.voice.busy') });
        }
        const gone = clientGone.get(req.raw) ?? new AbortController().signal;
        // The client went away before the handler: ElevenLabs is not asked (the quota is not spent).
        if (gone.aborted) {
          result = 'client_closed';
          throw new VoiceError(502, 'voice_upstream_error', { key: 'hub.voice.cancelled' });
        }

        busy++;
        try {
          // The client going away during the request aborts it (D2 «Отмена»).
          const r = await client.transcribe(body, String(req.headers['content-type']), gone);
          return { text: r.text.trim() };
        } catch (err) {
          if (!(err instanceof ScribeError)) throw err;
          switch (err.kind) {
            case 'quota': {
              const resetAt = await client.subscriptionResetAt();
              throw new VoiceError(402, 'voice_quota_exceeded', { key: 'hub.voice.quota' }, resetAt ? { resetAt } : undefined);
            }
            case 'key':
              throw new VoiceError(502, 'voice_key_rejected', { key: 'hub.voice.keyRejected' });
            case 'timeout':
              throw new VoiceError(504, 'voice_timeout', { key: 'hub.voice.timeout' });
            case 'aborted':
              result = 'client_closed';
              throw new VoiceError(502, 'voice_upstream_error', { key: 'hub.voice.cancelled' });
            default:
              throw new VoiceError(502, 'voice_upstream_error', { key: 'hub.voice.failed' });
          }
        } finally {
          busy--;
        }
      } catch (err) {
        if (result === 'ok') result = err instanceof VoiceError ? err.code : 'internal';
        throw err;
      } finally {
        logResult(req, body?.length ?? 0, started, result);
      }
    });
  });
}
