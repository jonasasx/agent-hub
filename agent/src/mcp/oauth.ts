import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { auth, discoverOAuthServerInfo, refreshAuthorization } from '@modelcontextprotocol/sdk/client/auth.js';
import type { AuthorizationServerMetadata, OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { PayloadOf, HubMessage } from '@agent-hub/shared';
import type { Logger } from '../log.js';
import { CmdError } from '../sessions/manager.js';
import type { RegistrySnapshot } from './registryCache.js';
import type { McpGateway } from './gateway.js';

type OAuthStart = PayloadOf<HubMessage, 'mcp.oauth.start'>;
type OAuthCallback = PayloadOf<HubMessage, 'mcp.oauth.callback'>;
type OAuthCredentials = PayloadOf<HubMessage, 'mcp.oauth.credentials'>;
interface SavedTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

class OAuthProvider implements OAuthClientProvider {
  readonly clientMetadata: OAuthClientProvider['clientMetadata'];
  stateValue: string;
  tokensValue: OAuthTokens | undefined;
  clientInfo?: OAuthClientInformationMixed;
  codeVerifierValue?: string;
  discovery?: OAuthDiscoveryState;
  authorizationUrl?: URL;

  constructor(
    readonly redirectUrl: string,
    readonly flowId: string,
    readonly serverId: string,
    readonly machineId: string,
    readonly serverUrl: string,
    initialState?: { clientInfo?: OAuthClientInformationMixed; tokens?: OAuthTokens; discovery?: OAuthDiscoveryState },
  ) {
    this.stateValue = randomBytes(32).toString('base64url');
    this.clientInfo = initialState?.clientInfo;
    this.tokensValue = initialState?.tokens;
    this.discovery = initialState?.discovery;
    this.clientMetadata = {
      client_name: 'Agent Hub MCP Gateway',
      redirect_uris: [redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  get state(): () => string {
    return () => this.stateValue;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.clientInfo;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.clientInfo = info;
  }

  tokens(): OAuthTokens | undefined {
    return this.tokensValue;
  }

  saveTokens(tokens: OAuthTokens): void {
    Object.assign(this, { tokensValue: tokens });
  }

  saveCodeVerifier(verifier: string): void {
    this.codeVerifierValue = verifier;
  }

  codeVerifier(): string {
    if (!this.codeVerifierValue) throw new Error('OAuth verifier expired');
    return this.codeVerifierValue;
  }

  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery;
  }
}

/** Session-local OAuth flows and credentials; neither PKCE data nor tokens are written to disk. */
export class McpOAuthManager {
  private readonly pending = new Map<string, { provider: OAuthProvider; expiresAt: number; timer: NodeJS.Timeout }>();
  private readonly providers = new Map<string, OAuthProvider>();
  private readonly credentials = new Map<string, SavedTokens>();
  private readonly refreshes = new Map<string, Promise<string | null>>();
  private machine = '';

  constructor(
    private readonly registry: () => RegistrySnapshot | null,
    private readonly gateway: McpGateway,
    private readonly send: (type: string, payload: unknown) => boolean,
    private readonly log: Logger,
  ) {
    gateway.setOAuthAccess(async serverId => this.accessToken(serverId));
    gateway.setOAuthRefresh(serverId => this.refresh(serverId));
  }

  setMachine(machineId: string): void {
    this.machine = machineId;
  }

  async begin(payload: OAuthStart): Promise<{ flowId: string; authorizationUrl: string; state: string; expiresAt: number }> {
    let target: URL;
    try {
      target = new URL(payload.serverUrl);
    } catch {
      throw new CmdError('oauth_unavailable', 'OAuth server URL is invalid');
    }
    if (payload.machineId !== this.machine || !['http', 'sse'].includes(payload.transport) || !['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
      throw new CmdError('oauth_unavailable', 'OAuth is unavailable for this MCP server on this machine');
    }
    const known = this.registry()?.servers.find(server => server.id === payload.serverId);
    if (known?.url && known.url !== payload.serverUrl) throw new CmdError('oauth_unavailable', 'OAuth server URL does not match the registry');
    const expiresAt = Date.now() + 10 * 60_000;
    for (const [flowId, flow] of this.pending) {
      if (flow.provider.serverId === payload.serverId) {
        clearTimeout(flow.timer);
        flow.provider.codeVerifierValue = undefined;
        flow.provider.stateValue = '';
        flow.provider.authorizationUrl = undefined;
        this.pending.delete(flowId);
      }
    }
    const provider = new OAuthProvider(payload.redirectUri, payload.flowId, payload.serverId, payload.machineId, payload.serverUrl);
    try {
      const result = await auth(provider, { serverUrl: provider.serverUrl });
      if (result !== 'REDIRECT' || !provider.authorizationUrl || !provider.codeVerifierValue) throw new Error('OAuth server did not start an authorization flow');
      const timer = setTimeout(() => {
        const current = this.pending.get(payload.flowId);
        if (current?.provider === provider) {
          provider.codeVerifierValue = undefined;
          provider.stateValue = '';
          provider.authorizationUrl = undefined;
          this.pending.delete(payload.flowId);
        }
      }, expiresAt - Date.now());
      timer.unref();
      this.pending.set(payload.flowId, { provider, expiresAt, timer });
      return { flowId: payload.flowId, authorizationUrl: provider.authorizationUrl.toString(), state: provider.stateValue, expiresAt };
    } catch {
      throw new CmdError('oauth_start_failed', 'MCP OAuth discovery or authorization setup failed');
    }
  }

  async callback(payload: OAuthCallback): Promise<{ ok: true }> {
    const pending = this.pending.get(payload.flowId);
    if (!pending || pending.expiresAt <= Date.now()) {
      if (pending) {
        clearTimeout(pending.timer);
        pending.provider.codeVerifierValue = undefined;
        pending.provider.stateValue = '';
        pending.provider.authorizationUrl = undefined;
      }
      this.pending.delete(payload.flowId);
      throw new CmdError('oauth_flow_expired', 'MCP OAuth flow expired; start sign-in again');
    }
    let callback: URL;
    try {
      callback = new URL(payload.callbackUrl);
    } catch {
      clearTimeout(pending.timer);
      pending.provider.codeVerifierValue = undefined;
      pending.provider.stateValue = '';
      pending.provider.authorizationUrl = undefined;
      this.pending.delete(payload.flowId);
      throw new CmdError('invalid_input', 'MCP OAuth callback URL is invalid');
    }
    const receivedState = callback.searchParams.get('state') ?? '';
    if (!this.sameState(receivedState, pending.provider.stateValue)) throw new CmdError('oauth_state_mismatch', 'MCP OAuth callback state did not match');
    const providerError = callback.searchParams.get('error');
    const code = callback.searchParams.get('code');
    if (providerError || !code) throw new CmdError('oauth_denied', 'MCP OAuth authorization was not completed');
    try {
      const result = await auth(pending.provider, { serverUrl: pending.provider.serverUrl, authorizationCode: code });
      if (result !== 'AUTHORIZED' || !pending.provider.tokensValue?.access_token) throw new Error('OAuth exchange did not return credentials');
      const credentials = this.tokensToCredentials(pending.provider.tokensValue);
      this.credentials.set(pending.provider.serverId, credentials);
      this.providers.set(pending.provider.serverId, pending.provider);
      const delivered = this.send('mcp.oauth.token.update', {
        serverId: pending.provider.serverId,
        machineId: this.machine,
        flowId: pending.provider.flowId,
        accessToken: credentials.accessToken,
        ...(credentials.refreshToken ? { refreshToken: credentials.refreshToken } : {}),
        ...(credentials.expiresAt ? { expiresAt: credentials.expiresAt } : {}),
        oauthClientState: this.serializeClientState(pending.provider),
      });
      if (!delivered) throw new CmdError('oauth_hub_unavailable', 'MCP OAuth credentials could not be delivered to the hub');
      this.send('mcp.oauth.status.update', {
        serverId: pending.provider.serverId,
        machineId: this.machine,
        state: 'signed-in',
        expiresAt: credentials.expiresAt,
      });
      this.pending.delete(payload.flowId);
      clearTimeout(pending.timer);
      pending.provider.codeVerifierValue = undefined;
      pending.provider.stateValue = '';
      pending.provider.authorizationUrl = undefined;
      return { ok: true };
    } catch {
      this.pending.delete(payload.flowId);
      clearTimeout(pending.timer);
      pending.provider.codeVerifierValue = undefined;
      pending.provider.stateValue = '';
      pending.provider.authorizationUrl = undefined;
      this.credentials.delete(pending.provider.serverId);
      this.providers.delete(pending.provider.serverId);
      throw new CmdError('oauth_exchange_failed', 'MCP OAuth token exchange failed');
    }
  }

  receiveCredentials(payload: OAuthCredentials): void {
    if (payload.machineId !== this.machine) return;
    const credentials: SavedTokens = {
      accessToken: payload.accessToken,
      ...(payload.refreshToken ? { refreshToken: payload.refreshToken } : {}),
      ...(payload.expiresAt ? { expiresAt: payload.expiresAt } : {}),
    };
    this.credentials.set(payload.serverId, credentials);
    const state = payload.oauthClientState ? this.parseClientState(payload.oauthClientState) : null;
    if (!state) return;
    const server = this.registry()?.servers.find(item => item.id === payload.serverId);
    const serverUrl = server?.url ?? state.resource;
    if (!serverUrl) return;
    const redirectUri = 'redirect_uris' in state.clientInformation ? String(state.clientInformation.redirect_uris[0]) : serverUrl;
    const provider = new OAuthProvider(redirectUri, randomUUID(), payload.serverId, payload.machineId, serverUrl, {
      clientInfo: state.clientInformation,
      discovery: {
        authorizationServerUrl: state.authorizationServerUrl,
        authorizationServerMetadata: state.metadata,
        ...(state.resource ? { resourceMetadata: { resource: state.resource } } : {}),
      },
      tokens: {
        access_token: payload.accessToken,
        token_type: 'Bearer',
        ...(payload.refreshToken ? { refresh_token: payload.refreshToken } : {}),
        ...(payload.expiresAt ? { expires_in: Math.max(0, Math.floor((payload.expiresAt - Date.now()) / 1000)) } : {}),
      },
    });
    this.providers.set(payload.serverId, provider);
  }

  revoke(serverId: string, machineId: string): { revoked: boolean } {
    if (machineId !== this.machine) return { revoked: false };
    this.credentials.delete(serverId);
    this.providers.delete(serverId);
    for (const [flowId, flow] of this.pending) {
      if (flow.provider.serverId === serverId) {
        clearTimeout(flow.timer);
        flow.provider.codeVerifierValue = undefined;
        flow.provider.stateValue = '';
        flow.provider.authorizationUrl = undefined;
        this.pending.delete(flowId);
      }
    }
    return { revoked: true };
  }

  clear(): void {
    for (const flow of this.pending.values()) {
      clearTimeout(flow.timer);
      flow.provider.codeVerifierValue = undefined;
      flow.provider.stateValue = '';
      flow.provider.authorizationUrl = undefined;
    }
    this.pending.clear();
    this.providers.clear();
    this.credentials.clear();
  }

  private async accessToken(serverId: string): Promise<string | null> {
    const credentials = this.credentials.get(serverId);
    if (!credentials) return null;
    if (credentials.expiresAt && credentials.expiresAt <= Date.now() + 60_000) return this.refresh(serverId);
    return credentials.accessToken;
  }

  private refresh(serverId: string): Promise<string | null> {
    const existing = this.refreshes.get(serverId);
    if (existing) return existing;
    const refresh = this.refreshOnce(serverId).finally(() => {
      if (this.refreshes.get(serverId) === refresh) this.refreshes.delete(serverId);
    });
    this.refreshes.set(serverId, refresh);
    return refresh;
  }

  private async refreshOnce(serverId: string): Promise<string | null> {
    const provider = this.providers.get(serverId);
    const credentials = this.credentials.get(serverId);
    if (!credentials?.refreshToken) return null;
    if (!provider || !provider.clientInfo) {
      this.send('mcp.oauth.status.update', {
        serverId,
        machineId: this.machine,
        state: 'refresh-error',
        error: 'OAuth client registration is unavailable; sign in again',
      });
      return null;
    }
    try {
      const info = provider.discovery ?? (await discoverOAuthServerInfo(provider.serverUrl));
      const tokens = await refreshAuthorization(info.authorizationServerUrl, {
        metadata: info.authorizationServerMetadata,
        clientInformation: provider.clientInfo,
        refreshToken: credentials.refreshToken,
        resource: info.resourceMetadata?.resource,
      });
      provider.saveTokens(tokens);
      const next = this.tokensToCredentials(tokens, credentials.expiresAt);
      this.credentials.set(serverId, next);
      this.send('mcp.oauth.token.update', {
        serverId,
        machineId: this.machine,
        accessToken: next.accessToken,
        ...(next.refreshToken ? { refreshToken: next.refreshToken } : {}),
        ...(next.expiresAt ? { expiresAt: next.expiresAt } : {}),
      });
      this.send('mcp.oauth.status.update', { serverId, machineId: this.machine, state: 'signed-in', expiresAt: next.expiresAt });
      return next.accessToken;
    } catch {
      this.log.warn('MCP OAuth token refresh failed', { serverId });
      this.send('mcp.oauth.status.update', { serverId, machineId: this.machine, state: 'refresh-error', error: 'OAuth token refresh failed' });
      return null;
    }
  }

  private tokensToCredentials(tokens: OAuthTokens, previousExpiry?: number): SavedTokens {
    const expiresAt = tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : previousExpiry;
    return {
      accessToken: tokens.access_token,
      ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    };
  }

  private serializeClientState(provider: OAuthProvider): string | undefined {
    if (!provider.clientInfo || !provider.discovery) return undefined;
    return JSON.stringify({
      authorizationServerUrl: provider.discovery.authorizationServerUrl,
      ...(provider.discovery.resourceMetadata?.resource ? { resource: provider.discovery.resourceMetadata.resource } : {}),
      ...(provider.discovery.authorizationServerMetadata ? { metadata: provider.discovery.authorizationServerMetadata } : {}),
      clientInformation: provider.clientInfo,
    });
  }

  private parseClientState(value: string): {
    authorizationServerUrl: string;
    resource?: string;
    metadata?: AuthorizationServerMetadata;
    clientInformation: OAuthClientInformationMixed;
  } | null {
    try {
      const parsed: unknown = JSON.parse(value);
      if (!parsed || typeof parsed !== 'object') return null;
      const state = parsed as Record<string, unknown>;
      const client = state.clientInformation;
      if (typeof state.authorizationServerUrl !== 'string' || !client || typeof client !== 'object') return null;
      const info = client as Record<string, unknown>;
      if (typeof info.client_id !== 'string') return null;
      if (state.resource !== undefined && typeof state.resource !== 'string') return null;
      if (state.metadata !== undefined && (!state.metadata || typeof state.metadata !== 'object')) return null;
      return {
        authorizationServerUrl: state.authorizationServerUrl,
        ...(typeof state.resource === 'string' ? { resource: state.resource } : {}),
        ...(state.metadata ? { metadata: state.metadata as AuthorizationServerMetadata } : {}),
        clientInformation: info as OAuthClientInformationMixed,
      };
    } catch {
      return null;
    }
  }

  private sameState(received: string, expected: string): boolean {
    const a = Buffer.from(received),
      b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
