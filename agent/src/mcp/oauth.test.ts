import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../log.js';
import { McpGateway } from './gateway.js';
import { McpOAuthManager } from './oauth.js';
import type { RegistrySnapshot } from './registryCache.js';

describe('McpOAuthManager', () => {
  let server: ReturnType<typeof createServer> | undefined;
  let gateway: McpGateway | undefined;
  afterEach(async () => {
    await gateway?.stop();
    gateway = undefined;
    if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
  });

  it('runs SDK discovery, DCR, PKCE, callback exchange, refresh and rotation', async () => {
    const grants: URLSearchParams[] = [];
    server = createServer(async (req, res) => {
      const origin = `http://${req.headers.host}`;
      if (req.method === 'GET' && req.url?.includes('oauth-protected-resource')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ['tools'] }));
        return;
      }
      if (req.method === 'GET' && req.url?.includes('oauth-authorization-server')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            registration_endpoint: `${origin}/register`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            token_endpoint_auth_methods_supported: ['client_secret_post'],
            code_challenge_methods_supported: ['S256'],
          }),
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/register') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { redirect_uris: string[] };
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            client_id: 'fixture-client',
            client_secret: 'fixture-client-secret',
            redirect_uris: body.redirect_uris,
            token_endpoint_auth_method: 'client_secret_post',
          }),
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/token') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        grants.push(form);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify(
            form.get('grant_type') === 'refresh_token'
              ? { access_token: 'rotated-access', refresh_token: 'rotated-refresh', token_type: 'Bearer', expires_in: 3600 }
              : { access_token: 'initial-access', refresh_token: 'initial-refresh', token_type: 'Bearer', expires_in: 1 },
          ),
        );
        return;
      }
      if (req.url === '/mcp') {
        if (req.headers.authorization !== 'Bearer rotated-access') {
          res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` });
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { authenticated: true } }));
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('OAuth fixture failed to bind');
    const origin = `http://127.0.0.1:${address.port}`;
    const serverId = randomUUID();
    const machineId = randomUUID();
    const logs: string[] = [];
    const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const snapshot: RegistrySnapshot = {
      protocol: '1.13',
      revision: 1,
      generatedAt: Date.now(),
      registryEnabled: true,
      servers: [
        {
          id: serverId,
          name: 'oauth-fixture',
          enabled: true,
          transport: 'http',
          mode: 'remote',
          url: `${origin}/mcp`,
          machineScope: { allMachines: true, machineIds: [] },
          projectIds: [],
          revision: 1,
          secrets: [],
        },
      ],
    };
    gateway = new McpGateway(createLogger({ level: 'debug', write: line => logs.push(line) }));
    gateway.setRegistry(snapshot);
    await gateway.start();
    const oauth = new McpOAuthManager(
      () => null,
      gateway,
      (type, payload) => {
        sent.push({ type, payload: payload as Record<string, unknown> });
        return true;
      },
      createLogger({ level: 'debug', write: line => logs.push(line) }),
    );
    oauth.setMachine(machineId);
    const flowId = randomUUID();
    const redirectUri = 'https://hub.example.test/mcp/oauth/callback';
    const started = await oauth.begin({ flowId, serverId, machineId, redirectUri, serverUrl: `${origin}/mcp`, transport: 'http' });
    const authorizationUrl = new URL(started.authorizationUrl);
    expect(started.flowId).toBe(flowId);
    expect(started.expiresAt).toBeGreaterThan(Date.now());
    expect(authorizationUrl.searchParams.get('state')).toBe(started.state);
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    const callback = `${redirectUri}?code=fixture-code&state=${encodeURIComponent(started.state)}`;
    await expect(oauth.callback({ flowId, callbackUrl: `${redirectUri}?code=wrong&state=wrong-state` })).rejects.toMatchObject({ code: 'oauth_state_mismatch' });
    expect(await oauth.callback({ flowId, callbackUrl: callback })).toEqual({ ok: true });
    const initial = sent.find(message => message.type === 'mcp.oauth.token.update')?.payload;
    expect(initial).toMatchObject({ serverId, machineId, flowId, accessToken: 'initial-access', refreshToken: 'initial-refresh' });
    expect(initial?.oauthClientState).toEqual(expect.any(String));
    expect(String(initial?.oauthClientState)).not.toContain(started.state);
    expect(String(initial?.oauthClientState)).not.toContain('fixture-code');
    const verifier = grants.find(grant => grant.get('grant_type') === 'authorization_code')?.get('code_verifier');
    expect(verifier).toBeTruthy();
    expect(createHash('sha256').update(verifier!).digest('base64url')).toBe(authorizationUrl.searchParams.get('code_challenge'));

    const restored = new McpOAuthManager(
      () => snapshot,
      gateway,
      (type, payload) => {
        sent.push({ type, payload: payload as Record<string, unknown> });
        return true;
      },
      createLogger({ level: 'debug', write: line => logs.push(line) }),
    );
    restored.setMachine(machineId);
    restored.receiveCredentials({
      serverId,
      machineId,
      accessToken: 'initial-access',
      refreshToken: 'initial-refresh',
      expiresAt: Date.now() - 1,
      oauthClientState: String(initial?.oauthClientState),
    });
    const accessToken = (restored as unknown as { accessToken: (id: string) => Promise<string | null> }).accessToken.bind(restored);
    const [accessA, accessB] = await Promise.all([accessToken(serverId), accessToken(serverId)]);
    expect([accessA, accessB]).toEqual(['rotated-access', 'rotated-access']);
    expect(grants.filter(grant => grant.get('grant_type') === 'refresh_token')).toHaveLength(1);
    expect(sent.some(message => message.type === 'mcp.oauth.status.update' && message.payload.state === 'refresh-error')).toBe(false);

    const sessionId = randomUUID();
    const bearerToken = randomUUID() + randomUUID();
    await gateway.startManaged(serverId, sessionId, bearerToken);
    const proxied = await fetch(`${gateway.url}?server=${serverId}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearerToken}`, 'x-agent-session': sessionId, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(proxied.status).toBe(200);
    expect(await proxied.json()).toMatchObject({ result: { authenticated: true } });
    expect(grants.map(grant => grant.get('grant_type'))).toEqual(['authorization_code', 'refresh_token']);
    expect(grants.every(grant => grant.get('client_secret') === 'fixture-client-secret')).toBe(true);
    expect(sent.find(message => message.type === 'mcp.oauth.token.update' && !message.payload.flowId)?.payload).toMatchObject({
      serverId,
      machineId,
      accessToken: 'rotated-access',
      refreshToken: 'rotated-refresh',
    });
    expect(sent.filter(message => message.type === 'mcp.oauth.status.update').map(message => message.payload.state)).toEqual(['signed-in', 'signed-in']);
    expect(logs.join('\n')).not.toContain('initial-access');
    expect(logs.join('\n')).not.toContain('initial-refresh');
    expect(logs.join('\n')).not.toContain('fixture-code');
    expect(logs.join('\n')).not.toContain('fixture-client-secret');

    const malformedFlowId = randomUUID();
    await oauth.begin({ flowId: malformedFlowId, serverId, machineId, redirectUri, serverUrl: `${origin}/mcp`, transport: 'http' });
    await expect(oauth.callback({ flowId: malformedFlowId, callbackUrl: 'not a valid URL' })).rejects.toMatchObject({ code: 'invalid_input' });
    const pending = (oauth as unknown as { pending: Map<string, unknown> }).pending;
    expect(pending.has(malformedFlowId)).toBe(false);
  });
});
