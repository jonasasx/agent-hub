// Change multi-user, task 3.1 (design M3): no query of a user table in http/ without `user_id` — the owner is the
// filter, or the object was reached through an owned lookup (SessionService.get, getOwnedRunner). A new query without
// it fails here until it is scoped or listed below with the reason.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR = fileURLToPath(new URL('./', import.meta.url));

/** Tables whose rows belong to a user (directly or through a session). */
const USER_TABLES = [
  'sessions',
  'runners',
  'transcript_files',
  'events',
  'permission_requests',
  'session_notes',
  'path_touches',
  'background_tasks',
  'ui_layouts',
  'uploads',
  'blob_owners',
  'projects',
  'classification_labels',
  'handoff_drafts',
  'subagent_runs',
  'auth_sessions',
  'security_events',
  'enroll_codes',
  'telegram_links',
];

/** file:line-text fragments allowed without user_id, with the reason. */
const ALLOWED: Array<[file: string, fragment: string, reason: string]> = [
  ['api.ts', "tx.updateTable('sessions').set({ project_id: projectId", 'pin(): the session id comes from sessions.get(userId, id)'],
  ['blobs.ts', "deleteFrom('uploads').where('used_at', 'is', null)", 'hourly cleanup of unsent uploads of every user, no request data'],
];

function statements(src: string): Array<{ start: number; text: string }> {
  const out: Array<{ start: number; text: string }> = [];
  const re = /(selectFrom|updateTable|deleteFrom|insertInto)\(\s*'([a-z_]+)(?: as \w+)?'/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (!USER_TABLES.includes(m[2]!)) continue;
    if (m[1] === 'insertInto') continue; // inserts carry user_id in their values (checked by the integration tests)
    // The statement: up to the next `;` (Kysely chains end with execute…();).
    const end = src.indexOf(';', m.index);
    out.push({ start: m.index, text: src.slice(m.index, end === -1 ? undefined : end) });
  }
  return out;
}

describe('http/: every query of a user table is scoped by user_id', () => {
  const files = readdirSync(DIR).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  it.each(files)('%s', file => {
    const src = readFileSync(DIR + file, 'utf8');
    const bad = statements(src)
      .filter(s => !/user_id/.test(s.text))
      // Whitespace-insensitive: a formatter may break a Kysely chain over several lines.
      .filter(s => !ALLOWED.some(([f, frag]) => f === file && s.text.replace(/\s+/g, '').includes(frag.replace(/^(tx|db)\./, '').replace(/\s+/g, ''))))
      .map(s => `${file}:${src.slice(0, s.start).split('\n').length}: ${s.text.split('\n')[0]!.slice(0, 120)}`);
    expect(bad).toEqual([]);
  });

  it('the check finds an unscoped query (it is not vacuous)', () => {
    const src = "const r = await db.selectFrom('sessions').selectAll().where('id', '=', id).execute();";
    expect(statements(src).filter(s => !/user_id/.test(s.text))).toHaveLength(1);
  });
});
