// Requirement: Снимок лимитов подписки; Состояния «нет данных»; Ручное обновление (subscription-limits L6, task 2.2).
import { describe, expect, it } from 'vitest';
import {
  LIMITS_REASONS,
  REFRESH_LIMITS_ERRORS,
  refreshLimitsResponseSchema,
  subscriptionLimitsResponseSchema,
  subscriptionLimitsViewSchema,
  type SubscriptionLimitsView,
  type UiServerMessage,
} from './index.js';

const A = '3a7c1e2d-5b4f-4a6e-9c8d-7e6f5a4b3c2d';

const ok: SubscriptionLimitsView = {
  subscriptionId: A,
  state: 'ok',
  reason: null,
  windows: [
    { type: 'five_hour', utilization: 92, resetsAt: '2026-10-27T15:10:00.000Z', status: 'allowed_warning', observedAt: '2026-10-27T12:00:00.000Z', source: 'session' },
    { type: 'seven_day', utilization: 100, resetsAt: '2026-10-29T15:00:00.000Z', status: 'rejected', observedAt: '2026-10-27T12:00:00.000Z', source: 'probe' },
    { type: 'seven_day_future', utilization: null, resetsAt: null, status: null, observedAt: '2026-10-27T12:00:00.000Z', source: 'probe' },
  ],
  overage: { status: 'rejected', inUse: false, enabled: true },
  lastOkAt: '2026-10-27T12:00:00.000Z',
  quietAt: null,
  lastProbeAt: '2026-10-27T12:00:00.000Z',
  staleAt: null,
  refreshableAt: null,
};

describe('GET /api/subscriptions/limits answer', () => {
  it('accepts a full view, an unknown window with nulls, and the reasons of «нет данных»', () => {
    expect(subscriptionLimitsResponseSchema.safeParse({ limits: [ok], serverTime: '2026-10-27T12:00:05.000Z' }).success).toBe(true);
    for (const reason of LIMITS_REASONS) {
      const v = { ...ok, state: 'unavailable', reason, windows: [], overage: null, lastOkAt: null };
      expect(subscriptionLimitsViewSchema.safeParse(v).success, reason).toBe(true);
    }
    expect(subscriptionLimitsViewSchema.safeParse({ ...ok, state: 'stale', staleAt: '2026-10-27T11:00:00.000Z' }).success).toBe(true);
  });

  it.each([
    ['a percent over 100', { windows: [{ ...ok.windows[0]!, utilization: 101 }] }],
    ['an unknown state', { state: 'fresh' }],
    ['an unknown reason', { state: 'unavailable', reason: 'offline' }],
    ['an unknown source', { windows: [{ ...ok.windows[0]!, source: 'usage' }] }],
    ['a non-ISO time', { lastOkAt: '12:00' }],
    ['a subscription id that is not a uuid', { subscriptionId: 'sub-1' }],
  ])('refuses %s', (_name, extra) => {
    expect(subscriptionLimitsViewSchema.safeParse({ ...ok, ...extra }).success).toBe(false);
  });

  it('never carries a token: the view has no field for it (extra fields are dropped)', () => {
    const r = subscriptionLimitsViewSchema.parse({ ...ok, token: 'sk-ant-oat01-secret', tokenHint: 'AAAA' } as unknown);
    expect(r).not.toHaveProperty('token');
    expect(r).not.toHaveProperty('tokenHint');
  });
});

describe('POST /api/subscriptions/:id/limits/refresh', () => {
  it('202 {limits: view}; the error codes of the contract', () => {
    expect(refreshLimitsResponseSchema.safeParse({ limits: ok }).success).toBe(true);
    expect(refreshLimitsResponseSchema.safeParse({ limits: [ok] }).success).toBe(false);
    expect(REFRESH_LIMITS_ERRORS).toEqual(['not_found', 'subscription_retired', 'token_rejected', 'runner_offline', 'agent_outdated', 'probes_disabled', 'refresh_too_soon', 'subscriptions_disabled']);
  });

  it('the WS push is a bare subscription_limits.changed', () => {
    const m: UiServerMessage = { type: 'subscription_limits.changed' };
    expect(Object.keys(m)).toEqual(['type']);
  });
});
