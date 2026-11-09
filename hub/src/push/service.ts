// Web Push of «the session waits for you» (change web-push-notifications): the front of the waiting is found on every upsert
// of a session, the text comes from permission_requests / the result of the turn, the delivery goes through PushSender.
// The rule «waits for me» is notifyReason of @agent-hub/shared, the same as the desktop notifications.
import { DEFAULT_LOCALE, isLocale, notifyReason, PUSH_MAX_FAILURES, PUSH_THROTTLE_MS, type Locale, type SessionView } from '@agent-hub/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/db.js';
import { tr } from '../i18n.js';
import type { SessionRow } from '../sessions/repo.js';
import type { AgentGateway } from '../runners/agentGateway.js';
import type { UiGateway } from '../ui/uiGateway.js';
import { composeBody, failureText, permissionText, titleOf, turnText, type TextOf, type TurnFailure } from './text.js';
import { activeForUser, deleteByEndpoint, findByHash, markFailure, markSuccess, type PushSubscriptionRow } from './repo.js';
import type { PushSendOptions, PushSender } from './sender.js';

type Reason = 'permission' | 'turn_ended';

const TTL_SECONDS = 3600;
const RESULT_KEEP_MS = 60_000;
const SWEEP_MS = 60_000;
const TEST_LIMIT = 5;
const TEST_WINDOW_MS = 60_000;
const CONCURRENCY = 5;
/** push-voice-fixes D5: the agent sends the status permission before the request itself; the push waits for the request. */
export const PERMISSION_REQUEST_WAIT_MS = 3000;

export interface PushObserver {
  observe(row: SessionRow, view: SessionView): void;
  rememberResult(sessionId: string, text: string | undefined): void;
  rememberFailure(sessionId: string, failure: TurnFailure): void;
  /** push-voice-fixes D4: true when a push skipped for a visible tab after the tab got hidden (lateMs ago) may go out on the next observe. */
  reopen(sessionId: string, userId: string, lateMs: number): boolean;
}

export interface PushServiceOptions {
  db: Db;
  ui: Pick<UiGateway, 'isActiveVisible'>;
  agents: Pick<AgentGateway, 'isOnline'>;
  log: FastifyBaseLogger;
  /** VAPID is complete (config.pushEnabled): without it the service does nothing. */
  enabled: boolean;
  sender?: PushSender;
  /** The language of the hub for a user without a profile language (en; the tests pin ru). */
  defaultLocale?: Locale;
  now?: () => number;
}

export type PushTestResult = 'ok' | 'not_configured' | 'rate_limited' | 'not_found' | 'gone' | 'failed';

export class PushService implements PushObserver {
  private readonly waiting = new Map<string, Reason>();
  private readonly sentAt = new Map<string, number>();
  private readonly results = new Map<string, { text: string; at: number }>();
  private readonly failures = new Map<string, { failure: TurnFailure; at: number }>();
  private readonly tests = new Map<string, number[]>();
  /** D4: the push of a front skipped because the session was on a visible tab. */
  private readonly skippedVisible = new Map<string, { userId: string; reason: Reason; at: number }>();
  /** D5: permission fronts waiting for their permission_requests row. */
  private readonly requestWait = new Map<string, NodeJS.Timeout>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly o: PushServiceOptions) {}

  get enabled(): boolean {
    return this.o.enabled && this.o.sender !== undefined;
  }

  private now(): number {
    return this.o.now ? this.o.now() : Date.now();
  }

  /** The sessions that wait at the start are the baseline: a restart of the hub sends nothing for them. */
  async init(): Promise<void> {
    if (!this.enabled) return;
    const rows = await this.o.db
      .selectFrom('sessions')
      .select(['id', 'status', 'unread'])
      .where(eb => eb.or([eb('status', '=', 'permission'), eb.and([eb('status', '=', 'waiting'), eb('unread', '=', true)])]))
      .execute();
    for (const r of rows) this.waiting.set(r.id, r.status === 'permission' ? 'permission' : 'turn_ended');
    this.timer = setInterval(() => this.sweep(), SWEEP_MS);
    this.timer.unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const t of this.requestWait.values()) clearTimeout(t);
    this.requestWait.clear();
  }

  reopen(sessionId: string, userId: string, lateMs: number): boolean {
    if (!this.enabled) return false;
    const hiddenAt = this.now() - lateMs;
    const skipped = this.skippedVisible.get(sessionId);
    if (!skipped || skipped.userId !== userId || skipped.at <= hiddenAt) return false;
    this.skippedVisible.delete(sessionId);
    if (this.waiting.get(sessionId) !== skipped.reason) return false;
    // the next observe of this session is a front again
    this.waiting.delete(sessionId);
    return true;
  }

  rememberResult(sessionId: string, text: string | undefined): void {
    if (!this.enabled) return;
    // a new turn: the reason of an earlier refused one is not its reason
    this.failures.delete(sessionId);
    if (!text) return;
    this.results.set(sessionId, { text, at: this.now() });
  }

  /** agent-hub-mvp 5.2a: the turn was refused by its subscription; the push of its end says why instead of the answer. */
  rememberFailure(sessionId: string, failure: TurnFailure): void {
    if (!this.enabled) return;
    this.failures.set(sessionId, { failure, at: this.now() });
  }

  /** Called on every upsert of the own row of a session; only Map operations until the front is found. */
  observe(row: SessionRow, view: SessionView): void {
    if (!this.enabled) return;
    // the machine being online is checked in notify, after the front: an offline machine does not reset the front
    const reason: Reason | null = notifyReason(view, true);
    const prev = this.waiting.get(view.id);
    if (reason !== 'permission') this.stopWaiting(view.id);
    if (!reason) {
      this.waiting.delete(view.id);
      this.skippedVisible.delete(view.id);
      return;
    }
    this.waiting.set(view.id, reason);
    // D5: the upsert after the permission request came repeats the front that waited for it
    const front = prev === undefined || (prev === 'turn_ended' && reason === 'permission') || (reason === 'permission' && this.stopWaiting(view.id));
    if (!front) return;
    this.notify(row, view, reason).catch(err => this.o.log.warn({ err: (err as Error).message, sessionId: view.id }, 'push: notify failed'));
  }

  private stopWaiting(sessionId: string): boolean {
    const t = this.requestWait.get(sessionId);
    if (!t) return false;
    clearTimeout(t);
    this.requestWait.delete(sessionId);
    return true;
  }

  private async notify(row: SessionRow, view: SessionView, reason: Reason, force = false): Promise<void> {
    if (!view.isHubManaged || view.isCron) return;
    if (view.spawnedBy && reason !== 'permission') return;
    if (!this.o.agents.isOnline(view.runnerId)) return;
    if (this.o.ui.isActiveVisible(row.user_id, view.id)) {
      this.skippedVisible.set(view.id, { userId: row.user_id, reason, at: this.now() });
      return;
    }
    this.skippedVisible.delete(view.id);
    const subs = await activeForUser(this.o.db, row.user_id);
    if (!subs.length) return;
    const now = this.now();
    const key = `${view.id}:${reason}`;
    const last = this.sentAt.get(key);
    if (last !== undefined && now - last < PUSH_THROTTLE_MS) return;
    this.sentAt.set(key, now);
    const profile = await this.profileLocale(row.user_id);
    const runner = await this.o.db.selectFrom('runners').select('name').where('id', '=', view.runnerId).executeTakeFirst();
    const request =
      reason === 'permission'
        ? await this.o.db
            .selectFrom('permission_requests')
            .select(['tool_name', 'input'])
            .where('session_id', '=', view.id)
            .where('resolved_at', 'is', null)
            .orderBy('created_at', 'desc')
            .limit(1)
            .executeTakeFirst()
        : undefined;
    if (reason === 'permission' && !request && !force) {
      // D5: no request yet — it comes right after the status; without it in 3 s the push goes with the fixed phrase
      if (last === undefined) this.sentAt.delete(key);
      else this.sentAt.set(key, last);
      this.waitForRequest(row, view);
      return;
    }
    const kept = this.results.get(view.id);
    this.results.delete(view.id);
    const resultText = kept && now - kept.at <= RESULT_KEEP_MS ? kept.text : undefined;
    const refused = reason === 'turn_ended' ? this.failures.get(view.id) : undefined;
    if (reason === 'turn_ended') this.failures.delete(view.id);
    const failure = refused && now - refused.at <= RESULT_KEEP_MS ? refused.failure : undefined;
    const opts: PushSendOptions = { ttl: TTL_SECONDS, urgency: reason === 'permission' ? 'high' : 'normal', topic: view.id.replace(/-/g, '') };
    // the text is built once per language: devices of one user may show different languages when the profile has none
    const byLocale = new Map<Locale, PushSubscriptionRow[]>();
    for (const sub of subs) {
      const locale = this.localeFor(profile, sub);
      byLocale.set(locale, [...(byLocale.get(locale) ?? []), sub]);
    }
    for (const [locale, group] of byLocale) {
      const t: TextOf = (k, p) => tr(locale).text(k, p);
      const text = reason === 'permission' ? permissionText(request, t) : failure ? failureText(failure, t) : turnText(resultText, t);
      const payload = {
        v: 1,
        kind: 'session',
        sessionId: view.id,
        title: titleOf(view.title, t),
        body: composeBody(runner?.name ?? '', text, reason === 'permission' || failure ? 'head' : 'tail'),
        tag: view.id,
        lang: locale,
      };
      await this.deliverAll(group, payload, opts);
    }
  }

  private waitForRequest(row: SessionRow, view: SessionView): void {
    this.stopWaiting(view.id);
    const timer = setTimeout(() => {
      this.requestWait.delete(view.id);
      if (this.waiting.get(view.id) !== 'permission') return;
      this.notify(row, view, 'permission', true).catch(err => this.o.log.warn({ err: (err as Error).message, sessionId: view.id }, 'push: notify failed'));
    }, PERMISSION_REQUEST_WAIT_MS);
    timer.unref();
    this.requestWait.set(view.id, timer);
  }

  /** The test push of one device of the user: no filters, 5 per minute. */
  async sendTest(userId: string, endpointHash: string): Promise<PushTestResult> {
    if (!this.enabled) return 'not_configured';
    const now = this.now();
    const recent = (this.tests.get(userId) ?? []).filter(at => now - at < TEST_WINDOW_MS);
    if (recent.length >= TEST_LIMIT) {
      this.tests.set(userId, recent);
      return 'rate_limited';
    }
    this.tests.set(userId, [...recent, now]);
    const sub = await findByHash(this.o.db, userId, endpointHash);
    if (!sub) return 'not_found';
    const locale = this.localeFor(await this.profileLocale(userId), sub);
    const t: TextOf = (k, p) => tr(locale).text(k, p);
    const payload = { v: 1, kind: 'test', title: t('hub.push.testTitle'), body: t('hub.push.testBody'), tag: 'agent-hub-test', lang: locale };
    const res = await this.deliver(sub, payload, { ttl: TTL_SECONDS, urgency: 'normal' });
    if (res.ok) return 'ok';
    return res.status === 404 || res.status === 410 ? 'gone' : 'failed';
  }

  private async profileLocale(userId: string): Promise<Locale | null> {
    const pref = await this.o.db.selectFrom('user_preferences').select('locale').where('user_id', '=', userId).executeTakeFirst();
    return isLocale(pref?.locale) ? pref.locale : null;
  }

  /** The language of the profile, then the one of the device when it subscribed, then the default of the hub. */
  private localeFor(profile: Locale | null, sub: PushSubscriptionRow): Locale {
    if (profile) return profile;
    return isLocale(sub.locale) ? sub.locale : (this.o.defaultLocale ?? DEFAULT_LOCALE);
  }

  private async deliverAll(subs: PushSubscriptionRow[], payload: unknown, opts: PushSendOptions): Promise<void> {
    const queue = [...subs];
    const worker = async (): Promise<void> => {
      for (let sub = queue.shift(); sub; sub = queue.shift()) {
        const current = sub;
        await this.deliver(current, payload, opts).catch(err => this.o.log.warn({ err: (err as Error).message, subscriptionId: current.id }, 'push: delivery failed'));
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  }

  /** Sends and applies the result to the subscription: success, gone (404/410) and 10 failures in a row (D6). */
  private async deliver(sub: PushSubscriptionRow, payload: unknown, opts: PushSendOptions): Promise<{ ok: true } | { ok: false; status: number | null }> {
    const res = await this.o.sender!.send({ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }, payload, opts);
    const at = new Date(this.now());
    if (res.ok) {
      await markSuccess(this.o.db, sub.id, at);
      return res;
    }
    if (res.blocked) {
      await deleteByEndpoint(this.o.db, sub.endpoint);
      this.o.log.warn({ subscriptionId: sub.id }, 'push: subscription dropped, the address is not public');
      return res;
    }
    if (res.status === null) {
      // nothing came from the push service (our network, DNS, keys, timeout): not the fault of the device, nothing is counted
      this.o.log.warn({ subscriptionId: sub.id }, 'push: no answer from the push service');
      return res;
    }
    if (res.status === 404 || res.status === 410) {
      await deleteByEndpoint(this.o.db, sub.endpoint);
      this.o.log.info({ subscriptionId: sub.id, status: res.status }, 'push: subscription is gone');
      return res;
    }
    const failures = await markFailure(this.o.db, sub.id, res.status, at);
    this.o.log.warn({ subscriptionId: sub.id, status: res.status, failures }, 'push: delivery rejected');
    if (failures >= PUSH_MAX_FAILURES) {
      await deleteByEndpoint(this.o.db, sub.endpoint);
      this.o.log.info({ subscriptionId: sub.id }, 'push: subscription dropped after repeated failures');
    }
    return res;
  }

  private sweep(): void {
    const now = this.now();
    for (const [k, at] of this.sentAt) if (now - at >= PUSH_THROTTLE_MS) this.sentAt.delete(k);
    for (const [k, r] of this.results) if (now - r.at > RESULT_KEEP_MS) this.results.delete(k);
    for (const [k, f] of this.failures) if (now - f.at > RESULT_KEEP_MS) this.failures.delete(k);
    for (const [k, v] of this.skippedVisible) if (now - v.at > RESULT_KEEP_MS) this.skippedVisible.delete(k);
    for (const [k, list] of this.tests) {
      const recent = list.filter(at => now - at < TEST_WINDOW_MS);
      if (recent.length) this.tests.set(k, recent);
      else this.tests.delete(k);
    }
  }
}
