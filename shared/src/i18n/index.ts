/**
 * Interface languages (change `i18n`, Requirement: Набор языков). English is the base and the fallback; a new language is
 * a folder `messages/<locale>/` plus a line in LOCALES and in `loadMessages`.
 */
import en from './messages/en/index.js';

export const LOCALES = [
  { id: 'en', name: 'English' },
  { id: 'ru', name: 'Русский' },
  { id: 'zh-CN', name: '简体中文' },
  { id: 'es', name: 'Español' },
  { id: 'pt-BR', name: 'Português (Brasil)' },
  { id: 'de', name: 'Deutsch' },
  { id: 'fr', name: 'Français' },
  { id: 'ja', name: '日本語' },
  { id: 'ko', name: '한국어' },
  { id: 'th', name: 'ไทย' },
] as const;

export type Locale = (typeof LOCALES)[number]['id'];
export const LOCALE_IDS = LOCALES.map(l => l.id) as unknown as readonly [Locale, ...Locale[]];
export const DEFAULT_LOCALE: Locale = 'en';

/** A plural message: the categories of `Intl.PluralRules`, `other` is required. */
export type PluralMessage = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };
export type Message = string | PluralMessage;
export type Dict = Record<string, Message>;
export type MessageKey = keyof typeof en;
export type Params = Record<string, string | number>;
/** A text the hub hands over untranslated: the client renders it in its own language. */
export type I18nText = { key: string; params?: Params };

export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && LOCALES.some(l => l.id === v);
}

/** The base subtag a language falls back to when its exact tag is not supported. */
const BY_LANGUAGE: Record<string, Locale> = { en: 'en', ru: 'ru', zh: 'zh-CN', es: 'es', pt: 'pt-BR', de: 'de', fr: 'fr', ja: 'ja', ko: 'ko', th: 'th' };

/** The first supported language of a preference list (`navigator.languages`, `Accept-Language`): exact tag, then the base subtag. */
export function matchLocale(tags: readonly string[]): Locale {
  for (const raw of tags) {
    const tag = raw.trim();
    if (!tag) continue;
    const exact = LOCALES.find(l => l.id.toLowerCase() === tag.toLowerCase());
    if (exact) return exact.id;
    const base = BY_LANGUAGE[tag.split(/[-_]/)[0]!.toLowerCase()];
    if (base) return base;
  }
  return DEFAULT_LOCALE;
}

/** `Accept-Language: de-DE,de;q=0.9,en;q=0.8` → tags by descending q. */
export function parseAcceptLanguage(header: string | undefined): string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((part, i) => {
      const [tag, ...attrs] = part.trim().split(';');
      const q = attrs.map(a => /^\s*q=([0-9.]+)\s*$/.exec(a)).find(Boolean);
      return { tag: tag!.trim(), q: q ? Number(q[1]) : 1, i };
    })
    .filter(x => x.tag && x.tag !== '*' && x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i)
    .map(x => x.tag);
}

/** The dictionary of a language; one `import()` per language so a bundler splits them. */
export async function loadMessages(locale: Locale): Promise<Dict> {
  switch (locale) {
    case 'en':
      return en;
    case 'ru':
      return (await import('./messages/ru/index.js')).default;
    case 'zh-CN':
      return (await import('./messages/zh-CN/index.js')).default;
    case 'es':
      return (await import('./messages/es/index.js')).default;
    case 'pt-BR':
      return (await import('./messages/pt-BR/index.js')).default;
    case 'de':
      return (await import('./messages/de/index.js')).default;
    case 'fr':
      return (await import('./messages/fr/index.js')).default;
    case 'ja':
      return (await import('./messages/ja/index.js')).default;
    case 'ko':
      return (await import('./messages/ko/index.js')).default;
    case 'th':
      return (await import('./messages/th/index.js')).default;
    default:
      return en;
  }
}

export const englishMessages: Dict = en;

function interpolate(text: string, params: Params | undefined): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

export type Translate = (key: MessageKey, params?: Params) => string;

/**
 * `t(key, params)`: `{name}` placeholders; a plural message picks its form by `params.count`. A key missing in the
 * language falls back to English, missing in English too — the key itself.
 */
export function createT(locale: Locale, dict: Dict): Translate & { locale: Locale; text: (k: string, p?: Params) => string } {
  const rules = new Intl.PluralRules(locale);
  const text = (key: string, params?: Params): string => {
    const msg: Message = (Object.hasOwn(dict, key) ? dict[key] : undefined) ?? (Object.hasOwn(englishMessages, key) ? englishMessages[key] : undefined) ?? key;
    if (typeof msg === 'string') return interpolate(msg, params);
    const count = Number(params?.count ?? 0);
    const form = msg[rules.select(count)] ?? msg.other;
    return interpolate(form, params);
  };
  const t = ((key: MessageKey, params?: Params) => text(key, params)) as Translate & { locale: Locale; text: typeof text };
  t.locale = locale;
  t.text = text;
  return t;
}

/** Placeholder names of a message (all plural forms), for the dictionary tests. */
export function placeholders(msg: Message): string[] {
  const forms = typeof msg === 'string' ? [msg] : Object.values(msg);
  const names = new Set<string>();
  for (const f of forms) for (const m of f.matchAll(/\{(\w+)\}/g)) names.add(m[1]!);
  return [...names].sort();
}
