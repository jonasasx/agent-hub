// Unit tests: captions, format by content, normalisation plan and quality loop (design.md D19).
// Requirement (chat-images): Форматы и размеры изображений пользователя.
import { describe, expect, it } from 'vitest';
import { formatBytes, imageCaption, imageOfBlock, jpegExif, pngHasAlpha, sniffImage } from './format';
import { ERR_DECODE, ERR_FORMAT, ERR_GIF_TOO_BIG, ERR_TOO_BIG, MAX_SEND_BYTES, encodeWithin, normalizeImage, planNormalize, type Codec } from './normalize';

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** A PNG header with IHDR of the given colour type (byte 25). */
function png(colourType: number, extra: number[] = []): Uint8Array {
  const ihdr = [0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0, 0, 0, 1, 0, 8, colourType, 0, 0, 0, 0, 0, 0, 0];
  return new Uint8Array([...PNG_HEAD, ...ihdr, ...extra]);
}
const chunk = (type: string, len = 0) => [0, 0, 0, len, ...[...type].map(c => c.charCodeAt(0)), ...new Array(len + 4).fill(0)];

describe('format', () => {
  it('captions', () => {
    expect(imageCaption({ mime: 'image/png', size: 188_416, width: 1280, height: 720 })).toBe('PNG · 1280×720 · 184 КБ');
    expect(imageCaption({ mime: 'image/jpeg', size: 1_258_291 })).toBe('JPEG · 1,2 МБ');
    expect(formatBytes(512)).toBe('512 Б');
  });

  it('sniffs the format by content, not by the name', () => {
    expect(sniffImage(new Uint8Array(PNG_HEAD))).toBe('image/png');
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(new TextEncoder().encode('GIF89a...'))).toBe('image/gif');
    expect(sniffImage(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImage(new TextEncoder().encode('%PDF-1.7'))).toBeNull();
    expect(sniffImage(new TextEncoder().encode('hello, this is text in a .png'))).toBeNull();
  });

  it('PNG transparency: colour type with alpha or a tRNS chunk', () => {
    expect(pngHasAlpha(png(6))).toBe(true);
    expect(pngHasAlpha(png(2))).toBe(false);
    expect(pngHasAlpha(png(3, chunk('PLTE', 3).concat(chunk('tRNS', 1))))).toBe(true);
    expect(pngHasAlpha(png(3, chunk('PLTE', 3).concat(chunk('IDAT', 2))))).toBe(false);
  });

  it('reads an image block with a $blob source', () => {
    expect(imageOfBlock({ type: 'image', source: { $blob: 'ab', mime: 'image/png', size: 10, width: 4, height: 3 } })).toEqual({ sha256: 'ab', mime: 'image/png', size: 10, width: 4, height: 3 });
    expect(imageOfBlock({ type: 'image', source: { type: 'base64', data: 'xx' } })).toBeNull();
    expect(imageOfBlock({ type: 'text', text: 'x' })).toBeNull();
  });
});

describe('normalisation plan (D19 p. 2)', () => {
  it('JPEG 4000×3000, 6 MB → JPEG 2000×1500', () => {
    expect(planNormalize('image/jpeg', 4000, 3000, 6 * 1024 * 1024, false)).toEqual({ keep: false, width: 2000, height: 1500, mime: 'image/jpeg', quality: 0.85 });
  });
  it('a PNG with transparency that is too big becomes WebP', () => {
    expect(planNormalize('image/png', 3000, 1000, 2_000_000, true)).toMatchObject({ keep: false, width: 2000, height: 667, mime: 'image/webp' });
  });
  it('a PNG without transparency becomes JPEG', () => {
    expect(planNormalize('image/png', 2400, 2400, 2_000_000, false)).toMatchObject({ keep: false, mime: 'image/jpeg', width: 2000, height: 2000 });
  });
  it('GIF is never changed; an image within the limits is kept as it is', () => {
    expect(planNormalize('image/gif', 4000, 4000, 10_000_000, false)).toEqual({ keep: true });
    expect(planNormalize('image/png', 1280, 720, 300_000, true)).toEqual({ keep: true });
  });
  it('an image within 2000 px but above 3.75 MB is re-encoded at the same size', () => {
    expect(planNormalize('image/jpeg', 1800, 1200, 4_500_000, false)).toMatchObject({ keep: false, width: 1800, height: 1200 });
  });
  it('quality falls by 0.1 down to 0.5 until the result fits 3.75 MB', async () => {
    const asked: number[] = [];
    const out = await encodeWithin(async q => {
      asked.push(q);
      return new Blob([new Uint8Array(q > 0.6 ? MAX_SEND_BYTES + 1 : 1000)]);
    }, 0.85);
    expect(asked).toEqual([0.85, 0.75, 0.65, 0.55]);
    expect(out.size).toBe(1000);
  });
});

describe('normalizeImage', () => {
  const codec = (width: number, height: number, drawn: number[] = []): Codec => ({
    async decode() {
      return {
        width,
        height,
        async draw(w, h, mime) {
          drawn.push(w, h);
          return new Blob([new Uint8Array(1000)], { type: mime });
        },
      };
    },
  });
  const file = (bytes: number[], size = bytes.length, type = '') => {
    const pad = size > bytes.length ? new Uint8Array(size - bytes.length) : new Uint8Array(0);
    return new File([new Uint8Array(bytes), pad], 'x', { type });
  };

  it('refuses another format and a source above 20 MB', async () => {
    expect(await normalizeImage(file([...new TextEncoder().encode('%PDF-1.7')]), codec(10, 10))).toEqual({ ok: false, error: ERR_FORMAT });
    expect(await normalizeImage(file(PNG_HEAD, 25 * 1024 * 1024), codec(10, 10))).toEqual({ ok: false, error: ERR_TOO_BIG });
  });
  it('a file that does not decode', async () => {
    const broken: Codec = { decode: () => Promise.reject(new Error('x')) };
    expect(await normalizeImage(file(PNG_HEAD), broken)).toEqual({ ok: false, error: ERR_DECODE });
  });
  it('a large photo is redrawn at 2000 px (EXIF orientation is applied by the decoder: its size is used)', async () => {
    const drawn: number[] = [];
    // a portrait photo stored landscape with an EXIF rotation: the decoder reports 3000×4000
    const r = await normalizeImage(file([0xff, 0xd8, 0xff, 0xe1], 6 * 1024 * 1024, 'image/jpeg'), codec(3000, 4000, drawn));
    expect(r).toMatchObject({ ok: true, image: { mime: 'image/jpeg', width: 1500, height: 2000 } });
    expect(drawn).toEqual([1500, 2000]);
  });
  it('a small image and a GIF keep their bytes', async () => {
    const small = file(PNG_HEAD, 50_000, 'image/png');
    const r = await normalizeImage(small, codec(800, 600));
    expect(r.ok && r.image.blob).toBe(small);
    const gif = file([...new TextEncoder().encode('GIF89a')], 30_000_00, 'image/gif');
    const g = await normalizeImage(gif, codec(4000, 4000));
    expect(g.ok && g.image.blob).toBe(gif);
  });
});

/** A JPEG head: SOI, APP1 «Exif» with IFD0 entries (tag, type, count, value), then SOS. Little-endian TIFF. */
function jpegWithExif(entries: Array<[number, number]>, bigEndian = false): number[] {
  const w16 = (v: number) => (bigEndian ? [(v >> 8) & 0xff, v & 0xff] : [v & 0xff, (v >> 8) & 0xff]);
  const w32 = (v: number) => (bigEndian ? [(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff] : [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);
  const tiff = [...(bigEndian ? [0x4d, 0x4d] : [0x49, 0x49]), ...w16(42), ...w32(8), ...w16(entries.length)];
  for (const [tag, value] of entries) tiff.push(...w16(tag), ...w16(tag === 0x8825 ? 4 : 3), ...w32(1), ...(tag === 0x8825 ? w32(value) : [...w16(value), 0, 0]));
  tiff.push(...w32(0));
  const app1 = [...new TextEncoder().encode('Exif'), 0, 0, ...tiff];
  const len = app1.length + 2;
  return [0xff, 0xd8, 0xff, 0xe1, (len >> 8) & 0xff, len & 0xff, ...app1, 0xff, 0xda, 0, 2];
}

describe('JPEG EXIF (advisory: rotation and GPS are not sent)', () => {
  it('reads the orientation and the GPS pointer, both byte orders; no EXIF → nulls', () => {
    expect(jpegExif(new Uint8Array(jpegWithExif([[0x0112, 6]])))).toEqual({ orientation: 6, gps: false });
    expect(
      jpegExif(
        new Uint8Array(
          jpegWithExif(
            [
              [0x0112, 1],
              [0x8825, 100],
            ],
            true,
          ),
        ),
      ),
    ).toEqual({ orientation: 1, gps: true });
    expect(jpegExif(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toEqual({ orientation: null, gps: false });
    expect(jpegExif(new Uint8Array([0x89, 0x50]))).toEqual({ orientation: null, gps: false });
    // a truncated APP1 does not throw
    expect(jpegExif(new Uint8Array(jpegWithExif([[0x0112, 6]]).slice(0, 20)))).toEqual({ orientation: null, gps: false });
  });

  const codec = (width: number, height: number, drawn: number[]): Codec => ({
    async decode() {
      return { width, height, draw: async (w, h, mime) => (drawn.push(w, h), new Blob([new Uint8Array(500)], { type: mime })) };
    },
  });
  const jpeg = (head: number[]) => new File([new Uint8Array(head), new Uint8Array(40_000)], 'p.jpg', { type: 'image/jpeg' });

  it('a small JPEG with a rotation or GPS is redrawn at its decoded (upright) size; without them it keeps its bytes', async () => {
    const drawn: number[] = [];
    const rotated = await normalizeImage(jpeg(jpegWithExif([[0x0112, 6]])), codec(600, 800, drawn));
    expect(rotated).toMatchObject({ ok: true, image: { mime: 'image/jpeg', width: 600, height: 800 } });
    expect(drawn).toEqual([600, 800]);
    const gps = await normalizeImage(
      jpeg(
        jpegWithExif([
          [0x0112, 1],
          [0x8825, 64],
        ]),
      ),
      codec(800, 600, drawn),
    );
    expect(gps.ok && gps.image.blob.size).toBe(500); // redrawn: the metadata is gone
    const plain = jpeg(jpegWithExif([[0x0112, 1]]));
    const kept = await normalizeImage(plain, codec(800, 600, drawn));
    expect(kept.ok && kept.image.blob).toBe(plain);
  });

  it('a GIF above 3.75 MB is refused with a reason', async () => {
    const gif = new File([new TextEncoder().encode('GIF89a'), new Uint8Array(4 * 1024 * 1024)], 'a.gif', { type: 'image/gif' });
    expect(await normalizeImage(gif, codec(10, 10, []))).toEqual({ ok: false, error: ERR_GIF_TOO_BIG });
  });
});
