// Images for the in-memory hub: real PNG bytes of a given size and colour, sha256, sizes from the header.
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const cache = new Map<string, Buffer>();

/** A solid-colour RGB PNG (a stripe of another colour on top, so it is not uniform); cached — every test builds a hub. */
export function makePng(width: number, height: number, rgb: [number, number, number] = [60, 130, 220]): Buffer {
  const key = `${width}x${height}:${rgb.join(',')}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const png = buildPng(width, height, rgb);
  cache.set(key, png);
  return png;
}

function buildPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  const stripe = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) {
    row.set(rgb, 1 + x * 3);
    stripe.set([240, 180, 70], 1 + x * 3);
  }
  const raw = Buffer.concat(Array.from({ length: height }, (_, y) => (y < Math.max(1, height >> 3) ? stripe : row)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Format and size from the header: PNG IHDR, JPEG SOFn, GIF, WebP VP8/VP8L/VP8X. */
export function imageInfo(b: Buffer): { mime: string; width: number; height: number } | null {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { mime: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 10 && b.toString('ascii', 0, 3) === 'GIF') return { mime: 'image/gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const kind = b.toString('ascii', 12, 16);
    if (kind === 'VP8X') return { mime: 'image/webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (kind === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return { mime: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return { mime: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let p = 2;
    while (p + 9 < b.length) {
      if (b[p] !== 0xff) return null;
      const marker = b[p + 1]!;
      const len = b.readUInt16BE(p + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { mime: 'image/jpeg', width: b.readUInt16BE(p + 7), height: b.readUInt16BE(p + 5) };
      p += 2 + len;
    }
  }
  return null;
}
