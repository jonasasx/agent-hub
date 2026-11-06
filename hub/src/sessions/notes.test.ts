// Change i18n D6: a note keeps the English text and the key; an old plain note reads as before.
import { describe, expect, it } from 'vitest';
import type { Db } from '../db/db.js';
import { addNote, noteEvent } from './repo.js';

/** Just enough of Kysely for addNote: records the inserted row. */
function fakeDb(): { db: Db; rows: { session_id: string; kind: string; text: string }[] } {
  const rows: { session_id: string; kind: string; text: string }[] = [];
  const db = {
    insertInto: () => ({
      values: (row: { session_id: string; kind: string; text: string }) => {
        rows.push(row);
        return { returning: () => ({ executeTakeFirstOrThrow: async () => ({ id: rows.length, ts: new Date('2026-11-06T10:00:00Z') }) }) };
      },
    }),
  } as unknown as Db;
  return { db, rows };
}

describe('notes with a key (D6)', () => {
  it('addNote with an I18nText stores {display, i18n} and the event carries both', async () => {
    const { db, rows } = fakeDb();
    const ev = await addNote(db, 's1', 'interrupt', { key: 'hub.sessions.noteInterrupted' });
    expect(JSON.parse(rows[0]!.text)).toEqual({ display: 'Turn interrupted', i18n: { key: 'hub.sessions.noteInterrupted' } });
    expect(ev).toMatchObject({ kind: 'note', text: 'Turn interrupted', i18n: { key: 'hub.sessions.noteInterrupted' } });
  });

  it('a plain text with an explicit key stores both; params survive the round trip', async () => {
    const { db, rows } = fakeDb();
    const ev = await addNote(db, 's1', 'mode', 'Permission mode: plan', { key: 'hub.sessions.noteMode', params: { mode: 'plan' } });
    expect(JSON.parse(rows[0]!.text)).toEqual({ display: 'Permission mode: plan', i18n: { key: 'hub.sessions.noteMode', params: { mode: 'plan' } } });
    expect(ev).toMatchObject({ text: 'Permission mode: plan', i18n: { key: 'hub.sessions.noteMode', params: { mode: 'plan' } } });
  });

  it('an old note without a key stays a plain text and gets no i18n', async () => {
    const { db, rows } = fakeDb();
    const ev = await addNote(db, 's1', 'resume', 'Поднята через resume');
    expect(rows[0]!.text).toBe('Поднята через resume');
    expect(ev).toMatchObject({ text: 'Поднята через resume' });
    expect('i18n' in ev).toBe(false);
    const read = noteEvent('n:9', '2026-01-01T00:00:00.000Z', 'error', 'Старая ошибка');
    expect(read).toMatchObject({ text: 'Старая ошибка' });
    expect('i18n' in read).toBe(false);
  });
});
