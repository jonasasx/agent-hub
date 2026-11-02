// Tasks 2.4–2.7 and the server part of 2.10/2.12: every M2 endpoint of D10 against a real hub, Postgres and a
// scripted agent.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EventsPage, SessionView, SidebarResponse } from '@agent-hub/shared';
import { PUBLIC_URL, agentSend, autoReply, connectFakeAgent, connectUi, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';

const VAULT = 'C:\\Users\\alice\\vault';
let offsetMs = 0;
const clock = () => new Date(Date.now() + offsetMs);

/** Delivery grace (15 s in production): long enough that a repeat right after a reconnect beats it under a loaded run. */
const GRACE = 1000;

describe('sessions API (integration)', () => {
  let t: TestHub;
  let cookie: string;
  let cookieUser: string;
  let agent: FakeAgent;
  const got: Array<{ type: string; payload: Record<string, unknown> }> = [];
  /** Commands the fake agent fails: type → error code. */
  const failing = new Map<string, string>();
  const silent = new Set<string>();
  /** Commands on which the fake agent drops its connection instead of answering. */
  const dropOn = new Set<string>();
  /** Commands the fake agent acknowledges and then drops its connection (agent stopped right after cmd.ok). */
  const closeAfterOk = new Set<string>();
  let ui: ReturnType<typeof connectUi>;

  const api = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    t.hub.app.inject({ method, url, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  /** The last command of the type, optionally of one session (other tests' sessions run in the same hub). */
  const lastCmd = (type: string, sessionId?: string) => [...got].reverse().find(m => m.type === type && (!sessionId || m.payload.sessionId === sessionId))?.payload;

  async function startAgent(liveSessions: Array<{ sessionId: string; state: string }> = []) {
    const a = connectFakeAgent(t.wsBase, await tokenFor('hp'), { liveSessions });
    a.ws.on('message', d => {
      const m = JSON.parse(d.toString()) as { type: string; payload: Record<string, unknown> };
      got.push(m);
    });
    autoReply(a, (type, p) => {
      if (dropOn.has(type)) {
        a.ws.terminate();
        throw Object.assign(new Error('dropped'), { code: '__dropped' });
      }
      if (closeAfterOk.has(type)) setTimeout(() => a.ws.terminate(), 20);
      if (silent.has(type)) throw Object.assign(new Error('no reply'), { code: '__silent' });
      const code = failing.get(type);
      if (code) throw Object.assign(new Error(`${type} failed`), { code });
      if (type === 'fs.stat') return { exists: !String(p.path).includes('nope'), isDir: !String(p.path).includes('nope') };
      if (type === 'session.start' || type === 'session.resume') return { models: [{ value: 'haiku', displayName: 'Haiku' }] };
      return {};
    });
    await a.next('welcome');
    return a;
  }
  const tokens = new Map<string, string>();
  const tokenFor = async (id: string) => tokens.get(id)!;

  async function newSession(prompt = 'Скажи, на какой машине ты работаешь: выполни hostname', extra: Record<string, unknown> = {}): Promise<SessionView> {
    const r = await api('POST', '/api/sessions', { runnerId: 'hp', cwd: VAULT, model: 'haiku', prompt, ...extra });
    expect(r.statusCode).toBe(201);
    return r.json() as SessionView;
  }
  const getS = async (id: string) => (await api('GET', `/api/sessions/${id}`)).json() as SessionView;

  beforeAll(async () => {
    t = await startTestHub({ sessions: { now: clock, idleCheckMs: 0, initTimeoutMs: 1500, deliveryGraceMs: GRACE } });
    tokens.set('hp', await t.addRunner('hp', 'HP'));
    tokens.set('vm', await t.addRunner('vm', 'ВМ .3'));
    cookie = await t.login();
    cookieUser = ((await api('GET', '/api/me')).json() as { user: { id: string } }).user.id;
    agent = await startAgent();
    ui = connectUi(t.wsBase, cookie);
    await ui.open;
  });
  afterAll(async () => {
    ui.ws.close();
    await t.close();
  });

  describe('2.4 runner stat and session start', () => {
    it('GET /api/runners/:id/stat answers from the agent; offline runner → 409', async () => {
      expect((await api('GET', `/api/runners/hp/stat?path=${encodeURIComponent(VAULT)}`)).json()).toEqual({ exists: true, isDir: true });
      expect((await api('GET', '/api/runners/hp/stat?path=C%3A%5Cnope')).json()).toEqual({ exists: false, isDir: false });
      const off = await api('GET', '/api/runners/vm/stat?path=/home');
      expect(off.statusCode).toBe(409);
      expect(off.json()).toMatchObject({ error: 'runner_offline' });
    });

    it('Несуществующий каталог: 422 cwd_not_found with the machine name, no session', async () => {
      const r = await api('POST', '/api/sessions', { runnerId: 'hp', cwd: 'C:\\nope', model: 'haiku', prompt: 'x' });
      expect(r.statusCode).toBe(422);
      expect(r.json()).toEqual({ error: 'cwd_not_found', message: 'Каталог не найден на HP' });
      const n = await t.tdb.pool.query(`SELECT count(*)::int AS n FROM sessions`);
      expect(n.rows[0].n).toBe(0);
    });

    it('offline runner → 409 runner_offline', async () => {
      const r = await api('POST', '/api/sessions', { runnerId: 'vm', cwd: '/home/ubuntu', model: 'haiku', prompt: 'x' });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({ error: 'runner_offline', message: 'ВМ .3 не в сети' });
    });

    it('201: session.start with the hub id, bypassPermissions by default, settings of the form', async () => {
      const s = await newSession();
      expect(s).toMatchObject({ runnerId: 'hp', cwd: VAULT, status: 'working', source: 'hub', isHubManaged: true, permissionMode: 'bypassPermissions', model: 'haiku', processAlive: true });
      expect(s.title).toBe(`${'Скажи, на какой машине ты работаешь: выполни hostname'.slice(0, 40)}…`);
      const start = await waitFor(() => lastCmd('session.start'));
      expect(start).toMatchObject({ sessionId: s.id, cwd: VAULT, permissionMode: 'bypassPermissions', model: 'haiku', prompt: 'Скажи, на какой машине ты работаешь: выполни hostname' });
      await waitFor(() => ui.received.some(m => m.type === 'session.upsert' && (m.session as SessionView).id === s.id));
      // Models reported by the agent replace the default list.
      await waitFor(async () => ((await api('GET', '/api/models')).json() as Array<{ value: string }>)[0]?.value === 'haiku');
    });
  });

  describe('2.7 chat events of a hub session', () => {
    it('repl.chunk is stored, acked and pushed to subscribers; GET events pages from the end', async () => {
      const s = await newSession('запомни число 4817');
      ui.send({ type: 'subscribe', sessionIds: [s.id] });
      await waitFor(() => t.hub.ui.isSubscribed(s.id));
      const rel = `C--Users-alice-vault/${s.id}.jsonl`;
      const ts = (n: number) => new Date(Date.UTC(2026, 9, 25, 10, 0, n)).toISOString();
      const lines = [
        JSON.stringify({ type: 'user', uuid: randomUUID(), timestamp: ts(1), cwd: VAULT, gitBranch: 'master', message: { role: 'user', content: 'запомни число 4817' } }),
        JSON.stringify({ type: 'attachment', timestamp: ts(2), attachment: { big: 'x' } }),
        JSON.stringify({
          type: 'assistant',
          uuid: randomUUID(),
          timestamp: ts(3),
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'hm', signature: 'SIG' },
              { type: 'text', text: 'Запомнил.' },
            ],
          },
        }),
        JSON.stringify({ type: 'ai-title', aiTitle: 'Запомнить число', sessionId: s.id }),
      ];
      agentSend(agent, 'session.partial', { sessionId: s.id, messageId: 'msg_1', blockIndex: 0, textDelta: 'Запом' });
      agentSend(agent, 'repl.chunk', { relPath: rel, kind: 'main', sessionId: s.id, generation: 0, fromLine: 0, fromByte: 0, lines, endByte: 999 });
      const ack = await waitFor(() => got.find(m => m.type === 'repl.ack' && m.payload.relPath === rel));
      expect(ack.payload).toEqual({ relPath: rel, generation: 0, ackedLine: 4, ackedByte: 999 });
      const pushed = await waitFor(() => ui.received.find(m => m.type === 'session.events' && m.sessionId === s.id));
      expect((pushed.events as unknown[]).length).toBe(3); // attachment is not stored
      expect(ui.received.some(m => m.type === 'session.partial' && m.textDelta === 'Запом')).toBe(true);

      // A resent chunk (lost ack) does not duplicate events.
      agentSend(agent, 'repl.chunk', { relPath: rel, kind: 'main', sessionId: s.id, generation: 0, fromLine: 0, fromByte: 0, lines, endByte: 999 });
      await waitFor(() => got.filter(m => m.type === 'repl.ack' && m.payload.relPath === rel).length === 2);

      const page = (await api('GET', `/api/sessions/${s.id}/events?limit=200`)).json() as EventsPage;
      const kinds = page.events.map(e => (e.kind === 'line' ? `line:${e.line.type}` : e.kind));
      expect(kinds).toEqual(['line:user', 'line:assistant', 'line:ai-title']);
      const assistant = page.events[1]!;
      expect(JSON.stringify(assistant)).not.toContain('SIG');
      expect(page.before).toBeNull();
      const p1 = (await api('GET', `/api/sessions/${s.id}/events?limit=2`)).json() as EventsPage;
      expect(p1.events.map(e => e.id)).toEqual(page.events.slice(1).map(e => e.id));
      const p2 = (await api('GET', `/api/sessions/${s.id}/events?limit=2&before=${p1.before}`)).json() as EventsPage;
      expect(p2.events.map(e => e.id)).toEqual([page.events[0]!.id]);
      expect(p2.before).toBeNull();

      const view = await getS(s.id);
      expect(view.title).toBe('Запомнить число');
      expect(view.lastEventAt).toBe(ts(3));
      // welcome cursors on reconnect come from the stored file
      const welcome = await (async () => {
        const a2 = connectFakeAgent(t.wsBase, await tokenFor('hp'));
        const w = await a2.next('welcome');
        a2.ws.close();
        return w;
      })();
      expect((welcome.payload as { cursors: unknown[] }).cursors).toContainEqual({ relPath: rel, generation: 0, ackedLine: 4, ackedByte: 999 });
      agent = await startAgent([{ sessionId: s.id, state: 'working' }]);
    });
  });

  describe('2.5 messages, interrupt, mode/model, permissions', () => {
    let s: SessionView;
    beforeAll(async () => {
      s = await newSession('первое');
      agentSend(agent, 'session.result', { sessionId: s.id, subtype: 'success', isError: false, durationMs: 10, costUsd: 0 });
      await waitFor(async () => (await getS(s.id)).status === 'waiting');
    });

    it('result without a visible client marks unread; presence clears it', async () => {
      expect((await getS(s.id)).unread).toBe(true);
      ui.send({ type: 'presence', visible: true, activeSessionIds: [s.id] });
      await waitFor(async () => !(await getS(s.id)).unread);
    });

    it('message to a live session goes to session.send; a repeated clientUuid is not sent twice', async () => {
      const clientUuid = randomUUID();
      const r = await api('POST', `/api/sessions/${s.id}/messages`, { text: 'второе', clientUuid });
      expect(r.statusCode).toBe(202);
      expect((r.json() as { session: SessionView }).session.status).toBe('working');
      expect(lastCmd('session.send')).toEqual({ sessionId: s.id, text: 'второе', promptUuid: clientUuid });
      await api('POST', `/api/sessions/${s.id}/messages`, { text: 'второе', clientUuid });
      expect(got.filter(m => m.type === 'session.send' && m.payload.promptUuid === clientUuid)).toHaveLength(1);
    });

    it('interrupt → agent interrupt, note «Ход прерван», waiting; not running → 409', async () => {
      const r = await api('POST', `/api/sessions/${s.id}/interrupt`);
      expect(r.statusCode).toBe(202);
      expect(lastCmd('session.interrupt')).toEqual({ sessionId: s.id });
      expect((r.json() as { session: SessionView }).session.status).toBe('waiting');
      const page = (await api('GET', `/api/sessions/${s.id}/events`)).json() as EventsPage;
      expect(page.events.some(e => e.kind === 'note' && e.text === 'Ход прерван')).toBe(true);
    });

    it('PATCH mode and model go to the live process; toast «mode_changed»; idle timeout validated', async () => {
      const r = await api('PATCH', `/api/sessions/${s.id}`, { permissionMode: 'plan', model: 'sonnet', idleTimeoutMin: 15 });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ permissionMode: 'plan', model: 'sonnet', idleTimeoutMin: 15, effectiveIdleTimeoutMin: 15 });
      expect(lastCmd('session.set_mode')).toEqual({ sessionId: s.id, mode: 'plan' });
      expect(lastCmd('session.set_model')).toEqual({ sessionId: s.id, model: 'sonnet' });
      await waitFor(() => ui.received.some(m => m.type === 'toast' && m.kind === 'mode_changed' && m.sessionId === s.id));
      expect((await api('PATCH', `/api/sessions/${s.id}`, { idleTimeoutMin: 7 })).statusCode).toBe(400);
      expect((await api('PATCH', `/api/sessions/${s.id}`, { permissionMode: 'dontAsk' })).statusCode).toBe(400);
      await api('PATCH', `/api/sessions/${s.id}`, { permissionMode: 'default', idleTimeoutMin: null });
    });

    it('permission request → card; allow_session → permission.response scope session; second answer → 409', async () => {
      ui.send({ type: 'subscribe', sessionIds: [s.id] });
      await waitFor(() => t.hub.ui.isSubscribed(s.id));
      const requestId = randomUUID();
      agentSend(agent, 'session.state', { sessionId: s.id, state: 'permission', processAlive: true });
      agentSend(agent, 'permission.request', { requestId, sessionId: s.id, toolName: 'Bash', toolUseId: 'toolu_1', input: { command: 'hostname' }, suggestions: [] });
      await waitFor(() => ui.received.some(m => m.type === 'permission.request' && (m.request as { requestId: string }).requestId === requestId));
      expect((await getS(s.id)).status).toBe('permission');
      const r = await api('POST', `/api/sessions/${s.id}/permissions/${requestId}`, { decision: 'allow_session' });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ request: { requestId, decision: 'allow_session', toolName: 'Bash' } });
      await waitFor(() => got.find(m => m.type === 'permission.response' && m.payload.requestId === requestId));
      expect(lastCmd('permission.response')).toEqual({ requestId, behavior: 'allow', scope: 'session' });
      await waitFor(() => ui.received.some(m => m.type === 'permission.resolved' && m.requestId === requestId));
      expect((await getS(s.id)).status).toBe('working');
      const again = await api('POST', `/api/sessions/${s.id}/permissions/${requestId}`, { decision: 'deny' });
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ error: 'already_resolved' });
    });

    it('M4b: a question of AskUserQuestion — structured questions, answers to the agent, 422 without an answer; a plan — «Продолжить планирование» with the comment', async () => {
      const requestId = randomUUID();
      const input = {
        questions: [
          {
            question: 'Какую букву выбрать?',
            header: 'Буква',
            options: [
              { label: 'A', description: 'первая' },
              { label: 'B', description: 'вторая' },
            ],
            multiSelect: false,
          },
          {
            question: 'Какие цвета?',
            header: 'Цвета',
            options: [
              { label: 'Красный', description: '' },
              { label: 'Синий', description: '' },
            ],
            multiSelect: true,
          },
        ],
      };
      agentSend(agent, 'session.state', { sessionId: s.id, state: 'permission', processAlive: true });
      agentSend(agent, 'permission.request', { requestId, sessionId: s.id, toolName: 'AskUserQuestion', toolUseId: 'toolu_q', input, suggestions: [], kind: 'question' });
      const shown = await waitFor(() => ui.received.find(m => m.type === 'permission.request' && (m.request as { requestId: string }).requestId === requestId));
      expect(shown.request).toMatchObject({
        kind: 'question',
        questions: [
          {
            question: 'Какую букву выбрать?',
            header: 'Буква',
            options: [
              { label: 'A', description: 'первая' },
              { label: 'B', description: 'вторая' },
            ],
            multiSelect: false,
          },
          { multiSelect: true },
        ],
        answers: null,
      });
      expect((await api('POST', `/api/sessions/${s.id}/permissions/${requestId}`, { decision: 'allow_session' })).json()).toMatchObject({ error: 'bad_decision' });
      const missing = await api('POST', `/api/sessions/${s.id}/permissions/${requestId}`, { decision: 'allow', answers: { 'Какую букву выбрать?': 'B' } });
      expect(missing.statusCode).toBe(422);
      expect(missing.json()).toMatchObject({ error: 'bad_answers', message: 'Нет ответа на вопрос «Какие цвета?»' });
      const ok = await api('POST', `/api/sessions/${s.id}/permissions/${requestId}`, { decision: 'allow', answers: { 'Какую букву выбрать?': 'B', 'Какие цвета?': ['Красный', 'Синий'] } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ request: { decision: 'allow', kind: 'question', answers: { 'Какую букву выбрать?': 'B', 'Какие цвета?': 'Красный, Синий' } } });
      await waitFor(() => got.find(m => m.type === 'permission.response' && m.payload.requestId === requestId));
      expect(lastCmd('permission.response')).toEqual({ requestId, behavior: 'allow', scope: 'once', answers: { 'Какую букву выбрать?': 'B', 'Какие цвета?': 'Красный, Синий' } });

      const planId = randomUUID();
      agentSend(agent, 'session.state', { sessionId: s.id, state: 'permission', processAlive: true });
      agentSend(agent, 'permission.request', {
        requestId: planId,
        sessionId: s.id,
        toolName: 'ExitPlanMode',
        toolUseId: 'toolu_p',
        input: { plan: '# План\n1. создать файл', planFilePath: 'C:/p.md' },
        suggestions: [],
      });
      const plan = await waitFor(() => ui.received.find(m => m.type === 'permission.request' && (m.request as { requestId: string }).requestId === planId));
      expect(plan.request).toMatchObject({ kind: 'plan', plan: '# План\n1. создать файл' });
      const back = await api('POST', `/api/sessions/${s.id}/permissions/${planId}`, { decision: 'deny', message: 'Добавь проверку файла' });
      expect(back.json()).toMatchObject({ request: { decision: 'deny', kind: 'plan', message: 'Добавь проверку файла' } });
      await waitFor(() => got.find(m => m.type === 'permission.response' && m.payload.requestId === planId));
      expect(lastCmd('permission.response')).toEqual({ requestId: planId, behavior: 'deny', scope: 'once', message: 'Добавь проверку файла' });
      // the user's choice wins: a stale state with the old mode after a PATCH does not bring bypass back
      await t.tdb.pool.query(`UPDATE sessions SET permission_mode = 'bypassPermissions', status = 'working', process_alive = true WHERE id = $1`, [s.id]);
      expect((await api('PATCH', `/api/sessions/${s.id}`, { permissionMode: 'default' })).statusCode).toBe(200);
      expect((await getS(s.id)).permissionMode).toBe('default');
      agentSend(agent, 'session.state', { sessionId: s.id, state: 'working', processAlive: true, permissionMode: 'bypassPermissions' });
      agentSend(agent, 'session.state', { sessionId: s.id, state: 'waiting', processAlive: true, permissionMode: 'bypassPermissions' });
      await waitFor(async () => (await getS(s.id)).status === 'waiting');
      expect((await getS(s.id)).permissionMode).toBe('default');
      expect((await t.tdb.pool.query(`SELECT permission_mode FROM sessions WHERE id = $1`, [s.id])).rows[0].permission_mode).toBe('default');
      // the plan approved later: the process reports its actual mode, the hub stores it (a resume starts with it)
      await t.tdb.pool.query(`UPDATE sessions SET permission_mode = 'plan' WHERE id = $1`, [s.id]);
      agentSend(agent, 'session.state', { sessionId: s.id, state: 'working', processAlive: true, permissionMode: 'default' });
      await waitFor(async () => (await getS(s.id)).permissionMode === 'default');
      await waitFor(() => ui.received.some(m => m.type === 'session.upsert' && (m.session as SessionView).id === s.id && (m.session as SessionView).permissionMode === 'default'));
    });

    it('a request cancelled by the agent (state leaves permission) is closed for the clients', async () => {
      const requestId = randomUUID();
      agentSend(agent, 'permission.request', { requestId, sessionId: s.id, toolName: 'Edit', toolUseId: 'toolu_2', input: {}, suggestions: [] });
      await waitFor(async () => (await getS(s.id)).status === 'permission');
      agentSend(agent, 'session.state', { sessionId: s.id, state: 'waiting', processAlive: true });
      await waitFor(() => ui.received.some(m => m.type === 'permission.resolved' && m.requestId === requestId && m.decision === 'deny'));
    });

    it('crash → waiting with a note; next message resumes', async () => {
      agentSend(agent, 'session.exited', { sessionId: s.id, code: 1, reason: 'crashed', errorText: 'boom' });
      await waitFor(async () => !(await getS(s.id)).processAlive);
      expect((await getS(s.id)).status).toBe('waiting');
      const r = await api('POST', `/api/sessions/${s.id}/messages`, { text: 'ты тут?', clientUuid: randomUUID() });
      expect(r.statusCode).toBe(202);
      // The command reaches the fake agent's socket a moment after the HTTP answer: wait for it.
      const resume = await waitFor(() => got.filter(m => m.type === 'session.resume' && m.payload.prompt === 'ты тут?').at(-1));
      expect(resume.payload).toMatchObject({ sessionId: s.id, cwd: VAULT, prompt: 'ты тут?', permissionMode: 'default', model: 'sonnet' });
    });
  });

  describe('2.6 idle sleep with a fake clock, resume, external writes', () => {
    it('waiting falls asleep after 30 min, working never; permission after 2 h with a deny', async () => {
      offsetMs = 0;
      const w = await newSession('w');
      const k = await newSession('k');
      const p = await newSession('p');
      agentSend(agent, 'session.result', { sessionId: w.id, subtype: 'success', isError: false, durationMs: 1, costUsd: 0 });
      const requestId = randomUUID();
      agentSend(agent, 'permission.request', { requestId, sessionId: p.id, toolName: 'Bash', toolUseId: 't', input: {}, suggestions: [] });
      await waitFor(async () => (await getS(w.id)).status === 'waiting' && (await getS(p.id)).status === 'permission');
      expect((await getS(w.id)).sleepsAt).not.toBeNull();

      offsetMs = 29 * 60_000;
      expect(await t.hub.sessions.checkIdle()).toBe(0);
      offsetMs = 31 * 60_000;
      await t.hub.sessions.checkIdle();
      expect((await getS(w.id)).status).toBe('sleeping');
      expect(got.some(m => m.type === 'session.stop' && m.payload.sessionId === w.id && m.payload.reason === 'sleep')).toBe(true);
      expect((await getS(k.id)).status).toBe('working'); // a turn is never interrupted by sleep
      expect((await getS(p.id)).status).toBe('permission'); // 31 min of waiting for permission: awake

      offsetMs = 121 * 60_000;
      await t.hub.sessions.checkIdle();
      expect((await getS(p.id)).status).toBe('sleeping');
      expect(lastCmd('permission.response')).toMatchObject({ requestId, behavior: 'deny' });
      const page = (await api('GET', `/api/sessions/${p.id}/events`)).json() as EventsPage;
      const req = page.events.find(e => e.kind === 'permission');
      expect(req).toMatchObject({ request: { decision: 'deny', message: 'уснула, не дождавшись разрешения' } });
      expect((await getS(k.id)).status).toBe('working');
      offsetMs = 0;
    });

    it('«не усыплять» (0) keeps a waiting session awake', async () => {
      const s = await newSession('n');
      await api('PATCH', `/api/sessions/${s.id}`, { idleTimeoutMin: 0 });
      agentSend(agent, 'session.result', { sessionId: s.id, subtype: 'success', isError: false, durationMs: 1, costUsd: 0 });
      await waitFor(async () => (await getS(s.id)).status === 'waiting');
      offsetMs = 10 * 60 * 60_000;
      await t.hub.sessions.checkIdle();
      expect((await getS(s.id)).status).toBe('waiting');
      offsetMs = 0;
    });

    it('message to a sleeping session resumes it with the prompt and a note; wake resumes without one', async () => {
      const s = await newSession('a');
      await t.tdb.pool.query(`UPDATE sessions SET status = 'sleeping', process_alive = false WHERE id = $1`, [s.id]);
      const r = await api('POST', `/api/sessions/${s.id}/messages`, { text: 'какое число я просил запомнить?', clientUuid: randomUUID() });
      expect(r.statusCode).toBe(202);
      // Only this session's commands: a resume of another test's session may arrive in between (flake in the full run).
      const mine = () => got.filter(m => m.type === 'session.resume' && m.payload.sessionId === s.id);
      await waitFor(() => mine().length === 1);
      expect(mine()[0]!.payload).toMatchObject({ sessionId: s.id, prompt: 'какое число я просил запомнить?' });
      const page = (await api('GET', `/api/sessions/${s.id}/events`)).json() as EventsPage;
      expect(page.events.some(e => e.kind === 'note' && e.text === 'Поднята через resume')).toBe(true);

      await t.tdb.pool.query(`UPDATE sessions SET status = 'sleeping', process_alive = false WHERE id = $1`, [s.id]);
      const before = mine().length;
      const wk = await api('POST', `/api/sessions/${s.id}/wake`, {});
      expect(wk.statusCode).toBe(202);
      expect((wk.json() as { session: SessionView }).session.status).toBe('waiting');
      await waitFor(() => mine().length === before + 1);
      const resumes = mine();
      expect(resumes.length).toBe(before + 1);
      expect(resumes.at(-1)!.payload.prompt).toBeUndefined();
    });

    it('B1 / Сессия ещё жива в терминале: 409 concurrent_external → the same clientUuid with force:true resumes', async () => {
      const s = await newSession('b');
      await t.tdb.pool.query(`UPDATE sessions SET status = 'closed', process_alive = false, last_external_write_at = now() - interval '2 minutes' WHERE id = $1`, [s.id]);
      // Like the web: «Продолжить всё равно» repeats the refused message with the same clientUuid and force.
      const clientUuid = randomUUID();
      const r = await api('POST', `/api/sessions/${s.id}/messages`, { text: 'какое слово?', clientUuid });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toEqual({ error: 'concurrent_external', message: 'Сессия, возможно, открыта в терминале на HP' });
      expect((await api('POST', `/api/sessions/${s.id}/wake`, {})).statusCode).toBe(409);
      const resumes = got.filter(m => m.type === 'session.resume').length;
      const f = await api('POST', `/api/sessions/${s.id}/messages`, { text: 'какое слово?', clientUuid, force: true });
      expect(f.statusCode).toBe(202);
      expect((f.json() as { session: SessionView }).session.status).toBe('working');
      await waitFor(() => got.filter(m => m.type === 'session.resume').length === resumes + 1);
      expect(await waitFor(() => lastCmd('session.resume', s.id))).toMatchObject({ sessionId: s.id, prompt: 'какое слово?', promptUuid: clientUuid });
      // The delivered message repeated (lost response): no second resume.
      await api('POST', `/api/sessions/${s.id}/messages`, { text: 'какое слово?', clientUuid, force: true });
      expect(got.filter(m => m.type === 'session.resume').length).toBe(resumes + 1);
      await t.tdb.pool.query(`UPDATE sessions SET last_external_write_at = now() - interval '11 minutes', status = 'closed', process_alive = false WHERE id = $1`, [s.id]);
      expect((await api('POST', `/api/sessions/${s.id}/messages`, { text: 'и ещё', clientUuid: randomUUID() })).statusCode).toBe(202);
    });

    it('resume that does not reach init within the timeout puts the session to sleep with a note', async () => {
      const s = await newSession('c');
      await t.tdb.pool.query(`UPDATE sessions SET status = 'sleeping', process_alive = false WHERE id = $1`, [s.id]);
      silent.add('session.resume');
      try {
        expect((await api('POST', `/api/sessions/${s.id}/messages`, { text: 'x', clientUuid: randomUUID() })).statusCode).toBe(202);
        await waitFor(async () => (await getS(s.id)).status === 'sleeping', 5000);
      } finally {
        silent.delete('session.resume');
      }
      const page = (await api('GET', `/api/sessions/${s.id}/events`)).json() as EventsPage;
      expect(page.events.some(e => e.kind === 'note' && e.text.startsWith('Не удалось поднять сессию'))).toBe(true);
    });

    it('read-only: cron → 423; missing directory → 423 and read_only_reason cwd_missing', async () => {
      const cron = await newSession('d');
      await t.tdb.pool.query(`UPDATE sessions SET source = 'cron', status = 'closed', process_alive = false WHERE id = $1`, [cron.id]);
      const c = await api('POST', `/api/sessions/${cron.id}/messages`, { text: 'x', clientUuid: randomUUID() });
      expect(c.statusCode).toBe(423);
      expect(c.json()).toMatchObject({ error: 'read_only' });
      const s = await newSession('d2');
      await t.tdb.pool.query(`UPDATE sessions SET source = 'terminal', status = 'closed', process_alive = false, cwd = 'C:\\nope\\gone' WHERE id = $1`, [s.id]);
      const m = await api('POST', `/api/sessions/${s.id}/messages`, { text: 'x', clientUuid: randomUUID() });
      expect(m.statusCode).toBe(423);
      expect(m.json()).toEqual({ error: 'read_only', message: 'Каталог проекта на машине удалён — только чтение' });
      expect((await getS(s.id)).readOnlyReason).toBe('cwd_missing');
      expect((await api('PATCH', `/api/sessions/${s.id}`, { model: 'opus' })).statusCode).toBe(423);
    });

    it('reconnect: hub sessions missing from liveSessions fall asleep, listed ones take the reported state', async () => {
      const a = await newSession('e');
      const b = await newSession('f');
      agent.ws.close();
      await waitFor(() => !t.hub.agents.isOnline('hp'));
      const off = await api('POST', `/api/sessions/${a.id}/messages`, { text: 'x', clientUuid: randomUUID() });
      expect(off.statusCode).toBe(409);
      expect(off.json()).toMatchObject({ error: 'runner_offline' });
      agent = await startAgent([{ sessionId: b.id, state: 'waiting' }]);
      // Reconcile applies sessions one by one: wait for both instead of reading b right after a changed.
      await waitFor(async () => (await getS(a.id)).status === 'sleeping');
      await waitFor(async () => {
        const v = await getS(b.id);
        return v.status === 'waiting' && v.processAlive;
      });
    });
  });

  describe('sidebar (2.9 data)', () => {
    it('«Сейчас» holds permission/unread/working of online machines, ordered; cron hidden by default', async () => {
      const sb = (await api('GET', '/api/sidebar')).json() as SidebarResponse;
      expect(sb.now.every(x => x.status === 'working' || x.status === 'permission' || x.unread)).toBe(true);
      const rank = (x: SessionView) => (x.status === 'permission' || x.unread ? 0 : 1);
      expect(sb.now.map(rank)).toEqual([...sb.now.map(rank)].sort());
      expect(sb.projects).toHaveLength(1);
      expect(sb.projects[0]!.project).toEqual({ id: null, title: 'Без проекта', colorKey: 'none', path: '' });
      expect(sb.projects[0]!.sessions).toHaveLength(5);
      const total = sb.projects[0]!.total;
      const withCron = (await api('GET', '/api/sidebar?cron=1')).json() as SidebarResponse;
      expect(withCron.projects[0]!.total).toBe(total + 1); // the cron session of the read-only test
      expect(sb.runners.find(r => r.id === 'hp')).toMatchObject({ online: true, vaultRoot: VAULT, homeDir: 'C:\\Users\\alice' });
      const more = (await api('GET', '/api/projects/none/sessions?offset=5&limit=100')).json() as { sessions: SessionView[]; total: number };
      expect(more.total).toBe(total);
      expect(more.sessions).toHaveLength(total - 5);
    });

    it('another user cannot read a session', async () => {
      const s = (await api('GET', '/api/sidebar')).json() as SidebarResponse;
      const id = s.projects[0]!.sessions[0]!.id;
      await t.tdb.pool.query(`INSERT INTO users (email) VALUES ('other@example.com')`);
      const other = await t.tdb.pool.query<{ id: string }>(`SELECT id FROM users WHERE email = 'other@example.com'`);
      const r = await t.tdb.pool.query(`SELECT count(*)::int AS n FROM sessions WHERE id = $1 AND user_id = $2`, [id, other.rows[0]!.id]);
      expect(r.rows[0].n).toBe(0);
      expect((await api('GET', `/api/sessions/${randomUUID()}`)).statusCode).toBe(404);
      expect((await api('GET', '/api/sessions/not-a-uuid')).statusCode).toBe(404);
    });
  });

  describe('2.17 window workspace: layout template, paths by runner OS, presence per connection', () => {
    const ws = (tabs: string[]) => ({
      layout: { type: 'leaf', pane: 'p1' },
      panes: { p1: { id: 'p1', tabs, active: tabs[0] ?? null } },
      focus: 'p1',
      seq: 1,
    });

    it('PUT from two windows in a row: GET returns the second; no WS message about tabs or layout', async () => {
      const list = (await api('GET', '/api/projects/none/sessions?limit=100')).json() as { sessions: SessionView[] };
      const [a, b] = list.sessions.map(x => x.id);
      const before = ui.received.length;
      const r1 = await api('PUT', '/api/layout', { device: 'desktop', layout: ws([a!]), savedLayout: null, openedAt: { [a!]: new Date().toISOString() } });
      expect(r1.statusCode).toBe(200);
      const r2 = await api('PUT', '/api/layout', { device: 'desktop', layout: ws([b!]), savedLayout: null, openedAt: null, version: 7 });
      expect(r2.statusCode).toBe(200);
      expect(Date.parse((r2.json() as { updatedAt: string }).updatedAt)).not.toBeNaN();
      const g = (await api('GET', '/api/layout?device=desktop')).json() as { layout: unknown; openedAt: unknown; updatedAt: string };
      expect(g.layout).toEqual(ws([b!]));
      expect(g.openedAt).toBeNull();
      expect(g.updatedAt).toBe((r2.json() as { updatedAt: string }).updatedAt);
      expect((await api('GET', '/api/layout?device=phone')).json()).toEqual({ layout: null, savedLayout: null, openedAt: null, tabKinds: null, updatedAt: null });
      // kinds of tabs that are not sessions (subagent chats, change `subagents` S9) come back as sent
      const sub = '00000000-0000-4000-8000-000000000001';
      expect((await api('PUT', '/api/layout', { device: 'phone', layout: ws([a!, sub]), savedLayout: null, openedAt: null, tabKinds: { [sub]: 'subagent' } })).statusCode).toBe(200);
      expect((await api('GET', '/api/layout?device=phone')).json()).toMatchObject({ layout: ws([a!, sub]), tabKinds: { [sub]: 'subagent' } });
      expect((await api('PUT', '/api/layout', { device: 'phone', layout: null, savedLayout: null, openedAt: null })).statusCode).toBe(200);
      expect((await api('GET', '/api/layout?device=phone')).json()).toMatchObject({ layout: null, tabKinds: null });
      await new Promise(r => setTimeout(r, 100));
      const layoutMsgs = ui.received.slice(before).filter(m => m.type === 'layout.changed' || m.type === 'tabs.changed' || (m.type === 'toast' && m.kind === 'tab_evicted'));
      expect(layoutMsgs).toEqual([]);
    });

    it('clientTs: a late PUT of an older change does not overwrite the template of a newer change (keepalive on pagehide)', async () => {
      const list = (await api('GET', '/api/projects/none/sessions?limit=100')).json() as { sessions: SessionView[] };
      const [a, b, c] = list.sessions.map(x => x.id);
      const put = (tabs: string[], clientTs?: number) => api('PUT', '/api/layout', { device: 'phone', layout: ws(tabs), savedLayout: null, ...(clientTs === undefined ? {} : { clientTs }) });
      const newer = await put([b!], 2_000);
      expect(newer.json()).toMatchObject({ applied: true });
      // window A changed at 1 000 ms, its keepalive PUT arrives after window B's change at 2 000 ms
      const late = await put([a!], 1_000);
      expect(late.statusCode).toBe(200);
      expect(late.json()).toEqual({ applied: false, updatedAt: (newer.json() as { updatedAt: string }).updatedAt });
      expect(((await api('GET', '/api/layout?device=phone')).json() as { layout: unknown }).layout).toEqual(ws([b!]));
      // the same or a newer clientTs is applied; a body without clientTs (an older client) is applied too
      expect((await put([c!], 2_000)).json()).toMatchObject({ applied: true });
      expect((await put([a!], 3_000)).json()).toMatchObject({ applied: true });
      expect((await put([b!])).json()).toMatchObject({ applied: true });
      expect(((await api('GET', '/api/layout?device=phone')).json() as { layout: unknown }).layout).toEqual(ws([b!]));
      // after a body without clientTs any clientTs wins again
      expect((await put([c!], 1)).json()).toMatchObject({ applied: true });
      expect((await api('PUT', '/api/layout', { device: 'phone', layout: null, savedLayout: null })).statusCode).toBe(200);
    });

    it('PUT checks the shape (≤4 panes, ≤8 tabs, UUID ids, consistent panes) → 400; a body above 64 KB → 413', async () => {
      const ids = Array.from({ length: 9 }, () => randomUUID());
      const bad = [
        { device: 'desktop', layout: ws(ids), savedLayout: null },
        { device: 'desktop', layout: { ...ws([]), panes: { p1: { id: 'p1', tabs: ['not-a-uuid'], active: null } } }, savedLayout: null },
        { device: 'desktop', layout: { ...ws([]), layout: { type: 'oops' } }, savedLayout: null },
        {
          device: 'desktop',
          layout: {
            ...ws([]),
            layout: {
              type: 'split',
              dir: 'row',
              ratio: 0.5,
              a: { type: 'split', dir: 'row', ratio: 0.5, a: { type: 'leaf', pane: 'a' }, b: { type: 'leaf', pane: 'b' } },
              b: {
                type: 'split',
                dir: 'row',
                ratio: 0.5,
                a: { type: 'leaf', pane: 'c' },
                b: { type: 'split', dir: 'col', ratio: 0.5, a: { type: 'leaf', pane: 'd' }, b: { type: 'leaf', pane: 'e' } },
              },
            },
          },
          savedLayout: null,
        },
        { device: 'tv', layout: null, savedLayout: null },
        // consistency (review M2.1): leaves = keys of panes, focus is a pane, active is one of the pane's tabs, id = key
        { device: 'desktop', layout: { ...ws([ids[0]!]), panes: { p2: { id: 'p2', tabs: [ids[0]!], active: ids[0]! } }, focus: 'p2' }, savedLayout: null },
        { device: 'desktop', layout: { ...ws([ids[0]!]), focus: 'p9' }, savedLayout: null },
        { device: 'desktop', layout: { ...ws([ids[0]!]), panes: { p1: { id: 'p1', tabs: [ids[0]!], active: ids[1]! } } }, savedLayout: null },
        { device: 'desktop', layout: { ...ws([ids[0]!]), panes: { p1: { id: 'px', tabs: [ids[0]!], active: ids[0]! } } }, savedLayout: null },
        {
          device: 'desktop',
          layout: { ...ws([]), layout: { type: 'split', dir: 'row', ratio: 0.5, a: { type: 'leaf', pane: 'p1' }, b: { type: 'leaf', pane: 'p1' } } },
          savedLayout: null,
        },
        { device: 'desktop', layout: ws([ids[0]!]), savedLayout: { layout: { type: 'leaf', pane: 'p1' }, panes: { p1: { id: 'p1', tabs: [], active: ids[0]! } }, focus: 'p1' } },
      ];
      for (const body of bad) {
        const r = await api('PUT', '/api/layout', body);
        expect(r.statusCode, JSON.stringify(body).slice(0, 80)).toBe(400);
        expect(r.json()).toMatchObject({ error: 'invalid_request' });
      }
      const big = await api('PUT', '/api/layout', { device: 'desktop', layout: ws([]), savedLayout: null, pad: 'x'.repeat(70 * 1024) });
      expect(big.statusCode).toBe(413);
      expect(big.json()).toMatchObject({ error: 'too_large' });
      expect((await api('PUT', '/api/layout', { device: 'phone', layout: null, savedLayout: null })).statusCode).toBe(200);
    });

    it('/api/tabs is gone', async () => {
      expect((await api('GET', '/api/tabs')).statusCode).toBe(404);
      expect((await api('POST', '/api/tabs', { sessionId: randomUUID(), device: 'desktop' })).statusCode).toBe(404);
    });

    it('Windows path for the Linux runner and Linux path for the Windows runner → 422 bad_path, no fs.stat', async () => {
      await t.tdb.pool.query(`UPDATE runners SET home_dir = '/home/ubuntu' WHERE id = 'vm'`);
      const stats = got.filter(m => m.type === 'fs.stat').length;
      const vm = await api('POST', '/api/sessions', { runnerId: 'vm', cwd: 'C:\\Users\\alice\\vault', model: 'haiku', prompt: 'x' });
      expect(vm.statusCode).toBe(422);
      expect(vm.json()).toEqual({ error: 'bad_path', message: 'Путь не подходит для Linux: нужен вид /…' });
      const hp = await api('POST', '/api/sessions', { runnerId: 'hp', cwd: '/home/ubuntu', model: 'haiku', prompt: 'x' });
      expect(hp.statusCode).toBe(422);
      expect(hp.json()).toEqual({ error: 'bad_path', message: 'Путь не подходит для Windows: нужен вид C:\\…' });
      for (const p of ['\\\\evil\\share', '//evil/share', 'vault']) {
        const st = await api('GET', `/api/runners/hp/stat?path=${encodeURIComponent(p)}`);
        expect(st.statusCode).toBe(422);
        expect(st.json()).toMatchObject({ error: 'bad_path' });
      }
      expect((await api('GET', '/api/runners/vm/stat?path=C%3A%5Cw')).json()).toMatchObject({ error: 'bad_path', message: 'Путь не подходит для Linux: нужен вид /…' });
      expect(got.filter(m => m.type === 'fs.stat').length).toBe(stats);
      // Form errors stay 400.
      expect((await api('POST', '/api/sessions', { runnerId: 'hp', model: 'haiku', prompt: 'x' })).statusCode).toBe(400);
    });

    it('the agent refusing a path (cmd.error bad_path) → 422 bad_path with the Russian text, not 502', async () => {
      failing.set('fs.stat', 'bad_path');
      try {
        const r = await api('POST', '/api/sessions', { runnerId: 'hp', cwd: 'C:\\Users\\alice\\vault', model: 'haiku', prompt: 'x' });
        expect(r.statusCode).toBe(422);
        expect(r.json()).toEqual({ error: 'bad_path', message: 'Путь не подходит для Windows: нужен вид C:\\…' });
        const st = await api('GET', `/api/runners/hp/stat?path=${encodeURIComponent('C:\\w')}`);
        expect(st.statusCode).toBe(422);
      } finally {
        failing.delete('fs.stat');
      }
    });

    it('two windows: the session visible only in the second connection gets no unread mark (no notification)', async () => {
      const w1 = connectUi(t.wsBase, cookie);
      const w2 = connectUi(t.wsBase, cookie);
      await Promise.all([w1.open, w2.open]);
      try {
        const s = await newSession('два окна');
        w1.send({ type: 'presence', visible: false, activeSessionIds: [] });
        w2.send({ type: 'presence', visible: true, activeSessionIds: [s.id] });
        w2.send({ type: 'subscribe', sessionIds: [s.id] });
        w1.send({ type: 'subscribe', sessionIds: [] });
        // The main test client shows nothing either.
        ui.send({ type: 'presence', visible: true, activeSessionIds: [] });
        await waitFor(() => t.hub.ui.isActiveVisible(cookieUser, s.id));
        agentSend(agent, 'session.partial', { sessionId: s.id, messageId: 'm', blockIndex: 0, textDelta: 'только второму' });
        agentSend(agent, 'session.result', { sessionId: s.id, subtype: 'success', isError: false, durationMs: 1, costUsd: 0 });
        await waitFor(async () => (await getS(s.id)).status === 'waiting');
        expect((await getS(s.id)).unread).toBe(false);
        // Subscriptions are per connection.
        await waitFor(() => w2.received.some(m => m.type === 'session.partial' && m.textDelta === 'только второму'));
        expect(w1.received.some(m => m.type === 'session.partial')).toBe(false);
        // The second window hides: the next answer is unread.
        w2.send({ type: 'presence', visible: false, activeSessionIds: [] });
        await waitFor(() => !t.hub.ui.isActiveVisible(cookieUser, s.id));
        agentSend(agent, 'session.state', { sessionId: s.id, state: 'working', processAlive: true });
        agentSend(agent, 'session.result', { sessionId: s.id, subtype: 'success', isError: false, durationMs: 1, costUsd: 0 });
        await waitFor(async () => (await getS(s.id)).unread);
      } finally {
        w1.ws.close();
        w2.ws.close();
      }
    });
  });

  describe('review M2', () => {
    it('B1: a message refused because the machine was offline goes through when repeated with the same clientUuid', async () => {
      const s = await newSession('офлайн-повтор');
      agentSend(agent, 'session.result', { sessionId: s.id, subtype: 'success', isError: false, durationMs: 1, costUsd: 0 });
      await waitFor(async () => (await getS(s.id)).status === 'waiting');
      agent.ws.close();
      await waitFor(() => !t.hub.agents.isOnline('hp'));
      const clientUuid = randomUUID();
      expect((await api('POST', `/api/sessions/${s.id}/messages`, { text: 'повтор', clientUuid })).statusCode).toBe(409);
      agent = await startAgent([{ sessionId: s.id, state: 'waiting' }]);
      await waitFor(async () => (await getS(s.id)).processAlive);
      expect((await api('POST', `/api/sessions/${s.id}/messages`, { text: 'повтор', clientUuid })).statusCode).toBe(202);
      await waitFor(() => got.some(m => m.type === 'session.send' && m.payload.promptUuid === clientUuid));
    });

    it('B2: agent events of a session are applied in order (permission card survives, late working does not override)', async () => {
      for (let i = 0; i < 10; i++) {
        const s = await newSession(`порядок ${i}`);
        const requestId = randomUUID();
        agentSend(agent, 'session.state', { sessionId: s.id, state: 'working', processAlive: true });
        agentSend(agent, 'session.state', { sessionId: s.id, state: 'permission', processAlive: true });
        agentSend(agent, 'permission.request', { requestId, sessionId: s.id, toolName: 'Bash', toolUseId: 't', input: {}, suggestions: [] });
        await waitFor(async () => (await t.tdb.pool.query(`SELECT 1 FROM permission_requests WHERE request_id = $1`, [requestId])).rowCount === 1);
        const pr = await t.tdb.pool.query<{ resolved_at: Date | null }>(`SELECT resolved_at FROM permission_requests WHERE request_id = $1`, [requestId]);
        expect(pr.rows[0]!.resolved_at).toBeNull();
        expect((await getS(s.id)).status).toBe('permission');

        const s2 = await newSession(`порядок b ${i}`);
        agentSend(agent, 'session.state', { sessionId: s2.id, state: 'working', processAlive: true });
        agentSend(agent, 'session.result', { sessionId: s2.id, subtype: 'success', isError: false, durationMs: 1, costUsd: 0 });
        agentSend(agent, 'session.state', { sessionId: s2.id, state: 'waiting', processAlive: true });
        await waitFor(async () => (await getS(s2.id)).lastTurnEndAt !== null);
        await new Promise(r => setTimeout(r, 30));
        expect((await getS(s2.id)).status).toBe('waiting');
      }
    });

    it('advisory 1: sleep and a message at the same time end with the message delivered', async () => {
      const s = await newSession('сон и сообщение');
      agentSend(agent, 'session.result', { sessionId: s.id, subtype: 'success', isError: false, durationMs: 1, costUsd: 0 });
      await waitFor(async () => (await getS(s.id)).status === 'waiting');
      offsetMs = 31 * 60_000;
      const [msg] = await Promise.all([api('POST', `/api/sessions/${s.id}/messages`, { text: 'не спи', clientUuid: randomUUID() }), t.hub.sessions.checkIdle()]);
      offsetMs = 0;
      expect(msg.statusCode).toBe(202);
      const v = await getS(s.id);
      expect(v.status).toBe('working');
      expect(v.processAlive).toBe(true);
    });

    it('advisory 3: a late re-sent chunk does not move the cursor back', async () => {
      const s = await newSession('курсор');
      const rel = `C--Users-alice-vault/${s.id}.jsonl`;
      const l = (n: number) => JSON.stringify({ type: 'user', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content: `m${n}` } });
      agentSend(agent, 'repl.chunk', { relPath: rel, kind: 'main', sessionId: s.id, generation: 0, fromLine: 0, fromByte: 0, lines: [l(0), l(1), l(2)], endByte: 300 });
      await waitFor(() => got.some(m => m.type === 'repl.ack' && m.payload.relPath === rel && m.payload.ackedLine === 3));
      agentSend(agent, 'repl.chunk', { relPath: rel, kind: 'main', sessionId: s.id, generation: 0, fromLine: 0, fromByte: 0, lines: [l(0)], endByte: 100 });
      await waitFor(() => got.filter(m => m.type === 'repl.ack' && m.payload.relPath === rel).length === 2);
      const acks = got.filter(m => m.type === 'repl.ack' && m.payload.relPath === rel);
      expect(acks[1]!.payload).toEqual({ relPath: rel, generation: 0, ackedLine: 3, ackedByte: 300 });
      const f = await t.tdb.pool.query(`SELECT acked_line::int AS l, acked_byte::int AS b FROM transcript_files WHERE rel_path = $1`, [rel]);
      expect(f.rows[0]).toEqual({ l: 3, b: 300 });
    });

    it('advisory 5: the tail of a stopped hub process is not an external write; a later line is', async () => {
      const s = await newSession('внешняя запись');
      const sleptAt = new Date(Date.now() - 5 * 60_000);
      await t.tdb.pool.query(`UPDATE sessions SET status = 'sleeping', process_alive = false, slept_at = $2, last_turn_end_at = $2, last_input_at = $2 WHERE id = $1`, [s.id, sleptAt]);
      const rel = `C--Users-alice-vault/${s.id}.jsonl`;
      const line = (ts: Date) => JSON.stringify({ type: 'assistant', uuid: randomUUID(), timestamp: ts.toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } });
      agentSend(agent, 'repl.chunk', { relPath: rel, kind: 'main', sessionId: s.id, generation: 0, fromLine: 0, fromByte: 0, lines: [line(new Date(sleptAt.getTime() - 5000))], endByte: 10 });
      await waitFor(() => got.some(m => m.type === 'repl.ack' && m.payload.relPath === rel));
      expect((await getS(s.id)).lastExternalWriteAt).toBeNull();
      const written = new Date(sleptAt.getTime() + 3 * 60_000);
      agentSend(agent, 'repl.chunk', { relPath: rel, kind: 'main', sessionId: s.id, generation: 0, fromLine: 1, fromByte: 10, lines: [line(written)], endByte: 20 });
      await waitFor(async () => (await getS(s.id)).lastExternalWriteAt === written.toISOString());
    });

    it('re-review 5: a resume lost with the connection keeps the message delivered; a refused resume does not', async () => {
      const s = await newSession('обрыв при resume');
      await t.tdb.pool.query(`UPDATE sessions SET status = 'sleeping', process_alive = false WHERE id = $1`, [s.id]);
      const clientUuid = randomUUID();
      dropOn.add('session.resume');
      try {
        expect((await api('POST', `/api/sessions/${s.id}/messages`, { text: 'x', clientUuid })).statusCode).toBe(202);
        await waitFor(() => !t.hub.agents.isOnline('hp'));
      } finally {
        dropOn.delete('session.resume');
      }
      // The agent may have started the process: after the reconnect the same message is not sent again.
      agent = await startAgent([{ sessionId: s.id, state: 'working' }]);
      const resumes = got.filter(m => m.type === 'session.resume').length;
      const sends = got.filter(m => m.type === 'session.send').length;
      expect((await api('POST', `/api/sessions/${s.id}/messages`, { text: 'x', clientUuid })).statusCode).toBe(202);
      await new Promise(r => setTimeout(r, 100));
      expect(got.filter(m => m.type === 'session.resume').length).toBe(resumes);
      expect(got.filter(m => m.type === 'session.send').length).toBe(sends);

      // A resume the agent refused: the same clientUuid goes through on the next attempt.
      const s2 = await newSession('отказ при resume');
      await t.tdb.pool.query(`UPDATE sessions SET status = 'sleeping', process_alive = false WHERE id = $1`, [s2.id]);
      const u2 = randomUUID();
      failing.set('session.resume', 'start_failed');
      try {
        await api('POST', `/api/sessions/${s2.id}/messages`, { text: 'y', clientUuid: u2 });
        await waitFor(async () => (await getS(s2.id)).status === 'sleeping');
      } finally {
        failing.delete('session.resume');
      }
      await new Promise(r => setTimeout(r, 50));
      expect((await api('POST', `/api/sessions/${s2.id}/messages`, { text: 'y', clientUuid: u2 })).statusCode).toBe(202);
      await waitFor(() => got.filter(m => m.type === 'session.resume' && m.payload.promptUuid === u2).length === 2);
    });

    it('advisory 6: resume of a session without a model leaves the model to the machine', async () => {
      const s = await newSession('без модели');
      await t.tdb.pool.query(`UPDATE sessions SET status = 'closed', process_alive = false, model = NULL WHERE id = $1`, [s.id]);
      expect((await api('POST', `/api/sessions/${s.id}/wake`, {})).statusCode).toBe(202);
      const resume = (await waitFor(() => lastCmd('session.resume', s.id)))!;
      expect(resume.sessionId).toBe(s.id);
      expect('model' in resume).toBe(false);
    });

    it('advisory 14: the error result after «Прервать» adds no error note', async () => {
      const s = await newSession('прерывание');
      ui.send({ type: 'subscribe', sessionIds: [s.id] });
      await waitFor(() => t.hub.ui.isSubscribed(s.id));
      expect((await api('POST', `/api/sessions/${s.id}/interrupt`)).statusCode).toBe(202);
      agentSend(agent, 'session.result', { sessionId: s.id, subtype: 'error_during_execution', isError: true, durationMs: 1, costUsd: 0, errorText: 'aborted' });
      await waitFor(async () => (await getS(s.id)).lastTurnEndAt !== null);
      await new Promise(r => setTimeout(r, 100));
      const page = (await api('GET', `/api/sessions/${s.id}/events`)).json() as EventsPage;
      expect(page.events.filter(e => e.kind === 'note').map(e => (e as { text: string }).text)).toEqual(['Ход прерван']);
      // A later failing turn still gets its note.
      agentSend(agent, 'session.result', { sessionId: s.id, subtype: 'error_during_execution', isError: true, durationMs: 1, costUsd: 0, errorText: 'API 529' });
      await waitFor(async () => ((await api('GET', `/api/sessions/${s.id}/events`)).json() as EventsPage).events.some(e => e.kind === 'note' && e.text.includes('API 529')));
    });
  });

  describe('QA M3b: delivery confirmation (D10)', () => {
    const notes = async (id: string) => ((await api('GET', `/api/sessions/${id}/events`)).json() as EventsPage).events.flatMap(e => (e.kind === 'note' ? [(e as { text: string }).text] : []));
    const userLine = (uuid: string, text: string) => JSON.stringify({ type: 'user', uuid, timestamp: new Date().toISOString(), message: { role: 'user', content: text } });
    async function waitingSession(prompt: string): Promise<SessionView> {
      const s = await newSession(prompt);
      agentSend(agent, 'session.result', { sessionId: s.id, subtype: 'success', isError: false, durationMs: 1, costUsd: 0 });
      await waitFor(async () => (await getS(s.id)).status === 'waiting');
      return s;
    }

    it('cmd.ok, then the agent goes away with the process: a note in the chat, the repeat with the same clientUuid delivers once', async () => {
      const s = await waitingSession('доставка: обрыв после ok');
      const clientUuid = randomUUID();
      closeAfterOk.add('session.send');
      try {
        expect((await api('POST', `/api/sessions/${s.id}/messages`, { text: 'потерянное сообщение', clientUuid })).statusCode).toBe(202);
        await waitFor(() => !t.hub.agents.isOnline('hp'));
      } finally {
        closeAfterOk.delete('session.send');
      }
      // Back without the process (Stop-ScheduledTask killed it): reconcile puts the session to sleep.
      agent = await startAgent([]);
      await waitFor(async () => (await getS(s.id)).status === 'sleeping');
      const note = await waitFor(async () => (await notes(s.id)).find(n => n.startsWith('Сообщение не доставлено')));
      expect(note).toBe('Сообщение не доставлено — процесс Claude Code на машине завершился, отправьте ещё раз: «потерянное сообщение»');
      // «Повторить» with the same clientUuid: resume carries the message exactly once.
      expect((await api('POST', `/api/sessions/${s.id}/messages`, { text: 'потерянное сообщение', clientUuid })).statusCode).toBe(202);
      expect((await api('POST', `/api/sessions/${s.id}/messages`, { text: 'потерянное сообщение', clientUuid })).statusCode).toBe(202);
      await waitFor(() => got.some(m => m.type === 'session.resume' && m.payload.promptUuid === clientUuid));
      await new Promise(r => setTimeout(r, 100));
      expect(got.filter(m => (m.type === 'session.resume' || m.type === 'session.send') && m.payload.promptUuid === clientUuid)).toHaveLength(2);
      expect(got.filter(m => m.type === 'session.resume' && m.payload.promptUuid === clientUuid)).toHaveLength(1);
    });

    it('M3c tail: offline at once «ожидает доставки»; after the reconnect exactly one «не доставлено»', async () => {
      const s = await waitingSession('доставка: офлайн');
      const clientUuid = randomUUID();
      closeAfterOk.add('session.send');
      try {
        expect((await api('POST', `/api/sessions/${s.id}/messages`, { text: 'в офлайн', clientUuid })).statusCode).toBe(202);
        await waitFor(() => !t.hub.agents.isOnline('hp'));
      } finally {
        closeAfterOk.delete('session.send');
      }
      // Before any reconnect: the chat already tells the message waits.
      await waitFor(async () => (await notes(s.id)).includes('HP не в сети — сообщение ожидает доставки: «в офлайн»'));
      agent = await startAgent([]);
      await waitFor(async () => (await notes(s.id)).some(n => n.startsWith('Сообщение не доставлено') && n.includes('«в офлайн»')));
      await new Promise(r => setTimeout(r, 2 * GRACE + 200)); // two more grace periods: no second note
      expect((await notes(s.id)).filter(n => n.startsWith('Сообщение не доставлено') && n.includes('«в офлайн»'))).toHaveLength(1);
      // Structured for «Повторить»: the text, the images and the clientUuid.
      const page = (await api('GET', `/api/sessions/${s.id}/events`)).json() as EventsPage;
      const lost = page.events.find(e => e.kind === 'note' && e.undelivered) as Extract<EventsPage['events'][number], { kind: 'note' }>;
      expect(lost.undelivered).toEqual({ text: 'в офлайн', attachments: [], clientUuid });
    });

    it('M3c tail: a repeat within the grace after the reconnect is delivered and no «не доставлено» follows', async () => {
      const s = await waitingSession('доставка: быстрый повтор');
      const clientUuid = randomUUID();
      closeAfterOk.add('session.send');
      try {
        expect((await api('POST', `/api/sessions/${s.id}/messages`, { text: 'быстрый', clientUuid })).statusCode).toBe(202);
        await waitFor(() => !t.hub.agents.isOnline('hp'));
      } finally {
        closeAfterOk.delete('session.send');
      }
      agent = await startAgent([]);
      await waitFor(async () => (await getS(s.id)).status === 'sleeping');
      // At once, before the grace of 200 ms runs out.
      expect((await api('POST', `/api/sessions/${s.id}/messages`, { text: 'быстрый', clientUuid })).statusCode).toBe(202);
      await waitFor(() => got.some(m => m.type === 'session.resume' && m.payload.promptUuid === clientUuid));
      await new Promise(r => setTimeout(r, GRACE + 300)); // past the grace: no note
      expect((await notes(s.id)).some(n => n.startsWith('Сообщение не доставлено') && n.includes('«быстрый»'))).toBe(false);
      // The resumed process writes the line: «дошло» for the message announced as waiting, no «всё же дошло».
      const rel = `C--Users-alice-vault/${s.id}.jsonl`;
      agentSend(agent, 'repl.chunk', { relPath: rel, kind: 'main', sessionId: s.id, generation: 0, fromLine: 0, fromByte: 0, lines: [userLine(clientUuid, 'быстрый')], endByte: 100 });
      await waitFor(() => got.some(m => m.type === 'repl.ack' && m.payload.relPath === rel));
      await new Promise(r => setTimeout(r, 100));
      expect((await notes(s.id)).some(n => n.startsWith('Сообщение всё же дошло'))).toBe(false);
    });

    it('M3c tail: «Повторить» after the note, then the line comes: no «всё же дошло» for the repeat', async () => {
      const s = await waitingSession('доставка: повтор после пометки');
      const clientUuid = randomUUID();
      expect((await api('POST', `/api/sessions/${s.id}/messages`, { text: 'повтор', clientUuid })).statusCode).toBe(202);
      agentSend(agent, 'session.exited', { sessionId: s.id, code: 0, reason: 'stopped' });
      await waitFor(async () => (await notes(s.id)).some(n => n.startsWith('Сообщение не доставлено') && n.includes('«повтор»')));
      expect((await api('POST', `/api/sessions/${s.id}/messages`, { text: 'повтор', clientUuid })).statusCode).toBe(202);
      const rel = `C--Users-alice-vault/${s.id}.jsonl`;
      agentSend(agent, 'repl.chunk', { relPath: rel, kind: 'main', sessionId: s.id, generation: 0, fromLine: 0, fromByte: 0, lines: [userLine(clientUuid, 'повтор')], endByte: 100 });
      await waitFor(() => got.some(m => m.type === 'repl.ack' && m.payload.relPath === rel));
      await new Promise(r => setTimeout(r, 100));
      expect((await notes(s.id)).some(n => n.startsWith('Сообщение всё же дошло'))).toBe(false);
    });

    it('the agent exits the process while connected: the unconfirmed message gets the note', async () => {
      const s = await waitingSession('доставка: процесс упал');
      const clientUuid = randomUUID();
      expect((await api('POST', `/api/sessions/${s.id}/messages`, { text: 'до краша', clientUuid })).statusCode).toBe(202);
      agentSend(agent, 'session.exited', { sessionId: s.id, code: 0, reason: 'stopped' });
      await waitFor(async () => (await notes(s.id)).some(n => n.includes('«до краша»')));
    });

    it('a message whose user line reached the transcript is delivered: no note after the process ends; a repeat is a no-op', async () => {
      const s = await waitingSession('доставка: подтверждено');
      const clientUuid = randomUUID();
      expect((await api('POST', `/api/sessions/${s.id}/messages`, { text: 'дошло', clientUuid })).statusCode).toBe(202);
      const rel = `C--Users-alice-vault/${s.id}.jsonl`;
      agentSend(agent, 'repl.chunk', { relPath: rel, kind: 'main', sessionId: s.id, generation: 0, fromLine: 0, fromByte: 0, lines: [userLine(clientUuid, 'дошло')], endByte: 100 });
      await waitFor(() => got.some(m => m.type === 'repl.ack' && m.payload.relPath === rel));
      agentSend(agent, 'session.exited', { sessionId: s.id, code: 0, reason: 'stopped' });
      await waitFor(async () => !(await getS(s.id)).processAlive);
      await new Promise(r => setTimeout(r, GRACE + 300));
      expect((await notes(s.id)).some(n => n.startsWith('Сообщение не доставлено'))).toBe(false);
    });

    it('no cmd.ok (connection dropped on session.send): 409, the uuid stays unmarked; a line already in the transcript makes the repeat a no-op', async () => {
      const s = await waitingSession('доставка: без ok');
      const clientUuid = randomUUID();
      dropOn.add('session.send');
      try {
        const r = await api('POST', `/api/sessions/${s.id}/messages`, { text: 'без ответа', clientUuid });
        expect(r.statusCode).toBe(409);
        expect(r.json()).toMatchObject({ error: 'runner_offline' });
      } finally {
        dropOn.delete('session.send');
      }
      agent = await startAgent([{ sessionId: s.id, state: 'working' }]);
      await waitFor(async () => (await getS(s.id)).processAlive);
      // The live process had queued it: its line arrives with the tail after the reconnect.
      const rel = `C--Users-alice-vault/${s.id}.jsonl`;
      agentSend(agent, 'repl.chunk', { relPath: rel, kind: 'main', sessionId: s.id, generation: 0, fromLine: 0, fromByte: 0, lines: [userLine(clientUuid, 'без ответа')], endByte: 100 });
      await waitFor(() => got.some(m => m.type === 'repl.ack' && m.payload.relPath === rel));
      const sends = got.filter(m => m.type === 'session.send' && m.payload.promptUuid === clientUuid).length;
      expect((await api('POST', `/api/sessions/${s.id}/messages`, { text: 'без ответа', clientUuid })).statusCode).toBe(202);
      await new Promise(r => setTimeout(r, 100));
      expect(got.filter(m => m.type === 'session.send' && m.payload.promptUuid === clientUuid)).toHaveLength(sends);

      // Without the line the repeat goes through once.
      const u2 = randomUUID();
      dropOn.add('session.send');
      try {
        expect((await api('POST', `/api/sessions/${s.id}/messages`, { text: 'второй', clientUuid: u2 })).statusCode).toBe(409);
      } finally {
        dropOn.delete('session.send');
      }
      agent = await startAgent([{ sessionId: s.id, state: 'waiting' }]);
      await waitFor(async () => (await getS(s.id)).status === 'waiting');
      expect((await api('POST', `/api/sessions/${s.id}/messages`, { text: 'второй', clientUuid: u2 })).statusCode).toBe(202);
      expect((await api('POST', `/api/sessions/${s.id}/messages`, { text: 'второй', clientUuid: u2 })).statusCode).toBe(202);
      expect(got.filter(m => m.type === 'session.send' && m.payload.promptUuid === u2)).toHaveLength(2);
    });

    it('a note sent too early is corrected when the line arrives late; the repeat is then a no-op', async () => {
      const s = await waitingSession('доставка: поздний хвост');
      const clientUuid = randomUUID();
      expect((await api('POST', `/api/sessions/${s.id}/messages`, { text: 'поздно', clientUuid })).statusCode).toBe(202);
      agentSend(agent, 'session.exited', { sessionId: s.id, code: 0, reason: 'stopped' });
      await waitFor(async () => (await notes(s.id)).some(n => n.startsWith('Сообщение не доставлено')));
      const rel = `C--Users-alice-vault/${s.id}.jsonl`;
      agentSend(agent, 'repl.chunk', { relPath: rel, kind: 'main', sessionId: s.id, generation: 0, fromLine: 0, fromByte: 0, lines: [userLine(clientUuid, 'поздно')], endByte: 100 });
      await waitFor(async () => (await notes(s.id)).includes('Сообщение всё же дошло до сессии: «поздно»'));
      const before = got.filter(m => m.payload.promptUuid === clientUuid).length;
      expect((await api('POST', `/api/sessions/${s.id}/messages`, { text: 'поздно', clientUuid })).statusCode).toBe(202);
      await new Promise(r => setTimeout(r, 100));
      expect(got.filter(m => m.payload.promptUuid === clientUuid)).toHaveLength(before);
    });
  });
});
