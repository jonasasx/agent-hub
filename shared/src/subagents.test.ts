import { describe, expect, it } from 'vitest';
import { effectiveStatus, sessionAlive } from './subagents.js';

describe('effectiveStatus (change subagents, design S3)', () => {
  it('running and idle of a session that is not alive are interrupted; every other state stays', () => {
    expect(effectiveStatus('running', false)).toBe('interrupted');
    expect(effectiveStatus('idle', false)).toBe('interrupted');
    expect(effectiveStatus('running', true)).toBe('running');
    expect(effectiveStatus('idle', true)).toBe('idle');
    for (const s of ['completed', 'failed', 'stopped'] as const) {
      expect(effectiveStatus(s, false)).toBe(s);
      expect(effectiveStatus(s, true)).toBe(s);
    }
  });
  it('a session is alive with a hub process or while it runs outside the hub', () => {
    expect(sessionAlive({ processAlive: true })).toBe(true);
    expect(sessionAlive({ processAlive: false, externalActive: true })).toBe(true);
    expect(sessionAlive({ processAlive: false, externalActive: false })).toBe(false);
  });
});
