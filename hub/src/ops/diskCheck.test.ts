import { describe, expect, it } from 'vitest';
import { diskCheckPeriodMs } from './metrics.js';

describe('diskCheckPeriodMs (paas-deployment D2)', () => {
  it('the data volume is mounted: the configured period', () => {
    expect(diskCheckPeriodMs({ dataPath: '/hostdata', periodMs: 600_000, injectedStat: false, exists: () => true })).toBe(600_000);
  });

  it('a platform pod without the volume: off', () => {
    expect(diskCheckPeriodMs({ dataPath: '/hostdata', periodMs: 600_000, injectedStat: false, exists: () => false })).toBe(0);
    expect(diskCheckPeriodMs({ dataPath: '/no/such/agent-hub/volume', periodMs: 600_000, injectedStat: false })).toBe(0);
  });

  it('an injected stat (tests) counts as mounted', () => {
    expect(diskCheckPeriodMs({ dataPath: '/no/such/agent-hub/volume', periodMs: 1000, injectedStat: true })).toBe(1000);
  });
});
