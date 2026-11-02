// Minimal OIDC provider for tests: discovery, JWKS, token endpoint with PKCE (S256) verification.
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';

export interface FakeIdentity {
  email: string;
  emailVerified?: boolean;
  /** Overrides the nonce put into the ID token (to test nonce mismatch). */
  nonce?: string;
  /** Signs the ID token with a key that is not in the provider JWKS (to test signature checks). */
  rogueSignature?: boolean;
  /** `sub` of the ID token; default `sub-<email>`. */
  sub?: string;
  /** `name` claim (scope profile). */
  name?: string;
}

interface Grant {
  identity: FakeIdentity;
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
}

export interface FakeOidc {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Simulates the user finishing login at the provider: returns the code for the callback. */
  authorize(authUrl: string, identity: FakeIdentity): { code: string; state: string };
  close(): Promise<void>;
}

export async function startFakeOidc(): Promise<FakeOidc> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const rogue = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const clientId = 'test-client';
  const clientSecret = 'test-secret';
  const grants = new Map<string, Grant>();
  let issuer = '';

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        void (async () => {
          const p = new URLSearchParams(body);
          const grant = grants.get(p.get('code') ?? '');
          if (!grant) return json(400, { error: 'invalid_grant' });
          grants.delete(p.get('code')!);
          const challenge = createHash('sha256')
            .update(p.get('code_verifier') ?? '')
            .digest('base64url');
          if (challenge !== grant.codeChallenge) return json(400, { error: 'invalid_grant', error_description: 'pkce' });
          if (p.get('redirect_uri') !== grant.redirectUri) return json(400, { error: 'invalid_grant', error_description: 'redirect_uri' });
          const idToken = await new SignJWT({
            email: grant.identity.email,
            email_verified: grant.identity.emailVerified ?? true,
            nonce: grant.identity.nonce ?? grant.nonce,
            ...(grant.identity.name ? { name: grant.identity.name } : {}),
          })
            .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
            .setIssuer(issuer)
            .setAudience(clientId)
            .setSubject(grant.identity.sub ?? `sub-${grant.identity.email}`)
            .setIssuedAt()
            .setExpirationTime('5m')
            .sign(grant.identity.rogueSignature ? rogue.privateKey : privateKey);
          json(200, { access_token: 'at', token_type: 'Bearer', expires_in: 300, id_token: idToken, scope: 'openid email' });
        })();
      });
      return;
    }
    json(404, { error: 'not_found' });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    issuer,
    clientId,
    clientSecret,
    authorize(authUrl, identity) {
      const u = new URL(authUrl);
      if (u.searchParams.get('code_challenge_method') !== 'S256') throw new Error('PKCE S256 expected');
      const code = randomBytes(12).toString('hex');
      grants.set(code, {
        identity,
        nonce: u.searchParams.get('nonce')!,
        codeChallenge: u.searchParams.get('code_challenge')!,
        redirectUri: u.searchParams.get('redirect_uri')!,
      });
      return { code, state: u.searchParams.get('state')! };
    },
    close: () => new Promise<void>(r => server.close(() => r())),
  };
}
