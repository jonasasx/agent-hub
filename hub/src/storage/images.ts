// Images in the chat (design D19): type by signature, size by header, content-addressed storage.
import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/db.js';
import { imageDimensions } from '../replication/extract.js';
import type { ObjectStore } from './objectStore.js';

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
export const MAX_IMAGE_SIDE = 8000;

/** png / jpeg / gif / webp by the first bytes; anything else is not an image for the hub. */
export function sniffImage(b: Buffer): ImageMime | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && (b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a')) return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

export interface StoredImage {
  sha256: string;
  mime: ImageMime;
  size: number;
  width: number;
  height: number;
  /** false when the object already existed (no second upload). */
  uploaded: boolean;
}

export class ImageError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Checks an image and stores it as blobs/<sha256> (once), readable by the user. */
export async function storeImage(db: Db, store: ObjectStore, userId: string, bytes: Buffer): Promise<StoredImage> {
  const mime = sniffImage(bytes);
  if (!mime) throw new ImageError(415, 'not_image', 'Это не изображение PNG, JPEG, GIF или WebP');
  const dims = imageDimensions(bytes);
  if (!dims) throw new ImageError(415, 'not_image', 'Не удалось прочитать размер изображения');
  if (dims.width > MAX_IMAGE_SIDE || dims.height > MAX_IMAGE_SIDE) throw new ImageError(422, 'image_too_large', `Изображение больше ${MAX_IMAGE_SIDE} px по стороне`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const known = await db.selectFrom('blobs').select('sha256').where('sha256', '=', sha256).executeTakeFirst();
  if (!known) await store.put(`blobs/${sha256}`, bytes, mime);
  await db
    .insertInto('blobs')
    .values({ sha256, s3_key: `blobs/${sha256}`, size: bytes.length, mime, width: dims.width, height: dims.height })
    .onConflict(oc => oc.column('sha256').doNothing())
    .execute();
  await db
    .insertInto('blob_owners')
    .values({ sha256, user_id: userId })
    .onConflict(oc => oc.columns(['sha256', 'user_id']).doNothing())
    .execute();
  return { sha256, mime, size: bytes.length, width: dims.width, height: dims.height, uploaded: !known };
}

/**
 * One-time links /agent-api/blobs/<token> for attachments (D19): bound to a runner and a sha256, 15 minutes,
 * reusable within that time (a re-sent command fetches again).
 */
export class BlobLinks {
  private readonly links = new Map<string, { runnerId: string; sha256: string; expires: number }>();

  constructor(private readonly ttlMs = 15 * 60_000) {}

  issue(runnerId: string, sha256: string): string {
    this.sweep();
    const token = randomBytes(32).toString('base64url');
    this.links.set(token, { runnerId, sha256, expires: Date.now() + this.ttlMs });
    return token;
  }

  resolve(token: string, runnerId: string): string | null {
    const l = this.links.get(token);
    if (!l || l.runnerId !== runnerId || l.expires < Date.now()) return null;
    return l.sha256;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.links) if (v.expires < now) this.links.delete(k);
    while (this.links.size > 1000) this.links.delete(this.links.keys().next().value!);
  }
}
