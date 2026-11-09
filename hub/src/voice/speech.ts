// The answer of the Custom LLM endpoint (change voice-conversation, D5): OpenAI chat.completion chunks over SSE, or one
// chat.completion JSON for `stream: false`. ElevenLabs speaks what arrives; silence longer than its timeout ends the
// turn, so a space goes out every few seconds while the session thinks.
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';

export const HEARTBEAT_MS = 5000;
const MODEL = 'agent-hub';

/** Where the bridge speaks to. */
export interface Speech {
  say(text: string): void;
  /** finish_reason stop; nothing is said after it. */
  end(): void;
  readonly ended: boolean;
}

/**
 * Spacing of the spoken text: the first text without its leading whitespace, trailing whitespace held until more text
 * comes (a heartbeat drops it: the heartbeat is a space itself).
 */
class Spacing {
  private started = false;
  private held = '';

  next(text: string): string {
    let t = text;
    if (!this.started) {
      t = t.trimStart();
      if (!t) return '';
      this.started = true;
    }
    const full = this.held + t;
    const body = full.trimEnd();
    this.held = full.slice(body.length);
    return body;
  }

  drop(): void {
    this.held = '';
  }
}

export class SseSpeech implements Speech {
  private readonly id = `chatcmpl-${randomUUID()}`;
  private readonly created = Math.floor(Date.now() / 1000);
  private readonly spacing = new Spacing();
  private timer: NodeJS.Timeout | undefined;
  ended = false;

  constructor(
    private readonly raw: ServerResponse,
    private readonly heartbeatMs = HEARTBEAT_MS,
  ) {
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    this.chunk({ role: 'assistant', content: '' }, null);
    this.arm();
  }

  say(text: string): void {
    if (this.ended) return;
    const t = this.spacing.next(text);
    if (!t) return;
    this.chunk({ content: t }, null);
    this.arm();
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.timer);
    this.chunk({}, 'stop');
    if (!this.raw.destroyed) this.raw.end('data: [DONE]\n\n');
  }

  /** The client went away: no more writes, no timers. */
  close(): void {
    this.ended = true;
    clearTimeout(this.timer);
  }

  private arm(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.ended) return;
      this.spacing.drop();
      this.chunk({ content: ' ' }, null);
      this.arm();
    }, this.heartbeatMs);
  }

  private chunk(delta: Record<string, string>, finish: 'stop' | null): void {
    if (this.raw.destroyed || this.raw.writableEnded) return;
    const c = { id: this.id, object: 'chat.completion.chunk', created: this.created, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] };
    this.raw.write(`data: ${JSON.stringify(c)}\n\n`);
  }
}

/** `stream: false`: the whole answer at the end. */
export class CollectedSpeech implements Speech {
  private readonly spacing = new Spacing();
  private text = '';
  ended = false;
  private resolve!: (v: object) => void;
  readonly done = new Promise<object>(r => (this.resolve = r));

  say(text: string): void {
    if (!this.ended) this.text += this.spacing.next(text);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.resolve({
      id: `chatcmpl-${randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content: this.text }, finish_reason: 'stop' }],
    });
  }
}
