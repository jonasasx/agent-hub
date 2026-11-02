// The subscription registry in Postgres (claude-subscriptions design P2). No token ever leaves this module in a view.
import type { Selectable } from 'kysely';
import { sql } from 'kysely';
import { CODEX_SUBSCRIPTIONS_PROTOCOL, SUBSCRIPTIONS_PROTOCOL, type Provider, type SubscriptionView } from '@agent-hub/shared';
import type { Db, SubscriptionsTable } from '../db/db.js';

export type SubscriptionRow = Selectable<SubscriptionsTable>;

/** Columns of a row without the ciphertext: everything a view or a decision needs. */
export const PUBLIC_COLUMNS = [
  'id',
  'user_id',
  'name',
  'token_hint',
  'provider',
  'position',
  'auto_switch',
  'retired_at',
  'limit_resets_at',
  'limit_kind',
  'token_rejected_at',
  'token_updated_at',
  'created_at',
] as const;
export type SubscriptionMeta = Omit<SubscriptionRow, 'token_enc'>;

/** A limit counts while its reset time is in the future (a limit without a known reset is not kept, see P5). */
export function limitActive(s: Pick<SubscriptionMeta, 'limit_resets_at'>, now: Date): boolean {
  return !!s.limit_resets_at && s.limit_resets_at.getTime() > now.getTime();
}

export function toSubscriptionView(s: SubscriptionMeta, now: Date): SubscriptionView {
  const limited = limitActive(s, now);
  return {
    id: s.id,
    name: s.name,
    position: s.position,
    autoSwitch: s.auto_switch,
    retired: s.retired_at !== null,
    tokenHint: s.token_hint,
    tokenUpdatedAt: s.token_updated_at.toISOString(),
    limitResetsAt: limited ? s.limit_resets_at!.toISOString() : null,
    limitKind: limited ? s.limit_kind : null,
    tokenRejected: s.token_rejected_at !== null,
    provider: s.provider,
  };
}

/** Every subscription of the user: active ones by position, then retired ones (latest retired last). */
export async function listSubscriptions(db: Db, userId: string): Promise<SubscriptionMeta[]> {
  return db
    .selectFrom('subscriptions')
    .select(PUBLIC_COLUMNS)
    .where('user_id', '=', userId)
    .orderBy(sql`retired_at IS NOT NULL`)
    .orderBy('position')
    .orderBy('created_at')
    .execute();
}

export async function getSubscription(db: Db, userId: string, id: string): Promise<SubscriptionMeta | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  return db.selectFrom('subscriptions').select(PUBLIC_COLUMNS).where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
}

/** The last explicit choice of the user for a provider (claude by default). */
export async function lastChoiceOf(db: Db, userId: string, provider: Provider = 'claude'): Promise<string | null> {
  const col = provider === 'codex' ? 'last_codex_subscription_id' : 'last_subscription_id';
  const u = await db.selectFrom('users').select(col).where('id', '=', userId).executeTakeFirst();
  return (u as Record<string, string | null> | undefined)?.[col] ?? null;
}

/** The default subscription (P2): the last choice while it is active, else the first active one by position. */
export function defaultOf(subs: SubscriptionMeta[], lastChoiceId: string | null, provider: Provider = 'claude'): SubscriptionMeta | null {
  const active = subs.filter(s => s.retired_at === null && s.provider === provider);
  return active.find(s => s.id === lastChoiceId) ?? active[0] ?? null;
}

/** «major.minor» of the agent at least SUBSCRIPTIONS_PROTOCOL (1.4). */
export function supportsSubscriptions(protocolVersion: string | null | undefined): boolean {
  const m = /^(\d+)\.(\d+)$/.exec(protocolVersion ?? '');
  const [a, b] = SUBSCRIPTIONS_PROTOCOL.split('.').map(Number) as [number, number];
  return !!m && (Number(m[1]) > a || (Number(m[1]) === a && Number(m[2]) >= b));
}

/** The agent takes Codex subscriptions (protocol 1.11, provider-parity). */
export function supportsCodexSubscriptions(protocolVersion: string | null | undefined): boolean {
  const m = /^(\d+)\.(\d+)$/.exec(protocolVersion ?? '');
  const [a, b] = CODEX_SUBSCRIPTIONS_PROTOCOL.split('.').map(Number) as [number, number];
  return !!m && (Number(m[1]) > a || (Number(m[1]) === a && Number(m[2]) >= b));
}

/** A token version (token_updated_at) `current` is later than `launched` (QA B2; 2 ms of parse tolerance, see service). */
export function tokenNewer(current: Date, launched: Date): boolean {
  return current.getTime() - launched.getTime() >= 2;
}

/** Postgres unique violation of the active-name index. */
export function isNameTaken(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string };
  return e.code === '23505' && e.constraint === 'subscriptions_active_name';
}
