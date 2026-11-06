import { mcpDraftCreateSchema, mcpDraftUpdateSchema, mcpMachineScopeInputSchema, mcpSecretInputSchema } from '@agent-hub/shared';
import { z } from 'zod';
import type { PeerToolDef, ToolResult } from '../peers/tools.js';
import type { McpDraftClient } from './draftClient.js';

const ok = (value: unknown, secrets: string[] = []): ToolResult => {
  let text = JSON.stringify(value, null, 2);
  for (const secret of secrets) if (secret.length >= 1) text = text.split(secret).join('[redacted]');
  return { content: [{ type: 'text', text }] };
};
const fail = (message: string): ToolResult => ({ content: [{ type: 'text', text: message }], isError: true });

/** Owner-scoped registry draft tools exposed by the in-process agent-hub MCP server. */
export function mcpDraftTools(sessionId: string, machineId: string, client: Pick<McpDraftClient, 'request'>): PeerToolDef[] {
  const addServerSchema = mcpDraftCreateSchema.shape.server.extend({ machineScope: mcpMachineScopeInputSchema.optional() });
  return [
    {
      name: 'mcp_add',
      description:
        'Create and immediately validate an MCP registry draft. Return the tools or a safe validation status, draftId, and confirmation link. ' +
        'This does not connect or publish the server; the user must confirm in the hub. ' +
        'Pass secret values as secrets:[{name,value}], and reference them in env or headers with {kind:"secret-name",name}. ' +
        'Use urlSecretName for URL credentials. machineScope is optional; by default the server is available only on this machine. ' +
        'Set allMachines:true with machineIds:[] to share it, or set allMachines:false and include at least one machineId. ' +
        'Never invent secretIds. Secret values are write-only and never returned.',
      shape: { server: addServerSchema, secrets: mcpSecretInputSchema.optional() },
      readOnly: false,
      run: async args => {
        const secrets = Array.isArray(args.secrets) ? args.secrets.map(s => (typeof s === 'object' && s && 'value' in s ? String((s as { value: unknown }).value) : '')) : [];
        const server = args.server as Record<string, unknown>;
        const machineScope = server.machineScope as { allMachines: boolean; machineIds: string[] } | undefined;
        if (machineScope && !machineScope.allMachines && machineScope.machineIds.length === 0) {
          return fail('machineScope cannot be empty. Set allMachines:true or include at least one machineId.');
        }
        const scopedServer = {
          ...server,
          machineScope: machineScope ?? { allMachines: false, machineIds: [machineId] },
        };
        try {
          return ok(
            await client.request({ sessionId, op: 'add', payload: { server: scopedServer, ...(args.secrets ? { secrets: args.secrets } : {}) } } as Parameters<McpDraftClient['request']>[0]),
            secrets,
          );
        } catch {
          return fail('MCP draft service is unavailable; no server was added.');
        }
      },
    },
    {
      name: 'mcp_list',
      description: 'List owner-visible MCP registry servers and drafts. Secret values are never included.',
      shape: { includeDrafts: z.boolean().optional() },
      readOnly: true,
      run: async args => {
        try {
          return ok(await client.request({ sessionId, op: 'list', payload: { includeDrafts: args.includeDrafts ?? true } } as Parameters<McpDraftClient['request']>[0]));
        } catch {
          return fail('MCP draft service is unavailable.');
        }
      },
    },
    {
      name: 'mcp_update',
      description:
        'Edit an existing registry draft with draftId, or create a revision-bound candidate for a connected server with serverId. ' +
        'Provide exactly one id and its current revision. The candidate is immediately validated and remains unpublished until hub confirmation. ' +
        'Pass secret values in update.secrets:[{name,value}], and reference them in env or headers with {kind:"secret-name",name}. ' +
        'Use urlSecretName for URL credentials. For machineScope, set allMachines:true with machineIds:[], or include at least one machineId when false. Never invent secretIds.',
      shape: { draftId: z.guid().optional(), serverId: z.guid().optional(), update: mcpDraftUpdateSchema },
      readOnly: false,
      run: async args => {
        const update = args.update as z.infer<typeof mcpDraftUpdateSchema>;
        const secrets = update.secrets?.map(s => s.value) ?? [];
        if ((typeof args.draftId === 'string') === (typeof args.serverId === 'string')) {
          return fail('Provide exactly one of draftId or serverId.');
        }
        try {
          const target = typeof args.draftId === 'string' ? { draftId: args.draftId } : { serverId: String(args.serverId) };
          return ok(await client.request({ sessionId, op: 'update', payload: { ...target, update } } as Parameters<McpDraftClient['request']>[0]), secrets);
        } catch {
          return fail('MCP draft service is unavailable; no changes were applied.');
        }
      },
    },
  ];
}
