// Task 3.9: GET /api/search — title, directory (project until M4), text of messages with russian and english
// morphology, snippet as plain text with offsets, cron hidden unless asked. Requirement: Быстрый поиск Ctrl+K.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SearchResponse } from '@agent-hub/shared';
import { FIXTURE_VAULT, PUBLIC_URL, agentSend, connectFakeAgent, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';
import { seedFixtureVault } from '../test/legacyCatalog.js';
import * as F from '../test/transcriptFixtures.js';
import { splitHeadline } from './search.js';

describe('search (integration)', () => {
  let t: TestHub;
  let cookie: string;
  let agent: FakeAgent;
  const got: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const search = async (q: string, extra = '') => {
    const r = await t.hub.app.inject({ method: 'GET', url: `/api/search?q=${encodeURIComponent(q)}${extra}`, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL } });
    expect(r.statusCode).toBe(200);
    return (r.json() as SearchResponse).results;
  };
  const ids = new Map<string, string>();
  async function session(key: string, cwd: string, lines: (o: F.LineOpts) => unknown[], entrypoint: 'cli' | 'sdk-cli' = 'cli') {
    const sid = randomUUID();
    const o = { sessionId: sid, cwd, entrypoint };
    const rel = `x/${sid}.jsonl`;
    const n = got.filter(m => m.type === 'repl.ack' && m.payload.relPath === rel).length;
    const ls = lines(o);
    agentSend(agent, 'repl.chunk', { relPath: rel, kind: 'main', sessionId: sid, generation: 0, fromLine: 0, fromByte: 0, lines: ls.map(l => JSON.stringify(l)), endByte: 100 * ls.length });
    await waitFor(() => got.filter(m => m.type === 'repl.ack' && m.payload.relPath === rel).length > n);
    const id = (await t.tdb.pool.query<{ id: string }>(`SELECT id FROM sessions WHERE claude_session_id = $1`, [sid])).rows[0]!.id;
    ids.set(key, id);
    return id;
  }

  beforeAll(async () => {
    t = await startTestHub();
    const token = await t.addRunner('hp', 'HP');
    cookie = await t.login();
    await seedFixtureVault(t.tdb.db, t.hub.projects.catalog, FIXTURE_VAULT);
    agent = connectFakeAgent(t.wsBase, token);
    agent.ws.on('message', d => got.push(JSON.parse(d.toString()) as { type: string; payload: Record<string, unknown> }));
    await agent.next('welcome');
    await session('dzi', 'C:\\Users\\alice\\vault', o => [F.userText(o, 'почему растут тайминги очереди DZI на Барометре?'), F.assistantText(o, 'Тайминги очереди DZI выросли из-за конвертера Q50.')]);
    await session('deploy', 'C:\\Users\\alice\\vault', o => [F.userText(o, 'что с выкаткой?'), F.assistantText(o, 'После перезапуска deployments в namespace copilot всё поднялось.')]);
    await session('ledger', 'C:\\Users\\alice\\vault\\20-personal\\01-finance\\systems\\01-ledger', o => [F.userText(o, 'импортируй выписку'), F.assistantText(o, 'Готово.')]);
    const titled = await session('title', 'C:\\Users\\alice\\vault', o => [F.userText(o, 'привет'), F.assistantText(o, 'Здравствуй.')]);
    await t.tdb.pool.query(`UPDATE sessions SET title = 'Барабан стиральной машины' WHERE id = $1`, [titled]);
    // 01-ledger by its start directory (the project of the catalogue, M4)
    await waitFor(async () => (await t.tdb.pool.query(`SELECT project_id FROM sessions WHERE id = $1`, [ids.get('ledger')])).rows[0].project_id !== null);
    await session('cron', '/home/ubuntu/vault', o => [F.userText(o, 'отчёт мониторинга: барабан алертов', 'sdk')], 'sdk-cli');
  });
  afterAll(async () => t.close());

  it('text of messages: «тайминги очереди» finds the DZI session with a highlighted fragment', async () => {
    const r = await search('тайминги очереди');
    // the title is the first prompt, so it matches too; the fragment comes from the best message
    expect(r[0]).toMatchObject({ session: { id: ids.get('dzi') } });
    expect(['title', 'text']).toContain(r[0]!.match);
    const sn = r[0]!.snippet!;
    expect(sn.text.toLowerCase()).toContain('тайминги очереди dzi');
    const words = sn.highlights.map(([a, b]) => sn.text.slice(a, b).toLowerCase());
    expect(words).toContain('тайминги');
    expect(words).toContain('очереди');
    expect(/[\x01\x02<]/.test(sn.text)).toBe(false); // eslint-disable-line no-control-regex
  });

  it('morphology: «перезапуск» finds «перезапуска», «deployment» finds «deployments»', async () => {
    expect((await search('перезапуск')).map(x => x.session.id)).toContain(ids.get('deploy'));
    const en = await search('deployment');
    expect(en[0]).toMatchObject({ match: 'text', session: { id: ids.get('deploy') } });
    expect(en[0]!.snippet!.highlights.map(([a, b]) => en[0]!.snippet!.text.slice(a, b))).toEqual(['deployments']);
  });

  it('title and project: the title first, the project by its name in the catalogue; cron only with cron=1', async () => {
    const r = await search('барабан');
    expect(r.map(x => [x.session.id, x.match])).toEqual([[ids.get('title'), 'title']]);
    expect((await search('барабан', '&cron=1')).map(x => x.session.id).sort()).toEqual([ids.get('title'), ids.get('cron')].sort());
    expect((await search('ledger'))[0]).toMatchObject({ match: 'project', session: { id: ids.get('ledger') } });
    expect(await search('слово-которого-нет')).toEqual([]);
  });

  it('an empty query gives recent sessions; limit and validation', async () => {
    const r = await search('', '&limit=2');
    expect(r).toHaveLength(2);
    expect(r.every(x => x.snippet === null)).toBe(true);
    const bad = await t.hub.app.inject({ method: 'GET', url: '/api/search?limit=500', cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: 'invalid_request' });
    // websearch syntax: quotes, minus, OR do not break the query
    expect((await search('"тайминги очереди" -копилот OR deployment')).length).toBeGreaterThan(0);
    expect(await search('%_\\')).toEqual([]);
  });

  it('splitHeadline: markers become offsets', () => {
    expect(splitHeadline('a \u0001bc\u0002 d \u0001e\u0002')).toEqual({
      text: 'a bc d e',
      highlights: [
        [2, 4],
        [7, 8],
      ],
    });
  });
});
