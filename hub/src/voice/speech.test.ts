// Change voice-conversation (D5): the SSE chunks and the collected answer of the Custom LLM endpoint.
// Requirement: Эндпоинт Custom LLM.
import type { ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollectedSpeech, SseSpeech } from './speech.js';

function fakeRaw() {
  const out: string[] = [];
  const raw = {
    head: null as null | { status: number; headers: Record<string, string> },
    destroyed: false,
    writableEnded: false,
    writeHead(status: number, headers: Record<string, string>) {
      raw.head = { status, headers };
    },
    write(s: string) {
      out.push(s);
      return true;
    },
    end(s?: string) {
      if (s) out.push(s);
      raw.writableEnded = true;
    },
  };
  return { raw, out, res: raw as unknown as ServerResponse };
}

type Chunk = { object: string; model: string; choices: Array<{ delta: { role?: string; content?: string }; finish_reason: string | null }> };
const chunks = (out: string[]) =>
  out
    .filter(s => s !== 'data: [DONE]\n\n')
    .map(s => {
      expect(s.startsWith('data: ') && s.endsWith('\n\n')).toBe(true);
      return JSON.parse(s.slice(6)) as Chunk;
    });
const contents = (out: string[]) => chunks(out).map(c => c.choices[0]!.delta.content);

describe('SseSpeech', () => {
  afterEach(() => vi.useRealTimers());

  it('head, the role chunk, content chunks, stop and [DONE]', () => {
    const { raw, out, res } = fakeRaw();
    const s = new SseSpeech(res, 60_000);
    s.say('Привет');
    s.end();
    expect(raw.head).toMatchObject({ status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' } });
    const c = chunks(out);
    expect(c[0]!.choices[0]!.delta).toEqual({ role: 'assistant', content: '' });
    expect(c[0]).toMatchObject({ object: 'chat.completion.chunk', model: 'agent-hub' });
    expect(c[1]!.choices[0]).toEqual({ index: 0, delta: { content: 'Привет' }, finish_reason: null });
    expect(c[2]!.choices[0]).toEqual({ index: 0, delta: {}, finish_reason: 'stop' });
    expect(out.at(-1)).toBe('data: [DONE]\n\n');
    expect(raw.writableEnded).toBe(true);
  });

  it('spacing: the first text without leading whitespace, trailing whitespace held for the next text', () => {
    const { out, res } = fakeRaw();
    const s = new SseSpeech(res, 60_000);
    s.say('  \n');
    s.say('  Один. ');
    s.say('Два  ');
    s.say(' ');
    s.say('три');
    s.end();
    expect(contents(out).slice(1, -1)).toEqual(['Один.', ' Два', '   три']);
  });

  it('heartbeat: a space every period of silence, the held whitespace dropped', () => {
    vi.useFakeTimers();
    const { out, res } = fakeRaw();
    const s = new SseSpeech(res, 5000);
    s.say('Думаю ');
    vi.advanceTimersByTime(4999);
    expect(contents(out)).toEqual(['', 'Думаю']);
    vi.advanceTimersByTime(1);
    vi.advanceTimersByTime(5000);
    s.say('дальше');
    expect(contents(out)).toEqual(['', 'Думаю', ' ', ' ', 'дальше']);
    s.end();
    vi.advanceTimersByTime(20_000);
    expect(contents(out).at(-1)).toBeUndefined();
    expect(out.at(-1)).toBe('data: [DONE]\n\n');
  });

  it('nothing after end or close; end twice writes one stop', () => {
    vi.useFakeTimers();
    const { out, res } = fakeRaw();
    const s = new SseSpeech(res, 5000);
    s.end();
    s.end();
    s.say('поздно');
    expect(chunks(out).filter(c => c.choices[0]!.finish_reason === 'stop')).toHaveLength(1);
    const b = fakeRaw();
    const closed = new SseSpeech(b.res, 5000);
    closed.close();
    closed.say('x');
    vi.advanceTimersByTime(20_000);
    closed.end();
    expect(b.out).toHaveLength(1);
  });
});

describe('CollectedSpeech', () => {
  it('one chat.completion with the whole text', async () => {
    const s = new CollectedSpeech();
    s.say(' Привет,');
    s.say(' мир ');
    s.end();
    s.say('после');
    expect(await s.done).toMatchObject({
      object: 'chat.completion',
      model: 'agent-hub',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Привет, мир' }, finish_reason: 'stop' }],
    });
  });
});
