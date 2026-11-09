// The id_token of a login at rest (change idtoken-at-rest-denied-logout D1–D3): the same AES-256-GCM and key as the
// subscription tokens (SUBSCRIPTION_TOKEN_KEY). A session row binds its ciphertext to the session's id_hash; the cookie of a
// denied login binds it to its own purpose. Requirements: Хранение id-токена входа, Выход из провайдера со страницы отказа.
import type { Db } from '../db/db.js';
import { TokenUnreadableError, decryptToken, encryptToken, tokenKey } from '../subscriptions/crypto.js';

const DENIED_AAD = 'auth-denied';
/** Browsers drop a cookie over ~4 KB without an error: the value stays below it with the signature and attributes. */
export const DENIED_VALUE_MAX = 3500;

/** The key of the hub (SUBSCRIPTION_TOKEN_KEY), null — not configured: id tokens are not kept. */
export function idTokenKey(base64: string | undefined): Buffer | null {
  return base64 ? tokenKey(base64) : null;
}

function sessionAad(idHash: Buffer): string {
  return `auth-session:${idHash.toString('hex')}`;
}

function openOrNull(key: Buffer, aad: string, enc: Buffer): string | null {
  try {
    return decryptToken(key, aad, enc);
  } catch (err) {
    if (err instanceof TokenUnreadableError) return null;
    throw err;
  }
}

export function sealSessionIdToken(key: Buffer, idHash: Buffer, idToken: string): Buffer {
  return encryptToken(key, sessionAad(idHash), idToken);
}

/** null — the ciphertext does not decrypt (the key changed or the row was moved). */
export function openSessionIdToken(key: Buffer, idHash: Buffer, enc: Buffer): string | null {
  return openOrNull(key, sessionAad(idHash), enc);
}

/** The value of the denied-login cookie: base64url of the ciphertext; null — too large for a cookie (logout goes without a hint). */
export function sealDeniedIdToken(key: Buffer, idToken: string): string | null {
  const value = encryptToken(key, DENIED_AAD, idToken).toString('base64url');
  return value.length <= DENIED_VALUE_MAX ? value : null;
}

export function openDeniedIdToken(key: Buffer, value: string): string | null {
  return openOrNull(key, DENIED_AAD, Buffer.from(value, 'base64url'));
}

/**
 * D2: id tokens kept in plaintext before the change are encrypted into `id_token_enc`; without a key they are erased.
 * Sessions stay. Idempotent: a row is updated only while its plaintext is there. Returns the number of rows touched.
 */
export async function sealLegacyIdTokens(db: Db, key: Buffer | null): Promise<number> {
  if (!key) {
    const r = await db.updateTable('auth_sessions').set({ id_token: null }).where('id_token', 'is not', null).executeTakeFirst();
    return Number(r.numUpdatedRows);
  }
  const rows = await db.selectFrom('auth_sessions').select(['id_hash', 'id_token']).where('id_token', 'is not', null).execute();
  let n = 0;
  for (const row of rows) {
    const r = await db
      .updateTable('auth_sessions')
      .set({ id_token_enc: sealSessionIdToken(key, row.id_hash, row.id_token!), id_token: null })
      .where('id_hash', '=', row.id_hash)
      .where('id_token', '=', row.id_token)
      .executeTakeFirst();
    n += Number(r.numUpdatedRows);
  }
  return n;
}
