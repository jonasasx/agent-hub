// subscription-limits tasks 5.1, 5.2 (pure part): merging windows, the state of a view, when a probe is due.
import { describe, expect, it } from 'vitest';
import type { LimitWindow } from '@agent-hub/shared';
import { mergeWindows, toLimitsView, type LimitsRow, type StoredLimitWindow } from './limitsRepo.js';
import { backoffMs, exhausted, probeDue } from './limits.js';

const NOW = new Date('2026-10-27T12:00:00.000Z');
const min = (n: number) => new Date(NOW.getTime() - n * 60_000);
const SUB: { id: string; token_rejected_at: Date | null; retired_at: Date | null; limit_resets_at: Date | null } = {
  id: '3a7c1e2d-5b4f-4a6e-9c8d-7e6f5a4b3c2d',
  token_rejected_at: null,
  retired_at: null,
  limit_resets_at: null,
};

const w = (type: string, utilization: number | null, extra: Partial<LimitWindow> = {}): LimitWindow => ({ type, utilization, resetsAt: '2026-10-27T15:10:00.000Z', status: 'allowed', ...extra });
const stored = (type: string, utilization: number | null, at: Date, extra: Partial<StoredLimitWindow> = {}): StoredLimitWindow => ({
  ...w(type, utilization),
  observedAt: at.toISOString(),
  source: 'session',
  ...extra,
});

function row(o: Partial<LimitsRow> = {}): LimitsRow {
  return {
    subscription_id: SUB.id,
    user_id: 'u',
    token_at: NOW,
    windows: [],
    overage: null,
    last_ok_at: null,
    last_quiet_at: null,
    last_probe_at: null,
    probe_outcome: null,
    probe_error: null,
    probe_failures: 0,
    updated_at: NOW,
    ...o,
  };
}

describe('mergeWindows', () => {
  it('a newer window replaces its type; windows missing from the event stay; new types are appended', () => {
    const s = [stored('five_hour', 40, min(10)), stored('seven_day', 80, min(10))];
    const out = mergeWindows(s, [w('five_hour', 55, { status: 'allowed_warning' }), w('seven_day_future', null, { resetsAt: null, status: null })], min(1), 'probe')!;
    expect(out.map(x => [x.type, x.utilization, x.source])).toEqual([
      ['five_hour', 55, 'probe'],
      ['seven_day', 80, 'session'],
      ['seven_day_future', null, 'probe'],
    ]);
    expect(out[0]!.observedAt).toBe(min(1).toISOString());
  });

  it('an older event does not change a window; nothing changed → null', () => {
    const s = [stored('five_hour', 40, min(1))];
    expect(mergeWindows(s, [w('five_hour', 99)], min(5), 'session')).toBeNull();
    expect(mergeWindows(s, [], NOW, 'session')).toBeNull();
  });
});

describe('toLimitsView', () => {
  const v = (r: LimitsRow | undefined, sub: Partial<typeof SUB> = {}, idleSec = 1800) => toLimitsView({ ...SUB, ...sub }, r, NOW, { idleSec });

  it('fresh windows → ok with percents, ISO times, the source; no surpassedThreshold or disabledReason in the view', () => {
    const r = row({
      windows: [{ ...stored('five_hour', 92, min(5)), surpassedThreshold: 90 }],
      overage: { status: 'rejected', inUse: false, enabled: true, disabledReason: 'out_of_credits' },
      last_ok_at: min(5),
      last_probe_at: min(5),
    });
    expect(v(r)).toEqual({
      subscriptionId: SUB.id,
      state: 'ok',
      reason: null,
      windows: [{ type: 'five_hour', utilization: 92, resetsAt: '2026-10-27T15:10:00.000Z', status: 'allowed', observedAt: min(5).toISOString(), source: 'session' }],
      overage: { status: 'rejected', inUse: false, enabled: true },
      lastOkAt: min(5).toISOString(),
      quietAt: null,
      lastProbeAt: min(5).toISOString(),
      staleAt: null,
      refreshableAt: null,
    });
  });

  it('no data: not_polled, or the reason of the last attempt (no_runner, agent_outdated, probe_failed)', () => {
    expect(v(undefined)).toMatchObject({ state: 'unavailable', reason: 'not_polled', windows: [] });
    expect(v(row({ probe_outcome: 'no_runner' })).reason).toBe('no_runner');
    expect(v(row({ probe_outcome: 'agent_outdated' })).reason).toBe('agent_outdated');
    expect(v(row({ probe_outcome: 'failed' })).reason).toBe('probe_failed');
    expect(v(row({ probe_outcome: 'account_unavailable' })).reason).toBe('probe_failed');
  });

  it('token_rejected wins over everything, the last snapshot time is kept', () => {
    expect(v(row({ last_ok_at: min(1), probe_outcome: 'no_runner' }), { token_rejected_at: min(2) })).toMatchObject({ state: 'unavailable', reason: 'token_rejected', lastOkAt: min(1).toISOString() });
  });

  it('70 min old → stale with staleAt; with the last attempt «no runner» → unavailable no_runner; over 24 h → expired', () => {
    expect(v(row({ last_ok_at: min(70), windows: [stored('five_hour', 50, min(70))] }))).toMatchObject({ state: 'stale', reason: null, staleAt: min(70).toISOString() });
    expect(v(row({ last_ok_at: min(59) })).state).toBe('ok');
    expect(v(row({ last_ok_at: min(70), probe_outcome: 'no_runner' }))).toMatchObject({ state: 'unavailable', reason: 'no_runner', lastOkAt: min(70).toISOString(), staleAt: null });
    expect(v(row({ last_ok_at: min(70), probe_outcome: 'failed' })).state).toBe('stale');
    expect(v(row({ last_ok_at: min(25 * 60) }))).toMatchObject({ state: 'unavailable', reason: 'expired' });
    // periodic probes off (0): stale still after 60 min
    expect(v(row({ last_ok_at: min(70) }), {}, 0).state).toBe('stale');
  });

  it('quiet: quietAt only when newer than the windows; the percents stay; a quiet check keeps the data fresh', () => {
    const r = row({ windows: [stored('five_hour', 40, min(90))], last_ok_at: min(90), last_quiet_at: min(5) });
    expect(v(r)).toMatchObject({ state: 'ok', quietAt: min(5).toISOString(), lastOkAt: min(90).toISOString() });
    expect(v(r).windows[0]!.utilization).toBe(40);
    expect(v(row({ last_ok_at: min(1), last_quiet_at: min(5) })).quietAt).toBeNull();
    expect(v(row({ last_quiet_at: min(5) }))).toMatchObject({ state: 'ok', quietAt: min(5).toISOString(), windows: [] });
  });

  it("fix 2026-10-29: a quiet check after a 97% window keeps the window, its percent, status and time — the level is the web's call", () => {
    const r = row({ windows: [stored('five_hour', 26, min(4)), stored('seven_day', 97, min(4), { resetsAt: '2026-11-03T02:00:00.000Z' })], last_ok_at: min(4), last_quiet_at: min(0) });
    const view = v(r);
    expect(view).toMatchObject({ state: 'ok', reason: null, quietAt: min(0).toISOString(), lastOkAt: min(4).toISOString() });
    expect(view.windows.find(x => x.type === 'seven_day')).toEqual({
      type: 'seven_day',
      utilization: 97,
      resetsAt: '2026-11-03T02:00:00.000Z',
      status: 'allowed',
      observedAt: min(4).toISOString(),
      source: 'session',
    });
  });

  it('refreshableAt only while in the future', () => {
    expect(toLimitsView(SUB, undefined, NOW, { idleSec: 1800, refreshableAt: new Date(NOW.getTime() + 20_000) }).refreshableAt).toBe(new Date(NOW.getTime() + 20_000).toISOString());
    expect(toLimitsView(SUB, undefined, NOW, { idleSec: 1800, refreshableAt: min(1) }).refreshableAt).toBeNull();
  });
});

describe('probeDue', () => {
  it('data older than the period is due; fresh data (events of a live session) is not; period 0 — never', () => {
    expect(probeDue(SUB, undefined, NOW, 1800)).toBe(true);
    expect(probeDue(SUB, row({ last_ok_at: min(31) }), NOW, 1800)).toBe(true);
    expect(probeDue(SUB, row({ last_ok_at: min(10) }), NOW, 1800)).toBe(false);
    expect(probeDue(SUB, row({ last_ok_at: min(40), last_quiet_at: min(5) }), NOW, 1800)).toBe(false);
    expect(probeDue(SUB, undefined, NOW, 0)).toBe(false);
  });

  it('exhausted until the reset: limit_resets_at or a rejected window with a future reset; due again after the reset', () => {
    const rejected = row({ last_ok_at: min(60), windows: [stored('seven_day', 100, min(60), { status: 'rejected', resetsAt: new Date(NOW.getTime() + 2 * 86_400_000).toISOString() })] });
    expect(exhausted(SUB, rejected, NOW)).toBe(true);
    expect(probeDue(SUB, rejected, NOW, 1800)).toBe(false);
    expect(probeDue(SUB, rejected, new Date(NOW.getTime() + 2 * 86_400_000 + 1000), 1800)).toBe(true);
    expect(probeDue({ ...SUB, limit_resets_at: new Date(NOW.getTime() + 60_000) }, undefined, NOW, 1800)).toBe(false);
    expect(probeDue({ ...SUB, limit_resets_at: min(1) }, undefined, NOW, 1800)).toBe(true);
  });

  it('a rejected token or a retired subscription is never probed', () => {
    expect(probeDue({ ...SUB, token_rejected_at: min(1) }, undefined, NOW, 1800)).toBe(false);
    expect(probeDue({ ...SUB, retired_at: min(1) }, undefined, NOW, 1800)).toBe(false);
  });

  it('review B1: a probe within the period holds the next one whatever its outcome; a reset after it lifts the hold', () => {
    // an `ok` that left no data (no windows, no quiet) 5 min ago: not due until the period passes
    expect(probeDue(SUB, row({ last_probe_at: min(5), probe_outcome: 'ok' }), NOW, 1800)).toBe(false);
    expect(probeDue(SUB, row({ last_probe_at: min(31), probe_outcome: 'ok' }), NOW, 1800)).toBe(true);
    // a limit without a reset time leaves nothing to wait for: the hold still applies
    expect(probeDue(SUB, row({ last_probe_at: min(5), probe_outcome: 'limit' }), NOW, 1800)).toBe(false);
    // limit_resets_at came after the last probe and is past: queued at once
    expect(probeDue({ ...SUB, limit_resets_at: min(1) }, row({ last_probe_at: min(5), probe_outcome: 'limit' }), NOW, 1800)).toBe(true);
  });

  it('review A5: a row of another token version is ignored (view not_polled, probe due)', () => {
    const old = row({ token_at: min(600), last_ok_at: min(5), windows: [stored('five_hour', 90, min(5))] });
    const sub = { ...SUB, token_updated_at: min(10) };
    expect(probeDue(sub, old, NOW, 1800)).toBe(true);
    expect(toLimitsView(sub, old, NOW, { idleSec: 1800 })).toMatchObject({ state: 'unavailable', reason: 'not_polled', windows: [] });
    expect(toLimitsView({ ...SUB, token_updated_at: min(600) }, old, NOW, { idleSec: 1800 }).state).toBe('ok');
  });

  it('backoff after failures: 30 min × 2^(n−1), at most 2 h', () => {
    expect([1, 2, 3, 4, 10].map(backoffMs)).toEqual([30, 60, 120, 120, 120].map(m => m * 60_000));
    expect(probeDue(SUB, row({ probe_failures: 2, last_probe_at: min(50) }), NOW, 1800)).toBe(false);
    expect(probeDue(SUB, row({ probe_failures: 2, last_probe_at: min(61) }), NOW, 1800)).toBe(true);
    expect(probeDue(SUB, row({ probe_failures: 5, last_probe_at: min(119) }), NOW, 1800)).toBe(false);
  });
});
