import { describe, expect, it } from 'vitest';
import { notifyReason, waitingReason, waitsForUser, workingChildren, type AttentionSession } from './attention.js';

const s = (o: Partial<AttentionSession> = {}): AttentionSession => ({ status: 'waiting', unread: true, ...o });

describe('attention rule', () => {
  it('counts subagents, background tasks and child hub sessions', () => {
    expect(workingChildren(s())).toBe(0);
    expect(workingChildren(s({ subagents: { working: 2 } }))).toBe(2);
    expect(workingChildren(s({ subagents: { working: 1, hub: { working: 3 } } }))).toBe(4);
  });

  it('an offline machine waits for nobody', () => {
    expect(waitingReason(s({ status: 'permission' }), false)).toBeNull();
    expect(notifyReason(s(), false)).toBeNull();
  });

  it('a permission request waits and notifies while children work', () => {
    const p = s({ status: 'permission', unread: false, subagents: { working: 1, hub: { working: 1 } } });
    expect(waitingReason(p, true)).toBe('permission');
    expect(notifyReason(p, true)).toBe('permission');
  });

  it('an unread finished turn waits; it notifies only when no child works', () => {
    expect(notifyReason(s(), true)).toBe('turn_ended');
    for (const subagents of [{ working: 2 }, { working: 0, hub: { working: 1 } }]) {
      const busy = s({ subagents });
      expect(waitsForUser(busy, true)).toBe(true);
      expect(notifyReason(busy, true)).toBeNull();
    }
  });

  it('a read answer and a running turn do not wait', () => {
    expect(waitingReason(s({ unread: false }), true)).toBeNull();
    expect(waitingReason(s({ status: 'working' }), true)).toBeNull();
    expect(waitingReason(s({ status: 'sleeping' }), true)).toBeNull();
  });
});
