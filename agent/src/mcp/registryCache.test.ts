import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RegistryCache, type RegistrySnapshot } from './registryCache.js';

describe('RegistryCache', () => {
  let root = '';
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = '';
  });
  it('atomically stores a validated snapshot without resolved secret values', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-registry-'));
    const cache = new RegistryCache(root);
    const snapshot = {
      protocol: '1.13' as const,
      revision: 2,
      generatedAt: 10,
      registryEnabled: true,
      servers: [
        {
          id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
          name: 'sample',
          enabled: true,
          transport: 'stdio' as const,
          mode: 'machine-shared' as const,
          command: 'node',
          machineScope: { allMachines: true, machineIds: [] },
          projectIds: [],
          revision: 2,
          secrets: [{ secretId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', name: 'API_KEY', state: 'set' as const }],
          env: { API_KEY: { kind: 'secret' as const, secretId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8' } },
        },
      ],
    };
    await cache.write(snapshot);
    expect(await cache.read()).toEqual(snapshot);
    const disk = await readFile(cache.file, 'utf8');
    expect(disk).not.toContain('plaintext-secret');
    expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    const withResolvedValue = {
      ...snapshot,
      servers: snapshot.servers.map(server => ({ ...server, env: { API_KEY: { kind: 'literal' as const, value: 'plaintext-secret' } } })),
    } as unknown as RegistrySnapshot;
    await expect(cache.write(withResolvedValue)).rejects.toThrow();
    expect(await readFile(cache.file, 'utf8')).toBe(disk);
  });
  it('returns null for a missing or invalid cache', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-registry-'));
    const cache = new RegistryCache(root);
    expect(await cache.read()).toBeNull();
  });
});
