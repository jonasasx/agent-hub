// Change idtoken-at-rest-denied-logout D1, D3: the id token is sealed with the hub's key and bound to its purpose.
import { describe, expect, it } from 'vitest';
import { DENIED_VALUE_MAX, idTokenKey, openDeniedIdToken, openSessionIdToken, sealDeniedIdToken, sealSessionIdToken } from './idToken.js';

const KEY = Buffer.alloc(32, 7);
const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.payload.signature';

describe('idToken', () => {
  it('no key — null', () => {
    expect(idTokenKey(undefined)).toBeNull();
    expect(idTokenKey('')).toBeNull();
    expect(idTokenKey(KEY.toString('base64'))).toEqual(KEY);
  });

  it('a session ciphertext opens only for its own session and key', () => {
    const idHash = Buffer.alloc(32, 1);
    const enc = sealSessionIdToken(KEY, idHash, TOKEN);
    expect(enc.toString('latin1')).not.toContain('payload');
    expect(openSessionIdToken(KEY, idHash, enc)).toBe(TOKEN);
    expect(openSessionIdToken(KEY, Buffer.alloc(32, 2), enc)).toBeNull();
    expect(openSessionIdToken(Buffer.alloc(32, 8), idHash, enc)).toBeNull();
  });

  it('a denied-login value does not open as a session and back', () => {
    const value = sealDeniedIdToken(KEY, TOKEN)!;
    expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(openDeniedIdToken(KEY, value)).toBe(TOKEN);
    expect(openDeniedIdToken(KEY, 'garbage')).toBeNull();
    expect(openSessionIdToken(KEY, Buffer.alloc(32, 1), Buffer.from(value, 'base64url'))).toBeNull();
    expect(openDeniedIdToken(KEY, sealSessionIdToken(KEY, Buffer.alloc(32, 1), TOKEN).toString('base64url'))).toBeNull();
  });

  it('a token too large for a cookie is not kept', () => {
    expect(sealDeniedIdToken(KEY, 'e'.repeat(2500))!.length).toBeLessThanOrEqual(DENIED_VALUE_MAX);
    expect(sealDeniedIdToken(KEY, 'e'.repeat(2700))).toBeNull();
  });
});
