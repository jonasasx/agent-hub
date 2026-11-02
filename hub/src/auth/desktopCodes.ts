// Requirement: Одноразовый код входа (change desktop-app, design.md D9) — codes of the desktop login, kept in memory.
import { createHash } from 'node:crypto';
import { hashSecret, newSecret, safeEqual } from './secrets.js';

export const DESKTOP_CODE_TTL_MS = 60_000;
export const DESKTOP_CODE_MAX = 64;

interface Entry {
  userId: string;
  email: string;
  /** PKCE code_challenge (S256) of the app. */
  challenge: string;
  /** state of the app. */
  state: string;
  expiresAt: number;
}

export interface DesktopCodeGrant {
  userId: string;
  email: string;
}

/** BASE64URL(SHA256(verifier)) — RFC 7636 S256. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/**
 * One-time codes: 32 random bytes (base64url), only sha256 is kept, TTL 60 s, at most 64 (the oldest is evicted).
 * A hub restart loses them — the exchange answers invalid_grant and the app starts the login again.
 */
export class DesktopCodeStore {
  /** Insertion order = issue order: the first key is the oldest. */
  private readonly codes = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  get size(): number {
    this.sweep();
    return this.codes.size;
  }

  issue(grant: DesktopCodeGrant & { challenge: string; state: string }): string {
    this.sweep();
    while (this.codes.size >= DESKTOP_CODE_MAX) this.codes.delete(this.codes.keys().next().value!);
    const code = newSecret();
    this.codes.set(hashSecret(code).toString('hex'), {
      userId: grant.userId,
      email: grant.email,
      challenge: grant.challenge,
      state: grant.state,
      expiresAt: this.now() + DESKTOP_CODE_TTL_MS,
    });
    return code;
  }

  /**
   * The exchange attempt: the code is removed whatever the outcome. Returns the grant only for a live code whose
   * challenge matches the verifier and whose state matches; otherwise null (one invalid_grant for every case).
   */
  redeem(code: string, verifier: string, state: string): DesktopCodeGrant | null {
    this.sweep();
    const key = hashSecret(code).toString('hex');
    const e = this.codes.get(key);
    if (!e) return null;
    this.codes.delete(key);
    if (e.expiresAt <= this.now()) return null;
    if (!safeEqual(Buffer.from(pkceChallenge(verifier)), Buffer.from(e.challenge))) return null;
    if (!safeEqual(Buffer.from(state), Buffer.from(e.state))) return null;
    return { userId: e.userId, email: e.email };
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, e] of this.codes) if (e.expiresAt <= t) this.codes.delete(k);
  }
}
