// A fake OAuth provider with an MCP server behind Bearer on 127.0.0.1 (mcp-management design M9, SA-1 p. 3):
// protected-resource metadata, AS metadata, dynamic client registration, /authorize that redirects at once, /token, and
// a Streamable-HTTP MCP endpoint (JSON answers) that wants `Authorization: Bearer <issued token>`.
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeProvider {
  base: string;
  mcpUrl: string;
  /** redirect_uri of every /authorize call, in order. */
  redirects: string[];
  tokens: Set<string>;
  /** Calls of the revocation endpoint (mcp-auth-controls A7): only their number, no token kept. */
  revocations: number;
  close(): Promise<void>;
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    let s = '';
    req.on('data', (c: Buffer) => (s += c.toString('utf8')));
    req.on('end', () => resolve(s));
  });
}

function json(res: ServerResponse, code: number, v: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(code, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(v));
}

export async function startFakeProvider(name = 'fake-oauth-mcp'): Promise<FakeProvider> {
  const redirects: string[] = [];
  const tokens = new Set<string>();
  const codes = new Set<string>();
  const refresh = new Set<string>();
  let revocations = 0;
  let base = '';
  const server = createServer((req, res) => {
    void (async () => {
      const u = new URL(req.url ?? '/', base);
      const p = u.pathname;
      if (p.startsWith('/.well-known/oauth-protected-resource')) return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ['header'] });
      if (p === '/.well-known/oauth-authorization-server' || p === '/.well-known/openid-configuration') {
        return json(res, 200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          revocation_endpoint: `${base}/revoke`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        });
      }
      if (p === '/register' && req.method === 'POST') {
        const b = JSON.parse((await body(req)) || '{}') as Record<string, unknown>;
        return json(res, 201, { ...b, client_id: `client-${randomBytes(4).toString('hex')}`, token_endpoint_auth_method: 'none' });
      }
      if (p === '/authorize') {
        const redirect = u.searchParams.get('redirect_uri') ?? '';
        redirects.push(redirect);
        const back = new URL(redirect);
        if (u.searchParams.get('deny') === '1') back.searchParams.set('error', 'access_denied');
        else {
          const code = randomBytes(8).toString('hex');
          codes.add(code);
          back.searchParams.set('code', code);
        }
        back.searchParams.set('state', u.searchParams.get('state') ?? '');
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }
      if (p === '/token' && req.method === 'POST') {
        const f = new URLSearchParams(await body(req));
        if (f.get('grant_type') === 'authorization_code' && !codes.delete(f.get('code') ?? '')) return json(res, 400, { error: 'invalid_grant' });
        if (f.get('grant_type') === 'refresh_token' && !refresh.has(f.get('refresh_token') ?? '')) return json(res, 400, { error: 'invalid_grant' });
        const tok = `at-${randomBytes(8).toString('hex')}`;
        const rt = `rt-${randomBytes(8).toString('hex')}`;
        tokens.add(tok);
        refresh.add(rt);
        return json(res, 200, { access_token: tok, token_type: 'Bearer', expires_in: 3600, refresh_token: rt });
      }
      if (p === '/revoke' && req.method === 'POST') {
        // RFC 7009: the token (access or refresh) stops working; 200 either way
        const t = new URLSearchParams(await body(req)).get('token') ?? '';
        tokens.delete(t);
        refresh.delete(t);
        revocations++;
        res.writeHead(200);
        return res.end();
      }
      if (p === '/mcp') {
        const auth = req.headers.authorization ?? '';
        if (!tokens.has(auth.replace(/^Bearer\s+/i, ''))) {
          return json(res, 401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
        }
        if (req.method !== 'POST') {
          res.writeHead(405);
          return res.end();
        }
        const m = JSON.parse((await body(req)) || '{}') as { id?: unknown; method?: string; params?: { protocolVersion?: string } };
        if (m.id === undefined) {
          res.writeHead(202);
          return res.end();
        }
        if (m.method === 'initialize')
          return json(res, 200, {
            jsonrpc: '2.0',
            id: m.id,
            result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name, version: '1.0.0' } },
          });
        if (m.method === 'tools/list') return json(res, 200, { jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'hello', description: 'Hello', inputSchema: { type: 'object' } }] } });
        return json(res, 200, { jsonrpc: '2.0', id: m.id, result: {} });
      }
      res.writeHead(404);
      res.end();
    })().catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    mcpUrl: `${base}/mcp`,
    redirects,
    tokens,
    get revocations() {
      return revocations;
    },
    close: () => new Promise<void>(r => server.close(() => r())),
  };
}
