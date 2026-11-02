// claude-subscriptions task 4.3: AES-256-GCM of subscription tokens.
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TokenUnreadableError, decryptToken, encryptToken, tokenHint, tokenKey } from './crypto.js';

const TOKEN = 'sk-ant-oat01-' + 'a'.repeat(90) + 'WXYZ';

describe('subscription token crypto', () => {
  const key = randomBytes(32);
  const id = randomUUID();

  it('decrypts with its own key and id; iv ‖ tag ‖ ciphertext; the token is not in the stored bytes', () => {
    const enc = encryptToken(key, id, TOKEN);
    expect(enc.length).toBe(12 + 16 + Buffer.byteLength(TOKEN));
    expect(enc.includes(Buffer.from(TOKEN.slice(-12)))).toBe(false);
    expect(decryptToken(key, id, enc)).toBe(TOKEN);
  });

  it('another key → TokenUnreadableError', () => {
    const enc = encryptToken(key, id, TOKEN);
    expect(() => decryptToken(randomBytes(32), id, enc)).toThrow(TokenUnreadableError);
  });

  it('the ciphertext moved to another id (AAD) → error; a flipped byte → error; too short → error', () => {
    const enc = encryptToken(key, id, TOKEN);
    expect(() => decryptToken(key, randomUUID(), enc)).toThrow(TokenUnreadableError);
    const bad = Buffer.from(enc);
    bad.writeUInt8(bad.readUInt8(bad.length - 1) ^ 1, bad.length - 1);
    expect(() => decryptToken(key, id, bad)).toThrow(TokenUnreadableError);
    expect(() => decryptToken(key, id, enc.subarray(0, 28))).toThrow(TokenUnreadableError);
  });

  it('two encryptions of one token differ (random IV)', () => {
    const a = encryptToken(key, id, TOKEN);
    const b = encryptToken(key, id, TOKEN);
    expect(a.equals(b)).toBe(false);
    expect(a.subarray(0, 12).equals(b.subarray(0, 12))).toBe(false);
  });

  it('hint = the last 4 characters; tokenKey checks the length', () => {
    expect(tokenHint(TOKEN)).toBe('WXYZ');
    expect(tokenKey(Buffer.alloc(32, 1).toString('base64')).length).toBe(32);
    expect(() => tokenKey(Buffer.alloc(16, 1).toString('base64'))).toThrow(/32 bytes/);
  });
});
