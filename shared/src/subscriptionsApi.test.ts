// Requirement: Реестр подписок, Хранение токена подписки, Выбор подписки при запуске и handoff (design P8)
import { describe, expect, it } from 'vitest';
import {
  SUBSCRIPTION_NAME_MAX,
  createSessionRequestSchema,
  createSubscriptionRequestSchema,
  forkRequestSchema,
  patchSubscriptionRequestSchema,
  putSubscriptionOrderRequestSchema,
  putSubscriptionTokenRequestSchema,
  subscriptionUsageQuerySchema,
  switchSubscriptionRequestSchema,
} from './index.js';

const A = '3a7c1e2d-5b4f-4a6e-9c8d-7e6f5a4b3c2d';
const B = '0b9d8c7e-6f5a-4b3c-9d2e-1f0a9b8c7d6e';
const TOKEN = 'sk-ant-oat01-' + 'Ab9_-'.repeat(16);

describe('POST /api/subscriptions body', () => {
  it('accepts a name of 1 and of 60 characters, trims it, autoSwitch optional', () => {
    expect(createSubscriptionRequestSchema.parse({ name: '  Max личная ', token: TOKEN })).toEqual({ name: 'Max личная', token: TOKEN });
    expect(createSubscriptionRequestSchema.safeParse({ name: 'x', token: TOKEN, autoSwitch: true }).success).toBe(true);
    expect(createSubscriptionRequestSchema.safeParse({ name: 'я'.repeat(SUBSCRIPTION_NAME_MAX), token: TOKEN }).success).toBe(true);
  });

  it.each([
    ['an empty name', { name: '', token: TOKEN }],
    ['a name of spaces only', { name: '   ', token: TOKEN }],
    ['a name of 61 characters', { name: 'я'.repeat(61), token: TOKEN }],
    ['no token', { name: 'A' }],
    ['a token with a space', { name: 'A', token: 'sk-ant-oat01-abc def-0123456789' }],
    ['a token with a newline', { name: 'A', token: TOKEN + '\n' }],
    ['a token of 19 characters', { name: 'A', token: 'x'.repeat(19) }],
    ['a token over 4096 characters', { name: 'A', token: 'x'.repeat(4097) }],
  ])('refuses %s', (_name, body) => {
    expect(createSubscriptionRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('PATCH /api/subscriptions/:id and PUT …/token bodies', () => {
  it('PATCH takes any of name, autoSwitch, retired and refuses an empty body or a bad name', () => {
    expect(patchSubscriptionRequestSchema.safeParse({ retired: false }).success).toBe(true);
    expect(patchSubscriptionRequestSchema.safeParse({ name: 'Pro рабочая', autoSwitch: true }).success).toBe(true);
    expect(patchSubscriptionRequestSchema.safeParse({}).success).toBe(false);
    expect(patchSubscriptionRequestSchema.safeParse({ name: '' }).success).toBe(false);
    expect(patchSubscriptionRequestSchema.safeParse({ name: 'x'.repeat(61) }).success).toBe(false);
  });

  it('PUT token checks the token like POST', () => {
    expect(putSubscriptionTokenRequestSchema.safeParse({ token: TOKEN }).success).toBe(true);
    expect(putSubscriptionTokenRequestSchema.safeParse({ token: 'short' }).success).toBe(false);
    expect(putSubscriptionTokenRequestSchema.safeParse({ token: 'a b'.repeat(10) }).success).toBe(false);
  });
});

describe('PUT /api/subscriptions/order body', () => {
  it('accepts distinct ids', () => {
    expect(putSubscriptionOrderRequestSchema.safeParse({ ids: [B, A] }).success).toBe(true);
  });
  it.each([
    ['duplicates', { ids: [A, B, A] }],
    ['an empty list', { ids: [] }],
    ['a non-uuid', { ids: [A, 'sub-2'] }],
    ['no ids', {}],
  ])('refuses %s', (_name, body) => {
    expect(putSubscriptionOrderRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('GET /api/subscriptions/usage query', () => {
  it('accepts no bounds, one bound, and a period of exactly 366 days', () => {
    expect(subscriptionUsageQuerySchema.safeParse({}).success).toBe(true);
    expect(subscriptionUsageQuerySchema.safeParse({ from: '2026-10-20T00:00:00+03:00' }).success).toBe(true);
    expect(subscriptionUsageQuerySchema.safeParse({ from: '2025-10-27T00:00:00Z', to: '2026-10-28T00:00:00Z' }).success).toBe(true);
  });
  it.each([
    ['a period over 366 days', { from: '2025-10-26T00:00:00Z', to: '2026-10-28T00:00:00Z' }],
    ['from after to', { from: '2026-10-28T00:00:00Z', to: '2026-10-27T00:00:00Z' }],
    ['from equal to to', { from: '2026-10-27T00:00:00Z', to: '2026-10-27T00:00:00Z' }],
    ['a date that is not ISO', { from: 'вчера' }],
  ])('refuses %s', (_name, q) => {
    expect(subscriptionUsageQuerySchema.safeParse(q).success).toBe(false);
  });
});

describe('subscriptionId of a launch', () => {
  const create = { runnerId: 'hp', cwd: 'C:\\x', model: 'opus', prompt: 'hi' };
  const handoff = { mode: 'handoff', prompt: 'p', runnerId: 'vm', cwd: '/home/ubuntu/vault' };

  it('absent, null and a uuid are accepted by the new-session and handoff forms', () => {
    for (const subscriptionId of [undefined, null, A]) {
      expect(createSessionRequestSchema.safeParse({ ...create, subscriptionId }).success, String(subscriptionId)).toBe(true);
      expect(forkRequestSchema.safeParse({ ...handoff, subscriptionId }).success, String(subscriptionId)).toBe(true);
    }
    const parsed = createSessionRequestSchema.parse({ ...create, subscriptionId: A });
    expect(parsed.subscriptionId).toBe(A);
  });

  it('a subscriptionId that is not a uuid is refused', () => {
    expect(createSessionRequestSchema.safeParse({ ...create, subscriptionId: 'max' }).success).toBe(false);
    expect(forkRequestSchema.safeParse({ ...handoff, subscriptionId: 'max' }).success).toBe(false);
  });

  it('POST /api/sessions/:id/subscription needs a uuid; interrupt and repeatLast are optional', () => {
    expect(switchSubscriptionRequestSchema.safeParse({ subscriptionId: A }).success).toBe(true);
    expect(switchSubscriptionRequestSchema.safeParse({ subscriptionId: A, interrupt: true, repeatLast: true }).success).toBe(true);
    expect(switchSubscriptionRequestSchema.safeParse({ subscriptionId: null }).success).toBe(false);
    expect(switchSubscriptionRequestSchema.safeParse({}).success).toBe(false);
  });
});
