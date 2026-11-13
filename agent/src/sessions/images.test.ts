// D19 on the agent: attachments become one SDKUserMessage (images, then text); a bad download fails the command and
// queues nothing; fs.read_image checks the path, the extension, the signature and the size.
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { HubMessage, PayloadOf } from '@agent-hub/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { createLogger } from '../log.js';
import { renderMachineContext } from '../machineContext.js';
import { AsyncQueue } from './asyncQueue.js';
import { readImageFile } from './images.js';
import { HUB_SYSTEM_PROMPT_APPEND, SessionManager, type QueryFn } from './manager.js';

const dir = mkdtempSync(join(tmpdir(), 'agenthub-images-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const CWD = process.platform === 'win32' ? dir : '/tmp';

function setup(fetchAttachment: (a: { url: string }) => Promise<Buffer>, now?: () => number) {
  const inputs: SDKUserMessage[] = [];
  let options: Options | null = null;
  const queryFn: QueryFn = ({ prompt, options: o }) => {
    options = o;
    const out = new AsyncQueue<never>();
    void (async () => {
      for await (const m of prompt) inputs.push(m);
    })();
    const it = out[Symbol.asyncIterator]();
    const q = {
      next: () => it.next(),
      return: () => Promise.resolve({ value: undefined, done: true }),
      [Symbol.asyncIterator]() {
        return q;
      },
      initializationResult: () => Promise.resolve({}),
      supportedModels: () => Promise.resolve([]),
      close: () => out.close(),
    };
    return q as unknown as Query;
  };
  const mgr = new SessionManager({ send: () => undefined, log: createLogger({ level: 'error', write: () => undefined }), queryFn, fetchAttachment, stopGraceMs: 100, ...(now ? { now } : {}) });
  return { mgr, inputs, options: () => options };
}

const start = (attachments: PayloadOf<HubMessage, 'session.start'>['attachments'], prompt = 'какой код?') =>
  ({
    v: 1,
    ts: 0,
    id: 'c',
    type: 'session.start',
    payload: { sessionId: randomUUID(), cwd: CWD, permissionMode: 'default', model: 'haiku', prompt, promptUuid: randomUUID(), attachments },
  }) as HubMessage;

describe('attachments on the agent', () => {
  it('one user message: images first, then the text; the hub system prompt is appended', async () => {
    const { mgr, inputs, options } = setup(() => Promise.resolve(PNG));
    await mgr.handle(start([{ sha256: sha(PNG), mime: 'image/png', size: PNG.length, url: '/agent-api/blobs/t1' }]));
    await new Promise(r => setTimeout(r, 10));
    const content = inputs[0]!.message.content as Array<{ type: string; source?: { data: string; media_type: string }; text?: string }>;
    expect(content.map(c => c.type)).toEqual(['image', 'text']);
    expect(content[0]!.source).toEqual({ type: 'base64', media_type: 'image/png', data: PNG.toString('base64') });
    expect(content[1]!.text).toBe('какой код?');
    expect(options()!.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: `${HUB_SYSTEM_PROMPT_APPEND}

${renderMachineContext(undefined)}`,
    });
  });

  it('a wrong sha256 or a failed download → attachment_fetch_failed, no process, nothing queued', async () => {
    const bad = setup(() => Promise.resolve(Buffer.from('other')));
    await expect(bad.mgr.handle(start([{ sha256: sha(PNG), mime: 'image/png', size: PNG.length, url: '/agent-api/blobs/t' }]))).rejects.toMatchObject({ code: 'attachment_fetch_failed' });
    expect(bad.options()).toBeNull();
    const down = setup(() => Promise.reject(new Error('hub answered 404')));
    await expect(down.mgr.handle(start([{ sha256: sha(PNG), mime: 'image/png', size: PNG.length, url: '/agent-api/blobs/t' }]))).rejects.toMatchObject({ code: 'attachment_fetch_failed' });
    expect(down.inputs).toHaveLength(0);
  });

  it('attachments.fetch downloads and checks the images first; start then takes them from the cache', async () => {
    let downloads = 0;
    const { mgr, inputs } = setup(() => {
      downloads++;
      return Promise.resolve(PNG);
    });
    const a = { sha256: sha(PNG), mime: 'image/png' as const, size: PNG.length, url: '/agent-api/blobs/t1' };
    expect(await mgr.handle({ v: 1, ts: 0, id: 'f', type: 'attachments.fetch', payload: { attachments: [a] } } as HubMessage)).toEqual({ cached: 1 });
    expect(downloads).toBe(1);
    await mgr.handle(start([{ ...a, url: '/agent-api/blobs/t2' }]));
    await new Promise(r => setTimeout(r, 10));
    expect(downloads).toBe(1); // from the cache
    expect((inputs[0]!.message.content as Array<{ type: string }>).map(c => c.type)).toEqual(['image', 'text']);
    // A bad image fails attachments.fetch and caches nothing.
    const bad = setup(() => Promise.resolve(Buffer.from('other')));
    await expect(bad.mgr.handle({ v: 1, ts: 0, id: 'f', type: 'attachments.fetch', payload: { attachments: [a] } } as HubMessage)).rejects.toMatchObject({ code: 'attachment_fetch_failed' });
  });

  it('the cache expires after 15 minutes', async () => {
    let now = 0;
    let downloads = 0;
    const { mgr } = setup(
      () => {
        downloads++;
        return Promise.resolve(PNG);
      },
      () => now,
    );
    const a = { sha256: sha(PNG), mime: 'image/png' as const, size: PNG.length, url: '/agent-api/blobs/t1' };
    await mgr.handle({ v: 1, ts: 0, id: 'f', type: 'attachments.fetch', payload: { attachments: [a] } } as HubMessage);
    now = 16 * 60_000;
    await mgr.handle(start([a]));
    expect(downloads).toBe(2);
  });

  it('images without text: only image blocks', async () => {
    const { mgr, inputs } = setup(() => Promise.resolve(PNG));
    await mgr.handle(start([{ sha256: sha(PNG), mime: 'image/png', size: PNG.length, url: '/agent-api/blobs/t' }], ''));
    await new Promise(r => setTimeout(r, 10));
    expect((inputs[0]!.message.content as Array<{ type: string }>).map(c => c.type)).toEqual(['image']);
  });
});

describe('fs.read_image', () => {
  it('reads a PNG; refuses a missing file, a non-image, a wrong extension and a network path', async () => {
    const p = join(dir, 'a.png');
    writeFileSync(p, PNG);
    expect(await readImageFile(p)).toMatchObject({ sha256: sha(PNG), mime: 'image/png', size: PNG.length });
    await expect(readImageFile(join(dir, 'none.png'))).rejects.toMatchObject({ code: 'not_found' });
    writeFileSync(join(dir, 'b.png'), 'not an image');
    await expect(readImageFile(join(dir, 'b.png'))).rejects.toMatchObject({ code: 'not_image' });
    writeFileSync(join(dir, 'c.txt'), PNG);
    await expect(readImageFile(join(dir, 'c.txt'))).rejects.toMatchObject({ code: 'not_image' });
    await expect(readImageFile('\\\\evil\\share\\x.png')).rejects.toMatchObject({ code: 'bad_path' });
  });
});
