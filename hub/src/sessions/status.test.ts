// Task 2.1: every transition of the D8 diagram, and nothing else.
import { describe, expect, it } from 'vitest';
import { SESSION_STATUSES, type SessionStatus } from '@agent-hub/shared';
import { effectiveIdleTimeoutMin, initialStatus, isLiveStatus, nextStatus, sleepsAt, TRANSITIONS, type SessionEvent } from './status.js';

const ALL_EVENTS: SessionEvent[] = [
  'start',
  'fork_copy',
  'discovered',
  'result',
  'permission_request',
  'permission_resolved',
  'interrupt',
  'send',
  'idle_timeout',
  'permission_timeout',
  'resume_send',
  'wake',
  'crashed',
];

// [from, event, to] — the D8 diagram plus interrupt/crash while a permission is open.
const DIAGRAM: Array<[SessionStatus, SessionEvent, SessionStatus]> = [
  ['working', 'result', 'waiting'],
  ['working', 'permission_request', 'permission'],
  ['permission', 'permission_resolved', 'working'],
  ['working', 'interrupt', 'waiting'],
  ['waiting', 'send', 'working'],
  ['waiting', 'idle_timeout', 'sleeping'],
  ['permission', 'permission_timeout', 'sleeping'],
  ['sleeping', 'resume_send', 'working'],
  ['sleeping', 'wake', 'waiting'],
  ['closed', 'resume_send', 'working'],
  ['closed', 'wake', 'waiting'],
  ['working', 'crashed', 'waiting'],
  ['permission', 'interrupt', 'waiting'],
  ['permission', 'crashed', 'waiting'],
  ['waiting', 'crashed', 'waiting'],
];

describe('session status machine (D8)', () => {
  it('initial states: start → working, fork copy → waiting, discovered → closed', () => {
    expect(initialStatus('start')).toBe('working');
    expect(initialStatus('fork_copy')).toBe('waiting');
    expect(initialStatus('discovered')).toBe('closed');
    expect(initialStatus('result')).toBeNull();
  });

  it.each(DIAGRAM)('%s --%s--> %s', (from, ev, to) => {
    expect(nextStatus(from, ev)).toBe(to);
  });

  it('rejects every pair that is not on the diagram', () => {
    const allowed = new Set(DIAGRAM.map(([f, e]) => `${f}:${e}`));
    for (const from of SESSION_STATUSES) {
      for (const ev of ALL_EVENTS) {
        if (!allowed.has(`${from}:${ev}`)) expect(nextStatus(from, ev), `${from}:${ev}`).toBeNull();
      }
    }
    const tableSize = Object.values(TRANSITIONS).reduce((n, t) => n + Object.keys(t).length, 0);
    expect(tableSize).toBe(DIAGRAM.length);
  });

  it('working never falls asleep; sleeping and closed are not live', () => {
    expect(nextStatus('working', 'idle_timeout')).toBeNull();
    expect(nextStatus('working', 'permission_timeout')).toBeNull();
    expect(isLiveStatus('working') && isLiveStatus('waiting') && isLiveStatus('permission')).toBe(true);
    expect(isLiveStatus('sleeping') || isLiveStatus('closed')).toBe(false);
  });
});

describe('idle timeout', () => {
  it('30 min by default, 2 h waiting for permission, override, 0 = never, working = never', () => {
    expect(effectiveIdleTimeoutMin('waiting', null)).toBe(30);
    expect(effectiveIdleTimeoutMin('waiting', 15)).toBe(15);
    expect(effectiveIdleTimeoutMin('permission', 15)).toBe(120);
    expect(effectiveIdleTimeoutMin('permission', 0)).toBe(0);
    expect(effectiveIdleTimeoutMin('waiting', 0)).toBe(0);
    expect(effectiveIdleTimeoutMin('working', null)).toBe(0);
  });

  it('sleepsAt counts from the latest of turn end, input and the open permission request', () => {
    const t0 = new Date('2026-10-25T10:00:00Z');
    const base = { processAlive: true, idleTimeoutMin: null, lastTurnEndAt: t0, lastInputAt: new Date(t0.getTime() - 60_000) };
    expect(sleepsAt({ ...base, status: 'waiting' })?.toISOString()).toBe('2026-10-25T10:30:00.000Z');
    const asked = new Date('2026-10-25T10:40:00Z');
    expect(sleepsAt({ ...base, status: 'permission', permissionSince: asked })?.toISOString()).toBe('2026-10-25T12:40:00.000Z');
    expect(sleepsAt({ ...base, status: 'working' })).toBeNull();
    expect(sleepsAt({ ...base, status: 'waiting', processAlive: false })).toBeNull();
    expect(sleepsAt({ ...base, status: 'waiting', idleTimeoutMin: 0 })).toBeNull();
  });

  it('children: the latest activity moves the start; a working child replaces the idle timeout with the 120 min guard', () => {
    const t0 = new Date('2026-10-25T10:00:00Z');
    const base = { status: 'waiting' as const, processAlive: true, idleTimeoutMin: null, lastTurnEndAt: t0, lastInputAt: t0 };
    const sub = new Date('2026-10-25T10:30:00Z');
    expect(sleepsAt({ ...base, lastActivityAt: sub })?.toISOString()).toBe('2026-10-25T11:00:00.000Z');
    expect(sleepsAt({ ...base, lastActivityAt: sub, workingChildren: 2 })?.toISOString()).toBe('2026-10-25T12:30:00.000Z');
    // an override longer than the guard stays; «не усыплять» stays
    expect(sleepsAt({ ...base, idleTimeoutMin: 480, workingChildren: 1 })?.toISOString()).toBe('2026-10-25T18:00:00.000Z');
    expect(sleepsAt({ ...base, idleTimeoutMin: 0, workingChildren: 1 })).toBeNull();
    // older activity does not move the start back
    expect(sleepsAt({ ...base, lastActivityAt: new Date('2026-10-25T09:00:00Z') })?.toISOString()).toBe('2026-10-25T10:30:00.000Z');
  });
});
