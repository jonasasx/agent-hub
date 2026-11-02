// D5 fix after QA M3a: source signals from the main transcript only, a human reply outside the CLI → desktop
// (Windows) / sdk (Linux), never cron with a human; `sessions:reclassify` fixes sessions classified before.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionView } from '@agent-hub/shared';
import { PUBLIC_URL, agentSend, connectFakeAgent, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';
import * as F from '../test/transcriptFixtures.js';
import { runCli } from '../cliCommands.js';

describe('D5 sources (integration)', () => {
  let t: TestHub;
  let cookie: string;
  let vm: FakeAgent;
  let hp: FakeAgent;
  const got: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const api = (url: string) => t.hub.app.inject({ method: 'GET', url, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL } });
  const sessionOf = async (claudeId: string) => {
    const r = await t.tdb.pool.query<{ id: string }>(`SELECT id FROM sessions WHERE claude_session_id = $1`, [claudeId]);
    return r.rows[0] ? ((await api(`/api/sessions/${r.rows[0].id}`)).json() as SessionView) : null;
  };
  async function chunk(agent: FakeAgent, sessionId: string, relPath: string, lines: unknown[], o: { from?: number; kind?: 'main' | 'subagent' } = {}) {
    const n = got.filter(m => m.type === 'repl.ack' && m.payload.relPath === relPath).length;
    agentSend(agent, 'repl.chunk', {
      relPath,
      kind: o.kind ?? 'main',
      sessionId,
      ...(o.kind === 'subagent' ? { agentId: 'agent-a1' } : {}),
      generation: 0,
      fromLine: o.from ?? 0,
      fromByte: 0,
      lines: lines.map(l => JSON.stringify(l)),
      endByte: 100 * ((o.from ?? 0) + lines.length),
    });
    await waitFor(() => got.filter(m => m.type === 'repl.ack' && m.payload.relPath === relPath).length > n);
  }
  const listen = (a: FakeAgent) => a.ws.on('message', d => got.push(JSON.parse(d.toString()) as { type: string; payload: Record<string, unknown> }));

  beforeAll(async () => {
    t = await startTestHub();
    const vmToken = await t.addRunner('vm', 'ВМ .3');
    const hpToken = await t.addRunner('hp', 'HP');
    cookie = await t.login();
    vm = connectFakeAgent(t.wsBase, vmToken, { hostname: 'vault', os: 'Ubuntu 24.04', homeDir: '/home/ubuntu', vaultRoot: '/home/ubuntu/vault' });
    listen(vm);
    await vm.next('welcome');
    hp = connectFakeAgent(t.wsBase, hpToken);
    listen(hp);
    await hp.next('welcome');
  });
  afterAll(async () => t.close());

  it('0545e095 on the VM: a human through the SDK with subagents is «sdk», not cron', async () => {
    const sid = '0545e095-3c21-582a-833c-07ab6da57f89';
    const o = { sessionId: sid, cwd: '/home/ubuntu/vault', entrypoint: 'sdk-cli' as const };
    // The subagent transcript arrives first: sdk-cli, turnOrigin = sdk.
    await chunk(vm, sid, `-home-ubuntu-vault/${sid}/subagents/agent-a1.jsonl`, [{ ...F.userText(o, 'задача субагенту', 'sdk'), isSidechain: true }], { kind: 'subagent' });
    await chunk(vm, sid, `-home-ubuntu-vault/${sid}.jsonl`, [F.userText(o, 'Привет, проверь мониторинг', 'human'), F.assistantText(o, 'Проверил')]);
    expect(await sessionOf(sid)).toMatchObject({ source: 'sdk', originSource: 'sdk', isCron: false, readOnlyReason: null });
  });

  it('dd346743 on HP (Windows): desktop with Remote Control', async () => {
    const dd = 'dd346743-9bbb-5c33-a0c4-38db15ed5df6';
    const o = { sessionId: dd, cwd: 'C:\\Users\\alice\\vault' };
    await chunk(hp, dd, `c--Users-alice-vault/${dd}.jsonl`, [
      F.userText({ ...o, entrypoint: 'cli' }, 'начал в терминале'),
      F.bridge(o),
      F.userText({ ...o, entrypoint: 'sdk-cli' }, 'продолжил в приложении', 'human'),
    ]);
    expect(await sessionOf(dd)).toMatchObject({ source: 'desktop', remoteControl: true, isCron: false });
  });

  it('a real claude -p run of monitoring-report-cron.sh on the VM (all strings scrubbed) is cron: turnOrigin = sdk, no human line', async () => {
    const lines = readFileSync(fileURLToPath(new URL('../test/fixtures/d5-cron-monitoring-report.jsonl', import.meta.url)), 'utf8')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l) as Record<string, unknown>);
    const sid = '6827b439-f3df-4230-afdb-81418a014716';
    expect(lines.filter(l => l.type === 'user').every(l => l.turnOrigin !== 'human' && (l.origin as { kind?: string } | undefined)?.kind !== 'human')).toBe(true);
    await chunk(vm, sid, `-home-ubuntu-vault/${sid}.jsonl`, lines);
    expect(await sessionOf(sid)).toMatchObject({ source: 'cron', originSource: 'cron', isCron: true, readOnlyReason: 'cron' });
  });

  it('a human reply without entrypoint on Windows → desktop; a claude -p run stays cron', async () => {
    const a = randomUUID();
    await chunk(hp, a, `c--x/${a}.jsonl`, [{ ...F.userText({ sessionId: a, cwd: 'C:\\x' }, 'вопрос'), origin: { kind: 'human' } }]);
    expect(await sessionOf(a)).toMatchObject({ source: 'desktop' });
    const c = randomUUID();
    await chunk(vm, c, `-home-ubuntu-vault/${c}.jsonl`, [F.userText({ sessionId: c, cwd: '/home/ubuntu/vault', entrypoint: 'sdk-cli' }, 'отчёт', 'sdk')]);
    expect(await sessionOf(c)).toMatchObject({ source: 'cron', readOnlyReason: 'cron' });
  });

  it('sessions:reclassify fixes sessions classified by the old rules (cron with a human, subagent signals) and lifts the cron read-only mark', async () => {
    const sid = randomUUID();
    const o = { sessionId: sid, cwd: '/home/ubuntu/vault', entrypoint: 'sdk-cli' as const };
    await chunk(vm, sid, `-home-ubuntu-vault/${sid}.jsonl`, [F.userText(o, 'Привет', 'human')]);
    // As M3a stored it: cron, read-only, signals from subagents mixed in.
    await t.tdb.pool.query(`UPDATE sessions SET source = 'cron', origin_source = 'cron', read_only_reason = 'cron', seen_human = false, seen_human_non_cli = false WHERE claude_session_id = $1`, [
      sid,
    ]);
    const hubSession = (await t.tdb.pool.query(`SELECT id FROM sessions WHERE claude_session_id = '0545e095-3c21-582a-833c-07ab6da57f89'`)).rows[0].id as string;
    await t.tdb.pool.query(`UPDATE sessions SET is_hub_managed = true, source = 'hub' WHERE id = $1`, [hubSession]);
    const out: string[] = [];
    expect(await runCli(['sessions:reclassify', '--dry-run'], t.tdb.db, s => out.push(s))).toBe(0);
    expect((await sessionOf(sid))!.source).toBe('cron'); // dry run changes nothing
    expect(out.some(l => l.includes(sid) && l.includes('cron -> sdk'))).toBe(true);
    expect(await runCli(['sessions:reclassify'], t.tdb.db, s => out.push(s))).toBe(0);
    expect(await sessionOf(sid)).toMatchObject({ source: 'sdk', originSource: 'sdk', readOnlyReason: null, isCron: false });
    // A session the hub took over keeps source hub, its origin is recomputed.
    expect((await t.tdb.pool.query(`SELECT source, origin_source FROM sessions WHERE id = $1`, [hubSession])).rows[0]).toEqual({ source: 'hub', origin_source: 'sdk' });
    out.length = 0;
    await runCli(['sessions:reclassify'], t.tdb.db, s => out.push(s));
    expect(out.at(-1)).toMatch(/changed 0/); // idempotent
  });
});
