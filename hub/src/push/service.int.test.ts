// Change web-push-notifications (tasks 4.1–4.4): the front of «the session waits for you», the filters, the throttle, the
// text and the language, the baseline after a restart and the cleanup of dead subscriptions — against a real hub,
// Postgres and a scripted agent. The sender is a fake: no request leaves the process.
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PUSH_MAX_FAILURES, PUSH_THROTTLE_MS, type SessionView } from '@agent-hub/shared';
import { PUBLIC_URL, agentSend, autoReply, connectFakeAgent, connectUi, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';
import type { SessionRow } from '../sessions/repo.js';
import { endpointHash, listByUser, upsertByEndpoint } from './repo.js';
import { PERMISSION_REQUEST_WAIT_MS, PushService } from './service.js';
import type { PushSendOptions, PushSendResult, PushSender, PushTarget } from './sender.js';

const VAPID = { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', VAPID_SUBJECT: 'mailto:ops@example.com', SUBSCRIPTION_TOKEN_KEY: randomBytes(32).toString('base64') };
const ENDPOINT = 'https://push.example.com/send/laptop-0001';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface Sent {
  target: PushTarget;
  payload: Record<string, unknown>;
  opts: PushSendOptions;
}

class FakeSender implements PushSender {
  sent: Sent[] = [];
  /** endpoint → result; absent — ok. */
  results = new Map<string, PushSendResult>();
  async send(target: PushTarget, payload: unknown, opts: PushSendOptions): Promise<PushSendResult> {
    this.sent.push({ target, payload: payload as Record<string, unknown>, opts });
    return this.results.get(target.endpoint) ?? { ok: true };
  }
}

describe('push service (integration)', () => {
  let t: TestHub;
  let agent: FakeAgent;
  let cookie: string;
  let userId: string;
  let clock = Date.now();
  const sender = new FakeSender();
  let ui: ReturnType<typeof connectUi>;

  const q = (text: string, values: unknown[] = []) => t.tdb.pool.query(text, values);
  const api = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    t.hub.app.inject({ method, url, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, ...(payload !== undefined ? { payload: payload as object } : {}) });

  async function mkSession(
    over: { runner?: string; source?: string; managed?: boolean; title?: string; spawnedBy?: string | null; subscriptionId?: string | null } = {},
  ): Promise<{ id: string; cid: string }> {
    const cid = randomUUID();
    const r = await q(
      `INSERT INTO sessions (user_id, runner_id, claude_session_id, source, status, title, cwd, is_hub_managed, process_alive, spawned_by, subscription_id) VALUES ($1, $2, $3, $4, 'working', $5, '/home/a/code', $6, true, $7, $8) RETURNING id`,
      [userId, over.runner ?? 'x1', cid, over.source ?? 'hub', over.title ?? 'Рефакторинг модуля', over.managed ?? true, over.spawnedBy ?? null, over.subscriptionId ?? null],
    );
    return { id: r.rows[0].id, cid };
  }
  const ask = (cid: string, question = 'Какой вариант выбрать?') =>
    agentSend(agent, 'permission.request', {
      requestId: randomUUID(),
      sessionId: cid,
      toolName: 'AskUserQuestion',
      toolUseId: `toolu_${randomUUID().slice(0, 8)}`,
      input: { questions: [{ question, header: 'Выбор', options: [{ label: 'A', description: '' }], multiSelect: false }] },
      suggestions: [],
    });
  const bash = (cid: string, command: string) =>
    agentSend(agent, 'permission.request', { requestId: randomUUID(), sessionId: cid, toolName: 'Bash', toolUseId: `toolu_${randomUUID().slice(0, 8)}`, input: { command }, suggestions: [] });
  const result = (cid: string, resultText?: string) =>
    agentSend(agent, 'session.result', { sessionId: cid, subtype: 'success', isError: false, durationMs: 1, costUsd: 0, ...(resultText !== undefined ? { resultText } : {}) });
  const status = async (id: string) => (await q(`SELECT status FROM sessions WHERE id = $1`, [id])).rows[0].status as string;
  const waitStatus = (id: string, want: string) => waitFor(async () => (await status(id)) === want);
  /** The state «not waiting any more» (the answer was given): the hub forgets the waiting period. */
  const resume = async (id: string) => {
    await q(`UPDATE sessions SET status = 'working', unread = false WHERE id = $1`, [id]);
    await t.hub.sessions.upsert(id);
  };
  /** Nothing is sent for a while: the hub had time to process what came before. */
  const quiet = async (before: number) => {
    await sleep(250);
    expect(sender.sent.length).toBe(before);
  };

  beforeAll(async () => {
    t = await startTestHub({ env: VAPID, push: { sender, now: () => clock } });
    const token = await t.addRunner('x1', 'X1');
    agent = connectFakeAgent(t.wsBase, token);
    autoReply(agent, () => ({}));
    await agent.next('welcome');
    await t.addRunner('vm', 'ВМ .3');
    cookie = await t.login();
    userId = ((await api('GET', '/api/me')).json() as { user: { id: string } }).user.id;
    const sub = await api('POST', '/api/push/subscriptions', { endpoint: ENDPOINT, keys: { p256dh: 'p256dh-key', auth: 'auth-key' } });
    expect(sub.statusCode).toBe(201);
    ui = connectUi(t.wsBase, cookie);
    await ui.open;
  });
  afterAll(async () => {
    ui.ws.close();
    await t.close();
  });

  it('a question of the agent: one push with the machine, the question, the topic and a high urgency', async () => {
    const s = await mkSession();
    const before = sender.sent.length;
    ask(s.cid);
    await waitFor(() => sender.sent.length > before);
    const m = sender.sent[before]!;
    expect(m.target.endpoint).toBe(ENDPOINT);
    expect(m.payload).toMatchObject({ v: 1, kind: 'session', sessionId: s.id, title: 'Рефакторинг модуля ждёт ответа', body: 'X1 · Какой вариант выбрать?', tag: s.id, lang: 'ru' });
    expect(m.opts).toEqual({ ttl: 3600, urgency: 'high', topic: s.id.replace(/-/g, '') });
    expect(JSON.stringify(m.payload).length).toBeLessThan(1000);
    // the delivery is written down
    const row = (await q(`SELECT last_success_at, failure_count FROM push_subscriptions WHERE endpoint = $1`, [ENDPOINT])).rows[0];
    expect(row.failure_count).toBe(0);
    expect(row.last_success_at).not.toBeNull();
  });

  it('while the same wait lasts a second request gives no second push; after the answer the next one does (after the throttle)', async () => {
    const s = await mkSession();
    const before = sender.sent.length;
    bash(s.cid, 'ls');
    await waitFor(() => sender.sent.length > before);
    bash(s.cid, 'pwd');
    await waitFor(async () => (await q(`SELECT count(*)::int AS n FROM permission_requests WHERE session_id = $1`, [s.id])).rows[0].n === 2);
    await quiet(before + 1);
    // answered: working again; within 30 s the same reason is thrown away, later it is sent
    await resume(s.id);
    clock += PUSH_THROTTLE_MS - 1000;
    bash(s.cid, 'whoami');
    await waitFor(async () => (await q(`SELECT count(*)::int AS n FROM permission_requests WHERE session_id = $1`, [s.id])).rows[0].n === 3);
    await quiet(before + 1);
    await resume(s.id);
    clock += PUSH_THROTTLE_MS + 1000;
    bash(s.cid, 'date');
    await waitFor(() => sender.sent.length > before + 1);
    expect(sender.sent[before + 1]!.payload.body).toBe('X1 · Разрешение: Bash date');
  });

  it('the end of a turn: the tail of the answer, a normal urgency; a second result of the same wait is silent', async () => {
    const s = await mkSession({ title: 'Отчёт' });
    const before = sender.sent.length;
    const answer = `${'длинное вступление '.repeat(20)}Итог: все тесты зелёные, можно вливать?`;
    result(s.cid, answer);
    await waitStatus(s.id, 'waiting');
    await waitFor(() => sender.sent.length > before);
    const m = sender.sent[before]!;
    expect(m.opts).toEqual({ ttl: 3600, urgency: 'normal', topic: s.id.replace(/-/g, '') });
    expect(m.payload.title).toBe('Отчёт ждёт ответа');
    const body = m.payload.body as string;
    expect(body.startsWith('X1 · …')).toBe(true);
    expect(body.endsWith('Итог: все тесты зелёные, можно вливать?')).toBe(true);
    expect(body.length).toBeLessThanOrEqual(120);
    result(s.cid, 'ещё один ответ');
    await sleep(100);
    await quiet(before + 1);
  });

  it('a turn without the text of the answer gets the fixed phrase', async () => {
    const s = await mkSession();
    const before = sender.sent.length;
    result(s.cid);
    await waitFor(() => sender.sent.length > before);
    expect(sender.sent[before]!.payload.body).toBe('X1 · Ход завершён, ждёт ответа');
  });

  it('a permission request after the end of a turn is a new front (waiting → permission)', async () => {
    const s = await mkSession();
    const before = sender.sent.length;
    result(s.cid, 'Готово, жду указаний');
    await waitFor(() => sender.sent.length > before);
    bash(s.cid, 'rm -rf build');
    await waitFor(() => sender.sent.length > before + 1);
    expect(sender.sent[before + 1]!.opts.urgency).toBe('high');
    // of a shell command only the program is shown: the arguments may hold secrets
    expect(sender.sent[before + 1]!.payload.body).toBe('X1 · Разрешение: Bash rm');
  });

  it('secrets of the question and of the answer are cut', async () => {
    const s = await mkSession();
    const before = sender.sent.length;
    ask(s.cid, 'Использовать token=abcdef123456 или пароль?');
    await waitFor(() => sender.sent.length > before);
    expect(JSON.stringify(sender.sent[before]!.payload)).not.toContain('abcdef123456');
  });

  it('a session open and active in a visible tab gets no push', async () => {
    const s = await mkSession();
    ui.send({ type: 'presence', visible: true, activeSessionIds: [s.id] });
    await sleep(150);
    const before = sender.sent.length;
    ask(s.cid);
    await waitStatus(s.id, 'permission');
    await quiet(before);
    // the tab went to the background: the next wait is sent
    ui.send({ type: 'presence', visible: false, activeSessionIds: [s.id] });
    await sleep(150);
    await resume(s.id);
    clock += PUSH_THROTTLE_MS + 1000;
    ask(s.cid);
    await waitFor(() => sender.sent.length > before);
    ui.send({ type: 'presence', visible: true, activeSessionIds: [] });
  });

  describe('a late report of the hidden tab (push-voice-fixes)', () => {
    const unread = async (id: string) => (await q(`SELECT unread FROM sessions WHERE id = $1`, [id])).rows[0].unread as boolean;
    const show = async (id: string, client = ui) => {
      client.send({ type: 'presence', visible: true, activeSessionIds: [id] });
      await sleep(150);
    };
    const hide = (hiddenForMs?: number, client = ui) => client.send({ type: 'presence', visible: false, activeSessionIds: [], ...(hiddenForMs !== undefined ? { hiddenForMs } : {}) });

    it('a turn that ended after the tab was minimized gets its push and stays unread', async () => {
      const s = await mkSession();
      await show(s.id);
      const before = sender.sent.length;
      result(s.cid, 'Готово после сворачивания');
      await waitStatus(s.id, 'waiting');
      expect(await unread(s.id)).toBe(false);
      await quiet(before);
      // the phone was minimized 3 s ago; the report comes only now
      hide(3000);
      await waitFor(() => sender.sent.length > before);
      expect(sender.sent[before]!.payload.body).toBe('X1 · Готово после сворачивания');
      expect(await unread(s.id)).toBe(true);
    });

    it('a turn that ended before the tab was minimized stays read and silent', async () => {
      const s = await mkSession();
      await show(s.id);
      const before = sender.sent.length;
      result(s.cid, 'Прочитано на экране');
      await waitStatus(s.id, 'waiting');
      await sleep(400);
      hide(100);
      await quiet(before);
      expect(await unread(s.id)).toBe(false);
    });

    it('a session still visible on another device gets no push', async () => {
      const s = await mkSession();
      const other = connectUi(t.wsBase, cookie);
      await other.open;
      try {
        await show(s.id);
        await show(s.id, other);
        const before = sender.sent.length;
        result(s.cid, 'Видно на ноутбуке');
        await waitStatus(s.id, 'waiting');
        hide(3000);
        await quiet(before);
        expect(await unread(s.id)).toBe(false);
      } finally {
        other.ws.close();
      }
    });

    it('a permission request that came after the tab was minimized gets its push', async () => {
      const s = await mkSession();
      await show(s.id);
      const before = sender.sent.length;
      bash(s.cid, 'git push');
      await waitStatus(s.id, 'permission');
      await quiet(before);
      hide(2000);
      await waitFor(() => sender.sent.length > before);
      expect(sender.sent[before]!.payload.body).toBe('X1 · Разрешение: Bash git');
      await quiet(before + 1);
    });

    it('the hub looks back no more than 15 s however long the tab says it is hidden', async () => {
      const s = await mkSession();
      await show(s.id);
      const spy = vi.spyOn(t.hub.sessions, 'onHidden');
      try {
        hide(600_000);
        await waitFor(() => spy.mock.calls.length > 0);
        expect(spy.mock.calls[0]).toEqual([userId, [s.id], 15_000]);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('the status permission before the request itself (push-voice-fixes)', () => {
    const state = (cid: string) => agentSend(agent, 'session.state', { sessionId: cid, state: 'permission', processAlive: true });

    it('the push waits for the request and names the tool', async () => {
      const s = await mkSession();
      const before = sender.sent.length;
      state(s.cid);
      await waitStatus(s.id, 'permission');
      await sleep(300);
      expect(sender.sent.length).toBe(before);
      bash(s.cid, 'git status');
      await waitFor(() => sender.sent.length > before);
      expect(sender.sent[before]!.payload.body).toBe('X1 · Разрешение: Bash git');
      await sleep(PERMISSION_REQUEST_WAIT_MS + 200);
      expect(sender.sent.length).toBe(before + 1);
    });

    it('without the request in 3 s the push goes with the fixed phrase', async () => {
      const s = await mkSession();
      const before = sender.sent.length;
      state(s.cid);
      await waitStatus(s.id, 'permission');
      await waitFor(() => sender.sent.length > before, PERMISSION_REQUEST_WAIT_MS + 3000);
      expect(sender.sent[before]!.payload.body).toBe('X1 · Ход завершён, ждёт ответа');
      await quiet(before + 1);
    });

    it('a session that left the permission before the request came gets nothing', async () => {
      const s = await mkSession();
      const before = sender.sent.length;
      state(s.cid);
      await waitStatus(s.id, 'permission');
      await resume(s.id);
      await sleep(PERMISSION_REQUEST_WAIT_MS + 300);
      expect(sender.sent.length).toBe(before);
    });
  });

  it('does not push for terminal sessions, cron, a child that finished a turn, or an offline machine', async () => {
    const before = sender.sent.length;
    const terminal = await mkSession({ managed: false, source: 'terminal' });
    ask(terminal.cid);
    await waitStatus(terminal.id, 'permission');
    const cron = await mkSession({ source: 'cron' });
    ask(cron.cid);
    await waitStatus(cron.id, 'permission');
    const offline = await mkSession({ runner: 'vm' });
    await q(`UPDATE sessions SET status = 'permission' WHERE id = $1`, [offline.id]);
    await t.hub.sessions.upsert(offline.id);
    const parent = await mkSession();
    const child = await mkSession({ spawnedBy: parent.id });
    result(child.cid, 'Отчёт ребёнка');
    await waitStatus(child.id, 'waiting');
    await quiet(before);
    // a child asking for a permission is still sent
    const child2 = await mkSession({ spawnedBy: parent.id });
    bash(child2.cid, 'ls');
    await waitFor(() => sender.sent.length > before);
    expect(sender.sent[before]!.payload.sessionId).toBe(child2.id);
  });

  it('the language of the profile decides, then the default of the hub', async () => {
    const set = await api('PUT', '/api/preferences/locale', { locale: 'en' });
    expect(set.statusCode).toBe(204);
    const s = await mkSession({ title: 'Refactor' });
    const before = sender.sent.length;
    ask(s.cid, 'Which option?');
    await waitFor(() => sender.sent.length > before);
    expect(sender.sent[before]!.payload).toMatchObject({ title: 'Refactor is waiting for a reply', body: 'X1 · Which option?', lang: 'en' });
    await api('PUT', '/api/preferences/locale', { locale: null });
    const s2 = await mkSession({ title: 'Другая' });
    ask(s2.cid);
    await waitFor(() => sender.sent.length > before + 1);
    expect(sender.sent[before + 1]!.payload).toMatchObject({ title: 'Другая ждёт ответа', lang: 'ru' });
  });

  it('with no language in the profile the device speaks the language it subscribed with', async () => {
    const resub = (locale: string) =>
      t.hub.app.inject({
        method: 'POST',
        url: '/api/push/subscriptions',
        cookies: { ah_session: cookie },
        headers: { origin: PUBLIC_URL, 'x-agent-hub-locale': locale },
        payload: { endpoint: ENDPOINT, keys: { p256dh: 'p256dh-key', auth: 'auth-key' } },
      });
    expect((await resub('en')).statusCode).toBe(200);
    expect((await q(`SELECT locale FROM push_subscriptions WHERE endpoint = $1`, [ENDPOINT])).rows[0].locale).toBe('en');
    try {
      const s = await mkSession({ title: 'Device' });
      const before = sender.sent.length;
      ask(s.cid, 'Which one?');
      await waitFor(() => sender.sent.length > before);
      expect(sender.sent[before]!.payload).toMatchObject({ title: 'Device is waiting for a reply', lang: 'en' });
      // the language of the profile wins over the one of the device
      await api('PUT', '/api/preferences/locale', { locale: 'ru' });
      const s2 = await mkSession({ title: 'Профиль' });
      ask(s2.cid);
      await waitFor(() => sender.sent.length > before + 1);
      expect(sender.sent[before + 1]!.payload).toMatchObject({ title: 'Профиль ждёт ответа', lang: 'ru' });
    } finally {
      await api('PUT', '/api/preferences/locale', { locale: null });
      expect((await resub('ru')).statusCode).toBe(200);
    }
  });

  describe('a turn refused by its subscription says why (agent-hub-mvp 5.2a)', () => {
    const subscription = async (name: string) => {
      const r = await api('POST', '/api/subscriptions', { name, token: `sk-ant-oat01-${randomBytes(30).toString('hex')}` });
      expect(r.statusCode, r.body).toBe(201);
      return (r.json() as { id: string }).id;
    };
    const failed = (cid: string, failure: Record<string, unknown>) =>
      agentSend(agent, 'session.result', { sessionId: cid, subtype: 'error_during_execution', isError: true, durationMs: 1, costUsd: 0, resultText: "You've hit your limit · API Error 429", failure });
    const notes = async (id: string) => (await q(`SELECT kind FROM session_notes WHERE session_id = $1`, [id])).rows.map(r => r.kind as string);

    it('a limit: the name of the subscription instead of the error of the answer; with resetsAt — the time of the reset', async () => {
      const subId = await subscription('Max');
      const s = await mkSession({ subscriptionId: subId });
      let before = sender.sent.length;
      failed(s.cid, { kind: 'subscription_limit', message: "You've hit your limit" });
      await waitFor(() => sender.sent.length > before);
      expect(await notes(s.id)).toContain('subscription_limit');
      expect(sender.sent[before]!.payload.body).toBe('X1 · Лимит подписки Max исчерпан');

      const s2 = await mkSession({ subscriptionId: subId });
      before = sender.sent.length;
      failed(s2.cid, { kind: 'subscription_limit', resetsAt: Date.parse('2026-11-08T15:00:00.000Z'), limitType: 'five_hour' });
      await waitFor(() => sender.sent.length > before);
      expect(sender.sent[before]!.payload.body).toBe('X1 · Лимит подписки Max исчерпан, сброс в 18:00');
      await q(`UPDATE subscriptions SET limit_resets_at = NULL, limit_kind = NULL WHERE id = $1`, [subId]);
    });

    it('a rejected token: the push says so before the session is put to sleep', async () => {
      const subId = await subscription('Work');
      const s = await mkSession({ subscriptionId: subId });
      const before = sender.sent.length;
      failed(s.cid, { kind: 'auth_rejected', message: 'Failed to authenticate. API Error: 401' });
      await waitFor(() => sender.sent.length > before);
      expect(sender.sent[before]!.payload.body).toBe('X1 · Токен подписки Work отклонён');
      await waitStatus(s.id, 'sleeping');
      expect(await notes(s.id)).toContain('subscription_auth');
      await quiet(before + 1);
    });

    it('a reason no push used (the session was open) does not leak into the next turn: it gets the tail of its answer', async () => {
      const subId = await subscription('Pro');
      const s = await mkSession({ subscriptionId: subId });
      ui.send({ type: 'presence', visible: true, activeSessionIds: [s.id] });
      await sleep(150);
      const before = sender.sent.length;
      failed(s.cid, { kind: 'subscription_limit' });
      await waitFor(async () => (await notes(s.id)).includes('subscription_limit'));
      await quiet(before);
      ui.send({ type: 'presence', visible: false, activeSessionIds: [s.id] });
      await sleep(150);
      await resume(s.id);
      result(s.cid, 'Готово после переключения');
      await waitFor(() => sender.sent.length > before);
      expect(sender.sent[before]!.payload.body).toBe('X1 · Готово после переключения');
      ui.send({ type: 'presence', visible: true, activeSessionIds: [] });
    });
  });

  it('an account that is disabled gets nothing', async () => {
    await q(`UPDATE users SET status = 'disabled' WHERE id = $1`, [userId]);
    try {
      const s = await mkSession();
      const before = sender.sent.length;
      ask(s.cid);
      await waitStatus(s.id, 'permission');
      await quiet(before);
    } finally {
      await q(`UPDATE users SET status = 'active' WHERE id = $1`, [userId]);
    }
  });

  describe('a service of its own (baseline, cleanup)', () => {
    const log = { warn: () => undefined, info: () => undefined, error: () => undefined, debug: () => undefined } as never;
    let own: FakeSender;
    let now: number;

    const service = (enabled = true) => {
      own = new FakeSender();
      return new PushService({ db: t.tdb.db, ui: { isActiveVisible: () => false }, agents: { isOnline: () => true }, log, enabled, sender: own, defaultLocale: 'ru', now: () => now });
    };
    // the delivery tests use the end of a turn: a permission without its request row waits for it (push-voice-fixes D5)
    const rowView = (id: string, st: 'permission' | 'waiting', unread: boolean) =>
      [{ user_id: userId } as SessionRow, { id, title: 'T', runnerId: 'x1', status: st, unread, isHubManaged: true, isCron: false, spawnedBy: null } as unknown as SessionView] as const;

    it('sessions that wait when the hub starts are the baseline: no push for them, a push for a new wait', async () => {
      const waiting = await mkSession();
      const asking = await mkSession();
      await q(`UPDATE sessions SET status = 'waiting', unread = true WHERE id = $1`, [waiting.id]);
      await q(`UPDATE sessions SET status = 'permission' WHERE id = $1`, [asking.id]);
      now = Date.now();
      const svc = service();
      await svc.init();
      try {
        svc.observe(...rowView(waiting.id, 'waiting', true));
        svc.observe(...rowView(asking.id, 'permission', false));
        await sleep(200);
        expect(own.sent).toEqual([]);
        // a session the hub has never seen is «not waiting»: its first wait is a front
        const fresh = randomUUID();
        svc.observe(...rowView(fresh, 'waiting', true));
        await waitFor(() => own.sent.length > 0);
        expect(own.sent[0]!.payload.sessionId).toBe(fresh);
        // and the baseline session starts over after it has left the wait
        svc.observe(...rowView(waiting.id, 'waiting', false));
      } finally {
        svc.close();
      }
    });

    it('a turn that ends while background tasks or child sessions work is silent; the push comes when the last one ends', async () => {
      now = Date.now();
      const svc = service();
      try {
        const id = randomUUID();
        const busy = (working: number, hub = 0) => {
          const [row, view] = rowView(id, 'waiting', true);
          return [row, { ...view, subagents: { total: 2, running: 0, working, background: 2, hub: { total: 1, working: hub } } } as SessionView] as const;
        };
        svc.observe(...busy(2));
        svc.observe(...busy(1));
        svc.observe(...busy(0, 1));
        await sleep(200);
        expect(own.sent).toEqual([]);
        svc.observe(...busy(0));
        await waitFor(() => own.sent.length > 0);
        expect(own.sent[0]!.payload.sessionId).toBe(id);
        // a permission request still reaches the user while children work
        const asking = randomUUID();
        const [row, view] = rowView(asking, 'permission', false);
        svc.observe(row, { ...view, subagents: { total: 1, running: 1, working: 1 } } as SessionView);
        await waitFor(() => own.sent.length > 1);
        expect(own.sent[1]!.payload.sessionId).toBe(asking);
      } finally {
        svc.close();
      }
    });

    it('does nothing when push is not configured', async () => {
      const svc = service(false);
      await svc.init();
      svc.observe(...rowView(randomUUID(), 'permission', false));
      svc.rememberResult(randomUUID(), 'x');
      await sleep(150);
      expect(own.sent).toEqual([]);
      expect(svc.enabled).toBe(false);
      expect(await svc.sendTest(userId, endpointHash(ENDPOINT))).toBe('not_configured');
    });

    it('410 and 404 remove the subscription at once; the others stay and count', async () => {
      const gone = 'https://push.example.com/send/gone-410';
      const missing = 'https://push.example.com/send/missing-404';
      const flaky = 'https://push.example.com/send/flaky-503';
      for (const e of [gone, missing, flaky]) await upsertByEndpoint(t.tdb.db, userId, { endpoint: e, p256dh: 'k', auth: 'a', deviceLabel: 'Test' });
      now = Date.now();
      const svc = service();
      own.results.set(gone, { ok: false, status: 410 });
      own.results.set(missing, { ok: false, status: 404 });
      own.results.set(flaky, { ok: false, status: 503 });
      svc.observe(...rowView(randomUUID(), 'waiting', true));
      // the deliveries run in parallel workers: the 503 may be written after both removals, wait for it too
      await waitFor(async () => {
        const all = await listByUser(t.tdb.db, userId);
        return all.every(r => r.endpoint !== gone && r.endpoint !== missing) && all.find(r => r.endpoint === flaky)?.failure_count === 1;
      });
      const rows = await listByUser(t.tdb.db, userId);
      const kept = rows.find(r => r.endpoint === flaky)!;
      expect(kept.failure_count).toBe(1);
      expect(kept.last_failure_status).toBe(503);
      expect(kept.last_failure_at).not.toBeNull();
      // the healthy device of the same push was served and is clean
      const ok = rows.find(r => r.endpoint === ENDPOINT)!;
      expect(ok.last_success_at).not.toBeNull();
      expect(ok.failure_count).toBe(0);
      await t.tdb.pool.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [flaky]);
    });

    it('PUSH_MAX_FAILURES failures in a row remove the subscription; a success in between starts the count again', async () => {
      const broken = 'https://push.example.com/send/broken-403';
      await upsertByEndpoint(t.tdb.db, userId, { endpoint: broken, p256dh: 'k', auth: 'a', deviceLabel: 'Test' });
      now = Date.now();
      const svc = service();
      own.results.set(broken, { ok: false, status: 403 });
      const failures = async () => (await listByUser(t.tdb.db, userId)).find(r => r.endpoint === broken)?.failure_count;
      for (let i = 1; i < PUSH_MAX_FAILURES; i++) {
        svc.observe(...rowView(randomUUID(), 'waiting', true));
        await waitFor(async () => (await failures()) === i);
      }
      // one good delivery: the count is cleared
      own.results.delete(broken);
      svc.observe(...rowView(randomUUID(), 'waiting', true));
      await waitFor(async () => (await failures()) === 0);
      own.results.set(broken, { ok: false, status: 403 });
      for (let i = 1; i <= PUSH_MAX_FAILURES; i++) {
        svc.observe(...rowView(randomUUID(), 'waiting', true));
        if (i < PUSH_MAX_FAILURES) await waitFor(async () => (await failures()) === i);
      }
      await waitFor(async () => (await failures()) === undefined);
    });

    it('failures without an answer of the push service (network, DNS, keys, timeout) are not counted and never remove the subscription', async () => {
      const net = 'https://push.example.com/send/network';
      await upsertByEndpoint(t.tdb.db, userId, { endpoint: net, p256dh: 'k', auth: 'a', deviceLabel: 'Test' });
      now = Date.now();
      const svc = service();
      own.results.set(net, { ok: false, status: null });
      for (let i = 1; i <= PUSH_MAX_FAILURES + 2; i++) {
        svc.observe(...rowView(randomUUID(), 'waiting', true));
        await waitFor(() => own.sent.filter(m => m.target.endpoint === net).length === i);
      }
      await sleep(150);
      const row = (await listByUser(t.tdb.db, userId)).find(r => r.endpoint === net)!;
      expect(row.failure_count).toBe(0);
      expect(row.last_failure_at).toBeNull();
      await t.tdb.pool.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [net]);
    });

    it('an address that is not public removes the subscription at once', async () => {
      const internal = 'https://10-0-0-3.nip.io/send/internal';
      await upsertByEndpoint(t.tdb.db, userId, { endpoint: internal, p256dh: 'k', auth: 'a', deviceLabel: 'Test' });
      now = Date.now();
      const svc = service();
      own.results.set(internal, { ok: false, status: null, blocked: true });
      svc.observe(...rowView(randomUUID(), 'waiting', true));
      await waitFor(async () => (await listByUser(t.tdb.db, userId)).every(r => r.endpoint !== internal));
    });
  });
});
