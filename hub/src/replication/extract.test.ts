import { describe, expect, it } from 'vitest';
import { PREVIEW_CHARS, extractPayloads, previewOf } from './extract.js';

const EMOJI = '\u{1F600}';

describe('previews of blob payloads', () => {
  it('does not tear a surrogate pair at the cut', () => {
    const s = 'a'.repeat(PREVIEW_CHARS - 1) + EMOJI + 'tail';
    const p = previewOf(s);
    expect(p).toBe('a'.repeat(PREVIEW_CHARS - 1));
    expect(() => JSON.parse(JSON.stringify(p))).not.toThrow();
    expect(JSON.stringify(p)).not.toMatch(/\\ud[89ab]/i);
  });

  it('keeps a pair that ends exactly at the limit and short strings', () => {
    expect(previewOf('a'.repeat(PREVIEW_CHARS - 2) + EMOJI + 'x')).toBe('a'.repeat(PREVIEW_CHARS - 2) + EMOJI);
    expect(previewOf('short')).toBe('short');
  });

  it('a big text with an emoji on the cut gives a line Postgres jsonb accepts', () => {
    const text = 'x'.repeat(PREVIEW_CHARS - 1) + EMOJI + 'y'.repeat(20_000);
    const { line } = extractPayloads({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: text }] } });
    const json = JSON.stringify(line);
    expect(json).not.toMatch(/\\ud[89ab][0-9a-f]{2}"/i);
    const blob = (line.message as { content: Array<{ content: { preview: string } }> }).content[0]!.content;
    expect(blob.preview.length).toBe(PREVIEW_CHARS - 1);
  });
});
