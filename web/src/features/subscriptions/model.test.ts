// Unit tests of the pure helpers and the store side of the subscriptions UI (tasks 6.1, 6.3, 6.4).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../store';
import { mockFetch, resetStore, runner, session } from '../../test/factories';
import { handleServerMessage } from '../workspace/actions';
import { loadSubscriptions, reorder, switchSubscription } from './actions';
import { SUB_A, SUB_B, SUB_C, subView, subsResponse } from './fixtures';
import { formField, headState, initialChoice, limitUntil, moved, movedBefore, optionLabel, protocolAtLeast, usageRange } from './model';

describe('subscriptions model', () => {
  it('protocolAtLeast compares dotted versions numerically', () => {
    expect(protocolAtLeast('1.4')).toBe(true);
    expect(protocolAtLeast('1.10')).toBe(true);
    expect(protocolAtLeast('2.0')).toBe(true);
    expect(protocolAtLeast('1.3')).toBe(false);
    expect(protocolAtLeast(null)).toBe(false);
    expect(protocolAtLeast('x')).toBe(false);
  });

  it('a limit shows until it resets; a rejected token is marked in the option', () => {
    const now = new Date('2026-10-27T10:00:00');
    const s = subView({ limitResetsAt: new Date('2026-10-27T13:40:00').toISOString(), tokenRejected: true });
    expect(limitUntil(s, now)).toBe('лимит до 13:40');
    expect(optionLabel(s, now)).toBe('Max личная (лимит до 13:40, токен отклонён)');
    expect(limitUntil(subView({ limitResetsAt: new Date('2026-10-27T09:00:00').toISOString() }), now)).toBeNull();
  });

  it('Последний выбор: the default if active, else the first active one; retired ones are not offered', () => {
    expect(initialChoice(subsResponse({ defaultId: SUB_B, lastChoiceId: SUB_B }))).toBe(SUB_B);
    const r = subsResponse({ subscriptions: [subView({ retired: true }), subView({ id: SUB_B, name: 'Pro', position: 1 })], defaultId: SUB_A });
    expect(initialChoice(r)).toBe(SUB_B);
    expect(initialChoice(null)).toBe('');
  });

  it('Поведение без подписок / Агент без поддержки подписок: the form field', () => {
    expect(formField(null, runner())).toBe('hidden');
    expect(formField(subsResponse({ subscriptions: [subView({ retired: true })] }), runner())).toBe('hidden');
    expect(formField(subsResponse(), runner({ protocolVersion: '1.3' }))).toBe('outdated');
    expect(formField(subsResponse(), runner({ protocolVersion: '1.4' }))).toBe('select');
  });

  it('a hub without SUBSCRIPTION_TOKEN_KEY (enabled: false): no field and no switch even with subscriptions in the registry', () => {
    const off = subsResponse({ enabled: false });
    const r4 = runner({ protocolVersion: '1.4' });
    expect(off.subscriptions.length).toBeGreaterThan(0);
    expect(formField(off, r4)).toBe('hidden');
    expect(headState(session({ processAlive: true, subscription: { id: SUB_A, name: 'Max' }, subscriptionMode: 'subscription' }), off, r4)).toEqual({ kind: 'hidden' });
    expect(headState(session({ processAlive: false, status: 'sleeping', subscriptionMode: 'none' }), off, r4)).toEqual({ kind: 'hidden' });
  });

  it('the head: the live process, «продолжит под» the default for a sleeping one, «вход машины», hidden', () => {
    const r4 = runner({ protocolVersion: '1.4' });
    const subs = subsResponse({ defaultId: SUB_B });
    expect(headState(session({ processAlive: true, subscription: { id: SUB_A, name: 'Max' }, subscriptionMode: 'subscription' }), subs, r4)).toEqual({ kind: 'select', value: SUB_A, next: false });
    expect(headState(session({ processAlive: false, status: 'sleeping', subscription: { id: SUB_A, name: 'Max' }, subscriptionMode: 'subscription' }), subs, r4)).toEqual({
      kind: 'select',
      value: SUB_B,
      next: true,
    });
    expect(headState(session({ processAlive: true, subscription: null, subscriptionMode: 'machine_login' }), subs, r4)).toEqual({ kind: 'select', value: '', next: false });
    expect(headState(session({ subscriptionMode: 'agent_outdated' }), subs, r4)).toEqual({ kind: 'outdated' });
    expect(headState(session({}), subs, runner({ protocolVersion: '1.3' }))).toEqual({ kind: 'outdated' });
    expect(headState(session({}), null, r4)).toEqual({ kind: 'hidden' });
    expect(headState(session({ subscriptionMode: 'none' }), subsResponse({ subscriptions: [subView({ retired: true })] }), r4)).toEqual({ kind: 'hidden' });
  });

  it('the head: mode none from an empty registry is stale once a subscription is added — derived from the runner and the subscription', () => {
    const subs = subsResponse({ defaultId: SUB_B });
    const r4 = runner({ protocolVersion: '1.4' });
    // a live process under the machine login (the registry was empty at its start)
    expect(headState(session({ processAlive: true, subscription: null, subscriptionMode: 'none' }), subs, r4)).toEqual({ kind: 'select', value: '', next: false });
    expect(headState(session({ processAlive: true, subscription: { id: SUB_A, name: 'Max' }, subscriptionMode: 'none' }), subs, r4)).toEqual({ kind: 'select', value: SUB_A, next: false });
    expect(headState(session({ processAlive: false, status: 'sleeping', subscriptionMode: 'none' }), subs, r4)).toEqual({ kind: 'select', value: SUB_B, next: true });
    expect(headState(session({ processAlive: true, subscriptionMode: 'none' }), subs, runner({ protocolVersion: '1.3' }))).toEqual({ kind: 'outdated' });
    expect(headState(session({ processAlive: true, subscriptionMode: 'none' }), subs, runner({ protocolVersion: null }))).toEqual({ kind: 'outdated' });
    expect(headState(session({ processAlive: true, subscriptionMode: 'none' }), subs, undefined)).toEqual({ kind: 'hidden' });
  });

  it('the head: a session written in a terminal (externalActive) without a hub process is «продолжит под», not the process subscription', () => {
    const subs = subsResponse({ defaultId: SUB_B });
    const s = session({ processAlive: false, externalActive: true, status: 'sleeping', subscription: { id: SUB_A, name: 'Max' }, subscriptionMode: 'subscription' });
    expect(headState(s, subs, runner({ protocolVersion: '1.4' }))).toEqual({ kind: 'select', value: SUB_B, next: true });
  });

  it('usage periods: today from the local midnight, whole local days for dates, ≤ 366 days', () => {
    const now = new Date('2026-10-27T15:30:00');
    const t = usageRange('today', now) as { from: string; to: string };
    expect(new Date(t.from).getHours()).toBe(0);
    expect(t.to).toBe(now.toISOString());
    const d = usageRange('dates', now, { from: '2026-10-01', to: '2026-10-01' }) as { from: string; to: string };
    expect(Date.parse(d.to) - Date.parse(d.from)).toBe(86_400_000);
    expect(usageRange('dates', now, { from: '2026-10-05', to: '2026-10-01' })).toEqual({ error: 'Начало периода позже конца' });
    expect(usageRange('dates', now, { from: '2025-01-01', to: '2026-10-01' })).toEqual({ error: 'Период — не больше 366 дней' });
    expect(usageRange('dates', now, { from: '', to: '2026-10-01' })).toEqual({ error: 'Укажите обе даты' });
  });

  it('order: ↑/↓ and drag before another row', () => {
    expect(moved([SUB_A, SUB_B, SUB_C], SUB_C, -1)).toEqual([SUB_A, SUB_C, SUB_B]);
    expect(moved([SUB_A, SUB_B], SUB_A, -1)).toBeNull();
    expect(movedBefore([SUB_A, SUB_B, SUB_C], SUB_C, SUB_A)).toEqual([SUB_C, SUB_A, SUB_B]);
    expect(movedBefore([SUB_A, SUB_B, SUB_C], SUB_A, null)).toEqual([SUB_B, SUB_C, SUB_A]);
    expect(movedBefore([SUB_A, SUB_B], SUB_A, SUB_B)).toBeNull();
  });
});

describe('subscriptions store', () => {
  beforeEach(resetStore);
  afterEach(() => vi.unstubAllGlobals());

  it('after subscriptions.changed the list is reloaded from the hub; no token field reaches the store', async () => {
    let n = 0;
    mockFetch({
      'GET /api/subscriptions': () => {
        n++;
        return {
          status: 200,
          body: n === 1 ? subsResponse() : subsResponse({ subscriptions: [subView(), subView({ id: SUB_C, name: 'Третья', position: 1 })], lastChoiceId: SUB_C, defaultId: SUB_C }),
        };
      },
    });
    await loadSubscriptions();
    expect(useStore.getState().subs?.subscriptions.map(s => s.name)).toEqual(['Max личная', 'Pro рабочая']);
    handleServerMessage({ type: 'subscriptions.changed' });
    await vi.waitFor(() => expect(useStore.getState().subs?.defaultId).toBe(SUB_C));
    expect(useStore.getState().subs?.subscriptions.map(s => s.name)).toEqual(['Max личная', 'Третья']);
    expect(JSON.stringify(useStore.getState())).not.toMatch(/"token"/);
  });

  it('a hub without the API (404) leaves no subscription UI', async () => {
    mockFetch({});
    useStore.setState({ subs: subsResponse() });
    await loadSubscriptions();
    expect(useStore.getState().subs).toBeNull();
  });

  it('reorder shows the new order at once and keeps the hub answer; a refused order rolls back', async () => {
    useStore.setState({ subs: subsResponse() });
    const calls = mockFetch({ 'PUT /api/subscriptions/order': () => ({ status: 422, body: { error: 'bad_order' } }), 'GET /api/subscriptions': () => ({ status: 200, body: subsResponse() }) });
    const r = await reorder([SUB_B, SUB_A]);
    expect(r).toEqual({ ok: false, message: 'Список подписок изменился — порядок обновлён' });
    expect(calls.find(c => c.method === 'PUT')!.body).toEqual({ ids: [SUB_B, SUB_A] });
    expect(useStore.getState().subs?.subscriptions.find(s => s.id === SUB_A)?.position).toBe(0);
  });

  it('switch: 409 turn_in_progress waits for the confirmation; other errors are a toast', async () => {
    const s = session({ status: 'working' });
    useStore.setState({ runners: [runner()] });
    useStore.getState().upsertSessions([s]);
    mockFetch({ 'POST /api/sessions/': () => ({ status: 409, body: { error: 'turn_in_progress' } }) });
    await switchSubscription(s.id, SUB_B);
    expect(useStore.getState().pendingSwitch).toEqual({ sessionId: s.id, subscriptionId: SUB_B, repeatLast: false });
    mockFetch({ 'POST /api/sessions/': () => ({ status: 409, body: { error: 'runner_offline' } }) });
    await switchSubscription(s.id, SUB_B, { interrupt: true });
    expect(useStore.getState().pendingSwitch).toBeNull();
    expect(useStore.getState().toasts.at(-1)).toMatchObject({ title: 'Подписка не переключена', text: 'X1 не в сети' });
  });
});
