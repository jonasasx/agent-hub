/**
 * Subscription limits of the in-memory hub (change subscription-limits, design.md L6): GET /api/subscriptions/limits,
 * POST /api/subscriptions/:id/limits/refresh (202, 404, 409, 429 refresh_too_soon + Retry-After). A refresh answers
 * 202 at once and «finishes the probe turn» after `probeMs`, then broadcasts subscription_limits.changed — like the hub,
 * the message carries no data. Values follow the spike 2026-10-27 (design.md «Итоги спайка»).
 */
type Json = Record<string, unknown>;

export interface MockWindow {
  type: string;
  utilization: number | null;
  resetsAt: string | null;
  status: 'allowed' | 'allowed_warning' | 'rejected' | 'unknown' | null;
  observedAt: string;
  source: 'session' | 'probe';
}

export interface MockLimitsView {
  subscriptionId: string;
  state: 'ok' | 'stale' | 'unavailable';
  reason: string | null;
  windows: MockWindow[];
  overage: Json | null;
  lastOkAt: string | null;
  quietAt: string | null;
  lastProbeAt: string | null;
  staleAt: string | null;
  refreshableAt: string | null;
}

const at = (min: number) => new Date(Date.now() + min * 60_000).toISOString();

export const mockWindow = (type: string, utilization: number | null, resetInMin: number | null, status: MockWindow['status'] = 'allowed', source: MockWindow['source'] = 'session'): MockWindow => ({
  type,
  utilization,
  resetsAt: resetInMin == null ? null : at(resetInMin),
  status,
  observedAt: at(-3),
  source,
});

export const emptyLimits = (subscriptionId: string, over: Partial<MockLimitsView> = {}): MockLimitsView => ({
  subscriptionId,
  state: 'unavailable',
  reason: 'not_polled',
  windows: [],
  overage: null,
  lastOkAt: null,
  quietAt: null,
  lastProbeAt: null,
  staleAt: null,
  refreshableAt: null,
  ...over,
});

export class MockLimits {
  views = new Map<string, MockLimitsView>();
  /** Refresh requests by subscription id, in order. */
  refreshes: string[] = [];
  /** How long a probe turn «runs» before the snapshot changes. */
  probeMs = 400;
  /** The windows a probe turn brings; null — `no_event` (the subscription below the warning thresholds). */
  probeResult = new Map<string, MockWindow[] | null>();
  /** 409 code for the next refresh of a subscription (runner_offline, …). */
  refuse = new Map<string, string>();

  view(id: string): MockLimitsView {
    return this.views.get(id) ?? emptyLimits(id);
  }

  set(id: string, over: Partial<MockLimitsView>) {
    this.views.set(id, { ...this.view(id), ...over });
  }
}

/**
 * Answers a limits request; null — not a limits path. `ids` — active subscription ids in the registry order, `known`
 * — any id of the user (a retired one gets 409), `changed` broadcasts subscription_limits.changed.
 */
export function handleLimits(
  lim: MockLimits,
  path: string,
  method: string,
  ids: string[],
  known: (id: string) => { retired: boolean; tokenRejected: boolean } | null,
  changed: () => void,
): { status: number; body: unknown; headers?: Record<string, string> } | null {
  if (path === '/api/subscriptions/limits' && method === 'GET') {
    return { status: 200, body: { limits: ids.map(id => lim.view(id)), serverTime: new Date().toISOString() } };
  }
  const m = /^\/api\/subscriptions\/([^/]+)\/limits\/refresh$/.exec(path);
  if (!m || method !== 'POST') return null;
  const id = m[1]!;
  const s = known(id);
  // bodies as the hub sends them (hub/src/http/api.ts): {error, message, ...details}
  if (!s) return { status: 404, body: { error: 'not_found', message: 'Подписка не найдена' } };
  if (s.retired) return { status: 409, body: { error: 'subscription_retired', message: 'Подписка выведена' } };
  if (s.tokenRejected) return { status: 409, body: { error: 'token_rejected', message: 'Токен отклонён' } };
  const refuse = lim.refuse.get(id);
  if (refuse) {
    lim.refuse.delete(id);
    return { status: 409, body: { error: refuse, message: refuse } };
  }
  const v = lim.view(id);
  const until = v.refreshableAt ? Date.parse(v.refreshableAt) : 0;
  if (until > Date.now()) {
    const sec = Math.ceil((until - Date.now()) / 1000);
    // the hub puts the wait both in the body (`retryAfter`, seconds as a string) and in Retry-After
    return { status: 429, body: { error: 'refresh_too_soon', message: `Обновить можно через ${sec} с`, retryAfter: String(sec) }, headers: { 'Retry-After': String(sec) } };
  }
  lim.refreshes.push(id);
  lim.set(id, { refreshableAt: new Date(Date.now() + 30_000).toISOString() });
  setTimeout(() => {
    const now = new Date().toISOString();
    const result = lim.probeResult.has(id) ? lim.probeResult.get(id)! : null;
    if (result) lim.set(id, { state: 'ok', reason: null, windows: result.map(w => ({ ...w, observedAt: now, source: 'probe' })), lastOkAt: now, lastProbeAt: now });
    else lim.set(id, { state: 'ok', reason: null, quietAt: now, lastProbeAt: now });
    changed();
  }, lim.probeMs);
  return { status: 202, body: { limits: lim.view(id) } };
}
