// Task 3.3 integration: the real agent replicates a terminal session to a real hub; lines written while the hub was
// unreachable arrive after the reconnect without gaps or duplicates (scenario «Досылка после офлайна»). Side files
// of the session go to S3. file.restore writes the transcript back.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestHub, waitFor, type TestHub } from '../../../hub/src/test/harness.js';
import type { MemoryStore } from '../../../hub/src/storage/objectStore.js';
import { createAgent, type Agent } from '../agent.js';
import { createLogger } from '../log.js';

describe('agent replication ↔ hub (integration)', () => {
  let t: TestHub;
  let token: string;
  let agent: Agent;
  const root = mkdtempSync(join(tmpdir(), 'agenthub-replint-'));
  const projects = join(root, 'projects');
  const dir = join(projects, 'c--Users-alice-vault');
  const sid = randomUUID();
  const file = join(dir, `${sid}.jsonl`);
  const line = (n: number) =>
    JSON.stringify({
      type: n % 2 ? 'assistant' : 'user',
      uuid: randomUUID(),
      timestamp: new Date(Date.now() - 3600_000).toISOString(),
      sessionId: sid,
      cwd: 'C:\\Users\\alice\\vault',
      entrypoint: 'cli',
      message: { role: n % 2 ? 'assistant' : 'user', content: n % 2 ? [{ type: 'text', text: `ответ ${n}` }] : `вопрос ${n}` },
    });
  const write = (from: number, to: number) => appendFileSync(file, Array.from({ length: to - from }, (_, i) => `${line(from + i)}\n`).join(''));
  const count = async () => Number((await t.tdb.pool.query(`SELECT count(*)::int AS n FROM events e JOIN sessions s ON s.id = e.session_id WHERE s.claude_session_id = $1`, [sid])).rows[0]?.n ?? 0);

  const makeAgent = () =>
    createAgent({
      hubUrl: `${t.wsBase}/ws/agent`,
      token,
      vaultRoot: null,
      claudeProjectsDir: projects,
      stateDir: join(root, 'state'),
      log: createLogger({ level: 'error', write: () => undefined }),
      backoff: { minMs: 50, maxMs: 200 },
      tailPollMs: 50,
      walkMs: 200,
      replMaxBytesPerSec: 50 * 1024 * 1024,
    });

  beforeAll(async () => {
    t = await startTestHub();
    token = await t.addRunner('hp', 'HP');
    mkdirSync(join(dir, sid, 'tool-results'), { recursive: true });
    writeFileSync(join(dir, sid, 'tool-results', 'toolu_1.txt'), 'длинный вывод '.repeat(1000));
    write(0, 300);
    agent = makeAgent();
    agent.start();
  });
  afterAll(async () => {
    await agent.stop();
    await t.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('a session written outside the hub is replicated with all lines; its side file is in S3', async () => {
    await waitFor(async () => (await count()) === 300, 20_000, 100);
    const store = t.store as MemoryStore;
    await waitFor(() => [...store.objects.keys()].some(k => k === `side/hp/${sid}/tool-results/toolu_1.txt`), 10_000, 100);
    // side.ack from the hub marks it sent (state file), so it is not offered again.
    const sha = createHash('sha256')
      .update(readFileSync(join(dir, sid, 'tool-results', 'toolu_1.txt')))
      .digest('hex');
    await waitFor(() => existsSync(join(root, 'state', 'replication-state.json')) && readFileSync(join(root, 'state', 'replication-state.json'), 'utf8').includes(sha), 10_000, 100);
    const s = (await t.tdb.pool.query(`SELECT source, status FROM sessions WHERE claude_session_id = $1`, [sid])).rows[0];
    expect(s).toEqual({ source: 'terminal', status: 'closed' });
  });

  it('Досылка после офлайна: lines written while disconnected arrive after the reconnect, no gaps, no duplicates', async () => {
    await agent.stop();
    await waitFor(() => !t.hub.agents.isOnline('hp'));
    write(300, 600);
    agent = makeAgent();
    agent.start();
    await waitFor(async () => (await count()) === 600, 20_000, 100);
    await new Promise(r => setTimeout(r, 500));
    expect(await count()).toBe(600);
    const lines = (await t.tdb.pool.query<{ line_no: string }>(`SELECT line_no FROM events e JOIN sessions s ON s.id = e.session_id WHERE s.claude_session_id = $1 ORDER BY line_no`, [sid])).rows.map(
      r => Number(r.line_no),
    );
    expect(lines).toEqual(Array.from({ length: 600 }, (_, i) => i));
  });

  it('3.19: «Показать изображение» through the real agent: bytes in a binary frame, stored in the hub', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000070000000508060000', 'hex');
    const path = join(root, 'shot.png');
    writeFileSync(path, png);
    const row = (await t.tdb.pool.query(`SELECT id FROM sessions WHERE claude_session_id = $1`, [sid])).rows[0];
    const cookie = await t.login();
    const r = await t.hub.app.inject({ method: 'POST', url: `/api/sessions/${row.id}/images`, cookies: { ah_session: cookie }, headers: { origin: 'https://agents.test.example' }, payload: { path } });
    expect(r.statusCode).toBe(200);
    const blob = (r.json() as { event: { image: { blob: { $blob: string; width: number; height: number } } } }).event.image.blob;
    expect(blob).toMatchObject({ $blob: createHash('sha256').update(png).digest('hex'), width: 7, height: 5 });
    const missing = await t.hub.app.inject({
      method: 'POST',
      url: `/api/sessions/${row.id}/images`,
      cookies: { ah_session: cookie },
      headers: { origin: 'https://agents.test.example' },
      payload: { path: join(root, 'none.png') },
    });
    expect(missing.json()).toEqual({ error: 'file_not_found', message: 'Файл не найден на HP' });
  });

  it('file.restore writes the deleted transcript back from the hub copy (same bytes)', async () => {
    const original = readFileSync(file);
    unlinkSync(file);
    const row = (await t.tdb.pool.query(`SELECT * FROM sessions WHERE claude_session_id = $1`, [sid])).rows[0];
    const rep = t.hub.sessions.replication!;
    const f = (await rep.mainFile(row))!;
    const r = await rep.prepareRestore(row, f);
    const res = (await t.hub.agents.get('hp')!.request('file.restore', { sessionId: sid, cwd: 'C:\\Users\\alice\\vault', url: r.url, sha256: r.sha256 }, 10_000)) as { path: string };
    expect(existsSync(file)).toBe(true);
    expect(res.path.toLowerCase()).toBe(file.toLowerCase());
    expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(createHash('sha256').update(original).digest('hex'));
    // The restored file matches the hub cursor: nothing is sent again.
    await new Promise(res2 => setTimeout(res2, 500));
    expect(await count()).toBe(600);
  });
});
