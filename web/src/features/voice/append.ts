/**
 * Dictated text goes to the end of the draft (design.md D7).
 * Requirement (voice-input): Завершение записи и вставка текста — one space before the text when the draft is not
 * empty and does not end with whitespace.
 */
export function appendDictation(draft: string, text: string): string {
  const t = text.trim();
  if (!t) return draft;
  if (!draft || /\s$/.test(draft)) return draft + t;
  return `${draft} ${t}`;
}
