// Test data for desktop core (shapes of shared SessionView / RunnerView).
import type { RunnerView, SessionView } from '@agent-hub/shared';

export function runner(over: Partial<RunnerView> = {}): RunnerView {
  return {
    id: 'x1',
    name: 'X1',
    kind: 'machine',
    os: 'windows',
    online: true,
    lastSeenAt: null,
    agentVersion: null,
    claudeVersion: null,
    protocolVersion: null,
    incompatible: false,
    ...over,
  };
}

/** x1 online, hp offline (as web/src/test/factories RUNNERS). */
export const RUNNERS = new Map([
  ['x1', runner()],
  ['hp', runner({ id: 'hp', name: 'HP', online: false })],
]);

let n = 0;
export function session(over: Partial<SessionView> = {}): SessionView {
  n++;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    title: 'Ревизия DNS',
    runnerId: 'x1',
    cwd: null,
    status: 'working',
    unread: false,
    processAlive: true,
    source: 'hub',
    originSource: 'hub',
    isHubManaged: true,
    isCron: false,
    remoteControl: false,
    readOnlyReason: null,
    project: { id: null, title: 'Сеть', colorKey: 'none', path: '' },
    projectSource: 'auto',
    projectEvidence: null,
    forkOf: null,
    permissionMode: 'bypassPermissions',
    model: null,
    idleTimeoutMin: null,
    effectiveIdleTimeoutMin: 30,
    sleepsAt: null,
    lastInputAt: null,
    lastTurnEndAt: null,
    sleptAt: null,
    lastEventAt: null,
    lastExternalWriteAt: null,
    createdAt: '2026-10-26T10:00:00Z',
    ...over,
  };
}
