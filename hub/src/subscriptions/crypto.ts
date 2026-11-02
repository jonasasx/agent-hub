// Subscription tokens at rest (claude-subscriptions design P1): AES-256-GCM, a random 12-byte IV per record, the
// subscription id as AAD (a ciphertext cannot be moved to another row). Stored as iv(12) ‖ tag(16) ‖ ciphertext.
// Requirement: Хранение токена подписки.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV = 12;
const TAG = 16;

/** The stored token does not decrypt with the hub's key (the key changed, the row was tampered with or moved). */
export class TokenUnreadableError extends Error {
  constructor() {
    super('subscription token cannot be decrypted');
  }
}

/** The key of SUBSCRIPTION_TOKEN_KEY (base64 of 32 bytes, checked by loadConfig). */
export function tokenKey(base64: string): Buffer {
  const k = Buffer.from(base64, 'base64');
  if (k.length !== 32) throw new Error('SUBSCRIPTION_TOKEN_KEY must be 32 bytes');
  return k;
}

export function encryptToken(key: Buffer, subscriptionId: string, token: string): Buffer {
  const iv = randomBytes(IV);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(subscriptionId, 'utf8'));
  const ct = Buffer.concat([c.update(token, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

export function decryptToken(key: Buffer, subscriptionId: string, enc: Buffer): string {
  if (enc.length <= IV + TAG) throw new TokenUnreadableError();
  try {
    const d = createDecipheriv('aes-256-gcm', key, enc.subarray(0, IV));
    d.setAAD(Buffer.from(subscriptionId, 'utf8'));
    d.setAuthTag(enc.subarray(IV, IV + TAG));
    return Buffer.concat([d.update(enc.subarray(IV + TAG)), d.final()]).toString('utf8');
  } catch {
    throw new TokenUnreadableError();
  }
}

/** What the UI shows of a Codex sign-in: the last 4 characters of the ChatGPT account id (or dots). */
export function codexHint(authJson: string): string {
  try {
    const id = (JSON.parse(authJson) as { tokens?: { account_id?: unknown } }).tokens?.account_id;
    return typeof id === 'string' && id.length >= 4 ? id.slice(-4) : '····';
  } catch {
    return '····';
  }
}

/** What the UI shows of a token: its last 4 characters. */
export function tokenHint(token: string): string {
  return token.slice(-4);
}

/** The ChatGPT account and the CLI's last token refresh of an auth.json (null — absent or unreadable). */
export function codexAuthInfo(authJson: string): { accountId: string | null; refreshedAt: number | null } {
  try {
    const o = JSON.parse(authJson) as { last_refresh?: unknown; tokens?: { account_id?: unknown } };
    const t = typeof o.last_refresh === 'string' ? Date.parse(o.last_refresh) : NaN;
    return { accountId: typeof o.tokens?.account_id === 'string' ? o.tokens.account_id : null, refreshedAt: Number.isFinite(t) ? t : null };
  } catch {
    return { accountId: null, refreshedAt: null };
  }
}
