/**
 * Pure helpers of the subscriptions UI (change claude-subscriptions, design P8, P9).
 * Requirements: Реестр подписок; Последний выбор подписки; Выбор подписки при запуске и handoff; Подписка в шапке
 * вкладки и переключение; Поведение без подписок; Агент без поддержки подписок; Исчерпан лимит подписки.
 */
import {
  CODEX_SUBSCRIPTIONS_PROTOCOL,
  PROVIDERS,
  PROVIDER_LABELS,
  SUBSCRIPTIONS_PROTOCOL,
  type Provider,
  type RunnerView,
  type SessionView,
  type SubscriptionView,
  type SubscriptionsResponse,
} from '../../api/types';

/** «Коннекторы claude.ai …» (Requirement: Ограничения сессии под подпиской). */
export const CONNECTORS_HINT = 'Коннекторы claude.ai (Gmail, Drive и др.) под подпиской недоступны, локальные MCP работают';
export const MACHINE_LOGIN = 'вход машины';

/** The subscription's vendor; a registry of an older hub has no field — Claude. */
export const subProvider = (s: Pick<SubscriptionView, 'provider'>): Provider => s.provider ?? 'claude';

/** Active subscriptions of a provider in the order of the registry. */
export function activeSubs(subs: SubscriptionsResponse | null, provider: Provider = 'claude'): SubscriptionView[] {
  return subs ? subs.subscriptions.filter(s => !s.retired && subProvider(s) === provider).sort((a, b) => a.position - b.position) : [];
}

export function retiredSubs(subs: SubscriptionsResponse | null, provider: Provider = 'claude'): SubscriptionView[] {
  return subs ? subs.subscriptions.filter(s => s.retired && subProvider(s) === provider) : [];
}

/** Active subscriptions of every provider in the order of the registry (the limits screen). */
export function activeAllSubs(subs: SubscriptionsResponse | null): SubscriptionView[] {
  return subs ? subs.subscriptions.filter(s => !s.retired).sort((a, b) => a.position - b.position) : [];
}

/** The protocol an agent needs to run a session of the provider under a subscription of the registry. */
export const subscriptionsProtocol = (provider: Provider): string => (provider === 'codex' ? CODEX_SUBSCRIPTIONS_PROTOCOL : SUBSCRIPTIONS_PROTOCOL);

/** «Claude»/«Codex» — the vendor mark next to the name of a subscription. */
export const providerLabel = (provider: Provider): string => PROVIDER_LABELS[provider];

/** Providers that have anything in the registry or can be added to it. */
export const REGISTRY_PROVIDERS: readonly Provider[] = PROVIDERS;

/**
 * The full order for PUT /api/subscriptions/order after `next` reordered the active subscriptions of `provider`:
 * the other providers keep their places, the slots of `provider` are filled in the new order.
 */
export function fullOrder(subs: SubscriptionsResponse | null, provider: Provider, next: string[]): string[] {
  const all = activeAllSubs(subs);
  const queue = [...next];
  return all.map(s => (subProvider(s) === provider ? (queue.shift() ?? s.id) : s.id));
}

/**
 * Requirement: Поведение без подписок — no field, no switch while the registry has no active subscription, or while
 * the hub keeps no tokens (`enabled: false`, no SUBSCRIPTION_TOKEN_KEY): every launch runs under the machine login then.
 */
export function hasActive(subs: SubscriptionsResponse | null, provider: Provider = 'claude'): boolean {
  return !!subs?.enabled && activeSubs(subs, provider).length > 0;
}

/** «1.4» ≥ «1.4»: numeric comparison of dotted versions; an unknown version is not enough. */
export function protocolAtLeast(version: string | null | undefined, min: string = SUBSCRIPTIONS_PROTOCOL): boolean {
  if (!version) return false;
  const a = version.split('.').map(Number);
  const b = min.split('.').map(Number);
  if (a.some(x => !Number.isFinite(x))) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

/** «03:40» for today, «28.10 03:40» for another day, in the browser time zone. */
export function clock(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? time : `${d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })} ${time}`;
}

/** The limit of a subscription while it has not reset yet; null otherwise. */
export function limitUntil(s: Pick<SubscriptionView, 'limitResetsAt'>, now: Date = new Date()): string | null {
  if (!s.limitResetsAt) return null;
  const t = Date.parse(s.limitResetsAt);
  return Number.isFinite(t) && t > now.getTime() ? `лимит до ${clock(s.limitResetsAt, now)}` : null;
}

/** An option of a subscription select: the name, a known limit or a rejected token in brackets. */
export function optionLabel(s: SubscriptionView, now: Date = new Date()): string {
  const marks = [limitUntil(s, now), s.tokenRejected ? 'токен отклонён' : null].filter(Boolean);
  return marks.length ? `${s.name} (${marks.join(', ')})` : s.name;
}

/** A short option for the «⋯» menu of the tab head (UI review M5): «Имя · до 13:06», «Имя · токен отклонён». */
export function shortOptionLabel(s: SubscriptionView, now: Date = new Date()): string {
  const limit = limitUntil(s, now);
  const marks = [limit ? limit.replace('лимит ', '') : null, s.tokenRejected ? 'токен отклонён' : null].filter(Boolean);
  return [s.name, ...marks].join(' · ');
}

/**
 * The warning under the form field for the chosen subscription (UI review C3: the preselection stays the last choice,
 * but a known limit or a rejected token is said aloud). null — nothing to warn about.
 */
export function choiceWarning(s: SubscriptionView | undefined, now: Date = new Date()): { level: 'warn' | 'bad'; text: string } | null {
  if (!s) return null;
  if (s.tokenRejected) return { level: 'bad', text: 'Токен отклонён — замените токен' };
  const t = s.limitResetsAt ? Date.parse(s.limitResetsAt) : NaN;
  if (Number.isFinite(t) && t > now.getTime()) return { level: 'warn', text: `Лимит до ${clock(s.limitResetsAt!, now)} — первый ход упрётся в лимит` };
  return null;
}

/** `…abcd`: the only part of a token the browser ever sees. */
export const tokenMask = (hint: string) => `…${hint}`;

/**
 * What the form field «Подписка» is for the chosen runner: hidden (empty registry or no API), a hint instead of the
 * field (agent older than 1.4) or the select.
 */
export function formField(subs: SubscriptionsResponse | null, runner: RunnerView | undefined, provider: Provider = 'claude'): 'hidden' | 'outdated' | 'select' {
  if (!hasActive(subs, provider)) return 'hidden';
  if (runner && !protocolAtLeast(runner.protocolVersion, subscriptionsProtocol(provider))) return 'outdated';
  return 'select';
}

export const outdatedText = (runnerName: string) => `Агент на ${runnerName} устарел — сессия пойдёт под входом машины — обновите агента`;

/** The subscription a form starts with: the hub's default (the last choice if active, else the first active one). */
export function initialChoice(subs: SubscriptionsResponse | null, provider: Provider = 'claude'): string {
  const active = activeSubs(subs, provider);
  const def = subs?.byProvider?.[provider]?.defaultId ?? (provider === 'claude' ? subs?.defaultId : null);
  if (def && active.some(s => s.id === def)) return def;
  return active[0]?.id ?? '';
}

/**
 * The subscription of a session in the tab head (Requirement: Подписка в шапке вкладки и переключение):
 * - `hidden` — empty registry / no API. Mode `none` comes from the moment of the view (empty registry then): with
 *   active subscriptions now it is stale and the state is derived from the runner's protocol and the subscription;
 * - `outdated` — the machine's agent is older than 1.4: «вход машины», no switch;
 * - `select` — the select; `value` is the subscription of the live process ('' — the machine login) or, for a session
 *   without a process, the subscription resume will use (`next` — «продолжит под»). «A process» is the hub's own
 *   (`processAlive`), not a terminal writing the transcript (`externalActive`): resume would start a new process.
 */
export type HeadState = { kind: 'hidden' } | { kind: 'outdated' } | { kind: 'select'; value: string; next: boolean };

export function headState(s: SessionView, subs: SubscriptionsResponse | null, runner: RunnerView | undefined): HeadState {
  const provider = s.provider ?? 'claude';
  const need = subscriptionsProtocol(provider);
  if (!hasActive(subs, provider)) return { kind: 'hidden' };
  if (s.subscriptionMode === 'none') {
    // stale (the view was built while the registry was empty): derive from the runner, unknown runner — nothing to show
    if (!runner) return { kind: 'hidden' };
    if (!protocolAtLeast(runner.protocolVersion, need)) return { kind: 'outdated' };
  }
  if (s.subscriptionMode === 'agent_outdated' || (runner && runner.protocolVersion && !protocolAtLeast(runner.protocolVersion, need))) return { kind: 'outdated' };
  if (s.processAlive) return { kind: 'select', value: s.subscription?.id ?? '', next: false };
  return { kind: 'select', value: initialChoice(subs, provider), next: true };
}

/** A name for a subscription id: retired ones too (history); null for an unknown id. */
export function subName(subs: SubscriptionsResponse | null, id: string | null | undefined): string | null {
  if (!id) return null;
  return subs?.subscriptions.find(s => s.id === id)?.name ?? null;
}

// ---------- the usage screen (Requirement: Учёт ходов и расход по подпискам) ----------

export type UsagePeriod = 'today' | '7d' | '30d' | 'dates';
export const USAGE_PERIODS: Array<{ value: UsagePeriod; label: string }> = [
  { value: 'today', label: 'Сегодня' },
  { value: '7d', label: '7 дней' },
  { value: '30d', label: '30 дней' },
  { value: 'dates', label: 'Даты' },
];

const DAY = 86_400_000;

/** `YYYY-MM-DD` of a local date. */
export function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * The interval of a period, ISO. «Сегодня» — from the local midnight; «Даты» — whole local days, `to` inclusive.
 * Returns an error text for a bad pair of dates.
 */
export function usageRange(period: UsagePeriod, now: Date = new Date(), dates?: { from: string; to: string }): { from: string; to: string } | { error: string } {
  if (period === 'today') {
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return { from: from.toISOString(), to: now.toISOString() };
  }
  if (period === '7d' || period === '30d') {
    const days = period === '7d' ? 7 : 30;
    return { from: new Date(now.getTime() - days * DAY).toISOString(), to: now.toISOString() };
  }
  const f = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dates?.from ?? '');
  const t = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dates?.to ?? '');
  if (!f || !t) return { error: 'Укажите обе даты' };
  const from = new Date(Number(f[1]), Number(f[2]) - 1, Number(f[3]));
  const to = new Date(Number(t[1]), Number(t[2]) - 1, Number(t[3]) + 1);
  if (from >= to) return { error: 'Начало периода позже конца' };
  if (to.getTime() - from.getTime() > 366 * DAY) return { error: 'Период — не больше 366 дней' };
  return { from: from.toISOString(), to: to.toISOString() };
}

export const fmtInt = (n: number) => n.toLocaleString('ru-RU');

/** Moves `id` by `delta` places among the active ids; null when it cannot move. */
export function moved(ids: string[], id: string, delta: number): string[] | null {
  const i = ids.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= ids.length) return null;
  const next = [...ids];
  next.splice(i, 1);
  next.splice(j, 0, id);
  return next;
}

/** Puts `id` before `beforeId` (drag and drop); `beforeId` null — to the end. */
export function movedBefore(ids: string[], id: string, beforeId: string | null): string[] | null {
  if (id === beforeId || !ids.includes(id)) return null;
  const rest = ids.filter(x => x !== id);
  const at = beforeId === null ? rest.length : rest.indexOf(beforeId);
  if (at < 0) return null;
  rest.splice(at, 0, id);
  return rest.join() === ids.join() ? null : rest;
}
