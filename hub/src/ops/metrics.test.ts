// Task 3.10: /metrics behind METRICS_TOKEN; the disk warning (statfs 14%) is sent once in 12 h, survives a restart
// of the check (state in alert_state), and again after 12 h while the condition holds.
// Requirement (replication): Метрики и предупреждение о диске.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentSend, connectFakeAgent, startTestHub, waitFor, type TestHub } from '../test/harness.js';
import { checkDisk, DISK_ALERT_EVERY_MS, DiskWatch, telegramSender, type DiskStat } from './metrics.js';

const TOKEN = 'metrics-token-0123456789';

describe('metrics and the disk warning (integration)', () => {
  let t: TestHub;
  let disk: DiskStat = { free: 50, total: 100 };
  const sent: string[] = [];
  beforeAll(async () => {
    t = await startTestHub({
      env: { METRICS_TOKEN: TOKEN, DATA_VOLUME_PATH: '/data', ALERT_HOST_LABEL: '10.0.0.3' },
      ops: { stat: async () => disk, send: async text => (sent.push(text), true) },
    });
  });
  afterAll(async () => t.close());

  it('/metrics: 401 without the token; with it — db size, free share, runners online, replication lag', { timeout: 60_000 }, async () => {
    const token = await t.addRunner('hp', 'HP');
    await t.addRunner('vm', 'ВМ .3');
    const agent = connectFakeAgent(t.wsBase, token);
    await agent.next('welcome');
    // The machine lists two transcripts; the hub has stored 100 bytes of the first.
    agentSend(agent, 'repl.files', {
      files: [
        { relPath: 'p/a.jsonl', size: 300, mtimeMs: 1 },
        { relPath: 'p/b.jsonl', size: 50, mtimeMs: 1 },
      ],
      final: true,
    });
    agentSend(agent, 'repl.chunk', {
      relPath: 'p/a.jsonl',
      kind: 'main',
      sessionId: '6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7',
      generation: 0,
      fromLine: 0,
      fromByte: 0,
      lines: [JSON.stringify({ type: 'user', uuid: 'u1', timestamp: new Date().toISOString(), message: { role: 'user', content: 'x' } })],
      endByte: 100,
    });
    expect((await t.hub.app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401);
    expect((await t.hub.app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer wrong-token-0000000000' } })).statusCode).toBe(401);
    const get = () => t.hub.app.inject({ method: 'GET', url: '/metrics', headers: { authorization: `Bearer ${TOKEN}` } });
    await waitFor(async () => (await get()).body.includes('agenthub_replication_lag_bytes{runner="hp"} 250'));
    const r = await get();
    expect(r.statusCode).toBe(200);
    expect(String(r.headers['content-type'])).toMatch(/^text\/plain; version=0\.0\.4/);
    expect(r.body).toMatch(/^agenthub_db_bytes \d{6,}$/m);
    expect(r.body).toContain('agenthub_disk_free_ratio 0.5');
    expect(r.body).toContain('agenthub_runner_online{runner="hp"} 1');
    expect(r.body).toContain('agenthub_runner_online{runner="vm"} 0');
    expect(r.body).toContain('agenthub_replication_lag_files{runner="hp"} 2');
    expect(r.body).toContain('# TYPE agenthub_db_bytes gauge');
  });

  it('statfs 14%: one message in 12 h, again after 12 h; 20% — nothing', { timeout: 60_000 }, async () => {
    disk = { free: 14, total: 100 };
    let now = new Date('2026-10-26T10:00:00Z');
    const check = () => checkDisk(t.tdb.db, { dataPath: '/data', thresholdPct: 15, hostLabel: '10.0.0.3', stat: async () => disk, send: async text => (sent.push(text), true), now: () => now });
    sent.length = 0;
    expect(await check()).toBe('sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^Agent Hub: на 10\.0\.0\.3 свободно 14% диска, БД 0([,.]\d)? ГБ$/);
    // checks at +10 min … +11 h 50 min (every 10 minutes on prod): nothing more
    for (const i of [1, 6, 18, 36, 54, 71]) {
      now = new Date(Date.parse('2026-10-26T10:00:00Z') + i * 10 * 60_000);
      expect(await check()).toBe('suppressed');
    }
    expect(sent).toHaveLength(1);
    now = new Date(Date.parse('2026-10-26T10:00:00Z') + DISK_ALERT_EVERY_MS);
    expect(await check()).toBe('sent');
    expect(sent).toHaveLength(2);
    disk = { free: 20, total: 100 };
    now = new Date(Date.parse('2026-10-26T10:00:00Z') + 3 * DISK_ALERT_EVERY_MS);
    expect(await check()).toBe('ok');
    expect(sent).toHaveLength(2);
    // a failed send is not remembered: the next check tries again
    disk = { free: 10, total: 100 };
    const failing = await checkDisk(t.tdb.db, { dataPath: '/data', thresholdPct: 15, hostLabel: '10.0.0.3', stat: async () => disk, send: async () => false, now: () => now });
    expect(failing).toBe('failed');
    expect(await check()).toBe('sent');
  });

  it('review M3c: ok resets the 12 h window; a failed send waits 10 min, doubling up to 1 h; suppressed is debug', { timeout: 60_000 }, async () => {
    await t.tdb.pool.query(`DELETE FROM alert_state`);
    let now = Date.parse('2026-11-01T00:00:00Z');
    let ok = false;
    const logs: Array<[string, string]> = [];
    const log = { debug: (_o: object, m: string) => logs.push(['debug', m]), info: (_o: object, m: string) => logs.push(['info', m]), warn: (_o: object, m: string) => logs.push(['warn', m]) };
    let tries = 0;
    const w = new DiskWatch(t.tdb.db, { dataPath: '/data', thresholdPct: 15, hostLabel: 'x', stat: async () => disk, send: async () => (tries++, ok), now: () => new Date(now), log });
    disk = { free: 10, total: 100 };
    const at = (min: number) => (now = Date.parse('2026-11-01T00:00:00Z') + min * 60_000);
    expect(await w.tick()).toBe('failed'); // t=0, next try at +10 min
    at(5);
    expect(await w.tick()).toBe('waiting');
    at(10);
    expect(await w.tick()).toBe('failed'); // next at +30 (20 min wait)
    at(29);
    expect(await w.tick()).toBe('waiting');
    at(30);
    expect(await w.tick()).toBe('failed'); // 40 min
    at(70);
    expect(await w.tick()).toBe('failed'); // 80 → capped to 60 min
    at(129);
    expect(await w.tick()).toBe('waiting');
    at(130);
    ok = true;
    expect(await w.tick()).toBe('sent');
    expect(tries).toBe(5);
    at(140);
    expect(await w.tick()).toBe('suppressed');
    expect(logs.filter(([l]) => l === 'warn')).toHaveLength(4);
    expect(logs.at(-1)).toEqual(['debug', 'disk low, warning already sent within 12 h']);
    // back above the threshold: the window is reset, the next drop warns at once
    disk = { free: 30, total: 100 };
    at(150);
    expect(await w.tick()).toBe('ok');
    disk = { free: 10, total: 100 };
    at(160);
    expect(await w.tick()).toBe('sent');
  });

  it('telegramSender: posts sendMessage with chat_id; without a token nothing is sent', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fake = (async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;
    const log = { warn: () => undefined };
    expect(await telegramSender('123:abc', '42', log, fake)('привет')).toBe(true);
    expect(calls[0]).toMatchObject({ url: 'https://api.telegram.org/bot123:abc/sendMessage', body: { chat_id: '42', text: 'привет' } });
    expect(await telegramSender(undefined, '42', log, fake)('x')).toBe(false);
    expect(calls).toHaveLength(1);
  });
});
