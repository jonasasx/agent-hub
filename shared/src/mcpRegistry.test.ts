import { describe, expect, it } from 'vitest';
import {
  MCP_REGISTRY_CAPABILITIES,
  MCP_REGISTRY_PROTOCOL,
  mcpDraftConnectSchema,
  mcpDraftCreateSchema,
  mcpDraftValidateSchema,
  mcpDraftUpdateSchema,
  mcpDraftRequestPayload,
  mcpDraftResultPayload,
  mcpCapabilitiesSchema,
  mcpGatewayStatusSchema,
  mcpMachineScopeSchema,
  mcpMachineScopeInputSchema,
  mcpRegistryDraftSchema,
  mcpRegistrySnapshotSchema,
  mcpSecretDeliverySchema,
  mcpSecretMetadataSchema,
  mcpImportPreviewResultPayload,
  mcpImportCommitPayload,
  mcpImportPreviewPayload,
  mcpOAuthStartResultSchema,
  mcpOAuthStartSchema,
  mcpRegistryOAuthStartResponseSchema,
  mcpRegistryOAuthStatusSchema,
  mcpRegistryOAuthValidateResponseSchema,
  mcpRegistryOAuthConnectResponseSchema,
  mcpRegistryMachineToggleRequestSchema,
  mcpRegistryMachineToggleResponseSchema,
  mcpRegistryStatusSchema,
  mcpRegistryValidateResultPayload,
  parseAgentMessage,
  parseHubMessage,
} from './index.js';
import protocol112Hello from './fixtures/protocol-1.12-hello.json';

const machineId = '00000000-0000-4000-8000-000000000001';
const runnerId = 'vm';
const serverId = '00000000-0000-4000-8000-000000000002';

describe('MCP registry protocol 1.13 contracts', () => {
  it('accepts name-bound secret inputs and defaults registry consumption off', () => {
    const input = {
      server: {
        id: serverId,
        name: 'wizard_server',
        enabled: true,
        transport: 'http',
        mode: 'remote',
        url: 'https://mcp.example.test/mcp?api_key=__AGENT_HUB_SECRET__',
        urlSecretName: 'url:api_key',
        env: { API_KEY: { kind: 'secret-name', name: 'API_KEY' } },
        machineScope: { allMachines: true, machineIds: [] },
        projectIds: [],
      },
      secrets: [
        { name: 'API_KEY', value: 'wizard-secret' },
        { name: 'url:api_key', value: 'url-secret' },
      ],
    };
    expect(mcpDraftCreateSchema.parse(input).server.env?.API_KEY).toEqual({ kind: 'secret-name', name: 'API_KEY' });
    expect(mcpDraftUpdateSchema.parse({ revision: 1, server: { env: input.server.env }, secrets: input.secrets }).server.env?.API_KEY).toEqual({
      kind: 'secret-name',
      name: 'API_KEY',
    });
    expect(mcpRegistrySnapshotSchema.parse({ protocol: MCP_REGISTRY_PROTOCOL, revision: 0, generatedAt: 1, servers: [] }).registryEnabled).toBe(false);
    expect(mcpRegistryMachineToggleRequestSchema.parse({ enabled: true }).enabled).toBe(true);
    expect(mcpRegistryMachineToggleResponseSchema.parse({ machineId, registryEnabled: true })).toMatchObject({ registryEnabled: true });
    expect(
      mcpRegistryStatusSchema.parse({ revision: 0, agents: [{ machineId: 'machine', machineName: 'Machine', online: false, protocolVersion: '1.13', capabilities: [] }], gateways: [] }).agents[0]
        ?.registryEnabled,
    ).toBe(false);
  });

  it('validates the OAuth start and status contract without exposing callback state', () => {
    expect(
      mcpOAuthStartSchema.parse({
        flowId: serverId,
        serverId,
        machineId,
        redirectUri: 'https://agents.example.test/mcp/oauth/callback',
        serverUrl: 'https://mcp.example.test/rpc',
        transport: 'http',
      }),
    ).toMatchObject({ serverUrl: 'https://mcp.example.test/rpc', transport: 'http' });
    const start = mcpOAuthStartResultSchema.parse({
      flowId: serverId,
      authorizationUrl: 'https://idp.example.test/authorize?state=opaque-state-not-for-ui',
      state: 'opaque-state-not-for-ui',
      expiresAt: 1793120000000,
    });
    expect(start.state).toBe('opaque-state-not-for-ui');
    expect(
      mcpRegistryOAuthStartResponseSchema.parse({
        serverId,
        machineId,
        state: 'pending',
        authorizationUrl: 'https://idp.example.test/authorize?state=opaque-state-not-for-ui',
        expiresAt: 1793120000000,
      }),
    ).not.toHaveProperty('stateValue');
    expect(mcpRegistryOAuthStatusSchema.parse({ serverId, machineId, state: 'refresh-error', validationState: 'needs_auth', connected: false, error: 'Token refresh failed' })).toMatchObject({
      state: 'refresh-error',
      validationState: 'needs_auth',
      connected: false,
      error: 'Token refresh failed',
    });
    expect(mcpRegistryOAuthValidateResponseSchema.parse({ serverId, machineId, state: 'needs_auth' }).state).toBe('needs_auth');
    expect(mcpRegistryOAuthConnectResponseSchema.parse({ serverId, machineId, state: 'connected' }).state).toBe('connected');
    expect(mcpRegistryValidateResultPayload.parse({ draftId: serverId, revision: 1, ok: false, status: 'needs_auth', tools: [], oauthRequired: true }).status).toBe('needs_auth');
  });

  it('accepts non-GUID runner ids throughout MCP machine-scoped contracts', () => {
    expect(mcpMachineScopeSchema.parse({ allMachines: false, machineIds: [runnerId] }).machineIds).toEqual([runnerId]);
    expect(mcpDraftValidateSchema.parse({ machineId: runnerId, revision: 1 }).machineId).toBe(runnerId);
    expect(mcpImportPreviewPayload.parse({ machineId: runnerId, projectRoot: 'C:/work' }).machineId).toBe(runnerId);
    expect(
      mcpOAuthStartSchema.parse({
        flowId: serverId,
        serverId,
        machineId: runnerId,
        redirectUri: 'https://agents.example.test/mcp/oauth/callback',
        serverUrl: 'https://mcp.example.test/mcp',
        transport: 'http',
      }).machineId,
    ).toBe(runnerId);
    expect(mcpGatewayStatusSchema.parse({ serverId, machineId: runnerId, status: 'ready', endpoint: 'http://127.0.0.1:9000/mcp', observedAt: 1 }).machineId).toBe(runnerId);
    expect(mcpSecretDeliverySchema.parse({ serverId, machineId: runnerId, revision: 1, secrets: [] }).machineId).toBe(runnerId);
    expect(mcpMachineScopeSchema.safeParse({ allMachines: false, machineIds: [] }).success).toBe(true);
    expect(mcpMachineScopeInputSchema.safeParse({ allMachines: false, machineIds: [] }).success).toBe(false);
    expect(mcpMachineScopeSchema.safeParse({ allMachines: true, machineIds: [] }).success).toBe(true);
    expect(mcpDraftUpdateSchema.safeParse({ revision: 1, server: { machineScope: { allMachines: false, machineIds: [] } } }).success).toBe(false);
    expect(mcpDraftValidateSchema.safeParse({ machineId: 'v'.repeat(129), revision: 1 }).success).toBe(false);
  });

  it('exposes a stable capability set and validates a registry snapshot', () => {
    expect(mcpCapabilitiesSchema.parse({ protocol: MCP_REGISTRY_PROTOCOL, capabilities: [...MCP_REGISTRY_CAPABILITIES] }).protocol).toBe('1.13');
    expect(
      mcpRegistrySnapshotSchema.parse({
        protocol: '1.13',
        revision: 3,
        generatedAt: 100,
        servers: [
          {
            id: serverId,
            name: 'remote',
            enabled: true,
            transport: 'http',
            mode: 'remote',
            url: 'https://mcp.example.test/mcp',
            machineScope: { allMachines: true, machineIds: [] },
            projectIds: [],
            revision: 3,
          },
        ],
      }).servers,
    ).toHaveLength(1);
    expect(mcpRegistrySnapshotSchema.safeParse({ protocol: '1.12', revision: 0, generatedAt: 0, servers: [] }).success).toBe(false);
    expect(
      mcpRegistrySnapshotSchema.safeParse({
        protocol: '1.13',
        revision: 3,
        generatedAt: 100,
        servers: [
          {
            id: serverId,
            name: 'secret-config',
            enabled: true,
            transport: 'stdio',
            mode: 'machine-shared',
            command: 'server',
            env: { API_KEY: 'plaintext-must-not-appear' },
            machineScope: { allMachines: true, machineIds: [] },
            revision: 3,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      mcpRegistrySnapshotSchema.safeParse({
        protocol: '1.13',
        revision: 3,
        generatedAt: 100,
        servers: [
          {
            id: serverId,
            name: 'secret-config',
            enabled: true,
            transport: 'stdio',
            mode: 'machine-shared',
            command: 'server',
            env: { API_KEY: { kind: 'literal', value: 'plaintext-must-not-appear' } },
            machineScope: { allMachines: true, machineIds: [] },
            revision: 3,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('accepts legacy empty machine scopes in stored configs and snapshots', () => {
    const legacyServer = {
      id: serverId,
      name: 'legacy_empty_scope',
      enabled: true,
      transport: 'stdio',
      mode: 'per-session',
      command: 'node',
      machineScope: { allMachines: false, machineIds: [] },
      projectIds: [],
      revision: 1,
    };
    expect(mcpRegistrySnapshotSchema.parse({ protocol: '1.13', revision: 1, generatedAt: 1, servers: [legacyServer] }).servers).toHaveLength(1);
    expect(mcpDraftCreateSchema.safeParse({ server: legacyServer }).success).toBe(false);
  });

  it('accepts explicit disabled project overrides and rejects enabled override entries', () => {
    const snapshot = {
      protocol: '1.13',
      revision: 3,
      generatedAt: 100,
      servers: [],
      projectOverrides: [{ projectId: machineId, serverId, enabled: false }],
    };
    expect(mcpRegistrySnapshotSchema.parse(snapshot).projectOverrides).toEqual(snapshot.projectOverrides);
    expect(mcpRegistrySnapshotSchema.safeParse({ ...snapshot, projectOverrides: [{ projectId: machineId, serverId, enabled: true }] }).success).toBe(false);
  });

  it('validates gateway, secret metadata and one-time target-machine delivery', () => {
    expect(mcpGatewayStatusSchema.parse({ serverId, machineId, status: 'needs-secret', observedAt: 12 }).status).toBe('needs-secret');
    expect(mcpSecretMetadataSchema.parse({ id: serverId, name: 'API key', state: 'set', masked: true })).not.toHaveProperty('value');
    expect(mcpSecretDeliverySchema.parse({ serverId, machineId, revision: 4, secrets: [{ name: 'API_KEY', value: 'secret-for-test' }] }).machineId).toBe(machineId);
    expect(mcpSecretDeliverySchema.safeParse({ serverId, machineId: '', revision: 4, secrets: [] }).success).toBe(false);
    expect(mcpDraftConnectSchema.safeParse({ revision: 1, userConfirmed: true }).success).toBe(true);
    expect(mcpDraftConnectSchema.safeParse({ revision: 1, userConfirmed: false }).success).toBe(false);
    expect(
      mcpDraftCreateSchema.safeParse({
        server: { id: serverId, name: 'draft', enabled: true, transport: 'stdio', mode: 'per-session', command: 'node', machineScope: { allMachines: true, machineIds: [] }, projectIds: [] },
        secrets: [{ name: 'TOKEN', value: 'test-only' }],
      }).success,
    ).toBe(true);
    expect(
      mcpRegistryDraftSchema.safeParse({
        draftId: serverId,
        revision: 1,
        state: 'needs-secret',
        server: {
          id: serverId,
          name: 'draft',
          enabled: true,
          transport: 'stdio',
          mode: 'per-session',
          command: 'node',
          machineScope: { allMachines: true, machineIds: [] },
          projectIds: [],
          revision: 1,
        },
      }).success,
    ).toBe(true);
  });

  it('parses 1.13 commands and rejects malformed secret-bearing commands', () => {
    expect(parseHubMessage(JSON.stringify({ v: 1, type: 'mcp.gateway.start', id: 'cmd-1', ts: 100, payload: { serverId, revision: 1, bearerToken: 'x'.repeat(32) } })).ok).toBe(true);
    expect(
      parseHubMessage(
        JSON.stringify({ v: 1, type: 'mcp.secrets.deliver', id: 'cmd-2', ts: 100, payload: { serverId, machineId, revision: 1, secrets: [{ name: 'TOKEN', value: 'secret-for-test' }] } }),
      ).ok,
    ).toBe(true);
    expect(
      parseHubMessage(JSON.stringify({ v: 1, type: 'mcp.secrets.deliver', id: 'cmd-3', ts: 100, payload: { serverId, machineId, revision: 1, secrets: [{ name: 'TOKEN', value: '' }] } })).ok,
    ).toBe(false);
    expect(parseAgentMessage(JSON.stringify({ v: 1, type: 'mcp.registry.ack', ts: 100, payload: { revision: 1, applied: true } })).ok).toBe(true);
  });

  it('defines owner-scoped draft messages with safe results and one-time import secret values', () => {
    const requestId = '00000000-0000-4000-8000-000000000003';
    expect(mcpDraftRequestPayload.parse({ requestId, sessionId: machineId, op: 'list', payload: {} })).toMatchObject({ op: 'list', sessionId: machineId });
    const noCallerIdentity = mcpDraftRequestPayload.parse({ requestId, sessionId: machineId, userId: machineId, op: 'list', payload: {} });
    expect(noCallerIdentity).not.toHaveProperty('userId'); // the hub derives ownership from sessionId
    expect(mcpDraftResultPayload.safeParse({ requestId, ok: false, error: { code: 'forbidden', message: 'not allowed' } }).success).toBe(true);
    const safeResult = mcpDraftResultPayload.parse({ requestId, ok: true, result: { message: 'added', secretValues: [{ value: 'must-not-return' }] } }); // unknown result field is stripped
    expect(JSON.stringify(safeResult)).not.toContain('must-not-return');
    const imported = mcpImportPreviewResultPayload.parse({
      importId: requestId,
      servers: [
        {
          id: serverId,
          name: 'imported',
          enabled: true,
          transport: 'stdio',
          mode: 'machine-shared',
          command: 'node',
          machineScope: { allMachines: true, machineIds: [] },
          projectIds: [],
          revision: 0,
          source: 'project',
        },
      ],
      secretsCaptured: 1,
      warnings: [],
      secretValues: [{ serverName: 'local', location: 'env', key: 'API_KEY', value: 'one-time-only' }],
    });
    expect(imported.secretValues[0]).toMatchObject({ key: 'API_KEY', value: 'one-time-only' });
    expect(imported.secretValues[0]?.value).not.toBeUndefined();
    expect(imported.servers[0]?.source).toBe('project');
    expect(mcpImportCommitPayload.safeParse({ importId: requestId, revision: 2, serverIds: [serverId], userConfirmed: true }).success).toBe(true);
    expect(mcpImportCommitPayload.safeParse({ importId: requestId, revision: 2, userConfirmed: true }).success).toBe(false);
  });

  it('continues to accept the protocol 1.12 hello fixture without registry capabilities', () => {
    const result = parseAgentMessage(JSON.stringify(protocol112Hello));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.payload).toMatchObject({ protocol: '1.12' });
      expect(result.message.payload).not.toHaveProperty('capabilities');
    }
  });
});
