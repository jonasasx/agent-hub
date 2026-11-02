import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgent } from '../agent.js';
import { createLogger } from '../log.js';
import { AsyncQueue } from '../sessions/asyncQueue.js';
import { RegistryCache } from './registryCache.js';

describe('registry cache startup', () => {
  let root = '';
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = '';
  });

  it('uses a cached MCP snapshot while the hub is unavailable', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-registry-start-'));
    const stateDir = join(root, 'state');
    const cache = new RegistryCache(stateDir);
    const snapshot = {
      protocol: '1.13' as const,
      revision: 1,
      generatedAt: 1,
      registryEnabled: true,
      servers: [
        {
          id: randomUUID(),
          name: 'offline-server',
          enabled: true,
          transport: 'http' as const,
          mode: 'remote' as const,
          url: 'https://mcp.example.test/mcp',
          machineScope: { allMachines: true, machineIds: [] },
          projectIds: [],
          revision: 1,
          secrets: [],
        },
      ],
    };
    await cache.write(snapshot);
    let seenOptions: Record<string, unknown> | undefined;
    const output = new AsyncQueue<never>();
    const agent = createAgent({
      hubUrl: 'ws://127.0.0.1:1/ws/agent',
      token: 'test-token',
      vaultRoot: null,
      claudeProjectsDir: join(root, 'claude', 'projects'),
      stateDir,
      codexBin: null,
      watch: false,
      backoff: { minMs: 60_000, maxMs: 60_000 },
      log: createLogger({ level: 'error', write: () => undefined }),
      queryFn: ({ options }) => {
        seenOptions = options as Record<string, unknown>;
        return {
          [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
          initializationResult: async () => ({}),
          supportedModels: async () => [],
          close: () => output.close(),
        } as unknown as Query;
      },
    });

    try {
      agent.start();
      for (let attempt = 0; attempt < 100 && agent.client.state === 'idle'; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(agent.client.state).not.toBe('idle');
      await agent.providers.handle({
        v: 1,
        ts: Date.now(),
        id: randomUUID(),
        type: 'session.start',
        payload: {
          sessionId: randomUUID(),
          cwd: root,
          permissionMode: 'default',
          model: 'haiku',
          prompt: '',
          promptUuid: randomUUID(),
        },
      });
      expect(seenOptions?.strictMcpConfig).toBe(true);
      expect(Object.keys(seenOptions?.mcpServers as Record<string, unknown>)).toContain('offline-server');
    } finally {
      await agent.stop(100);
    }
  });
});
