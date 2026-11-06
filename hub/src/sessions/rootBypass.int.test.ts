// Requirement (runner-enrollment): Запуск под root — a machine whose agent runs as root (hello.root) gets no
// bypassPermissions: 422 bypass_root on start, resume and mode change, nothing goes to the agent; another machine starts
// as before; the stderr of Claude Code about root (an agent without the field) becomes advice in the chat.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunnersResponse, SessionView } from '@agent-hub/shared';
import { PUBLIC_URL, agentSend, autoReply, connectFakeAgent, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';
import { ROOT_BYPASS_NOTE, ROOT_MODE_NOTE } from './service.js';

const STDERR = 'Claude Code process exited with code 1. stderr: --dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons';

describe('root machine and bypassPermissions (integration)', () => {
  let t: TestHub;
  let cookie: string;
  let root: FakeAgent;
  let hp: FakeAgent;
  /** Commands the agents got: [runner, type, sessionId]. */
  const got: Array<[string, string, unknown]> = [];
  /** The next session.start of the fake HP agent fails with the root stderr (cmd.error, as start_failed does). */
  let failNextStart = false;

  const api = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
    t.hub.app.inject({ method, url, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, ...(payload ? { payload } : {}) });
  const start = (runnerId: string, permissionMode: string) =>
    api('POST', '/api/sessions', { runnerId, cwd: runnerId === 'vm' ? '/root' : 'C:\\Users\\alice\\vault', permissionMode, model: 'haiku', prompt: `привет ${randomUUID()}` });
  // a keyed note is stored as {display, i18n} (D6): `text` is the English display, `i18n` the key
  const notes = async (id: string) => {
    const rows = (await t.tdb.pool.query(`SELECT kind, text FROM session_notes WHERE session_id = $1 ORDER BY id`, [id])).rows as Array<{ kind: string; text: string }>;
    return rows.map(r => {
      const u = r.text.startsWith('{') ? (JSON.parse(r.text) as { display: string; i18n: { key: string } }) : null;
      return { kind: r.kind, text: u ? u.display : r.text, i18n: u?.i18n };
    });
  };
  /** The payload of the last command of this type the runner got for the session. */
  const payloads: Array<[string, string, Record<string, unknown>]> = [];
  const lastPayload = (runner: string, type: string, id: string) => payloads.filter(([r, ty, p]) => r === runner && ty === type && p.sessionId === id).at(-1)?.[2];
  const sent = (runner: string, type: string, id: string) => got.some(([r, ty, s]) => r === runner && ty === type && s === id);

  function agent(runner: string, token: string, hello: Record<string, unknown>) {
    const a = connectFakeAgent(t.wsBase, token, { protocol: '1.5', ...hello });
    autoReply(a, (type, p) => {
      got.push([runner, type, p.sessionId]);
      payloads.push([runner, type, p]);
      if (type === 'fs.stat') return { exists: true, isDir: true };
      if (type === 'session.start' && failNextStart) {
        failNextStart = false;
        throw Object.assign(new Error(STDERR), { code: 'start_failed' });
      }
      if (type === 'session.start' || type === 'session.resume') return { models: [] };
      if (type === 'session.fork') return { newSessionId: randomUUID() };
      return {};
    });
    return a;
  }

  beforeAll(async () => {
    t = await startTestHub({ sessions: { idleCheckMs: 0, initTimeoutMs: 3000, deliveryGraceMs: 60_000 } });
    const vmToken = await t.addRunner('vm', 'Контейнер');
    const hpToken = await t.addRunner('hp', 'HP');
    cookie = await t.login();
    root = agent('vm', vmToken, { hostname: 'container', os: 'Ubuntu 24.04', homeDir: '/root', vaultRoot: null, root: true });
    hp = agent('hp', hpToken, { root: false });
    await root.next('welcome');
    await hp.next('welcome');
  }, 240_000);
  afterAll(async () => {
    await t.close();
  });

  it('RunnerView.runsAsRoot comes from hello.root', async () => {
    const r = (await api('GET', '/api/runners')).json() as RunnersResponse;
    expect(r.runners.find(x => x.id === 'vm')?.runsAsRoot).toBe(true);
    expect(r.runners.find(x => x.id === 'hp')?.runsAsRoot).toBe(false);
  });

  it('start in bypassPermissions on the root machine: 422 bypass_root, no session, nothing sent', async () => {
    const before = got.length;
    const r = await start('vm', 'bypassPermissions');
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json()).toMatchObject({ error: 'bypass_root' });
    expect(r.body).toContain('Агент на Контейнер работает под root');
    expect(got.slice(before).some(([, ty]) => ty === 'session.start')).toBe(false);
    const n = await t.tdb.pool.query(`SELECT count(*)::int AS n FROM sessions WHERE runner_id = 'vm'`);
    expect(n.rows[0].n).toBe(0);
  });

  it('the same request on a machine not under root starts the session', async () => {
    const r = await start('hp', 'bypassPermissions');
    expect(r.statusCode, r.body).toBe(201);
    const s = r.json() as SessionView;
    await waitFor(() => sent('hp', 'session.start', s.id));
  });

  it('acceptEdits on the root machine starts; switching it to bypassPermissions is 422, the mode stays', async () => {
    const r = await start('vm', 'acceptEdits');
    expect(r.statusCode, r.body).toBe(201);
    const s = r.json() as SessionView;
    await waitFor(() => sent('vm', 'session.start', s.id));
    const p = await api('PATCH', `/api/sessions/${s.id}`, { permissionMode: 'bypassPermissions' });
    expect(p.statusCode, p.body).toBe(422);
    expect(p.json()).toMatchObject({ error: 'bypass_root' });
    expect(sent('vm', 'session.set_mode', s.id)).toBe(false);
    expect(((await api('GET', `/api/sessions/${s.id}`)).json() as SessionView).permissionMode).toBe('acceptEdits');
    // another mode is fine
    expect((await api('PATCH', `/api/sessions/${s.id}`, { permissionMode: 'plan' })).statusCode).toBe(200);
  });

  it('a message to a sleeping bypassPermissions session of the root machine: 422, no resume', async () => {
    const r = await start('vm', 'acceptEdits');
    const s = r.json() as SessionView;
    await waitFor(() => sent('vm', 'session.start', s.id));
    agentSend(root, 'session.exited', { sessionId: s.id, code: 0, reason: 'stopped' });
    await waitFor(async () => ((await api('GET', `/api/sessions/${s.id}`)).json() as SessionView).status === 'sleeping');
    // a session started before the agent reported root (or imported from the machine)
    await t.tdb.pool.query(`UPDATE sessions SET permission_mode = 'bypassPermissions' WHERE id = $1`, [s.id]);
    const m = await api('POST', `/api/sessions/${s.id}/messages`, { text: 'ещё', clientUuid: randomUUID() });
    expect(m.statusCode, m.body).toBe(422);
    expect(m.json()).toMatchObject({ error: 'bypass_root' });
    expect(sent('vm', 'session.resume', s.id)).toBe(false);
  });

  it('an agent without hello.root: the root stderr becomes advice when the start fails', async () => {
    failNextStart = true;
    const r = await start('hp', 'bypassPermissions');
    expect(r.statusCode, r.body).toBe(201);
    const s = r.json() as SessionView;
    const n = await waitFor(async () => (await notes(s.id)).find(x => x.kind === 'launch_failed'));
    expect(n.i18n).toEqual(ROOT_BYPASS_NOTE);
  });

  it('an agent without hello.root: the root stderr becomes advice when the process crashes', async () => {
    const r = await start('hp', 'bypassPermissions');
    const s = r.json() as SessionView;
    await waitFor(() => sent('hp', 'session.start', s.id));
    agentSend(hp, 'session.exited', { sessionId: s.id, code: null, reason: 'crashed', errorText: STDERR });
    const n = await waitFor(async () => (await notes(s.id)).find(x => x.kind === 'crashed'));
    expect(n.i18n).toEqual(ROOT_BYPASS_NOTE);
  });

  it('any other process error is kept as it is', async () => {
    const r = await start('hp', 'acceptEdits');
    const s = r.json() as SessionView;
    await waitFor(() => sent('hp', 'session.start', s.id));
    agentSend(hp, 'session.exited', { sessionId: s.id, code: null, reason: 'crashed', errorText: 'boom' });
    const n = await waitFor(async () => (await notes(s.id)).find(x => x.kind === 'crashed'));
    expect(n.text).toBe('The Claude Code process crashed: boom');
  });

  it('handoff of a bypassPermissions session onto the root machine: acceptEdits with a note; an explicit bypassPermissions is 422', async () => {
    const src = (await start('hp', 'bypassPermissions')).json() as SessionView;
    await waitFor(() => sent('hp', 'session.start', src.id));
    const bad = await api('POST', `/api/sessions/${src.id}/fork`, { mode: 'handoff', prompt: 'продолжи', runnerId: 'vm', cwd: '/root', permissionMode: 'bypassPermissions' });
    expect(bad.statusCode, bad.body).toBe(422);
    expect(bad.json()).toMatchObject({ error: 'bypass_root' });
    const res = await api('POST', `/api/sessions/${src.id}/fork`, { mode: 'handoff', prompt: 'продолжи', runnerId: 'vm', cwd: '/root' });
    expect(res.statusCode, res.body).toBe(201);
    const h = res.json() as SessionView;
    expect(h.permissionMode).toBe('acceptEdits');
    await waitFor(() => lastPayload('vm', 'session.start', h.id));
    expect(lastPayload('vm', 'session.start', h.id)!.permissionMode).toBe('acceptEdits');
    expect((await notes(h.id)).find(n => n.kind === 'mode')?.i18n).toEqual(ROOT_MODE_NOTE);
    // onto a machine not under root the mode is inherited as it is
    const ok = await api('POST', `/api/sessions/${src.id}/fork`, { mode: 'handoff', prompt: 'продолжи', runnerId: 'hp', cwd: 'C:\\Users\\alice\\vault' });
    expect(ok.statusCode, ok.body).toBe(201);
    expect((ok.json() as SessionView).permissionMode).toBe('bypassPermissions');
  });

  it('a full copy of a bypassPermissions session on the root machine becomes acceptEdits with a note', async () => {
    const src = (await start('vm', 'acceptEdits')).json() as SessionView;
    await waitFor(() => sent('vm', 'session.start', src.id));
    await t.tdb.pool.query(`UPDATE sessions SET permission_mode = 'bypassPermissions' WHERE id = $1`, [src.id]);
    const res = await api('POST', `/api/sessions/${src.id}/fork`, { mode: 'copy' });
    expect(res.statusCode, res.body).toBe(201);
    const c = res.json() as SessionView;
    expect(c.permissionMode).toBe('acceptEdits');
    expect((await notes(c.id)).find(n => n.kind === 'mode')?.i18n).toEqual(ROOT_MODE_NOTE);
  });
});
