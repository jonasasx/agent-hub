// Task 4.1: tolerant parsing of rate_limit_event (design L1) on the two observations of the spike (design «Итоги спайка»).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { limitsSnapshotSchema } from '@agent-hub/shared';
import { parseRateLimitEvent, toPercent } from './parse.js';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as { type: string };
const ev = (info: Record<string, unknown>) => ({ type: 'rate_limit_event', rate_limit_info: info });

describe('parseRateLimitEvent', () => {
  it('setup-token, subscription exhausted (429): both windows in percent and ISO, overage rejected', () => {
    const s = parseRateLimitEvent(fixture('1-setup-token-rejected.json'))!;
    expect(s).toEqual({
      windows: [
        { type: 'five_hour', utilization: 92, resetsAt: new Date(1793121000_000).toISOString(), status: 'allowed_warning', surpassedThreshold: 90 },
        { type: 'seven_day', utilization: 100, resetsAt: new Date(1793264400_000).toISOString(), status: 'rejected', surpassedThreshold: 100 },
      ],
      overage: { status: 'rejected', inUse: false, enabled: null, disabledReason: 'out_of_credits' },
    });
    expect(limitsSnapshotSchema.safeParse(s).success).toBe(true);
  });

  it('interactive login, turn passed with allowed_warning on top: windows of unifiedWindows, not the top level', () => {
    const s = parseRateLimitEvent(fixture('2-interactive-allowed-warning.json'))!;
    expect(s.windows).toEqual([
      { type: 'five_hour', utilization: 11, resetsAt: new Date(1793124000_000).toISOString(), status: 'allowed' },
      { type: 'seven_day', utilization: 34, resetsAt: new Date(1793671200_000).toISOString(), status: 'allowed' },
    ]);
    expect(s.overage).toEqual({ status: 'rejected', inUse: false, enabled: true, disabledReason: 'out_of_credits' });
    expect(limitsSnapshotSchema.safeParse(s).success).toBe(true);
  });

  it('without unifiedWindows: one window from the top level', () => {
    const s = parseRateLimitEvent(ev({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.82, resetsAt: 1793121000 }))!;
    expect(s).toEqual({ windows: [{ type: 'five_hour', utilization: 82, resetsAt: new Date(1793121000_000).toISOString(), status: 'allowed_warning' }], overage: null });
  });

  it('an unknown window key is kept with its raw name; missing or bad fields are null; an unknown status is `unknown`', () => {
    const s = parseRateLimitEvent(ev({ unifiedWindows: { seven_day_future: { utilization: 0.5 }, seven_day_opus: { utilization: 'x', resetsAt: 'tomorrow', status: 'throttled' }, odd: null } }))!;
    expect(s.windows).toEqual([
      { type: 'seven_day_future', utilization: 50, resetsAt: null, status: null },
      { type: 'seven_day_opus', utilization: null, resetsAt: null, status: 'unknown' },
      { type: 'odd', utilization: null, resetsAt: null, status: null },
    ]);
    expect(limitsSnapshotSchema.safeParse(s).success).toBe(true);
  });

  it('percents instead of fractions; resetsAt in ms', () => {
    const s = parseRateLimitEvent(ev({ unifiedWindows: { five_hour: { utilization: 82.34, resetsAt: 1793121000_000, status: 'allowed_warning' } } }))!;
    expect(s.windows[0]).toEqual({ type: 'five_hour', utilization: 82.3, resetsAt: new Date(1793121000_000).toISOString(), status: 'allowed_warning' });
    expect([toPercent(0), toPercent(1), toPercent(1.5), toPercent(-0.1), toPercent(Number.NaN), toPercent('0.5')]).toEqual([0, 100, null, null, null, null]);
    expect([toPercent(1, true), toPercent(1.5, true), toPercent(100, true), toPercent(100.1, true)]).toEqual([1, 1.5, 100, null]);
  });

  it('review A4: the scale is chosen for the whole event: any value over 1 makes it percents, else fractions', () => {
    const pcts = (u: Record<string, number>) =>
      parseRateLimitEvent(ev({ unifiedWindows: Object.fromEntries(Object.entries(u).map(([k, v]) => [k, { utilization: v }])) }))!.windows.map(w => w.utilization);
    expect(pcts({ five_hour: 1.0 })).toEqual([100]);
    expect(pcts({ five_hour: 0.5, seven_day: 1 })).toEqual([50, 100]);
    expect(pcts({ five_hour: 50, seven_day: 1 })).toEqual([50, 1]);
    // a surpassedThreshold over 1 counts too; the top level joins the windows
    const s = parseRateLimitEvent(ev({ utilization: 90, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 1, surpassedThreshold: 0.9 } } }))!;
    expect(s.windows[0]).toMatchObject({ utilization: 1, surpassedThreshold: 0.9 });
  });

  it('at most 16 windows; a window type over 64 characters is cut; not an event → null', () => {
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`w${i}`, { utilization: 0.1 }]));
    expect(parseRateLimitEvent(ev({ unifiedWindows: many }))!.windows).toHaveLength(16);
    expect(parseRateLimitEvent(ev({ unifiedWindows: { ['k'.repeat(80)]: {} } }))!.windows[0]!.type).toHaveLength(64);
    expect(parseRateLimitEvent({ type: 'assistant' })).toBeNull();
    expect(parseRateLimitEvent({ type: 'rate_limit_event' })).toBeNull();
    expect(parseRateLimitEvent(ev({}))).toEqual({ windows: [], overage: null });
  });
});
