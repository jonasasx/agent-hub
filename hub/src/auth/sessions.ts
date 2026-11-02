// Requirement: Браузерная сессия 30 дней
import type { Db } from '../db/db.js';
import { hashSecret, newSecret } from './secrets.js';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = 'ah_session';

export interface AuthUser {
  id: string;
  email: string;
  role: 'admin' | 'user';
  name: string | null;
  provider: 'google' | 'keycloak';
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
export async function createSession(db: Db, userId: string, userAgent: string | undefined, now = new Date()): Promise<string> {
  const token = newSecret();
  await db
    .insertInto('auth_sessions')
    .values({
      id_hash: hashSecret(token),
      user_id: userId,
      created_at: now,
      expires_at: new Date(now.getTime() + SESSION_TTL_MS),
      user_agent: userAgent?.slice(0, 500) ?? null,
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
    .select([...AUTH_USER_COLUMNS, 'auth_sessions.expires_at'])
    .where('auth_sessions.id_hash', '=', idHash)
    .where('auth_sessions.expires_at', '>', now)
    // Requirement: Отключение пользователя — a disabled user has no session (his rows are deleted too, this is the guard).
    .where('users.status', '=', 'active')
    .executeTakeFirst();
  return row ? { user: { id: row.id, email: row.email, role: row.role, name: row.name, provider: row.provider }, idHash, expiresAt: row.expires_at } : null;
}

export async function findSessionUser(db: Db, token: string | undefined, now = new Date()): Promise<AuthUser | null> {
  return (await findSession(db, token, now))?.user ?? null;
}

export async function deleteSession(db: Db, token: string | undefined): Promise<void> {
  if (!token) return;
  await db.deleteFrom('auth_sessions').where('id_hash', '=', hashSecret(token)).execute();
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
