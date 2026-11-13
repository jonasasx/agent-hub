import { z } from 'zod';

const id = z.guid();
const machineId = z.string().min(1).max(128);
const name = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.-]+$/);
const safeText = z.string().max(500);

export const MCP_REGISTRY_PROTOCOL_VERSION = '1.13' as const;
export const MCP_REGISTRY_CAPABILITIES = ['mcp.registry.v1', 'mcp.gateway.streamable-http.v1', 'mcp.secrets.encrypted.v1', 'mcp.oauth.v1', 'mcp.registry.tools.v1'] as const;
/** Import v2 (change `mcp-hub-only`, D4): Codex, plugins, all projects; the agent honours `projectIds`. Kept apart from the list above. */
export const MCP_IMPORT_V2_CAPABILITY = 'mcp.import.v2' as const;
export const mcpImportStateSchema = z.enum(['auto-pending', 'done']);
export const mcpTransportSchema = z.enum(['stdio', 'http', 'sse']);
export const mcpInstanceModeSchema = z.enum(['remote', 'machine-shared', 'per-session']);
export const mcpSecretStateSchema = z.enum(['set', 'needs-secret']);
export const mcpSecretReferenceSchema = z.object({ secretId: id, name: z.string().min(1).max(128), state: mcpSecretStateSchema });
export const mcpConfigValueSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('literal'), value: z.string().max(8192) }), z.object({ kind: z.literal('secret'), secretId: id })]);
export const mcpConfigValueInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), value: z.string().max(8192) }),
  z.object({ kind: z.literal('secret'), secretId: id }),
  z.object({ kind: z.literal('secret-name'), name: z.string().min(1).max(128) }),
]);
export const mcpMachineScopeSchema = z.object({ allMachines: z.boolean(), machineIds: z.array(machineId).max(100) });
export const mcpMachineScopeInputSchema = mcpMachineScopeSchema.superRefine((scope, ctx) => {
  if (!scope.allMachines && scope.machineIds.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['machineIds'], message: 'include at least one machine when allMachines is false' });
  }
});
const mcpServerConfigBaseSchema = z.object({
  id,
  name,
  enabled: z.boolean(),
  transport: mcpTransportSchema,
  mode: mcpInstanceModeSchema,
  command: z.string().min(1).max(2048).optional(),
  args: z.array(z.string().max(8192)).max(256).optional(),
  url: z.url().max(4096).optional(),
  urlSecretId: id.optional(),
  env: z.record(z.string(), mcpConfigValueSchema).optional(),
  headers: z.record(z.string(), mcpConfigValueSchema).optional(),
  secrets: z.array(mcpSecretReferenceSchema).max(256).default([]),
  machineScope: mcpMachineScopeSchema,
  projectIds: z.array(id).max(100).default([]),
  oauthClientId: z.string().min(1).max(256).optional(),
  revision: z.number().int().nonnegative(),
});
const mcpServerConfigInputBaseSchema = mcpServerConfigBaseSchema.extend({
  machineScope: mcpMachineScopeInputSchema,
  env: z.record(z.string(), mcpConfigValueInputSchema).optional(),
  headers: z.record(z.string(), mcpConfigValueInputSchema).optional(),
  urlSecretName: z.string().min(1).max(128).optional(),
});
function validateSensitiveInputs(
  server: { env?: Record<string, z.infer<typeof mcpConfigValueInputSchema>>; headers?: Record<string, z.infer<typeof mcpConfigValueInputSchema>> },
  ctx: z.RefinementCtx,
) {
  const secretName = /(?:token|api[-_]?key|secret|password|credential|authorization|cookie)/i;
  for (const bucket of ['env', 'headers'] as const) {
    for (const [key, value] of Object.entries(server[bucket] ?? {})) {
      if (secretName.test(key) && value.kind === 'literal') {
        ctx.addIssue({ code: 'custom', path: [bucket, key], message: 'sensitive values must use a secret reference' });
      }
    }
  }
}
/** `oauthClientId: null` clears a pre-registered OAuth client: the server returns to dynamic client registration. */
export const mcpServerConfigPatchInputSchema = mcpServerConfigInputBaseSchema
  .partial()
  .omit({ id: true, revision: true, secrets: true })
  .extend({ oauthClientId: z.string().trim().min(1).max(256).nullable().optional() })
  .superRefine(validateSensitiveInputs);
export const mcpServerConfigSchema = mcpServerConfigBaseSchema.superRefine((server, ctx) => {
  if (server.transport === 'stdio' && !server.command) ctx.addIssue({ code: 'custom', path: ['command'], message: 'stdio requires command' });
  if (server.transport !== 'stdio' && !server.url) ctx.addIssue({ code: 'custom', path: ['url'], message: 'HTTP transport requires url' });
  const secretName = /(?:token|api[-_]?key|secret|password|credential|authorization|cookie)/i;
  for (const key of Object.keys(server.env ?? {}))
    if (secretName.test(key) && server.env?.[key]?.kind !== 'secret') {
      ctx.addIssue({ code: 'custom', path: ['env', key], message: 'sensitive values must use a secret reference' });
    }
  for (const key of Object.keys(server.headers ?? {}))
    if (secretName.test(key) && server.headers?.[key]?.kind !== 'secret') {
      ctx.addIssue({ code: 'custom', path: ['headers', key], message: 'sensitive values must use a secret reference' });
    }
  if (server.url) {
    const url = new URL(server.url);
    const placeholder = '__AGENT_HUB_SECRET__';
    if (
      (url.username && (decodeURIComponent(url.username) !== placeholder || !server.urlSecretId)) ||
      (url.password && (decodeURIComponent(url.password) !== placeholder || !server.urlSecretId)) ||
      [...url.searchParams.entries()].some(([key, value]) => secretName.test(key) && (value !== placeholder || !server.urlSecretId))
    ) {
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'URL credentials must use a secret reference' });
    }
  }
});
function validateInputConfig(server: z.infer<typeof mcpServerConfigInputBaseSchema>, ctx: z.RefinementCtx) {
  validateSensitiveInputs(server, ctx);
  if (server.urlSecretId && server.urlSecretName) {
    ctx.addIssue({ code: 'custom', path: ['urlSecretName'], message: 'provide urlSecretId or urlSecretName, not both' });
  }
  if (server.url) {
    const url = new URL(server.url);
    const placeholder = '__AGENT_HUB_SECRET__';
    const hasSecretBinding = !!server.urlSecretId || !!server.urlSecretName;
    if (
      (url.username && (decodeURIComponent(url.username) !== placeholder || !hasSecretBinding)) ||
      (url.password && (decodeURIComponent(url.password) !== placeholder || !hasSecretBinding)) ||
      [...url.searchParams.entries()].some(([key, value]) => /(?:token|api[-_]?key|secret|password|credential|authorization|cookie)/i.test(key) && (value !== placeholder || !hasSecretBinding))
    ) {
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'URL credentials must use a secret reference' });
    }
  }
}
export const mcpRegistrySnapshotSchema = z.object({
  protocol: z.literal(MCP_REGISTRY_PROTOCOL_VERSION),
  revision: z.number().int().nonnegative(),
  generatedAt: z.number().int().nonnegative(),
  registryEnabled: z.boolean().default(false),
  servers: z.array(mcpServerConfigSchema).max(1000),
  projectOverrides: z
    .array(z.object({ projectId: id, serverId: id, enabled: z.literal(false) }))
    .max(100_000)
    .optional(),
});
export const mcpRegistryAgentStatusSchema = z.object({
  machineId,
  machineName: z.string().max(256),
  online: z.boolean(),
  protocolVersion: z.string().max(32),
  capabilities: z.array(z.string().max(128)).max(100),
  registryEnabled: z.boolean().default(false),
  importState: mcpImportStateSchema.optional(),
  importedAt: z.number().int().nonnegative().nullable().optional(),
  importReport: z
    .object({ imported: z.array(z.string().max(128)).max(1000), skipped: z.array(z.string().max(128)).max(1000) })
    .nullable()
    .optional(),
});
export const mcpRegistryDraftSchema = z.object({
  draftId: id,
  revision: z.number().int().nonnegative(),
  state: z.enum(['draft', 'validating', 'checked', 'validation-failed', 'needs-secret', 'needs_auth', 'connected', 'saved-unchecked']),
  server: mcpServerConfigSchema,
  validation: z
    .object({
      ok: z.boolean(),
      checkedAt: z.number().int().nonnegative().optional(),
      error: safeText.optional(),
      tools: z
        .array(z.object({ name, description: z.string().max(2000).optional() }))
        .max(1000)
        .optional(),
    })
    .optional(),
});
/** Secret plaintext is accepted only on write commands; never use this schema for responses. */
export const mcpSecretWriteSchema = z.object({ name: z.string().min(1).max(128), value: z.string().min(1).max(65536) });
export const mcpSecretInputSchema = z.array(mcpSecretWriteSchema).max(256);
export const mcpSecretMetadataSchema = z.object({ id, name: z.string().min(1).max(128), state: mcpSecretStateSchema, masked: z.literal(true) });
/** Secret values are carried only inside the authenticated hub-to-agent delivery envelope. */
export const mcpSecretDeliverySchema = z.object({
  serverId: id,
  revision: z.number().int().nonnegative(),
  machineId,
  secrets: z.array(z.object({ name: z.string().min(1).max(128), value: z.string().min(1).max(65536) })).max(256),
});
export const mcpGatewayStatusSchema = z
  .object({
    serverId: id,
    machineId,
    sessionId: id.optional(),
    status: z.enum(['stopped', 'starting', 'ready', 'needs-secret', 'failed']),
    endpoint: z
      .string()
      .regex(/^http:\/\/127\.0\.0\.1:\d{1,5}\/mcp$/)
      .optional(),
    error: safeText.optional(),
    observedAt: z.number().int().nonnegative(),
  })
  .superRefine((status, ctx) => {
    if (status.endpoint) {
      const port = Number(new URL(status.endpoint).port);
      if (port < 1 || port > 65535) ctx.addIssue({ code: 'custom', path: ['endpoint'], message: 'invalid loopback port' });
    }
    if (status.status === 'ready' && !status.endpoint) ctx.addIssue({ code: 'custom', path: ['endpoint'], message: 'ready gateway requires endpoint' });
  });
export const mcpGatewayStartSchema = z.object({ serverId: id, revision: z.number().int().nonnegative(), sessionId: id.optional(), bearerToken: z.string().min(32).max(512) });
export const mcpGatewayStopSchema = z.object({ serverId: id, sessionId: id.optional(), reason: z.enum(['disabled', 'idle', 'requested', 'revision-changed']) });
export const mcpCapabilitiesSchema = z.object({ protocol: z.literal(MCP_REGISTRY_PROTOCOL_VERSION), capabilities: z.array(z.enum(MCP_REGISTRY_CAPABILITIES)).max(MCP_REGISTRY_CAPABILITIES.length) });
export const mcpDraftCreateSchema = z
  .object({
    server: mcpServerConfigInputBaseSchema.omit({ id: true, revision: true, secrets: true }).extend({ id: id.optional() }),
    secrets: mcpSecretInputSchema.optional(),
  })
  .superRefine((input, ctx) => validateInputConfig(input.server as z.infer<typeof mcpServerConfigInputBaseSchema>, ctx));
export const mcpDraftUpdateSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    server: mcpServerConfigPatchInputSchema,
    secrets: mcpSecretInputSchema.optional(),
  })
  .superRefine((input, ctx) => validateSensitiveInputs(input.server, ctx));
export const mcpDraftValidateSchema = z.object({ machineId, revision: z.number().int().nonnegative() });
export const mcpDraftConnectSchema = z.object({ revision: z.number().int().nonnegative(), userConfirmed: z.literal(true) });
export const mcpDraftSaveUncheckedSchema = z.object({ revision: z.number().int().nonnegative(), userConfirmed: z.literal(true) });
/** Agent-to-hub draft API requests. The hub derives the owner from sessionId and must never trust an owner field. */
export const mcpDraftRequestPayload = z.discriminatedUnion('op', [
  z.object({ requestId: id, sessionId: id, op: z.literal('add'), payload: mcpDraftCreateSchema }),
  z.object({ requestId: id, sessionId: id, op: z.literal('list'), payload: z.object({ includeDrafts: z.boolean().default(true) }) }),
  z.object({
    requestId: id,
    sessionId: id,
    op: z.literal('update'),
    payload: z.union([z.object({ draftId: id, update: mcpDraftUpdateSchema }), z.object({ serverId: id, update: mcpDraftUpdateSchema })]),
  }),
]);
export const mcpDraftValidationResultSchema = z.object({
  ok: z.boolean(),
  status: z.enum(['checked', 'validation-failed', 'needs-secret', 'needs_auth', 'timeout']),
  tools: z.array(z.object({ name, description: z.string().max(200).optional() })).max(100),
  truncated: z.boolean().optional(),
  error: safeText.optional(),
  oauthRequired: z.boolean(),
});
export const mcpDraftResultSchema = z
  .object({
    servers: z.array(mcpServerConfigSchema).max(1000).optional(),
    drafts: z.array(mcpRegistryDraftSchema).max(1000).optional(),
    draft: mcpRegistryDraftSchema.optional(),
    draftId: id.optional(),
    revision: z.number().int().nonnegative().optional(),
    validation: mcpDraftValidationResultSchema.optional(),
    confirmationUrl: z.string().max(2048).optional(),
    message: safeText.optional(),
  })
  .superRefine((result, ctx) => {
    if (!result.servers && !result.drafts && !result.draft && !result.draftId && !result.message) {
      ctx.addIssue({ code: 'custom', message: 'result must contain a safe draft API result' });
    }
  });
export const mcpDraftResultPayload = z
  .object({
    requestId: id,
    ok: z.boolean(),
    result: mcpDraftResultSchema.optional(),
    error: z
      .object({
        code: z.enum(['name_taken', 'forbidden', 'validation_failed', 'timeout', 'needs_secret', 'not_found', 'revision_conflict', 'invalid_input', 'unavailable']),
        message: safeText,
      })
      .optional(),
  })
  .superRefine((payload, ctx) => {
    if (payload.ok ? !payload.result || !!payload.error : !payload.error || !!payload.result) ctx.addIssue({ code: 'custom', message: 'ok must match exactly one of result or error' });
  });
export type McpDraftRequest = z.infer<typeof mcpDraftRequestPayload>;
export type McpDraftResult = z.infer<typeof mcpDraftResultPayload>;
export const mcpOAuthStateSchema = z.enum(['not-required', 'needs-login', 'pending', 'signed-in', 'refresh-error', 'expired', 'failed']);
export const mcpOAuthStartSchema = z.object({
  flowId: id,
  serverId: id,
  machineId,
  redirectUri: z.url().max(2048),
  serverUrl: z.url().max(4096),
  transport: z.enum(['http', 'sse']),
  /** Pre-registered client (Claude plugins): the server is not in the machine's registry until the first sign-in. */
  oauthClientId: z.string().min(1).max(256).optional(),
});
export const mcpOAuthStartResultSchema = z.object({ flowId: id, authorizationUrl: z.url().max(8192), state: z.string().min(16).max(512), expiresAt: z.number().int().nonnegative() });
export const mcpOAuthCallbackSchema = z.object({ flowId: id, callbackUrl: z.string().min(1).max(8192) });
export const mcpOAuthRevokeSchema = z.object({ serverId: id, machineId });
export const mcpOAuthStatusUpdateSchema = z.object({
  serverId: id,
  machineId,
  state: z.enum(['signed-in', 'refresh-error']),
  expiresAt: z.number().int().nonnegative().optional(),
  error: safeText.optional(),
});
export const mcpOAuthCredentialSchema = z.object({
  serverId: id,
  machineId,
  flowId: id.optional(),
  accessToken: z.string().min(1).max(65536),
  refreshToken: z.string().max(65536).optional(),
  expiresAt: z.number().int().nonnegative().optional(),
  oauthClientState: z.string().min(1).max(65536).optional(),
});
/**
 * Redirect of servers with a pre-registered OAuth client: such clients (Claude plugins, corporate Keycloak) accept only loopback
 * addresses. Nothing listens there; the browser shows an error page and the user pastes its address into the hub.
 */
export const OAUTH_LOOPBACK_REDIRECT_URI = 'http://localhost:45129/callback';
export const mcpRegistryOAuthStartRequestSchema = z.object({ machineId });
export const mcpRegistryOAuthStartResponseSchema = z.object({
  serverId: id,
  machineId,
  state: z.literal('pending'),
  authorizationUrl: z.url().max(8192),
  expiresAt: z.number().int().nonnegative(),
  /** `hub` — the provider returns to the hub by itself; `manual` — the user pastes the loopback address it landed on. */
  callback: z.enum(['hub', 'manual']).optional(),
});
export const mcpRegistryOAuthCompleteRequestSchema = z.object({ machineId, callbackUrl: z.string().min(1).max(8192) });
export const mcpRegistryOAuthCompleteResponseSchema = z.object({ serverId: id, machineId, state: z.literal('pending') });
export const mcpRegistryOAuthRevokeRequestSchema = z.object({ machineId });
export const mcpRegistryOAuthRevokeResponseSchema = z.object({ serverId: id, machineId, state: z.literal('needs-login') });
export const mcpRegistryOAuthValidateRequestSchema = z.object({ machineId });
export const mcpRegistryOAuthValidateResponseSchema = z.object({ serverId: id, machineId, state: z.enum(['checked', 'needs_auth', 'validation-failed']) });
export const mcpRegistryOAuthConnectRequestSchema = z.object({ machineId });
export const mcpRegistryOAuthConnectResponseSchema = z.object({ serverId: id, machineId, state: z.literal('connected') });
export const mcpRegistryOAuthStatusSchema = z.object({
  serverId: id,
  machineId,
  state: mcpOAuthStateSchema,
  validationState: z.enum(['unchecked', 'checked', 'needs_auth', 'validation-failed']).optional(),
  connected: z.boolean().optional(),
  expiresAt: z.number().int().nonnegative().optional(),
  error: safeText.optional(),
});
export const mcpRegistryStatusSchema = z.object({
  revision: z.number().int().nonnegative(),
  oauth: z.array(mcpRegistryOAuthStatusSchema).optional(),
  agents: z.array(mcpRegistryAgentStatusSchema),
  gateways: z.array(mcpGatewayStatusSchema),
  sessionUpdates: z
    .array(
      z.object({
        serverId: id,
        sessionId: id,
        revision: z.number().int().nonnegative(),
        activation: z.enum(['connected-live', 'available-next-thread', 'deferred']),
        applied: z.boolean(),
        error: z.string().max(500).nullable(),
        updatedAt: z.number().int().nonnegative(),
      }),
    )
    .optional(),
});
export const mcpRegistryMachineOverrideRequestSchema = z
  .object({ revision: z.number().int().nonnegative(), enabled: z.boolean().optional(), resetConfig: z.literal(true).optional() })
  .refine(body => body.enabled !== undefined || body.resetConfig, { message: 'enabled or resetConfig required' });
export const mcpRegistryServerMachineSchema = z.object({ machineId, enabled: z.boolean(), customConfig: z.boolean() });
export const mcpRegistryMachineOverrideResponseSchema = z.object({ serverId: id, revision: z.number().int().nonnegative(), machines: z.array(mcpRegistryServerMachineSchema).max(100) });
export type McpRegistryOAuthStatus = z.infer<typeof mcpRegistryOAuthStatusSchema>;
export type McpRegistryStatus = z.infer<typeof mcpRegistryStatusSchema>;
export type McpRegistryMachineOverrideRequest = z.infer<typeof mcpRegistryMachineOverrideRequestSchema>;
export type McpRegistryMachineOverrideResponse = z.infer<typeof mcpRegistryMachineOverrideResponseSchema>;
export type McpRegistryServerMachine = z.infer<typeof mcpRegistryServerMachineSchema>;
export type McpImportState = z.infer<typeof mcpImportStateSchema>;
export type McpRegistryOAuthStartRequest = z.infer<typeof mcpRegistryOAuthStartRequestSchema>;
export type McpRegistryOAuthStartResponse = z.infer<typeof mcpRegistryOAuthStartResponseSchema>;
export type McpRegistryOAuthCompleteRequest = z.infer<typeof mcpRegistryOAuthCompleteRequestSchema>;
export type McpRegistryOAuthCompleteResponse = z.infer<typeof mcpRegistryOAuthCompleteResponseSchema>;
export type McpRegistryOAuthRevokeRequest = z.infer<typeof mcpRegistryOAuthRevokeRequestSchema>;
export type McpRegistryOAuthRevokeResponse = z.infer<typeof mcpRegistryOAuthRevokeResponseSchema>;
export type McpRegistryOAuthValidateRequest = z.infer<typeof mcpRegistryOAuthValidateRequestSchema>;
export type McpRegistryOAuthValidateResponse = z.infer<typeof mcpRegistryOAuthValidateResponseSchema>;
export type McpRegistryOAuthConnectRequest = z.infer<typeof mcpRegistryOAuthConnectRequestSchema>;
export type McpRegistryOAuthConnectResponse = z.infer<typeof mcpRegistryOAuthConnectResponseSchema>;

export const mcpRegistryAckPayload = z.object({ revision: z.number().int().nonnegative(), applied: z.boolean(), error: safeText.optional() });
export const mcpRegistrySyncPayload = mcpRegistrySnapshotSchema;
export const mcpRegistryValidatePayload = z.object({
  draftId: id,
  revision: z.number().int().nonnegative(),
  machineId,
  /** Persistent identity used only to look up OAuth credentials during isolated draft validation. */
  oauthServerId: id.optional(),
  server: mcpServerConfigSchema,
  secretDelivery: mcpSecretDeliverySchema.optional(),
});
export const mcpRegistryValidateResultPayload = z.object({
  draftId: id,
  revision: z.number().int().nonnegative(),
  ok: z.boolean(),
  status: z.enum(['checked', 'validation-failed', 'needs-secret', 'needs_auth']),
  error: safeText.optional(),
  tools: z.array(z.object({ name, description: z.string().max(2000).optional() })).max(1000),
  oauthRequired: z.boolean(),
  authorizationUrl: z.url().optional(),
});
export const mcpRegistrySessionUpdatePayload = z.object({
  sessionId: id,
  revision: z.number().int().nonnegative(),
  server: mcpServerConfigSchema,
  activation: z.enum(['connected-live', 'available-next-thread', 'deferred']),
});
export const mcpRegistrySessionUpdateAckPayload = z.object({
  sessionId: id,
  revision: z.number().int().nonnegative(),
  activation: z.enum(['connected-live', 'available-next-thread', 'deferred']),
  applied: z.boolean(),
  error: safeText.optional(),
});
export const mcpGatewayStatusPayload = mcpGatewayStatusSchema;
export const mcpGatewayStartPayload = mcpGatewayStartSchema;
export const mcpGatewayStopPayload = mcpGatewayStopSchema;
export const mcpSecretDeliveryPayload = mcpSecretDeliverySchema;
export const mcpOAuthStartPayload = mcpOAuthStartSchema;
export const mcpOAuthStartResultPayload = mcpOAuthStartResultSchema;
export const mcpOAuthCallbackPayload = mcpOAuthCallbackSchema;
export const mcpOAuthRevokePayload = mcpOAuthRevokeSchema;
export const mcpOAuthStatusUpdatePayload = mcpOAuthStatusUpdateSchema;
export const mcpOAuthCredentialPayload = mcpOAuthCredentialSchema;
export const mcpOAuthTokenUpdatePayload = mcpOAuthCredentialSchema;
export const mcpImportProjectRootSchema = z.object({ projectId: id, path: z.string().min(1).max(4096) });
/** `projectRoot` is what agents before import v2 read; `projectRoots` are the machine's project bindings (D4). */
export const mcpImportPreviewPayload = z.object({
  machineId,
  projectRoot: z.string().min(1).max(4096),
  projectRoots: z.array(mcpImportProjectRootSchema).max(1000).optional(),
});
export const mcpImportCommitPayload = z.object({ importId: id, revision: z.number().int().nonnegative(), serverIds: z.array(id).min(1).max(1000), userConfirmed: z.literal(true) });
/** Sensitive one-time agent-to-hub import payload. Hub encrypts these values on receipt and never returns them. */
export const mcpImportSecretValueSchema = z.object({
  serverName: name,
  entryId: id.optional(),
  location: z.enum(['env', 'header', 'url']),
  key: z.string().min(1).max(256),
  value: z.string().min(1).max(65536),
});
export const mcpImportSourceSchema = z.enum(['user', 'local', 'project', 'codex', 'plugin']);
export const mcpImportDecisionSchema = z.enum(['new', 'add-machine', 'machine-config', 'unchanged', 'conflict']);
export const mcpImportWarningSchema = z.enum(['unbound-path', 'duplicate-skipped', 'disabled-in-source', 'project-conflict']);
export const mcpImportPreviewResultPayload = z.object({
  importId: id,
  servers: z
    .array(
      z.object({
        ...mcpServerConfigSchema.shape,
        source: mcpImportSourceSchema,
        origin: z.string().max(4096).optional(),
        projectId: id.optional(),
        warnings: z.array(mcpImportWarningSchema).max(10).optional(),
      }),
    )
    .max(1000),
  secretsCaptured: z.number().int().nonnegative(),
  warnings: z.array(safeText).max(100),
  secretValues: z.array(mcpImportSecretValueSchema).max(1000).default([]),
});
/** One preview entry as the hub shows it: secrets masked, decision computed by the hub (D5). */
export const mcpImportEntrySchema = z.object({
  id,
  name,
  transport: mcpTransportSchema,
  command: z.string().max(2048).optional(),
  url: z.string().max(4096).optional(),
  source: mcpImportSourceSchema,
  origin: z.string().max(4096).optional(),
  projectId: id.optional(),
  decision: mcpImportDecisionSchema,
  selected: z.boolean(),
  selectable: z.boolean(),
  warnings: z.array(mcpImportWarningSchema).max(10),
  secrets: z.array(z.object({ name: z.string().max(256), masked: z.literal(true) })).max(256),
});
export const mcpImportNoticeSchema = z.enum(['claude-ai-connectors']);
export const mcpImportPreviewResponseSchema = z.object({
  importId: id,
  machineId,
  revision: z.number().int().nonnegative(),
  servers: z.array(mcpImportEntrySchema).max(1000),
  secretsCaptured: z.number().int().nonnegative(),
  warnings: z.array(safeText).max(100),
  notices: z.array(mcpImportNoticeSchema).max(10),
});
export const mcpImportPreviewRequestSchema = z.object({ machineId, projectRoot: z.string().min(1).max(4096).optional() });
export const mcpImportCommitResponseSchema = z.object({
  imported: z.number().int().nonnegative(),
  servers: z.array(z.object({ serverId: id, name, decision: mcpImportDecisionSchema })).max(1000),
});
export type McpImportEntry = z.infer<typeof mcpImportEntrySchema>;
export type McpImportPreviewResponse = z.infer<typeof mcpImportPreviewResponseSchema>;
export type McpImportCommitResponse = z.infer<typeof mcpImportCommitResponseSchema>;
export type McpImportDecision = z.infer<typeof mcpImportDecisionSchema>;
export type McpImportSource = z.infer<typeof mcpImportSourceSchema>;
export type McpImportWarning = z.infer<typeof mcpImportWarningSchema>;
