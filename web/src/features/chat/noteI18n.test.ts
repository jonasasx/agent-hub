// Hub notes in the interface language: a note with `i18n` follows the language, an older note shows as stored.
import { afterEach, describe, expect, it } from 'vitest';
import type { HubEvent } from '../../api/types';
import { chooseLocale, initLocale } from '../../i18n';
import { buildChat } from './transcript';

const note = (over: Partial<Extract<HubEvent, { kind: 'note' }>>): HubEvent => ({ id: 'n1', kind: 'note', ts: '2026-11-06T10:00:00Z', text: 'Resumed', ...over }) as HubEvent;
const texts = (ev: HubEvent): string[] => buildChat([ev]).flatMap(i => (i.kind === 'note' ? [i.text] : []));

describe('hub notes by language', () => {
  afterEach(async () => {
    await initLocale('ru');
  });

  it('a note with i18n gives its own language on en and ru', async () => {
    const ev = note({ i18n: { key: 'hub.sessions.noteResumed' } });
    await chooseLocale('en');
    expect(texts(ev)).toEqual(['Resumed']);
    await chooseLocale('ru');
    expect(texts(ev)).toEqual(['Поднята через resume']);
  });

  it('an older note without i18n shows as stored in any language', async () => {
    const ev = note({ text: 'Поднята через resume' });
    await chooseLocale('en');
    expect(texts(ev)).toEqual(['Поднята через resume']);
    await chooseLocale('ru');
    expect(texts(ev)).toEqual(['Поднята через resume']);
  });
});
