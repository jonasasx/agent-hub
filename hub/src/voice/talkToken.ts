// Conversation token (change voice-conversation, design D2): binds a conversation of the ElevenLabs agent to a user and a
// session of the hub. Signed with VOICE_LLM_KEY under a domain label, nothing is stored: the signature and `exp` decide.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isLocale, type Locale } from '@agent-hub/shared';

/** How long a conversation token is valid, ms (2 hours). */
export const TALK_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

const LABEL = 'agent-hub voice-talk v1\n';

export interface TalkClaims {
  /** User id. */
  u: string;
  /** Hub session id. */
  s: string;
  /** Expiry, ms since epoch. */
  exp: number;
  /** Language of the hub's spoken phrases: the language of the request that started the conversation. */
  l: Locale;
}

const sign = (key: string, payload: string): string =>
  createHmac('sha256', key)
    .update(LABEL + payload)
    .digest('base64url');

export function issueTalkToken(key: string, claims: { u: string; s: string; l: Locale }, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ ...claims, exp: now + TALK_TOKEN_TTL_MS } satisfies TalkClaims)).toString('base64url');
  return `${payload}.${sign(key, payload)}`;
}

/** The claims of a token signed with `key` and not expired; null for anything else. */
export function verifyTalkToken(key: string, token: unknown, now = Date.now()): TalkClaims | null {
  if (typeof token !== 'string' || token.length > 2000) return null;
  const [payload, sig, extra] = token.split('.');
  if (!payload || !sig || extra !== undefined) return null;
  const want = Buffer.from(sign(key, payload));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  let c: unknown;
  try {
    c = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const { u, s, exp, l } = (c ?? {}) as Partial<TalkClaims>;
  if (typeof u !== 'string' || typeof s !== 'string' || typeof exp !== 'number' || exp <= now || !isLocale(l)) return null;
  return { u, s, exp, l };
}

/** Constant-time comparison of the Bearer key of the Custom LLM endpoint. */
export function sameKey(given: string | undefined, key: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}
