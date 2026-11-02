// Requirement: Статус MCP сессии; Переподключение MCP-сервера; Вход в удалённый MCP с любого устройства; MCP машины
// (mcp-management M8, task 1.2).
import { describe, expect, it } from 'vitest';
import {
  MCP_API_ERRORS,
  MCP_PENDING_ACTIONS,
  MCP_TEXTS,
  MCP_VIEW_REASONS,
  mcpActionRequestSchema,
  mcpAuthCallbackRequestSchema,
  mcpAuthRequestSchema,
  mcpLogoutRequestSchema,
  isAuthErrorText,
  type McpMachineView,
  type McpSessionView,
  type SessionView,
  type UiServerMessage,
} from './index.js';

const SID = '6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7';

const view: McpSessionView = {
  available: true,
  live: true,
  observedAt: '2026-10-28T12:00:00.000Z',
  waking: false,
  authControls: true,
  servers: [
    {
      name: 'vaultwarden',
      status: 'connected',
      transport: 'stdio',
      target: 'node vw.js',
      scope: 'user',
      serverInfo: { name: 'vw', version: '1.0.0' },
      toolCount: 12,
      persistence: 'project',
      canAuth: false,
      oauth: false,
      authError: false,
    },
    {
      name: 'notion',
      status: 'needs-auth',
      transport: 'http',
      target: 'https://mcp.notion.com/mcp',
      scope: 'project',
      toolCount: 0,
      persistence: 'project',
      canAuth: true,
      oauth: true,
      authError: false,
      pendingAction: 'auth',
    },
    { name: 'scanner-fleet', status: 'failed', error: 'ECONNREFUSED', transport: 'http', toolCount: 0, persistence: 'process', canAuth: true, oauth: false, authError: false, lastError: 'boom' },
  ],
  authFlows: [{ server: 'notion', authUrl: 'https://mcp.notion.com/authorize?x=1', redirect: 'hub', expiresAt: '2026-10-28T12:10:00.000Z' }],
};

describe('MCP request bodies', () => {
  it('actions: reconnect, enable, disable; a server name is required', () => {
    for (const action of ['reconnect', 'enable', 'disable']) expect(mcpActionRequestSchema.safeParse({ server: 'x', action }).success, action).toBe(true);
    expect(mcpActionRequestSchema.safeParse({ server: 'x', action: 'auth' }).success).toBe(false);
    expect(mcpActionRequestSchema.safeParse({ server: '', action: 'reconnect' }).success).toBe(false);
    expect(mcpActionRequestSchema.safeParse({ server: 'x'.repeat(201), action: 'reconnect' }).success).toBe(false);
  });

  it('auth and the pasted callback', () => {
    expect(mcpAuthRequestSchema.safeParse({ server: 'notion' }).success).toBe(true);
    expect(mcpAuthRequestSchema.safeParse({}).success).toBe(false);
    expect(mcpAuthCallbackRequestSchema.safeParse({ server: 'notion', callbackUrl: 'http://localhost:53412/callback?code=a&state=b' }).success).toBe(true);
    expect(mcpAuthCallbackRequestSchema.safeParse({ server: 'notion', callbackUrl: '' }).success).toBe(false);
    expect(mcpAuthCallbackRequestSchema.safeParse({ server: 'notion', callbackUrl: 'x'.repeat(8193) }).success).toBe(false);
  });
});

describe('MCP views and WS events', () => {
  it('the session view and the WS events type-check and serialize as plain JSON', () => {
    const machine: McpMachineView = {
      available: true,
      observedAt: view.observedAt,
      source: 'session',
      servers: [view.servers[0]!],
      probeAt: null,
      probeAvailableAt: null,
      probing: false,
      probeError: null,
      online: true,
      authControls: true,
    };
    const msgs: UiServerMessage[] = [
      { type: 'session.mcp', sessionId: SID, mcp: view },
      { type: 'mcp.auth', sessionId: SID, server: 'notion', flow: view.authFlows[0]! },
      { type: 'mcp.auth', sessionId: SID, server: 'notion', flow: null, result: 'process_exited', error: MCP_TEXTS.processExited },
      { type: 'runner.mcp', runnerId: 'x1', mcp: machine },
    ];
    for (const m of msgs) expect(JSON.parse(JSON.stringify(m))).toEqual(m);
    const s: Pick<SessionView, 'mcpProblems'> = { mcpProblems: 2 };
    expect(s.mcpProblems).toBe(2);
  });

  it('constants: pending actions, reasons, error codes, spec texts', () => {
    expect(MCP_PENDING_ACTIONS).toEqual(['reconnect', 'enable', 'disable', 'auth', 'wake', 'logout']);
    expect(MCP_VIEW_REASONS).toEqual(['agent_outdated', 'not_hub_managed', 'no_snapshot']);
    expect(MCP_API_ERRORS).toContain('probe_too_soon');
    expect(MCP_API_ERRORS).toContain('bad_callback_url');
    expect(MCP_TEXTS.agentOutdated).toBe('Управление MCP требует обновления агента');
    expect(MCP_TEXTS.stateMismatch).toBe('Адрес не от этой попытки входа или без кода — вставьте адрес со страницы этой попытки');
  });
});

describe('mcp-auth-controls: sign-out body and the auth-error heuristic (A2)', () => {
  it('logout needs a server name', () => {
    expect(mcpLogoutRequestSchema.safeParse({ server: 'notion' }).success).toBe(true);
    expect(mcpLogoutRequestSchema.safeParse({}).success).toBe(false);
    expect(mcpLogoutRequestSchema.safeParse({ server: '' }).success).toBe(false);
  });

  it.each([
    'HTTP 401',
    'HTTP 401: Unauthorized',
    'Unauthorized',
    'unauthorised',
    'invalid_token',
    'Invalid token: expired',
    'invalid_grant',
    'Token expired',
    'token revoked by the provider',
    'Authentication cleared',
    'Authentication required',
    'authentication failed',
  ])('%s reads as a refused authorisation', t => {
    expect(isAuthErrorText(t)).toBe(true);
  });

  it.each([
    'HTTP 403',
    'Forbidden',
    'SSE error: Non-200 status code (403)',
    'connect ECONNREFUSED 127.0.0.1:8770',
    'port 4013 is busy',
    'port 4011 is busy',
    'listen on 14010',
    'timeout',
    'MCP error -32000: Connection closed',
    '',
    undefined,
    null,
  ])('%s does not', t => {
    expect(isAuthErrorText(t)).toBe(false);
  });

  it('spec texts of sign-out', () => {
    expect(MCP_TEXTS.logoutUnsupported).toBe('Выход из хаба не поддерживается этой версией Claude Code на машине — выполните claude mcp logout <сервер> в терминале');
    expect(MCP_TEXTS.resigninHint).toBe('Прежний вход сброшен — завершите вход, иначе сервер останется без входа');
  });
});
