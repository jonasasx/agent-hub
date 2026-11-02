// Test data of the MCP UI (change mcp-management): views as the hub sends them (design M8).
import type { McpAuthFlowView, McpServerView, McpSessionView } from '../../api/types';

export const mcpServer = (over: Partial<McpServerView> = {}): McpServerView => ({
  name: 'vaultwarden',
  status: 'connected',
  transport: 'stdio',
  target: 'node C:/Users/alice/mcp/secrets/index.js --token •••',
  scope: 'user',
  serverInfo: { name: 'vaultwarden-mcp', version: '1.4.0' },
  toolCount: 12,
  persistence: 'project',
  canAuth: false,
  oauth: false,
  authError: false,
  ...over,
});

/** One server of every status (the panel scenarios of the spec). */
export const ALL_STATUSES: McpServerView[] = [
  mcpServer(),
  mcpServer({ name: 'scanner-fleet', status: 'failed', error: 'MCP error -32000: Connection closed: ECONNREFUSED 127.0.0.1:8770', serverInfo: undefined, toolCount: 0, scope: 'project' }),
  mcpServer({ name: 'notion', status: 'needs-auth', transport: 'http', target: 'https://mcp.notion.com/mcp', serverInfo: undefined, toolCount: 0, canAuth: true }),
  mcpServer({ name: 'krisp', status: 'pending', transport: 'http', target: 'https://mcp.krisp.ai/mcp', serverInfo: undefined, toolCount: 0, canAuth: true }),
  mcpServer({ name: 'playwright', status: 'disabled', target: 'npx @playwright/mcp@latest', serverInfo: undefined, toolCount: 0, scope: 'local' }),
  mcpServer({ name: 'future', status: 'unknown', transport: 'other', target: undefined, serverInfo: undefined, toolCount: 0, scope: 'managed' }),
];

export const mcpView = (over: Partial<McpSessionView> = {}): McpSessionView => ({
  available: true,
  live: true,
  observedAt: new Date(Date.now() - 60_000).toISOString(),
  servers: ALL_STATUSES,
  authFlows: [],
  waking: false,
  authControls: true,
  ...over,
});

export const authFlow = (over: Partial<McpAuthFlowView> = {}): McpAuthFlowView => ({
  server: 'notion',
  authUrl: 'https://mcp.notion.com/authorize?client_id=abc&redirect_uri=https%3A%2F%2Fhub.example.com%2Fmcp%2Foauth%2Fcallback&state=s1',
  redirect: 'hub',
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  ...over,
});
