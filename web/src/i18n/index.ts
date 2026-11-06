// Change i18n D3: the interface language. The effective language is the user's choice (profile on the hub, cached in
// localStorage so the page does not flash in another language) or, with no choice, the browser language.
import { create } from 'zustand';
import { createT, englishMessages, isLocale, loadMessages, matchLocale, type Locale, type MessageKey, type Params } from '@agent-hub/shared';

const KEY = 'ah-locale';

type Translator = ReturnType<typeof createT>;

interface LocaleState {
  /** The language the interface is shown in. */
  locale: Locale;
  /** The user's explicit choice; `null` — «Как в браузере». */
  chosen: Locale | null;
  t: Translator;
}

function storedChoice(): Locale | null {
  try {
    const v = localStorage.getItem(KEY);
    return isLocale(v) ? v : null;
  } catch {
    return null;
  }
}

function storeChoice(locale: Locale | null): void {
  try {
    if (locale) localStorage.setItem(KEY, locale);
    else localStorage.removeItem(KEY);
  } catch {
    // private mode: the choice still applies for this page
  }
}

export function browserLocale(): Locale {
  const langs = typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];
  return matchLocale(langs.filter(Boolean));
}

export const useLocale = create<LocaleState>(() => ({ locale: 'en', chosen: null, t: createT('en', englishMessages) }));

let loading = 0;
/** A language pinned by `initLocale(forced)`: the profile does not move it (tests check one language). */
let pinned = false;

/** Loads the dictionary and switches the interface; a slower earlier load never overrides a later one. */
async function apply(chosen: Locale | null): Promise<void> {
  const locale = chosen ?? browserLocale();
  const ticket = ++loading;
  const dict = await loadMessages(locale);
  if (ticket !== loading) return;
  useLocale.setState({ locale, chosen, t: createT(locale, dict) });
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
}

/** Before the first render: the cached choice or the browser language. `forced` pins a language (tests). */
export function initLocale(forced?: Locale): Promise<void> {
  pinned = forced !== undefined;
  return apply(forced ?? storedChoice());
}

/** The profile language from `/api/me`: it wins over the device cache (the same language on every device). */
export function applyProfileLocale(locale: Locale | null): Promise<void> {
  if (pinned) return Promise.resolve();
  storeChoice(locale);
  const s = useLocale.getState();
  if (locale === s.chosen && s.locale === (locale ?? browserLocale())) return Promise.resolve();
  return apply(locale);
}

/** The choice in «Настройки → Язык», applied at once; saving it on the hub is the caller's job. */
export function chooseLocale(locale: Locale | null): Promise<void> {
  storeChoice(locale);
  return apply(locale);
}

export const currentLocale = (): Locale => useLocale.getState().locale;

/** `t()` outside React (toasts, actions): the current language at the moment of the call. */
export function t(key: MessageKey, params?: Params): string {
  return useLocale.getState().t(key, params);
}

/** A key that comes from the hub (`i18n.key` of a note or an error), not checked by the compiler. */
export function tText(key: string, params?: Params): string {
  return useLocale.getState().t.text(key, params);
}

/** A text of the hub for a person: the key `i18n` in the interface language when the hub sent one, the stored `text` otherwise (older data). */
export function hubText(text: string, i18n?: { key: string; params?: Params } | null): string {
  return i18n ? tText(i18n.key, i18n.params) : text;
}

/** `t` for components: re-renders when the language changes. */
export function useT(): Translator {
  return useLocale(s => s.t);
}

const cache = new Map<string, Intl.DateTimeFormat | Intl.NumberFormat | Intl.RelativeTimeFormat | Intl.Collator>();

function cached<T extends Intl.DateTimeFormat | Intl.NumberFormat | Intl.RelativeTimeFormat | Intl.Collator>(kind: string, options: object, make: (l: Locale) => T): T {
  const locale = currentLocale();
  const key = `${kind}|${locale}|${JSON.stringify(options)}`;
  let f = cache.get(key) as T | undefined;
  if (!f) {
    f = make(locale);
    cache.set(key, f);
  }
  return f;
}

/** Dates, numbers and relative time in the current language (Requirement: Перевод интерфейса). */
export const fmt = {
  date: (value: Date | number, options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }) => cached('date', options, l => new Intl.DateTimeFormat(l, options)).format(value),
  /** `14:05` — hours and minutes. */
  time: (value: Date | number) => fmt.date(value, { hour: '2-digit', minute: '2-digit' }),
  /** `06.11` / `11/06` — day and month without the year. */
  dayMonth: (value: Date | number) => fmt.date(value, { day: '2-digit', month: '2-digit' }),
  /** Date and time in the language's medium form. */
  dateTime: (value: Date | number) => fmt.date(value, { dateStyle: 'medium', timeStyle: 'short' }),
  number: (value: number, options: Intl.NumberFormatOptions = {}) => cached('number', options, l => new Intl.NumberFormat(l, options)).format(value),
  relative: (value: number, unit: Intl.RelativeTimeFormatUnit, options: Intl.RelativeTimeFormatOptions = { numeric: 'auto' }) =>
    cached('relative', options, l => new Intl.RelativeTimeFormat(l, options)).format(value, unit),
  collator: (options: Intl.CollatorOptions = {}) => cached('collator', options, l => new Intl.Collator(l, options)),
};
