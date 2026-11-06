/**
 * Side effects of the limits UI (change subscription-limits, design.md L6, task 6.2): GET /api/subscriptions/limits
 * into the store on start, on `subscription_limits.changed`, `subscriptions.changed` and after a reconnect; «Обновить».
 * A hub without the API (404) leaves `limits` null: the block and the chip are hidden.
 */
import { ApiError, api } from '../../api/client';
import { useStore } from '../../store';
import { subscriptionLimitsResponseSchema, type SubscriptionLimitsView } from '../../api/types';
import { refreshErrorText } from './limitTexts';

let loadGen = 0;

export async function loadLimits(): Promise<void> {
  const gen = ++loadGen;
  try {
    const r = await api.subscriptionLimits();
    if (gen !== loadGen) return;
    // the shared schema of the hub's answer: a body that does not match hides the block instead of breaking it
    const parsed = subscriptionLimitsResponseSchema.safeParse(r);
    if (!parsed.success) {
      useStore.setState({ limits: null });
      return;
    }
    const server = Date.parse(parsed.data.serverTime);
    useStore.setState({ limits: parsed.data, limitsSkew: Number.isFinite(server) ? server - Date.now() : 0 });
  } catch (err) {
    if (gen === loadGen && err instanceof ApiError && err.status === 404) useStore.setState({ limits: null });
  }
}

/** The hub's «now» for the model: the browser clock shifted by the last `serverTime`. */
export const hubNow = () => Date.now() + useStore.getState().limitsSkew;

function putView(view: SubscriptionLimitsView) {
  const cur = useStore.getState().limits;
  if (!cur) return;
  const has = cur.limits.some(l => l.subscriptionId === view.subscriptionId);
  useStore.setState({ limits: { ...cur, limits: has ? cur.limits.map(l => (l.subscriptionId === view.subscriptionId ? view : l)) : [...cur.limits, view] } });
}

export type RefreshResult = { ok: true } | { ok: false; message: string };

/**
 * POST …/:id/limits/refresh. 202 — the probe is queued, its result comes with `subscription_limits.changed`; the
 * answer's view (with `refreshableAt`) replaces the stored one at once. 429 refresh_too_soon moves `refreshableAt` to
 * the hub's Retry-After; the button counts it down.
 */
export async function refreshLimits(id: string): Promise<RefreshResult> {
  try {
    const r = await api.refreshSubscriptionLimits(id);
    if (r?.limits) putView(r.limits);
    return { ok: true };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return { ok: false, message: '' };
    if (err instanceof ApiError && err.status === 429) {
      const sec = Number(err.body?.retryAfter);
      const cur = useStore.getState().limits?.limits.find(l => l.subscriptionId === id);
      const wait = Number.isFinite(sec) && sec > 0 ? sec : 30;
      if (cur) putView({ ...cur, refreshableAt: new Date(hubNow() + wait * 1000).toISOString() });
      return { ok: false, message: `Слишком часто: повторить можно через ${Math.ceil(wait)} с.` };
    }
    if (err instanceof ApiError && err.status === 404) void loadLimits();
    return { ok: false, message: refreshErrorText(err instanceof ApiError ? err.code : null, err instanceof ApiError ? err.status : 0) };
  }
}

export function openLimitCard(subscriptionId: string, from: 'row' | 'chip'): void {
  const cur = useStore.getState().limitCard;
  useStore.setState({ limitCard: cur?.subscriptionId === subscriptionId && cur.from === from ? null : { subscriptionId, from } });
}

export function closeLimitCard(): void {
  useStore.setState({ limitCard: null });
}
