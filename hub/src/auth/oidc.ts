// Requirement: Вход через Google OIDC; Вход по приглашению (Google or Keycloak) — authorization code flow with PKCE, state and nonce.
import * as client from 'openid-client';

export interface OidcChecks {
  state: string;
  nonce: string;
  verifier: string;
}

export interface OidcIdentity {
  email: string | null;
  emailVerified: boolean;
  /** `sub` of the provider (multi-user M2): the identity of the user after the first login. */
  subject: string | null;
  /** `name` (scope profile), null when not given. */
  name: string | null;
}

export interface OidcClient {
  /** Builds the provider authorization URL and the values to keep in the browser until the callback. */
  start(opts: { redirectUri: string; prompt?: string }): Promise<{ url: string; checks: OidcChecks }>;
  /** Exchanges the code; throws on any state/nonce/PKCE/signature mismatch. */
  finish(currentUrl: URL, checks: OidcChecks): Promise<OidcIdentity>;
}

export function createOidcClient(opts: { issuer: string; clientId: string; clientSecret: string }): OidcClient {
  let configPromise: Promise<client.Configuration> | null = null;
  const issuer = new URL(opts.issuer);
  // Plain http is accepted only for a loopback test provider.
  const insecure = issuer.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(issuer.hostname);

  function config(): Promise<client.Configuration> {
    if (!configPromise) {
      configPromise = client
        .discovery(issuer, opts.clientId, opts.clientSecret, undefined, {
          // ID token signatures are verified against the provider JWKS, not only trusted because they
          // came over TLS from the token endpoint (design.md D12).
          execute: insecure ? [client.enableNonRepudiationChecks, client.allowInsecureRequests] : [client.enableNonRepudiationChecks],
        })
        .catch((err: unknown) => {
          configPromise = null; // retry discovery on the next login
          throw err;
        });
    }
    return configPromise;
  }

  return {
    async start({ redirectUri, prompt }) {
      const cfg = await config();
      const verifier = client.randomPKCECodeVerifier();
      const checks: OidcChecks = { state: client.randomState(), nonce: client.randomNonce(), verifier };
      const params: Record<string, string> = {
        redirect_uri: redirectUri,
        scope: 'openid email profile',
        response_type: 'code',
        code_challenge: await client.calculatePKCECodeChallenge(verifier),
        code_challenge_method: 'S256',
        state: checks.state,
        nonce: checks.nonce,
      };
      if (prompt) params.prompt = prompt;
      return { url: client.buildAuthorizationUrl(cfg, params).href, checks };
    },

    async finish(currentUrl, checks) {
      const cfg = await config();
      const tokens = await client.authorizationCodeGrant(cfg, currentUrl, {
        pkceCodeVerifier: checks.verifier,
        expectedState: checks.state,
        expectedNonce: checks.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      const email = typeof claims?.email === 'string' ? claims.email.toLowerCase() : null;
      // Google sends a boolean; some providers send the string "true".
      const ev = claims?.email_verified as unknown;
      const subject = typeof claims?.sub === 'string' && claims.sub ? claims.sub : null;
      const name = typeof claims?.name === 'string' && claims.name.trim() ? claims.name.trim().slice(0, 200) : null;
      return { email, emailVerified: ev === true || ev === 'true', subject, name };
    },
  };
}
