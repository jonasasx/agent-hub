/**
 * Image normalisation in the browser before upload (design.md D19 «Пользователь → агент», p. 1–2).
 * Requirement (chat-images): Форматы и размеры изображений пользователя — PNG/JPEG/GIF/WebP by content, source
 * ≤ 20 MB, long side ≤ 2000 px and ≤ 3.75 MB (5 MB in base64); GIF and images within the limits are sent as they are,
 * except a GIF above 3.75 MB (refused) and a JPEG with an EXIF rotation or GPS (always redrawn: upright, no metadata).
 */
import { MAX_ATTACHMENTS } from '../../api/types';
import { jpegExif, pngHasAlpha, sniffImage, type ImageMime } from './format';

export { MAX_ATTACHMENTS };

export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
export const MAX_SEND_BYTES = 3.75 * 1024 * 1024;
export const MAX_SIDE = 2000;

export const ERR_FORMAT = 'chat.images.err.format';
export const ERR_TOO_BIG = 'chat.images.err.sourceTooBig';
export const ERR_DECODE = 'chat.images.err.decode';
export const ERR_GIF_TOO_BIG = 'chat.images.err.gifTooBig';

export interface Normalized {
  blob: Blob;
  mime: ImageMime;
  width: number;
  height: number;
}

export type Plan = { keep: true } | { keep: false; width: number; height: number; mime: 'image/jpeg' | 'image/webp'; quality: number };

/**
 * What to do with an image of this format and size: keep the bytes, or redraw it (smaller, or at the same size).
 * `redraw`: a JPEG with an EXIF rotation or GPS is always redrawn — the model gets it upright and without metadata.
 */
export function planNormalize(mime: ImageMime, width: number, height: number, bytes: number, hasAlpha: boolean, redraw = false): Plan {
  const long = Math.max(width, height);
  if (mime === 'image/gif') return { keep: true };
  if (!redraw && long <= MAX_SIDE && bytes <= MAX_SEND_BYTES) return { keep: true };
  const k = Math.min(1, MAX_SIDE / long);
  const w = Math.max(1, Math.round(width * k));
  const h = Math.max(1, Math.round(height * k));
  // transparency survives in WebP; everything else becomes JPEG
  return hasAlpha || mime === 'image/webp' ? { keep: false, width: w, height: h, mime: 'image/webp', quality: 0.9 } : { keep: false, width: w, height: h, mime: 'image/jpeg', quality: 0.85 };
}

/** Encodes with falling quality (step 0.1, not below 0.5) until the result fits 3.75 MB. */
export async function encodeWithin(encode: (quality: number) => Promise<Blob>, start: number): Promise<Blob> {
  let q = start;
  let out = await encode(q);
  while (out.size > MAX_SEND_BYTES && q > 0.5 + 1e-9) {
    q = Math.max(0.5, Math.round((q - 0.1) * 100) / 100);
    out = await encode(q);
  }
  return out;
}

export interface Codec {
  /** Decoded size (EXIF orientation applied) and a function that redraws it at the given size. */
  decode(file: Blob): Promise<{ width: number; height: number; draw(width: number, height: number, mime: string, quality: number): Promise<Blob> }>;
}

/** The browser codec: createImageBitmap (EXIF orientation from the image) and OffscreenCanvas (or a canvas). */
export const browserCodec: Codec = {
  async decode(file) {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return {
      width: bmp.width,
      height: bmp.height,
      async draw(width, height, mime, quality) {
        if (typeof OffscreenCanvas !== 'undefined') {
          const c = new OffscreenCanvas(width, height);
          c.getContext('2d')!.drawImage(bmp, 0, 0, width, height);
          return c.convertToBlob({ type: mime, quality });
        }
        const c = document.createElement('canvas');
        c.width = width;
        c.height = height;
        c.getContext('2d')!.drawImage(bmp, 0, 0, width, height);
        return new Promise<Blob>((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('encode'))), mime, quality));
      },
    };
  },
};

export type NormalizeResult = { ok: true; image: Normalized } | { ok: false; error: string };

/** Checks and normalises one file; the reason of a refusal is shown at its thumbnail. */
export async function normalizeImage(file: Blob, codec: Codec = browserCodec): Promise<NormalizeResult> {
  if (file.size > MAX_SOURCE_BYTES) return { ok: false, error: ERR_TOO_BIG };
  // 128 KB: the JPEG markers before the image data (EXIF may carry a thumbnail of ~64 KB)
  const head = new Uint8Array(await file.slice(0, 128 * 1024).arrayBuffer());
  const mime = sniffImage(head);
  if (!mime) return { ok: false, error: ERR_FORMAT };
  // a GIF is sent as it is (animation): one above the API limit cannot be sent
  if (mime === 'image/gif' && file.size > MAX_SEND_BYTES) return { ok: false, error: ERR_GIF_TOO_BIG };
  let decoded: Awaited<ReturnType<Codec['decode']>>;
  try {
    decoded = await codec.decode(file);
  } catch {
    return { ok: false, error: ERR_DECODE };
  }
  const exif = mime === 'image/jpeg' ? jpegExif(head) : null;
  const redraw = !!exif && ((exif.orientation !== null && exif.orientation !== 1) || exif.gps);
  const plan = planNormalize(mime, decoded.width, decoded.height, file.size, mime === 'image/png' && pngHasAlpha(head), redraw);
  if (plan.keep) return { ok: true, image: { blob: file.type === mime ? file : new Blob([file], { type: mime }), mime, width: decoded.width, height: decoded.height } };
  try {
    const blob = await encodeWithin(q => decoded.draw(plan.width, plan.height, plan.mime, q), plan.quality);
    if (blob.size > MAX_SEND_BYTES) return { ok: false, error: 'chat.images.err.shrink' };
    return { ok: true, image: { blob, mime: plan.mime, width: plan.width, height: plan.height } };
  } catch {
    return { ok: false, error: ERR_DECODE };
  }
}
