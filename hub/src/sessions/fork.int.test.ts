// M4b (tasks 4.12–4.14, design D14): the full copy, side files of a session of another runner, handoff drafts and the
// handoff start — against scripted agents. The real SDK: agent/src/fork.sdk.test.ts.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HandoffDraftView, SessionView } from '@agent-hub/shared';
import type { MemoryStore } from '../storage/objectStore.js';
import { FIXTURE_MAPPING, FIXTURE_VAULT, PUBLIC_URL, agentSend, autoReply, connectFakeAgent, connectUi, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';
import * as F from '../test/transcriptFixtures.js';
import { buildTranscript, scrubSidePaths } from './handoff.js';

const VAULT = 'C:\\Users\\alice\\vault';

describe('fork (integration)', () => {
  let t: TestHub;
  let cookie: string;
  let hp: FakeAgent;
  let vm: FakeAgent;
  const got: Array<{ type: string; id?: string; payload: Record<string, unknown> }> = [];
  /** Per-type behaviour of the scripted agents: a function → result, or throw {code}. */
  const hpReply = new Map<string, (p: Record<string, unknown>) => unknown>();
  const vmReply = new Map<string, (p: Record<string, unknown>) => unknown>();
  const api = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    t.hub.app.inject({ method, url, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, ...(payload !== undefined ? { payload: payload as object } : {}) });

  async function chunk(agent: FakeAgent, sid: string, rel: string, lines: unknown[], from = 0) {
    const n = got.filter(m => m.type === 'repl.ack' && m.payload.relPath === rel).length;
    agentSend(agent, 'repl.chunk', {
      relPath: rel,
      kind: 'main',
      sessionId: sid,
      generation: 0,
      fromLine: from,
      fromByte: from * 100,
      lines: lines.map(l => JSON.stringify(l)),
      endByte: (from + lines.length) * 100,
    });
    // the first chunk of a session also writes S3 and the registry: 5 s is not enough in a loaded full run
    await waitFor(() => got.filter(m => m.type === 'repl.ack' && m.payload.relPath === rel).length > n, 20_000);
    await t.hub.projects.flush();
    return (await t.tdb.pool.query<{ id: string }>(`SELECT id FROM sessions WHERE claude_session_id = $1`, [sid])).rows[0]!.id;
  }

  beforeAll(async () => {
    t = await startTestHub({ env: { VAULT_DIR: FIXTURE_VAULT, LEGACY_PATHS_FILE: FIXTURE_MAPPING, HANDOFF_MODEL: 'haiku' }, sessions: { idleCheckMs: 0 } });
    const hpToken = await t.addRunner('hp', 'HP');
    const vmToken = await t.addRunner('vm', 'ВМ .3');
    await t.tdb.pool.query(`UPDATE runners SET is_utility = true WHERE id = 'vm'`);
    cookie = await t.login();
    hp = connectFakeAgent(t.wsBase, hpToken);
    vm = connectFakeAgent(t.wsBase, vmToken, { hostname: 'vault', os: 'Ubuntu 24.04', homeDir: '/home/ubuntu', vaultRoot: '/home/ubuntu/vault' });
    for (const [a, replies] of [
      [hp, hpReply],
      [vm, vmReply],
    ] as const) {
      a.ws.on('message', d => got.push(JSON.parse(d.toString()) as (typeof got)[number]));
      autoReply(a, (type, payload) => {
        const f = replies.get(type);
        if (f) return f(payload);
        if (type === 'fs.stat') return { exists: true, isDir: true };
        if (type === 'session.start' || type === 'session.resume') return { models: [] };
        throw Object.assign(new Error(`${type} not scripted`), { code: 'not_implemented' });
      });
    }
    await hp.next('welcome');
    await vm.next('welcome');
  });
  afterAll(async () => t.close());

  it('full copy: forkSession on the source machine, the row of the copy waits, the source is untouched, the project is inherited', async () => {
    const sid = randomUUID();
    const o = { sessionId: sid, cwd: `${VAULT}\\20-personal\\01-finance\\systems\\01-ledger`, entrypoint: 'cli' as const };
    const src = await chunk(hp, sid, `c--ledger/${sid}.jsonl`, [F.userText(o, 'запомни 4817'), F.assistantText(o, 'Запомнил: 4817')]);
    await t.tdb.pool.query(`UPDATE sessions SET status = 'sleeping', process_alive = false, permission_mode = 'acceptEdits', model = 'haiku' WHERE id = $1`, [src]);
    const before = (await t.tdb.pool.query(`SELECT status, project_id, project_source FROM sessions WHERE id = $1`, [src])).rows[0];
    expect(before.project_source).toBe('auto'); // 01-ledger by the start directory
    const copySid = randomUUID();
    const forks: Array<Record<string, unknown>> = [];
    hpReply.set('session.fork', p => (forks.push(p), { newSessionId: copySid }));
    const res = await api('POST', `/api/sessions/${src}/fork`, { mode: 'copy' });
    expect(res.statusCode).toBe(201);
    const v = res.json() as SessionView;
    expect(forks).toEqual([{ sourceSessionId: sid, cwd: o.cwd, title: 'запомни 4817 (копия)' }]);
    expect(v).toMatchObject({
      id: copySid,
      runnerId: 'hp',
      cwd: o.cwd,
      status: 'waiting',
      processAlive: false,
      permissionMode: 'acceptEdits',
      model: 'haiku',
      forkOf: { id: src, title: 'запомни 4817' },
      projectSource: 'inherited',
      projectEvidence: 'унаследовано от родителя',
    });
    expect(v.project.id).toBe(before.project_id);
    expect((await t.tdb.pool.query(`SELECT fork_mode FROM sessions WHERE id = $1`, [copySid])).rows[0].fork_mode).toBe('copy');
    // the source: still asleep, nothing sent to it
    expect((await t.tdb.pool.query(`SELECT status, process_alive FROM sessions WHERE id = $1`, [src])).rows[0]).toEqual({ status: 'sleeping', process_alive: false });
    expect(got.some(m => (m.type === 'session.resume' || m.type === 'session.start') && m.payload.sessionId === sid)).toBe(false);
    // the copy's transcript arrives by the usual replication and lands on the same row
    const oc = { ...o, sessionId: copySid };
    const id2 = await chunk(hp, copySid, `c--ledger/${copySid}.jsonl`, [F.userText(oc, 'запомни 4817'), F.assistantText(oc, 'Запомнил: 4817')]);
    expect(id2).toBe(copySid);
    expect((await api('GET', `/api/sessions/${copySid}`)).json()).toMatchObject({ forkOf: { id: src }, status: 'waiting' });
    // the first message resumes the copy lazily
    const msg = await api('POST', `/api/sessions/${copySid}/messages`, { text: 'замени на 9999', clientUuid: randomUUID() });
    expect(msg.statusCode).toBe(202);
    await waitFor(() => got.some(m => m.type === 'session.resume' && m.payload.sessionId === copySid));
  });

  it('copies of one source are numbered: «X (копия)», «X (копия 2)», «X (копия 3)»; a copy of a copy counts from the base', async () => {
    const sid = randomUUID();
    const o = { sessionId: sid, cwd: VAULT, entrypoint: 'cli' as const };
    const src = await chunk(hp, sid, `c--Users-alice-vault/${sid}.jsonl`, [F.userText(o, 'нумерация_копий 50%'), F.assistantText(o, 'ок')]);
    const titles: string[] = [];
    hpReply.set('session.fork', p => (titles.push(String(p.title)), { newSessionId: randomUUID() }));
    for (let i = 0; i < 3; i++) expect((await api('POST', `/api/sessions/${src}/fork`, { mode: 'copy' })).statusCode).toBe(201);
    expect(titles).toEqual(['нумерация_копий 50% (копия)', 'нумерация_копий 50% (копия 2)', 'нумерация_копий 50% (копия 3)']);
    const copy = (await t.tdb.pool.query<{ id: string }>(`SELECT id FROM sessions WHERE title = 'нумерация_копий 50% (копия 2)'`)).rows[0]!.id;
    expect((await api('POST', `/api/sessions/${copy}/fork`, { mode: 'copy' })).statusCode).toBe(201);
    expect(titles[3]).toBe('нумерация_копий 50% (копия 4)');
    // copies of the source and of a copy at once (different sessions, not serialised): the names differ
    titles.length = 0;
    const res = await Promise.all([api('POST', `/api/sessions/${src}/fork`, { mode: 'copy' }), api('POST', `/api/sessions/${copy}/fork`, { mode: 'copy' })]);
    expect(res.map(r => r.statusCode)).toEqual([201, 201]);
    expect([...titles].sort()).toEqual(['нумерация_копий 50% (копия 5)', 'нумерация_копий 50% (копия 6)']);
    hpReply.delete('session.fork');
  });

  it('full copy of a session whose .jsonl is not on the machine: restored from the hub copy first, then forked', async () => {
    const sid = randomUUID();
    const o = { sessionId: sid, cwd: VAULT, entrypoint: 'cli' as const };
    const src = await chunk(hp, sid, `c--Users-alice-vault/${sid}.jsonl`, [F.userText(o, 'восстанови меня'), F.assistantText(o, 'ок')]);
    const order: string[] = [];
    hpReply.set('fs.stat', p => (order.push(`stat ${String(p.path).endsWith('.jsonl') ? 'jsonl' : 'dir'}`), { exists: !String(p.path).endsWith('.jsonl'), isDir: !String(p.path).endsWith('.jsonl') }));
    hpReply.set('file.restore', p => (order.push(`restore ${String(p.sessionId)}`), {}));
    const copySid = randomUUID();
    hpReply.set('session.fork', () => (order.push('fork'), { newSessionId: copySid }));
    const res = await api('POST', `/api/sessions/${src}/fork`, { mode: 'copy' });
    expect(res.statusCode).toBe(201);
    expect(order).toEqual(['stat dir', 'stat jsonl', `restore ${sid}`, 'fork']);
    hpReply.delete('fs.stat');
    hpReply.delete('file.restore');
  });

  it('copy of a pinned session stays pinned; copy_unavailable for cron and a missing directory; agent_outdated; runner_offline', async () => {
    const sid = randomUUID();
    const o = { sessionId: sid, cwd: VAULT, entrypoint: 'cli' as const };
    const src = await chunk(hp, sid, `c--pinned/${sid}.jsonl`, [F.userText(o, 'закреплённая'), F.assistantText(o, 'да')]);
    const list = (await api('GET', '/api/projects')).json() as Array<{ id: string; title: string }>;
    const bridge = list.find(p => p.title === '03-mm-sms-bridge')!;
    await t.hub.app.inject({ method: 'PUT', url: `/api/sessions/${src}/project`, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, payload: { projectId: bridge.id } });
    const copySid = randomUUID();
    hpReply.set('session.fork', () => ({ newSessionId: copySid }));
    const v = (await api('POST', `/api/sessions/${src}/fork`, { mode: 'copy' })).json() as SessionView;
    expect(v).toMatchObject({ project: { title: '03-mm-sms-bridge' }, projectSource: 'manual' });
    expect((await t.tdb.pool.query(`SELECT project_id FROM classification_labels WHERE session_id = $1`, [copySid])).rows[0].project_id).toBe(bridge.id);

    await t.tdb.pool.query(`UPDATE sessions SET source = 'cron' WHERE id = $1`, [src]);
    const cron = await api('POST', `/api/sessions/${src}/fork`, { mode: 'copy' });
    expect(cron.statusCode).toBe(409);
    expect(cron.json()).toEqual({ error: 'copy_unavailable', reason: 'cron', message: 'Недоступно: cron-сессия' });
    await t.tdb.pool.query(`UPDATE sessions SET source = 'terminal' WHERE id = $1`, [src]);

    hpReply.set('fs.stat', () => ({ exists: false, isDir: false }));
    const gone = await api('POST', `/api/sessions/${src}/fork`, { mode: 'copy' });
    expect(gone.json()).toMatchObject({ error: 'copy_unavailable', reason: 'cwd_missing' });
    expect((await t.tdb.pool.query(`SELECT read_only_reason FROM sessions WHERE id = $1`, [src])).rows[0].read_only_reason).toBe('cwd_missing');
    hpReply.delete('fs.stat');
    await t.tdb.pool.query(`UPDATE sessions SET read_only_reason = NULL WHERE id = $1`, [src]);

    hpReply.delete('session.fork'); // an agent before M4b
    const old = await api('POST', `/api/sessions/${src}/fork`, { mode: 'copy' });
    expect(old.statusCode).toBe(409);
    expect(old.json()).toMatchObject({ error: 'agent_outdated' });

    // a runner that is not connected
    await t.addRunner('x1', 'X1');
    await t.tdb.pool.query(`UPDATE sessions SET runner_id = 'x1' WHERE id = $1`, [src]);
    const off = await api('POST', `/api/sessions/${src}/fork`, { mode: 'copy' });
    expect(off.statusCode).toBe(409);
    expect(off.json()).toMatchObject({ error: 'runner_offline' });
    await t.tdb.pool.query(`UPDATE sessions SET runner_id = 'hp' WHERE id = $1`, [src]);
  });

  it("«Показать полностью» of a session of another runner: the runner of the user's session with that sid; another user — 404", async () => {
    const store = t.store as MemoryStore;
    const hpSid = randomUUID();
    const o = { sessionId: hpSid, cwd: VAULT, entrypoint: 'cli' as const };
    await chunk(hp, hpSid, `c--side/${hpSid}.jsonl`, [F.userText(o, 'большой вывод'), F.assistantText(o, 'вот')]);
    await store.put(`side/hp/${hpSid}/tool-results/b1.txt`, Buffer.from('ПОЛНЫЙ ВЫВОД HP'));
    const vmSid = randomUUID();
    const vo = { sessionId: vmSid, cwd: '/home/ubuntu/vault', entrypoint: 'cli' as const };
    const vmId = await chunk(vm, vmSid, `-home-ubuntu-vault/${vmSid}.jsonl`, [F.userText(vo, `посмотри C:\\Users\\alice\\.claude\\projects\\c--side\\${hpSid}\\tool-results\\b1.txt`)]);
    const r = await api('GET', `/api/sessions/${vmId}/tool-results/b1.txt?sid=${hpSid}`);
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe('ПОЛНЫЙ ВЫВОД HP');
    // a sid of another user's session is never looked up
    const other = (await t.tdb.pool.query(`INSERT INTO users (email) VALUES ('stranger@example.com') RETURNING id`)).rows[0].id;
    await t.tdb.pool.query(`UPDATE sessions SET user_id = $1 WHERE claude_session_id = $2`, [other, hpSid]);
    expect((await api('GET', `/api/sessions/${vmId}/tool-results/b1.txt?sid=${hpSid}`)).statusCode).toBe(404);
  });

  it('handoff draft: the transcript from the replica (a big output as text, no path of the source machine), generated on the utility runner; WS handoff.draft', async () => {
    const store = t.store as MemoryStore;
    const sid = randomUUID();
    const o = { sessionId: sid, cwd: VAULT, entrypoint: 'cli' as const };
    const path = `C:\\Users\\alice\\.claude\\projects\\c--Users-alice-vault\\${sid}\\tool-results\\b1.txt`;
    const toolUse = {
      ...F.assistantText(o, ''),
      message: { id: `msg_${randomUUID()}`, role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_big', name: 'Bash', input: { command: 'cat big.log' } }] },
    };
    const toolResult = {
      ...F.userText(o, ''),
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_big',
            content: `<persisted-output>\nOutput too large (200KB). Full output saved to: ${path}\n\nPreview (first 2KB):\nначало вывода\n</persisted-output>`,
          },
        ],
      },
    };
    const src = await chunk(hp, sid, `c--Users-alice-vault/${sid}.jsonl`, [F.userText(o, 'цель: починить сборку'), toolUse, toolResult, F.assistantText(o, 'Сборка падает на шаге lint')]);
    await store.put(`side/hp/${sid}/tool-results/b1.txt`, Buffer.from('ПОЛНЫЙ ТЕКСТ ВЫВОДА: ошибка в lint на строке 42'));
    const transcript = await buildTranscript(t.tdb.db, store, { id: src, runner_id: 'hp' });
    expect(transcript).toContain('Пользователь: цель: починить сборку');
    expect(transcript).toContain('Tool: Bash cat big.log');
    expect(transcript).toContain('ПОЛНЫЙ ТЕКСТ ВЫВОДА: ошибка в lint на строке 42');
    expect(transcript).not.toContain('tool-results\\b1.txt');
    expect(transcript).not.toContain('C:\\Users\\alice\\.claude');

    const ui = connectUi(t.wsBase, cookie);
    await ui.open;
    const calls: Array<{ runner: string; p: Record<string, unknown> }> = [];
    vmReply.set('handoff.generate', p => (calls.push({ runner: 'vm', p }), { text: '## Цель\nПочинить сборку' }));
    const created = await api('POST', `/api/sessions/${src}/handoff-drafts`);
    expect(created.statusCode).toBe(202);
    const draft = created.json() as HandoffDraftView;
    expect(draft).toMatchObject({ status: 'pending', sessionId: src, text: null });
    await t.hub.handoff.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.p.model).toBe('haiku');
    expect(String(calls[0]!.p.systemPrompt)).toMatch(
      /## Цель[\s\S]*## Что сделано[\s\S]*## Текущее состояние[\s\S]*## Решения и почему[\s\S]*## Открытые вопросы[\s\S]*## Ключевые файлы и команды[\s\S]*## Следующий шаг/,
    );
    expect(String(calls[0]!.p.transcript)).toContain('ПОЛНЫЙ ТЕКСТ ВЫВОДА');
    await waitFor(() => ui.received.some(m => m.type === 'handoff.draft'));
    expect(ui.received.find(m => m.type === 'handoff.draft')).toMatchObject({ draft: { id: draft.id, status: 'ready', text: '## Цель\nПочинить сборку' } });
    expect((await api('GET', `/api/handoff-drafts/${draft.id}`)).json()).toMatchObject({ status: 'ready', text: '## Цель\nПочинить сборку' });
    expect((await t.tdb.pool.query(`SELECT runner_id FROM handoff_drafts WHERE id = $1`, [draft.id])).rows[0].runner_id).toBe('vm');

    // the utility agent cannot generate (older): the next runner in the network does
    vmReply.delete('handoff.generate');
    hpReply.set('handoff.generate', () => ({ text: 'от HP' }));
    const d2 = (await api('POST', `/api/sessions/${src}/handoff-drafts`)).json() as HandoffDraftView;
    await t.hub.handoff.flush();
    expect((await api('GET', `/api/handoff-drafts/${d2.id}`)).json()).toMatchObject({ status: 'ready', text: 'от HP' });
    // a failure is an error with a Russian text; «Повторить» makes a new draft
    hpReply.set('handoff.generate', () => {
      throw Object.assign(new Error('the model did not answer'), { code: 'generation_failed' });
    });
    const d3 = (await api('POST', `/api/sessions/${src}/handoff-drafts`)).json() as HandoffDraftView;
    await t.hub.handoff.flush();
    expect((await api('GET', `/api/handoff-drafts/${d3.id}`)).json()).toMatchObject({ status: 'error', text: null, error: expect.stringMatching(/^Не удалось сгенерировать промпт/) });
    expect((await api('GET', `/api/handoff-drafts/${randomUUID()}`)).statusCode).toBe(404);
    // one draft in the works per session: a repeated request while it is generated gets the same draft
    let gens = 0;
    hpReply.delete('handoff.generate');
    // a slow agent: its socket is held until both requests are in
    vm.ws.pause();
    // two requests at the same moment (the partial unique index decides) and one more while it is generated
    const [r1, r2] = await Promise.all([api('POST', `/api/sessions/${src}/handoff-drafts`), api('POST', `/api/sessions/${src}/handoff-drafts`)]);
    const p1 = r1.json() as HandoffDraftView;
    expect((r2.json() as HandoffDraftView).id).toBe(p1.id);
    const p2 = (await api('POST', `/api/sessions/${src}/handoff-drafts`)).json() as HandoffDraftView;
    expect(p2.id).toBe(p1.id);
    vmReply.set('handoff.generate', () => (gens++, { text: 'один' }));
    vm.ws.resume();
    await t.hub.handoff.flush();
    expect(gens).toBe(1);
    expect((await api('GET', `/api/handoff-drafts/${p1.id}`)).json()).toMatchObject({ status: 'ready', text: 'один' });
    // drafts older than 7 days are deleted
    await t.tdb.pool.query(`UPDATE handoff_drafts SET created_at = now() - interval '8 days' WHERE id = $1`, [draft.id]);
    expect(await t.hub.handoff.expire()).toBe(1);
    expect((await api('GET', `/api/handoff-drafts/${draft.id}`)).statusCode).toBe(404);
    expect((await api('GET', `/api/handoff-drafts/${p1.id}`)).statusCode).toBe(200);
    ui.ws.close();
  });

  it('handoff start: a new session on the chosen runner with the prompt first, fork_of, the inherited project; bad_path by the OS of that runner', async () => {
    const sid = randomUUID();
    const o = { sessionId: sid, cwd: `${VAULT}\\20-personal\\01-finance\\systems\\01-ledger`, entrypoint: 'cli' as const };
    const src = await chunk(hp, sid, `c--ledger2/${sid}.jsonl`, [F.userText(o, 'бухгалтерия'), F.assistantText(o, 'да')]);
    const bad = await api('POST', `/api/sessions/${src}/fork`, { mode: 'handoff', prompt: 'продолжи', runnerId: 'vm', cwd: 'C:\\Users\\x' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ error: 'bad_path' });
    const res = await api('POST', `/api/sessions/${src}/fork`, { mode: 'handoff', prompt: '## Цель\nПродолжить бухгалтерию', runnerId: 'vm', cwd: '/home/ubuntu/vault' });
    expect(res.statusCode).toBe(201);
    const v = res.json() as SessionView;
    expect(v).toMatchObject({
      runnerId: 'vm',
      cwd: '/home/ubuntu/vault',
      forkOf: { id: src },
      project: { title: '01-ledger' },
      projectSource: 'inherited',
      projectEvidence: 'унаследовано от родителя',
    });
    const start = await waitFor(() => got.find(m => m.type === 'session.start' && m.payload.sessionId === v.id));
    expect(start.payload).toMatchObject({ cwd: '/home/ubuntu/vault', prompt: '## Цель\nПродолжить бухгалтерию' });
    expect((await t.tdb.pool.query(`SELECT fork_mode FROM sessions WHERE id = $1`, [v.id])).rows[0].fork_mode).toBe('handoff');
    // projects:reclassify --fresh turns off the hysteresis of auto projects only: the inherited project stays
    await t.hub.projects.rebuild(v.id, false, true);
    expect((await api('GET', `/api/sessions/${v.id}`)).json()).toMatchObject({ project: { title: '01-ledger' }, projectSource: 'inherited' });
    // the source is untouched and may be offline
    expect((await t.tdb.pool.query(`SELECT count(*)::int AS n FROM sessions WHERE id = $1 AND fork_of IS NULL`, [src])).rows[0].n).toBe(1);
  });

  it('scrubSidePaths: Windows and POSIX paths of side files', () => {
    const s =
      'a C:\\Users\\x\\.claude\\projects\\p\\0f8fad5b-d9cb-469f-a165-70867728950e\\tool-results\\b1.txt b /home/u/.claude/projects/p/0f8fad5b-d9cb-469f-a165-70867728950e/tool-results/x-2.json c';
    expect(scrubSidePaths(s)).toBe('a [вывод b1.txt] b [вывод x-2.json] c');
  });
});
