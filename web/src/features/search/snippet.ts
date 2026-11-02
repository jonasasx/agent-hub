/**
 * Search results and their text fragments (design.md D10 `GET /api/search`, D6 `ts_headline`).
 * The fragment is rendered as text nodes with <mark> for the matches — never as HTML, whatever the hub sends.
 * Requirement (workspace-ui): Быстрый поиск Ctrl+K — «для совпадения по тексту — фрагмент с подсветкой».
 */
import type { SearchMatch, SearchResult, SessionView } from '../../api/types';

/**
 * A fragment: the hub sends plain text with UTF-16 offsets of the matches (M3c contract, built from ts_headline with
 * \u0001/\u0002 markers). The marker forms are accepted too, so an older hub or a raw ts_headline still renders safely.
 */
export type Snippet = { text: string; highlights?: [number, number][] } | string;

/** A row of the search: `SearchResult` of shared; the fragment may also come in a marker form. */
export interface SearchHit extends Omit<SearchResult, 'snippet' | 'match'> {
  session: SessionView;
  snippet: Snippet | null;
  match?: SearchMatch;
}

export interface SnippetPart {
  text: string;
  hit: boolean;
}

/** Decodes the entities ts_headline leaves in a fragment (it escapes nothing itself, the text is plain). */
function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39);/g, (_m, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]!);
}

/** Splits a fragment into plain and highlighted parts. Any other markup stays visible as text. */
export function snippetParts(s: Snippet | null | undefined): SnippetPart[] {
  if (!s) return [];
  if (typeof s !== 'string') {
    const out: SnippetPart[] = [];
    let at = 0;
    const ranges = [...(s.highlights ?? [])].filter(([a, b]) => a >= 0 && b > a && b <= s.text.length).sort((x, y) => x[0] - y[0]);
    for (const [a, b] of ranges) {
      if (a < at) continue;
      if (a > at) out.push({ text: s.text.slice(at, a), hit: false });
      out.push({ text: s.text.slice(a, b), hit: true });
      at = b;
    }
    if (at < s.text.length) out.push({ text: s.text.slice(at), hit: false });
    return out;
  }
  const [open, close] = s.includes('\u0001') ? ['\u0001', '\u0002'] : ['<b>', '</b>'];
  const out: SnippetPart[] = [];
  let rest = s;
  while (rest.length) {
    const a = rest.indexOf(open);
    if (a < 0) {
      out.push({ text: rest, hit: false });
      break;
    }
    if (a > 0) out.push({ text: rest.slice(0, a), hit: false });
    const b = rest.indexOf(close, a + open.length);
    const end = b < 0 ? rest.length : b;
    out.push({ text: rest.slice(a + open.length, end), hit: true });
    rest = b < 0 ? '' : rest.slice(b + close.length);
  }
  // with <b> markers the hub's fragment is HTML-escaped text: decode entities, everything is rendered as text anyway
  return (open === '<b>' ? out.map(p => ({ ...p, text: decodeEntities(p.text) })) : out).filter(p => p.text);
}

/** Response of GET /api/search: an array (D10) or `{results}`. */
export function hitsOf(body: unknown): SearchHit[] {
  const list = Array.isArray(body) ? body : body && typeof body === 'object' && Array.isArray((body as { results?: unknown }).results) ? (body as { results: unknown[] }).results : [];
  return list.flatMap(x => {
    const o = x as Partial<SearchResult> & { snippet?: Snippet | null };
    return o?.session?.id ? [{ session: o.session, snippet: o.snippet ?? null, ...(o.match ? { match: o.match } : {}) }] : [];
  });
}
