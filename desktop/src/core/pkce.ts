/**
 * PKCE and the pending sign-in of the app (design D9, spec desktop-auth «Приём кода приложением»):
 * verifier 32 random bytes, challenge S256, state 16 random bytes; one pending sign-in at a time, ≤10 minutes,
 * kept only in memory.
 */
import { createHash, randomBytes } from 'node:crypto';

export const PENDING_TTL_MS = 10 * 60_000;

export function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function createVerifier(random: (n: number) => Buffer = randomBytes): string {
  return base64url(random(32));
}

export function createState(random: (n: number) => Buffer = randomBytes): string {
  return base64url(random(16));
}

/** `BASE64URL(SHA256(ASCII(verifier)))` (RFC 7636 §4.2). */
export function challengeOf(verifier: string): string {
  return base64url(createHash('sha256').update(verifier, 'ascii').digest());
}

export interface PendingLogin {
  verifier: string;
  challenge: string;
  state: string;
  returnPath: string;
  createdAt: number;
}

/** The single pending sign-in: a new one replaces the previous; `take` consumes it. */
export class PendingLoginStore {
  private pending: PendingLogin | null = null;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly random: (n: number) => Buffer = randomBytes,
  ) {}

  begin(returnPath: string): PendingLogin {
    const verifier = createVerifier(this.random);
    this.pending = { verifier, challenge: challengeOf(verifier), state: createState(this.random), returnPath, createdAt: this.now() };
    return this.pending;
  }

  /** Returns and clears the pending sign-in when `state` matches and it has not expired; otherwise null (kept if alive). */
  take(state: string): PendingLogin | null {
    const p = this.pending;
    if (!p) return null;
    if (this.now() - p.createdAt > PENDING_TTL_MS) {
      this.pending = null;
      return null;
    }
    if (p.state !== state) return null;
    this.pending = null;
    return p;
  }

  hasPending(): boolean {
    return this.pending !== null && this.now() - this.pending.createdAt <= PENDING_TTL_MS;
  }
}

/** `<hub>/auth/desktop/start?code_challenge=…&code_challenge_method=S256&state=…` */
export function startUrl(hubUrl: string, p: Pick<PendingLogin, 'challenge' | 'state'>): string {
  const q = new URLSearchParams({ code_challenge: p.challenge, code_challenge_method: 'S256', state: p.state });
  return `${hubUrl}/auth/desktop/start?${q.toString()}`;
}
