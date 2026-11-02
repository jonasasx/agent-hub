// Transcript lines shaped like the real ones on X1/HP (2026-10-25): a Read of a PNG (image block in tool_result and
// the same base64 in toolUseResult.file), an MCP screenshot in tool_result, an image pasted by the user, a 200 KB
// Bash output, desktop/cron/terminal/Orca/Remote Control markers.
import { randomUUID } from 'node:crypto';
import zlib from 'node:zlib';

/** A valid PNG of the given size (one grey row repeated), so image-size reads real dimensions. */
export function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const raw = Buffer.alloc((width + 1) * height, 0x80);
  for (let y = 0; y < height; y++) raw[y * (width + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export interface LineOpts {
  sessionId: string;
  cwd: string;
  entrypoint?: 'cli' | 'sdk-cli';
  ts?: string;
}

const base = (o: LineOpts) => ({
  isSidechain: false,
  uuid: randomUUID(),
  timestamp: o.ts ?? new Date().toISOString(),
  sessionId: o.sessionId,
  cwd: o.cwd,
  version: '2.1.310',
  gitBranch: 'master',
  ...(o.entrypoint ? { entrypoint: o.entrypoint } : {}),
});

export function userText(o: LineOpts, text: string, origin?: 'human' | 'sdk') {
  return { ...base(o), type: 'user', message: { role: 'user', content: text }, ...(origin ? { turnOrigin: origin } : {}) };
}

export function assistantText(o: LineOpts, text: string) {
  return { ...base(o), type: 'assistant', message: { id: `msg_${randomUUID()}`, role: 'assistant', content: [{ type: 'text', text }] } };
}

/** Read of an image: the base64 twice (tool_result block and toolUseResult.file), shorter than 16 KB. */
export function readImage(o: LineOpts, image: Buffer) {
  const data = image.toString('base64');
  return {
    ...base(o),
    type: 'user',
    message: { role: 'user', content: [{ tool_use_id: 'toolu_read', type: 'tool_result', content: [{ type: 'image', source: { type: 'base64', data, media_type: 'image/png' } }] }] },
    toolUseResult: { type: 'image', file: { base64: data, type: 'image/png', originalSize: image.length, dimensions: { originalWidth: 925, originalHeight: 83 } } },
  };
}

/** MCP screenshot (Playwright) in a tool_result. */
export function mcpScreenshot(o: LineOpts, image: Buffer) {
  return {
    ...base(o),
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          tool_use_id: 'toolu_shot',
          type: 'tool_result',
          content: [
            { type: 'text', text: 'Took the screenshot' },
            { type: 'image', source: { type: 'base64', data: image.toString('base64'), media_type: 'image/png' } },
          ],
        },
      ],
    },
  };
}

/** An image the user pasted into the prompt. */
export function pastedImage(o: LineOpts, image: Buffer) {
  return {
    ...base(o),
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', data: image.toString('base64'), media_type: 'image/png' } },
        { type: 'text', text: 'что на картинке?' },
      ],
    },
    turnOrigin: 'human',
  };
}

/** Bash returned 200 KB. */
export function bigBash(o: LineOpts) {
  const out = 'строка вывода 0123456789\n'.repeat(8500);
  return { ...base(o), type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_bash', type: 'tool_result', content: out }] }, toolUseResult: { stdout: out, stderr: '' } };
}

export const bridge = (o: LineOpts) => ({ type: 'bridge-session', sessionId: o.sessionId, timestamp: o.ts ?? new Date().toISOString() });
export const attachment = (o: LineOpts) => ({ ...base(o), type: 'attachment', attachment: { type: 'hook_output', content: 'x'.repeat(100) } });
export const aiTitle = (o: LineOpts, t: string) => ({ type: 'ai-title', aiTitle: t, sessionId: o.sessionId });

/** MCP result with a 300 KB structuredContent of short strings (Google Calendar list, as on the hub VM). */
export function mcpStructured(o: LineOpts) {
  const result = Array.from({ length: 1500 }, (_, i) => ({
    id: `ev${i}_20261006`,
    start: '2026-10-06',
    end: '2026-10-07',
    status: 'confirmed',
    summary: `Событие ${i} календаря`,
    htmlLink: `https://www.google.com/calendar/event?eid=${'x'.repeat(80)}${i}`,
  }));
  return {
    ...base(o),
    type: 'user',
    message: { role: 'user', content: [{ tool_use_id: 'toolu_mcp', type: 'tool_result', content: [{ type: 'text', text: 'ok: 1500 events' }] }] },
    toolUseResult: [{ type: 'text', text: 'ok: 1500 events' }],
    mcpMeta: { structuredContent: { result }, _meta: { 'claude/x': 1 } },
  };
}

/** Edit whose toolUseResult is 200 KB of short strings (bashEditDiff-like hunks) with a small structuredPatch. */
export function bigEdit(o: LineOpts) {
  const lines = Array.from({ length: 4000 }, (_, i) => `+ строка правки номер ${i} с текстом`);
  return {
    ...base(o),
    type: 'user',
    message: { role: 'user', content: [{ tool_use_id: 'toolu_edit', type: 'tool_result', content: 'The file has been updated.' }] },
    toolUseResult: {
      filePath: 'a.md',
      oldString: 'a',
      newString: 'b',
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
      bashEditDiff: { files: [{ hunks: [{ lines }] }] },
    },
  };
}
