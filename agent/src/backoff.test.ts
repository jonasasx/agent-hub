import { describe, expect, it } from 'vitest';
import { backoffDelay, DEFAULT_BACKOFF } from './backoff.js';

describe('backoffDelay (1–60 s with jitter)', () => {
  it('grows exponentially and stays within [1 s, 60 s]', () => {
    const hi = (a: number) => backoffDelay(a, DEFAULT_BACKOFF, () => 1);
    const lo = (a: number) => backoffDelay(a, DEFAULT_BACKOFF, () => 0);
    expect([0, 1, 2, 3, 4, 5, 6, 7, 20, 1000].map(hi)).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000]);
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(lo)).toEqual([1000, 1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it('jitters: random draws spread inside [ceiling/2, ceiling]', () => {
    const values = Array.from({ length: 500 }, () => backoffDelay(4));
    expect(Math.min(...values)).toBeGreaterThanOrEqual(8000);
    expect(Math.max(...values)).toBeLessThanOrEqual(16000);
    expect(new Set(values).size).toBeGreaterThan(100);
  });

  it('never leaves the bounds for any attempt', () => {
    for (let a = 0; a < 100; a++) {
      const d = backoffDelay(a);
      expect(d).toBeGreaterThanOrEqual(1000);
      expect(d).toBeLessThanOrEqual(60000);
    }
  });

  it('honours custom bounds', () => {
    expect(backoffDelay(10, { minMs: 50, maxMs: 200 }, () => 1)).toBe(200);
    expect(backoffDelay(0, { minMs: 50, maxMs: 200 }, () => 0)).toBe(50);
  });
});
