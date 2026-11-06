// Change i18n D5: texts the hub hands to a person, in the language of the request. All dictionaries are loaded once at
// start, so a translation is synchronous.
import { createT, DEFAULT_LOCALE, isLocale, LOCALE_IDS, loadMessages, matchLocale, parseAcceptLanguage, type I18nText, type Locale } from '@agent-hub/shared';

type Translator = ReturnType<typeof createT>;

const translators = new Map<Locale, Translator>(await Promise.all(LOCALE_IDS.map(async l => [l, createT(l, await loadMessages(l))] as const)));

export function tr(locale: Locale): Translator {
  return translators.get(locale)!;
}

/** A keyed text in a language; English is the fallback of a missing key. */
export function render(text: I18nText, locale: Locale = DEFAULT_LOCALE): string {
  return tr(locale).text(text.key, text.params);
}

/** The order of D5: the web's header, the profile, `Accept-Language`, then `fallback` (en; tests pin ru). */
export function requestLocale(header: unknown, profile: Locale | null | undefined, acceptLanguage: string | undefined, fallback: Locale = DEFAULT_LOCALE): Locale {
  if (isLocale(header)) return header;
  if (profile) return profile;
  const tags = parseAcceptLanguage(acceptLanguage);
  return tags.length ? matchLocale(tags) : fallback;
}
