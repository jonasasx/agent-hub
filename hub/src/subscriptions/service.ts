// Subscriptions of a user (claude-subscriptions design P1, P2, P6, P7, P8, P10): the registry, the last choice, the
// token of a launch, limits and rejected tokens, usage. The token is decrypted only to build a command to an agent.
// Requirements: Реестр подписок; Хранение токена подписки; Последний выбор подписки; Учёт ходов и расход по подпискам.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { FastifyBaseLogger } from 'fastify';
import { PROVIDERS, codexCredentialSchema, type Provider } from '@agent-hub/shared';
import type { CreateSubscriptionRequest, PatchSubscriptionRequest, SubscriptionUsageResponse, SubscriptionView, SubscriptionsResponse } from '@agent-hub/shared';
import type { Db } from '../db/db.js';
import type { UiGateway } from '../ui/uiGateway.js';
import { HttpError } from '../sessions/service.js';
import { TokenUnreadableError, codexAuthInfo, codexHint, decryptToken, encryptToken, tokenHint, tokenKey } from './crypto.js';
import { deleteLimits } from './limitsRepo.js';
import {
  defaultOf,
  getSubscription,
  isNameTaken,
  lastChoiceOf,
  limitActive,
  listSubscriptions,
  supportsCodexSubscriptions,
  supportsSubscriptions,
  toSubscriptionView,
  type SubscriptionMeta,
} from './repo.js';

export interface SubscriptionServiceOptions {
  db: Db;
  ui: UiGateway;
  log: Pick<FastifyBaseLogger, 'info' | 'warn'>;
  /** SUBSCRIPTION_TOKEN_KEY (base64 of 32 bytes); undefined — tokens cannot be stored or used. */
  key: string | undefined;
  connectorsHint: boolean;
  now?: () => Date;
}

/** The subscription a process is launched under; the token is passed to the agent and dropped. */
export interface SubscriptionCredFull {
  id: string;
  name: string;
  token: string;
  provider: Provider;
  /** The version of the token (subscriptions.token_updated_at, ms precision): a process remembers what it got (QA B2). */
  tokenUpdatedAt: Date;
}

/**
 * The token is still the version `tokenAt` a process got (QA B2). A version is token_updated_at as read into a JS Date
 * (ms; microseconds of Postgres and float parsing may move it by a millisecond): equal within 2 ms. Two replacements
 * of one token within 2 ms do not happen.
 */
function sameTokenVersion(tokenAt: Date) {
  return sql<boolean>`abs(extract(epoch FROM (token_updated_at - ${tokenAt}::timestamptz))) < 0.002`;
}

/** Name of the machine login in usage and notes. */
export const MACHINE_LOGIN = 'Вход машины';
const DAY_MS = 86_400_000;

export class SubscriptionService {
  private readonly key: Buffer | null;
  private readonly now: () => Date;

  constructor(private readonly o: SubscriptionServiceOptions) {
    this.key = o.key ? tokenKey(o.key) : null;
    this.now = o.now ?? (() => new Date());
  }

  get enabled(): boolean {
    return this.key !== null;
  }

  /** subscriptions.changed to every client of the user (no token inside). */
  changed(userId: string): void {
    this.o.ui.broadcast(userId, { type: 'subscriptions.changed' });
  }

  // ---------- registry ----------

  async list(userId: string): Promise<SubscriptionsResponse> {
    const subs = await listSubscriptions(this.o.db, userId);
    const now = this.now();
    const byProvider = {} as SubscriptionsResponse['byProvider'];
    for (const p of PROVIDERS) {
      const lastChoiceId = await lastChoiceOf(this.o.db, userId, p);
      byProvider[p] = { lastChoiceId, defaultId: defaultOf(subs, lastChoiceId, p)?.id ?? null };
    }
    return {
      enabled: this.enabled,
      subscriptions: subs.map(s => toSubscriptionView(s, now)),
      lastChoiceId: byProvider.claude.lastChoiceId,
      defaultId: byProvider.claude.defaultId,
      byProvider,
      connectorsHint: this.o.connectorsHint,
    };
  }

  private requireKey(): Buffer {
    if (!this.key) throw new HttpError(503, 'subscriptions_disabled', 'Хранение токенов не настроено: задайте SUBSCRIPTION_TOKEN_KEY');
    return this.key;
  }

  /** A subscription of the user (retired ones too), else 404 — limits (subscription-limits L6) use it. */
  async ownMeta(userId: string, id: string): Promise<SubscriptionMeta> {
    return this.own(userId, id);
  }

  private async own(userId: string, id: string): Promise<SubscriptionMeta> {
    const s = await getSubscription(this.o.db, userId, id);
    if (!s) throw new HttpError(404, 'not_found', 'Подписка не найдена');
    return s;
  }

  private nameTaken(): HttpError {
    return new HttpError(409, 'name_taken', 'Подписка с таким именем уже есть');
  }

  /** POST /api/subscriptions: at the end of the registry, auto switch off unless asked. */
  async create(userId: string, b: CreateSubscriptionRequest): Promise<SubscriptionView> {
    const key = this.requireKey();
    const id = randomUUID();
    try {
      const row = await this.o.db
        .insertInto('subscriptions')
        .values({
          id,
          user_id: userId,
          name: b.name,
          token_enc: encryptToken(key, id, b.token),
          token_hint: tokenHint(b.token),
          position: sql<number>`(SELECT COALESCE(max(position) + 1, 0) FROM subscriptions WHERE user_id = ${userId})`,
          auto_switch: b.autoSwitch ?? false,
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();
      this.o.log.info({ userId, subscriptionId: row.id }, 'subscription added');
    } catch (err) {
      if (isNameTaken(err)) throw this.nameTaken();
      throw err;
    }
    this.changed(userId);
    return toSubscriptionView(await this.own(userId, id), this.now());
  }

  /** 409 name_taken before a Codex sign-in starts: the name is unique among the active subscriptions of a provider. */
  async assertNameFree(userId: string, provider: Provider, name: string): Promise<void> {
    const taken = await this.o.db
      .selectFrom('subscriptions')
      .select('id')
      .where('user_id', '=', userId)
      .where('provider', '=', provider)
      .where('retired_at', 'is', null)
      .where(sql<boolean>`lower(name) = lower(${name})`)
      .executeTakeFirst();
    if (taken) throw this.nameTaken();
  }

  /** A Codex subscription from a finished sign-in (provider-parity D3): at the end of the registry, auto switch off. */
  async createCodex(userId: string, name: string, credential: string): Promise<SubscriptionView> {
    const key = this.requireKey();
    codexCredentialSchema.parse(credential);
    const id = randomUUID();
    try {
      await this.o.db
        .insertInto('subscriptions')
        .values({
          id,
          user_id: userId,
          name,
          provider: 'codex',
          token_enc: encryptToken(key, id, credential),
          token_hint: codexHint(credential),
          position: sql<number>`(SELECT COALESCE(max(position) + 1, 0) FROM subscriptions WHERE user_id = ${userId})`,
          auto_switch: false,
        })
        .execute();
      this.o.log.info({ userId, subscriptionId: id }, 'codex subscription added');
    } catch (err) {
      if (isNameTaken(err)) throw this.nameTaken();
      throw err;
    }
    this.changed(userId);
    return toSubscriptionView(await this.own(userId, id), this.now());
  }

  /**
   * Codex rotated its tokens while a process ran (provider-parity D4): the stored auth.json is replaced, the token
   * version stays (a running process is not «older» for it) and «токен отклонён» is not touched.
   */
  async refreshCodex(subscriptionId: string, credential: string): Promise<void> {
    const key = this.requireKey();
    const row = await this.o.db.selectFrom('subscriptions').select(['token_enc', 'retired_at']).where('id', '=', subscriptionId).where('provider', '=', 'codex').executeTakeFirst();
    if (!row) {
      this.o.log.warn({ subscriptionId }, 'codex credential update for an unknown subscription');
      return;
    }
    // compare-and-swap by the CLI's own last_refresh: a stale write-back (an old process, another machine, a re-login
    // in between) never replaces a newer sign-in; another ChatGPT account never replaces the stored one
    let stored = { accountId: null as string | null, refreshedAt: null as number | null };
    try {
      stored = codexAuthInfo(decryptToken(key, subscriptionId, row.token_enc));
    } catch {
      // unreadable with this key: the new credential heals it
    }
    const next = codexAuthInfo(credential);
    if (
      row.retired_at !== null ||
      (stored.accountId && next.accountId !== stored.accountId) ||
      (stored.refreshedAt !== null && (next.refreshedAt === null || next.refreshedAt <= stored.refreshedAt))
    ) {
      this.o.log.info({ subscriptionId }, 'codex credential update skipped: not newer than the stored one');
      return;
    }
    await this.o.db
      .updateTable('subscriptions')
      .set({ token_enc: encryptToken(key, subscriptionId, credential), token_hint: codexHint(credential) })
      .where('id', '=', subscriptionId)
      .where('token_enc', '=', row.token_enc)
      .execute();
  }

  /** PATCH /api/subscriptions/:id: rename, auto switch, retire or bring back (to the end of the active ones). */
  async patch(userId: string, id: string, b: PatchSubscriptionRequest): Promise<SubscriptionView> {
    const s = await this.own(userId, id);
    const set: Record<string, unknown> = {};
    if (b.name !== undefined) set.name = b.name;
    if (b.autoSwitch !== undefined) set.auto_switch = b.autoSwitch;
    if (b.retired === true && s.retired_at === null) set.retired_at = this.now();
    if (b.retired === false && s.retired_at !== null) {
      set.retired_at = null;
      set.position = sql<number>`(SELECT COALESCE(max(position) + 1, 0) FROM subscriptions WHERE user_id = ${userId} AND retired_at IS NULL)`;
    }
    if (Object.keys(set).length) {
      try {
        await this.o.db.updateTable('subscriptions').set(set).where('id', '=', s.id).execute();
      } catch (err) {
        if (isNameTaken(err)) throw this.nameTaken();
        throw err;
      }
      this.changed(userId);
    }
    // subscription-limits L4: retiring or bringing back starts the limits from «ещё не проверялась»
    if (set.retired_at !== undefined && (await deleteLimits(this.o.db, userId, s.id))) this.limitsChanged(userId);
    return toSubscriptionView(await this.own(userId, id), this.now());
  }

  /** subscription-limits: subscription_limits.changed to every client of the user (no data inside). */
  limitsChanged(userId: string): void {
    this.o.ui.broadcast(userId, { type: 'subscription_limits.changed' });
  }

  /** PUT /api/subscriptions/:id/token: the whole value replaced, «токен отклонён» cleared. */
  async replaceToken(userId: string, id: string, token: string): Promise<SubscriptionView> {
    const key = this.requireKey();
    const s = await this.own(userId, id);
    const codex = s.provider === 'codex';
    if (codex) codexCredentialSchema.parse(token);
    await this.o.db
      .updateTable('subscriptions')
      .set({ token_enc: encryptToken(key, s.id, token), token_hint: codex ? codexHint(token) : tokenHint(token), token_updated_at: this.now(), token_rejected_at: null })
      .where('id', '=', s.id)
      .execute();
    this.o.log.info({ userId, subscriptionId: s.id }, 'subscription token replaced');
    this.changed(userId);
    // subscription-limits L4: the new token may be another account — the old snapshot goes
    if (await deleteLimits(this.o.db, userId, s.id)) this.limitsChanged(userId);
    return toSubscriptionView(await this.own(userId, id), this.now());
  }

  /** PUT /api/subscriptions/order: every active id exactly once, else 422 bad_order. */
  async order(userId: string, ids: string[]): Promise<SubscriptionsResponse> {
    const active = (await listSubscriptions(this.o.db, userId)).filter(s => s.retired_at === null).map(s => s.id);
    const want = new Set(ids.map(i => i.toLowerCase()));
    if (want.size !== active.length || !active.every(a => want.has(a))) throw new HttpError(422, 'bad_order', 'Порядок должен перечислять все активные подписки');
    await this.o.db.transaction().execute(async tx => {
      for (const [i, id] of ids.entries()) await tx.updateTable('subscriptions').set({ position: i }).where('id', '=', id.toLowerCase()).where('user_id', '=', userId).execute();
    });
    this.changed(userId);
    return this.list(userId);
  }

  // ---------- choice and launch ----------

  /** The active subscriptions of the user, by position. */
  async active(userId: string, provider: Provider = 'claude'): Promise<SubscriptionMeta[]> {
    return (await listSubscriptions(this.o.db, userId)).filter(s => s.retired_at === null && s.provider === provider);
  }

  /** Every active subscription of the user, of all providers (the limits screen). */
  async activeAll(userId: string): Promise<SubscriptionMeta[]> {
    return (await listSubscriptions(this.o.db, userId)).filter(s => s.retired_at === null);
  }

  async defaultFor(userId: string, provider: Provider = 'claude'): Promise<SubscriptionMeta | null> {
    return defaultOf(await listSubscriptions(this.o.db, userId), await lastChoiceOf(this.o.db, userId, provider), provider);
  }

  /** An explicit choice (form, head of the tab, «Продолжить под другой подпиской»): the last choice. */
  async setLastChoice(userId: string, id: string): Promise<void> {
    const s = await getSubscription(this.o.db, userId, id);
    if (!s) return;
    const col = s.provider === 'codex' ? 'last_codex_subscription_id' : 'last_subscription_id';
    const r = await this.o.db
      .updateTable('users')
      .set({ [col]: id })
      .where('id', '=', userId)
      .where(col, 'is distinct from', id)
      .executeTakeFirst();
    if (Number(r.numUpdatedRows)) this.changed(userId);
  }

  /** An explicitly chosen subscription for a launch: own and active, else 422 subscription_unavailable. */
  async requireActive(userId: string, id: string, provider: Provider = 'claude'): Promise<SubscriptionMeta> {
    const s = await getSubscription(this.o.db, userId, id);
    if (!s || s.retired_at !== null || s.provider !== provider) throw new HttpError(422, 'subscription_unavailable', 'Подписка недоступна — выберите другую');
    return s;
  }

  /**
   * The subscription a process of `runner` is launched under (design P6): null — the machine login, as before the
   * change (an agent older than 1.4, no key, an empty registry, or `null` asked for explicitly). `id` absent — the
   * default subscription; given — that one, checked. The token is decrypted here and nowhere else.
   */
  async credFor(userId: string, runner: { protocol_version: string | null }, id?: string | null, provider: Provider = 'claude'): Promise<SubscriptionCredFull | null> {
    const supported = provider === 'codex' ? supportsCodexSubscriptions(runner.protocol_version) : supportsSubscriptions(runner.protocol_version);
    if (!supported || !this.key || id === null) return null;
    const s = id !== undefined ? await this.requireActive(userId, id, provider) : await this.defaultFor(userId, provider);
    if (!s) return null;
    return this.cred(s);
  }

  /**
   * The subscription of a one-shot generation (handoff.generate, QA B1): `id` given — that one (the form's choice),
   * `null` — the machine login; absent — the default one while it has no active limit and no rejected token, else the
   * first such active one by position, else the default one anyway (its failure then says why).
   */
  async credForGeneration(userId: string, runner: { protocol_version: string | null }, id?: string | null): Promise<SubscriptionCredFull | null> {
    if (id !== undefined) return this.credFor(userId, runner, id);
    if (!supportsSubscriptions(runner.protocol_version) || !this.key) return null;
    const now = this.now();
    const usable = (x: SubscriptionMeta) => !limitActive(x, now) && x.token_rejected_at === null;
    const def = await this.defaultFor(userId);
    if (!def) return null;
    const pick = usable(def) ? def : ((await this.active(userId)).find(usable) ?? def);
    return this.cred(pick);
  }

  /** The token of a subscription: 409 token_unreadable when it does not decrypt with the hub's key. */
  async cred(s: Pick<SubscriptionMeta, 'id' | 'name'>): Promise<SubscriptionCredFull> {
    if (!this.key) throw new HttpError(409, 'token_unreadable', `Токен подписки ${s.name} не расшифрован — замените токен`);
    const row = await this.o.db.selectFrom('subscriptions').select(['token_enc', 'token_updated_at', 'provider']).where('id', '=', s.id).executeTakeFirst();
    try {
      if (!row) throw new TokenUnreadableError();
      return { id: s.id, name: s.name, token: decryptToken(this.key, s.id, row.token_enc), provider: row.provider, tokenUpdatedAt: row.token_updated_at };
    } catch (err) {
      if (err instanceof TokenUnreadableError) {
        this.o.log.warn({ subscriptionId: s.id }, 'subscription token unreadable');
        throw new HttpError(409, 'token_unreadable', `Токен подписки ${s.name} не расшифрован — замените токен`);
      }
      throw err;
    }
  }

  // ---------- failures (P6, P7) ----------
  // Every mark is of the owner's row only (change multi-user: subscriptions per user).

  /** A limit of the subscription: its reset time (only when the SDK told) and kind. */
  async markLimit(id: string, userId: string, resetsAt: Date | null, kind: string | null): Promise<void> {
    if (!resetsAt) return;
    await this.o.db.updateTable('subscriptions').set({ limit_resets_at: resetsAt, limit_kind: kind }).where('id', '=', id).where('user_id', '=', userId).execute();
    this.changed(userId);
  }

  /**
   * «Токен отклонён» (QA B2): only when the rejected process got the current token — `tokenAt` is the token version
   * the process was launched with (null — unknown, a process launched before the version was kept: marked as before).
   * A rejection of an old token after a replacement leaves the new one alone. Returns whether the mark was set.
   */
  async markRejected(id: string, userId: string, tokenAt: Date | null = null): Promise<boolean> {
    let q = this.o.db.updateTable('subscriptions').set({ token_rejected_at: this.now() }).where('id', '=', id).where('user_id', '=', userId);
    if (tokenAt) q = q.where(sameTokenVersion(tokenAt));
    const r = await q.executeTakeFirst();
    if (!Number(r.numUpdatedRows)) return false;
    this.changed(userId);
    return true;
  }

  /** A successful turn of a process launched with the current token clears «токен отклонён» (QA B2). */
  async clearRejected(id: string, userId: string, tokenAt: Date | null): Promise<boolean> {
    if (!tokenAt) return false;
    const r = await this.o.db
      .updateTable('subscriptions')
      .set({ token_rejected_at: null })
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .where('token_rejected_at', 'is not', null)
      .where(sameTokenVersion(tokenAt))
      .executeTakeFirst();
    if (!Number(r.numUpdatedRows)) return false;
    this.changed(userId);
    return true;
  }

  /** Active subscriptions without a limit and without a rejected token, except `exceptId`, by position. */
  async alternatives(userId: string, exceptId: string | null, provider: Provider = 'claude'): Promise<SubscriptionMeta[]> {
    const now = this.now();
    return (await this.active(userId, provider)).filter(s => s.id !== exceptId && !limitActive(s, now) && s.token_rejected_at === null);
  }

  /** The next subscription for an auto switch (P7): after `fromId` in the registry order, wrapping, not in `tried`. */
  async nextForAutoSwitch(userId: string, fromId: string, tried: Set<string>, provider: Provider = 'claude'): Promise<SubscriptionMeta | null> {
    const active = await this.active(userId, provider);
    const now = this.now();
    const i = active.findIndex(s => s.id === fromId);
    const ring = i < 0 ? active : [...active.slice(i + 1), ...active.slice(0, i)];
    return ring.find(s => s.id !== fromId && !tried.has(s.id) && !limitActive(s, now) && s.token_rejected_at === null) ?? null;
  }

  async byId(id: string): Promise<SubscriptionMeta | undefined> {
    return this.o.db
      .selectFrom('subscriptions')
      .select(['id', 'user_id', 'name', 'token_hint', 'provider', 'position', 'auto_switch', 'retired_at', 'limit_resets_at', 'limit_kind', 'token_rejected_at', 'token_updated_at', 'created_at'])
      .where('id', '=', id)
      .executeTakeFirst();
  }

  // ---------- usage (P10) ----------

  /** GET /api/subscriptions/usage: turns and tokens per subscription and «Вход машины», [from, to). */
  async usage(userId: string, q: { from?: string | undefined; to?: string | undefined }): Promise<SubscriptionUsageResponse> {
    const to = q.to ? new Date(q.to) : this.now();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 7 * DAY_MS);
    if (!(from < to) || to.getTime() - from.getTime() > 366 * DAY_MS) throw new HttpError(422, 'bad_period', 'Период — не больше 366 дней, начало раньше конца');
    const rows = await this.o.db
      .selectFrom('session_turns as t')
      .leftJoin('subscriptions as s', 's.id', 't.subscription_id')
      .select([
        't.subscription_id',
        's.name',
        sql<string>`count(*)`.as('turns'),
        sql<string>`COALESCE(sum(t.input_tokens), 0)`.as('input'),
        sql<string>`COALESCE(sum(t.output_tokens), 0)`.as('output'),
        sql<string>`COALESCE(sum(t.cache_read_tokens), 0)`.as('cache_read'),
        sql<string>`COALESCE(sum(t.cache_creation_tokens), 0)`.as('cache_creation'),
        sql<string>`count(*) FILTER (WHERE t.failure = 'subscription_limit')`.as('limit_hits'),
      ])
      .where('t.user_id', '=', userId)
      .where('t.ended_at', '>=', from)
      .where('t.ended_at', '<', to)
      .groupBy(['t.subscription_id', 's.name', 's.position', 's.retired_at'])
      .orderBy(sql`t.subscription_id IS NULL`)
      .orderBy(sql`s.retired_at IS NOT NULL`)
      .orderBy('s.position')
      .execute();
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      rows: rows.map(r => ({
        subscriptionId: r.subscription_id,
        name: r.subscription_id ? (r.name ?? '') : MACHINE_LOGIN,
        turns: Number(r.turns),
        inputTokens: Number(r.input),
        outputTokens: Number(r.output),
        cacheReadTokens: Number(r.cache_read),
        cacheCreationTokens: Number(r.cache_creation),
        limitHits: Number(r.limit_hits),
      })),
    };
  }
}
