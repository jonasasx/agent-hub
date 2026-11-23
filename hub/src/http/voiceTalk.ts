// Voice conversation (change voice-conversation, design D1, D4, D5): GET /api/voice/talk starts a conversation with the
// ElevenLabs agent, POST /voice-llm/v1/chat/completions is the agent's Custom LLM. Requirements: Включение разговора;
// Начало разговора; Эндпоинт Custom LLM; Приватность разговора.
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { VOICE_REPORT_MARKER, voiceTalkQuerySchema, type I18nText, type VoiceErrorCode, type VoiceTalkErrorCode, type VoiceTalkResponse } from '@agent-hub/shared';
import type { Config } from '../config.js';
import { tr } from '../i18n.js';
import { HttpError } from '../sessions/service.js';
import { conversationSignedUrl, ScribeError } from '../voice/elevenlabs.js';
import { issueTalkToken, sameKey, verifyTalkToken } from '../voice/talkToken.js';
import { VoiceBridge, type BridgeSessions, type VoiceTurnResult } from '../voice/llmBridge.js';
import { CollectedSpeech, SseSpeech, type Speech } from '../voice/speech.js';

class VoiceTalkError extends HttpError {
  declare readonly code: VoiceTalkErrorCode | VoiceErrorCode | 'unauthenticated' | 'invalid_request';
  constructor(status: number, code: VoiceTalkError['code'], message: I18nText) {
    super(status, code, message);
  }
}

const disabled = () => new VoiceTalkError(503, 'voice_talk_disabled', { key: 'hub.voiceTalk.disabled' });
const REPLAY_WINDOW_MS = 30_000;
const REPLAY_LIMIT = 2048;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** The part of an OpenAI chat request the bridge reads; anything else ElevenLabs sends is ignored. */
const completionSchema = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.unknown() })).default([]),
  stream: z.boolean().optional(),
  elevenlabs_extra_body: z.object({ hub_token: z.unknown() }).partial().optional(),
});

/** `content` is a string or an array of parts with `text`. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(p => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join('');
}

export interface VoiceTalkDeps {
  config: Config;
  sessions: BridgeSessions;
  /** Tests: replaces the global fetch of the ElevenLabs request. */
  fetch?: typeof fetch;
  /** Tests: the heartbeat period of the stream. */
  heartbeatMs?: number;
}

export function registerVoiceTalk(app: FastifyInstance, deps: VoiceTalkDeps): void {
  const { config } = deps;
  const bridge = config.voiceTalkEnabled ? new VoiceBridge({ sessions: deps.sessions, maxTurnMs: config.VOICE_TURN_MAX_MS }) : null;
  const recent = new Map<string, { at: number; requestId: string }>();

  app.get('/api/voice/talk', async (req): Promise<VoiceTalkResponse> => {
    if (!config.voiceTalkEnabled) throw disabled();
    const q = voiceTalkQuerySchema.safeParse(req.query);
    if (!q.success) throw new HttpError(404, 'not_found', { key: 'hub.sessions.notFound' });
    const user = req.user!;
    // 404 for a session of another user, before ElevenLabs is asked
    const s = await deps.sessions.get(user.id, q.data.session);
    if (s.read_only_reason === 'cwd_missing') throw new HttpError(423, 'read_only', { key: 'hub.sessions.readOnlyCwdGone' });
    if (s.read_only_reason || s.source === 'cron') throw new HttpError(423, 'read_only', { key: 'hub.sessions.readOnlyCron' });
    let signedUrl: string;
    try {
      signedUrl = await conversationSignedUrl({
        apiKey: config.voiceAgentApiKey!,
        apiUrl: config.ELEVENLABS_API_URL,
        agentId: config.VOICE_AGENT_ID!,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      });
    } catch (err) {
      if (!(err instanceof ScribeError)) throw err;
      req.log.warn({ kind: err.kind, upstreamStatus: err.upstreamStatus }, 'voice talk: signed URL failed');
      throw new VoiceTalkError(502, 'voice_upstream_error', { key: 'hub.voiceTalk.upstream' });
    }
    return { signedUrl, token: issueTalkToken(config.VOICE_LLM_KEY!, { u: user.id, s: q.data.session, l: req.locale }) };
  });

  app.get('/api/voice/talk/report', async (req, reply) => {
    if (!bridge) throw disabled();
    const q = voiceTalkQuerySchema.safeParse(req.query);
    if (!q.success) throw new HttpError(404, 'not_found', { key: 'hub.sessions.notFound' });
    await deps.sessions.get(req.user!.id, q.data.session);
    reply.header('Cache-Control', 'no-store');
    return { ready: bridge.hasReport(q.data.session) };
  });

  app.post('/voice-llm/v1/chat/completions', async (req, reply) => {
    const started = Date.now();
    if (!bridge) throw disabled();
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (!sameKey(bearer, config.VOICE_LLM_KEY!)) throw new VoiceTalkError(401, 'unauthenticated', { key: 'hub.voiceTalk.unauthorized' });
    const body = completionSchema.safeParse(req.body ?? {});
    const token = body.success ? body.data.elevenlabs_extra_body?.hub_token : null;
    const claims = verifyTalkToken(config.VOICE_LLM_KEY!, token);
    if (!body.success || !claims || typeof token !== 'string') throw new VoiceTalkError(401, 'voice_talk_token', { key: 'hub.voiceTalk.token' });
    const messages = body.data.messages.map(m => ({ role: m.role, text: contentText(m.content).trim() }));
    const selected = messages.findLastIndex(m => m.role === 'user' || (m.role !== 'system' && m.text === VOICE_REPORT_MARKER));
    const text = messages[selected]?.text ?? '';
    if (!text) throw new VoiceTalkError(400, 'invalid_request', { key: 'hub.voiceTalk.noUtterance' });

    const users = messages.filter(m => m.role === 'user' && m.text && m.text !== VOICE_REPORT_MARKER);
    const call = digest(token);
    const report = text === VOICE_REPORT_MARKER;
    // Assistant output and report markers can change across delivery attempts without advancing the user's turn.
    const fingerprint = digest(JSON.stringify([call, users.map(m => m.text)]));
    let duplicateOf: string | undefined;
    if (!report) {
      const previous = recent.get(fingerprint);
      if (previous && started - previous.at < REPLAY_WINDOW_MS) {
        duplicateOf = previous.requestId;
      }
      recent.delete(fingerprint);
      recent.set(fingerprint, { at: started, requestId: duplicateOf ?? req.id });
      if (recent.size > REPLAY_LIMIT) recent.delete(recent.keys().next().value!);
    }
    const stream = body.data.stream !== false;
    const markerIndex = messages.findLastIndex(m => m.text === VOICE_REPORT_MARKER);
    const role = messages[markerIndex]?.role;
    req.log.info(
      {
        session: claims.s,
        call: call.slice(0, 12),
        stream,
        messages: messages.length,
        users: users.length,
        selected,
        markerIndex,
        markerRole: role && (['user', 'assistant', 'tool', 'system', 'developer'].includes(role) ? role : 'other'),
        report,
        duplicateOf,
      },
      'voice talk request',
    );
    const gone = new AbortController();
    const log = (result: VoiceTurnResult | 'duplicate') => req.log.info({ session: claims.s, chars: text.length, ms: Date.now() - started, result }, 'voice talk turn');
    const turn = { userId: claims.u, sessionId: claims.s, locale: claims.l };
    const answer = async (speech: Speech): Promise<void> => {
      if (duplicateOf) {
        speech.say(tr(claims.l).text('hub.voiceTalk.repeated'));
        speech.end();
        log('duplicate');
        return;
      }
      log(await bridge.answer(turn, text, speech, gone.signal));
    };

    if (!stream) {
      const speech = new CollectedSpeech();
      reply.raw.once('close', () => {
        if (!reply.raw.writableFinished) gone.abort();
      });
      await answer(speech);
      return speech.done;
    }

    reply.hijack();
    const speech = new SseSpeech(reply.raw, deps.heartbeatMs);
    reply.raw.once('close', () => {
      if (reply.raw.writableFinished) return;
      speech.close();
      gone.abort();
    });
    try {
      await answer(speech);
    } catch (err) {
      req.log.error({ err, session: claims.s }, 'voice talk turn failed');
      log('failed');
    } finally {
      speech.end();
    }
  });
}
