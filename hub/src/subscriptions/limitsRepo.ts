// The limits snapshot of a subscription in Postgres (subscription-limits design L4, task 5.1): one row per
// subscription, windows merged by type (a window is replaced only by a newer observation; windows missing from an event
// stay), `quiet` touches only last_quiet_at. Every query is scoped by user_id. No token here.
// Requirements: Снимок лимитов подписки; Состояния «нет данных»; Устаревшие данные; Изоляция лимитов по пользователям.
import { sql, type Selectable } from 'kysely';
import type { LimitOverage, LimitWindow, LimitsReason, LimitsSnapshot, SubscriptionLimitsView } from '@agent-hub/shared';
import type { Db, LimitsProbeOutcomeDb, SubscriptionLimitsTable } from '../db/db.js';
import type { SubscriptionMeta } from './repo.js';

export type LimitsRow = Selectable<SubscriptionLimitsTable>;
export type LimitSource = 'session' | 'probe';
/** A window as stored: the snapshot's window plus when and where it was seen. */
export type StoredLimitWindow = LimitWindow & { observedAt: string; source: LimitSource };

/** Older than this, the data is not shown as a level any more (`expired`). */
export const LIMITS_EXPIRED_MS = 24 * 60 * 60_000;
/** The default probe period: `stale` comes after two of them (60 min), also when periodic probes are off. */
export const LIMITS_DEFAULT_IDLE_SEC = 1800;

export function storedWindows(row: Pick<LimitsRow, 'windows'> | undefined): StoredLimitWindow[] {
  return Array.isArray(row?.windows) ? (row.windows as StoredLimitWindow[]) : [];
}

/**
 * Merge (L4): an incoming window replaces the stored one of its type when it was observed later; stored windows the
 * event does not mention stay. Order: the stored order, new types appended. Returns null when nothing changed.
 */
export function mergeWindows(stored: StoredLimitWindow[], incoming: LimitWindow[], observedAt: Date, source: LimitSource): StoredLimitWindow[] | null {
  const at = observedAt.toISOString();
  const out = [...stored];
  let changed = false;
  for (const w of incoming) {
    const i = out.findIndex(s => s.type === w.type);
    const next: StoredLimitWindow = { ...w, observedAt: at, source };
    if (i < 0) {
      out.push(next);
      changed = true;
    } else if (Date.parse(out[i]!.observedAt) < observedAt.getTime()) {
      out[i] = next;
      changed = true;
    }
  }
  return changed ? out.slice(-32) : null;
}

export async function getLimits(db: Db, userId: string, subscriptionId: string): Promise<LimitsRow | undefined> {
  return db.selectFrom('subscription_limits').selectAll().where('subscription_id', '=', subscriptionId).where('user_id', '=', userId).executeTakeFirst();
}

export async function listLimits(db: Db, userId: string): Promise<LimitsRow[]> {
  return db.selectFrom('subscription_limits').selectAll().where('user_id', '=', userId).execute();
}

/**
 * The row of a subscription of `userId`, created empty when missing; locked until the end of `tx`. A row of another token
 * version (review A5: the token was replaced by a hub image that does not know this table, e.g. after a rollback) is
 * reset to empty first: the snapshot of the old token never mixes with the new one.
 */
async function lockRow(tx: Db, userId: string, subscriptionId: string): Promise<LimitsRow | undefined> {
  // only a subscription of this user gets a row (the composite FK checks it too, review A6)
  await sql`INSERT INTO subscription_limits (subscription_id, user_id, token_at)
            SELECT id, user_id, token_updated_at FROM subscriptions WHERE id = ${subscriptionId} AND user_id = ${userId}
            ON CONFLICT (subscription_id) DO UPDATE SET token_at = EXCLUDED.token_at, windows = '[]', overage = NULL, last_ok_at = NULL,
              last_quiet_at = NULL, last_probe_at = NULL, probe_outcome = NULL, probe_error = NULL, probe_failures = 0, updated_at = now()
            WHERE subscription_limits.token_at IS DISTINCT FROM EXCLUDED.token_at`.execute(tx);
  return tx.selectFrom('subscription_limits').selectAll().where('subscription_id', '=', subscriptionId).where('user_id', '=', userId).forUpdate().executeTakeFirst();
}

/**
 * The row when it belongs to the subscription's current token version, else undefined (review A5: a snapshot of a
 * replaced token is not shown and does not hold back probes). Without a known version the row is taken as is.
 */
export function rowOfToken(sub: { token_updated_at?: Date | null }, row: LimitsRow | undefined): LimitsRow | undefined {
  if (!row || !sub.token_updated_at || !row.token_at) return row;
  return Math.abs(sub.token_updated_at.getTime() - row.token_at.getTime()) < 2 ? row : undefined;
}

/**
 * Applies a snapshot of an event or a probe turn: windows merged, the overage replaced when the snapshot is the newest
 * data, last_ok_at moved forward. An empty snapshot (no windows) is not «data with windows»: only the overage. Returns
 * whether anything changed.
 */
export async function applySnapshot(db: Db, userId: string, subscriptionId: string, snap: LimitsSnapshot, observedAt: Date, source: LimitSource): Promise<boolean> {
  return db.transaction().execute(async tx => {
    const row = await lockRow(tx, userId, subscriptionId);
    if (!row) return false;
    const merged = mergeWindows(storedWindows(row), snap.windows, observedAt, source);
    const newest = !row.last_ok_at || row.last_ok_at.getTime() <= observedAt.getTime();
    const set: Record<string, unknown> = {};
    if (merged) set.windows = JSON.stringify(merged);
    if (snap.overage && newest) set.overage = JSON.stringify(snap.overage);
    if (snap.windows.length && newest) set.last_ok_at = observedAt;
    if (!Object.keys(set).length) return false;
    await tx
      .updateTable('subscription_limits')
      .set({ ...set, updated_at: new Date() })
      .where('subscription_id', '=', subscriptionId)
      .where('user_id', '=', userId)
      .execute();
    return true;
  });
}

/** A successful turn without an event: last_quiet_at moves forward, percents stay. */
export async function markQuiet(db: Db, userId: string, subscriptionId: string, at: Date): Promise<boolean> {
  return db.transaction().execute(async tx => {
    const row = await lockRow(tx, userId, subscriptionId);
    if (!row || (row.last_quiet_at && row.last_quiet_at.getTime() >= at.getTime())) return false;
    await tx.updateTable('subscription_limits').set({ last_quiet_at: at, updated_at: new Date() }).where('subscription_id', '=', subscriptionId).where('user_id', '=', userId).execute();
    return true;
  });
}

/**
 * The bookkeeping of a probe attempt: its time, outcome, short error and failure counter (`failed: true` — +1, else 0).
 * `at: null` — no probe was sent (no runner, outdated agents): last_probe_at and the counter stay.
 */
export async function recordProbe(db: Db, userId: string, subscriptionId: string, p: { at: Date | null; outcome: LimitsProbeOutcomeDb; error?: string | null; failed?: boolean }): Promise<boolean> {
  return db.transaction().execute(async tx => {
    const row = await lockRow(tx, userId, subscriptionId);
    if (!row) return false;
    const error = p.error ? p.error.slice(0, 200) : null;
    const failures = p.at === null ? row.probe_failures : p.failed ? row.probe_failures + 1 : 0;
    if (p.at === null && row.probe_outcome === p.outcome && row.probe_error === error) return false;
    await tx
      .updateTable('subscription_limits')
      .set({ ...(p.at ? { last_probe_at: p.at } : {}), probe_outcome: p.outcome, probe_error: error, probe_failures: failures, updated_at: new Date() })
      .where('subscription_id', '=', subscriptionId)
      .where('user_id', '=', userId)
      .execute();
    return true;
  });
}

/** Retire and token replacement (L4): the snapshot goes away, the subscription is «ещё не проверялась» again. */
export async function deleteLimits(db: Db, userId: string, subscriptionId: string): Promise<boolean> {
  const r = await db.deleteFrom('subscription_limits').where('subscription_id', '=', subscriptionId).where('user_id', '=', userId).executeTakeFirst();
  return Number(r.numDeletedRows) > 0;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** The time of the last data: windows or a quiet check, whichever is later. */
export function freshAt(row: Pick<LimitsRow, 'last_ok_at' | 'last_quiet_at'> | undefined): Date | null {
  const a = row?.last_ok_at ?? null;
  const b = row?.last_quiet_at ?? null;
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/** Why there is no data, from the outcome of the last probe attempt. */
function reasonOf(outcome: LimitsProbeOutcomeDb | null | undefined): LimitsReason {
  if (outcome === 'no_runner' || outcome === 'agent_outdated') return outcome;
  if (outcome === 'failed' || outcome === 'account_unavailable') return 'probe_failed';
  return 'not_polled';
}

/**
 * The view of one subscription (L4): `token_rejected` first; no data → `unavailable` with the reason of the last probe
 * attempt (or `not_polled`); data older than 24 h → `expired`; older than two probe periods → `stale`, except when the
 * last attempt found no runner or only outdated agents — then `unavailable` with that reason and the last data time.
 */
export function toLimitsView(
  sub: Pick<SubscriptionMeta, 'id' | 'token_rejected_at'> & Partial<Pick<SubscriptionMeta, 'token_updated_at'>>,
  rowAny: LimitsRow | undefined,
  now: Date,
  o: { idleSec: number; refreshableAt?: Date | null },
): SubscriptionLimitsView {
  const row = rowOfToken(sub, rowAny);
  const fresh = freshAt(row);
  const age = fresh ? now.getTime() - fresh.getTime() : Infinity;
  const staleMs = 2 * (o.idleSec > 0 ? o.idleSec : LIMITS_DEFAULT_IDLE_SEC) * 1000;
  let state: SubscriptionLimitsView['state'] = 'ok';
  let reason: LimitsReason | null = null;
  if (sub.token_rejected_at) [state, reason] = ['unavailable', 'token_rejected'];
  else if (!fresh) [state, reason] = ['unavailable', reasonOf(row?.probe_outcome)];
  else if (age > LIMITS_EXPIRED_MS) [state, reason] = ['unavailable', 'expired'];
  else if (age > staleMs) {
    const r = row?.probe_outcome;
    if (r === 'no_runner' || r === 'agent_outdated') [state, reason] = ['unavailable', r];
    else state = 'stale';
  }
  const quiet = row?.last_quiet_at && (!row.last_ok_at || row.last_quiet_at.getTime() > row.last_ok_at.getTime()) ? row.last_quiet_at : null;
  const overage = row?.overage as LimitOverage | null | undefined;
  return {
    subscriptionId: sub.id,
    state,
    reason,
    windows: storedWindows(row).map(w => ({ type: w.type, utilization: w.utilization, resetsAt: w.resetsAt, status: w.status, observedAt: w.observedAt, source: w.source })),
    overage: overage ? { status: overage.status, inUse: overage.inUse, enabled: overage.enabled } : null,
    lastOkAt: iso(row?.last_ok_at),
    quietAt: iso(quiet),
    lastProbeAt: iso(row?.last_probe_at),
    staleAt: state === 'stale' ? iso(fresh) : null,
    refreshableAt: o.refreshableAt && o.refreshableAt.getTime() > now.getTime() ? o.refreshableAt.toISOString() : null,
  };
}
