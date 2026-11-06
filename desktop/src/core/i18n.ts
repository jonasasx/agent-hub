/**
 * Texts of the main process (change `i18n`, design D8): one translator for the whole app, replaced when the language
 * changes. Language: `locale` of `/api/me` of the hub; null or before sign-in — the language of the system.
 */
import { DEFAULT_LOCALE, createT, englishMessages, loadMessages, matchLocale, type Locale, type MessageKey, type Params } from '@agent-hub/shared';

let current = createT(DEFAULT_LOCALE, englishMessages);

export function currentLocale(): Locale {
  return current.locale;
}

/** Translates into the current language. */
export function dt(key: MessageKey, params?: Params): string {
  return current(key, params);
}

/** The language to use: the profile choice of the hub, else the system language (`app.getPreferredSystemLanguages()`, `app.getLocale()`). */
export function resolveLocale(hubLocale: Locale | null | undefined, systemTags: readonly string[]): Locale {
  return hubLocale ?? matchLocale(systemTags);
}

/** Loads the dictionary and makes it current. Returns true when the language changed. */
export async function setLocale(locale: Locale): Promise<boolean> {
  if (locale === current.locale) return false;
  const dict = await loadMessages(locale);
  current = createT(locale, dict);
  return true;
}
