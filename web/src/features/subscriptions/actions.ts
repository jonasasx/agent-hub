/**
 * Side effects of the subscriptions UI (change claude-subscriptions, design P8): the registry, the switch of a session,
 * the usage. The store keeps only GET /api/subscriptions (`tokenHint`, never a token); a token lives in the caller's
 * input until the request leaves.
 * Requirements: Реестр подписок; Хранение токена подписки; Последний выбор подписки; Подписка в шапке вкладки и
 * переключение; Исчерпан лимит подписки.
 */
import { ApiError, api } from '../../api/client';
import type { PatchSubscriptionRequest, SubscriptionUsageResponse } from '../../api/types';
import { useStore } from '../../store';
import { t } from '../../i18n';

const get = () => useStore.getState();

let loadGen = 0;

/**
 * GET /api/subscriptions into the store; on `subscriptions.changed` and after a reconnect. A hub without the API (404)
 * leaves `subs` null: no subscription UI at all. Other failures keep what was loaded.
 */
export async function loadSubscriptions(): Promise<void> {
  const gen = ++loadGen;
  try {
    const subs = await api.subscriptions();
    if (gen === loadGen) useStore.setState({ subs, subsMissing: false, subsError: false });
  } catch (err) {
    if (gen !== loadGen) return;
    if (err instanceof ApiError && err.status === 404) useStore.setState({ subs: null, subsMissing: true, subsError: false });
    // a network error or 5xx keeps what was loaded; with nothing loaded the sections say so instead of a spinner
    else if (!(err instanceof ApiError && err.status === 401)) useStore.setState({ subsError: get().subs === null });
  }
}

/** The Russian text of a registry error (spec scenarios «Имя занято», «Ключ шифрования не задан»). */
export function registryError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'name_taken') return t('subscriptions.error.nameTaken');
    if (err.code === 'bad_order') return t('subscriptions.error.badOrder');
    if (err.code === 'bad_token' || (err.status === 422 && !err.serverMessage)) return t('subscriptions.error.badToken');
    if (err.code === 'subscriptions_disabled') return t('subscriptions.error.disabled');
    if (err.status === 404) return t('subscriptions.error.notFound');
    if (err.serverMessage) return err.serverMessage;
  }
  return t('subscriptions.error.hubSilent');
}

export type RegistryResult = { ok: true } | { ok: false; message: string; field?: 'name' | 'token' };

function fail(err: unknown): RegistryResult {
  void loadSubscriptions();
  const message = registryError(err);
  const field = err instanceof ApiError ? (err.code === 'name_taken' ? 'name' : err.code === 'bad_token' || (err.status === 422 && err.code !== 'bad_order') ? 'token' : undefined) : undefined;
  return field ? { ok: false, message, field } : { ok: false, message };
}

/** POST /api/subscriptions. The token is the caller's value; nothing of it stays here. */
export async function addSubscription(name: string, token: string, autoSwitch: boolean): Promise<RegistryResult> {
  try {
    await api.createSubscription({ name, token, autoSwitch });
    await loadSubscriptions();
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function patchSubscription(id: string, body: PatchSubscriptionRequest): Promise<RegistryResult> {
  try {
    await api.patchSubscription(id, body);
    await loadSubscriptions();
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

/** PUT …/token: replaces the token entirely and clears «токен отклонён». */
export async function replaceToken(id: string, token: string): Promise<RegistryResult> {
  try {
    await api.putSubscriptionToken(id, token);
    await loadSubscriptions();
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

/** PUT /api/subscriptions/order with every active id; the new order shows at once and is replaced by the hub's answer. */
export async function reorder(ids: string[]): Promise<RegistryResult> {
  const before = get().subs;
  if (before) {
    const pos = new Map(ids.map((id, i) => [id, i]));
    useStore.setState({ subs: { ...before, subscriptions: before.subscriptions.map(s => (pos.has(s.id) ? { ...s, position: pos.get(s.id)! } : s)) } });
  }
  try {
    const subs = await api.putSubscriptionOrder(ids);
    ++loadGen;
    useStore.setState({ subs });
    return { ok: true };
  } catch (err) {
    if (before) useStore.setState({ subs: before });
    return fail(err);
  }
}

export async function loadUsage(from: string, to: string): Promise<SubscriptionUsageResponse | { error: string }> {
  try {
    return await api.subscriptionUsage(from, to);
  } catch (err) {
    return { error: err instanceof ApiError && err.status === 422 ? t('subscriptions.error.badPeriod') : registryError(err) };
  }
}

function switchError(err: unknown, sid: string): string {
  const s = get().sessions[sid];
  const runner = get().runners.find(r => r.id === s?.runnerId)?.name ?? t('subscriptions.field.machineFallback');
  if (err instanceof ApiError) {
    if (err.code === 'agent_outdated') return t('subscriptions.error.agentOutdated', { runner });
    if (err.code === 'runner_offline') return t('subscriptions.head.offline', { runner });
    if (err.code === 'subscription_unavailable') return t('subscriptions.error.unavailable');
    if (err.code === 'read_only') return t('subscriptions.head.readOnly');
    if (err.serverMessage) return err.serverMessage;
  }
  return t('subscriptions.error.hubSilent');
}

/**
 * POST /api/sessions/:id/subscription (design P6). 409 turn_in_progress puts the switch into `pendingSwitch`: the
 * dialog «Идёт ход: прервать и переключить?» asks, `confirmSwitch` repeats it with `interrupt: true`.
 */
export async function switchSubscription(sid: string, subscriptionId: string, opts: { interrupt?: boolean; repeatLast?: boolean } = {}): Promise<void> {
  try {
    const r = await api.switchSubscription(sid, { subscriptionId, ...(opts.interrupt ? { interrupt: true } : {}), ...(opts.repeatLast ? { repeatLast: true } : {}) });
    if (r?.session) get().upsertSessions([r.session]);
    useStore.setState({ pendingSwitch: null });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    if (err instanceof ApiError && err.code === 'turn_in_progress' && !opts.interrupt) {
      useStore.setState({ pendingSwitch: { sessionId: sid, subscriptionId, repeatLast: !!opts.repeatLast } });
      return;
    }
    useStore.setState({ pendingSwitch: null });
    if (err instanceof ApiError && err.code === 'subscription_unavailable') void loadSubscriptions();
    get().pushToast({ title: t('subscriptions.error.switchFailed'), text: switchError(err, sid), color: 'var(--bad)' });
  }
}

export async function confirmSwitch(): Promise<void> {
  const p = get().pendingSwitch;
  if (!p) return;
  await switchSubscription(p.sessionId, p.subscriptionId, { interrupt: true, repeatLast: p.repeatLast });
}

export function cancelSwitch(): void {
  useStore.setState({ pendingSwitch: null });
}
