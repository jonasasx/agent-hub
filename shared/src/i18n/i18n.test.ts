import { describe, expect, it } from 'vitest';
import { createT, englishMessages, LOCALES, loadMessages, matchLocale, parseAcceptLanguage, placeholders, type Dict } from './index.js';

describe('matchLocale', () => {
  it('takes the first supported tag, exact or by the base subtag', () => {
    expect(matchLocale(['de-DE', 'en'])).toBe('de');
    expect(matchLocale(['pt-PT'])).toBe('pt-BR');
    expect(matchLocale(['zh-HK'])).toBe('zh-CN');
    expect(matchLocale(['en-GB'])).toBe('en');
    expect(matchLocale(['pt-br'])).toBe('pt-BR');
    expect(matchLocale(['pl', 'ja-JP'])).toBe('ja');
    expect(matchLocale(['th-TH', 'en'])).toBe('th');
  });

  it('falls back to English', () => {
    expect(matchLocale(['pl'])).toBe('en');
    expect(matchLocale([])).toBe('en');
  });
});

describe('parseAcceptLanguage', () => {
  it('orders by q and drops q=0 and *', () => {
    expect(parseAcceptLanguage('en;q=0.5, fr-CH, fr;q=0.9, *;q=0.1, de;q=0')).toEqual(['fr-CH', 'fr', 'en']);
    expect(parseAcceptLanguage(undefined)).toEqual([]);
  });
});

describe('createT', () => {
  const dict: Dict = { 'x.hello': 'Привет, {name}', 'x.sessions': { one: '{count} сессия', few: '{count} сессии', many: '{count} сессий', other: '{count} сессии' } };

  it('interpolates and picks the plural form of the language', () => {
    const t = createT('ru', dict);
    expect(t.text('x.hello', { name: 'Иван' })).toBe('Привет, Иван');
    expect(t.text('x.sessions', { count: 1 })).toBe('1 сессия');
    expect(t.text('x.sessions', { count: 3 })).toBe('3 сессии');
    expect(t.text('x.sessions', { count: 5 })).toBe('5 сессий');
    expect(t.text('x.sessions', { count: 21 })).toBe('21 сессия');
  });

  it('a missing key falls back to English, then to the key', () => {
    const key = Object.keys(englishMessages)[0];
    const t = createT('ru', {});
    if (key) expect(t.text(key)).toBe(createT('en', englishMessages).text(key));
    expect(t.text('no.such.key')).toBe('no.such.key');
  });
});

describe('dictionaries (Requirement: Набор языков)', () => {
  const enKeys = Object.keys(englishMessages).sort();

  it.each(LOCALES.map(l => l.id))('%s has every English key with the same placeholders', async locale => {
    const dict = await loadMessages(locale);
    expect(Object.keys(dict).sort()).toEqual(enKeys);
    for (const key of enKeys) expect({ key, p: placeholders(dict[key]!) }).toEqual({ key, p: placeholders(englishMessages[key]!) });
  });

  it('every plural message has the forms its language needs', async () => {
    for (const { id } of LOCALES) {
      const dict = await loadMessages(id);
      const needed = new Intl.PluralRules(id).resolvedOptions().pluralCategories;
      for (const [key, msg] of Object.entries(dict)) {
        if (typeof msg === 'string') continue;
        for (const cat of needed) expect({ id, key, has: cat in msg }).toEqual({ id, key, has: true });
      }
    }
  });
});
