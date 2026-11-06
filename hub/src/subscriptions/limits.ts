// Limits of subscriptions in the hub (subscription-limits design L2, L5, L6; tasks 5.2–5.6): the scheduler of probe
// turns (tick 30 s), the choice of a runner of the subscription's owner, the result of a probe, limits.event of
// sessions, the views of GET /api/subscriptions/limits and the manual refresh. The token is decrypted only to build
// the limits.probe command and never logged.
// Requirements: Источники снимка и частота обновления; Пробный ход; Выбор машины для пробного хода и защита токена;
// Ручное обновление; Изоляция лимитов по пользователям; Версионированный протокол лимитов.
import type { FastifyBaseLogger } from 'fastify';
import {
  CODEX_SUBSCRIPTIONS_PROTOCOL,
  LIMITS_PROTOCOL,
  limitsProbeResultSchema,
  protocolAtLeast,
  type AgentMessage,
  type LimitsProbeResult,
  type PayloadOf,
  type SubscriptionLimitsResponse,
  type SubscriptionLimitsView,
} from '@agent-hub/shared';
import type { Db } from '../db/db.js';
import type { HubBus } from '../bus.js';
import { CommandError, type AgentGateway } from '../runners/agentGateway.js';
import type { UiGateway } from '../ui/uiGateway.js';
import { HttpError } from '../sessions/service.js';
import { findSessionByClaudeId } from '../sessions/repo.js';
import { KeyedSerial } from '../util/serial.js';
import { PUBLIC_COLUMNS, limitActive, tokenNewer, type SubscriptionMeta } from './repo.js';
import type { SubscriptionCredFull, SubscriptionService } from './service.js';
import { applySnapshot, freshAt, getLimits, listLimits, markQuiet, recordProbe, rowOfToken, storedWindows, toLimitsView, type LimitsRow } from './limitsRepo.js';

export interface LimitsConfig {
  /** LIMITS_PROBE_ENABLED: false — no probe turns at all (only session events). */
  enabled: boolean;
  /** LIMITS_PROBE_IDLE_SEC: data older than this gets a probe; 0 — only «Обновить». */
  idleSec: number;
  timeoutSec: number;
  model: string;
  /** LIMITS_REFRESH_MIN_SEC: «Обновить» at most this often per subscription. */
  refreshMinSec: number;
  /** LIMITS_PROBE_LAST_HOSTS: hostnames (or runner ids) tried last (e.g. a small VM where a probe process risks an OOM). */
  lastHosts: string[];
}

export interface LimitsServiceOptions {
  db: Db;
  bus: HubBus;
  agents: AgentGateway;
  ui: UiGateway;
  subscriptions: SubscriptionService;
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
  config: LimitsConfig;
  now?: () => Date;
  /** The scheduler tick (default 30 s; 0 — no timer, tests call tick()). */
  tickMs?: number;
  /** The spread of scheduled probes (default ≤20 s; tests 0). */
  jitterMs?: number;
}

/** Backoff after failed probes (L2): 30 min × 2^(n−1), at most 2 h. */
export const BACKOFF_BASE_MS = 30 * 60_000;
export const BACKOFF_MAX_MS = 2 * 60 * 60_000;
export function backoffMs(failures: number): number {
  return failures <= 0 ? 0 : Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
}

/** Exhausted: an active limit_resets_at, or a window `rejected` whose reset is in the future. */
export function exhausted(sub: Pick<SubscriptionMeta, 'limit_resets_at'>, row: LimitsRow | undefined, now: Date): boolean {
  if (limitActive(sub, now)) return true;
  return storedWindows(row).some(w => w.status === 'rejected' && !!w.resetsAt && Date.parse(w.resetsAt) > now.getTime());
}

/** A reset (limit_resets_at, or a rejected window's) that came after `since` and is already past: the subscription is free again. */
function resetSince(sub: Pick<SubscriptionMeta, 'limit_resets_at'>, row: LimitsRow | undefined, since: Date, now: Date): boolean {
  const times = [
    sub.limit_resets_at?.getTime() ?? NaN,
    ...storedWindows(row)
      .filter(w => w.status === 'rejected' && w.resetsAt)
      .map(w => Date.parse(w.resetsAt!)),
  ];
  return times.some(t => Number.isFinite(t) && t > since.getTime() && t <= now.getTime());
}

/**
 * Whether a periodic probe of the subscription is due (L2): active, with a token not rejected, not exhausted, the data
 * older than the period, not in the backoff of failed probes, and no probe within the period whatever its outcome
 * (review B1: an outcome that leaves no fresh data, such as an event without windows or a limit without a reset time,
 * must not loop a probe every tick); only a reset after the last probe lifts that. The period 0: never (only «Обновить»).
 */
export function probeDue(
  sub: Pick<SubscriptionMeta, 'retired_at' | 'token_rejected_at' | 'limit_resets_at'> & Partial<Pick<SubscriptionMeta, 'token_updated_at'>>,
  rowAny: LimitsRow | undefined,
  now: Date,
  idleSec: number,
): boolean {
  if (idleSec <= 0 || sub.retired_at || sub.token_rejected_at) return false;
  const row = rowOfToken(sub, rowAny);
  if (exhausted(sub, row, now)) return false;
  const fresh = freshAt(row);
  if (fresh && now.getTime() - fresh.getTime() < idleSec * 1000) return false;
  if (row && row.probe_failures > 0 && row.last_probe_at && now.getTime() - row.last_probe_at.getTime() < backoffMs(row.probe_failures)) return false;
  if (row?.last_probe_at && now.getTime() - row.last_probe_at.getTime() < idleSec * 1000 && !resetSince(sub, row, row.last_probe_at, now)) return false;
  return true;
}

interface Candidate {
  id: string;
  name: string;
  protocol_version: string | null;
}

export class LimitsService {
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | null = null;
  /** One probe at a time per runner (L2: the hub queues them). */
  private readonly perRunner = new KeyedSerial();
  /** Subscriptions with a probe scheduled or running. */
  private readonly inFlight = new Set<string>();
  /** The last «Обновить» per subscription (in memory, L6). */
  private readonly refreshedAt = new Map<string, number>();
  private readonly running = new Set<Promise<void>>();
  private readonly pendingTimers = new Map<NodeJS.Timeout, () => void>();
  private stopped = false;

  constructor(private readonly o: LimitsServiceOptions) {
    this.now = o.now ?? (() => new Date());
    o.bus.on('agent.message', (runnerId, m) => {
      if (m.type === 'limits.event') void this.onEvent(runnerId, m.payload).catch((err: unknown) => o.log.warn({ err, runnerId }, 'limits event failed'));
    });
    // a machine came back: subscriptions waiting for a runner are re-checked at once (with jitter)
    o.bus.on('agent.hello', () => {
      if (this.timer) void this.tick().catch((err: unknown) => o.log.warn({ err }, 'limits tick failed'));
    });
  }

  start(): void {
    const every = this.o.tickMs ?? 30_000;
    if (every <= 0) return;
    this.timer = setInterval(() => void this.tick().catch((err: unknown) => this.o.log.warn({ err }, 'limits tick failed')), every);
    this.timer.unref();
  }

  /** Stops the timer and the probes not yet sent; probes in flight end with their commands (flush() waits for them). */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const [t, cancel] of this.pendingTimers) {
      clearTimeout(t);
      cancel();
    }
    this.pendingTimers.clear();
  }

  /** Tests: wait for the probes scheduled so far. */
  async flush(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running]);
  }

  private changed(userId: string): void {
    this.o.ui.broadcast(userId, { type: 'subscription_limits.changed' });
  }

  private get probesOn(): boolean {
    return this.o.config.enabled && this.o.subscriptions.enabled;
  }

  // ---------- views ----------

  private refreshableAt(id: string): Date | null {
    const last = this.refreshedAt.get(id);
    return last === undefined ? null : new Date(last + this.o.config.refreshMinSec * 1000);
  }

  private view(sub: SubscriptionMeta, row: LimitsRow | undefined): SubscriptionLimitsView {
    return toLimitsView(sub, row, this.now(), { idleSec: this.o.config.idleSec, refreshableAt: this.refreshableAt(sub.id) });
  }

  /** GET /api/subscriptions/limits: the user's active subscriptions in registry order; [] without stored tokens. */
  async list(userId: string): Promise<SubscriptionLimitsResponse> {
    const serverTime = this.now().toISOString();
    if (!this.o.subscriptions.enabled) return { limits: [], serverTime };
    const subs = await this.o.subscriptions.activeAll(userId);
    const rows = new Map((await listLimits(this.o.db, userId)).map(r => [r.subscription_id, r]));
    return { limits: subs.map(s => this.view(s, rows.get(s.id))), serverTime };
  }

  // ---------- runners ----------

  /**
   * Runners of the owner that may run a probe of `sub`, best first (L2): a live session under it, the last one used
   * under it, then by name with LIMITS_PROBE_LAST_HOSTS last. `online` — every online machine of the user (any version).
   */
  private async candidates(sub: Pick<SubscriptionMeta, 'id' | 'user_id' | 'provider'>): Promise<{ online: Candidate[]; capable: Candidate[] }> {
    const rows = await this.o.db
      .selectFrom('runners')
      .select(['id', 'name', 'hostname', 'protocol_version', 'providers'])
      .where('user_id', '=', sub.user_id)
      .where('kind', '=', 'machine')
      .where('state', '=', 'active')
      .execute();
    const online = rows.filter(r => this.o.agents.isOnline(r.id));
    // provider-parity D5: a Codex subscription is probed on a machine with the Codex CLI and an agent of 1.11+
    const capable = online.filter(r =>
      sub.provider === 'codex' ? protocolAtLeast(r.protocol_version, CODEX_SUBSCRIPTIONS_PROTOCOL) && !!r.providers?.some(p => p.id === 'codex') : protocolAtLeast(r.protocol_version, LIMITS_PROTOCOL),
    );
    if (capable.length < 2) return { online, capable };
    const used = await this.o.db
      .selectFrom('sessions')
      .select(['runner_id', 'process_alive', 'last_turn_end_at', 'last_input_at'])
      .where('user_id', '=', sub.user_id)
      .where('subscription_id', '=', sub.id)
      .execute();
    const live = new Set(used.filter(s => s.process_alive).map(s => s.runner_id));
    const lastUse = new Map<string, number>();
    for (const s of used) {
      const t = Math.max(s.last_turn_end_at?.getTime() ?? 0, s.last_input_at?.getTime() ?? 0);
      lastUse.set(s.runner_id, Math.max(lastUse.get(s.runner_id) ?? 0, t));
    }
    const last = new Set(this.o.config.lastHosts.map(h => h.toLowerCase()));
    const isLast = (r: (typeof rows)[number]) => last.has(r.id.toLowerCase()) || (!!r.hostname && last.has(r.hostname.toLowerCase()));
    capable.sort(
      (a, b) => Number(live.has(b.id)) - Number(live.has(a.id)) || (lastUse.get(b.id) ?? 0) - (lastUse.get(a.id) ?? 0) || Number(isLast(a)) - Number(isLast(b)) || a.name.localeCompare(b.name),
    );
    return { online, capable };
  }

  // ---------- scheduling ----------

  /** One scheduler pass (L2): every due subscription of every user, spread by jitter; one probe per runner at a time. */
  async tick(): Promise<void> {
    if (this.stopped || !this.probesOn || this.o.config.idleSec <= 0) return;
    const subs = await this.o.db.selectFrom('subscriptions').select(PUBLIC_COLUMNS).where('retired_at', 'is', null).where('token_rejected_at', 'is', null).execute();
    if (!subs.length) return;
    const rows = new Map(
      (
        await this.o.db
          .selectFrom('subscription_limits')
          .selectAll()
          .where(
            'subscription_id',
            'in',
            subs.map(s => s.id),
          )
          .execute()
      ).map(r => [r.subscription_id, r]),
    );
    const now = this.now();
    for (const s of subs) {
      if (this.inFlight.has(s.id) || !probeDue(s, rows.get(s.id), now, this.o.config.idleSec)) continue;
      this.schedule(s, false);
    }
  }

  private schedule(sub: SubscriptionMeta, manual: boolean): void {
    this.inFlight.add(sub.id);
    const jitter = manual ? 0 : Math.floor(Math.random() * (this.o.jitterMs ?? 20_000));
    let release!: () => void;
    const done = new Promise<void>(r => (release = r));
    this.running.add(done);
    const go = () => {
      void this.runProbe(sub, manual)
        .catch((err: unknown) => this.o.log.error({ err, subscriptionId: sub.id }, 'limits probe crashed'))
        .finally(() => {
          this.inFlight.delete(sub.id);
          this.running.delete(done);
          release();
        });
    };
    if (jitter <= 0) return go();
    const cancel = () => {
      this.inFlight.delete(sub.id);
      this.running.delete(done);
      release();
    };
    const t = setTimeout(() => {
      this.pendingTimers.delete(t);
      if (this.stopped) return cancel();
      go();
    }, jitter);
    t.unref();
    this.pendingTimers.set(t, cancel);
  }

  /** A probe of `sub`: a runner of its owner, the decrypted token, one retry on another runner after a link failure. */
  private async runProbe(sub: SubscriptionMeta, manual: boolean): Promise<void> {
    const { db } = this.o;
    const { online, capable } = await this.candidates(sub);
    if (!capable.length) {
      const outcome = online.length ? 'agent_outdated' : 'no_runner';
      if (await recordProbe(db, sub.user_id, sub.id, { at: null, outcome })) this.changed(sub.user_id);
      return;
    }
    let cred: SubscriptionCredFull;
    try {
      cred = await this.o.subscriptions.cred(sub);
    } catch (err) {
      await recordProbe(db, sub.user_id, sub.id, { at: this.now(), outcome: 'failed', error: err instanceof HttpError ? err.code : 'token_unreadable', failed: true });
      this.changed(sub.user_id);
      return;
    }
    let lastError = 'probe_failed';
    for (const r of capable.slice(0, 2)) {
      const conn = this.o.agents.get(r.id);
      if (!conn) continue;
      const at = this.now();
      let res: unknown;
      try {
        res = await this.perRunner.run(r.id, () =>
          conn.request(
            'limits.probe',
            {
              subscription: { id: cred.id, token: cred.token, ...(cred.provider === 'codex' ? { provider: 'codex' as const } : {}) },
              model: cred.provider === 'codex' ? 'codex' : this.o.config.model,
            },
            this.o.config.timeoutSec * 1000,
          ),
        );
      } catch (err) {
        const code = err instanceof CommandError ? err.code : 'error';
        lastError = code === 'timeout' ? 'probe_timeout' : code;
        this.o.log.warn({ subscriptionId: sub.id, runnerId: r.id, code, manual }, 'limits probe failed');
        if (code === 'timeout' || code === 'disconnected' || code === 'probe_timeout') continue; // one retry on the next runner
        break;
      }
      const parsed = limitsProbeResultSchema.safeParse(res);
      if (!parsed.success) {
        lastError = 'bad_result';
        break;
      }
      await this.onResult(sub, cred, parsed.data, at, r.id);
      return;
    }
    // review A1: a failure of a probe whose token was replaced meanwhile is not the new token's failure
    if (!(await this.sameToken(sub, cred))) {
      this.o.log.info({ subscriptionId: sub.id }, 'limits probe failure of a replaced token dropped');
      return;
    }
    await recordProbe(db, sub.user_id, sub.id, { at: this.now(), outcome: 'failed', error: lastError, failed: true });
    this.changed(sub.user_id);
  }

  /** The token of the probe is still the subscription's (a replacement during the probe drops the result, QA B2). */
  private async sameToken(sub: SubscriptionMeta, cred: SubscriptionCredFull): Promise<boolean> {
    const cur = await this.o.subscriptions.byId(sub.id);
    return !!cur && cur.user_id === sub.user_id && cur.retired_at === null && !tokenNewer(cur.token_updated_at, cred.tokenUpdatedAt);
  }

  /**
   * L2 table: ok → snapshot; no_event → quiet; limit → snapshot + markLimit; auth_rejected → markRejected; else failed.
   * An `ok` without windows is a quiet check too (review B1: else nothing fresh is kept and the next tick probes again).
   * A result of a token replaced during the probe is dropped whatever the outcome (QA B2, review A1).
   */
  private async onResult(sub: SubscriptionMeta, cred: SubscriptionCredFull, r: LimitsProbeResult, at: Date, runnerId: string): Promise<void> {
    const { db } = this.o;
    const userId = sub.user_id;
    this.o.log.info({ subscriptionId: sub.id, runnerId, outcome: r.outcome, windows: r.snapshot?.windows.length ?? 0, durationMs: r.durationMs }, 'limits probe done');
    if (!(await this.sameToken(sub, cred))) {
      this.o.log.info({ subscriptionId: sub.id }, 'limits probe result of a replaced token dropped');
      return;
    }
    if (r.outcome === 'auth_rejected') {
      // only the current token version is marked (QA B2: the SQL checks the version again); the snapshot is not touched
      await this.o.subscriptions.markRejected(sub.id, userId, cred.tokenUpdatedAt);
      await recordProbe(db, userId, sub.id, { at, outcome: 'auth_rejected', error: r.message });
      this.changed(userId);
      return;
    }
    if (r.snapshot && r.outcome !== 'account_unavailable') await applySnapshot(db, userId, sub.id, r.snapshot, at, 'probe');
    if (r.outcome === 'no_event' || (r.outcome === 'ok' && !r.snapshot?.windows.length)) await markQuiet(db, userId, sub.id, at);
    if (r.outcome === 'limit') await this.o.subscriptions.markLimit(sub.id, userId, r.resetsAt ? new Date(r.resetsAt) : null, r.limitType);
    const failed = r.outcome === 'account_unavailable';
    await recordProbe(db, userId, sub.id, { at, outcome: r.outcome, error: failed ? (r.message ?? 'account_unavailable') : null, failed });
    this.changed(userId);
  }

  // ---------- session events ----------

  /**
   * limits.event of a session (L1, L5): the subscription of the session's process; none (the machine login) — dropped,
   * as is an event of a process launched with a replaced token. The time is the agent's, moved onto the hub's clock.
   */
  private async onEvent(runnerId: string, p: PayloadOf<AgentMessage, 'limits.event'>): Promise<void> {
    const s = await findSessionByClaudeId(this.o.db, runnerId, p.sessionId);
    if (!s?.subscription_id) return;
    const sub = await this.o.subscriptions.byId(s.subscription_id);
    if (!sub || sub.user_id !== s.user_id || sub.retired_at) return;
    if (s.subscription_token_at && tokenNewer(sub.token_updated_at, s.subscription_token_at)) return;
    const offset = this.o.agents.get(runnerId)?.clockOffsetMs ?? 0;
    const at = new Date(Math.min(p.observedAt + offset, this.now().getTime()));
    const changed = p.snapshot && !p.quiet ? await applySnapshot(this.o.db, sub.user_id, sub.id, p.snapshot, at, 'session') : await markQuiet(this.o.db, sub.user_id, sub.id, at);
    if (changed) this.changed(sub.user_id);
  }

  // ---------- manual refresh ----------

  /**
   * POST /api/subscriptions/:id/limits/refresh (L6): checks, the 30 s limit, then the probe is queued (also for an
   * exhausted subscription: the service answers 429 without spending quota and sends the windows).
   */
  async refresh(userId: string, id: string): Promise<SubscriptionLimitsView> {
    const sub = await this.o.subscriptions.ownMeta(userId, id);
    if (!this.o.subscriptions.enabled) throw new HttpError(503, 'subscriptions_disabled', { key: 'hub.subscriptions.disabled' });
    if (sub.retired_at) throw new HttpError(409, 'subscription_retired', { key: 'hub.limits.retired' });
    if (sub.token_rejected_at) throw new HttpError(409, 'token_rejected', { key: 'hub.limits.tokenRejected' });
    if (!this.o.config.enabled) throw new HttpError(409, 'probes_disabled', { key: 'hub.limits.probesDisabled' });
    const nowMs = this.now().getTime();
    const last = this.refreshedAt.get(sub.id);
    const minMs = this.o.config.refreshMinSec * 1000;
    if (last !== undefined && nowMs - last < minMs) {
      const retryAfterSec = Math.max(1, Math.ceil((last + minMs - nowMs) / 1000));
      // `retryAfter` (seconds) in the body; the route also sets the Retry-After header from it
      throw new HttpError(429, 'refresh_too_soon', { key: 'hub.limits.refreshTooSoon', params: { sec: retryAfterSec } }, { retryAfter: String(retryAfterSec) });
    }
    const { online, capable } = await this.candidates(sub);
    if (!online.length) throw new HttpError(409, 'runner_offline', { key: 'hub.limits.noOnlineMachine' });
    if (!capable.length) throw new HttpError(409, 'agent_outdated', { key: 'hub.limits.agentOutdated' });
    this.refreshedAt.set(sub.id, nowMs);
    if (!this.inFlight.has(sub.id)) this.schedule(sub, true);
    return this.view(sub, await getLimits(this.o.db, userId, sub.id));
  }
}
