import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createServer, request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../log.js';
import { McpGateway } from './gateway.js';
import { McpRegistryQueue } from './registryQueue.js';

function fakeProcessEntry() {
  return {
    child: { stdin: { end: vi.fn() }, kill: vi.fn() },
    started: Promise.resolve(),
    exited: false,
    exitCode: null,
    buffers: Buffer.alloc(0),
    pending: new Map<string, never>(),
    sessions: new Map<string, string>(),
    managedSessions: new Set<string>(),
    streams: new Map<string, never>(),
    stopping: false,
    timer: undefined as NodeJS.Timeout | undefined,
    healthyTimer: undefined as NodeJS.Timeout | undefined,
  };
}

describe('McpGateway', () => {
  let gateway: McpGateway | undefined;
  let remoteFixture: ReturnType<typeof createServer> | undefined;
  afterEach(async () => {
    vi.unstubAllGlobals();
    await gateway?.stop();
    gateway = undefined;
    if (remoteFixture) await new Promise<void>(resolve => remoteFixture!.close(() => resolve()));
    remoteFixture = undefined;
  });

  it('starts a stdio process on demand and stops it after the last session idles', async () => {
    const statuses: Array<{ status?: string }> = [];
    gateway = new McpGateway(createLogger({ level: 'error', write: () => undefined }), status => statuses.push(status as { status?: string }), {
      maxProcesses: 8,
      maxSessions: 64,
      maxPending: 256,
      maxPerServerSessions: 4,
      idleMs: 20,
      backoffBaseMs: 10,
      backoffMaxMs: 30,
      backoffWindowMs: 100,
      maxRestarts: 5,
      healthyResetMs: 100,
    });
    await gateway.start();
    const serverId = randomUUID();
    gateway.setRegistry({
      protocol: '1.13',
      revision: 1,
      generatedAt: 1,
      registryEnabled: true,
      servers: [
        {
          id: serverId,
          name: 'lazy',
          enabled: true,
          transport: 'stdio',
          mode: 'machine-shared',
          command: process.execPath,
          args: [
            '-e',
            "process.stdin.on('data', d => { const q = JSON.parse(d.toString()); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: q.id, result: { pid: process.pid } }) + '\\n'); });",
          ],
          machineScope: { allMachines: true, machineIds: [] },
          projectIds: [],
          revision: 1,
          secrets: [],
        },
      ],
    });
    expect(statuses).toEqual([]);
    const sessionId = randomUUID();
    const bearer = gateway.authorize(serverId, sessionId);
    const response = await fetch(`${gateway.url}?server=${serverId}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'x-agent-session': sessionId, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(response.status).toBe(200);
    expect(statuses.map(status => status.status)).toContain('ready');
    gateway.revoke(serverId, sessionId);
    await delay(50);
    expect(statuses.map(status => status.status)).toContain('stopped');
  });

  it('does not let an old idle callback delete a replacement process entry', () => {
    const statuses: Array<{ status?: string }> = [];
    gateway = new McpGateway(createLogger({ level: 'error', write: () => undefined }), status => statuses.push(status as { status?: string }));
    const serverId = randomUUID();
    const sessionId = randomUUID();
    const key = `${serverId}:1`;
    const oldEntry = fakeProcessEntry();
    const replacement = fakeProcessEntry();
    const internals = gateway as unknown as {
      entries: Map<string, ReturnType<typeof fakeProcessEntry>>;
      expireIdle: (key: string, serverId: string, entry: ReturnType<typeof fakeProcessEntry>) => void;
    };
    internals.entries.set(key, oldEntry);
    gateway.revoke(serverId, sessionId);
    expect(oldEntry.timer).toBeDefined();
    internals.entries.set(key, replacement);

    internals.expireIdle(key, serverId, oldEntry);

    expect(internals.entries.get(key)).toBe(replacement);
    expect(statuses).not.toContainEqual(expect.objectContaining({ status: 'stopped' }));
    if (oldEntry.timer) clearTimeout(oldEntry.timer);
    oldEntry.timer = undefined;
  });

  it('clears idle timers and preserves managed sessions when a shared server is reused', async () => {
    const statuses: Array<{ status?: string }> = [];
    gateway = new McpGateway(createLogger({ level: 'error', write: () => undefined }), status => statuses.push(status as { status?: string }));
    const serverId = randomUUID();
    const firstSession = randomUUID();
    const secondSession = randomUUID();
    const entry = fakeProcessEntry();
    entry.managedSessions.add(firstSession);
    const internals = gateway as unknown as {
      entries: Map<string, ReturnType<typeof fakeProcessEntry>>;
      process: () => Promise<ReturnType<typeof fakeProcessEntry>>;
      expireIdle: (key: string, serverId: string, entry: ReturnType<typeof fakeProcessEntry>) => void;
    };
    const key = `${serverId}:1`;
    internals.entries.set(key, entry);
    gateway.revoke(serverId, firstSession);
    expect(entry.timer).toBeDefined();
    internals.process = async () => entry;
    gateway.setRegistry({
      protocol: '1.13',
      revision: 1,
      generatedAt: 1,
      registryEnabled: true,
      servers: [
        {
          id: serverId,
          name: 'reused-shared-process',
          enabled: true,
          transport: 'stdio',
          mode: 'machine-shared',
          command: process.execPath,
          args: [],
          machineScope: { allMachines: true, machineIds: [] },
          projectIds: [],
          revision: 1,
          secrets: [],
        },
      ],
    });
    await gateway.startManaged(serverId, secondSession, randomUUID() + randomUUID());
    expect(entry.timer).toBeUndefined();
    expect(entry.managedSessions.has(secondSession)).toBe(true);
    internals.expireIdle(key, serverId, entry);
    expect(internals.entries.get(key)).toBe(entry);
    expect(statuses).not.toContainEqual(expect.objectContaining({ status: 'stopped' }));
  });

  it('restores a previous managed bearer after a later start times out', async () => {
    const statuses: Array<{ status?: string }> = [];
    gateway = new McpGateway(createLogger({ level: 'error', write: () => undefined }), status => statuses.push(status as { status?: string }));
    const serverId = randomUUID();
    const sessionId = randomUUID();
    const entry = fakeProcessEntry();
    const internals = gateway as unknown as {
      entries: Map<string, ReturnType<typeof fakeProcessEntry>>;
      process: () => Promise<ReturnType<typeof fakeProcessEntry>>;
    };
    internals.entries.set(`${serverId}:1`, entry);
    internals.process = async () => entry;
    gateway.setRegistry({
      protocol: '1.13',
      revision: 1,
      generatedAt: 1,
      registryEnabled: true,
      servers: [
        {
          id: serverId,
          name: 'previous-bearer',
          enabled: true,
          transport: 'stdio',
          mode: 'machine-shared',
          command: process.execPath,
          args: [],
          machineScope: { allMachines: true, machineIds: [] },
          projectIds: [],
          revision: 1,
          secrets: [],
        },
      ],
    });
    const previousBearer = randomUUID() + randomUUID();
    const timedOutBearer = randomUUID() + randomUUID();
    await gateway.startManaged(serverId, sessionId, previousBearer);
    await gateway.startManaged(serverId, sessionId, timedOutBearer);

    gateway.stopTimedOutStart(serverId, sessionId, 1, timedOutBearer, previousBearer);

    expect(gateway.managedBearer(serverId, sessionId)).toBe(previousBearer);
    expect(entry.managedSessions.has(sessionId)).toBe(true);
    expect(statuses).not.toContainEqual(expect.objectContaining({ status: 'stopped' }));
  });

  it('buffers an early secret delivery and never launches a process without required env', async () => {
    const statuses: Array<{ status?: string }> = [];
    gateway = new McpGateway(createLogger({ level: 'error', write: () => undefined }), status => statuses.push(status as { status?: string }));
    await gateway.start();
    const serverId = randomUUID();
    const secretId = randomUUID();
    const sessionId = randomUUID();
    const secret = `delivery-race-${randomUUID()}`;
    const cfg = {
      id: serverId,
      name: 'secret-race',
      enabled: true,
      transport: 'stdio' as const,
      mode: 'machine-shared' as const,
      command: process.execPath,
      args: [
        '-e',
        [
          "process.stdin.on('data', d => {",
          '  const q = JSON.parse(d.toString());',
          '  const result = { envAvailable: Boolean(process.env.API_TOKEN) };',
          "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }) + '\\n');",
          '});',
        ].join(' '),
      ],
      env: { API_TOKEN: { kind: 'secret' as const, secretId } },
      secrets: [{ secretId, name: 'API_TOKEN', state: 'set' as const }],
      machineScope: { allMachines: true, machineIds: [] },
      projectIds: [],
      revision: 7,
    };
    gateway.setRegistry({ protocol: '1.13', revision: 6, generatedAt: 1, registryEnabled: true, servers: [] });
    expect(gateway.setSecretDelivery(serverId, 7, [{ name: 'API_TOKEN', value: secret }])).toBe(true);
    gateway.setRegistry({ protocol: '1.13', revision: 7, generatedAt: 2, registryEnabled: true, servers: [cfg] });
    const bearer = gateway.authorize(serverId, sessionId);
    const call = () =>
      fetch(`${gateway!.url}?server=${serverId}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'x-agent-session': sessionId, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
    const response = await call();
    expect(response.status).toBe(200);
    const responseBody = await response.text();
    expect(responseBody).toContain('"envAvailable":true');
    expect(responseBody).not.toContain(secret);
    expect(statuses.map(status => status.status)).toContain('ready');
  });

  it('drops pending secrets when the registry is disabled', async () => {
    gateway = new McpGateway(createLogger({ level: 'error', write: () => undefined }));
    await gateway.start();
    const serverId = randomUUID();
    expect(gateway.setSecretDelivery(serverId, 1, [{ name: 'TOKEN', value: 'secret-value' }])).toBe(true);
    gateway.setRegistry({ protocol: '1.13', revision: 1, generatedAt: 1, registryEnabled: false, servers: [] });
    expect(gateway.setSecretDelivery(serverId, 1, [{ name: 'TOKEN', value: 'late-value' }])).toBe(false);
  });

  it('expires buffered secret deliveries after one minute', async () => {
    const logs: string[] = [];
    gateway = new McpGateway(createLogger({ level: 'warn', write: line => logs.push(line) }));
    await gateway.start();
    vi.useFakeTimers();
    try {
      const serverId = randomUUID();
      const secretId = randomUUID();
      expect(gateway.setSecretDelivery(serverId, 1, [{ name: 'TOKEN', value: 'expired-value' }])).toBe(true);
      vi.advanceTimersByTime(60_001);
      expect(logs.join('\n')).toContain('MCP secret delivery expired before registry sync');
      expect(logs.join('\n')).not.toContain('expired-value');
      const cfg = {
        id: serverId,
        name: 'expired',
        enabled: true,
        transport: 'stdio' as const,
        mode: 'machine-shared' as const,
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        env: { TOKEN: { kind: 'secret' as const, secretId } },
        secrets: [{ secretId, name: 'TOKEN', state: 'set' as const }],
        machineScope: { allMachines: true, machineIds: [] },
        projectIds: [],
        revision: 1,
      };
      gateway.setRegistry({ protocol: '1.13', revision: 1, generatedAt: 1, registryEnabled: true, servers: [cfg] });
      const sessionId = randomUUID();
      const bearer = gateway.authorize(serverId, sessionId);
      const response = await fetch(`${gateway.url}?server=${serverId}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'x-agent-session': sessionId, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
      expect(response.status).toBe(503);
      expect(response.headers.get('content-type')).toContain('text/plain');
      expect(await response.text()).toContain('MCP server expired needs secret');
    } finally {
      vi.useRealTimers();
    }
  });

  it('validates a candidate without replacing live config or delivered secrets', async () => {
    gateway = new McpGateway(createLogger({ level: 'error', write: () => undefined }));
    await gateway.start();
    const serverId = randomUUID();
    const liveSecret = `live-${randomUUID()}`;
    const candidateSecret = `candidate-${randomUUID()}`;
    const secretId = randomUUID();
    const script = [
      "process.stdin.on('data', d => {",
      '  const q = JSON.parse(d.toString());',
      "  const result = q.method === 'tools/list' ? { tools: [] } : { marker: process.env.API_TOKEN };",
      "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }) + '\\n');",
      '});',
    ].join(' ');
    const server = {
      id: serverId,
      name: 'live-candidate',
      enabled: true,
      transport: 'stdio' as const,
      mode: 'machine-shared' as const,
      command: process.execPath,
      args: ['-e', script],
      env: { API_TOKEN: { kind: 'secret' as const, secretId } },
      secrets: [{ secretId, name: 'API_TOKEN', state: 'set' as const }],
      machineScope: { allMachines: true, machineIds: [] },
      projectIds: [],
      revision: 4,
    };
    gateway.setRegistry({ protocol: '1.13', revision: 4, generatedAt: 1, registryEnabled: true, servers: [server] });
    expect(gateway.setSecretDelivery(serverId, 4, [{ name: 'API_TOKEN', value: liveSecret }])).toBe(true);
    const sessionId = randomUUID();
    const bearer = gateway.authorize(serverId, sessionId);
    const callLive = () =>
      fetch(`${gateway!.url}?server=${serverId}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'x-agent-session': sessionId, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'custom/live', params: {} }),
      });
    const before = await callLive();
    const beforeBody = (await before.json()) as { result: { marker?: string } };
    expect(beforeBody.result.marker).toBe(liveSecret);
    const result = await gateway.validate({
      draftId: randomUUID(),
      revision: 4,
      machineId: randomUUID(),
      server: { ...server, id: serverId },
      secretDelivery: { serverId, revision: 4, machineId: randomUUID(), secrets: [{ name: 'API_TOKEN', value: candidateSecret }] },
    });
    expect(result.status).toBe('checked');
    expect(result.error).toBeUndefined();
    const after = await callLive();
    const afterBody = (await after.json()) as { result: { marker?: string } };
    expect(afterBody.result.marker).toBe(liveSecret);
    expect(liveSecret).not.toBe(candidateSecret);
  });

  it('stops the revision-scoped validation process and releases its process slot', async () => {
    gateway = new McpGateway(createLogger({ level: 'error', write: () => undefined }), undefined, {
      maxProcesses: 1,
      maxSessions: 8,
      maxPending: 8,
      maxPerServerSessions: 2,
      idleMs: 60_000,
      backoffBaseMs: 10,
      backoffMaxMs: 100,
      backoffWindowMs: 1000,
      maxRestarts: 2,
      healthyResetMs: 1000,
    });
    await gateway.start();
    const serverId = randomUUID();
    const script = [
      "process.stdin.on('data', d => {",
      '  const q = JSON.parse(d.toString());',
      "  const result = q.method === 'tools/list' ? { tools: [] } : {};",
      "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }) + '\\n');",
      '});',
    ].join(' ');
    const server = {
      id: serverId,
      name: 'validation-slot',
      enabled: true,
      transport: 'stdio' as const,
      mode: 'machine-shared' as const,
      command: process.execPath,
      args: ['-e', script],
      machineScope: { allMachines: true, machineIds: [] },
      projectIds: [],
      revision: 1,
      secrets: [],
    };
    const validation = await gateway.validate({
      draftId: randomUUID(),
      revision: 1,
      machineId: randomUUID(),
      server,
    });
    expect(validation.status).toBe('checked');
    gateway.setRegistry({ protocol: '1.13', revision: 1, generatedAt: 1, registryEnabled: true, servers: [server] });
    const sessionId = randomUUID();
    const bearer = gateway.authorize(serverId, sessionId);
    const response = await fetch(`${gateway.url}?server=${serverId}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'x-agent-session': sessionId, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(response.status).toBe(200);
  });

  it('reports needs-secret and refuses process launch until delivery arrives', async () => {
    const statuses: Array<{ status?: string }> = [];
    gateway = new McpGateway(createLogger({ level: 'error', write: () => undefined }), status => statuses.push(status as { status?: string }));
    await gateway.start();
    const serverId = randomUUID();
    const secretId = randomUUID();
    const sessionId = randomUUID();
    const cfg = {
      id: serverId,
      name: 'secret-required',
      enabled: true,
      transport: 'stdio' as const,
      mode: 'machine-shared' as const,
      command: process.execPath,
      args: [
        '-e',
        [
          "process.stdin.on('data', d => {",
          '  const q = JSON.parse(d.toString());',
          '  const result = { envAvailable: Boolean(process.env.API_TOKEN) };',
          "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }) + '\\n');",
          '});',
        ].join(' '),
      ],
      env: { API_TOKEN: { kind: 'secret' as const, secretId } },
      secrets: [{ secretId, name: 'API_TOKEN', state: 'set' as const }],
      machineScope: { allMachines: true, machineIds: [] },
      projectIds: [],
      revision: 3,
    };
    gateway.setRegistry({ protocol: '1.13', revision: 3, generatedAt: 1, registryEnabled: true, servers: [cfg] });
    const bearer = gateway.authorize(serverId, sessionId);
    const call = () =>
      fetch(`${gateway!.url}?server=${serverId}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'x-agent-session': sessionId, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
    const missing = await call();
    expect(missing.status).toBe(503);
    expect(missing.headers.get('content-type')).toContain('text/plain');
    expect(await missing.text()).toContain('MCP server secret-required needs secret');
    expect(statuses.map(status => status.status)).toContain('needs-secret');
    expect(gateway.setSecretDelivery(serverId, 3, [{ name: 'API_TOKEN', value: 'delivered-later' }])).toBe(true);
    const ready = await call();
    expect(ready.status).toBe(200);
    expect(await ready.text()).toContain('"envAvailable":true');
  });

  it('rejects a managed start when its registry revision changes during startup', async () => {
    const statuses: Array<{ status?: string; revision?: number }> = [];
    gateway = new McpGateway(createLogger({ level: 'error', write: () => undefined }), status => statuses.push(status as { status?: string; revision?: number }));
    await gateway.start();
    const serverId = randomUUID();
    const sessionId = randomUUID();
    const server = {
      id: serverId,
      name: 'slow-start',
      enabled: true,
      transport: 'stdio' as const,
      mode: 'machine-shared' as const,
      command: process.execPath,
      args: [],
      machineScope: { allMachines: true, machineIds: [] },
      projectIds: [],
      revision: 1,
      secrets: [],
    };
    gateway.setRegistry({ protocol: '1.13', revision: 1, generatedAt: 1, registryEnabled: true, servers: [server] });
    let markProcessStarted!: () => void;
    const processStarted = new Promise<void>(resolve => {
      markProcessStarted = resolve;
    });
    let releaseProcess!: () => void;
    const processGate = new Promise<void>(resolve => {
      releaseProcess = resolve;
    });
    const internals = gateway as unknown as { process: (config: unknown, session: string) => Promise<unknown> };
    internals.process = async () => {
      markProcessStarted();
      await processGate;
      return undefined;
    };
    const bearer = randomUUID() + randomUUID();
    const start = gateway.startManaged(serverId, sessionId, bearer);
    await processStarted;
    gateway.setRegistry({
      protocol: '1.13',
      revision: 2,
      generatedAt: 2,
      registryEnabled: true,
      servers: [{ ...server, revision: 2 }],
    });
    releaseProcess();
    await expect(start).rejects.toThrow('MCP server configuration changed while starting');

    const response = await fetch(`${gateway.url}?server=${serverId}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'x-agent-session': sessionId, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(response.status).toBe(401);
    expect(statuses).toContainEqual(expect.objectContaining({ status: 'stopped', revision: 1 }));
  });

  it.each([false, true])('does not install a token after in-flight session revocation (%s)', async revokeAll => {
    gateway = new McpGateway(createLogger({ level: 'error', write: () => undefined }));
    await gateway.start();
    const serverId = randomUUID();
    const sessionId = randomUUID();
    const bearer = randomUUID() + randomUUID();
    const server = {
      id: serverId,
      name: 'revoked-start',
      enabled: true,
      transport: 'stdio' as const,
      mode: 'machine-shared' as const,
      command: process.execPath,
      args: [],
      machineScope: { allMachines: true, machineIds: [] },
      projectIds: [],
      revision: 1,
      secrets: [],
    };
    gateway.setRegistry({ protocol: '1.13', revision: 1, generatedAt: 1, registryEnabled: true, servers: [server] });
    let markProcessStarted!: () => void;
    const processStarted = new Promise<void>(resolve => {
      markProcessStarted = resolve;
    });
    let releaseProcess!: () => void;
    const processGate = new Promise<void>(resolve => {
      releaseProcess = resolve;
    });
    const internals = gateway as unknown as {
      process: (config: unknown, session: string) => Promise<unknown>;
    };
    internals.process = async () => {
      markProcessStarted();
      await processGate;
      return undefined;
    };
    const start = gateway.startManaged(serverId, sessionId, bearer);
    await processStarted;
    if (revokeAll) gateway.revokeSession(sessionId);
    else gateway.revoke(serverId, sessionId);
    releaseProcess();
    await expect(start).rejects.toThrow('MCP session closed while its server was starting');
    const generationMaps = gateway as unknown as {
      sessionGenerations: Map<string, unknown>;
      sessionServerGenerations: Map<string, unknown>;
    };
    expect(generationMaps.sessionGenerations.size).toBe(0);
    expect(generationMaps.sessionServerGenerations.size).toBe(0);

    const response = await fetch(`${gateway.url}?server=${serverId}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'x-agent-session': sessionId, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(response.status).toBe(401);
  });

  it.each([false, true])('revokes a real start without killing a process still owned elsewhere (%s)', async keepOtherSession => {
    const statuses: Array<{ status?: string; serverId?: string }> = [];
    gateway = new McpGateway(createLogger({ level: 'error', write: () => undefined }), status => statuses.push(status as { status?: string; serverId?: string }));
    await gateway.start();
    const serverId = randomUUID();
    const revokedSession = randomUUID();
    const otherSession = randomUUID();
    const script = [
      "process.stdin.on('data', data => {",
      '  const request = JSON.parse(data.toString());',
      "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { alive: true } }) + '\\n');",
      '});',
    ].join(' ');
    const server = {
      id: serverId,
      name: 'real-revocation',
      enabled: true,
      transport: 'stdio' as const,
      mode: 'machine-shared' as const,
      command: process.execPath,
      args: ['-e', script],
      machineScope: { allMachines: true, machineIds: [] },
      projectIds: [],
      revision: 1,
      secrets: [],
    };
    gateway.setRegistry({ protocol: '1.13', revision: 1, generatedAt: 1, registryEnabled: true, servers: [server] });
    const otherBearer = randomUUID() + randomUUID();
    if (keepOtherSession) await gateway.startManaged(serverId, otherSession, otherBearer);

    let markProcessReady!: () => void;
    const processReady = new Promise<void>(resolve => {
      markProcessReady = resolve;
    });
    let releaseStart!: () => void;
    const startGate = new Promise<void>(resolve => {
      releaseStart = resolve;
    });
    const internals = gateway as unknown as {
      process: (config: unknown, session: string) => Promise<unknown>;
      entries: Map<string, { child: { once: (event: string, callback: () => void) => void } }>;
    };
    const originalProcess = internals.process.bind(gateway);
    let startedChild: { once: (event: string, callback: () => void) => void } | undefined;
    internals.process = async (config, session) => {
      const entry = await originalProcess(config, session);
      if (session === revokedSession) {
        startedChild = (entry as { child: { once: (event: string, callback: () => void) => void } }).child;
        markProcessReady();
        await startGate;
      }
      return entry;
    };
    const revokedBearer = randomUUID() + randomUUID();
    const start = gateway.startManaged(serverId, revokedSession, revokedBearer);
    await processReady;
    gateway.revoke(serverId, revokedSession);
    releaseStart();
    await expect(start).rejects.toThrow('MCP session closed while its server was starting');

    if (keepOtherSession) {
      const response = await fetch(`${gateway.url}?server=${serverId}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${otherBearer}`, 'x-agent-session': otherSession, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
      expect(response.status).toBe(200);
      expect(statuses.some(status => status.serverId === serverId && status.status === 'stopped')).toBe(false);
    } else {
      const closed = new Promise<void>(resolve => startedChild?.once('close', resolve));
      await closed;
      expect(statuses).toContainEqual(expect.objectContaining({ serverId, status: 'stopped' }));
      expect([...internals.entries.keys()].some(key => key.startsWith(`${serverId}:`))).toBe(false);
    }
  });

  it.each(['machine-shared', 'per-session'] as const)('preserves other session process during a late timeout (%s)', async mode => {
    const statuses: Array<{ status?: string; serverId?: string; revision?: number }> = [];
    gateway = new McpGateway(createLogger({ level: 'error', write: () => undefined }), status => statuses.push(status as { status?: string; serverId?: string; revision?: number }));
    await gateway.start();
    const serverId = randomUUID();
    const firstSession = randomUUID();
    const secondSession = randomUUID();
    const script = [
      "process.stdin.on('data', data => {",
      '  const request = JSON.parse(data.toString());',
      "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { alive: true } }) + '\\n');",
      '});',
    ].join(' ');
    const server = {
      id: serverId,
      name: 'shared-late-start',
      enabled: true,
      transport: 'stdio' as const,
      mode,
      command: process.execPath,
      args: ['-e', script],
      machineScope: { allMachines: true, machineIds: [] },
      projectIds: [],
      revision: 5,
      secrets: [],
    };
    gateway.setRegistry({ protocol: '1.13', revision: 5, generatedAt: 1, registryEnabled: true, servers: [server] });
    const secondBearer = randomUUID() + randomUUID();
    await gateway.startManaged(serverId, secondSession, secondBearer);

    let markLateStart!: () => void;
    const lateStartReachedProcess = new Promise<void>(resolve => {
      markLateStart = resolve;
    });
    let releaseLateStart!: () => void;
    const lateStartGate = new Promise<void>(resolve => {
      releaseLateStart = resolve;
    });
    const internals = gateway as unknown as {
      process: (config: unknown, session: string) => Promise<unknown>;
    };
    const originalProcess = internals.process.bind(gateway);
    internals.process = async (config, session) => {
      if (session === firstSession) {
        markLateStart();
        await lateStartGate;
      }
      return originalProcess(config, session);
    };

    const queue = new McpRegistryQueue(10);
    const firstBearer = randomUUID() + randomUUID();
    const start = queue.enqueue(
      () => gateway!.startManaged(serverId, firstSession, firstBearer),
      () => gateway!.stopTimedOutStart(serverId, firstSession, 5),
    );
    await lateStartReachedProcess;
    await expect(start).rejects.toThrow('MCP registry operation timed out');
    releaseLateStart();
    await queue.enqueue(async () => undefined);

    const response = await fetch(`${gateway.url}?server=${serverId}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secondBearer}`, 'x-agent-session': secondSession, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(response.status).toBe(200);
    expect(statuses.some(status => status.serverId === serverId && status.status === 'stopped')).toBe(false);
  });

  it('applies stop after an in-flight managed start and leaves no session token', async () => {
    gateway = new McpGateway(createLogger({ level: 'error', write: () => undefined }));
    await gateway.start();
    const serverId = randomUUID();
    const sessionId = randomUUID();
    const bearer = randomUUID() + randomUUID();
    const server = {
      id: serverId,
      name: 'slow-stop',
      enabled: true,
      transport: 'stdio' as const,
      mode: 'machine-shared' as const,
      command: process.execPath,
      args: [],
      machineScope: { allMachines: true, machineIds: [] },
      projectIds: [],
      revision: 1,
      secrets: [],
    };
    gateway.setRegistry({ protocol: '1.13', revision: 1, generatedAt: 1, registryEnabled: true, servers: [server] });
    let markProcessStarted!: () => void;
    const processStarted = new Promise<void>(resolve => {
      markProcessStarted = resolve;
    });
    let releaseProcess!: () => void;
    const processGate = new Promise<void>(resolve => {
      releaseProcess = resolve;
    });
    const internals = gateway as unknown as { process: (config: unknown, session: string) => Promise<unknown> };
    internals.process = async () => {
      markProcessStarted();
      await processGate;
      return undefined;
    };
    const queue = new McpRegistryQueue(1000);
    const start = queue.enqueue(() => gateway!.startManaged(serverId, sessionId, bearer));
    await processStarted;
    let stopRan = false;
    const stop = queue.enqueue(async () => {
      stopRan = true;
      gateway!.stopManaged(serverId, sessionId);
    });
    await delay(20);
    expect(stopRan).toBe(false);
    releaseProcess();
    await Promise.all([start, stop]);
    expect(stopRan).toBe(true);

    const response = await fetch(`${gateway.url}?server=${serverId}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'x-agent-session': sessionId, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(response.status).toBe(401);
  });

  it('uses server ID and revision in machine-shared process identity', async () => {
    gateway = new McpGateway(createLogger({ level: 'error', write: () => undefined }));
    await gateway.start();
    const serverA = randomUUID();
    const serverB = randomUUID();
    const sessionA = randomUUID();
    const sessionB = randomUUID();
    const script =
      "process.stdin.on('data', d => { const q = JSON.parse(d.toString()); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: q.id, result: { marker: process.env.MARKER } }) + '\\n'); });";
    const makeServer = (id: string, name: string, revision: number, marker: string) => ({
      id,
      name,
      enabled: true,
      transport: 'stdio' as const,
      mode: 'machine-shared' as const,
      command: process.execPath,
      args: ['-e', script],
      env: { MARKER: { kind: 'literal' as const, value: marker } },
      secrets: [],
      machineScope: { allMachines: true, machineIds: [] },
      projectIds: [],
      revision,
    });
    const configA = makeServer(serverA, 'server-a', 1, 'first');
    const configB = makeServer(serverB, 'server-b', 1, 'second');
    gateway.setRegistry({ protocol: '1.13', revision: 1, generatedAt: 1, registryEnabled: true, servers: [configA, configB] });
    const call = async (serverId: string, sessionId: string) => {
      const bearer = gateway!.authorize(serverId, sessionId);
      const response = await fetch(`${gateway!.url}?server=${serverId}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'x-agent-session': sessionId, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
      return response.json() as Promise<{ result: { marker: string } }>;
    };
    expect((await call(serverA, sessionA)).result.marker).toBe('first');
    expect((await call(serverB, sessionB)).result.marker).toBe('second');
    const configA2 = makeServer(serverA, 'server-a', 2, 'updated');
    gateway.setRegistry({ protocol: '1.13', revision: 2, generatedAt: 2, registryEnabled: true, servers: [configA2, configB] });
    expect((await call(serverA, sessionA)).result.marker).toBe('updated');
    expect((await call(serverB, sessionB)).result.marker).toBe('second');
  });

  it('keeps repeated failed launches inside supervisor backoff', async () => {
    const statuses: Array<{ status?: string }> = [];
    gateway = new McpGateway(createLogger({ level: 'error', write: () => undefined }), status => statuses.push(status as { status?: string }), {
      maxProcesses: 8,
      maxSessions: 64,
      maxPending: 256,
      maxPerServerSessions: 4,
      idleMs: 20,
      backoffBaseMs: 10_000,
      backoffMaxMs: 10_000,
      backoffWindowMs: 60_000,
      maxRestarts: 2,
      healthyResetMs: 100,
    });
    await gateway.start();
    const serverId = randomUUID();
    gateway.setRegistry({
      protocol: '1.13',
      revision: 1,
      generatedAt: 1,
      registryEnabled: true,
      servers: [
        {
          id: serverId,
          name: 'crashing',
          enabled: true,
          transport: 'stdio',
          mode: 'machine-shared',
          command: process.execPath,
          args: ['-e', "process.stdin.on('data', () => process.exit(2));"],
          machineScope: { allMachines: true, machineIds: [] },
          projectIds: [],
          revision: 1,
          secrets: [],
        },
      ],
    });
    const sessionId = randomUUID();
    const bearer = gateway.authorize(serverId, sessionId);
    const url = `${gateway.url}?server=${serverId}`;
    const request = () =>
      fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'x-agent-session': sessionId, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
    await request();
    await delay(30);
    await request();
    expect(statuses.filter(status => status.status === 'starting')).toHaveLength(1);
  });

  it('expires stalled stdio requests and releases pending capacity', async () => {
    gateway = new McpGateway(createLogger({ level: 'error', write: () => undefined }), undefined, {
      maxProcesses: 8,
      maxSessions: 64,
      maxPending: 1,
      maxPerServerSessions: 4,
      idleMs: 1000,
      backoffBaseMs: 10,
      backoffMaxMs: 30,
      backoffWindowMs: 100,
      maxRestarts: 5,
      healthyResetMs: 100,
      requestTimeoutMs: 25,
    });
    await gateway.start();
    const serverId = randomUUID();
    gateway.setRegistry({
      protocol: '1.13',
      revision: 1,
      generatedAt: 1,
      registryEnabled: true,
      servers: [
        {
          id: serverId,
          name: 'stalled',
          enabled: true,
          transport: 'stdio',
          mode: 'machine-shared',
          command: process.execPath,
          args: ['-e', 'process.stdin.resume();'],
          machineScope: { allMachines: true, machineIds: [] },
          projectIds: [],
          revision: 1,
          secrets: [],
        },
      ],
    });
    const session = randomUUID();
    const bearer = gateway.authorize(serverId, session);
    const send = (id: number) =>
      fetch(`${gateway!.url}?server=${serverId}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearer}`,
          'x-agent-session': session,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' }),
      });
    const first = await send(1);
    expect(first.status).toBe(504);
    expect(await first.json()).toEqual({ error: 'MCP request timed out' });
    const second = await send(2);
    expect(second.status).toBe(504);
  });

  it('enforces process limits and reports a missing runtime without repeated spawn attempts', async () => {
    const statuses: Array<{ serverId?: string; status?: string; error?: string }> = [];
    gateway = new McpGateway(createLogger({ level: 'error', write: () => undefined }), status => statuses.push(status as { serverId?: string; status?: string; error?: string }), {
      maxProcesses: 2,
      maxSessions: 64,
      maxPending: 256,
      maxPerServerSessions: 2,
      idleMs: 1000,
      backoffBaseMs: 10,
      backoffMaxMs: 30,
      backoffWindowMs: 100,
      maxRestarts: 2,
      healthyResetMs: 100,
    });
    await gateway.start();
    const firstId = randomUUID();
    const missingId = randomUUID();
    gateway.setRegistry({
      protocol: '1.13',
      revision: 1,
      generatedAt: 1,
      registryEnabled: true,
      servers: [
        {
          id: firstId,
          name: 'limited',
          enabled: true,
          transport: 'stdio',
          mode: 'per-session',
          command: process.execPath,
          args: ['-e', 'setInterval(() => undefined, 1000);'],
          machineScope: { allMachines: true, machineIds: [] },
          projectIds: [],
          revision: 1,
          secrets: [],
        },
        {
          id: missingId,
          name: 'missing-runtime',
          enabled: true,
          transport: 'stdio',
          mode: 'per-session',
          command: `missing-mcp-runtime-${randomUUID()}`,
          machineScope: { allMachines: true, machineIds: [] },
          projectIds: [],
          revision: 1,
          secrets: [],
        },
      ],
    });
    const firstSession = randomUUID();
    await gateway.startManaged(firstId, firstSession, randomUUID() + randomUUID());
    await gateway.startManaged(firstId, randomUUID(), randomUUID() + randomUUID());
    expect(statuses.filter(status => status.serverId === firstId && status.status === 'starting')).toHaveLength(2);
    await expect(gateway.startManaged(firstId, randomUUID(), randomUUID() + randomUUID())).rejects.toThrow('per-session process limit');
    await expect(gateway.startManaged(missingId, randomUUID(), randomUUID() + randomUUID())).rejects.toThrow('process limit reached');
    gateway.stopServer(firstId);
    const missingSession = randomUUID();
    await expect(gateway.startManaged(missingId, missingSession, randomUUID() + randomUUID())).rejects.toThrow('command not found');
    await delay(30);
    expect(statuses.filter(status => status.serverId === missingId && status.status === 'failed')).toHaveLength(1);
    await expect(gateway.startManaged(missingId, missingSession, randomUUID() + randomUUID())).rejects.toThrow('executable is unavailable');
    expect(statuses.filter(status => status.serverId === missingId && status.status === 'starting')).toHaveLength(1);
  });

  it('binds loopback only and rejects missing or cross-session bearer tokens', async () => {
    gateway = new McpGateway(createLogger({ level: 'error', write: () => undefined }));
    await gateway.start();
    const serverId = randomUUID();
    gateway.setRegistry({
      protocol: '1.13',
      revision: 1,
      generatedAt: 1,
      registryEnabled: true,
      servers: [
        {
          id: serverId,
          name: 'echo',
          enabled: true,
          transport: 'stdio',
          mode: 'machine-shared',
          command: process.execPath,
          args: ['-e', ''],
          machineScope: { allMachines: true, machineIds: [] },
          projectIds: [],
          revision: 1,
          secrets: [],
        },
      ],
    });
    const first = gateway.authorize(serverId, 'session-1');
    await gateway.authorize(serverId, 'session-2');
    const url = `${gateway.url}?server=${serverId}`;
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const missing = await fetch(url, { method: 'POST', body });
    const wrong = await fetch(url, { method: 'POST', body, headers: { authorization: `Bearer ${first}`, 'x-agent-session': 'session-2' } });
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
  });

  it('validates stdio MCP servers with initialize and tools/list', async () => {
    const statuses: unknown[] = [];
    gateway = new McpGateway(createLogger({ level: 'error', write: () => undefined }), status => statuses.push(status));
    await gateway.start();
    const serverId = randomUUID(),
      draftId = randomUUID(),
      machineId = randomUUID();
    const script = [
      "process.stdin.on('data', d => {",
      "  for (const line of d.toString().trim().split('\\n')) {",
      '    if (!line) continue;',
      '    const q = JSON.parse(line);',
      "    const result = q.method === 'initialize'",
      "      ? { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } }",
      "      : { tools: [{ name: 'hello', description: 'fixture tool' }] };",
      "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }) + '\\n');",
      '  }',
      '});',
    ].join(' ');
    const result = await gateway.validate({
      draftId,
      revision: 1,
      machineId,
      server: {
        id: serverId,
        name: 'fixture',
        enabled: true,
        transport: 'stdio',
        mode: 'machine-shared',
        command: process.execPath,
        args: ['-e', script],
        machineScope: { allMachines: false, machineIds: [machineId] },
        projectIds: [],
        revision: 1,
        secrets: [],
      },
    });
    expect(result).toMatchObject({ ok: true, status: 'checked', tools: [{ name: 'hello', description: 'fixture tool' }], oauthRequired: false });
    expect(statuses).toEqual([]);
  });

  it('uses the persisted OAuth server id while validating an edited remote server', async () => {
    const authorizationHeaders: string[] = [];
    const remote = (remoteFixture = createServer((req, res) => {
      authorizationHeaders.push(String(req.headers.authorization ?? ''));
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: number; method: string };
        const result = rpc.method === 'tools/list' ? { tools: [] } : { protocolVersion: '2025-03-26', capabilities: {} };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
      });
    }));
    await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve));
    const address = remote.address();
    if (!address || typeof address === 'string') throw new Error('remote fixture failed to bind');
    const statuses: unknown[] = [];
    gateway = new McpGateway(createLogger({ level: 'error', write: () => undefined }), status => statuses.push(status));
    await gateway.start();
    const serverId = randomUUID();
    const draftId = randomUUID();
    const serverUrl = `http://127.0.0.1:${address.port}/mcp`;
    const resolvedServerIds: string[] = [];
    gateway.setOAuthAccess(async id => {
      resolvedServerIds.push(id);
      return 'access-token';
    });
    gateway.setRegistry({
      protocol: '1.13',
      revision: 2,
      generatedAt: 1,
      registryEnabled: true,
      servers: [
        {
          id: serverId,
          name: 'oauth-edited',
          enabled: true,
          transport: 'http',
          mode: 'remote',
          url: serverUrl,
          machineScope: { allMachines: true, machineIds: [] },
          projectIds: [],
          revision: 2,
          secrets: [],
        },
      ],
    });
    const result = await gateway.validate({
      draftId,
      revision: 2,
      machineId: randomUUID(),
      oauthServerId: serverId,
      server: {
        id: draftId,
        name: 'oauth-edited',
        enabled: true,
        transport: 'http',
        mode: 'remote',
        url: serverUrl,
        machineScope: { allMachines: true, machineIds: [] },
        projectIds: [],
        revision: 2,
        secrets: [],
      },
    });
    expect(result).toMatchObject({ ok: true, status: 'checked', tools: [], oauthRequired: false });
    expect(resolvedServerIds).toEqual([serverId, serverId]);
    expect(authorizationHeaders).toEqual(['Bearer access-token', 'Bearer access-token']);
    expect(statuses).toEqual([]);
  });

  it('reports an HTTP 401 validation response as needs_auth', async () => {
    const remote = (remoteFixture = createServer((_req, res) => {
      res.writeHead(401, { 'www-authenticate': 'Bearer' });
      res.end();
    }));
    await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve));
    const address = remote.address();
    if (!address || typeof address === 'string') throw new Error('remote fixture failed to bind');
    gateway = new McpGateway(createLogger({ level: 'error', write: () => undefined }));
    await gateway.start();
    const serverId = randomUUID();
    const result = await gateway.validate({
      draftId: randomUUID(),
      revision: 1,
      machineId: randomUUID(),
      server: {
        id: serverId,
        name: 'oauth-required',
        enabled: true,
        transport: 'http',
        mode: 'remote',
        url: `http://127.0.0.1:${address.port}/mcp`,
        machineScope: { allMachines: true, machineIds: [] },
        projectIds: [],
        revision: 1,
        secrets: [],
      },
    });
    expect(result).toMatchObject({ ok: false, status: 'needs_auth', oauthRequired: true });
  });

  it('does not send or refresh OAuth tokens for a different URL origin', async () => {
    const authorizationHeaders: string[] = [];
    const remote = (remoteFixture = createServer((req, res) => {
      authorizationHeaders.push(String(req.headers.authorization ?? ''));
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: number; method: string };
        const result = rpc.method === 'tools/list' ? { tools: [] } : { protocolVersion: '2025-03-26', capabilities: {} };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
      });
    }));
    await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve));
    const address = remote.address();
    if (!address || typeof address === 'string') throw new Error('remote fixture failed to bind');
    gateway = new McpGateway(createLogger({ level: 'error', write: () => undefined }));
    await gateway.start();
    const serverId = randomUUID();
    let accessCalls = 0;
    let refreshCalls = 0;
    gateway.setOAuthAccess(async () => {
      accessCalls += 1;
      return 'access-token';
    });
    gateway.setOAuthRefresh(async () => {
      refreshCalls += 1;
      return 'refreshed-token';
    });
    gateway.setRegistry({
      protocol: '1.13',
      revision: 2,
      generatedAt: 1,
      registryEnabled: true,
      servers: [
        {
          id: serverId,
          name: 'registered-origin',
          enabled: true,
          transport: 'http',
          mode: 'remote',
          url: 'https://registered.example/mcp',
          machineScope: { allMachines: true, machineIds: [] },
          projectIds: [],
          revision: 2,
          secrets: [],
        },
      ],
    });
    const result = await gateway.validate({
      draftId: randomUUID(),
      revision: 2,
      machineId: randomUUID(),
      oauthServerId: serverId,
      server: {
        id: randomUUID(),
        name: 'different-origin',
        enabled: true,
        transport: 'http',
        mode: 'remote',
        url: `http://127.0.0.1:${address.port}/mcp`,
        machineScope: { allMachines: true, machineIds: [] },
        projectIds: [],
        revision: 2,
        secrets: [],
      },
    });
    expect(result.status).toBe('checked');
    expect(accessCalls).toBe(0);
    expect(refreshCalls).toBe(0);
    expect(authorizationHeaders).toEqual(['', '']);
  });

  it.each([
    {
      title: 'normalizes hostname case and the default port',
      registeredUrl: 'HTTPS://EXAMPLE.TEST:443/registered',
      candidateUrl: 'https://example.test/candidate',
      expectedAccessCalls: 2,
    },
    {
      title: 'keeps HTTP and HTTPS origins distinct',
      registeredUrl: 'HTTPS://EXAMPLE.TEST:443/registered',
      candidateUrl: 'http://example.test/candidate',
      expectedAccessCalls: 0,
    },
  ])('compares canonical OAuth origins: $title', async ({ registeredUrl, candidateUrl, expectedAccessCalls }) => {
    const originalFetch = globalThis.fetch;
    const authorizationHeaders: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const target = new URL(input instanceof Request ? input.url : String(input));
      if (target.hostname !== 'example.test') return originalFetch(input, init);
      authorizationHeaders.push(new Headers(init?.headers).get('authorization') ?? '');
      const request = JSON.parse(String(init?.body)) as { id: number; method: string };
      const result = request.method === 'tools/list' ? { tools: [] } : { protocolVersion: '2025-03-26', capabilities: {} };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    gateway = new McpGateway(createLogger({ level: 'error', write: () => undefined }));
    await gateway.start();
    const serverId = randomUUID();
    gateway.setOAuthAccess(async () => 'access-token');
    gateway.setRegistry({
      protocol: '1.13',
      revision: 1,
      generatedAt: 1,
      registryEnabled: true,
      servers: [
        {
          id: serverId,
          name: 'registered-origin',
          enabled: true,
          transport: 'http',
          mode: 'remote',
          url: registeredUrl,
          machineScope: { allMachines: true, machineIds: [] },
          projectIds: [],
          revision: 1,
          secrets: [],
        },
      ],
    });
    const result = await gateway.validate({
      draftId: randomUUID(),
      revision: 1,
      machineId: randomUUID(),
      oauthServerId: serverId,
      server: {
        id: randomUUID(),
        name: 'candidate-origin',
        enabled: true,
        transport: 'http',
        mode: 'remote',
        url: candidateUrl,
        machineScope: { allMachines: true, machineIds: [] },
        projectIds: [],
        revision: 1,
        secrets: [],
      },
    });
    expect(result.status).toBe('checked');
    expect(authorizationHeaders).toHaveLength(2);
    expect(authorizationHeaders.filter(value => value === 'Bearer access-token')).toHaveLength(expectedAccessCalls);
  });

  it('reports needs-secret from the gateway validation error code', async () => {
    gateway = new McpGateway(createLogger({ level: 'error', write: () => undefined }));
    await gateway.start();
    const serverId = randomUUID();
    const secretId = randomUUID();
    const result = await gateway.validate({
      draftId: randomUUID(),
      revision: 1,
      machineId: randomUUID(),
      server: {
        id: serverId,
        name: 'validation-secret-required',
        enabled: true,
        transport: 'stdio',
        mode: 'per-session',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        env: { API_TOKEN: { kind: 'secret', secretId } },
        machineScope: { allMachines: true, machineIds: [] },
        projectIds: [],
        revision: 1,
        secrets: [{ secretId, name: 'API_TOKEN', state: 'set' }],
      },
    });
    expect(result).toMatchObject({
      ok: false,
      status: 'needs-secret',
      error: 'MCP server needs secret',
      oauthRequired: false,
    });
  });

  it('does not classify an unmarked HTTP 424 as a missing secret', async () => {
    const remote = (remoteFixture = createServer((_req, res) => {
      res.writeHead(424, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream dependency failed' }));
    }));
    await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve));
    const address = remote.address();
    if (!address || typeof address === 'string') throw new Error('remote fixture failed to bind');
    gateway = new McpGateway(createLogger({ level: 'error', write: () => undefined }));
    await gateway.start();
    const result = await gateway.validate({
      draftId: randomUUID(),
      revision: 1,
      machineId: randomUUID(),
      server: {
        id: randomUUID(),
        name: 'unmarked-424',
        enabled: true,
        transport: 'http',
        mode: 'remote',
        url: `http://127.0.0.1:${address.port}/mcp`,
        machineScope: { allMachines: true, machineIds: [] },
        projectIds: [],
        revision: 1,
        secrets: [],
      },
    });
    expect(result).toMatchObject({ ok: false, status: 'validation-failed' });
  });

  it('returns immediately for a missing command and an early process exit', async () => {
    gateway = new McpGateway(createLogger({ level: 'error', write: () => undefined }));
    await gateway.start();
    const machineId = randomUUID();
    const validate = (command: string, args: string[]) =>
      gateway!.validate({
        draftId: randomUUID(),
        revision: 1,
        machineId,
        server: {
          id: randomUUID(),
          name: 'startup-failure',
          enabled: true,
          transport: 'stdio',
          mode: 'per-session',
          command,
          args,
          machineScope: { allMachines: true, machineIds: [] },
          projectIds: [],
          revision: 1,
          secrets: [],
        },
      });
    const missingCommand = `mcp-not-installed-${randomUUID()}`;
    const missingStarted = Date.now();
    const missing = await validate(missingCommand, []);
    expect(Date.now() - missingStarted).toBeLessThan(2_000);
    expect(missing).toMatchObject({
      ok: false,
      status: 'validation-failed',
      error: `MCP server returned HTTP 502: command not found: ${missingCommand}`,
    });

    const exitStarted = Date.now();
    const earlyExit = await validate(process.execPath, ['-e', 'process.exit(17)']);
    expect(Date.now() - exitStarted).toBeLessThan(2_000);
    expect(earlyExit).toMatchObject({
      ok: false,
      status: 'validation-failed',
      error: 'MCP server returned HTTP 502: MCP server process exited with code 17',
    });
  });

  it('keeps delivered stdio secrets out of argv, protocol replies, and logs', async () => {
    const logLines: string[] = [];
    gateway = new McpGateway(createLogger({ level: 'debug', write: line => logLines.push(line) }));
    await gateway.start();
    const serverId = randomUUID();
    const secretId = randomUUID();
    const secret = `agent-only-${randomUUID()}`;
    const sessionId = randomUUID();
    const bearer = gateway.authorize(serverId, sessionId);
    const script = [
      "process.stdin.on('data', d => {",
      '  const q = JSON.parse(d.toString());',
      '  process.stderr.write(process.env.API_TOKEN + "\\n");',
      '  const result = { envAvailable: Boolean(process.env.API_TOKEN), argvContainsSecret: process.argv.includes(process.env.API_TOKEN) };',
      '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: q.id, result }) + "\\n");',
      '});',
    ].join(' ');
    gateway.setRegistry({
      protocol: '1.13',
      revision: 1,
      generatedAt: 1,
      registryEnabled: true,
      servers: [
        {
          id: serverId,
          name: 'secret-env',
          enabled: true,
          transport: 'stdio',
          mode: 'per-session',
          command: process.execPath,
          args: ['-e', script],
          env: { API_TOKEN: { kind: 'secret', secretId } },
          secrets: [{ secretId, name: 'API_TOKEN', state: 'set' }],
          machineScope: { allMachines: true, machineIds: [] },
          projectIds: [],
          revision: 1,
        },
      ],
    });
    gateway.setSecretDelivery(serverId, 1, [{ name: 'API_TOKEN', value: secret }]);
    const response = await fetch(`${gateway.url}?server=${serverId}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'x-agent-session': sessionId, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    const protocolReply = await response.text();
    await delay(10);
    expect(protocolReply).not.toContain(secret);
    expect(protocolReply).toContain('"argvContainsSecret":false');
    expect(protocolReply).toContain('"envAvailable":true');
    expect(protocolReply).not.toContain('agent-only');
    expect(logLines.join('\n')).not.toContain(secret);
    expect(logLines.join('\n')).toContain('[redacted]');
  });

  it('multiplexes same JSON-RPC ids across clients and broadcasts tools/list_changed', async () => {
    gateway = new McpGateway(createLogger({ level: 'error', write: () => undefined }));
    await gateway.start();
    const serverId = randomUUID(),
      sessionA = 'session-a',
      sessionB = 'session-b';
    const script = [
      "process.stdin.on('data', d => {",
      "  for (const line of d.toString().trim().split('\\n')) {",
      '    if (!line) continue;',
      '    const q = JSON.parse(line);',
      "    if (q.method === 'trigger') {",
      "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) + '\\n');",
      '    }',
      "    const client = q.params?.client ?? 'ok';",
      '    const common = { client, pid: process.pid, backendId: q.id };',
      "    const result = q.method === 'initialize'",
      "      ? { ...common, protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } }",
      '      : common;',
      "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }) + '\\n');",
      '  }',
      '});',
    ].join(' ');
    gateway.setRegistry({
      protocol: '1.13',
      revision: 1,
      generatedAt: 1,
      registryEnabled: true,
      servers: [
        {
          id: serverId,
          name: 'shared',
          enabled: true,
          transport: 'stdio',
          mode: 'machine-shared',
          command: process.execPath,
          args: ['-e', script],
          machineScope: { allMachines: true, machineIds: [] },
          projectIds: [],
          revision: 1,
          secrets: [],
        },
      ],
    });
    const tokenA = gateway.authorize(serverId, sessionA),
      tokenB = gateway.authorize(serverId, sessionB),
      url = `${gateway.url}?server=${serverId}`;
    const connect = async (session: string, token: string) => fetch(url, { headers: { authorization: `Bearer ${token}`, 'x-agent-session': session } });
    const [streamA, streamB] = await Promise.all([connect(sessionA, tokenA), connect(sessionB, tokenB)]);
    const readerA = streamA.body!.getReader(),
      readerB = streamB.body!.getReader();
    const readEvent = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
      const decoder = new TextDecoder();
      let text = '';
      for (let n = 0; n < 8; n++) {
        const r = await Promise.race([reader.read(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SSE notification timeout')), 2000))]);
        if (r.done) break;
        text += decoder.decode(r.value);
        if (text.includes('notifications/tools/list_changed')) return text;
      }
      throw new Error('missing tools/list_changed event');
    };
    type GatewayReply = { id: string; result: { client: string; pid: number; backendId: string } };
    const post = async (session: string, token: string, id: string, client: string, method = 'tools/call') =>
      fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'x-agent-session': session, 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method,
          params: method === 'initialize' ? { client, protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: client, version: '1' } } : { client },
        }),
      }).then(r => r.json() as Promise<GatewayReply>);
    const [initA, initB] = await Promise.all([post(sessionA, tokenA, 'same', 'a', 'initialize'), post(sessionB, tokenB, 'same', 'b', 'initialize')]);
    expect(initA).toMatchObject({ id: 'same', result: { client: 'a' } });
    expect(initB).toMatchObject({ id: 'same', result: { client: 'b' } });
    expect(initA.result.pid).toBe(initB.result.pid);
    expect(initA.result.backendId).not.toBe(initB.result.backendId);
    expect(initA.result.backendId).toContain(sessionA);
    expect(initB.result.backendId).toContain(sessionB);
    const [a, b] = await Promise.all([post(sessionA, tokenA, 'same', 'a'), post(sessionB, tokenB, 'same', 'b')]);
    expect(a).toMatchObject({ id: 'same', result: { client: 'a' } });
    expect(b).toMatchObject({ id: 'same', result: { client: 'b' } });
    await Promise.all([post(sessionA, tokenA, 'notify', 'a', 'trigger'), post(sessionB, tokenB, 'notify', 'b', 'trigger')]);
    const [eventA, eventB] = await Promise.all([readEvent(readerA), readEvent(readerB)]);
    expect(eventA).toContain('notifications/tools/list_changed');
    expect(eventB).toContain('notifications/tools/list_changed');
    readerA.releaseLock();
    readerB.releaseLock();
    await streamA.body?.cancel();
    await streamB.body?.cancel();
  });

  it('proxies remote HTTP with hop-by-hop and caller authorization stripped, registry auth injected, and logs redacted', async () => {
    let remoteDoneAt = 0;
    const records: string[] = [],
      logLines: string[] = [];
    const remote = (remoteFixture = createServer((req, res) => {
      records.push(JSON.stringify(req.headers));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"jsonrpc":"2.0",');
      setTimeout(() => {
        res.end('"result":{"ok":true}}');
        remoteDoneAt = Date.now();
      }, 150);
    }));
    await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve));
    const address = remote.address();
    if (!address || typeof address === 'string') throw new Error('remote fixture failed to bind');
    const g = (gateway = new McpGateway(createLogger({ level: 'debug', write: line => logLines.push(line) })));
    await g.start();
    const serverId = randomUUID(),
      secretId = randomUUID(),
      session = 'session-proxy',
      secret = 'do-not-log-this-api-key';
    g.setRegistry({
      protocol: '1.13',
      revision: 1,
      generatedAt: 1,
      registryEnabled: true,
      servers: [
        {
          id: serverId,
          name: 'remote',
          enabled: true,
          transport: 'http',
          mode: 'remote',
          url: `http://127.0.0.1:${address.port}/mcp`,
          headers: { 'X-Api-Key': { kind: 'secret', secretId } },
          secrets: [{ secretId, name: 'header:X-Api-Key', state: 'set' }],
          machineScope: { allMachines: true, machineIds: [] },
          projectIds: [],
          revision: 1,
        },
      ],
    });
    g.setSecretDelivery(serverId, 1, [{ name: 'header:X-Api-Key', value: secret }]);
    const bearer = g.authorize(serverId, session);
    const response = await new Promise<{ status: number; body: string; firstDataAt: number }>(resolve => {
      const req = httpRequest(
        `${g.url}?server=${serverId}`,
        { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'x-agent-session': session, connection: 'x-remove, keep-alive', 'x-remove': 'remove-me', 'content-type': 'application/json' } },
        res => {
          let body = '',
            firstDataAt = 0;
          res.setEncoding('utf8');
          res.on('data', x => {
            if (!firstDataAt) firstDataAt = Date.now();
            body += x;
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body, firstDataAt }));
        },
      );
      req.end('{}');
    });
    expect(response.status).toBe(200);
    const forwarded = JSON.parse(records.find(x => x.includes('"x-api-key"')) ?? '{}') as Record<string, string>;
    expect(forwarded['x-api-key']).toBe(secret);
    expect(forwarded.authorization).toBeUndefined();
    expect(forwarded['x-remove']).toBeUndefined();
    expect(response.body).toContain('"ok":true');
    expect(response.firstDataAt).toBeLessThan(remoteDoneAt);
    expect(logLines.join('\n')).not.toContain(secret);
  });

  it('does not forward stale compression headers after undici decompresses a remote body', async () => {
    const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    const compressed = gzipSync(Buffer.from(payload));
    remoteFixture = createServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'content-length': String(compressed.length),
      });
      res.end(compressed);
    });
    await new Promise<void>(resolve => remoteFixture!.listen(0, '127.0.0.1', resolve));
    const address = remoteFixture.address();
    if (!address || typeof address === 'string') throw new Error('remote fixture failed to bind');
    gateway = new McpGateway(createLogger({ level: 'error', write: () => undefined }));
    await gateway.start();
    const serverId = randomUUID();
    gateway.setRegistry({
      protocol: '1.13',
      revision: 1,
      generatedAt: 1,
      registryEnabled: true,
      servers: [
        {
          id: serverId,
          name: 'compressed-remote',
          enabled: true,
          transport: 'http',
          mode: 'remote',
          url: `http://127.0.0.1:${address.port}/mcp`,
          machineScope: { allMachines: true, machineIds: [] },
          projectIds: [],
          revision: 1,
          secrets: [],
        },
      ],
    });
    const session = randomUUID();
    const bearer = gateway.authorize(serverId, session);
    const response = await fetch(`${gateway.url}?server=${serverId}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'x-agent-session': session,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('content-length')).toBeNull();
    expect(await response.json()).toEqual(JSON.parse(payload));
  });
});
