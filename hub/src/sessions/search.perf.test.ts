// Task 3.9, performance of Ctrl+K on synthetic history (opt-in: AGENT_HUB_PERF=1). Sizes from env:
// PERF_SESSIONS (default 5000), PERF_EVENTS_PER_SESSION (default 200, i.e. 1 M events). The target of the spec is
// p95 < 500 ms at 5000 sessions / ~10 M events; the run prints what it measured.
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../test/db.js';
import { searchSessions } from './search.js';

const RUN = process.env.AGENT_HUB_PERF === '1';
const SESSIONS = Number(process.env.PERF_SESSIONS ?? 5000);
const PER = Number(process.env.PERF_EVENTS_PER_SESSION ?? 200);

// Russian and English words of a working vault; a few are rare on purpose.
const WORDS = (
  'сервер деплой очередь тайминги конвертер сканер слайд платформа заявка поддержка кластер нода база миграция ' +
  'бэкап отчёт мониторинг алерт сертификат домен маршрут туннель пользователь роль права доступ шаблон форма ' +
  'запрос ответ ошибка лог перезапуск обновление релиз версия тест сборка пайплайн ветка коммит ревью ' +
  'deployment namespace ingress service pod volume secret config release build pipeline branch merge review ' +
  'error timeout latency queue worker cache index search query table column schema backup restore metrics'
).split(' ');
const RARE = ['барабан', 'барометр', 'антресоль', 'kfbio', 'vipnet'];

describe.skipIf(!RUN)(`search performance (${SESSIONS} sessions × ${PER} events)`, () => {
  let t: TestDb;
  let userId: string;
  beforeAll(async () => {
    t = await createTestDb();
    const started = performance.now();
    userId = (await t.pool.query<{ id: string }>(`INSERT INTO users (email) VALUES ('perf@x.y') RETURNING id`)).rows[0]!.id;
    await t.pool.query(`INSERT INTO runners (id, user_id, name, home_dir) VALUES ('hp', $1, 'HP', 'C:\\Users\\alice')`, [userId]);
    await t.pool.query(
      `INSERT INTO sessions (user_id, runner_id, claude_session_id, cwd, source, status, title, created_at, last_event_at)
       SELECT $1, 'hp', gen_random_uuid(), 'C:\\Users\\alice\\vault\\area-' || (i % 40), CASE WHEN i % 10 = 0 THEN 'cron' ELSE 'terminal' END,
              'closed', 'Сессия ' || i || ' ' || ($2::text[])[1 + i % array_length($2::text[], 1)],
              now() - (i || ' minutes')::interval, now() - (i || ' minutes')::interval
         FROM generate_series(1, $3::int) i`,
      [userId, WORDS, SESSIONS],
    );
    await t.pool.query(
      `INSERT INTO transcript_files (user_id, session_id, runner_id, claude_session_id, rel_path, rel_key, kind)
       SELECT user_id, id, runner_id, claude_session_id, 'p/' || claude_session_id || '.jsonl', 'p/' || claude_session_id || '.jsonl', 'main' FROM sessions`,
    );
    // Messages of 12..40 words; one session in 500 mentions a rare word.
    await t.pool.query(
      `INSERT INTO events (file_id, generation, line_no, session_id, type, ts, payload, search_text)
       SELECT f.id, 0, n, f.session_id, CASE WHEN n % 2 = 0 THEN 'user' ELSE 'assistant' END, now() - (n || ' seconds')::interval, '{}'::jsonb,
              (SELECT string_agg(($1::text[])[1 + floor(random() * array_length($1::text[], 1))::int], ' ') FROM generate_series(1, 12 + (n * 7 + f.id::int) % 29))
              || CASE WHEN (f.id + n) % (500 * $3::int) = 0 THEN ' ' || ($2::text[])[1 + f.id::int % 5] ELSE '' END
         FROM transcript_files f, generate_series(0, $3::int - 1) n`,
      [WORDS, RARE, PER],
    );
    await t.pool.query('ANALYZE');
    const n = (await t.pool.query<{ n: string }>(`SELECT count(*) AS n FROM events`)).rows[0]!.n;
    const size = (await t.pool.query<{ s: string }>(`SELECT pg_size_pretty(pg_database_size(current_database())) AS s`)).rows[0]!.s;
    console.log(`perf: ${SESSIONS} sessions, ${n} events, db ${size}, built in ${Math.round((performance.now() - started) / 1000)} s`);
  }, 3_600_000);
  afterAll(async () => t?.drop());

  it('p95 under 500 ms over rare, common, multi-word, english and title queries', { timeout: 600_000 }, async () => {
    const queries = [
      'барабан',
      'барометр',
      'тайминги очереди',
      'деплой',
      'перезапуска сервера',
      'deployment',
      'namespace ingress',
      '"ошибка доступа"',
      'kfbio',
      'Сессия 4242',
      'area-7',
      'timeout -cache',
    ];
    const times: Record<string, number[]> = {};
    for (let round = 0; round < 5; round++) {
      for (const q of queries) {
        const a = performance.now();
        await searchSessions(t.db, { userId, q, limit: 12, cron: false });
        (times[q] ??= []).push(performance.now() - a);
      }
    }
    const all = Object.values(times)
      .flat()
      .sort((x, y) => x - y);
    const p = (k: number) => Math.round(all[Math.min(all.length - 1, Math.floor(k * all.length))]!);
    for (const [q, v] of Object.entries(times)) console.log(`perf: ${q.padEnd(22)} median ${Math.round(v.sort((x, y) => x - y)[2]!)} ms, max ${Math.round(Math.max(...v))} ms`);
    console.log(`perf: p50 ${p(0.5)} ms, p95 ${p(0.95)} ms, max ${Math.round(all.at(-1)!)} ms (${all.length} queries)`);
    expect(p(0.95)).toBeLessThan(500);
  });
});
