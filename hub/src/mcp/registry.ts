import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import {
  MCP_REGISTRY_CAPABILITIES,
  MCP_REGISTRY_PROTOCOL_VERSION,
  mcpDraftConnectSchema,
  mcpDraftCreateSchema,
  mcpDraftRequestPayload,
  mcpDraftValidationResultSchema,
  mcpDraftSaveUncheckedSchema,
  mcpDraftUpdateSchema,
  mcpDraftValidateSchema,
  mcpSecretInputSchema,
  mcpImportCommitPayload,
  mcpImportCommitResponseSchema,
  mcpImportPreviewRequestSchema,
  mcpImportPreviewResponseSchema,
  mcpImportPreviewResultPayload,
  type McpImportCommitResponse,
  type McpImportDecision,
  type McpImportPreviewResponse,
  mcpOAuthCredentialSchema,
  mcpOAuthStartResultSchema,
  mcpOAuthStatusUpdateSchema,
  mcpRegistryValidateResultPayload,
  mcpRegistryValidatePayload,
  mcpRegistryOAuthRevokeRequestSchema,
  mcpRegistryOAuthRevokeResponseSchema,
  mcpRegistryOAuthConnectRequestSchema,
  mcpRegistryOAuthConnectResponseSchema,
  mcpRegistryOAuthCompleteRequestSchema,
  mcpRegistryOAuthCompleteResponseSchema,
  mcpRegistryOAuthStartRequestSchema,
  OAUTH_LOOPBACK_REDIRECT_URI,
  mcpRegistryOAuthStartResponseSchema,
  mcpRegistryOAuthStatusSchema,
  mcpRegistryMachineOverrideRequestSchema,
  mcpRegistryMachineOverrideResponseSchema,
  MCP_IMPORT_V2_CAPABILITY,
  platformOfHome,
  projectDir,
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
const apiDraftCreateRequestSchema = z.object({ sessionId: z.string().uuid().optional() }).passthrough();
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
const SENSITIVE_KEY = /(?:token|api[-_]?key|secret|password|credential|authorization|cookie)/i;
/**
 * An empty sensitive value in a local config (nano-banana ships `GEMINI_API_KEY: ""`) is not a secret, yet the registry
 * schema accepts sensitive keys only as secret references. Drop such keys so the server is imported, and name them in a warning.
 */
function dropEmptySensitiveValues(entry: Cfg): string[] {
  const dropped: string[] = [];
  for (const field of ['env', 'headers'] as const) {
    const values = entry[field] as Record<string, { kind?: string; value?: string }> | undefined;
    if (!values) continue;
    for (const [key, value] of Object.entries(values)) {
      if (!SENSITIVE_KEY.test(key) || value?.kind !== 'literal' || value.value !== '') continue;
      delete values[key];
      dropped.push(key);
    }
  }
  if (typeof entry.url === 'string' && URL.canParse(entry.url)) {
    const url = new URL(entry.url);
    const empty = [...url.searchParams.entries()].filter(([key, value]) => SENSITIVE_KEY.test(key) && value === '').map(([key]) => key);
    if (empty.length) {
      for (const key of empty) url.searchParams.delete(key);
      entry.url = url.toString();
      dropped.push(...empty);
    }
  }
  return dropped;
}
const OAUTH_FLOW_TTL_MS = 10 * 60_000;
type PendingOAuthFlow = {
  flowId: string;
  userId: string;
  serverId: string;
  machineId: string;
  state: string;
  redirectUri: string;
  expiresAt: number;
  callbackForwarded: boolean;
  timer: NodeJS.Timeout;
};
/** mcp-hub-only D2: fields a machine override may replace; each one is replaced whole, env and headers are not merged. */
const OVERRIDE_FIELDS = ['transport', 'mode', 'command', 'args', 'url', 'urlSecretId', 'env', 'headers', 'oauthClientId'] as const;
type SecretRef = { secretId: string; name: string; state?: string };
type MachineOverrideRow = { server_id: string; runner_id: string; enabled: boolean; config: Cfg | null };
function referencedSecretIds(server: Cfg): Set<string> {
  const ids = new Set<string>();
  if (typeof server.urlSecretId === 'string') ids.add(server.urlSecretId);
  for (const bucket of ['env', 'headers'] as const) {
    const values = (server[bucket] ?? {}) as Record<string, { kind?: string; secretId?: string }>;
    for (const value of Object.values(values)) if (value?.kind === 'secret' && value.secretId) ids.add(value.secretId);
  }
  return ids;
}
/** Effective server for one machine: the server config with the override fields on top; secrets limited to what the result references. */
function effectiveServer(server: Cfg, overrideConfig: Cfg | null | undefined): Cfg {
  if (!overrideConfig) return server;
  const merged: Cfg = { ...server };
  for (const field of OVERRIDE_FIELDS) {
    if (!(field in overrideConfig)) continue;
    if (overrideConfig[field] === undefined || overrideConfig[field] === null) delete merged[field];
    else merged[field] = overrideConfig[field];
  }
  const used = referencedSecretIds(merged);
  const refs = [...((server.secrets ?? []) as SecretRef[]), ...((overrideConfig.secrets ?? []) as SecretRef[])];
  const seen = new Set<string>();
  merged.secrets = refs.filter(ref => {
    if (!used.has(ref.secretId) || seen.has(ref.secretId)) return false;
    seen.add(ref.secretId);
    return true;
  });
  return merged;
}
type ImportEntryRecord = Cfg & { id: string; name: string; transport: string; source: string; origin?: string; projectId?: string; warnings: string[]; secrets: SecretRef[] };
type StoredImportPreview = { importId: string; machineId: string; revision: number; entries: ImportEntryRecord[]; secretsCaptured: number; warnings: string[] };
type ImportRegistryServer = { id: string; config: Cfg; revision: number; override: { enabled: boolean; config: Cfg | null } | null };
const IMPORT_CONFIG_FIELDS = ['transport', 'command', 'args', 'url', 'urlSecretId', 'env', 'headers', 'oauthClientId'] as const;
function pickImportConfig(entry: Cfg): Cfg {
  const picked: Cfg = {};
  for (const field of IMPORT_CONFIG_FIELDS) if (entry[field] !== undefined && entry[field] !== null) picked[field] = entry[field];
  return picked;
}
/** D5: what a server does on a machine — transport, command, args, URL, env, headers and OAuth client with secret values resolved. */
function importFingerprint(server: Cfg, values: Map<string, string>): string {
  const resolve = (secretId: string) => values.get(secretId) ?? `missing:${secretId}`;
  const valueOf = (value: { kind?: string; value?: string; secretId?: string } | undefined) =>
    value?.kind === 'secret' ? `secret:${resolve(String(value.secretId))}` : `literal:${value?.value ?? ''}`;
  const bucket = (name: 'env' | 'headers') =>
    Object.entries((server[name] ?? {}) as Record<string, { kind?: string; value?: string; secretId?: string }>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => [key, valueOf(value)]);
  let url = typeof server.url === 'string' ? server.url : null;
  if (url && typeof server.urlSecretId === 'string') url = url.replaceAll(URL_SECRET_PLACEHOLDER, resolve(server.urlSecretId));
  return JSON.stringify({
    transport: server.transport,
    command: server.command ?? null,
    args: server.args ?? [],
    url,
    env: bucket('env'),
    headers: bucket('headers'),
    oauthClientId: server.oauthClientId ?? null,
  });
}
/** D5: same-name entries of one scan that cannot all be imported — project entries that differ from the machine-level entry, or differ from each other. */
function importConflicts(entries: ImportEntryRecord[], values: Map<string, string>): Set<string> {
  const groups = new Map<string, ImportEntryRecord[]>();
  for (const entry of entries) groups.set(entry.name, [...(groups.get(entry.name) ?? []), entry]);
  const conflicts = new Set<string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const prints = new Map(group.map(entry => [entry.id, importFingerprint(entry, values)]));
    const primary = group.find(entry => !entry.projectId);
    if (primary) {
      for (const entry of group) if (entry !== primary && prints.get(entry.id) !== prints.get(primary.id)) conflicts.add(entry.id);
    } else if (new Set(prints.values()).size > 1) {
      for (const entry of group) conflicts.add(entry.id);
    }
  }
  return conflicts;
}
/** D5: decision for one entry against the registry server of the same name as the machine sees it. */
function importDecision(entry: ImportEntryRecord, existing: ImportRegistryServer | undefined, machineId: string, values: Map<string, string>): McpImportDecision {
  if (!existing) return 'new';
  const effective = effectiveServer(existing.config, existing.override?.config);
  if (importFingerprint(effective, values) !== importFingerprint(entry, values)) return 'machine-config';
  const scope = existing.config.machineScope as { allMachines?: boolean; machineIds?: string[] } | undefined;
  const inScope = (!scope || scope.allMachines === true || scope.machineIds?.includes(machineId) === true) && existing.override?.enabled !== false;
  const projectIds = Array.isArray(existing.config.projectIds) ? (existing.config.projectIds as string[]) : [];
  const projectOk = !projectIds.length || (!!entry.projectId && projectIds.includes(entry.projectId));
  return inScope && projectOk ? 'unchanged' : 'add-machine';
}
function redactValues(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string') return secrets.reduce((text, secret) => (secret ? text.replaceAll(secret, '[REDACTED]') : text), value);
  if (Array.isArray(value)) return value.map(item => redactValues(item, secrets));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValues(item, secrets)]));
}
function matchesSavedServerOrigin(candidate: Cfg, saved: Cfg): boolean {
  if (candidate.transport !== saved.transport || typeof candidate.url !== 'string' || typeof saved.url !== 'string') return false;
  try {
    return new URL(candidate.url).origin === new URL(saved.url).origin;
  } catch {
    return false;
  }
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
  /** The last hello's capabilities per machine; a live connection is read through caps(). */
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
        void this.syncRunner(runnerId, userId)
          .catch((error: unknown) => this.o.log.warn({ runnerId, errorClass: error instanceof Error ? error.name : 'unknown' }, 'MCP registry sync failed'))
          .then(() => this.autoImport(runnerId, userId))
          .catch((error: unknown) => this.o.log.warn({ runnerId, errorClass: error instanceof Error ? error.name : 'unknown' }, 'MCP auto-import failed'));
      }
    });
    o.bus.on('agent.message', (runnerId, m) => {
      const connection = this.o.agents.get(runnerId);
      if (m.type === 'mcp.registry.validate.result') this.settleValidationResult(runnerId, m.re, m.payload);
      if (m.type === 'mcp.oauth.token.update' && connection && this.caps(runnerId)?.has('mcp.oauth.v1'))
        void this.storeOAuth(runnerId, connection.userId, m.payload).catch((err: unknown) =>
          this.o.log.warn({ runnerId, errorClass: err instanceof Error ? err.name : 'unknown' }, 'MCP OAuth token update rejected'),
        );
      if (m.type === 'mcp.oauth.status.update' && connection && this.caps(runnerId)?.has('mcp.oauth.v1'))
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
    const machines = await this.serverMachines(
      userId,
      registry.servers.map(server => ({ id: server.id, config: server })),
    );
    return {
      ...registry,
      servers: registry.servers.map(server => ({ ...server, machines: machines.get(server.id) ?? [] })),
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
    existingQuery = owner.draftId ? existingQuery.where('draft_id', '=', owner.draftId) : existingQuery.where('server_id', '=', owner.serverId!).where('machine_id', 'is', null);
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
    const trustedByName = new Map<string, { id: string; name: string }>();
    const allowedName = (name: string) => writeByName.get(name) ?? ownedByName.get(name) ?? trustedByName.get(name);
    const allowedId = (id: string) => writeById.get(id)?.name ?? ownedById.get(id);
    const trustedIds = new Set<string>();
    const trustedNames = new Map<string, string>();
    const readTrustedReferences = (source: Cfg) => {
      const refs = (Array.isArray(source.secrets) ? source.secrets : []) as Array<{ secretId?: string; name?: string }>;
      for (const ref of refs) {
        if (typeof ref.secretId === 'string') {
          trustedIds.add(ref.secretId);
          if (typeof ref.name === 'string') {
            trustedNames.set(ref.secretId, ref.name);
            if (!trustedByName.has(ref.name)) trustedByName.set(ref.name, { id: ref.secretId, name: ref.name });
          }
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
    const missingByName = new Map<string, string>();
    const missingNamesById = new Map<string, string>();
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
          const secretName = String(value.name ?? '');
          const resolved = allowedName(secretName);
          if (!resolved) {
            const secretId = missingByName.get(secretName) ?? randomUUID();
            missingByName.set(secretName, secretId);
            missingNamesById.set(secretId, secretName);
            value.secretId = secretId;
            addRef(secretId, secretName, 'needs-secret');
          } else {
            value.secretId = resolved.id;
          }
          value.kind = 'secret';
          delete value.name;
        }
        if (value.kind === 'secret') {
          const secretId = String(value.secretId ?? '');
          const refName = allowedId(secretId) ?? trustedNames.get(secretId);
          const missing = missingNamesById.has(String(value.secretId ?? ''));
          if (!refName && !missing) {
            throw new HttpError(400, 'invalid_input', 'Secret reference does not belong to this MCP entry');
          }
          if (!missing && !ownedById.has(secretId) && !writeById.has(secretId) && !trustedIds.has(secretId)) {
            throw new HttpError(400, 'invalid_input', 'Secret reference does not belong to this MCP entry');
          }
          addRef(secretId, refName ?? missingNamesById.get(secretId) ?? 'secret', missing ? 'needs-secret' : 'set');
        }
        values[key] = value;
      }
      if (normalized[bucket] !== undefined) normalized[bucket] = values;
    }
    if (typeof normalized.urlSecretName === 'string') {
      const name = normalized.urlSecretName;
      const resolved = allowedName(name);
      if (!resolved) {
        const secretId = missingByName.get(name) ?? randomUUID();
        missingByName.set(name, secretId);
        missingNamesById.set(secretId, name);
        normalized.urlSecretId = secretId;
        addRef(secretId, name, 'needs-secret');
      } else {
        normalized.urlSecretId = resolved.id;
      }
      delete normalized.urlSecretName;
    }
    if (typeof normalized.urlSecretId === 'string') {
      const urlSecretId = normalized.urlSecretId;
      const refName = allowedId(urlSecretId) ?? trustedNames.get(urlSecretId);
      const missing = missingNamesById.has(urlSecretId);
      if (!refName && !missing) {
        throw new HttpError(400, 'invalid_input', 'URL secret reference does not belong to this MCP entry');
      }
      if (!missing && !ownedById.has(urlSecretId) && !writeById.has(urlSecretId) && !trustedIds.has(urlSecretId)) {
        throw new HttpError(400, 'invalid_input', 'URL secret reference does not belong to this MCP entry');
      }
      addRef(urlSecretId, refName ?? missingNamesById.get(urlSecretId) ?? 'url:secret', missing ? 'needs-secret' : 'set');
    }
    const replacementIds = new Map<string, string>();
    for (const ref of refs.values()) {
      const replacement = writeByName.get(ref.name);
      if (replacement && replacement.id !== ref.secretId) {
        replacementIds.set(ref.secretId, replacement.id);
        refs.delete(ref.secretId);
      }
    }
    for (const bucket of ['env', 'headers']) {
      const values = (normalized[bucket] ?? {}) as Record<string, Cfg>;
      for (const value of Object.values(values)) {
        const replacement = replacementIds.get(String(value.secretId ?? ''));
        if (value.kind === 'secret' && replacement) value.secretId = replacement;
      }
    }
    if (typeof normalized.urlSecretId === 'string') {
      normalized.urlSecretId = replacementIds.get(normalized.urlSecretId) ?? normalized.urlSecretId;
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
    const oauthClientId = typeof server.config.oauthClientId === 'string' ? server.config.oauthClientId : undefined;
    // A pre-registered client accepts only loopback redirects: the user pastes the address back (completeOAuth).
    const redirectUri = oauthClientId ? OAUTH_LOOPBACK_REDIRECT_URI : new URL('/mcp/oauth/callback', this.o.publicUrl).toString();
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
          ...(oauthClientId ? { oauthClientId } : {}),
        }),
      );
    } catch (error) {
      await this.writeOAuthStatus(userId, serverId, request.machineId, 'failed', null, 'OAuth authorization could not be started');
      await this.audit(userId, 'api', 'oauth.start-failed', serverId);
      const agentCode = error instanceof CommandError ? error.code : error instanceof Error ? error.name : 'unknown';
      this.o.log.warn({ serverId, machineId: request.machineId, agentCode }, 'MCP OAuth start failed');
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
      redirectUri,
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
      callback: oauthClientId ? 'manual' : 'hub',
    });
  }
  /** Ends a loopback sign-in: the user pastes the address the provider sent the browser to. */
  async completeOAuth(userId: string, serverId: string, body: unknown) {
    const request = parse(mcpRegistryOAuthCompleteRequestSchema, body);
    let pasted: URL;
    try {
      pasted = new URL(request.callbackUrl.trim());
    } catch {
      throw new HttpError(400, 'oauth_callback_invalid', 'The pasted text is not a sign-in address');
    }
    const flow = this.pendingOAuth.get(pasted.searchParams.get('state') ?? '');
    if (!flow || flow.userId !== userId || flow.serverId !== serverId || flow.machineId !== request.machineId) {
      throw new HttpError(404, 'oauth_flow_not_found', 'No sign-in is waiting for this address');
    }
    if (`${pasted.origin}${pasted.pathname}` !== flow.redirectUri) throw new HttpError(400, 'oauth_callback_invalid', 'The pasted address is not the sign-in callback');
    const result = await this.oauthCallback(userId, flow.state, pasted.toString());
    if (result && !result.ok && result.error === 'OAuth authorization expired') throw new HttpError(410, 'oauth_flow_expired', 'The sign-in has expired');
    if (!result?.ok) throw new HttpError(502, 'oauth_callback_failed', result?.error ?? 'OAuth callback could not be completed');
    return mcpRegistryOAuthCompleteResponseSchema.parse({ serverId, machineId: request.machineId, state: 'pending' });
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
        if (connection && this.caps(runner.id)?.has('mcp.oauth.v1')) {
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
    if (secretIds.size && !this.caps(request.machineId)?.has('mcp.secrets.encrypted.v1')) {
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
        oauthServerId: serverId,
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
        .select(['id', 'name', 'online', 'protocol_version', 'state', 'mcp_import_state', 'mcp_imported_at', 'mcp_import_report'])
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
        capabilities: [...(this.caps(runner.id) ?? [])],
        registryEnabled: runner.mcp_import_state === 'done',
        importState: runner.mcp_import_state,
        importedAt: runner.mcp_imported_at ? new Date(runner.mcp_imported_at).getTime() : null,
        importReport: (runner.mcp_import_report ?? null) as { imported: string[]; skipped: string[] } | null,
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
  /** D2: one row per active machine — whether the server reaches it and whether it has its own config there. */
  private async serverMachines(userId: string, servers: Array<{ id: string; config: Cfg }>) {
    const [runners, overrides] = await Promise.all([
      this.o.db.selectFrom('runners').select('id').where('user_id', '=', userId).where('state', '=', 'active').orderBy('name').execute(),
      this.machineOverrideRows(userId),
    ]);
    const byPair = new Map(overrides.map(row => [`${row.server_id}:${row.runner_id}`, row]));
    const result = new Map<string, Array<{ machineId: string; enabled: boolean; customConfig: boolean }>>();
    for (const server of servers) {
      const scope = server.config.machineScope as { allMachines?: boolean; machineIds?: string[] } | undefined;
      result.set(
        server.id,
        runners.map(runner => {
          const override = byPair.get(`${server.id}:${runner.id}`);
          const inScope = !scope || scope.allMachines === true || scope.machineIds?.includes(runner.id) === true;
          return { machineId: runner.id, enabled: inScope && override?.enabled !== false, customConfig: !!override?.config };
        }),
      );
    }
    return result;
  }
  async setMachineOverride(userId: string, serverId: string, machineId: string, body: unknown) {
    const request = parse(mcpRegistryMachineOverrideRequestSchema, body);
    const server = await this.o.db.selectFrom('mcp_registry_servers').select(['id', 'config', 'revision']).where('user_id', '=', userId).where('id', '=', serverId).executeTakeFirst();
    if (!server) {
      await this.audit(userId, 'api', 'machine.override.forbidden', null, undefined, { serverId, machineId });
      throw new HttpError(404, 'mcp_server_not_found', 'MCP server not found');
    }
    const machine = await this.o.db.selectFrom('runners').select(['user_id', 'state']).where('id', '=', machineId).executeTakeFirst();
    if (!machine || machine.state === 'pending') throw new HttpError(404, 'machine_not_found', 'Machine not found');
    if (machine.user_id !== userId) {
      await this.audit(userId, 'api', 'machine.override.forbidden', serverId, undefined, { machineId });
      throw new HttpError(403, 'machine_forbidden', 'Machine belongs to another user');
    }
    const revision = Number(server.revision);
    if (revision !== request.revision) throw new HttpError(409, 'revision_conflict', 'Registry revision changed');
    const scope = (server.config.machineScope ?? { allMachines: true, machineIds: [] }) as { allMachines: boolean; machineIds: string[] };
    const outside = !scope.allMachines && !scope.machineIds.includes(machineId);
    const machineScope = request.enabled === true && outside ? { ...scope, machineIds: [...scope.machineIds, machineId] } : scope;
    await this.o.db.transaction().execute(async trx => {
      const updated = await trx
        .updateTable('mcp_registry_servers')
        .set({ config: JSON.stringify({ ...server.config, machineScope, revision: revision + 1 }), revision: revision + 1, updated_at: new Date() })
        .where('user_id', '=', userId)
        .where('id', '=', serverId)
        .where('revision', '=', String(revision))
        .returning('id')
        .executeTakeFirst();
      if (!updated) throw new HttpError(409, 'revision_conflict', 'Registry revision changed');
      const current = await trx.selectFrom('mcp_registry_machine_overrides').select(['enabled', 'config']).where('server_id', '=', serverId).where('runner_id', '=', machineId).executeTakeFirst();
      if (request.resetConfig) await trx.deleteFrom('mcp_secrets').where('user_id', '=', userId).where('server_id', '=', serverId).where('machine_id', '=', machineId).execute();
      const enabled = request.enabled ?? current?.enabled ?? true;
      const config = request.resetConfig ? null : (current?.config ?? null);
      if (enabled && !config) {
        await trx.deleteFrom('mcp_registry_machine_overrides').where('server_id', '=', serverId).where('runner_id', '=', machineId).execute();
        return;
      }
      await trx
        .insertInto('mcp_registry_machine_overrides')
        .values({ user_id: userId, server_id: serverId, runner_id: machineId, enabled, config: config ? JSON.stringify(config) : null })
        .onConflict(conflict => conflict.columns(['server_id', 'runner_id']).doUpdateSet({ enabled, config: config ? JSON.stringify(config) : null, updated_at: new Date() }))
        .execute();
    });
    await this.bump(userId);
    await this.audit(userId, 'api', 'machine.override', serverId, undefined, { machineId, enabled: request.enabled ?? null, resetConfig: request.resetConfig === true });
    await this.syncUser(userId);
    const machines = await this.serverMachines(userId, [{ id: serverId, config: { ...server.config, machineScope } }]);
    return mcpRegistryMachineOverrideResponseSchema.parse({ serverId, revision: revision + 1, machines: machines.get(serverId) ?? [] });
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
  async draftForSession(userId: string, body: unknown, sessionId: string) {
    const session = await this.o.db.selectFrom('sessions').select('id').where('id', '=', sessionId).where('user_id', '=', userId).executeTakeFirst();
    if (!session) throw new HttpError(403, 'forbidden', 'Session access denied');
    return this.draft(userId, body, sessionId);
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
  async updateExistingServerDraft(userId: string, serverId: string, body: unknown, sessionId: string, runnerId: string) {
    const prepared = prepareDraftUrlSecrets(body);
    const update = parse(mcpDraftUpdateSchema, prepared.body);
    const current = await this.o.db
      .selectFrom('mcp_registry_servers')
      .select(['id', 'name', 'config', 'enabled', 'revision'])
      .where('id', '=', serverId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!current) throw new HttpError(404, 'mcp_server_not_found', 'MCP server not found');
    const baseRevision = Number(current.revision);
    if (update.revision !== baseRevision) throw new HttpError(409, 'revision_conflict', 'Registry revision changed');
    const id = randomUUID();
    const generatedIds = new Map(prepared.urlSecrets);
    for (const write of update.secrets ?? []) {
      if (!generatedIds.has(write.name)) generatedIds.set(write.name, randomUUID());
    }
    const replacementIds = new Map<string, string>();
    const writeNames = new Set((update.secrets ?? []).map(write => write.name));
    for (const ref of (current.config.secrets ?? []) as Array<{ secretId?: string; name?: string }>) {
      if (ref.secretId && ref.name && writeNames.has(ref.name)) replacementIds.set(ref.secretId, generatedIds.get(ref.name)!);
    }
    const merged = {
      ...current.config,
      ...update.server,
      id: serverId,
      name: update.server.name ?? current.name,
      enabled: update.server.enabled ?? current.enabled,
      revision: 1,
      secrets: ((current.config.secrets ?? []) as Array<{ secretId?: string; name?: string }>).filter(ref => !ref.name || !writeNames.has(ref.name)),
    } as Cfg;
    for (const bucket of ['env', 'headers']) {
      const values = (merged[bucket] ?? {}) as Record<string, Cfg>;
      for (const value of Object.values(values)) {
        const oldId = String(value.secretId ?? '');
        if (value.kind === 'secret' && replacementIds.has(oldId)) value.secretId = replacementIds.get(oldId);
      }
      if (merged[bucket] !== undefined) merged[bucket] = values;
    }
    if (typeof merged.urlSecretId === 'string' && replacementIds.has(merged.urlSecretId)) {
      merged.urlSecretId = replacementIds.get(merged.urlSecretId);
    }
    const resolved = await this.resolveConfigSecretBindings(userId, merged, update.secrets ?? [], generatedIds, { draftId: id }, current.config);
    const config = { ...resolved.config, id: serverId, revision: 1 } as Cfg;
    parse(mcpServerConfigSchema, config);
    await this.o.db.transaction().execute(async trx => {
      await trx
        .insertInto('mcp_registry_drafts')
        .values({
          id,
          user_id: userId,
          runner_id: runnerId,
          session_id: sessionId,
          server_id: serverId,
          base_revision: baseRevision,
          name: String(config.name),
          state: 'draft',
          config: JSON.stringify(config),
          validation: null,
          revision: 1,
        })
        .execute();
      await this.persistSecretWrites(userId, { draftId: id }, resolved.writes, trx);
    });
    await this.audit(userId, sessionId, 'server.update-draft', serverId, id);
    return { draftId: id, revision: 1, state: 'draft', server: safe(config) };
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
    const row = await this.o.db.selectFrom('mcp_registry_drafts').select(['config', 'revision', 'server_id']).where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
    if (!row) throw new HttpError(404, 'draft_not_found', 'Draft not found');
    const b = parse(mcpDraftValidateSchema, body);
    if (Number(row.revision) !== b.revision) throw new HttpError(409, 'revision_conflict', 'Draft revision changed');
    const r = await this.o.db.selectFrom('runners').select(['protocol_version', 'user_id', 'name']).where('id', '=', b.machineId).where('user_id', '=', userId).executeTakeFirst();
    if (!r) throw new HttpError(403, 'forbidden', 'Machine access denied');
    if (!protocolAtLeast(r.protocol_version, MIN) || !this.caps(b.machineId)?.has('mcp.registry.v1')) {
      throw new HttpError(409, 'agent_outdated', 'Agent does not support MCP registry');
    }
    if (!this.caps(b.machineId)?.has('mcp.gateway.streamable-http.v1')) {
      throw new HttpError(409, 'agent_outdated', 'Agent does not support MCP gateway validation');
    }
    if (!this.o.agents.isOnline(b.machineId)) throw new HttpError(409, 'runner_offline', 'Target machine is offline');
    const cfg: Cfg = { ...row.config, revision: b.revision };
    const validationCfg = row.server_id ? { ...cfg, id } : cfg;
    const scope = cfg.machineScope as { allMachines?: boolean; machineIds?: string[] } | undefined;
    if (scope && !scope.allMachines && !scope.machineIds?.includes(b.machineId)) throw new HttpError(403, 'machine_not_allowed', 'Target machine is outside the server allow-list');
    const refs = new Set<string>();
    for (const bucket of ['env', 'headers'])
      for (const v of Object.values((cfg[bucket] ?? {}) as Record<string, { kind?: string; secretId?: string }>)) if (v.kind === 'secret' && v.secretId) refs.add(v.secretId);
    if (typeof cfg.urlSecretId === 'string') refs.add(cfg.urlSecretId);
    for (const secret of (cfg.secrets ?? []) as Array<{ secretId?: string }>) {
      if (typeof secret.secretId === 'string') refs.add(secret.secretId);
    }
    if (refs.size && !this.caps(b.machineId)?.has('mcp.secrets.encrypted.v1')) {
      throw new HttpError(409, 'agent_outdated', 'Agent does not support MCP secret delivery');
    }
    const secretRows = refs.size
      ? await this.o.db
          .selectFrom('mcp_secrets')
          .select(['id', 'name', 'ciphertext'])
          .where('user_id', '=', userId)
          .where('id', 'in', [...refs])
          .where(eb => eb.or([eb('draft_id', '=', id), ...(row.server_id ? [eb('server_id', '=', row.server_id)] : [])]))
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
    const savedServer = row.server_id
      ? await this.o.db.selectFrom('mcp_registry_servers').select('config').where('user_id', '=', userId).where('id', '=', row.server_id).executeTakeFirst()
      : undefined;
    const oauthServerId = savedServer && matchesSavedServerOrigin(cfg, savedServer.config) ? row.server_id : undefined;
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
        ...(oauthServerId ? { oauthServerId } : {}),
        server: parse(mcpServerConfigSchema, validationCfg),
        ...(secrets.length ? { secretDelivery: { serverId: validationCfg.id as string, revision: b.revision, machineId: b.machineId, secrets } } : {}),
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
  private async connectExistingServerDraft(
    userId: string,
    draftId: string,
    draftRevision: number,
    draft: { config: Cfg; runner_id: string | null; session_id: string | null; server_id: string; base_revision: string | number | null },
    needsAuth: boolean,
  ) {
    if (needsAuth) throw new HttpError(409, 'validation_required', 'Sign in before confirming this MCP server update');
    if (draft.base_revision === null) throw new HttpError(409, 'revision_conflict', 'Original MCP server revision is missing');
    const serverId = draft.server_id;
    const baseRevision = Number(draft.base_revision);
    const config = { ...draft.config, id: serverId, revision: baseRevision + 1 } as Cfg;
    parse(mcpServerConfigSchema, config);
    const refs = [...new Set(((config.secrets ?? []) as Array<{ secretId?: string }>).map(secret => secret.secretId).filter((id): id is string => !!id))];
    try {
      await this.o.db.transaction().execute(async trx => {
        const updated = await trx
          .updateTable('mcp_registry_servers')
          .set({
            name: String(config.name),
            enabled: config.enabled !== false,
            config: JSON.stringify(config),
            revision: baseRevision + 1,
            updated_at: new Date(),
          })
          .where('user_id', '=', userId)
          .where('id', '=', serverId)
          .where('revision', '=', String(baseRevision))
          .returning('id')
          .executeTakeFirst();
        if (!updated) throw new HttpError(409, 'revision_conflict', 'Registry revision changed');
        const claimed = await trx
          .updateTable('mcp_registry_drafts')
          .set({ state: 'connected', config: JSON.stringify(config), updated_at: new Date() })
          .where('user_id', '=', userId)
          .where('id', '=', draftId)
          .where('revision', '=', String(draftRevision))
          .where('state', '=', 'checked')
          .returning('id')
          .executeTakeFirst();
        if (!claimed) throw new HttpError(409, 'revision_conflict', 'Draft changed before confirmation');
        await trx.updateTable('mcp_secrets').set({ server_id: serverId, draft_id: null, updated_at: new Date() }).where('user_id', '=', userId).where('draft_id', '=', draftId).execute();
        let stale = trx.deleteFrom('mcp_secrets').where('user_id', '=', userId).where('server_id', '=', serverId).where('machine_id', 'is', null);
        if (refs.length) stale = stale.where('id', 'not in', refs);
        await stale.execute();
      });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if ((error as { code?: string }).code === '23505') throw new HttpError(409, 'name_taken', 'An MCP server already uses this name');
      throw error;
    }
    const registryRevision = await this.bump(userId);
    await this.audit(userId, draft.session_id ?? 'api', 'server.update-confirm', serverId, draftId);
    await this.syncUser(userId);
    let sessionUpdate: Cfg | undefined;
    if (draft.session_id && draft.runner_id && this.caps(draft.runner_id)?.has('mcp.registry.v1')) {
      const current = await this.o.db.selectFrom('sessions').select(['user_id', 'runner_id']).where('id', '=', draft.session_id).where('user_id', '=', userId).executeTakeFirst();
      if (current?.runner_id === draft.runner_id) {
        await this.o.db
          .insertInto('mcp_registry_session_updates')
          .values({
            user_id: userId,
            runner_id: draft.runner_id,
            session_id: draft.session_id,
            server_id: serverId,
            revision: registryRevision,
            activation: 'deferred',
            applied: false,
            error: 'Awaiting agent acknowledgement',
          })
          .onConflict(conflict =>
            conflict.columns(['session_id', 'revision']).doUpdateSet({
              server_id: serverId,
              activation: 'deferred',
              applied: false,
              error: 'Awaiting agent acknowledgement',
              updated_at: new Date(),
            }),
          )
          .execute();
        this.o.agents
          .get(draft.runner_id)
          ?.send('mcp.registry.session-update', { sessionId: draft.session_id, revision: registryRevision, server: parse(mcpServerConfigSchema, config), activation: 'connected-live' });
        sessionUpdate = { activation: 'pending', applied: false };
      }
    }
    return { serverId, state: 'connected', server: safe(config), ...(sessionUpdate ? { sessionUpdate } : {}) };
  }
  async connect(userId: string, id: string, body: unknown, unchecked = false) {
    const row = await this.o.db
      .selectFrom('mcp_registry_drafts')
      .select(['config', 'revision', 'state', 'validation', 'runner_id', 'session_id', 'server_id', 'base_revision'])
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
    const existingServerId = row.server_id;
    if (existingServerId) {
      if (unchecked) {
        throw new HttpError(409, 'validation_required', 'Connected MCP updates must pass validation before confirmation');
      }
      return this.connectExistingServerDraft(userId, id, b.revision, { ...row, server_id: existingServerId }, needsAuth);
    }
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
    if (!needsAuth && !unchecked && row.session_id && row.runner_id && this.caps(row.runner_id)?.has('mcp.registry.v1')) {
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
  /**
   * Capabilities of the machine: the live connection's are set before welcome, while `agent.hello` reaches this service only after
   * the status write — a request right after welcome must not see a fresh agent as outdated. Offline — the last hello's.
   */
  private caps(runnerId: string): ReadonlySet<string> | undefined {
    const connection = this.o.agents.get(runnerId);
    return connection ? new Set(connection.capabilities) : this.capabilities.get(runnerId);
  }
  /** D5: scan the machine's local MCP config; the agent reads every bound project root, the hub computes decisions against the registry. */
  async importPreview(userId: string, machineId: string, projectRoot?: string): Promise<McpImportPreviewResponse> {
    const c = this.o.agents.get(machineId);
    if (!c) throw new HttpError(409, 'runner_offline', 'Target machine is offline');
    const runner = await this.o.db
      .selectFrom('runners')
      .select(['user_id', 'protocol_version', 'home_dir', 'default_dir'])
      .where('id', '=', machineId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!runner) throw new HttpError(403, 'forbidden', 'Machine access denied');
    const capabilities = this.caps(machineId);
    if (!protocolAtLeast(runner.protocol_version, MIN) || !capabilities?.has('mcp.registry.v1') || !capabilities.has(MCP_IMPORT_V2_CAPABILITY)) {
      throw new HttpError(409, 'agent_outdated', 'Agent does not support import');
    }
    if (this.pendingImports.has(machineId)) throw new HttpError(409, 'import_busy', 'An import scan is already running on this machine');
    // session-folder D1: a project's folder on this machine is the machine's default folder plus the project's folder.
    const base = runner.default_dir ?? runner.home_dir;
    const windows = platformOfHome(runner.home_dir) === 'windows';
    const projects = base
      ? await this.o.db.selectFrom('catalog_projects').select(['id', 'folder']).where('user_id', '=', userId).where('archived', '=', false).where('folder', 'is not', null).orderBy('folder').execute()
      : [];
    const projectRoots = projects.map(project => ({ projectId: project.id, path: projectDir(base as string, project.folder, windows) }));
    const root = projectRoot ?? base ?? '~';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingImports.delete(machineId);
        reject(new HttpError(504, 'timeout', 'Import scan timed out'));
      }, this.o.importTimeoutMs ?? 45_000);
      this.pendingImports.set(machineId, { userId, resolve: value => resolve(value as McpImportPreviewResponse), reject, timer });
      c.send('mcp.import.preview', { machineId, projectRoot: root, projectRoots }, { id: randomUUID() });
    });
  }
  /** D5: apply the selected preview entries in one transaction, deciding each one again against the registry as it changes. */
  async importCommit(userId: string, body: unknown, actor = 'api'): Promise<McpImportCommitResponse> {
    const b = parse(mcpImportCommitPayload, body);
    if (new Set(b.serverIds).size !== b.serverIds.length) throw new HttpError(400, 'invalid_request', 'Selected serverIds must be unique');
    const found = await this.o.db
      .selectFrom('mcp_registry_imports')
      .select(['preview', 'state', 'runner_id'])
      .where('id', '=', b.importId)
      .where('user_id', '=', userId)
      .where('expires_at', '>', new Date())
      .executeTakeFirst();
    if (!found) throw new HttpError(404, 'import_not_found', 'Import preview not found');
    if (found.preview.revision !== b.revision) throw new HttpError(409, 'revision_conflict', 'Import preview revision changed');
    if (found.state !== 'preview') throw new HttpError(409, 'import_already_committed', 'Import preview was already committed');
    const stored = found.preview as unknown as StoredImportPreview;
    if (!Array.isArray(stored.entries)) throw new HttpError(409, 'import_outdated', 'Import preview was made by an older hub; scan again');
    const machineId = found.runner_id;
    const selectedIds = new Set(b.serverIds);
    const selected = stored.entries.filter(entry => selectedIds.has(entry.id));
    if (selected.length !== selectedIds.size) throw new HttpError(400, 'invalid_request', 'One or more selected servers are not in this preview');
    const applied: Array<{ serverId: string; name: string; decision: McpImportDecision }> = [];
    const created: Array<{ id: string; config: Cfg }> = [];
    try {
      await this.o.db.transaction().execute(async trx => {
        const claimed = await trx
          .updateTable('mcp_registry_imports')
          .set({ state: 'committed' })
          .where('id', '=', b.importId)
          .where('user_id', '=', userId)
          .where('state', '=', 'preview')
          .returning('id')
          .executeTakeFirst();
        if (!claimed) throw new HttpError(409, 'import_already_committed', 'Import preview was already committed');
        const registry = await this.importRegistry(trx, userId, machineId, true);
        const values = new Map([...registry.values, ...(await this.importSecretValues(trx, userId, b.importId))]);
        const conflicts = importConflicts(stored.entries, values);
        for (const entry of selected) {
          if (conflicts.has(entry.id)) continue;
          const existing = registry.servers.get(entry.name);
          const decision = importDecision(entry, existing, machineId, values);
          if (decision === 'unchanged' || decision === 'conflict') continue;
          const secretIds = ((entry.secrets ?? []) as SecretRef[]).map(ref => ref.secretId);
          if (decision === 'new') {
            const serverId = randomUUID();
            const config = parse(mcpServerConfigSchema, {
              ...pickImportConfig(entry),
              id: serverId,
              name: entry.name,
              enabled: true,
              mode: entry.transport === 'stdio' ? 'machine-shared' : 'remote',
              machineScope: { allMachines: false, machineIds: [machineId] },
              projectIds: entry.projectId ? [entry.projectId] : [],
              secrets: entry.secrets ?? [],
              revision: 1,
            }) as Cfg;
            await trx
              .insertInto('mcp_registry_servers')
              .values({ id: serverId, user_id: userId, name: entry.name, config: JSON.stringify(config), enabled: true })
              .execute();
            if (secretIds.length) {
              await trx
                .updateTable('mcp_secrets')
                .set({ server_id: serverId, import_id: null, updated_at: new Date() })
                .where('user_id', '=', userId)
                .where('import_id', '=', b.importId)
                .where('id', 'in', secretIds)
                .execute();
            }
            registry.servers.set(entry.name, { id: serverId, config, revision: 1, override: null });
            created.push({ id: serverId, config });
            applied.push({ serverId, name: entry.name, decision });
            continue;
          }
          const server = existing!;
          const scope = (server.config.machineScope ?? { allMachines: true, machineIds: [] }) as { allMachines: boolean; machineIds: string[] };
          const machineScope = scope.allMachines || scope.machineIds.includes(machineId) ? scope : { ...scope, machineIds: [...scope.machineIds, machineId] };
          const current = Array.isArray(server.config.projectIds) ? (server.config.projectIds as string[]) : [];
          let projectIds: string[] = [];
          if (entry.projectId) projectIds = current.length && !current.includes(entry.projectId) ? [...current, entry.projectId] : current;
          const revision = server.revision + 1;
          const config = { ...server.config, machineScope, projectIds, revision };
          const updated = await trx
            .updateTable('mcp_registry_servers')
            .set({ config: JSON.stringify(config), revision, updated_at: new Date() })
            .where('user_id', '=', userId)
            .where('id', '=', server.id)
            .where('revision', '=', String(server.revision))
            .returning('id')
            .executeTakeFirst();
          if (!updated) throw new HttpError(409, 'revision_conflict', 'Registry revision changed');
          let override = server.override;
          if (decision === 'add-machine') {
            if (override && !override.config) {
              await trx.deleteFrom('mcp_registry_machine_overrides').where('server_id', '=', server.id).where('runner_id', '=', machineId).execute();
              override = null;
            } else if (override && !override.enabled) {
              await trx.updateTable('mcp_registry_machine_overrides').set({ enabled: true, updated_at: new Date() }).where('server_id', '=', server.id).where('runner_id', '=', machineId).execute();
              override = { ...override, enabled: true };
            }
          } else {
            await trx.deleteFrom('mcp_secrets').where('user_id', '=', userId).where('server_id', '=', server.id).where('machine_id', '=', machineId).execute();
            if (secretIds.length) {
              await trx
                .updateTable('mcp_secrets')
                .set({ server_id: server.id, machine_id: machineId, import_id: null, updated_at: new Date() })
                .where('user_id', '=', userId)
                .where('import_id', '=', b.importId)
                .where('id', 'in', secretIds)
                .execute();
            }
            const picked = pickImportConfig(entry);
            const overrideConfig: Cfg = { secrets: entry.secrets ?? [] };
            for (const field of OVERRIDE_FIELDS) overrideConfig[field] = picked[field] ?? null;
            const sameTransport = entry.transport === server.config.transport;
            overrideConfig.mode = sameTransport ? server.config.mode : entry.transport === 'stdio' ? 'machine-shared' : 'remote';
            await trx
              .insertInto('mcp_registry_machine_overrides')
              .values({ user_id: userId, server_id: server.id, runner_id: machineId, enabled: true, config: JSON.stringify(overrideConfig) })
              .onConflict(conflict => conflict.columns(['server_id', 'runner_id']).doUpdateSet({ enabled: true, config: JSON.stringify(overrideConfig), updated_at: new Date() }))
              .execute();
            override = { enabled: true, config: overrideConfig };
          }
          registry.servers.set(entry.name, { id: server.id, config, revision, override });
          applied.push({ serverId: server.id, name: entry.name, decision });
        }
        await trx.deleteFrom('mcp_secrets').where('user_id', '=', userId).where('import_id', '=', b.importId).execute();
      });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if ((error as { code?: string }).code === '23505') throw new HttpError(409, 'name_taken', 'An MCP server with this name already exists');
      throw error;
    }
    if (applied.length) await this.bump(userId);
    await this.audit(userId, actor, 'import.commit', null, undefined, { machineId, servers: applied.map(item => ({ name: item.name, decision: item.decision })) });
    for (const server of created) {
      if (typeof server.config.oauthClientId !== 'string') continue;
      await this.writeOAuthStatus(userId, server.id, machineId, 'needs-login', null, null, { registryReady: false });
    }
    if (applied.length) await this.syncUser(userId);
    return mcpImportCommitResponseSchema.parse({ imported: applied.length, servers: applied });
  }
  /** D6: first connection of an agent with import v2 on a machine that is not on the registry yet. */
  private async autoImport(runnerId: string, userId: string) {
    if (!this.caps(runnerId)?.has(MCP_IMPORT_V2_CAPABILITY)) return;
    const machine = await this.o.db.selectFrom('runners').select('mcp_import_state').where('id', '=', runnerId).where('user_id', '=', userId).where('state', '=', 'active').executeTakeFirst();
    if (machine?.mcp_import_state !== 'auto-pending') return;
    try {
      const preview = await this.importPreview(userId, runnerId);
      const serverIds = preview.servers.filter(entry => entry.selected).map(entry => entry.id);
      const committed = serverIds.length ? await this.importCommit(userId, { importId: preview.importId, revision: preview.revision, serverIds, userConfirmed: true }, runnerId) : null;
      const importedNames = new Set((committed?.servers ?? []).map(server => server.name));
      // A server already on the registry for this machine is not a skip: the machine keeps getting it.
      const skipped = preview.servers.filter(entry => entry.decision !== 'unchanged' && !importedNames.has(entry.name));
      const report = { imported: [...importedNames], skipped: skipped.map(entry => entry.name) };
      await this.o.db
        .updateTable('runners')
        .set({ mcp_import_state: 'done', mcp_imported_at: new Date(), mcp_import_report: JSON.stringify(report) })
        .where('id', '=', runnerId)
        .where('user_id', '=', userId)
        .execute();
      await this.audit(userId, runnerId, 'import.auto', null, undefined, report);
      await this.syncRunner(runnerId, userId);
    } catch (error) {
      const code = error instanceof HttpError ? error.code : 'import_failed';
      this.o.log.warn({ runnerId, code, errorClass: error instanceof Error ? error.name : 'unknown' }, 'MCP auto-import failed');
      await this.audit(userId, runnerId, 'import.auto.failed', null, undefined, { code });
    }
  }
  /** Registry servers of the user as the machine sees them, plus decrypted values of their shared and machine secrets. */
  private async importRegistry(db: Db | Transaction<Database>, userId: string, machineId: string, lock = false) {
    let query = db.selectFrom('mcp_registry_servers').select(['id', 'name', 'config', 'revision']).where('user_id', '=', userId);
    if (lock) query = query.forUpdate();
    const rows = await query.execute();
    const overrides = await db.selectFrom('mcp_registry_machine_overrides').select(['server_id', 'enabled', 'config']).where('user_id', '=', userId).where('runner_id', '=', machineId).execute();
    const overrideByServer = new Map(overrides.map(row => [row.server_id, { enabled: row.enabled, config: row.config }]));
    const servers = new Map<string, ImportRegistryServer>();
    for (const row of rows) servers.set(row.name, { id: row.id, config: row.config, revision: Number(row.revision), override: overrideByServer.get(row.id) ?? null });
    const secrets = rows.length
      ? await db
          .selectFrom('mcp_secrets')
          .select(['id', 'ciphertext'])
          .where('user_id', '=', userId)
          .where(
            'server_id',
            'in',
            rows.map(row => row.id),
          )
          .where(eb => eb.or([eb('machine_id', 'is', null), eb('machine_id', '=', machineId)]))
          .execute()
      : [];
    const values = new Map(secrets.map(row => [row.id, decryptSecret(this.o.key, userId, row.id, row.ciphertext)]));
    return { servers, values };
  }
  private async importSecretValues(db: Db | Transaction<Database>, userId: string, importId: string) {
    const rows = await db.selectFrom('mcp_secrets').select(['id', 'ciphertext']).where('user_id', '=', userId).where('import_id', '=', importId).execute();
    return new Map(rows.map(row => [row.id, decryptSecret(this.o.key, userId, row.id, row.ciphertext)]));
  }
  /** Preview as the user sees it: decisions against the current registry, default selection, masked secrets. */
  private async importView(userId: string, stored: StoredImportPreview): Promise<McpImportPreviewResponse> {
    const registry = await this.importRegistry(this.o.db, userId, stored.machineId);
    const values = new Map([...registry.values, ...(await this.importSecretValues(this.o.db, userId, stored.importId))]);
    const conflicts = importConflicts(stored.entries, values);
    const servers = stored.entries.map(entry => {
      const decision = conflicts.has(entry.id) ? 'conflict' : importDecision(entry, registry.servers.get(entry.name), stored.machineId, values);
      const warnings = [...(entry.warnings ?? [])];
      if (conflicts.has(entry.id) && !warnings.includes('project-conflict')) warnings.push('project-conflict');
      const selectable = decision !== 'unchanged' && decision !== 'conflict';
      return {
        id: entry.id,
        name: entry.name,
        transport: entry.transport,
        ...(typeof entry.command === 'string' ? { command: entry.command } : {}),
        ...(typeof entry.url === 'string' ? { url: entry.url } : {}),
        source: entry.source,
        ...(entry.origin ? { origin: entry.origin } : {}),
        ...(entry.projectId ? { projectId: entry.projectId } : {}),
        decision,
        selectable,
        selected: selectable && !warnings.includes('unbound-path'),
        warnings,
        secrets: ((entry.secrets ?? []) as SecretRef[]).map(ref => ({ name: ref.name, masked: true as const })),
      };
    });
    return mcpImportPreviewResponseSchema.parse({
      importId: stored.importId,
      machineId: stored.machineId,
      revision: stored.revision,
      servers,
      secretsCaptured: stored.secretsCaptured,
      warnings: stored.warnings,
      notices: ['claude-ai-connectors'],
    });
  }
  private async storeImportPreview(runnerId: string, payload: Cfg) {
    const pending = this.pendingImports.get(runnerId);
    const userId = this.o.agents.get(runnerId)?.userId;
    if (!userId || !pending || pending.userId !== userId) throw new HttpError(403, 'forbidden', 'Import result has no matching owner request');
    const result = parse(mcpImportPreviewResultPayload, payload);
    const importId = result.importId;
    const warnings = [...result.warnings];
    const seenIds = new Set<string>();
    const entries: ImportEntryRecord[] = result.servers.map(server => {
      const entryId = seenIds.has(server.id) ? randomUUID() : server.id;
      seenIds.add(entryId);
      return { ...server, id: entryId, secrets: [] as SecretRef[], warnings: [...(server.warnings ?? [])] } as ImportEntryRecord;
    });
    const agentIds = new Map(result.servers.map((server, index) => [server.id, entries[index]!]));
    await this.o.db
      .insertInto('mcp_registry_imports')
      .values({ id: importId, user_id: userId, runner_id: runnerId, preview: JSON.stringify({ importId, revision: 1, entries: [] }), state: 'preview' })
      .execute();
    const firstUrlSecret = new Set<string>();
    for (const secret of result.secretValues) {
      const entry = (secret.entryId ? agentIds.get(secret.entryId) : undefined) ?? entries.find(item => item.name === secret.serverName);
      if (!entry) throw new HttpError(400, 'invalid_import', 'Imported secret does not match a server');
      const secretId = randomUUID();
      const label = `${secret.location}:${secret.key}`;
      await this.o.db
        .insertInto('mcp_secrets')
        .values({ id: secretId, user_id: userId, import_id: importId, name: label, ciphertext: encryptSecret(this.o.key, userId, secretId, secret.value), server_id: null, draft_id: null })
        .execute();
      if (secret.location === 'env' || secret.location === 'header') {
        const key = secret.location === 'env' ? 'env' : 'headers';
        entry[key] = { ...((entry[key] ?? {}) as Cfg), [secret.key]: { kind: 'secret', secretId } };
      } else {
        if (typeof entry.url !== 'string') throw new HttpError(400, 'invalid_import', 'URL secret has no matching server URL');
        const url = new URL(entry.url);
        if (secret.key === 'username') url.username = URL_SECRET_PLACEHOLDER;
        else if (secret.key === 'password') url.password = URL_SECRET_PLACEHOLDER;
        else url.searchParams.set(secret.key, URL_SECRET_PLACEHOLDER);
        entry.url = url.toString();
        if (!firstUrlSecret.has(entry.id)) {
          firstUrlSecret.add(entry.id);
          entry.urlSecretId = secretId;
        }
      }
      (entry.secrets as SecretRef[]).push({ secretId, name: label, state: 'set' });
    }
    const valid = entries.filter(entry => {
      const dropped = dropEmptySensitiveValues(entry);
      if (dropped.length) warnings.push(`${entry.name}: empty ${dropped.join(', ')} not imported`.slice(0, 500));
      if (mcpServerConfigSchema.safeParse(entry).success) return true;
      warnings.push(`${entry.name}: invalid configuration, skipped`.slice(0, 500));
      return false;
    });
    const stored: StoredImportPreview = { importId, machineId: runnerId, revision: 1, entries: valid, secretsCaptured: result.secretsCaptured, warnings: warnings.slice(0, 100) };
    await this.o.db
      .updateTable('mcp_registry_imports')
      .set({ preview: JSON.stringify(stored) })
      .where('id', '=', importId)
      .where('user_id', '=', userId)
      .execute();
    const view = await this.importView(userId, stored);
    await this.audit(userId, runnerId, 'import.preview', null);
    clearTimeout(pending.timer);
    this.pendingImports.delete(runnerId);
    pending.resolve(view);
  }
  private async handleDraftRequest(runnerId: string, payload: unknown) {
    const req = parse(mcpDraftRequestPayload, payload);
    const conn = this.o.agents.get(runnerId);
    if (!conn) return;
    const send = (response: unknown) => conn.send('mcp.draft.result', response);
    const fail = (code: 'name_taken' | 'forbidden' | 'validation_failed' | 'timeout' | 'needs_secret' | 'not_found' | 'revision_conflict' | 'invalid_input' | 'unavailable', message: string) =>
      send({ requestId: req.requestId, ok: false, error: { code, message: message.slice(0, 500) } });
    if (!this.caps(runnerId)?.has(MCP_REGISTRY_CAPABILITIES[MCP_REGISTRY_CAPABILITIES.length - 1]!)) return fail('unavailable', 'This agent does not support MCP registry tools');
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
      const validateToolDraft = async (draft: { draftId: string; revision: number; state: string; server: Cfg }) => {
        let validation: z.infer<typeof mcpDraftValidationResultSchema>;
        let currentDraft = draft;
        try {
          const checked = await this.validate(session.user_id, draft.draftId, { machineId: runnerId, revision: draft.revision });
          const raw = checked.validation as Cfg;
          const rawTools = Array.isArray(raw.tools) ? (raw.tools as Cfg[]) : [];
          const toolsTruncated =
            rawTools.length > 100 ||
            rawTools.some(
              tool => typeof tool.name !== 'string' || tool.name.length > 128 || !/^[a-zA-Z0-9_.-]+$/.test(tool.name) || (typeof tool.description === 'string' && tool.description.length > 200),
            );
          validation = {
            ok: raw.ok === true,
            status: raw.status as z.infer<typeof mcpDraftValidationResultSchema>['status'],
            tools: rawTools
              .slice(0, 100)
              .flatMap((tool: Cfg) =>
                typeof tool.name === 'string' && tool.name.length <= 128 && /^[a-zA-Z0-9_.-]+$/.test(tool.name)
                  ? [{ name: tool.name, ...(typeof tool.description === 'string' ? { description: tool.description.slice(0, 200) } : {}) }]
                  : [],
              ),
            ...(toolsTruncated ? { truncated: true } : {}),
            ...(typeof raw.error === 'string' ? { error: raw.error.slice(0, 500) } : {}),
            oauthRequired: raw.oauthRequired === true,
          };
          currentDraft = { ...draft, state: checked.state };
        } catch (error) {
          const code = error instanceof HttpError ? error.code : 'validation_failed';
          const status = code === 'needs_secret' ? 'needs-secret' : code === 'timeout' ? 'timeout' : 'validation-failed';
          const message = status === 'needs-secret' ? 'One or more configured secrets are missing.' : status === 'timeout' ? 'Connection check timed out.' : 'Connection check failed.';
          validation = { ok: false, status, tools: [], error: message, oauthRequired: false };
          try {
            const latest = await this.getDraft(session.user_id, draft.draftId);
            currentDraft = { ...draft, state: latest.state };
          } catch {
            // The original draft response is safe to return if its status cannot be refreshed.
          }
        }
        return {
          draftId: draft.draftId,
          revision: draft.revision,
          draft: { ...currentDraft, server: safe(currentDraft.server) },
          validation,
          confirmationUrl: `/s/${encodeURIComponent(req.sessionId)}?mcp=1`,
        };
      };
      if (req.op === 'add') {
        const draft = await this.draft(session.user_id, req.payload, req.sessionId);
        return send({ requestId: req.requestId, ok: true, result: await validateToolDraft(draft as { draftId: string; revision: number; state: string; server: Cfg }) });
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
      const draft =
        'serverId' in req.payload
          ? await this.updateExistingServerDraft(session.user_id, req.payload.serverId, req.payload.update, req.sessionId, runnerId)
          : await this.updateDraft(session.user_id, req.payload.draftId, req.payload.update, req.sessionId);
      return send({ requestId: req.requestId, ok: true, result: await validateToolDraft(draft as { draftId: string; revision: number; state: string; server: Cfg }) });
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
  private async audit(userId: string, actor: string, action: string, serverId: string | null, draftId?: string, details?: Cfg) {
    await this.o.db
      .insertInto('mcp_registry_audit')
      .values({ user_id: userId, actor, action, server_id: serverId, draft_id: draftId ?? null, ...(details ? { details: JSON.stringify(details) } : {}) })
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
  private async machineOverrideRows(userId: string, runnerId?: string): Promise<MachineOverrideRow[]> {
    let query = this.o.db.selectFrom('mcp_registry_machine_overrides').select(['server_id', 'runner_id', 'enabled', 'config']).where('user_id', '=', userId);
    if (runnerId) query = query.where('runner_id', '=', runnerId);
    return query.execute();
  }
  /** D2: replace each server by its effective config on the machine; override secrets get their masked state. */
  private async withMachineConfig(userId: string, runnerId: string, servers: Cfg[], overrides: Map<string, MachineOverrideRow>) {
    const configured = servers.filter(server => overrides.get(String(server.id))?.config);
    if (!configured.length) return servers;
    const stored = await this.o.db
      .selectFrom('mcp_secrets')
      .select('id')
      .where('user_id', '=', userId)
      .where('machine_id', '=', runnerId)
      .where(
        'server_id',
        'in',
        configured.map(server => String(server.id)),
      )
      .execute();
    const storedIds = new Set(stored.map(row => row.id));
    return servers.map(server => {
      const config = overrides.get(String(server.id))?.config;
      if (!config) return server;
      const overrideSecrets = ((config.secrets ?? []) as SecretRef[]).map(ref => ({
        secretId: ref.secretId,
        name: ref.name,
        state: storedIds.has(ref.secretId) ? 'set' : 'needs-secret',
        masked: true as const,
      }));
      return effectiveServer(server, { ...config, secrets: overrideSecrets });
    });
  }
  private async syncRunner(runnerId: string, userId: string) {
    const conn = this.o.agents.get(runnerId);
    if (!conn) return;
    if (!this.caps(runnerId)?.has('mcp.registry.v1')) return;
    const machine = await this.o.db.selectFrom('runners').select('mcp_import_state').where('user_id', '=', userId).where('id', '=', runnerId).where('state', '=', 'active').executeTakeFirst();
    if (!machine) return;
    const r = await this.list(userId);
    // D1: a machine is on the registry once its local config is imported; before that it gets nothing.
    r.registryEnabled = machine.mcp_import_state === 'done';
    if (!r.registryEnabled) r.servers = [];
    const machineOverrides = new Map((await this.machineOverrideRows(userId, runnerId)).map(row => [row.server_id, row]));
    // D1: an agent without import v2 cannot limit a server to projects, so it does not get such servers.
    const projectAware = this.caps(runnerId)?.has(MCP_IMPORT_V2_CAPABILITY) === true;
    r.servers = r.servers.filter((server: Cfg) => {
      if (server.enabled === false) return false;
      if (machineOverrides.get(String(server.id))?.enabled === false) return false;
      if (!projectAware && Array.isArray(server.projectIds) && server.projectIds.length) return false;
      const scope = server.machineScope as { allMachines?: boolean; machineIds?: string[] } | undefined;
      return !scope || scope.allMachines === true || scope.machineIds?.includes(runnerId) === true;
    });
    r.servers = (await this.withMachineConfig(userId, runnerId, r.servers, machineOverrides)) as typeof r.servers;
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
      const ids = ((server.secrets ?? []) as Array<{ secretId: string }>).map(x => x.secretId);
      if (!ids.length) continue;
      // D2: a secret of a machine override goes to that machine only.
      const rows = await this.o.db
        .selectFrom('mcp_secrets')
        .select(['id', 'name', 'ciphertext'])
        .where('user_id', '=', userId)
        .where('server_id', '=', String(server.id))
        .where('id', 'in', ids)
        .where(eb => eb.or([eb('machine_id', 'is', null), eb('machine_id', '=', runnerId)]))
        .execute();
      if (!rows.length || !this.caps(runnerId)?.has('mcp.secrets.encrypted.v1')) continue;
      const secrets = rows.map(s => ({ name: s.name, value: decryptSecret(this.o.key, userId, s.id, s.ciphertext) }));
      conn.send('mcp.secrets.deliver', { serverId: server.id, revision: server.revision, machineId: runnerId, secrets }, { id: randomUUID() });
    }
    const oauth =
      activeServerIds.length && this.caps(runnerId)?.has('mcp.oauth.v1')
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
    if (!protocolAtLeast(runner.protocol_version, MIN) || !this.caps(machineId)?.has('mcp.oauth.v1')) {
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
    // Redact every secret this machine may hold for the server, its own override secrets included.
    const secretRows = await this.o.db
      .selectFrom('mcp_secrets')
      .select(['id', 'ciphertext'])
      .where('user_id', '=', userId)
      .where('server_id', '=', serverId)
      .where(eb => eb.or([eb('machine_id', 'is', null), eb('machine_id', '=', machineId)]))
      .execute();
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
  app.put('/api/mcp/registry/servers/:id/machines/:machineId', async req => {
    const params = req.params as { id: string; machineId: string };
    return service.setMachineOverride(req.user!.id, params.id, params.machineId, req.body);
  });
  app.post('/api/mcp/registry/servers/:id/oauth/start', async (req, reply) => reply.code(202).send(await service.startOAuth(req.user!.id, (req.params as { id: string }).id, req.body)));
  app.post('/api/mcp/registry/servers/:id/oauth/complete', async req => service.completeOAuth(req.user!.id, (req.params as { id: string }).id, req.body));
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
  app.post('/api/mcp/registry/drafts', async (req, reply) => {
    const body = parse(apiDraftCreateRequestSchema, req.body);
    const sessionId = body.sessionId;
    const created = sessionId ? await service.draftForSession(req.user!.id, req.body, sessionId) : await service.draft(req.user!.id, req.body);
    return reply.code(201).send(created);
  });
  app.get('/api/mcp/registry/drafts/:id', async req => service.getDraft(req.user!.id, (req.params as { id: string }).id));
  app.patch('/api/mcp/registry/drafts/:id', async req => service.updateDraft(req.user!.id, (req.params as { id: string }).id, req.body));
  app.post('/api/mcp/registry/drafts/:id/validate', async req => {
    const b = req.body as { machineId: string; revision: number };
    return service.validate(req.user!.id, (req.params as { id: string }).id, b);
  });
  app.post('/api/mcp/registry/drafts/:id/connect', async req => service.connect(req.user!.id, (req.params as { id: string }).id, req.body));
  app.post('/api/mcp/registry/drafts/:id/save-unchecked', async req => service.connect(req.user!.id, (req.params as { id: string }).id, req.body, true));
  app.post('/api/mcp/registry/import/preview', async req => {
    const b = parse(mcpImportPreviewRequestSchema, req.body);
    return service.importPreview(req.user!.id, b.machineId, b.projectRoot);
  });
  app.post('/api/mcp/registry/import/commit', async req => service.importCommit(req.user!.id, req.body));
}
