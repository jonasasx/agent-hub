/**
 * Image references, captions and format detection (design.md D19). Requirement (chat-images): Изображения от агента
 * в чате (caption «PNG · 1280×720 · 184 КБ»); Форматы и размеры изображений пользователя (format by content).
 */

/** An image stored in the hub (`blobs/<sha256>`): a `$blob` of an image block, an upload or a shown local file. */
export interface ImageRef {
  sha256: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
}

export const blobUrl = (sha256: string) => `/api/blobs/${sha256}`;

export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageMime = (typeof IMAGE_MIMES)[number];

/** «184 КБ», «1,2 МБ», «512 Б». */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} КБ`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
}

/** «PNG · 1280×720 · 184 КБ»; parts that are unknown are left out. */
export function imageCaption(img: Pick<ImageRef, 'mime' | 'size' | 'width' | 'height'>): string {
  const sub = (img.mime.split('/')[1] ?? img.mime).split(';')[0]!.toLowerCase();
  const kind = ({ png: 'PNG', jpeg: 'JPEG', jpg: 'JPEG', gif: 'GIF', webp: 'WebP' } as Record<string, string>)[sub] ?? sub.toUpperCase();
  const parts = [kind];
  if (img.width && img.height) parts.push(`${img.width}×${img.height}`);
  if (img.size) parts.push(formatBytes(img.size));
  return parts.join(' · ');
}

/** Image format by the first bytes (not by the name); null for anything else. */
export function sniffImage(head: Uint8Array): ImageMime | null {
  const b = head;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

/**
 * EXIF of a JPEG (APP1 «Exif»): the orientation (tag 0x0112, 1 = as stored) and whether a GPS block (0x8825) is
 * there. Reads the markers before the image data only; null fields when there is no EXIF or it is broken.
 */
export function jpegExif(bytes: Uint8Array): { orientation: number | null; gps: boolean } {
  const none = { orientation: null, gps: false };
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return none;
  let p = 2;
  while (p + 4 <= bytes.length && bytes[p] === 0xff) {
    const marker = bytes[p + 1]!;
    if (marker === 0xda || marker === 0xd9) return none; // image data: no EXIF before it
    const len = (bytes[p + 2]! << 8) | bytes[p + 3]!;
    if (marker === 0xe1 && p + 10 <= bytes.length && String.fromCharCode(...bytes.subarray(p + 4, p + 10)) === 'Exif\0\0') {
      return readTiff(bytes.subarray(p + 10, Math.min(bytes.length, p + 2 + len)));
    }
    p += 2 + len;
  }
  return none;
}

function readTiff(t: Uint8Array): { orientation: number | null; gps: boolean } {
  if (t.length < 8) return { orientation: null, gps: false };
  const le = t[0] === 0x49 && t[1] === 0x49;
  const u16 = (o: number) => (o + 2 <= t.length ? (le ? t[o]! | (t[o + 1]! << 8) : (t[o]! << 8) | t[o + 1]!) : 0);
  const u32 = (o: number) =>
    o + 4 <= t.length ? (le ? (t[o]! | (t[o + 1]! << 8) | (t[o + 2]! << 16) | (t[o + 3]! << 24)) >>> 0 : ((t[o]! << 24) | (t[o + 1]! << 16) | (t[o + 2]! << 8) | t[o + 3]!) >>> 0) : 0;
  const ifd = u32(4);
  const n = u16(ifd);
  let orientation: number | null = null;
  let gps = false;
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > t.length) break;
    const tag = u16(e);
    if (tag === 0x0112) orientation = u16(e + 8);
    if (tag === 0x8825) gps = true;
  }
  return { orientation, gps };
}

/** A PNG whose IHDR colour type carries alpha (4 grey+alpha, 6 RGBA) or that has a tRNS chunk before the image data. */
export function pngHasAlpha(bytes: Uint8Array): boolean {
  if (bytes.length < 26) return false;
  const colourType = bytes[25];
  if (colourType === 4 || colourType === 6) return true;
  // look for a tRNS chunk among the first chunks
  let p = 8;
  while (p + 8 <= bytes.length) {
    const len = ((bytes[p]! << 24) | (bytes[p + 1]! << 16) | (bytes[p + 2]! << 8) | bytes[p + 3]!) >>> 0;
    const type = String.fromCharCode(bytes[p + 4]!, bytes[p + 5]!, bytes[p + 6]!, bytes[p + 7]!);
    if (type === 'tRNS') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    p += 12 + len;
  }
  return false;
}

/** Image blocks a value holds: a content block `{type:'image', source:{$blob…}}`. */
export function imageOfBlock(b: unknown): ImageRef | null {
  if (!b || typeof b !== 'object') return null;
  const o = b as { type?: unknown; source?: unknown };
  if (o.type !== 'image' || !o.source || typeof o.source !== 'object') return null;
  const s = o.source as { $blob?: unknown; mime?: unknown; size?: unknown; width?: unknown; height?: unknown };
  if (typeof s.$blob !== 'string') return null;
  return {
    sha256: s.$blob,
    mime: typeof s.mime === 'string' ? s.mime : 'image/png',
    size: typeof s.size === 'number' ? s.size : 0,
    ...(typeof s.width === 'number' && typeof s.height === 'number' ? { width: s.width, height: s.height } : {}),
  };
}
