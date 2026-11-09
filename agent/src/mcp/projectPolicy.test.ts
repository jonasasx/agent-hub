import { describe, expect, it } from 'vitest';
import { serversForProject } from './projectPolicy.js';
import type { RegistrySnapshot } from './registryCache.js';

const projectId = '00000000-0000-4000-8000-000000000001';
const serverA = '00000000-0000-4000-8000-000000000002';
const serverB = '00000000-0000-4000-8000-000000000003';
const serverC = '00000000-0000-4000-8000-000000000005';

function snapshot(): RegistrySnapshot {
  return {
    protocol: '1.13',
    revision: 1,
    generatedAt: 1,
    registryEnabled: true,
    servers: [
      {
        id: serverA,
        name: 'disabled',
        enabled: true,
        transport: 'stdio',
        mode: 'per-session',
        command: 'node',
        machineScope: { allMachines: true, machineIds: [] },
        projectIds: [],
        revision: 1,
        secrets: [],
      },
      {
        id: serverB,
        name: 'global',
        enabled: true,
        transport: 'stdio',
        mode: 'per-session',
        command: 'node',
        machineScope: { allMachines: true, machineIds: [] },
        projectIds: [],
        revision: 1,
        secrets: [],
      },
      {
        id: serverC,
        name: 'project-only',
        enabled: true,
        transport: 'stdio',
        mode: 'per-session',
        command: 'node',
        machineScope: { allMachines: true, machineIds: [] },
        projectIds: [projectId],
        revision: 1,
        secrets: [],
      },
    ],
    projectOverrides: [{ projectId, serverId: serverA, enabled: false }],
  };
}

describe('MCP project overrides', () => {
  it('filters only exact disabled project/server pairs for a project session', () => {
    const registry = snapshot();
    expect(serversForProject(registry, projectId).map(server => server.id)).toEqual([serverB, serverC]);
    expect(serversForProject(registry, undefined).map(server => server.id)).toEqual([serverA, serverB]);
    expect(serversForProject(registry, '00000000-0000-4000-8000-000000000004').map(server => server.id)).toEqual([serverA, serverB]);
  });

  it('gives a server bound to projects only to sessions of those projects', () => {
    const registry = snapshot();
    expect(serversForProject(registry, projectId).map(server => server.name)).toContain('project-only');
    expect(serversForProject(registry, undefined).map(server => server.name)).not.toContain('project-only');
    expect(serversForProject(registry, '00000000-0000-4000-8000-000000000004').map(server => server.name)).not.toContain('project-only');
  });
});
