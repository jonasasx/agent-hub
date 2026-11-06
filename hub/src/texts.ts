// Change i18n D6: human text the hub stores or pushes. The English text stays for older clients and logs; `i18n` is the
// same text as a key, the client renders it in its own language.
import type { I18nText, Params } from '@agent-hub/shared';
import { render } from './i18n.js';

export function keyed(key: string, params?: Params): I18nText {
  return params ? { key, params } : { key };
}

/** `{ text, i18n }` for an event or a view: the English text and its key. */
export function tx(key: string, params?: Params): { text: string; i18n: I18nText } {
  const i18n = keyed(key, params);
  return { text: render(i18n, 'en'), i18n };
}

/** `{ error, errorI18n }` for a result that carries a failure text: the English text and its key. */
export function failText(i18n: I18nText): { error: string; errorI18n: I18nText } {
  return { error: render(i18n, 'en'), errorI18n: i18n };
}

/** The stored JSON of a note kind with its own payload (undelivered, subscription_*): `display` is English, `i18n` is the same text as a key. */
export function jsonNote(i18n: I18nText, extra: Record<string, unknown>): string {
  return JSON.stringify({ display: render(i18n, 'en'), i18n, ...extra });
}
