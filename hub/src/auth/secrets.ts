import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 32 random bytes, base64url: browser session cookies and agent tokens (256 bits of entropy). */
export function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 of the secret. A slow hash is unnecessary for 256-bit random values (design.md D12). */
export function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
