// spec session-title: manual rename (PATCH title) and «Перегенерировать название» (POST …/title/regenerate)
// against a scripted agent.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionView } from '@agent-hub/shared';
import { PUBLIC_URL, agentSend, autoReply, connectFakeAgent, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';
import * as F from '../test/transcriptFixtures.js';
import { normalizeTitle } from './handoff.js';

// split so the publication guard does not mistake the fixture for a credential
const FAKE_GH_TOKEN = 'ghp' + '_abcdefghijklmnopqrstuvwxyz0123456789';

describe('session title (integration)', () => {
  let t: TestHub;
  let cookie: string;
  let hp: FakeAgent;
  const acked: string[] = [];
  const generated: Array<Record<string, unknown>> = [];
  let answer: () => unknown = () => ({ text: 'Правки Agent Hub' });
  const api = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
    t.hub.app.inject({ method, url, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, ...(payload !== undefined ? { payload: payload as object } : {}) });

  async function session(lines: (o: { sessionId: string; cwd: string; entrypoint: 'cli' }) => unknown[]) {
    const sid = randomUUID();
    const o = { sessionId: sid, cwd: 'C:\\work\\title', entrypoint: 'cli' as const };
    const rel = `c--work-title/${sid}.jsonl`;
    const before = acked.length;
    const body = lines(o);
    agentSend(hp, 'repl.chunk', {
      relPath: rel,
      kind: 'main',
      sessionId: sid,
      generation: 0,
      fromLine: 0,
      fromByte: 0,
      lines: body.map(l => JSON.stringify(l)),
      endByte: body.length * 100,
    });
    await waitFor(() => acked.length > before, 20_000);
    await t.hub.projects.flush();
    const id = (await t.tdb.pool.query<{ id: string }>(`SELECT id FROM sessions WHERE claude_session_id = $1`, [sid])).rows[0]!.id;
    await t.tdb.pool.query(`UPDATE sessions SET status = 'sleeping', process_alive = false WHERE id = $1`, [id]);
    return { id, sid, o, rel };
  }

  const row = async (id: string) => (await t.tdb.pool.query<{ title: string; title_source: string }>(`SELECT title, title_source FROM sessions WHERE id = $1`, [id])).rows[0]!;

  beforeAll(async () => {
    t = await startTestHub({ env: { HANDOFF_MODEL: 'haiku' }, sessions: { idleCheckMs: 0 } });
    const token = await t.addRunner('hp', 'HP');
    cookie = await t.login();
    hp = connectFakeAgent(t.wsBase, token);
    hp.ws.on('message', d => {
      const m = JSON.parse(d.toString()) as { type: string };
      if (m.type === 'repl.ack') acked.push(m.type);
    });
    autoReply(hp, (type, payload) => {
      if (type === 'handoff.generate') {
        generated.push(payload);
        return answer();
      }
      if (type === 'fs.stat') return { exists: true, isDir: true };
      throw Object.assign(new Error(`${type} not scripted`), { code: 'not_implemented' });
    });
    await hp.next('welcome');
  });
  afterAll(async () => t.close());

  it('renames a sleeping session: the title is custom, the session stays asleep, the transcript does not overwrite it', async () => {
    const s = await session(o => [F.userText(o, 'сделай отчёт по Selectel'), F.assistantText(o, 'Готовлю')]);
    const res = await api('PATCH', `/api/sessions/${s.id}`, { title: '  Релиз 0.5  ' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as SessionView).title).toBe('Релиз 0.5');
    expect(await row(s.id)).toEqual({ title: 'Релиз 0.5', title_source: 'custom' });
    expect((await t.tdb.pool.query(`SELECT status, process_alive FROM sessions WHERE id = $1`, [s.id])).rows[0]).toEqual({ status: 'sleeping', process_alive: false });
    // Claude Code writes a new ai-title afterwards: the manual title stays
    agentSend(hp, 'repl.chunk', {
      relPath: s.rel,
      kind: 'main',
      sessionId: s.sid,
      generation: 0,
      fromLine: 2,
      fromByte: 200,
      lines: [JSON.stringify(F.aiTitle(s.o, 'Другое название от Claude'))],
      endByte: 300,
    });
    await waitFor(() => acked.length >= 2, 20_000);
    expect(await row(s.id)).toEqual({ title: 'Релиз 0.5', title_source: 'custom' });
  });

  it('rejects an empty or too long title with 422/400 and keeps the old one', async () => {
    const s = await session(o => [F.userText(o, 'вопрос про VPN')]);
    const old = await row(s.id);
    for (const title of ['', '   ', 'x'.repeat(201)]) {
      const res = await api('PATCH', `/api/sessions/${s.id}`, { title });
      expect([400, 422]).toContain(res.statusCode);
    }
    expect(await row(s.id)).toEqual(old);
  });

  it('regenerates the title of a fork that moved to another topic: the model gets the head and the tail, the result is stored as custom', async () => {
    const s = await session(o => [
      F.userText(o, 'сделай отчёт по Selectel'),
      F.assistantText(o, 'Готовлю отчёт по Selectel'),
      F.userText(o, 'а теперь добавь в Agent Hub переименование сессий'),
      F.assistantText(o, 'Добавляю PATCH title и кнопку перегенерации'),
    ]);
    await t.tdb.pool.query(`UPDATE sessions SET title = 'Отчёт по Selectel (копия)', title_source = 'custom' WHERE id = $1`, [s.id]);
    generated.length = 0;
    answer = () => ({ text: '«Переименование сессий в Agent Hub.»\nлишняя строка' });
    const res = await api('POST', `/api/sessions/${s.id}/title/regenerate`);
    expect(res.statusCode).toBe(200);
    expect((res.json() as SessionView).title).toBe('Переименование сессий в Agent Hub');
    expect(await row(s.id)).toEqual({ title: 'Переименование сессий в Agent Hub', title_source: 'custom' });
    expect(generated).toHaveLength(1);
    expect(String(generated[0]!.model)).toMatch(/haiku/);
    const transcript = String(generated[0]!.transcript);
    expect(transcript).toContain('сделай отчёт по Selectel');
    expect(transcript).toContain('Добавляю PATCH title и кнопку перегенерации');
    expect(String(generated[0]!.systemPrompt)).toMatch(/другую сторону/);
  });

  it('does not send secrets to the model', async () => {
    const s = await session(o => [
      F.userText(o, `ключ -----BEGIN ${'PRIVATE'} KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQ\n-----END ${'PRIVATE'} KEY----- и токен ${FAKE_GH_TOKEN}`),
      F.assistantText(o, 'ок'),
    ]);
    generated.length = 0;
    answer = () => ({ text: 'Работа с ключами' });
    expect((await api('POST', `/api/sessions/${s.id}/title/regenerate`)).statusCode).toBe(200);
    const transcript = String(generated[0]!.transcript);
    expect(transcript).toContain('[REDACTED]');
    expect(transcript).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQ');
    expect(transcript).not.toContain(FAKE_GH_TOKEN);
  });

  it('keeps the old title and says why when the model answers nothing usable', async () => {
    const s = await session(o => [F.userText(o, 'вопрос про DNS'), F.assistantText(o, 'ответ')]);
    const old = await row(s.id);
    answer = () => ({ text: '  "." ' });
    const empty = await api('POST', `/api/sessions/${s.id}/title/regenerate`);
    expect(empty.statusCode).toBe(502);
    answer = () => {
      throw Object.assign(new Error('model down'), { code: 'generation_failed' });
    };
    expect((await api('POST', `/api/sessions/${s.id}/title/regenerate`)).statusCode).toBe(502);
    expect(await row(s.id)).toEqual(old);
    expect((await api('POST', `/api/sessions/${randomUUID()}/title/regenerate`)).statusCode).toBe(404);
  });

  it('refuses a session without messages with 422', async () => {
    const s = await session(o => [F.aiTitle(o, 'Пустая')]);
    const res = await api('POST', `/api/sessions/${s.id}/title/regenerate`);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'empty' });
  });

  it('answers 409 when no machine is online', async () => {
    const s = await session(o => [F.userText(o, 'вопрос'), F.assistantText(o, 'ответ')]);
    await t.tdb.pool.query(`UPDATE runners SET online = false WHERE id = 'hp'`);
    hp.ws.close();
    await waitFor(() => !t.hub.agents.isOnline('hp'), 10_000);
    const res = await api('POST', `/api/sessions/${s.id}/title/regenerate`);
    expect(res.statusCode).toBe(409);
  });
});

describe('normalizeTitle', () => {
  it.each([
    ['Правки Agent Hub', 'Правки Agent Hub'],
    ['«Правки Agent Hub.»', 'Правки Agent Hub'],
    ['"Fix build"\nпояснение', 'Fix build'],
    ['# Название: Починка сборки', 'Починка сборки'],
    ['- **Починка сборки**', 'Починка сборки'],
    ['   ', ''],
    ['.', ''],
  ])('%j → %j', (raw, expected) => {
    expect(normalizeTitle(raw)).toBe(expected);
  });

  it('truncates to 80 characters with an ellipsis', () => {
    const out = normalizeTitle('слово '.repeat(40));
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith('…')).toBe(true);
  });
});
