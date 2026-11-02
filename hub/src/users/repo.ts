// Change multi-user (spec users, design M1–M3): roles, bootstrap administrators, invites, admission at login,
// disabling, the security log.
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { INVITE_TTL_MS, SECURITY_LOG_DAYS, type AdminUserView, type InviteStatus, type InviteView, type LoginProvider, type SecurityEventKind, type SecurityEventView } from '@agent-hub/shared';
import type { Db } from '../db/db.js';
import { hashSecret } from '../auth/secrets.js';
import type { AuthUser } from '../auth/sessions.js';
import type { OidcIdentity } from '../auth/oidc.js';

/**
 * Requirement: Роли и первичный администратор — every address of OIDC_ALLOWED_EMAILS becomes (or stays) an `admin`
 * with Google. Rows that already are admins are not written: a second start changes nothing.
 */
export async function bootstrapAdmins(db: Db, emails: readonly string[]): Promise<number> {
  let changed = 0;
  for (const raw of emails) {
    const email = raw.toLowerCase();
    const r = await db
      .insertInto('users')
      .values({ email, role: 'admin', provider: 'google' })
      .onConflict(oc => oc.column('email').doUpdateSet({ role: 'admin' }).where('users.role', '<>', 'admin'))
      .returning('id')
      .execute();
    changed += r.length;
  }
  return changed;
}

// ---------- invites ----------

/** 256-bit code of an invite link (spec users «Приглашение»), base64url. */
export function newInviteCode(): string {
  return randomBytes(32).toString('base64url');
}

export const INVITE_CODE_RE = /^[A-Za-z0-9_-]{43}$/;

type InviteRow = {
  id: string;
  email: string;
  provider: LoginProvider;
  created_at: Date;
  expires_at: Date;
  used_at: Date | null;
  revoked_at: Date | null;
};

export function inviteStatus(r: Pick<InviteRow, 'expires_at' | 'used_at' | 'revoked_at'>, now = new Date()): InviteStatus {
  if (r.used_at) return 'used';
  if (r.revoked_at) return 'revoked';
  if (r.expires_at.getTime() <= now.getTime()) return 'expired';
  return 'active';
}

export function toInviteView(r: InviteRow, now = new Date()): InviteView {
  return {
    id: r.id,
    email: r.email,
    provider: r.provider,
    status: inviteStatus(r, now),
    createdAt: r.created_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    usedAt: r.used_at?.toISOString() ?? null,
    revokedAt: r.revoked_at?.toISOString() ?? null,
  };
}

const INVITE_COLUMNS = ['id', 'email', 'provider', 'created_at', 'expires_at', 'used_at', 'revoked_at'] as const;

export class InviteError extends Error {
  constructor(readonly code: 'user_exists' | 'not_found' | 'invite_used') {
    super(code);
  }
}

/**
 * Requirement: Приглашение. An address of an existing user is refused («Пользователь уже есть»); an unused invite of
 * the same address is revoked. Returns the code (shown once) and the row.
 */
export async function createInvite(db: Db, by: string, email: string, provider: LoginProvider, now = new Date()): Promise<{ code: string; invite: InviteView }> {
  const address = email.trim().toLowerCase();
  return db.transaction().execute(async tx => {
    const existing = await tx
      .selectFrom('users')
      .select('id')
      .where(sql<boolean>`lower(email) = ${address}`)
      .executeTakeFirst();
    if (existing) throw new InviteError('user_exists');
    await tx
      .updateTable('invites')
      .set({ revoked_at: now })
      .where(sql<boolean>`lower(email) = ${address}`)
      .where('used_at', 'is', null)
      .where('revoked_at', 'is', null)
      .execute();
    const code = newInviteCode();
    const row = await tx
      .insertInto('invites')
      .values({ email: address, provider, code_hash: hashSecret(code), created_by: by, created_at: now, expires_at: new Date(now.getTime() + INVITE_TTL_MS) })
      .returning(INVITE_COLUMNS)
      .executeTakeFirstOrThrow();
    return { code, invite: toInviteView(row, now) };
  });
}

export async function listInvites(db: Db, now = new Date()): Promise<InviteView[]> {
  const rows = await db.selectFrom('invites').select(INVITE_COLUMNS).orderBy('created_at', 'desc').limit(500).execute();
  return rows.map(r => toInviteView(r, now));
}

export async function revokeInvite(db: Db, id: string, now = new Date()): Promise<InviteView> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new InviteError('not_found');
  const row = await db.selectFrom('invites').select(INVITE_COLUMNS).where('id', '=', id).executeTakeFirst();
  if (!row) throw new InviteError('not_found');
  if (row.used_at) throw new InviteError('invite_used');
  if (row.revoked_at) return toInviteView(row, now);
  const r = await db.updateTable('invites').set({ revoked_at: now }).where('id', '=', id).where('used_at', 'is', null).returning(INVITE_COLUMNS).executeTakeFirst();
  if (!r) throw new InviteError('invite_used');
  return toInviteView(r, now);
}

/** The invite of a link code (any status), or null. */
export async function findInvite(db: Db, code: string): Promise<(InviteRow & { user_id: string | null }) | null> {
  if (!INVITE_CODE_RE.test(code)) return null;
  return (
    (await db
      .selectFrom('invites')
      .select([...INVITE_COLUMNS, 'user_id'])
      .where('code_hash', '=', hashSecret(code))
      .executeTakeFirst()) ?? null
  );
}

// ---------- admission (design M2) ----------

export type Admission =
  | { ok: true; user: AuthUser; created: boolean }
  | {
      ok: false;
      /**
       * `unverified` — no address or email_verified false; `not_invited` — no user and no usable invite; `disabled`;
       * `mismatch` — the invite is for another address (it stays valid); `wrong_provider` — the invite needs the other
       * provider; `expired`, `used`, `revoked` — the invite of the cookie.
       */
      reason: 'unverified' | 'not_invited' | 'disabled' | 'mismatch' | 'wrong_provider' | 'expired' | 'used' | 'revoked';
      /** mismatch / wrong_provider: the invited address and provider, for the page. */
      invite?: { email: string; provider: LoginProvider };
    };

/**
 * Requirement: Вход по приглашению. In order: the user of (provider, sub); a user of this address and provider
 * without `sub` (bootstrap administrator: `sub` is filled); a valid invite of the login cookie with the same address
 * (case-insensitive) and provider — the user is created with role `user` and the invite used, in one transaction;
 * anything else is refused before a user exists. One function for the browser and the desktop app.
 */
export async function admit(db: Db, provider: LoginProvider, identity: OidcIdentity, inviteCode: string | null, now = new Date()): Promise<Admission> {
  const email = identity.email?.toLowerCase() ?? null;
  if (!email || !identity.emailVerified) return { ok: false, reason: 'unverified' };
  const cols = ['id', 'email', 'role', 'name', 'provider', 'status', 'subject'] as const;
  const touch = async (id: string, set: { subject?: string }): Promise<AuthUser> => {
    const r = await db
      .updateTable('users')
      .set({ ...set, last_login_at: now, ...(identity.name ? { name: identity.name } : {}) })
      .where('id', '=', id)
      .returning(['id', 'email', 'role', 'name', 'provider'])
      .executeTakeFirstOrThrow();
    return r;
  };

  if (identity.subject) {
    const bySub = await db.selectFrom('users').select(cols).where('provider', '=', provider).where('subject', '=', identity.subject).executeTakeFirst();
    if (bySub) {
      if (bySub.status !== 'active') return { ok: false, reason: 'disabled' };
      return { ok: true, user: await touch(bySub.id, {}), created: false };
    }
  }
  const byEmail = await db
    .selectFrom('users')
    .select(cols)
    .where(sql<boolean>`lower(email) = ${email}`)
    .executeTakeFirst();
  if (byEmail && byEmail.provider === provider && (byEmail.subject === null || byEmail.subject === identity.subject)) {
    if (byEmail.status !== 'active') return { ok: false, reason: 'disabled' };
    return { ok: true, user: await touch(byEmail.id, identity.subject ? { subject: identity.subject } : {}), created: false };
  }

  if (!inviteCode) return { ok: false, reason: 'not_invited' };
  const invite = await findInvite(db, inviteCode);
  if (!invite) return { ok: false, reason: 'not_invited' };
  const status = inviteStatus(invite, now);
  if (status !== 'active') return { ok: false, reason: status === 'used' ? 'used' : status === 'revoked' ? 'revoked' : 'expired' };
  if (invite.provider !== provider) return { ok: false, reason: 'wrong_provider', invite: { email: invite.email, provider: invite.provider } };
  if (invite.email.toLowerCase() !== email) return { ok: false, reason: 'mismatch', invite: { email: invite.email, provider: invite.provider } };
  // The address belongs to a user of the other provider (created after the invite): not this invite's business.
  if (byEmail) return { ok: false, reason: byEmail.status === 'active' ? 'not_invited' : 'disabled' };

  return db.transaction().execute(async (tx): Promise<Admission> => {
    const used = await tx
      .updateTable('invites')
      .set({ used_at: now })
      .where('id', '=', invite.id)
      .where('used_at', 'is', null)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', now)
      .returning('id')
      .executeTakeFirst();
    if (!used) return { ok: false, reason: 'used' };
    const user = await tx
      .insertInto('users')
      .values({ email, role: 'user', provider, subject: identity.subject, name: identity.name, last_login_at: now })
      .returning(['id', 'email', 'role', 'name', 'provider'])
      .executeTakeFirstOrThrow();
    await tx.updateTable('invites').set({ user_id: user.id }).where('id', '=', invite.id).execute();
    return { ok: true, user, created: true };
  });
}

// ---------- administration ----------

/** Requirement: Администратор не видит чужие сессии — counts only, no names of machines, no sessions. */
export async function listAdminUsers(db: Db, online: (runnerId: string) => boolean): Promise<AdminUserView[]> {
  const users = await db
    .selectFrom('users as u')
    .leftJoin('invites as i', 'i.user_id', 'u.id')
    .select(['u.id', 'u.email', 'u.name', 'u.provider', 'u.role', 'u.status', 'u.last_login_at', 'u.created_at', 'i.created_at as invited_at'])
    .orderBy('u.created_at')
    .execute();
  // Only ids and owners of machines: the online flag of the gateway, nothing else leaves this function. Only `active`
  // machines count: a `pending` one (the install never ran) or a disabled one is not a machine of the user yet / any more.
  const runners = await db.selectFrom('runners').select(['id', 'user_id']).where('kind', '=', 'machine').where('state', '=', 'active').execute();
  return users.map(u => {
    const own = runners.filter(r => r.user_id === u.id);
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      provider: u.provider,
      role: u.role,
      status: u.status,
      invitedAt: u.invited_at ? new Date(u.invited_at).toISOString() : null,
      lastLoginAt: u.last_login_at?.toISOString() ?? null,
      createdAt: u.created_at.toISOString(),
      machines: { total: own.length, online: own.filter(r => online(r.id)).length },
    };
  });
}

export async function setUserStatus(db: Db, id: string, status: 'active' | 'disabled'): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const r = await db.updateTable('users').set({ status }).where('id', '=', id).executeTakeFirst();
  return Number(r.numUpdatedRows) === 1;
}

// ---------- security log (spec public-access «Журнал безопасности и выход везде») ----------

export interface SecurityEventInput {
  userId: string | null;
  kind: SecurityEventKind;
  ip?: string | null;
  userAgent?: string | null;
  provider?: string | null;
  email?: string | null;
  runnerId?: string | null;
}

/** Writes an event; a failure is logged by the caller and never breaks the request. */
export async function logSecurity(db: Db, e: SecurityEventInput): Promise<void> {
  await db
    .insertInto('security_events')
    .values({
      user_id: e.userId,
      kind: e.kind,
      ip: e.ip && isIp(e.ip) ? e.ip : null,
      user_agent: e.userAgent?.slice(0, 500) ?? null,
      provider: e.provider ?? null,
      email: e.email?.slice(0, 320) ?? null,
      runner_id: e.runnerId ?? null,
    })
    .execute();
}

function isIp(s: string): boolean {
  return /^[0-9a-fA-F:.]+$/.test(s) && s.length <= 45;
}

export async function listSecurityEvents(db: Db, userId: string, now = new Date()): Promise<SecurityEventView[]> {
  const since = new Date(now.getTime() - SECURITY_LOG_DAYS * 86400_000);
  const rows = await db
    .selectFrom('security_events as e')
    .leftJoin('runners as r', j => j.onRef('r.id', '=', 'e.runner_id').on('r.user_id', '=', userId))
    .select(['e.id', 'e.kind', 'e.at', sql<string | null>`host(e.ip)`.as('ip'), 'e.user_agent', 'e.provider', 'e.runner_id', 'r.name as runner_name'])
    .where('e.user_id', '=', userId)
    .where('e.at', '>', since)
    .orderBy('e.at', 'desc')
    .orderBy('e.id', 'desc')
    .limit(500)
    .execute();
  return rows.map(r => ({
    id: String(r.id),
    kind: r.kind,
    at: r.at.toISOString(),
    ip: r.ip,
    userAgent: r.user_agent,
    provider: r.provider === 'google' || r.provider === 'keycloak' ? r.provider : null,
    runner: r.runner_id && r.runner_name ? { id: r.runner_id, name: r.runner_name } : null,
  }));
}

/** Hourly cleanup: events older than 90 days. */
export async function expireSecurityEvents(db: Db, now = new Date()): Promise<number> {
  const r = await db
    .deleteFrom('security_events')
    .where('at', '<', new Date(now.getTime() - SECURITY_LOG_DAYS * 86400_000))
    .executeTakeFirst();
  return Number(r.numDeletedRows);
}
