// Requirement: Браузерная сессия 30 дней
import { isLocale, type Locale } from '@agent-hub/shared';
import type { Db } from '../db/db.js';
import { hashSecret, newSecret } from './secrets.js';
import { openSessionIdToken, sealSessionIdToken } from './idToken.js';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = 'ah_session';

export interface AuthUser {
  id: string;
  email: string;
  role: 'admin' | 'user';
  name: string | null;
  provider: 'google' | 'keycloak' | 'oidc';
  /** change i18n D4: the interface language of the profile; set on a session lookup, `null` — the browser language. */
  locale?: Locale | null;
}

export const AUTH_USER_COLUMNS = ['users.id', 'users.email', 'users.role', 'users.name', 'users.provider'] as const;

/**
 * Finds or creates a user by address (role `user`, Google). Login no longer creates users (multi-user M2: invite or
 * bootstrap administrator); this is for the CLI, the dev login of e2e and tests.
 */
export async function upsertUser(db: Db, email: string): Promise<AuthUser> {
  const row = await db
    .insertInto('users')
    .values({ email: email.toLowerCase() })
    .onConflict(oc => oc.column('email').doUpdateSet({ email: email.toLowerCase() }))
    .returning(['id', 'email', 'role', 'name', 'provider'])
    .executeTakeFirstOrThrow();
  return row;
}

/** Creates a server-side session; returns the cookie value (only its hash is stored). */
/**
 * `idToken` — keycloak-auth D7: kept for the `id_token_hint` of the provider logout, encrypted with `key`
 * (idtoken-at-rest-denied-logout D1); without a key it is not kept.
 */
export async function createSession(db: Db, userId: string, userAgent: string | undefined, now = new Date(), idToken: string | null = null, key: Buffer | null = null): Promise<string> {
  const token = newSecret();
  const idHash = hashSecret(token);
  await db
    .insertInto('auth_sessions')
    .values({
      id_hash: idHash,
      user_id: userId,
      created_at: now,
      expires_at: new Date(now.getTime() + SESSION_TTL_MS),
      user_agent: userAgent?.slice(0, 500) ?? null,
      id_token_enc: idToken && key ? sealSessionIdToken(key, idHash, idToken) : null,
    })
    .execute();
  return token;
}

export interface AuthSession {
  user: AuthUser;
  /** sha256 of the cookie value: identifies the session without keeping the secret. */
  idHash: Buffer;
  expiresAt: Date;
}

export async function findSession(db: Db, token: string | undefined, now = new Date()): Promise<AuthSession | null> {
  if (!token) return null;
  const idHash = hashSecret(token);
  const row = await db
    .selectFrom('auth_sessions')
    .innerJoin('users', 'users.id', 'auth_sessions.user_id')
    .leftJoin('user_preferences', 'user_preferences.user_id', 'users.id')
    .select([...AUTH_USER_COLUMNS, 'auth_sessions.expires_at', 'user_preferences.locale'])
    .where('auth_sessions.id_hash', '=', idHash)
    .where('auth_sessions.expires_at', '>', now)
    // Requirement: Отключение пользователя — a disabled user has no session (his rows are deleted too, this is the guard).
    .where('users.status', '=', 'active')
    .executeTakeFirst();
  if (!row) return null;
  const locale = isLocale(row.locale) ? row.locale : null;
  return { user: { id: row.id, email: row.email, role: row.role, name: row.name, provider: row.provider, locale }, idHash, expiresAt: row.expires_at };
}

export async function findSessionUser(db: Db, token: string | undefined, now = new Date()): Promise<AuthUser | null> {
  return (await findSession(db, token, now))?.user ?? null;
}

/** Deletes the session; returns its id_token (keycloak-auth D7), null — none, unreadable with `key` or no session. */
export async function deleteSession(db: Db, token: string | undefined, key: Buffer | null = null): Promise<string | null> {
  if (!token) return null;
  const idHash = hashSecret(token);
  const r = await db.deleteFrom('auth_sessions').where('id_hash', '=', idHash).returning('id_token_enc').executeTakeFirst();
  if (!r?.id_token_enc || !key) return null;
  return openSessionIdToken(key, idHash, r.id_token_enc);
}

/** Deletes every browser session of the user except `keep` (sha256 of a cookie); returns the hashes deleted. */
export async function deleteUserSessions(db: Db, userId: string, keep?: Buffer): Promise<Buffer[]> {
  let q = db.deleteFrom('auth_sessions').where('user_id', '=', userId);
  if (keep) q = q.where('id_hash', '<>', keep);
  return (await q.returning('id_hash').execute()).map(r => r.id_hash);
}

export async function deleteExpiredSessions(db: Db, now = new Date()): Promise<number> {
  const r = await db.deleteFrom('auth_sessions').where('expires_at', '<=', now).executeTakeFirst();
  return Number(r.numDeletedRows);
}
