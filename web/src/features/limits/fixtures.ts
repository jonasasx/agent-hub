// Test data of the limits UI (change subscription-limits). Values of the spike 2026-10-27 (design.md «Итоги спайка»).
import type { LimitWindowView, SubscriptionLimitsResponse, SubscriptionLimitsView } from '../../api/types';
import { SUB_A } from '../subscriptions/fixtures';

export const NOW = Date.parse('2026-10-27T14:52:00Z');
export const isoAt = (minFromNow: number) => new Date(NOW + minFromNow * 60_000).toISOString();

export const win = (over: Partial<LimitWindowView> = {}): LimitWindowView => ({
  type: 'five_hour',
  utilization: 11,
  resetsAt: isoAt(270),
  status: 'allowed',
  observedAt: isoAt(-3),
  source: 'session',
  ...over,
});

export const limView = (over: Partial<SubscriptionLimitsView> = {}): SubscriptionLimitsView => ({
  subscriptionId: SUB_A,
  state: 'ok',
  reason: null,
  windows: [win(), win({ type: 'seven_day', utilization: 34, resetsAt: isoAt(7 * 1440) })],
  overage: null,
  lastOkAt: isoAt(-3),
  quietAt: null,
  lastProbeAt: null,
  staleAt: null,
  refreshableAt: null,
  ...over,
});

export const limResponse = (limits: SubscriptionLimitsView[], serverTime = new Date().toISOString()): SubscriptionLimitsResponse => ({ limits, serverTime });
