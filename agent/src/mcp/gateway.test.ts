import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createServer, request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../log.js';
import { McpGateway } from './gateway.js';

describe('McpGateway', () => {
  let gateway: McpGateway | undefined;
  let remoteFixture: ReturnType<typeof createServer> | undefined;
  afterEach(async () => {
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
    await gateway.startManaged(missingId, missingSession, randomUUID() + randomUUID());
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
    gateway = new McpGateway(createLogger({ level: 'error', write: () => undefined }));
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
