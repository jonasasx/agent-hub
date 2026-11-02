// fs.read_image (design D19): an image file of this machine for «Показать изображение». Only an absolute local path
// (no UNC), an image extension and signature, at most 20 MB.
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { CmdError, assertLocalPath } from './manager.js';

export const READ_IMAGE_LIMIT = 20 * 1024 * 1024;
const EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

export function sniffImage(b: Buffer): string | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

export async function readImageFile(path: string): Promise<{ sha256: string; mime: string; size: number; mtimeMs: number; data: Buffer }> {
  assertLocalPath(path);
  if (!EXT.has(extname(path).toLowerCase())) throw new CmdError('not_image', 'not an image file (png, jpg, gif, webp)');
  let st;
  try {
    st = await stat(path);
  } catch {
    throw new CmdError('not_found', 'file not found');
  }
  if (!st.isFile()) throw new CmdError('not_found', 'not a file');
  if (st.size > READ_IMAGE_LIMIT) throw new CmdError('too_large', 'file is larger than 20 MB');
  const data = await readFile(path);
  const mime = sniffImage(data);
  if (!mime) throw new CmdError('not_image', 'the file content is not an image');
  return { sha256: createHash('sha256').update(data).digest('hex'), mime, size: data.length, mtimeMs: Math.floor(st.mtimeMs), data };
}
