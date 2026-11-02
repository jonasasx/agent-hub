// Moves big payloads out of transcript lines before they go to Postgres (design D4 «Вынос нагрузок»):
// base64 image/document blocks, the image copy of Read in toolUseResult.file.base64, and any string over 16 KB
// become `{"$blob": sha256, size, mime, preview?, width?, height?}`; the bytes go to S3 `blobs/<sha256>`.
// Structured copies of a tool result (`toolUseResult`, `mcpMeta.structuredContent`) and of tool inputs
// (`wireToolInputs`) bigger than 16 KB as JSON go to S3 whole (`application/json`), even when every string
// inside is short; the UI reads only `toolUseResult.structuredPatch` (Edit diff), which stays inline when ≤16 KB.
// Requirement: Хранение событий без больших полезных нагрузок.
import { createHash } from 'node:crypto';
import { imageSize } from 'image-size';

export const INLINE_LIMIT = 16 * 1024;
export const PREVIEW_CHARS = 2000;

export interface BlobRef {
  $blob: string;
  size: number;
  mime: string;
  preview?: string;
  width?: number;
  height?: number;
}

export interface ExtractedBlob {
  sha256: string;
  bytes: Buffer;
  mime: string;
  width: number | null;
  height: number | null;
}

/**
 * The first `max` UTF-16 units of `s` without a torn surrogate pair: JSON.stringify writes a lone high surrogate as
 * `\ud83d`, which Postgres refuses in jsonb (the chunk would then fail forever, the agent re-sends it).
 */
export function previewOf(s: string, max: number = PREVIEW_CHARS): string {
  if (s.length <= max) return s;
  const last = s.charCodeAt(max - 1);
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

function sha256(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

/** Width and height from the image header (no decoding); null when unknown. */
export function imageDimensions(bytes: Buffer): { width: number; height: number } | null {
  try {
    const d = imageSize(bytes);
    return d.width && d.height ? { width: d.width, height: d.height } : null;
  } catch {
    return null;
  }
}

class Collector {
  readonly blobs = new Map<string, ExtractedBlob>();

  binary(base64: string, mime: string): BlobRef {
    const bytes = Buffer.from(base64, 'base64');
    const hash = sha256(bytes);
    const dims = mime.startsWith('image/') ? imageDimensions(bytes) : null;
    if (!this.blobs.has(hash)) this.blobs.set(hash, { sha256: hash, bytes, mime, width: dims?.width ?? null, height: dims?.height ?? null });
    return { $blob: hash, size: bytes.length, mime, ...(dims ? { width: dims.width, height: dims.height } : {}) };
  }

  /** A structured value as one JSON object; the preview is the start of its JSON text. */
  json(v: unknown): BlobRef {
    const s = JSON.stringify(v);
    const bytes = Buffer.from(s, 'utf8');
    const hash = sha256(bytes);
    const mime = 'application/json';
    if (!this.blobs.has(hash)) this.blobs.set(hash, { sha256: hash, bytes, mime, width: null, height: null });
    return { $blob: hash, size: bytes.length, mime, preview: previewOf(s) };
  }

  text(s: string): BlobRef {
    const bytes = Buffer.from(s, 'utf8');
    const hash = sha256(bytes);
    const mime = 'text/plain; charset=utf-8';
    if (!this.blobs.has(hash)) this.blobs.set(hash, { sha256: hash, bytes, mime, width: null, height: null });
    return { $blob: hash, size: bytes.length, mime, preview: previewOf(s) };
  }
}

function walk(v: unknown, c: Collector): unknown {
  if (typeof v === 'string') return v.length > INLINE_LIMIT ? c.text(v) : v;
  if (Array.isArray(v)) return v.map(x => walk(x, c));
  if (!v || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  // Messages API content block: {type: image|document, source: {type: base64, media_type, data}}.
  const src = o.source as Record<string, unknown> | undefined;
  // An empty base64 is left as it is: no zero-byte blob (M3c tail).
  if ((o.type === 'image' || o.type === 'document') && src && src.type === 'base64' && typeof src.data === 'string' && src.data.length > 0) {
    const mime = typeof src.media_type === 'string' ? src.media_type : 'application/octet-stream';
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) out[k] = k === 'source' ? c.binary(src.data, mime) : walk(x, c);
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) out[k] = walk(x, c);
  return out;
}

/**
 * Returns the line with payloads replaced and the blobs to store. The same bytes (a Read image in both the
 * tool_result block and toolUseResult) give one blob.
 */
export function extractPayloads(line: Record<string, unknown>): { line: Record<string, unknown>; blobs: ExtractedBlob[] } {
  const c = new Collector();
  let input = line;
  // Read of an image: toolUseResult = {type: 'image', file: {base64, type, originalSize, dimensions}}. The base64 is
  // often shorter than 16 KB, so it is moved by its path, not by its length.
  const tur = line.toolUseResult as Record<string, unknown> | undefined;
  const file = tur && typeof tur === 'object' ? (tur.file as Record<string, unknown> | undefined) : undefined;
  if (file && typeof file === 'object' && typeof file.base64 === 'string' && file.base64.length > 0) {
    const mime = typeof file.type === 'string' ? file.type : 'application/octet-stream';
    input = { ...line, toolUseResult: { ...tur, file: { ...file, base64: c.binary(file.base64, mime) } } };
  }
  const out = walk(input, c) as Record<string, unknown>;
  // Copies of a tool result made of many small strings: measured after the walk, so blobs already moved count
  // as their references. A line already processed (backfill) changes no more: its copies are ≤16 KB or $blob.
  if ('toolUseResult' in out) out.toolUseResult = moveCopy(out.toolUseResult, c, KEEP_INLINE);
  if ('wireToolInputs' in out) out.wireToolInputs = moveCopy(out.wireToolInputs, c);
  const meta = out.mcpMeta;
  if (meta && typeof meta === 'object' && !Array.isArray(meta) && 'structuredContent' in meta) {
    out.mcpMeta = { ...meta, structuredContent: moveCopy((meta as Record<string, unknown>).structuredContent, c) };
  }
  return { line: out, blobs: [...c.blobs.values()] };
}

/** Fields of a moved toolUseResult the UI needs (transcript.ts toolDiff); kept inline when small. */
const KEEP_INLINE = ['structuredPatch'];

function jsonBytes(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8');
}

function isBlobRef(v: unknown): boolean {
  return !!v && typeof v === 'object' && typeof (v as { $blob?: unknown }).$blob === 'string';
}

/** A copy over 16 KB (UTF-8 JSON) becomes a $blob; `keep` fields of an object stay next to the reference. */
function moveCopy(v: unknown, c: Collector, keep: string[] = []): unknown {
  if (v == null || isBlobRef(v) || jsonBytes(v) <= INLINE_LIMIT) return v;
  if (typeof v === 'string') return c.text(v);
  const ref: Record<string, unknown> = { ...c.json(v) };
  if (!Array.isArray(v) && typeof v === 'object') {
    for (const k of keep) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined && jsonBytes(x) <= INLINE_LIMIT) ref[k] = x;
    }
  }
  return ref;
}

/** Text of user/assistant message blocks for full-text search (D6): no thinking, no tool results, no meta. */
export function searchText(line: Record<string, unknown>): string | null {
  // a message delivered mid-turn (queued_command, change `subagents` S6): its text is searchable
  if (line.type === 'attachment') {
    const prompt = (line.attachment as { type?: unknown; prompt?: unknown } | undefined)?.prompt;
    return typeof prompt === 'string' && prompt ? prompt.slice(0, 100_000).replaceAll('\u0001', ' ').replaceAll('\u0002', ' ') : null;
  }
  if ((line.type !== 'user' && line.type !== 'assistant') || line.isMeta === true) return null;
  const content = (line.message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return content ? content.slice(0, 100_000).replaceAll('\u0001', ' ').replaceAll('\u0002', ' ') : null;
  if (!Array.isArray(content)) return null;
  const parts = content.filter(b => b && (b as { type?: unknown }).type === 'text').map(b => String((b as { text?: unknown }).text ?? ''));
  const t = parts.join('\n').trim();
  // \u0001/\u0002 are the highlight markers of the search snippet (sessions/search.ts): never in the text.
  return t ? t.slice(0, 100_000).replaceAll('\u0001', ' ').replaceAll('\u0002', ' ') : null;
}
