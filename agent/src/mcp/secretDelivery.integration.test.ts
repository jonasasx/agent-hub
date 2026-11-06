import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { envelope } from '@agent-hub/shared';
import { createAgent } from '../agent.js';
import { createLogger } from '../log.js';
import { RegistryCache } from './registryCache.js';

describe('MCP secret delivery over the agent websocket', () => {
  let root = '';
  let wss: WebSocketServer | undefined;
  afterEach(async () => {
    if (wss) await new Promise<void>(resolve => wss!.close(() => resolve()));
    wss = undefined;
    if (root) await rm(root, { recursive: true, force: true });
    root = '';
  });

  it('keeps delivered values in memory and out of logs, argv, disk cache, and replies', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-secret-delivery-'));
    const probe = createServer();
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address();
    if (!address || typeof address === 'string') throw new Error('failed to reserve a test port');
    await new Promise<void>(resolve => probe.close(() => resolve()));

    wss = new WebSocketServer({ port: address.port, host: '127.0.0.1' });
    await new Promise<void>(resolve => wss!.once('listening', resolve));
    const frames: Array<Record<string, unknown>> = [];
    const machineId = randomUUID();
    let socket: WebSocket | undefined;
    wss.on('connection', ws => {
      socket = ws;
      ws.on('message', data => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        frames.push(message);
        if (message.type === 'hello') {
          ws.send(JSON.stringify(envelope('welcome', { runnerId: machineId, protocol: '1.13', cursors: [] })));
        }
      });
    });

    const logs: string[] = [];
    const stateDir = join(root, 'agent-hub');
    const cache = new RegistryCache(stateDir);
    let cacheWriteStarted!: () => void;
    const writeStarted = new Promise<void>(resolve => {
      cacheWriteStarted = resolve;
    });
    let releaseCacheWrite!: () => void;
    const cacheWriteGate = new Promise<void>(resolve => {
      releaseCacheWrite = resolve;
    });
    let cacheWriteFinished!: () => void;
    const cacheWriteComplete = new Promise<void>(resolve => {
      cacheWriteFinished = resolve;
    });
    let secondCacheWriteStarted = false;
    let secondCacheWriteFinished!: () => void;
    const secondCacheWriteComplete = new Promise<void>(resolve => {
      secondCacheWriteFinished = resolve;
    });
    const originalWrite = cache.write.bind(cache);
    cache.write = async snapshot => {
      if (snapshot.revision === 1) {
        cacheWriteStarted();
        await cacheWriteGate;
      } else {
        secondCacheWriteStarted = true;
      }
      await originalWrite(snapshot);
      if (snapshot.revision === 1) cacheWriteFinished();
      else secondCacheWriteFinished();
    };
    const agent = createAgent({
      hubUrl: `ws://127.0.0.1:${address.port}/ws/agent`,
      token: 'test-token',
      vaultRoot: null,
      claudeProjectsDir: join(root, 'claude', 'projects'),
      stateDir,
      registryCache: cache,
      codexBin: null,
      watch: false,
      log: createLogger({ level: 'debug', write: line => logs.push(line) }),
    });

    const sendCommand = (type: string, payload: unknown): string => {
      const id = randomUUID();
      socket!.send(JSON.stringify(envelope(type, payload, { id })));
      return id;
    };
    const waitForReply = async (id: string): Promise<Record<string, unknown>> => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const result = frames.find(message => message.re === id && (message.type === 'cmd.ok' || message.type === 'cmd.error'));
        if (result) return result;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error(`agent command reply timed out: ${JSON.stringify(frames.map(message => ({ type: message.type, re: message.re, code: message.code })))}; logs=${logs.join(' | ')}`);
    };

    try {
      agent.start();
      for (let attempt = 0; attempt < 200 && !socket; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(socket).toBeDefined();
      const serverId = randomUUID();
      const secretId = randomUUID();
      const sessionId = randomUUID();
      const secret = `memory-only-${randomUUID()}`;
      const snapshot = {
        protocol: '1.13' as const,
        revision: 1,
        generatedAt: 1,
        registryEnabled: true,
        servers: [
          {
            id: serverId,
            name: 'secret-fixture',
            enabled: true,
            transport: 'stdio' as const,
            mode: 'per-session' as const,
            command: process.execPath,
            args: [
              '-e',
              [
                "process.stdin.on('data', data => {",
                '  const request = JSON.parse(data.toString());',
                '  process.stderr.write(process.env.API_TOKEN);',
                '  const result = { envPresent: Boolean(process.env.API_TOKEN), argvContainsSecret: process.argv.includes(process.env.API_TOKEN) };',
                '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");',
                '});',
              ].join(' '),
            ],
            env: { API_TOKEN: { kind: 'secret' as const, secretId } },
            secrets: [{ secretId, name: 'API_TOKEN', state: 'set' as const }],
            machineScope: { allMachines: true, machineIds: [] },
            projectIds: [],
            revision: 1,
          },
        ],
      };

      const syncId = sendCommand('mcp.registry.sync', snapshot);
      await writeStarted;
      const deliveryId = sendCommand('mcp.secrets.deliver', {
        serverId,
        machineId,
        revision: 1,
        secrets: [{ name: 'API_TOKEN', value: secret }],
      });
      const bearerToken = randomUUID() + randomUUID();
      const startId = sendCommand('mcp.gateway.start', { serverId, revision: 1, sessionId, bearerToken });
      expect(await waitForReply(syncId)).toMatchObject({ type: 'cmd.ok' });
      const deliveryReply = await waitForReply(deliveryId);
      expect(JSON.stringify(deliveryReply)).not.toContain(secret);
      expect(deliveryReply).toMatchObject({ type: 'cmd.ok', payload: { result: { delivered: true } } });
      const startReply = await waitForReply(startId);
      const endpoint = (startReply.payload as { result: { endpoint: string } }).result.endpoint;
      const nextSyncId = sendCommand('mcp.registry.sync', { ...snapshot, revision: 2 });
      expect(await waitForReply(nextSyncId)).toMatchObject({ type: 'cmd.ok' });
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(secondCacheWriteStarted).toBe(false);
      releaseCacheWrite();
      await cacheWriteComplete;
      await secondCacheWriteComplete;
      const response = await fetch(`${endpoint}?server=${serverId}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearerToken}`,
          'x-agent-session': sessionId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
      const protocolReply = await response.text();
      expect(protocolReply).toContain('"envPresent":true');
      expect(protocolReply).toContain('"argvContainsSecret":false');
      expect(protocolReply).not.toContain(secret);

      const cache = await readFile(join(stateDir, 'mcp-registry.json'), 'utf8');
      expect(cache).not.toContain(secret);
      expect(JSON.parse(cache)).toMatchObject({ revision: 2 });
      expect(JSON.stringify(frames)).not.toContain(secret);
      expect(logs.join('\n')).not.toContain(secret);
      expect(logs.join('\n')).toContain('[redacted]');
    } finally {
      releaseCacheWrite();
      await agent.stop(100);
    }
  }, 30_000);

  it('clears buffered commands when the hub disconnects before welcome', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-prewelcome-disconnect-'));
    const probe = createServer();
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address();
    if (!address || typeof address === 'string') throw new Error('failed to reserve a test port');
    await new Promise<void>(resolve => probe.close(() => resolve()));

    wss = new WebSocketServer({ port: address.port, host: '127.0.0.1' });
    await new Promise<void>(resolve => wss!.once('listening', resolve));
    let firstSocket: WebSocket | undefined;
    let reconnectWelcome!: () => void;
    const welcomedAgain = new Promise<void>(resolve => {
      reconnectWelcome = resolve;
    });
    const reconnectFrames: Array<Record<string, unknown>> = [];
    let connections = 0;
    wss.on('connection', ws => {
      connections += 1;
      if (connections === 1) {
        firstSocket = ws;
        ws.on('message', () => undefined);
        return;
      }
      ws.on('message', data => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        reconnectFrames.push(message);
        if (message.type === 'hello') {
          ws.send(JSON.stringify(envelope('welcome', { runnerId: randomUUID(), protocol: '1.13', cursors: [] })));
          reconnectWelcome();
        }
      });
    });

    const cache = new RegistryCache(join(root, 'agent-hub'));
    let cacheWrites = 0;
    const write = cache.write.bind(cache);
    cache.write = async snapshot => {
      cacheWrites += 1;
      await write(snapshot);
    };
    let agentWelcome!: () => void;
    const agentWelcomed = new Promise<void>(resolve => {
      agentWelcome = resolve;
    });
    const agent = createAgent({
      hubUrl: `ws://127.0.0.1:${address.port}/ws/agent`,
      token: 'test-token',
      vaultRoot: null,
      claudeProjectsDir: join(root, 'claude', 'projects'),
      stateDir: join(root, 'agent-hub'),
      registryCache: cache,
      codexBin: null,
      watch: false,
      backoff: { minMs: 10, maxMs: 10 },
      onWelcome: agentWelcome,
      log: createLogger({ level: 'error', write: () => undefined }),
    });

    try {
      agent.start();
      for (let attempt = 0; attempt < 200 && !firstSocket; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(firstSocket).toBeDefined();
      const commandId = randomUUID();
      firstSocket!.send(JSON.stringify(envelope('mcp.registry.sync', { protocol: '1.13', revision: 1, generatedAt: 1, registryEnabled: true, servers: [] }, { id: commandId })));
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(cacheWrites).toBe(0);
      firstSocket!.close();
      await welcomedAgain;
      await agentWelcomed;
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(cacheWrites).toBe(0);
      expect(reconnectFrames.some(frame => frame.re === commandId)).toBe(false);
    } finally {
      await agent.stop(100);
    }
  }, 30_000);
});
