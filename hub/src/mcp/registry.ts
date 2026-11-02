import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { sql, type Transaction } from 'kysely';
import type { z } from 'zod';
import {
  MCP_REGISTRY_CAPABILITIES,
  MCP_REGISTRY_PROTOCOL_VERSION,
  mcpDraftConnectSchema,
  mcpDraftCreateSchema,
  mcpDraftRequestPayload,
  mcpDraftSaveUncheckedSchema,
  mcpDraftUpdateSchema,
  mcpDraftValidateSchema,
  mcpSecretInputSchema,
  mcpImportCommitPayload,
  mcpOAuthCredentialSchema,
  mcpOAuthStartResultSchema,
  mcpOAuthStatusUpdateSchema,
  mcpRegistryValidateResultPayload,
  mcpRegistryValidatePayload,
  mcpRegistryOAuthRevokeRequestSchema,
  mcpRegistryOAuthRevokeResponseSchema,
  mcpRegistryOAuthConnectRequestSchema,
  mcpRegistryOAuthConnectResponseSchema,
  mcpRegistryOAuthStartRequestSchema,
  mcpRegistryOAuthStartResponseSchema,
  mcpRegistryOAuthStatusSchema,
  mcpRegistryMachineToggleRequestSchema,
  mcpRegistryMachineToggleResponseSchema,
  mcpRegistryOAuthValidateRequestSchema,
  mcpRegistryOAuthValidateResponseSchema,
  mcpRegistrySessionUpdateAckPayload,
  mcpServerConfigSchema,
  mcpServerConfigPatchInputSchema,
  protocolAtLeast,
} from '@agent-hub/shared';
import type { Database, Db } from '../db/db.js';
import type { HubBus } from '../bus.js';
import { CommandError, type AgentConnection, type AgentGateway } from '../runners/agentGateway.js';
import { HttpError } from '../sessions/service.js';
import { decryptToken, encryptToken, tokenKey } from '../subscriptions/crypto.js';

const MIN = '1.13';
type Cfg = Record<string, unknown>;
function encryptionKey(keyText: string | undefined) {
  if (!keyText) throw new HttpError(503, 'secret_storage_disabled', 'Secret storage is not configured');
  try {
    return tokenKey(keyText);
  } catch {
    throw new HttpError(503, 'secret_storage_disabled', 'Secret storage is not configured');
  }
}
function encryptSecret(keyText: string | undefined, userId: string, id: string, value: string): Buffer {
  return encryptToken(encryptionKey(keyText), `${userId}:${id}`, value);
}
function decryptSecret(keyText: string | undefined, userId: string, id: string, enc: Buffer): string {
  return decryptToken(encryptionKey(keyText), `${userId}:${id}`, enc);
}
function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw new HttpError(400, 'invalid_request', r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data;
}
const safe = (c: Cfg) => ({ ...c, secrets: (Array.isArray(c.secrets) ? c.secrets : []).map((s: Cfg) => ({ ...s, masked: true, state: s.state ?? 'set' })) });
const URL_SECRET_PLACEHOLDER = '__AGENT_HUB_SECRET__';
const OAUTH_FLOW_TTL_MS = 10 * 60_000;
type PendingOAuthFlow = {
  flowId: string;
  userId: string;
  serverId: string;
  machineId: string;
  state: string;
  expiresAt: number;
  callbackForwarded: boolean;
  timer: NodeJS.Timeout;
};
function redactValues(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string') return secrets.reduce((text, secret) => (secret ? text.replaceAll(secret, '[REDACTED]') : text), value);
  if (Array.isArray(value)) return value.map(item => redactValues(item, secrets));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValues(item, secrets)]));
}
function prepareDraftUrlSecrets(input: unknown): { body: unknown; urlSecrets: Map<string, string> } {
  const urlSecrets = new Map<string, string>();
  if (!input || typeof input !== 'object') return { body: input, urlSecrets };
  const request = input as { server?: Cfg; secrets?: Array<{ name: string; value: string }> };
  const writes = request.secrets ?? [];
  const urlWrites = writes.filter(s => s.name.startsWith('url:'));
  const server = { ...(request.server ?? {}) };
  if (!urlWrites.length) return { body: input, urlSecrets };
  if (typeof server.url !== 'string') throw new HttpError(400, 'invalid_request', 'URL secret requires a URL');
  let url: URL;
  try {
    url = new URL(server.url);
  } catch {
    throw new HttpError(400, 'invalid_input', 'URL secret requires a valid URL');
  }
  for (const secret of urlWrites) {
    const key = secret.name.slice(4);
    if (!key) throw new HttpError(400, 'invalid_input', 'URL secret name is required');
    const id = randomUUID();
    if (key === 'username') url.username = URL_SECRET_PLACEHOLDER;
    else if (key === 'password') url.password = URL_SECRET_PLACEHOLDER;
    else url.searchParams.set(key, URL_SECRET_PLACEHOLDER);
    urlSecrets.set(secret.name, id);
  }
  server.url = url.toString();
  server.urlSecretName = urlWrites[0]!.name;
  return { body: { ...request, server }, urlSecrets };
}

export class McpRegistryService {
  private readonly capabilities = new Map<string, Set<string>>();
  private readonly pendingImports = new Map<string, { userId: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readonly pendingValidationResults = new Map<string, { resolve: (value: Cfg | null) => void; timer?: NodeJS.Timeout }>();
  private readonly pendingOAuth = new Map<string, PendingOAuthFlow>();
  constructor(
    private readonly o: {
      db: Db;
      bus: HubBus;
      agents: AgentGateway;
      key?: string;
      publicUrl: string;
      importTimeoutMs?: number;
      validationTimeoutMs?: number;
      oauthFlowTtlMs?: number;
      log: Pick<FastifyBaseLogger, 'info' | 'warn'>;
    },
  ) {
    o.bus.on('agent.hello', (runnerId, userId, hello) => {
      this.capabilities.set(runnerId, new Set(hello.capabilities ?? []));
      if (protocolAtLeast(hello.protocol, MIN)) {
        void this.syncRunner(runnerId, userId).catch((error: unknown) => this.o.log.warn({ runnerId, errorClass: error instanceof Error ? error.name : 'unknown' }, 'MCP registry sync failed'));
      }
    });
    o.bus.on('agent.message', (runnerId, m) => {
      const connection = this.o.agents.get(runnerId);
      if (m.type === 'mcp.registry.validate.result') this.settleValidationResult(runnerId, m.re, m.payload);
      if (m.type === 'mcp.oauth.token.update' && connection && this.capabilities.get(runnerId)?.has('mcp.oauth.v1'))
        void this.storeOAuth(runnerId, connection.userId, m.payload).catch((err: unknown) =>
          this.o.log.warn({ runnerId, errorClass: err instanceof Error ? err.name : 'unknown' }, 'MCP OAuth token update rejected'),
        );
      if (m.type === 'mcp.oauth.status.update' && connection && this.capabilities.get(runnerId)?.has('mcp.oauth.v1'))
        void this.storeOAuthStatus(runnerId, connection.userId, m.payload).catch((err: unknown) =>
          this.o.log.warn({ runnerId, errorClass: err instanceof Error ? err.name : 'unknown' }, 'MCP OAuth status update rejected'),
        );
      if (m.type === 'mcp.gateway.status' && connection)
        void this.storeStatus(runnerId, connection.userId, m.payload).catch((err: unknown) => {
          const error = err as { code?: unknown; constraint?: unknown; issues?: Array<{ path?: unknown[] }> };
          const issuePaths = Array.isArray(error.issues) ? error.issues.map(issue => (issue.path ?? []).map(String).join('.')).filter(Boolean) : [];
          this.o.log.warn(
            {
              runnerId,
              ...(typeof error.code === 'string' ? { errorCode: error.code } : {}),
              ...(typeof error.constraint === 'string' ? { constraint: error.constraint } : {}),
              ...(issuePaths.length ? { issuePaths } : {}),
            },
            'MCP gateway status update rejected',
          );
        });
      if (m.type === 'mcp.registry.session-update.ack')
        void this.storeSessionUpdateAck(runnerId, connection?.userId, m.payload).catch((err: unknown) =>
          this.o.log.warn({ runnerId, errorClass: err instanceof Error ? err.name : 'unknown' }, 'MCP session update acknowledgement rejected'),
        );
      if (m.type === 'mcp.draft.request') void this.handleDraftRequest(runnerId, m.payload);
      if (m.type === 'mcp.import.preview.result')
        void this.storeImportPreview(runnerId, m.payload).catch((err: unknown) => {
          const pending = this.pendingImports.get(runnerId);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingImports.delete(runnerId);
            pending.reject(err instanceof HttpError ? err : new HttpError(503, 'secret_storage_disabled', 'Import secret storage is unavailable'));
          }
          const dbCode = (err as { code?: unknown })?.code;
          this.o.log.warn(
            {
              runnerId,
              code: err instanceof HttpError ? err.code : 'import_failed',
              errorClass: err instanceof Error ? err.name : 'unknown',
              errorSite: err instanceof Error ? err.stack?.split('\n').slice(1, 3).join(' ').slice(0, 300) : undefined,
              ...(typeof dbCode === 'string' && /^\d{5}$/.test(dbCode) ? { dbCode } : {}),
            },
            'MCP import preview rejected',
          );
        });
    });
  }
  private validationResultKey(runnerId: string, requestId: string) {
    return `${runnerId}:${requestId}`;
  }
  private waitForValidationResult(runnerId: string, requestId: string) {
    const key = this.validationResultKey(runnerId, requestId);
    let resolve!: (value: Cfg | null) => void;
    const promise = new Promise<Cfg | null>(done => {
      resolve = done;
    });
    this.pendingValidationResults.set(key, { resolve });
    return {
      promise,
      startTimeout: (timeoutMs: number) => {
        const pending = this.pendingValidationResults.get(key);
        if (!pending || pending.timer) return;
        pending.timer = setTimeout(() => {
          this.pendingValidationResults.delete(key);
          resolve(null);
        }, timeoutMs);
      },
      cancel: () => {
        const pending = this.pendingValidationResults.get(key);
        if (!pending) return;
        if (pending.timer) clearTimeout(pending.timer);
        this.pendingValidationResults.delete(key);
        pending.resolve(null);
      },
    };
  }
  private settleValidationResult(runnerId: string, requestId: string, result: Cfg) {
    const key = this.validationResultKey(runnerId, requestId);
    const pending = this.pendingValidationResults.get(key);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.pendingValidationResults.delete(key);
    pending.resolve(result);
  }
  private async requestValidationResult(connection: AgentConnection, runnerId: string, payload: z.infer<typeof mcpRegistryValidatePayload>) {
    const timeoutMs = this.o.validationTimeoutMs ?? 45_000;
    const requestId = randomUUID();
    const validationReply = this.waitForValidationResult(runnerId, requestId);
    try {
      const rawResult = await connection.request('mcp.registry.validate', payload, timeoutMs, requestId);
      const resultSent = !!rawResult && typeof rawResult === 'object' && (rawResult as Cfg).resultSent === true;
      let validationResult = rawResult;
      if (resultSent) {
        validationReply.startTimeout(timeoutMs);
        let onClose!: () => void;
        const disconnected = new Promise<never>((_, reject) => {
          onClose = () => reject(new CommandError('disconnected', 'Agent disconnected before returning the MCP validation result'));
          connection.ws.once('close', onClose);
          if (connection.ws.readyState !== 1) onClose();
        });
        try {
          validationResult = await Promise.race([validationReply.promise, disconnected]);
        } finally {
          connection.ws.off('close', onClose);
        }
      }
      if (resultSent && !validationResult) throw new CommandError('timeout', 'Agent did not return the MCP validation result');
      return validationResult;
    } finally {
      validationReply.cancel();
    }
  }
  async list(userId: string) {
    const rows = await this.o.db.selectFrom('mcp_registry_servers').select(['id', 'name', 'config', 'enabled', 'revision']).where('user_id', '=', userId).orderBy('name').execute();
    const rev = await this.o.db.selectFrom('mcp_registry_meta').select('revision').where('user_id', '=', userId).executeTakeFirst();
    const servers = await Promise.all(
      rows.map(async r => {
        const refs = (Array.isArray(r.config.secrets) ? r.config.secrets : []) as Array<{ secretId: string; name: string }>;
        const found = refs.length
          ? await this.o.db
              .selectFrom('mcp_secrets')
              .select('id')
              .where('user_id', '=', userId)
              .where('server_id', '=', r.id)
              .where(
                'id',
                'in',
                refs.map(x => x.secretId),
              )
              .execute()
          : [];
        const foundIds = new Set(found.map(x => x.id));
        return {
          ...r.config,
          id: r.id,
          name: r.name,
          enabled: r.enabled,
          revision: Number(r.revision),
          secrets: refs.map(s => ({ secretId: s.secretId, name: s.name, state: foundIds.has(s.secretId) ? 'set' : 'needs-secret', masked: true as const })),
        };
      }),
    );
    return { protocol: MCP_REGISTRY_PROTOCOL_VERSION, revision: Number(rev?.revision ?? 0), generatedAt: Date.now(), registryEnabled: false, servers };
  }
  async view(userId: string) {
    const registry = await this.list(userId);
    const drafts = await this.o.db
      .selectFrom('mcp_registry_drafts')
      .select(['id', 'name', 'config', 'state', 'revision', 'validation'])
      .where('user_id', '=', userId)
      .where('state', 'not in', ['connected', 'saved-unchecked'])
      .orderBy('updated_at', 'desc')
      .limit(100)
      .execute();
    return {
      ...registry,
      drafts: drafts.map(draft => ({
        draftId: draft.id,
        revision: Number(draft.revision),
        state: draft.state,
        server: safe({ ...draft.config, id: draft.config.id ?? draft.id, name: draft.name, revision: Number(draft.revision) }),
        ...(draft.validation ? { validation: draft.validation } : {}),
      })),
    };
  }
  private async resolveConfigSecretBindings(
    userId: string,
    config: Cfg,
    secretWrites: Array<{ name: string; value: string }>,
    generatedIds: Map<string, string>,
    owner: { draftId?: string; serverId?: string },
    trustedConfig: Cfg = {},
  ): Promise<{ config: Cfg; writes: Array<{ id: string; name: string; value: string; existing: boolean }> }> {
    const names = new Set<string>();
    for (const write of secretWrites) {
      if (names.has(write.name)) throw new HttpError(400, 'invalid_input', 'Secret names must be unique');
      names.add(write.name);
    }
    let existingQuery = this.o.db.selectFrom('mcp_secrets').select(['id', 'name']).where('user_id', '=', userId).orderBy('updated_at', 'desc');
    existingQuery = owner.draftId ? existingQuery.where('draft_id', '=', owner.draftId) : existingQuery.where('server_id', '=', owner.serverId!);
    const existingRows = await existingQuery.execute();
    const ownedById = new Map(existingRows.map(row => [row.id, row.name]));
    const ownedByName = new Map<string, { id: string; name: string }>();
    for (const row of existingRows) if (!ownedByName.has(row.name)) ownedByName.set(row.name, row);
    const writes = secretWrites.map(write => {
      const existing = ownedByName.get(write.name);
      return { id: existing?.id ?? generatedIds.get(write.name) ?? randomUUID(), name: write.name, value: write.value, existing: !!existing };
    });
    const writeByName = new Map(writes.map(write => [write.name, write]));
    const writeById = new Map(writes.map(write => [write.id, write]));
    const allowedName = (name: string) => writeByName.get(name) ?? ownedByName.get(name);
    const allowedId = (id: string) => writeById.get(id)?.name ?? ownedById.get(id);
    const trustedIds = new Set<string>();
    const trustedNames = new Map<string, string>();
    const readTrustedReferences = (source: Cfg) => {
      const refs = (Array.isArray(source.secrets) ? source.secrets : []) as Array<{ secretId?: string; name?: string }>;
      for (const ref of refs) {
        if (typeof ref.secretId === 'string') {
          trustedIds.add(ref.secretId);
          if (typeof ref.name === 'string') trustedNames.set(ref.secretId, ref.name);
        }
      }
      if (typeof source.urlSecretId === 'string') trustedIds.add(source.urlSecretId);
      for (const bucket of ['env', 'headers']) {
        for (const value of Object.values((source[bucket] ?? {}) as Record<string, { kind?: string; secretId?: string }>)) {
          if (value.kind === 'secret' && typeof value.secretId === 'string') trustedIds.add(value.secretId);
        }
      }
    };
    readTrustedReferences(trustedConfig);
    const normalized: Cfg = { ...config };
    const refs = new Map<string, { secretId: string; name: string; state: 'set' | 'needs-secret' }>();
    const addRef = (secretId: string, refName: string, state: 'set' | 'needs-secret' = 'set') => refs.set(secretId, { secretId, name: refName, state });
    const inheritedRefs = (Array.isArray(config.secrets) ? config.secrets : []) as Array<{ secretId?: string; name?: string; state?: string }>;
    for (const ref of inheritedRefs) {
      if (typeof ref.secretId !== 'string' || typeof ref.name !== 'string') throw new HttpError(400, 'invalid_input', 'Secret references must include an owned secret id and name');
      const resolvedName = allowedId(ref.secretId) ?? trustedNames.get(ref.secretId);
      const missing = ref.state === 'needs-secret' && trustedIds.has(ref.secretId);
      if (!resolvedName && !missing) throw new HttpError(400, 'invalid_input', 'Secret reference does not belong to this MCP entry');
      addRef(ref.secretId, resolvedName ?? ref.name, missing ? 'needs-secret' : 'set');
    }
    for (const bucket of ['env', 'headers']) {
      const values = { ...((normalized[bucket] ?? {}) as Record<string, Cfg>) };
      for (const [key, rawValue] of Object.entries(values)) {
        const value = { ...rawValue };
        if (value.kind === 'secret-name') {
          const resolved = allowedName(String(value.name ?? ''));
          if (!resolved) throw new HttpError(400, 'invalid_input', 'Secret name is not present in this MCP entry');
          value.kind = 'secret';
          value.secretId = resolved.id;
          delete value.name;
        }
        if (value.kind === 'secret') {
          const secretId = String(value.secretId ?? '');
          const refName = allowedId(secretId) ?? trustedNames.get(secretId);
          if (!refName || (!ownedById.has(secretId) && !writeById.has(secretId) && !trustedIds.has(secretId))) {
            throw new HttpError(400, 'invalid_input', 'Secret reference does not belong to this MCP entry');
          }
          addRef(secretId, refName);
        }
        values[key] = value;
      }
      if (normalized[bucket] !== undefined) normalized[bucket] = values;
    }
    if (typeof normalized.urlSecretName === 'string') {
      const resolved = allowedName(normalized.urlSecretName);
      if (!resolved) throw new HttpError(400, 'invalid_input', 'URL secret name is not present in this MCP entry');
      normalized.urlSecretId = resolved.id;
      delete normalized.urlSecretName;
    }
    if (typeof normalized.urlSecretId === 'string') {
      const urlSecretId = normalized.urlSecretId;
      const refName = allowedId(urlSecretId) ?? trustedNames.get(urlSecretId);
      if (!refName || (!ownedById.has(urlSecretId) && !writeById.has(urlSecretId) && !trustedIds.has(urlSecretId))) {
        throw new HttpError(400, 'invalid_input', 'URL secret reference does not belong to this MCP entry');
      }
      addRef(urlSecretId, refName);
    }
    for (const write of writes) addRef(write.id, write.name);
    normalized.secrets = [...refs.values()];
    return { config: normalized, writes };
  }
  private async persistSecretWrites(
    userId: string,
    owner: { draftId?: string; serverId?: string },
    writes: Array<{ id: string; name: string; value: string; existing: boolean }>,
    db: Db | Transaction<Database> = this.o.db,
  ) {
    for (const write of writes) {
      const ciphertext = encryptSecret(this.o.key, userId, write.id, write.value);
      if (write.existing) {
        let update = db.updateTable('mcp_secrets').set({ ciphertext, updated_at: new Date() }).where('user_id', '=', userId).where('id', '=', write.id);
        update = owner.draftId ? update.where('draft_id', '=', owner.draftId) : update.where('server_id', '=', owner.serverId!);
        await update.execute();
      } else {
        await db
          .insertInto('mcp_secrets')
          .values({
            id: write.id,
            user_id: userId,
            draft_id: owner.draftId ?? null,
            server_id: owner.serverId ?? null,
            import_id: null,
            name: write.name,
            ciphertext,
          })
          .execute();
      }
    }
  }
  async create(userId: string, input: unknown) {
    const prepared = prepareDraftUrlSecrets(input);
    const body = parse(mcpDraftCreateSchema, prepared.body);
    const id = randomUUID();
    const name = String(body.server.name);
    const duplicate = await this.o.db.selectFrom('mcp_registry_servers').select('id').where('user_id', '=', userId).where('name', '=', name).executeTakeFirst();
    if (duplicate) throw new HttpError(409, 'name_taken', 'An MCP server with this name already exists');
    const resolved = await this.resolveConfigSecretBindings(userId, body.server as Cfg, body.secrets ?? [], prepared.urlSecrets, { serverId: id });
    const config = { ...resolved.config, id, revision: 1 } as Cfg;
    parse(mcpServerConfigSchema, config);
    try {
      await this.o.db
        .insertInto('mcp_registry_servers')
        .values({ id, user_id: userId, name, config: JSON.stringify(config) })
        .execute();
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new HttpError(409, 'name_taken', 'An MCP server with this name already exists');
      }
      throw error;
    }
    await this.persistSecretWrites(userId, { serverId: id }, resolved.writes);
    await this.o.db
      .updateTable('mcp_registry_servers')
      .set({ config: JSON.stringify(config) })
      .where('user_id', '=', userId)
      .where('id', '=', id)
      .execute();
    await this.bump(userId);
    await this.audit(userId, 'api', 'server.create', id);
    await this.syncUser(userId);
    return await this.get(userId, id);
  }
  async get(userId: string, id: string) {
    const row = await this.o.db.selectFrom('mcp_registry_servers').select(['id', 'name', 'config', 'enabled', 'revision']).where('user_id', '=', userId).where('id', '=', id).executeTakeFirst();
    if (!row) throw new HttpError(404, 'mcp_server_not_found', 'MCP server not found');
    return { ...row.config, id: row.id, name: row.name, enabled: row.enabled, revision: Number(row.revision), secrets: safe(row.config).secrets };
  }
  async startOAuth(userId: string, serverId: string, body: unknown) {
    const request = parse(mcpRegistryOAuthStartRequestSchema, body);
    const server = await this.o.db.selectFrom('mcp_registry_servers').select(['id', 'config', 'enabled']).where('user_id', '=', userId).where('id', '=', serverId).executeTakeFirst();
    if (!server) throw new HttpError(404, 'mcp_server_not_found', 'MCP server not found');
    if (!server.enabled || server.config.transport === 'stdio') throw new HttpError(409, 'oauth_unsupported', 'OAuth is available for enabled HTTP MCP servers');
    const urlSecretNames = (server.config.secrets as Array<{ name?: string }> | undefined)?.some(secret => secret.name?.startsWith('url:')) === true;
    if (server.config.urlSecretId || urlSecretNames || String(server.config.url).includes(URL_SECRET_PLACEHOLDER)) {
      throw new HttpError(400, 'invalid_input', 'OAuth cannot start until URL secrets are resolved');
    }
    encryptionKey(this.o.key);
    const connection = await this.oauthMachine(userId, serverId, request.machineId, true);
    if (!connection) throw new HttpError(409, 'machine_offline', 'Target machine is offline');
    const flowId = randomUUID();
    const redirectUri = new URL('/mcp/oauth/callback', this.o.publicUrl).toString();
    let result: ReturnType<typeof mcpOAuthStartResultSchema.parse>;
    try {
      result = mcpOAuthStartResultSchema.parse(
        await connection.request('mcp.oauth.start', {
          flowId,
          serverId,
          machineId: request.machineId,
          redirectUri,
          serverUrl: String(server.config.url),
          transport: server.config.transport as 'http' | 'sse',
        }),
      );
    } catch (error) {
      await this.writeOAuthStatus(userId, serverId, request.machineId, 'failed', null, 'OAuth authorization could not be started');
      await this.audit(userId, 'api', 'oauth.start-failed', serverId);
      if (error instanceof CommandError && error.code === 'timeout') throw new HttpError(504, 'timeout', 'OAuth authorization start timed out');
      throw new HttpError(502, 'oauth_start_failed', 'OAuth authorization could not be started');
    }
    const now = Date.now();
    const ttl = this.o.oauthFlowTtlMs ?? OAUTH_FLOW_TTL_MS;
    if (result.flowId !== flowId || result.expiresAt <= now || result.expiresAt > now + ttl) {
      throw new HttpError(502, 'oauth_start_invalid', 'Agent returned an invalid OAuth flow');
    }
    const authorizationUrl = new URL(result.authorizationUrl);
    if (authorizationUrl.protocol !== 'https:' && authorizationUrl.hostname !== 'localhost' && authorizationUrl.hostname !== '127.0.0.1') {
      throw new HttpError(502, 'oauth_start_invalid', 'Agent returned an unsafe authorization URL');
    }
    if (authorizationUrl.searchParams.get('state') !== result.state) throw new HttpError(502, 'oauth_start_invalid', 'Agent returned an invalid OAuth state');
    const callback = authorizationUrl.searchParams.get('redirect_uri');
    if (callback && callback !== redirectUri) throw new HttpError(502, 'oauth_start_invalid', 'Agent returned a mismatched OAuth callback');
    const existingStatuses = await this.o.db.selectFrom('mcp_oauth_statuses').select('machine_id').where('user_id', '=', userId).where('server_id', '=', serverId).execute();
    if (!existingStatuses.length) {
      const scope = server.config.machineScope as { allMachines?: boolean; machineIds?: string[] } | undefined;
      const runners = await this.o.db.selectFrom('runners').select('id').where('user_id', '=', userId).where('state', '=', 'active').execute();
      for (const runner of runners) {
        if (scope && !scope.allMachines && !scope.machineIds?.includes(runner.id)) continue;
        await this.writeOAuthStatus(userId, serverId, runner.id, 'needs-login', null, null, { registryReady: false });
      }
    }
    this.clearOAuthFlowsForServer(userId, serverId);
    const timer = setTimeout(
      () => {
        this.pendingOAuth.delete(result.state);
        void this.writeOAuthStatus(userId, serverId, request.machineId, 'expired', null, null).catch(() => undefined);
      },
      Math.max(1, result.expiresAt - now),
    );
    timer.unref();
    this.pendingOAuth.set(result.state, {
      flowId,
      userId,
      serverId,
      machineId: request.machineId,
      state: result.state,
      expiresAt: result.expiresAt,
      callbackForwarded: false,
      timer,
    });
    await this.writeOAuthStatus(userId, serverId, request.machineId, 'pending', result.expiresAt, null);
    await this.audit(userId, 'api', 'oauth.start', serverId);
    return mcpRegistryOAuthStartResponseSchema.parse({
      serverId,
      machineId: request.machineId,
      state: 'pending',
      authorizationUrl: result.authorizationUrl,
      expiresAt: result.expiresAt,
    });
  }
  async oauthCallback(userId: string, state: string | undefined, callbackUrl: string) {
    if (!state) return null;
    const flow = this.pendingOAuth.get(state);
    if (!flow) return null;
    if (flow.userId !== userId) throw new HttpError(403, 'oauth_flow_forbidden', 'OAuth flow is not available');
    if (flow.expiresAt <= Date.now()) {
      this.removeOAuthFlow(flow);
      await this.writeOAuthStatus(userId, flow.serverId, flow.machineId, 'expired', null, null);
      return { handled: true, ok: false, error: 'OAuth authorization expired' };
    }
    if (flow.callbackForwarded) return { handled: true, ok: true };
    const connection = this.o.agents.get(flow.machineId);
    if (!connection || connection.userId !== userId) {
      this.removeOAuthFlow(flow);
      await this.writeOAuthStatus(userId, flow.serverId, flow.machineId, 'failed', null, 'The selected machine disconnected');
      return { handled: true, ok: false, error: 'The selected machine is unavailable' };
    }
    flow.callbackForwarded = true;
    try {
      const result = (await connection.request('mcp.oauth.callback', { flowId: flow.flowId, callbackUrl })) as Cfg | undefined;
      if (result?.ok === false) {
        this.removeOAuthFlow(flow);
        await this.writeOAuthStatus(userId, flow.serverId, flow.machineId, 'failed', null, 'OAuth authorization was rejected');
        return { handled: true, ok: false, error: 'OAuth authorization was rejected' };
      }
      return { handled: true, ok: true };
    } catch {
      flow.callbackForwarded = false;
      await this.writeOAuthStatus(userId, flow.serverId, flow.machineId, 'failed', null, 'OAuth callback could not be completed');
      return { handled: true, ok: false, error: 'OAuth callback could not be completed' };
    }
  }
  async revokeOAuth(userId: string, serverId: string, body: unknown) {
    const request = parse(mcpRegistryOAuthRevokeRequestSchema, body);
    const server = await this.o.db.selectFrom('mcp_registry_servers').select(['id', 'config']).where('user_id', '=', userId).where('id', '=', serverId).executeTakeFirst();
    if (!server) throw new HttpError(404, 'mcp_server_not_found', 'MCP server not found');
    await this.oauthMachine(userId, serverId, request.machineId, false);
    this.clearOAuthFlowsForServer(userId, serverId);
    await this.o.db.deleteFrom('mcp_oauth_tokens').where('user_id', '=', userId).where('server_id', '=', serverId).execute();
    const scope = server.config.machineScope as { allMachines?: boolean; machineIds?: string[] } | undefined;
    const runners = await this.o.db.selectFrom('runners').select('id').where('user_id', '=', userId).where('state', '=', 'active').execute();
    const allowed = runners.filter(runner => !scope || scope.allMachines === true || scope.machineIds?.includes(runner.id) === true);
    await Promise.all(
      allowed.map(async runner => {
        const connection = this.o.agents.get(runner.id);
        if (connection && this.capabilities.get(runner.id)?.has('mcp.oauth.v1')) {
          try {
            await connection.request('mcp.oauth.revoke', { serverId, machineId: runner.id }, 5000);
          } catch {
            // Offline agents cannot retain OAuth state across reconnect; registry sync omits the deleted credentials.
          }
        }
        await this.writeOAuthStatus(userId, serverId, runner.id, 'needs-login', null, null, { registryReady: false, validationState: 'unchecked', validatedRevision: null });
      }),
    );
    await this.audit(userId, 'api', 'oauth.revoke', serverId);
    await this.syncUser(userId);
    return mcpRegistryOAuthRevokeResponseSchema.parse({ serverId, machineId: request.machineId, state: 'needs-login' });
  }
  async validateOAuthServer(userId: string, serverId: string, body: unknown) {
    const request = parse(mcpRegistryOAuthValidateRequestSchema, body);
    const server = await this.o.db.selectFrom('mcp_registry_servers').select(['config', 'enabled', 'revision']).where('user_id', '=', userId).where('id', '=', serverId).executeTakeFirst();
    if (!server) throw new HttpError(404, 'mcp_server_not_found', 'MCP server not found');
    if (!server.enabled) throw new HttpError(409, 'server_disabled', 'Enable the server before validation');
    const connection = await this.oauthMachine(userId, serverId, request.machineId, true);
    if (!connection) throw new HttpError(409, 'machine_offline', 'Target machine is offline');
    const token = await this.o.db.selectFrom('mcp_oauth_tokens').select('ciphertext').where('user_id', '=', userId).where('server_id', '=', serverId).executeTakeFirst();
    if (!token) throw new HttpError(409, 'oauth_required', 'Sign in to the MCP server before validation');
    await this.deliverOAuthCredentials(userId, serverId, request.machineId);
    const config = { ...server.config, id: serverId, revision: Number(server.revision) } as Cfg;
    const secretRefs = (Array.isArray(config.secrets) ? config.secrets : []) as Array<{ secretId: string }>;
    const secretIds = new Set(secretRefs.map(secret => secret.secretId));
    if (typeof config.urlSecretId === 'string') secretIds.add(config.urlSecretId);
    for (const bucket of ['env', 'headers']) {
      for (const value of Object.values((config[bucket] ?? {}) as Record<string, { kind?: string; secretId?: string }>)) {
        if (value.kind === 'secret' && value.secretId) secretIds.add(value.secretId);
      }
    }
    if (secretIds.size && !this.capabilities.get(request.machineId)?.has('mcp.secrets.encrypted.v1')) {
      throw new HttpError(409, 'agent_outdated', 'Target machine does not support MCP secret delivery');
    }
    const secretRows = secretIds.size
      ? await this.o.db
          .selectFrom('mcp_secrets')
          .select(['id', 'name', 'ciphertext'])
          .where('user_id', '=', userId)
          .where('server_id', '=', serverId)
          .where('id', 'in', [...secretIds])
          .execute()
      : [];
    if (secretRows.length !== secretIds.size) throw new HttpError(409, 'needs_secret', 'One or more referenced secrets have not been saved');
    const secrets = secretRows.map(row => ({ name: row.name, value: decryptSecret(this.o.key, userId, row.id, row.ciphertext) }));
    let rawResult: unknown;
    try {
      rawResult = await this.requestValidationResult(connection, request.machineId, {
        draftId: serverId,
        revision: Number(server.revision),
        machineId: request.machineId,
        server: parse(mcpServerConfigSchema, config),
        ...(secrets.length ? { secretDelivery: { serverId, revision: Number(server.revision), machineId: request.machineId, secrets } } : {}),
      });
    } catch (error) {
      const errorInfo = error as { code?: unknown; issues?: Array<{ path?: unknown[] }> };
      const issuePaths = Array.isArray(errorInfo.issues) ? errorInfo.issues.map(issue => (issue.path ?? []).map(String).join('.')).filter(Boolean) : [];
      this.o.log.warn(
        {
          runnerId: request.machineId,
          serverId,
          errorClass: error instanceof Error ? error.name : 'unknown',
          ...(typeof errorInfo.code === 'string' ? { errorCode: errorInfo.code } : {}),
          ...(issuePaths.length ? { issuePaths } : {}),
        },
        'MCP OAuth validation command failed',
      );
      await this.writeOAuthStatus(userId, serverId, request.machineId, 'signed-in', null, 'Connection validation failed', {
        validationState: 'validation-failed',
        validatedRevision: Number(server.revision),
        registryReady: false,
      });
      throw new HttpError(502, 'validation_failed', 'Connection validation failed');
    }
    const parsedResult = mcpRegistryValidateResultPayload.safeParse(rawResult);
    if (!parsedResult.success || parsedResult.data.draftId !== serverId || parsedResult.data.revision !== Number(server.revision)) {
      await this.writeOAuthStatus(userId, serverId, request.machineId, 'signed-in', null, 'Connection validation returned an invalid result', {
        validationState: 'validation-failed',
        validatedRevision: Number(server.revision),
        registryReady: false,
      });
      await this.audit(userId, 'api', 'oauth.validate-failed', serverId);
      return mcpRegistryOAuthValidateResponseSchema.parse({ serverId, machineId: request.machineId, state: 'validation-failed' });
    }
    const result = parsedResult.data;
    const error = result.error
      ? (redactValues(
          result.error,
          secrets.map(secret => secret.value),
        ) as string)
      : null;
    const state = result.status;
    await this.writeOAuthStatus(userId, serverId, request.machineId, state === 'needs_auth' ? 'needs-login' : 'signed-in', null, error, {
      validationState: state === 'needs-secret' ? 'validation-failed' : state,
      validatedRevision: Number(server.revision),
      registryReady: false,
    });
    await this.audit(userId, 'api', 'oauth.validate', serverId);
    return mcpRegistryOAuthValidateResponseSchema.parse({ serverId, machineId: request.machineId, state: state === 'needs-secret' ? 'validation-failed' : state });
  }
  async connectOAuthServer(userId: string, serverId: string, body: unknown) {
    const request = parse(mcpRegistryOAuthConnectRequestSchema, body);
    const server = await this.o.db.selectFrom('mcp_registry_servers').select('revision').where('user_id', '=', userId).where('id', '=', serverId).executeTakeFirst();
    if (!server) throw new HttpError(404, 'mcp_server_not_found', 'MCP server not found');
    await this.oauthMachine(userId, serverId, request.machineId, false);
    const status = await this.o.db
      .selectFrom('mcp_oauth_statuses')
      .select(['state', 'validation_state', 'validated_revision'])
      .where('user_id', '=', userId)
      .where('server_id', '=', serverId)
      .where('machine_id', '=', request.machineId)
      .executeTakeFirst();
    if (!status || status.state !== 'signed-in') throw new HttpError(409, 'oauth_required', 'Sign in to the MCP server before connecting');
    if (status.validation_state !== 'checked' || status.validated_revision !== String(server.revision)) {
      throw new HttpError(409, 'validation_required', 'Run a successful connection check before connecting');
    }
    await this.writeOAuthStatus(userId, serverId, request.machineId, 'signed-in', null, null, { registryReady: true });
    await this.audit(userId, 'api', 'oauth.connect', serverId);
    await this.syncUser(userId);
    return mcpRegistryOAuthConnectResponseSchema.parse({ serverId, machineId: request.machineId, state: 'connected' });
  }
  async status(userId: string) {
    await this.expireOAuthStatuses(userId);
    const [q, runners, meta] = await Promise.all([
      this.o.db
        .selectFrom('mcp_gateway_statuses')
        .innerJoin('mcp_registry_servers', 'mcp_registry_servers.id', 'mcp_gateway_statuses.server_id')
        .innerJoin('runners', 'runners.id', 'mcp_gateway_statuses.machine_id')
        .select([
          'mcp_gateway_statuses.server_id',
          'mcp_registry_servers.name as server_name',
          'mcp_gateway_statuses.machine_id',
          'runners.name as machine_name',
          'mcp_gateway_statuses.session_id',
          'mcp_gateway_statuses.status',
          'mcp_gateway_statuses.endpoint',
          'mcp_gateway_statuses.error',
          'mcp_gateway_statuses.observed_at',
        ])
        .where('mcp_registry_servers.user_id', '=', userId)
        .where('runners.user_id', '=', userId)
        .orderBy('mcp_registry_servers.name')
        .orderBy('runners.name')
        .orderBy('mcp_gateway_statuses.observed_at', 'desc')
        .execute(),
      this.o.db
        .selectFrom('runners')
        .select(['id', 'name', 'online', 'protocol_version', 'state', 'mcp_registry_enabled'])
        .where('user_id', '=', userId)
        .where('state', '!=', 'pending')
        .orderBy('name')
        .execute(),
      this.o.db.selectFrom('mcp_registry_meta').select('revision').where('user_id', '=', userId).executeTakeFirst(),
    ]);
    const oauthRows = await this.o.db
      .selectFrom('mcp_oauth_statuses')
      .select(['server_id', 'machine_id', 'state', 'validation_state', 'registry_ready', 'expires_at', 'error'])
      .where('user_id', '=', userId)
      .orderBy('updated_at', 'desc')
      .execute();
    const updates = await this.o.db
      .selectFrom('mcp_registry_session_updates')
      .select(['server_id', 'session_id', 'revision', 'activation', 'applied', 'error', 'updated_at'])
      .where('user_id', '=', userId)
      .orderBy('updated_at', 'desc')
      .limit(200)
      .execute();
    return {
      revision: Number(meta?.revision ?? 0),
      oauth: oauthRows.map(row =>
        mcpRegistryOAuthStatusSchema.parse({
          serverId: row.server_id,
          machineId: row.machine_id,
          state: row.state,
          validationState: row.validation_state,
          connected: row.registry_ready,
          ...(row.expires_at ? { expiresAt: new Date(row.expires_at).getTime() } : {}),
          ...(row.error ? { error: row.error } : {}),
        }),
      ),
      agents: runners.map(runner => ({
        machineId: runner.id,
        machineName: runner.name,
        online: runner.online,
        protocolVersion: runner.protocol_version ?? '0.0',
        capabilities: [...(this.capabilities.get(runner.id) ?? [])],
        registryEnabled: runner.mcp_registry_enabled,
      })),
      gateways: q.map(x => ({
        serverId: x.server_id,
        machineId: x.machine_id,
        ...(x.session_id ? { sessionId: x.session_id } : {}),
        status: x.status,
        ...(x.endpoint ? { endpoint: x.endpoint } : {}),
        ...(x.error ? { error: x.error.slice(0, 500) } : {}),
        observedAt: new Date(x.observed_at).getTime(),
      })),
      sessionUpdates: updates.map(x => ({
        serverId: x.server_id,
        sessionId: x.session_id,
        revision: Number(x.revision),
        activation: x.activation,
        applied: x.applied,
        error: x.error,
        updatedAt: new Date(x.updated_at).getTime(),
      })),
    };
  }
  async setMachineRegistryEnabled(userId: string, machineId: string, body: unknown) {
    const request = parse(mcpRegistryMachineToggleRequestSchema, body);
    const machine = await this.o.db.selectFrom('runners').select('id').where('id', '=', machineId).where('user_id', '=', userId).where('state', '!=', 'pending').executeTakeFirst();
    if (!machine) throw new HttpError(404, 'machine_not_found', 'Machine not found');
    await this.o.db.updateTable('runners').set({ mcp_registry_enabled: request.enabled }).where('id', '=', machineId).where('user_id', '=', userId).execute();
    await this.audit(userId, 'api', request.enabled ? 'machine.registry-enable' : 'machine.registry-disable', null);
    await this.syncRunner(machineId, userId);
    return mcpRegistryMachineToggleResponseSchema.parse({ machineId, registryEnabled: request.enabled });
  }
  async patch(userId: string, id: string, revision: number, input: unknown) {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new HttpError(400, 'invalid_request', 'revision is required');
    const owned = await this.o.db.selectFrom('mcp_registry_servers').select(['id', 'name', 'config', 'enabled']).where('user_id', '=', userId).where('id', '=', id).executeTakeFirst();
    if (!owned) throw new HttpError(404, 'mcp_server_not_found', 'MCP server not found');
    const request = (input && typeof input === 'object' ? input : {}) as Cfg;
    const fields = parse(mcpServerConfigPatchInputSchema, request.server ?? request);
    const secretWrites = parse(mcpSecretInputSchema, request.secrets ?? []);
    const merged = {
      ...owned.config,
      ...fields,
      id,
      name: fields.name ?? owned.name,
      enabled: fields.enabled ?? owned.enabled,
      revision: revision + 1,
      secrets: owned.config.secrets ?? [],
    } as Cfg;
    const resolved = await this.resolveConfigSecretBindings(userId, merged, secretWrites, new Map(), { serverId: id }, owned.config);
    const patch = parse(mcpServerConfigSchema, resolved.config) as Cfg & { name: string; enabled: boolean; secrets: Array<{ secretId: string; name: string; state: string }> };
    const updated = await this.o.db
      .updateTable('mcp_registry_servers')
      .set({
        name: patch.name,
        enabled: patch.enabled,
        config: JSON.stringify({
          ...patch,
          revision: revision + 1,
          secrets: patch.secrets.map(s => ({ secretId: s.secretId, name: s.name, state: s.state })),
        }),
        revision: revision + 1,
        updated_at: new Date(),
      })
      .where('user_id', '=', userId)
      .where('id', '=', id)
      .where('revision', '=', String(revision))
      .returning('id')
      .executeTakeFirst();
    if (!updated) throw new HttpError(409, 'revision_conflict', 'Registry revision changed');
    await this.persistSecretWrites(userId, { serverId: id }, resolved.writes);
    await this.bump(userId);
    await this.audit(userId, 'api', 'server.update', id);
    await this.syncUser(userId);
    return this.get(userId, id);
  }
  async projectOverride(userId: string, serverId: string, projectId: string) {
    const server = await this.o.db.selectFrom('mcp_registry_servers').select('id').where('user_id', '=', userId).where('id', '=', serverId).executeTakeFirst();
    if (!server) throw new HttpError(404, 'mcp_server_not_found', 'MCP server not found');
    const project = await this.o.db.selectFrom('catalog_projects').select('id').where('user_id', '=', userId).where('id', '=', projectId).executeTakeFirst();
    if (!project) throw new HttpError(404, 'project_not_found', 'Project not found');
    const row = await this.o.db
      .selectFrom('mcp_registry_overrides')
      .select(['enabled', 'revision'])
      .where('user_id', '=', userId)
      .where('server_id', '=', serverId)
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    return { serverId, projectId, enabled: row?.enabled ?? null, revision: Number(row?.revision ?? 0) };
  }
  async setProjectOverride(userId: string, serverId: string, projectId: string, body: unknown) {
    const b = body as { revision?: number; enabled?: boolean };
    if (!Number.isSafeInteger(b?.revision) || typeof b.enabled !== 'boolean') {
      throw new HttpError(400, 'invalid_request', 'revision and enabled are required');
    }
    const current = await this.projectOverride(userId, serverId, projectId);
    if (current.revision !== b.revision) throw new HttpError(409, 'revision_conflict', 'Project override revision changed');
    const nextRevision = current.revision + 1;
    const saved = await this.o.db
      .insertInto('mcp_registry_overrides')
      .values({ user_id: userId, server_id: serverId, project_id: projectId, enabled: b.enabled, config: null, revision: nextRevision })
      .onConflict(conflict =>
        conflict.columns(['user_id', 'project_id', 'server_id']).doUpdateSet({ enabled: b.enabled, revision: nextRevision }).where('mcp_registry_overrides.revision', '=', String(current.revision)),
      )
      .returning('revision')
      .executeTakeFirst();
    if (!saved) throw new HttpError(409, 'revision_conflict', 'Project override revision changed');
    await this.bump(userId);
    await this.audit(userId, 'api', 'server.project-override', serverId);
    await this.syncUser(userId);
    return { serverId, projectId, enabled: b.enabled, revision: nextRevision };
  }
  async clearProjectOverride(userId: string, serverId: string, projectId: string, revision: number) {
    const current = await this.projectOverride(userId, serverId, projectId);
    if (current.revision !== revision) throw new HttpError(409, 'revision_conflict', 'Project override revision changed');
    if (current.revision === 0) return { ok: true };
    const deleted = await this.o.db
      .deleteFrom('mcp_registry_overrides')
      .where('user_id', '=', userId)
      .where('server_id', '=', serverId)
      .where('project_id', '=', projectId)
      .where('revision', '=', String(revision))
      .returning('server_id')
      .executeTakeFirst();
    if (!deleted) throw new HttpError(409, 'revision_conflict', 'Project override revision changed');
    await this.bump(userId);
    await this.audit(userId, 'api', 'server.project-override.clear', serverId);
    await this.syncUser(userId);
    return { ok: true };
  }
  async remove(userId: string, id: string, revision: number) {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new HttpError(400, 'invalid_request', 'revision is required');
    const owned = await this.o.db.selectFrom('mcp_registry_servers').select('id').where('user_id', '=', userId).where('id', '=', id).executeTakeFirst();
    if (!owned) throw new HttpError(404, 'mcp_server_not_found', 'MCP server not found');
    const deleted = await this.o.db.deleteFrom('mcp_registry_servers').where('user_id', '=', userId).where('id', '=', id).where('revision', '=', String(revision)).returning('id').executeTakeFirst();
    if (!deleted) throw new HttpError(409, 'revision_conflict', 'Registry revision changed');
    await this.bump(userId);
    await this.audit(userId, 'api', 'server.delete', id);
    await this.syncUser(userId);
    return { ok: true };
  }
  async draft(userId: string, body: unknown, actor = 'api') {
    const prepared = prepareDraftUrlSecrets(body);
    const b = parse(mcpDraftCreateSchema, prepared.body);
    const id = randomUUID();
    const name = String(b.server.name);
    const existingServer = await this.o.db.selectFrom('mcp_registry_servers').select('id').where('user_id', '=', userId).where('name', '=', name).executeTakeFirst();
    const existingDraft = await this.o.db
      .selectFrom('mcp_registry_drafts')
      .select('id')
      .where('user_id', '=', userId)
      .where('name', '=', name)
      .where('state', 'not in', ['connected', 'saved-unchecked'])
      .executeTakeFirst();
    if (existingServer || existingDraft) throw new HttpError(409, 'name_taken', 'An MCP server or draft already uses this name');
    const resolved = await this.resolveConfigSecretBindings(userId, b.server as Cfg, b.secrets ?? [], prepared.urlSecrets, { draftId: id });
    const config = { ...resolved.config, id, revision: 1 } as Cfg;
    parse(mcpServerConfigSchema, config);
    const sessionId = actor === 'api' || actor === 'tool' ? null : actor;
    await this.o.db
      .insertInto('mcp_registry_drafts')
      .values({ id, user_id: userId, name, state: 'draft', config: JSON.stringify(config), session_id: sessionId, runner_id: null })
      .execute();
    await this.persistSecretWrites(userId, { draftId: id }, resolved.writes);
    await this.o.db
      .updateTable('mcp_registry_drafts')
      .set({ config: JSON.stringify(config) })
      .where('user_id', '=', userId)
      .where('id', '=', id)
      .execute();
    await this.audit(userId, actor, 'draft.create', null, id);
    return { draftId: id, revision: 1, state: 'draft', server: safe(config) };
  }
  async updateDraft(userId: string, id: string, body: unknown, actor = 'api') {
    const row = await this.o.db.selectFrom('mcp_registry_drafts').select(['config', 'revision', 'state']).where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
    if (!row) throw new HttpError(404, 'draft_not_found', 'Draft not found');
    const prepared = prepareDraftUrlSecrets(body);
    const b = parse(mcpDraftUpdateSchema, prepared.body);
    if (Number(row.revision) !== b.revision) throw new HttpError(409, 'revision_conflict', 'Draft revision changed');
    const merged = { ...row.config, ...b.server, revision: b.revision + 1, secrets: [...((row.config.secrets ?? []) as unknown[])] } as Cfg;
    const resolved = await this.resolveConfigSecretBindings(userId, merged, b.secrets ?? [], prepared.urlSecrets, { draftId: id }, row.config);
    const config: Cfg = { ...resolved.config, id: row.config.id ?? id, revision: b.revision + 1 };
    parse(mcpServerConfigSchema, config);
    await this.o.db.transaction().execute(async trx => {
      const updated = await trx
        .updateTable('mcp_registry_drafts')
        .set({ config: JSON.stringify(config), name: String(config.name), revision: b.revision + 1, state: 'draft', validation: null, updated_at: new Date() })
        .where('id', '=', id)
        .where('user_id', '=', userId)
        .where('revision', '=', String(b.revision))
        .where('state', 'not in', ['connected', 'saved-unchecked'])
        .returning('id')
        .executeTakeFirst();
      if (!updated) throw new HttpError(409, 'revision_conflict', 'Draft revision changed');
      await this.persistSecretWrites(userId, { draftId: id }, resolved.writes, trx);
    });
    await this.audit(userId, actor, 'draft.update', null, id);
    return { draftId: id, revision: b.revision + 1, state: 'draft', server: safe(config) };
  }
  async getDraft(userId: string, id: string) {
    const r = await this.o.db
      .selectFrom('mcp_registry_drafts')
      .select(['config', 'revision', 'state', 'validation', 'session_id'])
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!r) throw new HttpError(404, 'draft_not_found', 'Draft not found');
    const sessionUpdate = r.session_id
      ? await this.o.db
          .selectFrom('mcp_registry_session_updates')
          .select(['revision', 'activation', 'applied', 'error', 'updated_at'])
          .where('user_id', '=', userId)
          .where('session_id', '=', r.session_id)
          .where('server_id', '=', String(r.config.id ?? ''))
          .orderBy('revision', 'desc')
          .executeTakeFirst()
      : undefined;
    return {
      draftId: id,
      revision: Number(r.revision),
      state: r.state,
      server: safe({ ...r.config, revision: Number(r.revision) }),
      ...(r.validation ? { validation: r.validation } : {}),
      ...(sessionUpdate
        ? {
            sessionUpdate: {
              revision: Number(sessionUpdate.revision),
              activation: sessionUpdate.activation,
              applied: sessionUpdate.applied,
              error: sessionUpdate.error,
              updatedAt: new Date(sessionUpdate.updated_at).getTime(),
            },
          }
        : {}),
    };
  }
  async validate(userId: string, id: string, body: unknown) {
    const row = await this.o.db.selectFrom('mcp_registry_drafts').select(['config', 'revision']).where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
    if (!row) throw new HttpError(404, 'draft_not_found', 'Draft not found');
    const b = parse(mcpDraftValidateSchema, body);
    if (Number(row.revision) !== b.revision) throw new HttpError(409, 'revision_conflict', 'Draft revision changed');
    const r = await this.o.db.selectFrom('runners').select(['protocol_version', 'user_id', 'name']).where('id', '=', b.machineId).where('user_id', '=', userId).executeTakeFirst();
    if (!r) throw new HttpError(403, 'forbidden', 'Machine access denied');
    if (!protocolAtLeast(r.protocol_version, MIN) || !this.capabilities.get(b.machineId)?.has('mcp.registry.v1')) {
      throw new HttpError(409, 'agent_outdated', 'Agent does not support MCP registry');
    }
    if (!this.capabilities.get(b.machineId)?.has('mcp.gateway.streamable-http.v1')) {
      throw new HttpError(409, 'agent_outdated', 'Agent does not support MCP gateway validation');
    }
    if (!this.o.agents.isOnline(b.machineId)) throw new HttpError(409, 'runner_offline', 'Target machine is offline');
    const cfg: Cfg = { ...row.config, revision: b.revision };
    const scope = cfg.machineScope as { allMachines?: boolean; machineIds?: string[] } | undefined;
    if (scope && !scope.allMachines && !scope.machineIds?.includes(b.machineId)) throw new HttpError(403, 'machine_not_allowed', 'Target machine is outside the server allow-list');
    const refs = new Set<string>();
    for (const bucket of ['env', 'headers'])
      for (const v of Object.values((cfg[bucket] ?? {}) as Record<string, { kind?: string; secretId?: string }>)) if (v.kind === 'secret' && v.secretId) refs.add(v.secretId);
    if (typeof cfg.urlSecretId === 'string') refs.add(cfg.urlSecretId);
    for (const secret of (cfg.secrets ?? []) as Array<{ secretId?: string }>) {
      if (typeof secret.secretId === 'string') refs.add(secret.secretId);
    }
    if (refs.size && !this.capabilities.get(b.machineId)?.has('mcp.secrets.encrypted.v1')) {
      throw new HttpError(409, 'agent_outdated', 'Agent does not support MCP secret delivery');
    }
    const secretRows = refs.size
      ? await this.o.db
          .selectFrom('mcp_secrets')
          .select(['id', 'name', 'ciphertext'])
          .where('user_id', '=', userId)
          .where('draft_id', '=', id)
          .where('id', 'in', [...refs])
          .execute()
      : [];
    const secrets = secretRows.map(s => ({ name: s.name, value: decryptSecret(this.o.key, userId, s.id, s.ciphertext) }));
    if (secrets.length !== refs.size) {
      const marked = await this.o.db
        .updateTable('mcp_registry_drafts')
        .set({ state: 'needs-secret' })
        .where('user_id', '=', userId)
        .where('id', '=', id)
        .where('revision', '=', String(b.revision))
        .returning('id')
        .executeTakeFirst();
      if (!marked) throw new HttpError(409, 'revision_conflict', 'Draft changed during validation');
      throw new HttpError(409, 'needs_secret', 'One or more referenced secrets have not been saved');
    }
    const command = this.o.agents.get(b.machineId)!;
    const validating = await this.o.db
      .updateTable('mcp_registry_drafts')
      .set({ state: 'validating', runner_id: b.machineId, updated_at: new Date() })
      .where('user_id', '=', userId)
      .where('id', '=', id)
      .where('revision', '=', String(b.revision))
      .where('state', 'in', ['draft', 'checked', 'validation-failed', 'needs-secret', 'needs_auth'])
      .returning('id')
      .executeTakeFirst();
    if (!validating) throw new HttpError(409, 'revision_conflict', 'Draft changed before validation started');
    let result: Cfg;
    try {
      const validationResult = await this.requestValidationResult(command, b.machineId, {
        draftId: id,
        revision: b.revision,
        machineId: b.machineId,
        server: parse(mcpServerConfigSchema, cfg),
        ...(secrets.length ? { secretDelivery: { serverId: cfg.id as string, revision: b.revision, machineId: b.machineId, secrets } } : {}),
      });
      const parsed = mcpRegistryValidateResultPayload.safeParse(validationResult);
      if (!parsed.success) {
        const issuePaths = parsed.error.issues.map(issue => issue.path.map(String).join('.')).filter(Boolean);
        throw new HttpError(502, 'validation_failed', `Connection check returned an invalid result${issuePaths.length ? ` at ${issuePaths.join(', ')}` : ''}`);
      }
      if (parsed.data.draftId !== id || parsed.data.revision !== b.revision) {
        throw new HttpError(502, 'validation_failed', 'Connection check returned a result for a different draft revision');
      }
      result = parsed.data as unknown as Cfg;
    } catch (error) {
      const errorInfo = error as { code?: unknown; issues?: Array<{ path?: unknown[] }> };
      const issuePaths = Array.isArray(errorInfo.issues) ? errorInfo.issues.map(issue => (issue.path ?? []).map(String).join('.')).filter(Boolean) : undefined;
      this.o.log.warn(
        {
          runnerId: b.machineId,
          draftId: id,
          ...(typeof errorInfo.code === 'string' ? { errorCode: errorInfo.code } : {}),
          errorClass: error instanceof Error ? error.name : 'unknown',
          ...(issuePaths?.length ? { issuePaths } : {}),
        },
        'MCP registry validation failed',
      );
      const timedOut = error instanceof CommandError && error.code === 'timeout';
      const failure = { ok: false, status: 'validation-failed', error: timedOut ? 'Connection check timed out' : 'Connection check failed' };
      await this.o.db
        .updateTable('mcp_registry_drafts')
        .set({ state: 'validation-failed', validation: JSON.stringify(failure), updated_at: new Date() })
        .where('user_id', '=', userId)
        .where('id', '=', id)
        .where('revision', '=', String(b.revision))
        .where('state', '=', 'validating')
        .execute();
      const current = await this.o.db.selectFrom('mcp_registry_drafts').select('revision').where('user_id', '=', userId).where('id', '=', id).executeTakeFirst();
      if (Number(current?.revision) !== b.revision) throw new HttpError(409, 'revision_conflict', 'Draft changed during validation');
      await this.audit(userId, 'api', 'draft.validate-failed', null, id);
      throw new HttpError(timedOut ? 504 : 502, timedOut ? 'timeout' : 'validation_failed', failure.error);
    }
    const safeResult = redactValues(
      result,
      secrets.map(secret => secret.value),
    ) as Cfg;
    const state = String(safeResult.status);
    const saved = await this.o.db
      .updateTable('mcp_registry_drafts')
      .set({ state: state as 'checked' | 'validation-failed' | 'needs-secret' | 'needs_auth', validation: JSON.stringify(safeResult), updated_at: new Date() })
      .where('user_id', '=', userId)
      .where('id', '=', id)
      .where('revision', '=', String(b.revision))
      .where('state', '=', 'validating')
      .returning('id')
      .executeTakeFirst();
    if (!saved) throw new HttpError(409, 'revision_conflict', 'Draft changed during validation');
    await this.audit(userId, 'api', 'draft.validate', null, id);
    return { draftId: id, revision: b.revision, state, server: safe(cfg), validation: safeResult };
  }
  async connect(userId: string, id: string, body: unknown, unchecked = false) {
    const row = await this.o.db
      .selectFrom('mcp_registry_drafts')
      .select(['config', 'revision', 'state', 'validation', 'runner_id', 'session_id'])
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!row) throw new HttpError(404, 'draft_not_found', 'Draft not found');
    const b = unchecked ? parse(mcpDraftSaveUncheckedSchema, body) : parse(mcpDraftConnectSchema, body);
    if (Number(row.revision) !== b.revision) throw new HttpError(409, 'revision_conflict', 'Draft revision changed');
    if (!unchecked && Number(row.validation?.revision) !== b.revision) {
      throw new HttpError(409, 'validation_required', 'A successful check for this draft revision is required');
    }
    const needsAuth = !unchecked && row.state === 'needs_auth' && row.validation?.oauthRequired === true;
    if (!unchecked && !needsAuth && (row.state !== 'checked' || row.validation?.ok !== true)) throw new HttpError(409, 'validation_required', 'A successful connection check is required');
    const name = String(row.config.name);
    const exists = await this.o.db.selectFrom('mcp_registry_servers').select('id').where('user_id', '=', userId).where('name', '=', name).executeTakeFirst();
    if (exists) throw new HttpError(409, 'name_taken', 'An MCP server with this name already exists');
    const idServer = randomUUID();
    const config: Cfg = { ...row.config, id: idServer, revision: 1 };
    const state = unchecked ? 'saved-unchecked' : 'connected';
    const allowedStates: Array<'draft' | 'checked' | 'validation-failed' | 'needs-secret' | 'needs_auth'> = unchecked
      ? ['draft', 'checked', 'validation-failed', 'needs-secret', 'needs_auth']
      : ['checked', 'needs_auth'];
    try {
      await this.o.db.transaction().execute(async trx => {
        const claimed = await trx
          .updateTable('mcp_registry_drafts')
          .set({ state, config: JSON.stringify({ ...row.config, id: idServer }), updated_at: new Date() })
          .where('user_id', '=', userId)
          .where('id', '=', id)
          .where('revision', '=', String(b.revision))
          .where('state', 'in', allowedStates)
          .returning('id')
          .executeTakeFirst();
        if (!claimed) throw new HttpError(409, 'revision_conflict', 'Draft changed before connect');
        await trx
          .insertInto('mcp_registry_servers')
          .values({ id: idServer, user_id: userId, name, config: JSON.stringify(config), enabled: config.enabled !== false })
          .execute();
        await trx.updateTable('mcp_secrets').set({ server_id: idServer, draft_id: null, updated_at: new Date() }).where('user_id', '=', userId).where('draft_id', '=', id).execute();
      });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if ((error as { code?: string }).code === '23505') throw new HttpError(409, 'name_taken', 'An MCP server with this name already exists');
      throw error;
    }
    if (needsAuth) {
      const scope = config.machineScope as { allMachines?: boolean; machineIds?: string[] } | undefined;
      const runners = await this.o.db.selectFrom('runners').select('id').where('user_id', '=', userId).where('state', '=', 'active').execute();
      for (const runner of runners) {
        if (scope && !scope.allMachines && !scope.machineIds?.includes(runner.id)) continue;
        await this.writeOAuthStatus(userId, idServer, runner.id, 'needs-login', null, null, {
          validationState: 'needs_auth',
          validatedRevision: 1,
          registryReady: false,
        });
      }
    }
    const registryRevision = await this.bump(userId);
    await this.audit(userId, 'api', unchecked ? 'draft.save-unchecked' : 'draft.connect', idServer, id);
    await this.syncUser(userId);
    let sessionUpdate: Cfg | undefined;
    if (!needsAuth && !unchecked && row.session_id && row.runner_id && this.capabilities.get(row.runner_id)?.has('mcp.registry.v1')) {
      const current = await this.o.db.selectFrom('sessions').select(['user_id', 'runner_id']).where('id', '=', row.session_id).where('user_id', '=', userId).executeTakeFirst();
      if (current?.runner_id === row.runner_id) {
        await this.o.db
          .insertInto('mcp_registry_session_updates')
          .values({
            user_id: userId,
            runner_id: row.runner_id,
            session_id: row.session_id,
            server_id: idServer,
            revision: registryRevision,
            activation: 'deferred',
            applied: false,
            error: 'Awaiting agent acknowledgement',
          })
          .onConflict(conflict =>
            conflict.columns(['session_id', 'revision']).doUpdateSet({
              server_id: idServer,
              activation: 'deferred',
              applied: false,
              error: 'Awaiting agent acknowledgement',
              updated_at: new Date(),
            }),
          )
          .execute();
        this.o.agents
          .get(row.runner_id)
          ?.send('mcp.registry.session-update', { sessionId: row.session_id, revision: registryRevision, server: parse(mcpServerConfigSchema, config), activation: 'connected-live' });
        sessionUpdate = { activation: 'pending', applied: false };
      }
    }
    return { serverId: idServer, state: needsAuth ? 'needs-login' : state, server: safe(config), ...(sessionUpdate ? { sessionUpdate } : {}) };
  }
  async importPreview(userId: string, machineId: string, projectRoot: string) {
    const c = this.o.agents.get(machineId);
    if (!c) throw new HttpError(409, 'runner_offline', 'Target machine is offline');
    const runner = await this.o.db.selectFrom('runners').select(['user_id', 'protocol_version']).where('id', '=', machineId).where('user_id', '=', userId).executeTakeFirst();
    if (!runner) throw new HttpError(403, 'forbidden', 'Machine access denied');
    if (!protocolAtLeast(runner.protocol_version, MIN) || !this.capabilities.get(machineId)?.has('mcp.registry.v1')) throw new HttpError(409, 'agent_outdated', 'Agent does not support import');
    if (this.pendingImports.has(machineId)) throw new HttpError(409, 'import_busy', 'An import scan is already running on this machine');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingImports.delete(machineId);
        reject(new HttpError(504, 'timeout', 'Import scan timed out'));
      }, this.o.importTimeoutMs ?? 45_000);
      this.pendingImports.set(machineId, { userId, resolve, reject, timer });
      c.send('mcp.import.preview', { machineId, projectRoot }, { id: randomUUID() });
    });
  }
  async importCommit(userId: string, body: unknown) {
    const b = parse(mcpImportCommitPayload, body);
    if (new Set(b.serverIds).size !== b.serverIds.length) throw new HttpError(400, 'invalid_request', 'Selected serverIds must be unique');
    const found = await this.o.db
      .selectFrom('mcp_registry_imports')
      .select(['preview', 'state'])
      .where('id', '=', b.importId)
      .where('user_id', '=', userId)
      .where('expires_at', '>', new Date())
      .executeTakeFirst();
    if (!found) throw new HttpError(404, 'import_not_found', 'Import preview not found');
    if (found.preview.revision !== b.revision) throw new HttpError(409, 'revision_conflict', 'Import preview revision changed');
    if (found.state !== 'preview') throw new HttpError(409, 'import_already_committed', 'Import preview was already committed');
    const previewServers = found.preview.servers as Cfg[];
    const selectedIds = new Set(b.serverIds);
    const selected = previewServers.filter(server => selectedIds.has(String(server.id)));
    if (selected.length !== selectedIds.size) throw new HttpError(400, 'invalid_request', 'One or more selected servers are not in this preview');
    const drafts = [];
    for (const server of selected) {
      const { revision: _revision, secrets, source: _source, ...candidate } = server;
      const refs = (secrets as Array<{ secretId: string; name: string }> | undefined) ?? [];
      const ids = refs.map(secret => secret.secretId);
      const secretRows = ids.length
        ? await this.o.db.selectFrom('mcp_secrets').select(['id', 'name', 'ciphertext']).where('user_id', '=', userId).where('import_id', '=', b.importId).where('id', 'in', ids).execute()
        : [];
      if (secretRows.length !== ids.length) throw new HttpError(400, 'invalid_input', 'Imported secret references are invalid');
      const namesById = new Map(secretRows.map(secret => [secret.id, secret.name]));
      const writes = secretRows.map(secret => ({
        name: secret.name,
        value: decryptSecret(this.o.key, userId, secret.id, secret.ciphertext),
      }));
      for (const bucket of ['env', 'headers']) {
        const values = (candidate[bucket] ?? {}) as Record<string, Cfg>;
        for (const [key, rawValue] of Object.entries(values)) {
          if (rawValue.kind !== 'secret') continue;
          const secretName = namesById.get(String(rawValue.secretId));
          if (!secretName) throw new HttpError(400, 'invalid_input', 'Imported config references an unowned secret');
          values[key] = { kind: 'secret-name', name: secretName };
        }
        if (candidate[bucket] !== undefined) candidate[bucket] = values;
      }
      if (typeof candidate.urlSecretId === 'string') {
        const secretName = namesById.get(candidate.urlSecretId);
        if (!secretName) throw new HttpError(400, 'invalid_input', 'Imported URL references an unowned secret');
        candidate.urlSecretName = secretName;
        delete candidate.urlSecretId;
      }
      const d = await this.draft(userId, { server: candidate, secrets: writes });
      if (ids.length) {
        await this.o.db.deleteFrom('mcp_secrets').where('user_id', '=', userId).where('import_id', '=', b.importId).where('id', 'in', ids).execute();
      }
      drafts.push(d);
    }
    await this.o.db.updateTable('mcp_registry_imports').set({ state: 'committed' }).where('id', '=', b.importId).where('user_id', '=', userId).execute();
    await this.audit(userId, 'api', 'import.commit', null);
    return { imported: drafts.length, drafts };
  }
  private async storeImportPreview(runnerId: string, payload: Cfg) {
    const pending = this.pendingImports.get(runnerId);
    const userId = this.o.agents.get(runnerId)?.userId;
    if (!userId || !pending || pending.userId !== userId) throw new HttpError(403, 'forbidden', 'Import result has no matching owner request');
    const importId = String(payload.importId);
    const servers = payload.servers as Cfg[];
    const secrets = (payload.secretValues ?? []) as Array<{ serverName: string; location: 'env' | 'header' | 'url'; key: string; value: string }>;
    const safeServers: Cfg[] = servers.map(server => ({ ...server, secrets: [] }));
    const firstUrlSecret = new Map<string, string>();
    const initialPreview = { importId, revision: 1, servers: [], secretsCaptured: secrets.length, warnings: payload.warnings ?? [] };
    await this.o.db
      .insertInto('mcp_registry_imports')
      .values({ id: importId, user_id: userId, runner_id: runnerId, preview: JSON.stringify(initialPreview), state: 'preview' })
      .execute();
    for (const secret of secrets) {
      const server = safeServers.find(s => s.name === secret.serverName);
      if (!server) throw new HttpError(400, 'invalid_import', 'Imported secret does not match a server');
      const secretId = randomUUID();
      const label = `${secret.location}:${secret.key}`;
      await this.o.db
        .insertInto('mcp_secrets')
        .values({
          id: secretId,
          user_id: userId,
          import_id: importId,
          name: label,
          ciphertext: encryptSecret(this.o.key, userId, secretId, secret.value),
          server_id: null,
          draft_id: null,
        })
        .execute();
      if (secret.location === 'env' || secret.location === 'header') {
        const key = secret.location === 'env' ? 'env' : 'headers';
        const values = (server[key] ?? {}) as Record<string, unknown>;
        values[secret.key] = { kind: 'secret', secretId };
        server[key] = values;
      } else {
        if (typeof server.url !== 'string') throw new HttpError(400, 'invalid_import', 'URL secret has no matching server URL');
        const url = new URL(server.url);
        if (secret.key === 'username') url.username = URL_SECRET_PLACEHOLDER;
        else if (secret.key === 'password') url.password = URL_SECRET_PLACEHOLDER;
        else url.searchParams.set(secret.key, URL_SECRET_PLACEHOLDER);
        server.url = url.toString();
        if (!firstUrlSecret.has(secret.serverName)) {
          firstUrlSecret.set(secret.serverName, secretId);
          server.urlSecretId = secretId;
        }
      }
      (server.secrets as unknown[]).push({ secretId, name: label, state: 'set' });
    }
    for (const server of safeServers) {
      const id = firstUrlSecret.get(String(server.name));
      if (id) server.urlSecretId = id;
    }
    const preview = {
      importId,
      revision: 1,
      servers: safeServers.map(server => ({
        ...safe(parse(mcpServerConfigSchema, server) as Cfg),
        ...(typeof server.source === 'string' ? { source: server.source } : {}),
      })),
      secretsCaptured: secrets.length,
      warnings: payload.warnings ?? [],
    };
    await this.o.db
      .updateTable('mcp_registry_imports')
      .set({ preview: JSON.stringify(preview) })
      .where('id', '=', importId)
      .where('user_id', '=', userId)
      .execute();
    await this.audit(userId, runnerId, 'import.preview', null);
    clearTimeout(pending.timer);
    this.pendingImports.delete(runnerId);
    pending.resolve(preview);
  }
  private async handleDraftRequest(runnerId: string, payload: unknown) {
    const req = parse(mcpDraftRequestPayload, payload);
    const conn = this.o.agents.get(runnerId);
    if (!conn) return;
    const send = (response: unknown) => conn.send('mcp.draft.result', response);
    const fail = (code: 'name_taken' | 'forbidden' | 'validation_failed' | 'timeout' | 'needs_secret' | 'not_found' | 'revision_conflict' | 'invalid_input' | 'unavailable', message: string) =>
      send({ requestId: req.requestId, ok: false, error: { code, message: message.slice(0, 500) } });
    if (!this.capabilities.get(runnerId)?.has(MCP_REGISTRY_CAPABILITIES[MCP_REGISTRY_CAPABILITIES.length - 1]!)) return fail('unavailable', 'This agent does not support MCP registry tools');
    let owner;
    try {
      owner = await this.o.db.selectFrom('sessions').select(['user_id', 'runner_id']).where('id', '=', req.sessionId).where('user_id', '=', conn.userId).executeTakeFirst();
    } catch {
      return fail('unavailable', 'MCP registry request failed');
    }
    const session = owner;
    if (!session || session.runner_id !== runnerId) {
      await this.audit(conn.userId, req.sessionId, 'tool.forbidden', null);
      return fail('forbidden', 'Session access denied');
    }
    try {
      if (req.op === 'add') {
        const draft = await this.draft(session.user_id, req.payload, req.sessionId);
        return send({ requestId: req.requestId, ok: true, result: { draft } });
      }
      if (req.op === 'list') {
        const registry = await this.list(session.user_id);
        const drafts = req.payload.includeDrafts
          ? await this.o.db
              .selectFrom('mcp_registry_drafts')
              .select(['id', 'name', 'config', 'state', 'revision', 'validation'])
              .where('user_id', '=', session.user_id)
              .where('state', 'not in', ['connected', 'saved-unchecked'])
              .orderBy('updated_at', 'desc')
              .limit(100)
              .execute()
          : [];
        await this.audit(session.user_id, req.sessionId, 'tool.list', null);
        return send({
          requestId: req.requestId,
          ok: true,
          result: {
            servers: registry.servers,
            drafts: drafts.map(d => ({
              draftId: d.id,
              revision: Number(d.revision),
              state: d.state,
              server: safe({ ...d.config, id: d.config.id ?? d.id, name: d.name, revision: Number(d.revision) }),
              ...(d.validation ? { validation: d.validation } : {}),
            })),
          },
        });
      }
      const draft = await this.updateDraft(session.user_id, req.payload.draftId, req.payload.update, req.sessionId);
      return send({ requestId: req.requestId, ok: true, result: { draft: { draftId: draft.draftId, revision: draft.revision, state: draft.state, server: draft.server } } });
    } catch (err) {
      if (err instanceof HttpError) {
        const code =
          err.code === 'name_taken'
            ? 'name_taken'
            : err.code === 'forbidden' || err.code === 'machine_not_allowed'
              ? 'forbidden'
              : err.code === 'needs_secret'
                ? 'needs_secret'
                : err.code === 'revision_conflict'
                  ? 'revision_conflict'
                  : err.status === 404
                    ? 'not_found'
                    : err.status === 504
                      ? 'timeout'
                      : err.status === 400
                        ? 'invalid_input'
                        : 'unavailable';
        return fail(code, code === 'unavailable' ? 'MCP registry request failed' : err.message);
      }
      const dbCode = (err as { code?: unknown })?.code;
      this.o.log.warn(
        {
          runnerId,
          sessionId: req.sessionId,
          op: req.op,
          errorClass: err instanceof Error ? err.name : 'unknown',
          errorSite: err instanceof Error ? err.stack?.split('\n').slice(1, 3).join(' ').slice(0, 300) : undefined,
          ...(typeof dbCode === 'string' && /^\d{5}$/.test(dbCode) ? { dbCode } : {}),
        },
        'MCP draft tool request failed',
      );
      return fail('unavailable', 'MCP registry request failed');
    }
  }
  private async audit(userId: string, actor: string, action: string, serverId: string | null, draftId?: string) {
    await this.o.db
      .insertInto('mcp_registry_audit')
      .values({ user_id: userId, actor, action, server_id: serverId, draft_id: draftId ?? null })
      .execute();
  }
  private async bump(userId: string) {
    const row = await this.o.db
      .insertInto('mcp_registry_meta')
      .values({ user_id: userId, revision: 1 })
      .onConflict(conflict => conflict.column('user_id').doUpdateSet(eb => ({ revision: eb('mcp_registry_meta.revision', '+', 1), updated_at: new Date() })))
      .returning('revision')
      .executeTakeFirstOrThrow();
    return Number(row.revision);
  }
  private async syncRunner(runnerId: string, userId: string) {
    const conn = this.o.agents.get(runnerId);
    if (!conn) return;
    if (!this.capabilities.get(runnerId)?.has('mcp.registry.v1')) return;
    const machine = await this.o.db.selectFrom('runners').select('mcp_registry_enabled').where('user_id', '=', userId).where('id', '=', runnerId).where('state', '=', 'active').executeTakeFirst();
    if (!machine) return;
    const r = await this.list(userId);
    r.registryEnabled = machine.mcp_registry_enabled;
    if (!machine.mcp_registry_enabled) r.servers = [];
    r.servers = r.servers.filter((server: Cfg) => {
      if (server.enabled === false) return false;
      const scope = server.machineScope as { allMachines?: boolean; machineIds?: string[] } | undefined;
      return !scope || scope.allMachines === true || scope.machineIds?.includes(runnerId) === true;
    });
    const scopedServerIds = (r.servers as Cfg[]).map(server => String(server.id));
    const oauthManagedRows = scopedServerIds.length
      ? await this.o.db.selectFrom('mcp_oauth_statuses').select(['server_id', 'machine_id', 'registry_ready']).where('user_id', '=', userId).where('server_id', 'in', scopedServerIds).execute()
      : [];
    const oauthManagedServerIds = new Set(oauthManagedRows.map(row => row.server_id));
    const readyOAuthServerIds = new Set(oauthManagedRows.filter(row => row.machine_id === runnerId && row.registry_ready).map(row => row.server_id));
    r.servers = r.servers.filter((server: Cfg) => !oauthManagedServerIds.has(String(server.id)) || readyOAuthServerIds.has(String(server.id)));
    const activeServerIds = (r.servers as Cfg[]).map(server => String(server.id));
    const overrides = activeServerIds.length
      ? await this.o.db
          .selectFrom('mcp_registry_overrides')
          .innerJoin('mcp_registry_servers', 'mcp_registry_servers.id', 'mcp_registry_overrides.server_id')
          .select(['mcp_registry_overrides.project_id', 'mcp_registry_overrides.server_id'])
          .where('mcp_registry_overrides.user_id', '=', userId)
          .where('mcp_registry_overrides.enabled', '=', false)
          .where('mcp_registry_servers.user_id', '=', userId)
          .where('mcp_registry_servers.enabled', '=', true)
          .where('mcp_registry_overrides.server_id', 'in', activeServerIds)
          .execute()
      : [];
    conn.send(
      'mcp.registry.sync',
      {
        ...r,
        projectOverrides: overrides.map(row => ({ projectId: row.project_id, serverId: row.server_id, enabled: false })),
      },
      { id: randomUUID() },
    );
    // Credentials never enter snapshots: send them in a separate, target-only WS command.
    for (const server of r.servers as Array<Cfg>) {
      const scope = server.machineScope as { allMachines?: boolean; machineIds?: string[] } | undefined;
      if (scope && !scope.allMachines && !scope.machineIds?.includes(runnerId)) continue;
      const ids = ((server.secrets ?? []) as Array<{ secretId: string }>).map(x => x.secretId);
      if (!ids.length) continue;
      const rows = await this.o.db
        .selectFrom('mcp_secrets')
        .select(['id', 'name', 'ciphertext'])
        .where('user_id', '=', userId)
        .where('server_id', '=', String(server.id))
        .where('id', 'in', ids)
        .execute();
      if (!rows.length || !this.capabilities.get(runnerId)?.has('mcp.secrets.encrypted.v1')) continue;
      const secrets = rows.map(s => ({ name: s.name, value: decryptSecret(this.o.key, userId, s.id, s.ciphertext) }));
      conn.send('mcp.secrets.deliver', { serverId: server.id, revision: server.revision, machineId: runnerId, secrets }, { id: randomUUID() });
    }
    const oauth =
      activeServerIds.length && this.capabilities.get(runnerId)?.has('mcp.oauth.v1')
        ? await this.o.db
            .selectFrom('mcp_oauth_tokens')
            .innerJoin('mcp_registry_servers', 'mcp_registry_servers.id', 'mcp_oauth_tokens.server_id')
            .select(['mcp_oauth_tokens.server_id', 'mcp_oauth_tokens.ciphertext', 'mcp_registry_servers.config'])
            .where('mcp_oauth_tokens.user_id', '=', userId)
            .where('mcp_registry_servers.user_id', '=', userId)
            .where('mcp_registry_servers.id', 'in', activeServerIds)
            .execute()
        : [];
    for (const row of oauth) {
      const scope = row.config.machineScope as { allMachines?: boolean; machineIds?: string[] } | undefined;
      if (scope && !scope.allMachines && !scope.machineIds?.includes(runnerId)) continue;
      try {
        const tokens = JSON.parse(decryptSecret(this.o.key, userId, row.server_id, row.ciphertext)) as Cfg;
        const credentials = mcpOAuthCredentialSchema.parse({ serverId: row.server_id, machineId: runnerId, ...tokens });
        await conn.request('mcp.oauth.credentials', credentials, 5000);
      } catch {
        this.o.log.warn({ serverId: row.server_id, machineId: runnerId }, 'MCP OAuth credentials unreadable');
      }
    }
  }
  private async syncUser(userId: string) {
    const rows = await this.o.db.selectFrom('runners').select(['id', 'protocol_version']).where('user_id', '=', userId).where('state', '=', 'active').execute();
    for (const runner of rows) {
      if (protocolAtLeast(runner.protocol_version, MIN)) await this.syncRunner(runner.id, userId);
    }
  }
  private async oauthMachine(userId: string, serverId: string, machineId: string, requireOnline: boolean) {
    const server = await this.o.db.selectFrom('mcp_registry_servers').select('config').where('user_id', '=', userId).where('id', '=', serverId).executeTakeFirst();
    if (!server) throw new HttpError(404, 'mcp_server_not_found', 'MCP server not found');
    const scope = server.config.machineScope as { allMachines?: boolean; machineIds?: string[] } | undefined;
    if (scope && !scope.allMachines && !scope.machineIds?.includes(machineId)) throw new HttpError(403, 'machine_not_allowed', 'Target machine is outside the server allow-list');
    const runner = await this.o.db.selectFrom('runners').select(['id', 'protocol_version', 'state']).where('id', '=', machineId).where('user_id', '=', userId).executeTakeFirst();
    if (!runner || runner.state !== 'active') throw new HttpError(404, 'machine_not_found', 'Target machine not found');
    if (!requireOnline) return null;
    const connection = this.o.agents.get(machineId);
    if (!connection) throw new HttpError(409, 'machine_offline', 'Target machine is offline');
    if (!protocolAtLeast(runner.protocol_version, MIN) || !this.capabilities.get(machineId)?.has('mcp.oauth.v1')) {
      throw new HttpError(409, 'agent_outdated', 'Target machine does not support MCP OAuth');
    }
    return connection;
  }
  private async deliverOAuthCredentials(userId: string, serverId: string, machineId: string) {
    const connection = await this.oauthMachine(userId, serverId, machineId, true);
    if (!connection) throw new HttpError(409, 'machine_offline', 'Target machine is offline');
    const row = await this.o.db.selectFrom('mcp_oauth_tokens').select('ciphertext').where('user_id', '=', userId).where('server_id', '=', serverId).executeTakeFirst();
    if (!row) throw new HttpError(409, 'oauth_required', 'Sign in to the MCP server before validation');
    const tokens = JSON.parse(decryptSecret(this.o.key, userId, serverId, row.ciphertext)) as Cfg;
    const payload = parse(mcpOAuthCredentialSchema, { serverId, machineId, ...tokens });
    try {
      await connection.request('mcp.oauth.credentials', payload, 5000);
    } catch {
      throw new HttpError(502, 'oauth_delivery_failed', 'OAuth credentials could not be delivered to the target machine');
    }
  }
  private async writeOAuthStatus(
    userId: string,
    serverId: string,
    machineId: string,
    state: 'pending' | 'signed-in' | 'refresh-error' | 'expired' | 'failed' | 'needs-login',
    expiresAt: number | null,
    error: string | null,
    options: { validationState?: 'unchecked' | 'checked' | 'needs_auth' | 'validation-failed'; validatedRevision?: number | null; registryReady?: boolean } = {},
  ) {
    const previous = await this.o.db
      .selectFrom('mcp_oauth_statuses')
      .select(['validation_state', 'validated_revision', 'registry_ready'])
      .where('user_id', '=', userId)
      .where('server_id', '=', serverId)
      .where('machine_id', '=', machineId)
      .executeTakeFirst();
    const validationState = options.validationState ?? previous?.validation_state ?? 'unchecked';
    const validatedRevision = options.validatedRevision === undefined ? (previous?.validated_revision ?? null) : options.validatedRevision === null ? null : String(options.validatedRevision);
    const registryReady = options.registryReady ?? previous?.registry_ready ?? true;
    await this.o.db
      .insertInto('mcp_oauth_statuses')
      .values({
        user_id: userId,
        server_id: serverId,
        machine_id: machineId,
        state,
        validation_state: validationState,
        validated_revision: validatedRevision,
        registry_ready: registryReady,
        expires_at: expiresAt === null ? null : new Date(expiresAt),
        error,
        updated_at: new Date(),
      })
      .onConflict(conflict =>
        conflict.columns(['user_id', 'server_id', 'machine_id']).doUpdateSet({
          state,
          validation_state: validationState,
          validated_revision: validatedRevision,
          registry_ready: registryReady,
          expires_at: expiresAt === null ? null : new Date(expiresAt),
          error,
          updated_at: new Date(),
        }),
      )
      .execute();
  }
  private removeOAuthFlow(flow: PendingOAuthFlow) {
    clearTimeout(flow.timer);
    this.pendingOAuth.delete(flow.state);
  }
  private clearOAuthFlowsForServer(userId: string, serverId: string) {
    for (const flow of this.pendingOAuth.values()) {
      if (flow.userId === userId && flow.serverId === serverId) this.removeOAuthFlow(flow);
    }
  }
  private async expireOAuthStatuses(userId: string) {
    const now = new Date();
    await this.o.db
      .updateTable('mcp_oauth_statuses')
      .set({ state: 'expired', expires_at: null, updated_at: now })
      .where('user_id', '=', userId)
      .where('state', '=', 'pending')
      .where('expires_at', '<=', now)
      .execute();
    for (const flow of this.pendingOAuth.values()) {
      if (flow.userId === userId && flow.expiresAt <= now.getTime()) this.removeOAuthFlow(flow);
    }
  }
  private async storeOAuth(machineId: string, userId: string, payload: Cfg) {
    const update = parse(mcpOAuthCredentialSchema, payload);
    if (update.machineId !== machineId) return;
    const id = update.serverId;
    const server = await this.o.db.selectFrom('mcp_registry_servers').select('config').where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
    const scope = server?.config.machineScope as { allMachines?: boolean; machineIds?: string[] } | undefined;
    if (!server || (scope && !scope.allMachines && !scope.machineIds?.includes(machineId))) return;
    let flow: PendingOAuthFlow | undefined;
    if (update.flowId) {
      flow = [...this.pendingOAuth.values()].find(item => item.flowId === update.flowId);
      if (!flow || flow.expiresAt <= Date.now() || flow.userId !== userId || flow.machineId !== machineId || flow.serverId !== id) return;
    }
    const previous = await this.o.db.selectFrom('mcp_oauth_tokens').select('ciphertext').where('user_id', '=', userId).where('server_id', '=', id).executeTakeFirst();
    const previousValues = previous ? (JSON.parse(decryptSecret(this.o.key, userId, id, previous.ciphertext)) as Cfg) : {};
    const tokenValues = {
      accessToken: update.accessToken,
      ...((update.refreshToken ?? previousValues.refreshToken) ? { refreshToken: update.refreshToken ?? previousValues.refreshToken } : {}),
      ...((update.expiresAt ?? previousValues.expiresAt) ? { expiresAt: update.expiresAt ?? previousValues.expiresAt } : {}),
      ...((update.oauthClientState ?? previousValues.oauthClientState) ? { oauthClientState: update.oauthClientState ?? previousValues.oauthClientState } : {}),
    };
    const token = JSON.stringify(tokenValues);
    await this.o.db
      .insertInto('mcp_oauth_tokens')
      .values({ user_id: userId, server_id: id, machine_id: machineId, ciphertext: encryptSecret(this.o.key, userId, id, token) })
      .onConflict(conflict =>
        conflict.columns(['user_id', 'server_id']).doUpdateSet({
          machine_id: machineId,
          ciphertext: encryptSecret(this.o.key, userId, id, token),
          updated_at: new Date(),
        }),
      )
      .execute();
    const runners = await this.o.db.selectFrom('runners').select('id').where('user_id', '=', userId).where('state', '=', 'active').execute();
    for (const runner of runners) {
      if (scope && !scope.allMachines && !scope.machineIds?.includes(runner.id)) continue;
      await this.writeOAuthStatus(userId, id, runner.id, 'signed-in', Number(tokenValues.expiresAt ?? 0) || null, null);
    }
    if (flow) this.removeOAuthFlow(flow);
    await this.audit(userId, machineId, 'oauth.tokens-updated', id);
    if (flow || update.oauthClientState || previousValues.oauthClientState) await this.syncUser(userId);
  }
  private async storeOAuthStatus(machineId: string, userId: string, payload: unknown) {
    const update = parse(mcpOAuthStatusUpdateSchema, payload);
    if (update.machineId !== machineId) return;
    const server = await this.o.db.selectFrom('mcp_registry_servers').select('config').where('id', '=', update.serverId).where('user_id', '=', userId).executeTakeFirst();
    const scope = server?.config.machineScope as { allMachines?: boolean; machineIds?: string[] } | undefined;
    if (!server || (scope && !scope.allMachines && !scope.machineIds?.includes(machineId))) return;
    if (update.state === 'signed-in') {
      const token = await this.o.db.selectFrom('mcp_oauth_tokens').select('server_id').where('user_id', '=', userId).where('server_id', '=', update.serverId).executeTakeFirst();
      if (!token) return;
      await this.writeOAuthStatus(userId, update.serverId, machineId, 'signed-in', update.expiresAt ?? null, null);
      return;
    }
    const token = await this.o.db.selectFrom('mcp_oauth_tokens').select('ciphertext').where('user_id', '=', userId).where('server_id', '=', update.serverId).executeTakeFirst();
    const tokenValues = token
      ? Object.values(JSON.parse(decryptSecret(this.o.key, userId, update.serverId, token.ciphertext)) as Cfg).filter((value): value is string => typeof value === 'string')
      : [];
    const error = typeof update.error === 'string' ? String(redactValues(update.error, tokenValues)).slice(0, 500) : 'OAuth token refresh failed';
    await this.writeOAuthStatus(userId, update.serverId, machineId, 'refresh-error', update.expiresAt ?? null, error);
    await this.audit(userId, machineId, 'oauth.refresh-failed', update.serverId);
  }
  private async storeSessionUpdateAck(runnerId: string, userId: string | undefined, payload: unknown) {
    const ack = parse(mcpRegistrySessionUpdateAckPayload, payload);
    if (!userId) return;
    const owner = await this.o.db.selectFrom('sessions').select('runner_id').where('id', '=', ack.sessionId).where('user_id', '=', userId).executeTakeFirst();
    if (!owner || owner.runner_id !== runnerId) return;
    const update = await this.o.db
      .selectFrom('mcp_registry_session_updates')
      .select('server_id')
      .where('user_id', '=', userId)
      .where('runner_id', '=', runnerId)
      .where('session_id', '=', ack.sessionId)
      .where('revision', '=', String(ack.revision))
      .executeTakeFirst();
    const secretRows = update ? await this.o.db.selectFrom('mcp_secrets').select(['id', 'ciphertext']).where('user_id', '=', userId).where('server_id', '=', update.server_id).execute() : [];
    const secretValues = secretRows.map(secret => decryptSecret(this.o.key, userId, secret.id, secret.ciphertext));
    const redacted = ack.error ? (redactValues(ack.error, secretValues) as string) : undefined;
    const message = redacted?.replace(/[\r\n\t]/g, ' ').slice(0, 500) ?? null;
    await this.o.db
      .updateTable('mcp_registry_session_updates')
      .set({ activation: ack.activation, applied: ack.applied, error: message, updated_at: new Date() })
      .where('user_id', '=', userId)
      .where('runner_id', '=', runnerId)
      .where('session_id', '=', ack.sessionId)
      .where('revision', '=', String(ack.revision))
      .execute();
  }
  private async storeStatus(machineId: string, userId: string, payload: Cfg) {
    const serverId = String(payload.serverId);
    const [server, runner] = await Promise.all([
      this.o.db.selectFrom('mcp_registry_servers').select('config').where('id', '=', serverId).where('user_id', '=', userId).executeTakeFirst(),
      this.o.db.selectFrom('runners').select('id').where('id', '=', machineId).where('user_id', '=', userId).executeTakeFirst(),
    ]);
    const scope = server?.config.machineScope as { allMachines?: boolean; machineIds?: string[] } | undefined;
    if (!server || !runner || (scope && !scope.allMachines && !scope.machineIds?.includes(machineId))) return;
    const secretIds = ((server.config.secrets ?? []) as Array<{ secretId?: string }>).map(secret => secret.secretId).filter((id): id is string => !!id);
    const secretRows = secretIds.length
      ? await this.o.db.selectFrom('mcp_secrets').select(['id', 'ciphertext']).where('user_id', '=', userId).where('server_id', '=', serverId).where('id', 'in', secretIds).execute()
      : [];
    const secretValues = secretRows.map(row => decryptSecret(this.o.key, userId, row.id, row.ciphertext));
    const safeError = typeof payload.error === 'string' ? (redactValues(payload.error, secretValues) as string) : null;
    await this.o.db
      .insertInto('mcp_gateway_statuses')
      .values({
        server_id: serverId,
        machine_id: machineId,
        session_id: payload.sessionId == null ? null : String(payload.sessionId),
        status: String(payload.status) as 'stopped' | 'starting' | 'ready' | 'needs-secret' | 'failed',
        endpoint: payload.endpoint == null ? null : String(payload.endpoint),
        error: safeError,
        observed_at: new Date(Math.min(Number(payload.observedAt), Date.now())),
      })
      .onConflict(conflict =>
        conflict
          .expression(sql`server_id, machine_id, (COALESCE(session_id, '00000000-0000-0000-0000-000000000000'::uuid))`)
          .doUpdateSet(eb => ({
            session_id: eb.ref('excluded.session_id'),
            status: eb.ref('excluded.status'),
            endpoint: eb.ref('excluded.endpoint'),
            error: eb.ref('excluded.error'),
            observed_at: eb.ref('excluded.observed_at'),
          }))
          .whereRef('mcp_gateway_statuses.observed_at', '<=', 'excluded.observed_at'),
      )
      .execute();
  }
}

export function registerMcpRegistryApi(app: FastifyInstance, service: McpRegistryService) {
  app.get('/api/mcp/registry', async req => service.view(req.user!.id));
  app.get('/api/mcp/registry/status', async req => service.status(req.user!.id));
  app.put('/api/mcp/registry/machines/:machineId', async req => service.setMachineRegistryEnabled(req.user!.id, (req.params as { machineId: string }).machineId, req.body));
  app.post('/api/mcp/registry/servers/:id/oauth/start', async (req, reply) => reply.code(202).send(await service.startOAuth(req.user!.id, (req.params as { id: string }).id, req.body)));
  app.post('/api/mcp/registry/servers/:id/oauth/validate', async req => service.validateOAuthServer(req.user!.id, (req.params as { id: string }).id, req.body));
  app.post('/api/mcp/registry/servers/:id/oauth/connect', async req => service.connectOAuthServer(req.user!.id, (req.params as { id: string }).id, req.body));
  app.post('/api/mcp/registry/servers/:id/oauth/revoke', async req => service.revokeOAuth(req.user!.id, (req.params as { id: string }).id, req.body));
  app.post('/api/mcp/registry', async (req, reply) => reply.code(201).send(await service.create(req.user!.id, req.body)));
  app.get('/api/mcp/registry/servers/:id', async req => service.get(req.user!.id, (req.params as { id: string }).id));
  app.patch('/api/mcp/registry/servers/:id', async req => {
    const b = (req.body ?? {}) as Cfg;
    const revision = Number(b.revision);
    const server = b.server && typeof b.server === 'object' ? b.server : Object.fromEntries(Object.entries(b).filter(([key]) => key !== 'revision'));
    const secretWrites = Array.isArray(b.secrets) ? b.secrets : [];
    return service.patch(req.user!.id, (req.params as { id: string }).id, revision, { server, secrets: secretWrites });
  });
  app.get('/api/mcp/registry/servers/:id/projects/:projectId', async req => {
    const p = req.params as { id: string; projectId: string };
    return service.projectOverride(req.user!.id, p.id, p.projectId);
  });
  app.put('/api/mcp/registry/servers/:id/projects/:projectId', async req => {
    const p = req.params as { id: string; projectId: string };
    return service.setProjectOverride(req.user!.id, p.id, p.projectId, req.body);
  });
  app.delete('/api/mcp/registry/servers/:id/projects/:projectId', async req => {
    const p = req.params as { id: string; projectId: string };
    const q = req.query as { revision?: string };
    return service.clearProjectOverride(req.user!.id, p.id, p.projectId, Number(q.revision));
  });
  app.delete('/api/mcp/registry/servers/:id', async req => {
    const body = (req.body ?? {}) as { revision?: number };
    const query = req.query as { revision?: string };
    return service.remove(req.user!.id, (req.params as { id: string }).id, Number(body.revision ?? query.revision));
  });
  app.post('/api/mcp/registry/drafts', async (req, reply) => reply.code(201).send(await service.draft(req.user!.id, req.body)));
  app.get('/api/mcp/registry/drafts/:id', async req => service.getDraft(req.user!.id, (req.params as { id: string }).id));
  app.patch('/api/mcp/registry/drafts/:id', async req => service.updateDraft(req.user!.id, (req.params as { id: string }).id, req.body));
  app.post('/api/mcp/registry/drafts/:id/validate', async req => {
    const b = req.body as { machineId: string; revision: number };
    return service.validate(req.user!.id, (req.params as { id: string }).id, b);
  });
  app.post('/api/mcp/registry/drafts/:id/connect', async req => service.connect(req.user!.id, (req.params as { id: string }).id, req.body));
  app.post('/api/mcp/registry/drafts/:id/save-unchecked', async req => service.connect(req.user!.id, (req.params as { id: string }).id, req.body, true));
  app.post('/api/mcp/registry/import/preview', async req => {
    const b = req.body as { machineId: string; projectRoot: string };
    return service.importPreview(req.user!.id, b.machineId, b.projectRoot);
  });
  app.post('/api/mcp/registry/import/commit', async req => service.importCommit(req.user!.id, req.body));
}
