// push_subscriptions (migration 045): the devices of a user that can get a Web Push.
import { createHash } from 'node:crypto';
import type { Selectable } from 'kysely';
import type { Db, PushSubscriptionsTable } from '../db/db.js';

export type PushSubscriptionRow = Selectable<PushSubscriptionsTable>;

export function endpointHash(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex');
}

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  deviceLabel: string;
  locale?: string | null;
}

export type UpsertResult = { kind: 'created' | 'updated'; row: PushSubscriptionRow } | { kind: 'limit' };

/**
 * The endpoint is unique: a device that signs in as another user is rebound to him as a new one (created_at starts over, failures are forgotten).
 * The limit of devices of the owner is checked in the same transaction, under a lock of his user row.
 */
export async function upsertByEndpoint(db: Db, userId: string, input: PushSubscriptionInput, maxDevices = Infinity): Promise<UpsertResult> {
  try {
    return await upsertOnce(db, userId, input, maxDevices);
  } catch (err) {
    // two users insert the same new endpoint at once: the loser retries and finds the row of the winner
    if ((err as { code?: string }).code !== '23505') throw err;
    return upsertOnce(db, userId, input, maxDevices);
  }
}

async function upsertOnce(db: Db, userId: string, input: PushSubscriptionInput, maxDevices: number): Promise<UpsertResult> {
  return db.transaction().execute(async tx => {
    await tx.selectFrom('users').select('id').where('id', '=', userId).forUpdate().executeTakeFirst();
    const existing = await tx.selectFrom('push_subscriptions').select(['id', 'user_id']).where('endpoint', '=', input.endpoint).forUpdate().executeTakeFirst();
    if (existing?.user_id === userId) {
      const row = await tx
        .updateTable('push_subscriptions')
        .set({
          p256dh: input.p256dh,
          auth: input.auth,
          device_label: input.deviceLabel,
          locale: input.locale ?? null,
          updated_at: new Date(),
          failure_count: 0,
          last_failure_at: null,
          last_failure_status: null,
        })
        .where('id', '=', existing.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { kind: 'updated', row };
    }
    const own = await tx
      .selectFrom('push_subscriptions')
      .select(eb => eb.fn.countAll<string>().as('n'))
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    if (Number(own.n) >= maxDevices) return { kind: 'limit' };
    const now = new Date();
    if (existing) {
      const row = await tx
        .updateTable('push_subscriptions')
        .set({
          user_id: userId,
          p256dh: input.p256dh,
          auth: input.auth,
          device_label: input.deviceLabel,
          locale: input.locale ?? null,
          created_at: now,
          updated_at: now,
          last_success_at: null,
          failure_count: 0,
          last_failure_at: null,
          last_failure_status: null,
        })
        .where('id', '=', existing.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { kind: 'created', row };
    }
    const row = await tx
      .insertInto('push_subscriptions')
      .values({
        user_id: userId,
        endpoint: input.endpoint,
        endpoint_hash: endpointHash(input.endpoint),
        p256dh: input.p256dh,
        auth: input.auth,
        device_label: input.deviceLabel,
        locale: input.locale ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { kind: 'created', row };
  });
}

export async function findByEndpoint(db: Db, endpoint: string): Promise<PushSubscriptionRow | undefined> {
  return db.selectFrom('push_subscriptions').selectAll().where('endpoint', '=', endpoint).executeTakeFirst();
}

export async function listByUser(db: Db, userId: string): Promise<PushSubscriptionRow[]> {
  return db.selectFrom('push_subscriptions').selectAll().where('user_id', '=', userId).orderBy('created_at').execute();
}

export async function countByUser(db: Db, userId: string): Promise<number> {
  const r = await db
    .selectFrom('push_subscriptions')
    .select(eb => eb.fn.countAll<string>().as('n'))
    .where('user_id', '=', userId)
    .executeTakeFirstOrThrow();
  return Number(r.n);
}

export async function findByHash(db: Db, userId: string, hash: string): Promise<PushSubscriptionRow | undefined> {
  return db.selectFrom('push_subscriptions').selectAll().where('user_id', '=', userId).where('endpoint_hash', '=', hash).executeTakeFirst();
}

export async function deleteById(db: Db, userId: string, id: string): Promise<boolean> {
  const r = await db.deleteFrom('push_subscriptions').where('user_id', '=', userId).where('id', '=', id).executeTakeFirst();
  return Number(r.numDeletedRows) > 0;
}

export async function deleteByHash(db: Db, userId: string, hash: string): Promise<void> {
  await db.deleteFrom('push_subscriptions').where('user_id', '=', userId).where('endpoint_hash', '=', hash).execute();
}

export async function deleteByEndpoint(db: Db, endpoint: string): Promise<void> {
  await db.deleteFrom('push_subscriptions').where('endpoint', '=', endpoint).execute();
}

export async function markSuccess(db: Db, id: string, at: Date): Promise<void> {
  await db.updateTable('push_subscriptions').set({ last_success_at: at, failure_count: 0 }).where('id', '=', id).execute();
}

/** Counts a failure and returns the number of failures in a row. */
export async function markFailure(db: Db, id: string, status: number | null, at: Date): Promise<number> {
  const r = await db
    .updateTable('push_subscriptions')
    .set(eb => ({ last_failure_at: at, last_failure_status: status, failure_count: eb('failure_count', '+', 1) }))
    .where('id', '=', id)
    .returning('failure_count')
    .executeTakeFirst();
  return r?.failure_count ?? 0;
}

/** The devices of a user who can still be written to (an active account). */
export async function activeForUser(db: Db, userId: string): Promise<PushSubscriptionRow[]> {
  return db
    .selectFrom('push_subscriptions as p')
    .innerJoin('users as u', 'u.id', 'p.user_id')
    .selectAll('p')
    .where('p.user_id', '=', userId)
    .where('u.status', '=', 'active')
    .orderBy('p.created_at')
    .execute();
}
