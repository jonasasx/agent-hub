// Change voice-conversation (tasks 2.x): GET /api/voice/talk and the Custom LLM endpoint on a fake agent and a mocked
// ElevenLabs. Requirements: Включение разговора; Начало разговора; Эндпоинт Custom LLM; Голосовая реплика в сессии;
// Приватность разговора.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseVoiceTurn, type SessionView, type VoiceTalkResponse } from '@agent-hub/shared';
import { PUBLIC_URL, agentSend, autoReply, connectFakeAgent, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';

const EL_KEY = 'sk_voice_talk_test_key_0123456789';
const AGENT_KEY = 'sk_voice_agent_test_key_0123456789';
const LLM_KEY = 'voice-llm-key-0123456789abcdef0123456789';
const AGENT = 'agent_test_voice';
const SIGNED = 'wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_test_voice&conversation_signature=sig';
const SECRET = 'секретная голосовая реплика';
const VAULT = 'C:\\Users\\alice\\vault';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The text and the finish of an SSE answer. */
function parseSse(body: string) {
  const events = body.split('\n\n').filter(Boolean);
  expect(events.at(-1)).toBe('data: [DONE]');
  const chunks = events.slice(0, -1).map(e => JSON.parse(e.replace(/^data: /, '')) as { choices: Array<{ delta: { content?: string }; finish_reason: string | null }> });
  return { text: chunks.map(c => c.choices[0]!.delta.content ?? '').join(''), finish: chunks.at(-1)!.choices[0]!.finish_reason };
}

describe('voice talk (integration)', () => {
  let t: TestHub;
  let cookie: string;
  let hp: FakeAgent;
  const logs: string[] = [];
  const got: Array<{ type: string; payload: Record<string, unknown> }> = [];
  let signedHandler: (url: string, init: RequestInit) => Promise<Response> = async () => json(200, { signed_url: SIGNED });
  const elCalls: Array<{ url: string; key: string | null }> = [];
  const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    elCalls.push({ url: String(input), key: new Headers(init.headers).get('xi-api-key') });
    return signedHandler(String(input), init);
  }) as typeof fetch;

  const api = (method: 'GET' | 'POST', url: string, c: string | null = cookie) => t.hub.app.inject({ method, url, ...(c ? { cookies: { ah_session: c } } : {}), headers: { origin: PUBLIC_URL } });
  const completion = (body: unknown, auth: string | null = `Bearer ${LLM_KEY}`) =>
    fetch(`${t.httpBase}/voice-llm/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify(body),
    });
  const sends = (sid: string) => got.filter(m => m.type === 'session.send' && m.payload.sessionId === sid);

  async function session(): Promise<{ id: string; sid: string }> {
    const r = await t.hub.app.inject({
      method: 'POST',
      url: '/api/sessions',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { runnerId: 'hp', cwd: VAULT, model: 'haiku', prompt: 'hi' },
    });
    expect(r.statusCode, r.body).toBe(201);
    const id = (r.json() as SessionView).id;
    const sid = (await t.tdb.pool.query(`SELECT claude_session_id FROM sessions WHERE id = $1`, [id])).rows[0].claude_session_id as string;
    agentSend(hp, 'session.result', { sessionId: sid, subtype: 'success', isError: false, durationMs: 1, costUsd: 0 });
    await waitFor(async () => (await t.tdb.pool.query(`SELECT status FROM sessions WHERE id = $1`, [id])).rows[0].status === 'waiting');
    return { id, sid };
  }
  async function talkToken(id: string): Promise<string> {
    const r = await api('GET', `/api/voice/talk?session=${id}`);
    expect(r.statusCode, r.body).toBe(200);
    return (r.json() as VoiceTalkResponse).token;
  }

  beforeAll(async () => {
    t = await startTestHub({
      env: {
        ELEVENLABS_API_KEY: EL_KEY,
        ELEVENLABS_API_URL: 'https://el.mock',
        VOICE_AGENT_ID: AGENT,
        VOICE_AGENT_API_KEY: AGENT_KEY,
        VOICE_LLM_KEY: LLM_KEY,
      },
      voice: { fetch: fakeFetch, heartbeatMs: 60_000 },
      sessions: { idleCheckMs: 0, initTimeoutMs: 3000 },
      logStream: { write: line => void logs.push(line) },
    });
    const token = await t.addRunner('hp', 'HP');
    cookie = await t.login();
    hp = connectFakeAgent(t.wsBase, token);
    hp.ws.on('message', d => got.push(JSON.parse(d.toString()) as { type: string; payload: Record<string, unknown> }));
    autoReply(hp, type => {
      if (type === 'fs.stat') return { exists: true, isDir: true };
      if (type === 'session.start' || type === 'session.resume') return { models: [] };
      return {};
    });
    await hp.next('welcome');
  });
  afterAll(async () => t.close());

  it('/api/me says voiceTalk: true and carries no key', async () => {
    const r = await api('GET', '/api/me');
    expect(r.json()).toMatchObject({ voiceTalk: true });
    expect(r.body).not.toContain(LLM_KEY);
    expect(r.body).not.toContain(EL_KEY);
    expect(r.body).not.toContain(AGENT_KEY);
  });

  it('GET /api/voice/talk: the signed URL of the agent and a token; the key goes only to ElevenLabs', async () => {
    const { id } = await session();
    elCalls.length = 0;
    const r = await api('GET', `/api/voice/talk?session=${id}`);
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json() as VoiceTalkResponse;
    expect(body.signedUrl).toBe(SIGNED);
    expect(body.token).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(r.body).not.toContain(LLM_KEY);
    expect(elCalls).toEqual([{ url: `https://el.mock/v1/convai/conversation/get-signed-url?agent_id=${AGENT}`, key: AGENT_KEY }]);
  });

  it('GET /api/voice/talk: 401 without a login, 404 for a bad or unknown session, 423 read-only, 502 upstream', async () => {
    const { id } = await session();
    elCalls.length = 0;
    expect((await api('GET', `/api/voice/talk?session=${id}`, null)).statusCode).toBe(401);
    expect((await api('GET', '/api/voice/talk?session=nope')).statusCode).toBe(404);
    expect((await api('GET', `/api/voice/talk?session=${randomUUID()}`)).statusCode).toBe(404);
    expect(elCalls).toHaveLength(0);
    await t.tdb.pool.query(`UPDATE sessions SET read_only_reason = 'cwd_missing' WHERE id = $1`, [id]);
    const ro = await api('GET', `/api/voice/talk?session=${id}`);
    expect(ro.statusCode).toBe(423);
    expect(ro.json()).toMatchObject({ error: 'read_only' });
    await t.tdb.pool.query(`UPDATE sessions SET read_only_reason = NULL WHERE id = $1`, [id]);
    signedHandler = async () => json(500, { detail: 'boom' });
    const up = await api('GET', `/api/voice/talk?session=${id}`);
    expect(up.statusCode).toBe(502);
    expect(up.json()).toMatchObject({ error: 'voice_upstream_error' });
    signedHandler = async () => json(200, { signed_url: SIGNED });
  });

  it('POST completions: 401 for a wrong bearer, 401 voice_talk_token for a bad token, 400 without an utterance', async () => {
    const { id } = await session();
    const token = await talkToken(id);
    const good = { messages: [{ role: 'user', content: 'привет' }], stream: true, elevenlabs_extra_body: { hub_token: token } };
    expect((await completion(good, null)).status).toBe(401);
    const wrong = await completion(good, 'Bearer not-the-key');
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ error: 'unauthenticated' });
    const bad = await completion({ ...good, elevenlabs_extra_body: { hub_token: `${token}x` } });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toMatchObject({ error: 'voice_talk_token' });
    const none = await completion({ ...good, messages: [{ role: 'system', content: 'ты ассистент' }] });
    expect(none.status).toBe(400);
    expect(await none.json()).toMatchObject({ error: 'invalid_request' });
    expect(sends((await t.tdb.pool.query(`SELECT claude_session_id FROM sessions WHERE id = $1`, [id])).rows[0].claude_session_id)).toHaveLength(0);
  });

  it('POST completions (stream): the utterance becomes a <voice-turn> of the session, the turn text is streamed back', async () => {
    const { id, sid } = await session();
    const token = await talkToken(id);
    logs.length = 0;
    const res = completion({
      messages: [
        { role: 'system', content: 'prompt' },
        { role: 'assistant', content: 'Слушаю' },
        { role: 'user', content: [{ type: 'text', text: SECRET }] },
      ],
      stream: true,
      elevenlabs_extra_body: { hub_token: token },
    });
    const send = await waitFor(() => sends(sid)[0]);
    expect(parseVoiceTurn(String(send.payload.text))?.text).toBe(SECRET);
    agentSend(hp, 'session.partial', { sessionId: sid, messageId: 'msg_1', blockIndex: 0, textDelta: 'Готово, ' });
    agentSend(hp, 'session.partial', { sessionId: sid, messageId: 'msg_1', blockIndex: 0, textDelta: 'файл создан.' });
    agentSend(hp, 'session.result', { sessionId: sid, subtype: 'success', isError: false, durationMs: 1, costUsd: 0 });
    const r = await res;
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/event-stream');
    expect(parseSse(await r.text())).toEqual({ text: 'Готово, файл создан.', finish: 'stop' });
    const line = await waitFor(() => logs.find(l => l.includes('voice talk turn')));
    expect(JSON.parse(line)).toMatchObject({ session: id, chars: SECRET.length, result: 'ok' });
    expect(logs.join('\n')).not.toContain(SECRET);
    expect(logs.join('\n')).not.toContain('файл создан');
  });

  it('POST completions (stream: false): one chat.completion', async () => {
    const { id, sid } = await session();
    const token = await talkToken(id);
    const res = completion({ messages: [{ role: 'user', content: 'сколько времени' }], stream: false, elevenlabs_extra_body: { hub_token: token } });
    await waitFor(() => sends(sid)[0]);
    agentSend(hp, 'session.partial', { sessionId: sid, messageId: 'msg_2', blockIndex: 0, textDelta: 'Полдень.' });
    agentSend(hp, 'session.result', { sessionId: sid, subtype: 'success', isError: false, durationMs: 1, costUsd: 0 });
    const r = await res;
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ object: 'chat.completion', choices: [{ message: { role: 'assistant', content: 'Полдень.' }, finish_reason: 'stop' }] });
  });

  it('POST completions: a busy session queues the utterance and says so', async () => {
    const { id, sid } = await session();
    const token = await talkToken(id);
    await t.tdb.pool.query(`UPDATE sessions SET status = 'working' WHERE id = $1`, [id]);
    const r = await completion({ messages: [{ role: 'user', content: 'ещё вопрос' }], stream: true, elevenlabs_extra_body: { hub_token: token } });
    const { text, finish } = parseSse(await r.text());
    expect(text).toContain('Сессия занята');
    expect(finish).toBe('stop');
    expect(sends(sid)).toHaveLength(1);
  });
});

describe('voice talk disabled (integration)', () => {
  let t: TestHub;
  let cookie: string;
  beforeAll(async () => {
    t = await startTestHub({ env: { ELEVENLABS_API_KEY: EL_KEY } });
    cookie = await t.login();
  });
  afterAll(async () => t.close());

  it('/api/me voiceTalk: false; both routes 503 voice_talk_disabled', async () => {
    const me = await t.hub.app.inject({ method: 'GET', url: '/api/me', cookies: { ah_session: cookie } });
    expect(me.json()).toMatchObject({ voiceTalk: false, voiceInput: true });
    const g = await t.hub.app.inject({ method: 'GET', url: `/api/voice/talk?session=${randomUUID()}`, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL } });
    expect(g.statusCode).toBe(503);
    expect(g.json()).toMatchObject({ error: 'voice_talk_disabled' });
    const p = await t.hub.app.inject({ method: 'POST', url: '/voice-llm/v1/chat/completions', payload: { messages: [] } });
    expect(p.statusCode).toBe(503);
  });
});
