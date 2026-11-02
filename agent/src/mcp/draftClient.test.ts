import { describe, expect, it, vi } from 'vitest';
import type { McpDraftRequest, McpDraftResult } from '@agent-hub/shared';
import { McpDraftClient } from './draftClient.js';
import { mcpDraftTools } from './tools.js';
import { runPeerTool } from '../peers/tools.js';

describe('McpDraftClient and MCP registry tools', () => {
  it('correlates draft result messages and fails pending requests on disconnect', async () => {
    let sent: { type: string; payload: unknown } | undefined;
    const client = new McpDraftClient((type, payload) => {
      sent = { type, payload };
      return true;
    }, 1000);
    const promise = client.request({ sessionId: '00000000-0000-4000-8000-000000000001', op: 'list', payload: { includeDrafts: true } });
    expect(sent?.type).toBe('mcp.draft.request');
    const request = sent!.payload as McpDraftRequest;
    const result: McpDraftResult = { requestId: request.requestId, ok: true, result: { message: 'safe' } };
    client.onResult(result);
    await expect(promise).resolves.toMatchObject({ ok: true });
    const pending = client.request({ sessionId: '00000000-0000-4000-8000-000000000001', op: 'list', payload: { includeDrafts: true } });
    client.failAll();
    await expect(pending).rejects.toThrow('hub connection lost');
  });

  it('scopes mcp_add to the caller session and redacts write-only secret values from results', async () => {
    const request = vi.fn(async (input: Parameters<McpDraftClient['request']>[0]) => {
      if (input.op !== 'add') throw new Error('expected add draft request');
      const secret = input.payload.secrets?.[0]?.value ?? '';
      return { requestId: '00000000-0000-4000-8000-000000000004', ok: true as const, result: { message: `stored ${secret}` } };
    });
    const tools = mcpDraftTools('00000000-0000-4000-8000-000000000001', 'vm', { request });
    const result = await runPeerTool(tools, 'mcp_add', {
      server: {
        id: '00000000-0000-4000-8000-000000000002',
        name: 'sample',
        enabled: true,
        transport: 'http',
        mode: 'remote',
        url: 'https://mcp.example.test/mcp?api_key=__AGENT_HUB_SECRET__',
        urlSecretName: 'TOKEN',
        headers: { Authorization: { kind: 'secret-name', name: 'TOKEN' } },
        machineScope: { allMachines: true, machineIds: [] },
        projectIds: [],
      },
      secrets: [{ name: 'TOKEN', value: 'super-secret-value' }],
    });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ sessionId: '00000000-0000-4000-8000-000000000001', op: 'add' }));
    expect(request.mock.calls[0]![0]).toMatchObject({
      op: 'add',
      payload: {
        server: {
          headers: { Authorization: { kind: 'secret-name', name: 'TOKEN' } },
          urlSecretName: 'TOKEN',
        },
        secrets: [{ name: 'TOKEN', value: 'super-secret-value' }],
      },
    });
    expect(JSON.stringify(result)).not.toContain('super-secret-value');
  });

  it('scopes mcp_list and mcp_update to the caller and redacts update secrets', async () => {
    const secret = 'update-only-secret';
    const request = vi.fn(async (input: Parameters<McpDraftClient['request']>[0]) => ({
      requestId: '00000000-0000-4000-8000-000000000005',
      ok: true as const,
      result: { message: input.op === 'update' ? `saved ${secret}` : 'listed', secretValues: input.op === 'update' ? [secret] : [{ masked: true }] },
    }));
    const sessionId = '00000000-0000-4000-8000-000000000001';
    const tools = mcpDraftTools(sessionId, 'vm', { request });
    const listed = await runPeerTool(tools, 'mcp_list', { includeDrafts: true });
    const updated = await runPeerTool(tools, 'mcp_update', {
      draftId: '00000000-0000-4000-8000-000000000006',
      update: {
        revision: 1,
        server: { name: 'sample', headers: { Authorization: { kind: 'secret-name', name: 'TOKEN' } } },
        secrets: [{ name: 'TOKEN', value: secret }],
      },
    });
    expect(request.mock.calls.map(([input]) => [input.sessionId, input.op])).toEqual([
      [sessionId, 'list'],
      [sessionId, 'update'],
    ]);
    expect(request.mock.calls[1]![0]).toMatchObject({
      op: 'update',
      payload: {
        update: { server: { headers: { Authorization: { kind: 'secret-name', name: 'TOKEN' } } } },
      },
    });
    expect(JSON.stringify(listed)).not.toContain(secret);
    expect(JSON.stringify(updated)).not.toContain(secret);
    const emptyScopeUpdate = await runPeerTool(tools, 'mcp_update', {
      draftId: '00000000-0000-4000-8000-000000000006',
      update: { revision: 2, server: { machineScope: { allMachines: false, machineIds: [] } } },
    });
    expect(emptyScopeUpdate.isError).toBe(true);
    expect(emptyScopeUpdate.content[0]?.text).toContain('include at least one machine when allMachines is false');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('defaults an omitted machine scope to the calling machine and rejects an explicitly empty scope', async () => {
    const request = vi.fn(async (_input: Parameters<McpDraftClient['request']>[0]): Promise<McpDraftResult> => ({
      requestId: '00000000-0000-4000-8000-000000000007',
      ok: true,
      result: { message: 'stored' },
    }));
    const tools = mcpDraftTools('00000000-0000-4000-8000-000000000001', 'vm', { request });
    const server = {
      id: '00000000-0000-4000-8000-000000000002',
      name: 'local_only',
      enabled: true,
      transport: 'stdio',
      mode: 'per-session',
      command: 'node',
      projectIds: [],
    };
    const added = await runPeerTool(tools, 'mcp_add', { server });
    expect(added.isError).toBeUndefined();
    expect(request.mock.calls[0]![0]).toMatchObject({
      op: 'add',
      payload: { server: { machineScope: { allMachines: false, machineIds: ['vm'] } } },
    });

    const empty = await runPeerTool(tools, 'mcp_add', {
      server: { ...server, machineScope: { allMachines: false, machineIds: [] } },
    });
    expect(empty.isError).toBe(true);
    expect(empty.content[0]?.text).toContain('include at least one machine when allMachines is false');
    expect(request).toHaveBeenCalledTimes(1);
  });
});
