// Change session-links (D4): POST /api/sessions/resolve. Requirement (session-links): Ссылки на сессии.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PUBLIC_URL, startTestHub, type TestHub } from '../test/harness.js';
import type { SessionRefView } from '@agent-hub/shared';

describe('session refs (integration)', () => {
  let t: TestHub;
  let cookie: string;
  let uid: string;
  const resolve = (payload: unknown) =>
    t.hub.app.inject({ method: 'POST', url: '/api/sessions/resolve', cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, payload: payload as object });
  const q = (sql: string, params: unknown[] = []) => t.tdb.pool.query<{ id: string }>(sql, params);
  const CLAUDE = '5f8ed526-b9a8-4aae-aef5-44a16ab8a693';
  const SHARED = '00000000-0000-4000-8000-0000000000a1';
  const FOREIGN = '00000000-0000-4000-8000-0000000000b2';
  let byClaude: string;
  let older: string;
  let newer: string;

  beforeAll(async () => {
    t = await startTestHub();
    await t.addRunner('hp', 'HP');
    await t.addRunner('x1', 'X1');
    cookie = await t.login();
    uid = (await q(`SELECT user_id AS id FROM runners WHERE id='hp'`)).rows[0]!.id;
    const insert = async (runner: string, claudeId: string, title: string, lastEvent: string | null) =>
      (
        await q(`INSERT INTO sessions (user_id, runner_id, claude_session_id, source, status, title, last_event_at) VALUES ($1, $2, $3, 'terminal', 'closed', $4, $5) RETURNING id`, [
          uid,
          runner,
          claudeId,
          title,
          lastEvent,
        ])
      ).rows[0]!.id;
    byClaude = await insert('hp', CLAUDE, 'Причина падения iceberg_compaction_job', null);
    older = await insert('hp', SHARED, 'Старая копия', '2026-11-01T00:00:00Z');
    newer = await insert('x1', SHARED, 'Свежая копия', '2026-11-10T00:00:00Z');
    const other = (await q(`INSERT INTO users(email) VALUES ('other@example.test') RETURNING id`)).rows[0]!.id;
    await q(`INSERT INTO runners(id,user_id,name) VALUES ('other-machine',$1,'Other')`, [other]);
    await q(`INSERT INTO sessions (user_id, runner_id, claude_session_id, source, status, title) VALUES ($1, 'other-machine', $2, 'terminal', 'closed', 'Чужая')`, [other, FOREIGN]);
  });
  afterAll(async () => {
    await t.close();
  });

  it('finds sessions by the hub id and by the Claude Code id, case-insensitively, with the machine name', async () => {
    const r = await resolve({ ids: [CLAUDE.toUpperCase(), byClaude, '11111111-1111-4111-8111-111111111111'] });
    expect(r.statusCode).toBe(200);
    const sessions = r.json<{ sessions: SessionRefView[] }>().sessions;
    expect(sessions).toEqual([
      { ref: CLAUDE, id: byClaude, title: 'Причина падения iceberg_compaction_job', runnerName: 'HP' },
      { ref: byClaude, id: byClaude, title: 'Причина падения iceberg_compaction_job', runnerName: 'HP' },
    ]);
  });

  it('a Claude id on two machines gives the session with the latest event', async () => {
    const sessions = (await resolve({ ids: [SHARED] })).json<{ sessions: SessionRefView[] }>().sessions;
    expect(sessions).toEqual([{ ref: SHARED, id: newer, title: 'Свежая копия', runnerName: 'X1' }]);
    expect(older).not.toBe(newer);
  });

  it('does not find sessions of another user', async () => {
    const foreignHubId = (await q(`SELECT id FROM sessions WHERE claude_session_id=$1`, [FOREIGN])).rows[0]!.id;
    const sessions = (await resolve({ ids: [FOREIGN, foreignHubId] })).json<{ sessions: SessionRefView[] }>().sessions;
    expect(sessions).toEqual([]);
  });

  it('refuses a body that is not 1..100 UUIDs', async () => {
    expect((await resolve({ ids: [] })).statusCode).toBe(400);
    expect((await resolve({ ids: ['not-a-uuid'] })).statusCode).toBe(400);
    expect((await resolve({ ids: Array.from({ length: 101 }, () => CLAUDE) })).statusCode).toBe(400);
  });
});
