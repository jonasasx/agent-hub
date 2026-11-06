import { describe, expect, it } from 'vitest';
import type { RunnerView } from '../../api/types';
import { agentMark, formatLastSeen, runnerStatusText, runnerTooltip } from './runnerInfo';

const NOW = new Date(2026, 9, 25, 12, 0);
const today641 = new Date(2026, 9, 25, 6, 41).toISOString();
const yesterday = new Date(2026, 9, 24, 23, 5).toISOString();

const base: RunnerView = {
  id: 'x1',
  name: 'X1',
  kind: 'machine',
  os: 'Windows 11 Pro',
  online: true,
  lastSeenAt: today641,
  agentVersion: '0.1.0',
  claudeVersion: '2.1.310',
  protocolVersion: '1.0',
  incompatible: false,
  vaultRoot: null,
  homeDir: null,
};

describe('formatLastSeen', () => {
  it('shows time for today and date + time for earlier days', () => {
    expect(formatLastSeen(today641, NOW)).toBe('06:41');
    expect(formatLastSeen(yesterday, NOW)).toBe('24.10 23:05');
    expect(formatLastSeen(null, NOW)).toBeNull();
  });
});

describe('runnerTooltip and runnerStatusText', () => {
  it('online machine: OS and agent version', () => {
    expect(runnerTooltip(base, NOW)).toBe('Windows 11 Pro · агент 0.1.0');
    expect(runnerStatusText(base)).toBe('в сети');
  });

  it('offline machine: the last connection time', () => {
    const hp = { ...base, online: false };
    expect(runnerTooltip(hp, NOW)).toBe('Windows 11 Pro · агент 0.1.0 · не в сети с 06:41');
    expect(runnerTooltip({ ...hp, os: 'Ubuntu 24.04.1 LTS', lastSeenAt: yesterday }, NOW)).toBe('Ubuntu 24.04.1 LTS · агент 0.1.0 · не в сети с 24.10 23:05');
    expect(runnerStatusText(hp)).toBe('не в сети');
  });

  it('an incompatible agent is named so', () => {
    const r: RunnerView = { ...base, online: false, incompatible: true, protocolVersion: '2.0' };
    expect(runnerTooltip(r, NOW)).toBe('Windows 11 Pro · агент 0.1.0 · несовместимая версия агента · не в сети с 06:41');
    expect(runnerStatusText(r)).toBe('несовместимая версия агента');
  });

  it('a machine that never connected says so', () => {
    expect(runnerTooltip({ ...base, online: false, lastSeenAt: null, os: null, agentVersion: null }, NOW)).toBe('ОС неизвестна · ещё не подключалась');
  });
});

// change client-versions: design D8
describe('agentMark', () => {
  const hp: RunnerView = { ...base, id: 'hp', name: 'HP', agentVersion: '0.1.2', outdated: true };

  it('outdated agent online', () => {
    expect(agentMark(hp)).toBe('outdated');
  });

  it('a running update shows «updating»', () => {
    expect(agentMark({ ...hp, update: { version: '0.2.0', status: 'installing', error: null, at: '' } })).toBe('updating');
  });

  it('a failed update leaves the agent outdated', () => {
    expect(agentMark({ ...hp, update: { version: '0.2.0', status: 'failed', error: 'sha_mismatch', at: '' } })).toBe('outdated');
  });

  it('a current, offline or unknown agent gets no mark', () => {
    expect(agentMark({ ...base, agentVersion: '0.2.0', outdated: false })).toBeNull();
    expect(agentMark({ ...hp, online: false })).toBeNull();
    expect(agentMark({ ...base, agentVersion: null, outdated: undefined })).toBeNull();
  });
});
