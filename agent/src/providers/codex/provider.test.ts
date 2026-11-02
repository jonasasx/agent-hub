// The Codex provider against a fake app-server (change agent-providers, task 2.11): start, mirror, partial text,
// result, permissions, questions, client tools, interrupt, stop, resume, fork, sign-in.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../log.js';
import { PEERS_SERVER_NAME } from '@agent-hub/shared';
import { ProviderRouter } from '../router.js';
import type { SessionProvider } from '../types.js';
import { FakeAppServer } from './fakeServer.js';
import { mirrorPath } from './mirror.js';
import { CodexProvider, failureOf, policyOf } from './provider.js';

interface Sent {
  type: string;
  payload: Record<string, unknown>;
}

const dirs: string[] = [];
const providers: CodexProvider[] = [];
let originalClaudeConfigDir: string | undefined;
let changedClaudeConfigDir = false;
afterEach(async () => {
  for (const p of providers.splice(0)) await p.stopAll(50);
  await new Promise(r => setTimeout(r, 30));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (changedClaudeConfigDir) {
    if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    changedClaudeConfigDir = false;
  }
});

function setup(
  o: {
    hubProtocol?: string;
    peers?: { request: (p: unknown) => Promise<unknown> };
    registry?: () => unknown;
    gateway?: unknown;
    mcpDraft?: unknown;
    machineId?: () => string;
    configDir?: string;
  } = {},
) {
  if (!changedClaudeConfigDir) {
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    changedClaudeConfigDir = true;
  }
  const configDir = o.configDir ?? mkdtempSync(join(tmpdir(), 'ah-claude-config-'));
  if (!o.configDir) dirs.push(configDir);
  process.env.CLAUDE_CONFIG_DIR = configDir;
  const peers = o.peers ?? { request: async () => ({}) };
  const projectsDir = mkdtempSync(join(tmpdir(), 'ah-codex-unit-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ah-codex-cwd-'));
  dirs.push(projectsDir, cwd);
  const servers: FakeAppServer[] = [];
  const service = new FakeAppServer();
  const sent: Sent[] = [];
  const p = new CodexProvider({
    bin: { command: 'codex', args: [], version: '0.166.0' },
    send: (type, payload) => {
      sent.push({ type, payload: payload as Record<string, unknown> });
      return true;
    },
    log: createLogger({ level: 'error', write: () => undefined }),
    projectsDir,
    agentVersion: '0.3.1',
    images: async () => [],
    hubProtocol: () => o.hubProtocol ?? '1.10',
    registry: o.registry as never,
    gateway: o.gateway as never,
    mcpDraft: o.mcpDraft as never,
    machineId: o.machineId,
    peers: peers as never,
    transport: () => {
      const s = new FakeAppServer();
      servers.push(s);
      return s.transport();
    },
    serviceTransport: () => service.transport(),
    stopGraceMs: 200,
  });
  providers.push(p);
  const tick = () => new Promise(r => setTimeout(r, 30));
  const lines = (sid: string) =>
    readFileSync(mirrorPath(projectsDir, sid), 'utf8')
      .trim()
      .split('\n')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose transcript lines in assertions
      .map(l => JSON.parse(l) as Record<string, any>);
  return { p, sent, servers, service, projectsDir, cwd, tick, lines };
}

const cmd = (type: string, payload: unknown) => ({ v: 1, ts: 0, type, id: randomUUID(), payload }) as never;

async function started(t: ReturnType<typeof setup>, mode = 'default', prompt = '') {
  const sessionId = randomUUID();
  const promptUuid = randomUUID();
  const r = await t.p.handle(cmd('session.start', { sessionId, cwd: t.cwd, permissionMode: mode, model: 'gpt-test', prompt, promptUuid, provider: 'codex' }));
  return { sessionId, promptUuid, r, server: t.servers.at(-1)! };
}

describe('policyOf (design D6)', () => {
  it('maps the modes', () => {
    expect(policyOf('bypassPermissions', '/w')).toMatchObject({ approvalPolicy: 'never', sandbox: 'danger-full-access' });
    expect(policyOf('default', '/w')).toMatchObject({ approvalPolicy: 'untrusted', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/w'] } });
    expect(policyOf('acceptEdits', '/w')).toMatchObject({ approvalPolicy: 'on-request', sandbox: 'workspace-write' });
    expect(policyOf('plan', '/w')).toMatchObject({ approvalPolicy: 'on-request', sandbox: 'read-only' });
  });
  it('classifies failures', () => {
    expect(failureOf({ message: 'x', codexErrorInfo: 'unauthorized' })?.kind).toBe('auth_rejected');
    expect(failureOf({ message: 'x', codexErrorInfo: 'usageLimitExceeded' })?.kind).toBe('subscription_limit');
    expect(failureOf({ message: 'x', codexErrorInfo: 'serverOverloaded' })).toBeUndefined();
  });
});

describe('CodexProvider', () => {
  it('starts a thread with the policy, MCP config and instructions; writes the header; reports models', async () => {
    const t = setup();
    const { sessionId, r, server } = await started(t);
    expect(r).toEqual({ models: [{ value: 'gpt-test', displayName: 'GPT Test' }] });
    const start = server.calls('thread/start')[0]!;
    expect(start).toMatchObject({ cwd: t.cwd, model: 'gpt-test', approvalPolicy: 'untrusted', sandbox: 'workspace-write' });
    expect(start.config).toEqual({ mcp_servers: {} });
    expect(String(start.developerInstructions)).toContain('session_send');
    expect((start.dynamicTools as Array<{ name: string; tools: Array<{ type: string; name: string }> }>)[0]!.tools.map(x => x.name)).toEqual(['sessions_list', 'session_get', 'session_send']);
    expect((start.dynamicTools as Array<{ tools: Array<{ type: string }> }>)[0]!.tools.every(x => x.type === 'function')).toBe(true);
    expect(server.calls('initialize')[0]).toMatchObject({ capabilities: { experimentalApi: true } });
    expect(t.lines(sessionId)[0]).toMatchObject({ type: 'system', subtype: 'agent_provider', provider: 'codex', threadId: 'thread-1', sessionId, cwd: t.cwd });
    expect(t.sent.filter(m => m.type === 'session.state').at(-1)).toMatchObject({ type: 'session.state', payload: { sessionId, state: 'waiting', permissionMode: 'default' } });
    expect(t.p.liveSessions()).toEqual([{ sessionId, state: 'waiting' }]);
  });

  // hub-subagents D1/D2: session_spawn and its instructions with a hub ≥1.12; resultText of a successful turn
  it('hub 1.12: session_spawn in the namespace and the instructions; the last agentMessage is resultText', async () => {
    const t = setup({ hubProtocol: '1.12' });
    const { sessionId, server } = await started(t);
    const start = server.calls('thread/start')[0]!;
    expect((start.dynamicTools as Array<{ tools: Array<{ name: string }> }>)[0]!.tools.map(x => x.name)).toEqual(['sessions_list', 'session_get', 'session_send', 'session_spawn']);
    expect(String(start.developerInstructions)).toContain('session_spawn');
    const turn = async (id: string, items: string[], status: string) => {
      await t.p.handle(cmd('session.send', { sessionId, text: 'x', promptUuid: randomUUID() }));
      server.notify('turn/started', { threadId: 'thread-1', turn: { id } });
      items.forEach((text, i) => server.notify('item/completed', { threadId: 'thread-1', turnId: id, item: { type: 'agentMessage', id: `${id}-m${i}`, text } }));
      server.notify('turn/completed', { threadId: 'thread-1', turn: { id, status, error: null, durationMs: 1 } });
      await t.tick();
      await t.tick();
      return t.sent.filter(m => m.type === 'session.result').at(-1)!.payload as { resultText?: string };
    };
    expect((await turn('turn-1', ['сначала', 'Итог: готово'], 'completed')).resultText).toBe('Итог: готово');
    expect((await turn('turn-2', [], 'completed')).resultText).toBeUndefined();
    expect((await turn('turn-3', ['частично'], 'interrupted')).resultText).toBeUndefined();
  });

  it('hub 1.11: no session_spawn and no resultText', async () => {
    const t = setup({ hubProtocol: '1.11' });
    const { server } = await started(t);
    const start = server.calls('thread/start')[0]!;
    expect((start.dynamicTools as Array<{ tools: Array<{ name: string }> }>)[0]!.tools.map(x => x.name)).not.toContain('session_spawn');
    expect(String(start.developerInstructions)).not.toContain('session_spawn');
  });

  it('hub 1.13 uses only registry MCP servers and reports updates for the next thread', async () => {
    const serverId = randomUUID(),
      sessionId = randomUUID(),
      machineId = randomUUID();
    const snapshot = {
      protocol: '1.13',
      revision: 1,
      generatedAt: 1,
      registryEnabled: true,
      servers: [
        {
          id: serverId,
          name: 'registry-only',
          enabled: true,
          transport: 'http',
          mode: 'remote',
          url: 'https://mcp.example.test/mcp',
          machineScope: { allMachines: false, machineIds: [machineId] },
          projectIds: [],
          revision: 1,
          secrets: [],
        },
      ],
    };
    const gateway = { url: 'http://127.0.0.1:4321/mcp', authorize: vi.fn(() => 'session-token'), revokeSession: vi.fn() };
    const draftCalls: unknown[] = [];
    const mcpDraft = {
      request: vi.fn(async (input: unknown) => {
        draftCalls.push(input);
        return { requestId: randomUUID(), ok: true, result: { message: 'stored' } };
      }),
    };
    const t = setup({ hubProtocol: '1.13', registry: () => snapshot, gateway, mcpDraft, machineId: () => machineId });
    const r = await t.p.handle(cmd('session.start', { sessionId, cwd: t.cwd, permissionMode: 'default', model: 'gpt-test', prompt: '', promptUuid: randomUUID(), provider: 'codex' }));
    const start = t.servers.at(-1)!.calls('thread/start')[0]!;
    expect(start.config).toMatchObject({
      mcp_servers: { 'registry-only': { url: `http://127.0.0.1:4321/mcp?server=${serverId}`, http_headers: { Authorization: 'Bearer session-token', 'x-agent-session': sessionId } } },
    });
    expect(Object.keys((start.config as { mcp_servers: Record<string, unknown> }).mcp_servers)).toEqual(['registry-only']);
    expect((start.dynamicTools as Array<{ tools: Array<{ name: string }> }>)[0]!.tools.map(x => x.name)).toEqual(expect.arrayContaining(['mcp_add', 'mcp_list', 'mcp_update']));
    const server = t.servers.at(-1)!;
    const toolResult = await server.request('item/tool/call', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      callId: 'mcp-add-default-scope',
      namespace: 'agent-hub',
      tool: 'mcp_add',
      arguments: {
        server: {
          id: randomUUID(),
          name: 'codex_default_scope',
          enabled: true,
          transport: 'stdio',
          mode: 'per-session',
          command: 'node',
          projectIds: [],
        },
      },
    });
    expect(toolResult.result).toMatchObject({ success: true });
    expect(draftCalls).toMatchObject([{ sessionId, op: 'add', payload: { server: { machineScope: { allMachines: false, machineIds: [machineId] } } } }]);
    expect(r).toBeDefined();
    const update = { sessionId, revision: 2, server: snapshot.servers[0], activation: 'available-next-thread' };
    await t.p.handle(cmd('mcp.registry.session-update', update));
    expect(t.sent.find(m => m.type === 'mcp.registry.session-update.ack')?.payload).toMatchObject({ sessionId, revision: 2, activation: 'available-next-thread', applied: true });
  });

  it('keeps legacy Codex MCP config without draft tools when registry mode is off', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'ah-claude-config-'));
    dirs.push(configDir);
    writeFileSync(
      join(configDir, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          legacy: { command: 'node', args: ['legacy-server.js'] },
          [PEERS_SERVER_NAME]: { command: 'node', args: ['ignored.js'] },
        },
      }),
    );
    const t = setup({
      hubProtocol: '1.13',
      registry: () => ({ protocol: '1.13', revision: 1, generatedAt: 1, registryEnabled: false, servers: [] }),
      mcpDraft: { request: vi.fn(async () => ({})) },
      configDir,
    });
    const { server } = await started(t);
    const start = server.calls('thread/start')[0]!;
    expect(start.config).toEqual({
      mcp_servers: { legacy: { command: 'node', args: ['legacy-server.js'], startup_timeout_sec: 30 } },
    });
    const tools = (start.dynamicTools as Array<{ tools: Array<{ name: string }> }>)[0]!.tools.map(tool => tool.name);
    expect(tools).not.toEqual(expect.arrayContaining(['mcp_add', 'mcp_list', 'mcp_update']));
  });

  it('starts against a 1.12 hub using legacy Codex MCP configuration', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'ah-claude-config-'));
    dirs.push(configDir);
    writeFileSync(join(configDir, '.claude.json'), JSON.stringify({ mcpServers: { legacy: { command: 'node' } } }));
    const t = setup({ hubProtocol: '1.12', configDir });
    const { server } = await started(t);
    const start = server.calls('thread/start')[0]!;
    expect(start.config).toEqual({
      mcp_servers: { legacy: { command: 'node', args: [], startup_timeout_sec: 30 } },
    });
    expect((start.dynamicTools as Array<{ tools: Array<{ name: string }> }>)[0]!.tools.map(tool => tool.name)).not.toContain('mcp_add');
  });

  it('no agent-hub tools for a hub below 1.9', async () => {
    const t = setup({ hubProtocol: '1.8' });
    const { server } = await started(t);
    expect(server.calls('thread/start')[0]!.dynamicTools).toBeUndefined();
  });

  it('a message: user line with the prompt uuid, turn/start with the policy; partial text; items; result', async () => {
    const t = setup();
    const { sessionId, server } = await started(t, 'bypassPermissions');
    const promptUuid = randomUUID();
    await t.p.handle(cmd('session.send', { sessionId, text: 'привет', promptUuid }));
    expect(server.calls('turn/start')[0]).toMatchObject({
      threadId: 'thread-1',
      clientUserMessageId: promptUuid,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
      input: [{ type: 'text', text: 'привет' }],
    });
    server.notify('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } });
    server.notify('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'msg-1', delta: 'При' });
    server.notify('item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { type: 'commandExecution', id: 'cmd-1', command: 'ls', cwd: t.cwd, status: 'completed', aggregatedOutput: 'a.txt\n', exitCode: 0 },
    });
    server.notify('item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { type: 'fileChange', id: 'fc-1', status: 'completed', changes: [{ path: 'a.txt', kind: { type: 'update', move_path: null }, diff: '-a\n+b' }] },
    });
    server.notify('item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { type: 'mcpToolCall', id: 'mcp-1', server: 'ctx', tool: 'docs', status: 'completed', arguments: { q: 1 }, result: { content: [{ type: 'text', text: 'ok' }] }, error: null },
    });
    server.notify('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'reasoning', id: 'r-1', summary: ['думаю'], content: [] } });
    server.notify('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'msg-1', text: 'Привет!' } });
    server.notify('turn/plan/updated', { threadId: 'thread-1', turnId: 'turn-1', plan: [{ step: 'шаг', status: 'inProgress' }] });
    server.notify('thread/tokenUsage/updated', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      tokenUsage: { last: { inputTokens: 10, outputTokens: 5, reasoningOutputTokens: 2, cachedInputTokens: 3, cacheWriteInputTokens: 1 } },
    });
    server.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null, durationMs: 1234 } });
    await t.tick();
    await t.tick();
    // the mirror is written asynchronously: a loaded machine needs more than the two ticks
    await vi.waitFor(
      () =>
        expect(
          t
            .lines(sessionId)
            .flatMap(l => (l.type === 'assistant' ? l.message.content : []))
            .filter((c: { type: string }) => c.type === 'tool_use'),
        ).toHaveLength(4),
      { timeout: 5000 },
    );
    expect(t.sent.find(m => m.type === 'session.partial')?.payload).toEqual({ sessionId, messageId: 'msg-1', blockIndex: 0, textDelta: 'При' });
    expect(t.sent.find(m => m.type === 'session.result')?.payload).toEqual({
      sessionId,
      subtype: 'success',
      isError: false,
      durationMs: 1234,
      costUsd: 0,
      usage: { inputTokens: 10, outputTokens: 7, cacheReadTokens: 3, cacheCreationTokens: 1 },
    });
    expect(t.sent.at(-1)).toMatchObject({ type: 'session.state', payload: { state: 'waiting' } });
    const lines = t.lines(sessionId);
    expect(lines[1]).toMatchObject({ type: 'user', uuid: promptUuid, message: { content: 'привет' }, parentUuid: lines[0]!.uuid });
    const tools = lines.flatMap(l => (l.type === 'assistant' ? l.message.content : [])).filter((c: { type: string }) => c.type === 'tool_use');
    expect(tools.map((c: { name: string }) => c.name)).toEqual(['Bash', 'ApplyPatch', 'mcp__ctx__docs', 'TodoWrite']);
    expect(tools[1].input).toEqual({ changes: [{ path: 'a.txt', kind: 'update', diff: '-a\n+b' }] });
    const results = lines.flatMap(l => (l.type === 'user' && Array.isArray(l.message.content) ? l.message.content : []));
    expect(results.find((c: { tool_use_id: string }) => c.tool_use_id === 'cmd-1')).toMatchObject({ content: 'a.txt' });
    expect(lines.some(l => l.type === 'assistant' && l.message.content[0].type === 'thinking')).toBe(true);
    expect(lines.some(l => l.type === 'assistant' && l.message.content[0].text === 'Привет!' && l.message.id === 'msg-1')).toBe(true);
  });

  it('a message during a turn steers it', async () => {
    const t = setup();
    const { sessionId, server } = await started(t, 'default', 'начни');
    server.notify('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } });
    await t.p.handle(cmd('session.send', { sessionId, text: 'ещё', promptUuid: randomUUID() }));
    expect(server.calls('turn/steer')[0]).toMatchObject({ threadId: 'thread-1', expectedTurnId: 'turn-1' });
    expect(server.calls('turn/start')).toHaveLength(1);
  });

  it('a failed turn: error result with failure, api_error line', async () => {
    const t = setup();
    const { sessionId, server } = await started(t, 'default', 'x');
    server.notify('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } });
    server.notify('error', { threadId: 'thread-1', turnId: 'turn-1', willRetry: false, error: { message: '401 Unauthorized', codexErrorInfo: 'unauthorized' } });
    server.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'failed', error: null, durationMs: 5 } });
    await vi.waitFor(() => expect(t.lines(sessionId).some(l => l.type === 'system' && l.subtype === 'api_error')).toBe(true), { timeout: 5000 });
    expect(t.sent.find(m => m.type === 'session.result')?.payload).toMatchObject({ isError: true, errorText: '401 Unauthorized', failure: { kind: 'auth_rejected' } });
    expect(t.p.status().login).toBe('rejected');
  });

  it('a command approval: permission card, allow for the session → acceptForSession', async () => {
    const t = setup();
    const { sessionId, server } = await started(t, 'default', 'x');
    server.notify('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } });
    const answer = server.request('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'cmd-1', command: 'rm -rf build', cwd: t.cwd, reason: 'clean' });
    await t.tick();
    const req = t.sent.find(m => m.type === 'permission.request')!.payload;
    expect(req).toMatchObject({ sessionId, toolName: 'Bash', toolUseId: 'cmd-1', kind: 'tool', input: { command: 'rm -rf build', reason: 'clean' }, reason: 'clean' });
    expect(t.p.ownsRequest(String(req.requestId))).toBe(true);
    expect(t.sent.filter(m => m.type === 'session.state').at(-1)?.payload.state).toBe('permission');
    await t.p.handle(cmd('permission.response', { requestId: req.requestId, behavior: 'allow', scope: 'session' }));
    expect((await answer).result).toEqual({ decision: 'acceptForSession' });
    expect(t.sent.filter(m => m.type === 'session.state').at(-1)?.payload.state).toBe('working');
  });

  it('a file change approval carries the changes of the started item; deny → decline', async () => {
    const t = setup();
    await started(t, 'default', 'x');
    const server = t.servers.at(-1)!;
    server.notify('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } });
    server.notify('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { type: 'fileChange', id: 'fc-1', status: 'inProgress', changes: [{ path: 'b.txt', kind: { type: 'add' }, diff: '+x' }] },
    });
    const answer = server.request('item/fileChange/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'fc-1' });
    await t.tick();
    const req = t.sent.find(m => m.type === 'permission.request')!.payload;
    expect(req).toMatchObject({ toolName: 'ApplyPatch', input: { changes: [{ path: 'b.txt', kind: 'add', diff: '+x' }] } });
    await t.p.handle(cmd('permission.response', { requestId: req.requestId, behavior: 'deny', scope: 'once' }));
    expect((await answer).result).toEqual({ decision: 'decline' });
  });

  it('a question: AskUserQuestion card, answers by question id', async () => {
    const t = setup();
    await started(t, 'default', 'x');
    const server = t.servers.at(-1)!;
    const answer = server.request('item/tool/requestUserInput', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'q-1',
      isBlocking: true,
      autoResolutionMs: null,
      questions: [
        {
          id: 'q1',
          header: 'Стек',
          question: 'Какой стек?',
          isOther: false,
          isSecret: false,
          options: [
            { label: 'Node', description: 'TS' },
            { label: 'Go', description: '' },
          ],
        },
      ],
    });
    await t.tick();
    const req = t.sent.find(m => m.type === 'permission.request')!.payload;
    expect(req).toMatchObject({
      toolName: 'AskUserQuestion',
      kind: 'question',
      input: {
        questions: [
          {
            question: 'Какой стек?',
            header: 'Стек',
            options: [
              { label: 'Node', description: 'TS' },
              { label: 'Go', description: '' },
            ],
            multiSelect: false,
          },
        ],
      },
    });
    await t.p.handle(cmd('permission.response', { requestId: req.requestId, behavior: 'allow', scope: 'once', answers: { 'Какой стек?': 'Go' } }));
    expect((await answer).result).toEqual({ answers: { q1: { answers: ['Go'] } } });
  });

  it('agent-hub client tools go to the hub with this session as the caller', async () => {
    const calls: unknown[] = [];
    const t = setup({ peers: { request: async p => (calls.push(p), { sessions: [] }) } });
    const { sessionId, server } = await started(t);
    const r = await server.request('item/tool/call', { threadId: 'thread-1', turnId: 'turn-1', callId: 'c1', namespace: 'agent-hub', tool: 'sessions_list', arguments: { machine: 'HP' } });
    expect(calls).toEqual([{ op: 'list', machine: 'HP', sessionId }]);
    expect(r.result).toMatchObject({ success: true, contentItems: [{ type: 'inputText' }] });
    const bad = await server.request('item/tool/call', { threadId: 'thread-1', turnId: 'turn-1', callId: 'c2', namespace: 'agent-hub', tool: 'session_send', arguments: { to: 'nope' } });
    expect(bad.result).toMatchObject({ success: false });
  });

  it('interrupt, set_model and set_mode reach the next turn', async () => {
    const t = setup();
    const { sessionId, server } = await started(t, 'default', 'x');
    server.notify('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } });
    await t.p.handle(cmd('session.interrupt', { sessionId }));
    expect(server.calls('turn/interrupt')[0]).toEqual({ threadId: 'thread-1', turnId: 'turn-1' });
    server.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted', error: null, durationMs: 1 } });
    await t.p.handle(cmd('session.set_model', { sessionId, model: 'gpt-other' }));
    await t.p.handle(cmd('session.set_mode', { sessionId, mode: 'plan' }));
    expect(t.sent.at(-1)).toMatchObject({ type: 'session.state', payload: { permissionMode: 'plan' } });
    await t.p.handle(cmd('session.send', { sessionId, text: 'дальше', promptUuid: randomUUID() }));
    expect(server.calls('turn/start').at(-1)).toMatchObject({ model: 'gpt-other', approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' } });
  });

  it('stop: exited stopped; resume finds the thread in the mirror; no mirror — transcript_missing', async () => {
    const t = setup();
    const { sessionId, server } = await started(t);
    await t.p.handle(cmd('session.stop', { sessionId, reason: 'sleep' }));
    expect(server.closed).toBe(true);
    expect(t.sent.find(m => m.type === 'session.exited')?.payload).toEqual({ sessionId, code: 0, reason: 'stopped' });
    expect(t.p.has(sessionId)).toBe(false);
    await t.p.handle(cmd('session.resume', { sessionId, cwd: t.cwd, permissionMode: 'default', provider: 'codex' }));
    expect(t.servers.at(-1)!.calls('thread/resume')[0]).toMatchObject({ threadId: 'thread-1', cwd: t.cwd });
    expect(t.servers.at(-1)!.calls('thread/resume')[0]).not.toHaveProperty('dynamicTools');
    expect(t.lines(sessionId).filter(l => l.subtype === 'agent_provider')).toHaveLength(1);
    await expect(t.p.handle(cmd('session.resume', { sessionId: randomUUID(), cwd: t.cwd, permissionMode: 'default', provider: 'codex' }))).rejects.toMatchObject({ code: 'transcript_missing' });
  });

  it('a crash: exited crashed with the error', async () => {
    const t = setup();
    const { sessionId, server } = await started(t);
    server.exit(1, 'boom');
    await t.tick();
    expect(t.sent.find(m => m.type === 'session.exited')?.payload).toMatchObject({ sessionId, reason: 'crashed', errorText: 'boom' });
  });

  it('fork: a new session with the copied mirror and a new thread', async () => {
    const t = setup();
    const { sessionId } = await started(t);
    const r = (await t.p.handle(cmd('session.fork', { sourceSessionId: sessionId, cwd: t.cwd, provider: 'codex' }))) as { newSessionId: string };
    const copy = t.lines(r.newSessionId);
    expect(copy[0]).toMatchObject({ subtype: 'agent_provider', threadId: 'thread-fork', sessionId: r.newSessionId });
    expect(copy[0]!.uuid).not.toBe(t.lines(sessionId)[0]!.uuid);
  });

  it('sign-in: device code, completion → provider.login.done and status; sign-out', async () => {
    const t = setup();
    const r = await t.p.handle(cmd('provider.login.start', { provider: 'codex' }));
    expect(r).toMatchObject({ loginId: 'login-1', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' });
    t.service.notify('account/login/completed', { loginId: 'login-1', success: true, error: null });
    await t.tick();
    await t.tick();
    expect(t.sent.find(m => m.type === 'provider.login.done')?.payload).toEqual({ provider: 'codex', loginId: 'login-1', ok: true });
    expect(t.p.status()).toEqual({ id: 'codex', version: '0.166.0', login: 'ok', account: { email: 'ivan@example.com', plan: 'pro' }, models: [{ value: 'gpt-test', displayName: 'GPT Test' }] });
    t.service.handlers['account/read'] = () => ({ account: null, requiresOpenaiAuth: true });
    await t.p.handle(cmd('provider.logout', { provider: 'codex' }));
    expect(t.p.status().login).toBe('missing');
  });

  it('a started session pushes its MCP status to the hub by itself', async () => {
    const t = setup();
    await started(t);
    await t.tick();
    await t.tick();
    expect(t.sent.filter(m => m.type === 'mcp.status').length).toBeGreaterThan(0);
  });

  it('MCP actions are refused, the status is read', async () => {
    const t = setup();
    const { sessionId, server } = await started(t);
    server.handlers['mcpServerStatus/list'] = () => ({
      data: [
        { name: 'ctx', httpOrigin: null, tools: { a: {}, b: {} }, toolsError: null, authStatus: 'unsupported', serverInfo: null, pluginId: null },
        { name: 'notion', httpOrigin: 'https://mcp.notion.com', tools: {}, toolsError: 'auth required', authStatus: 'notLoggedIn', serverInfo: null, pluginId: null },
      ],
      nextCursor: null,
    });
    const r = (await t.p.handle(cmd('mcp.status.get', { sessionId }))) as { snapshot: { servers: Array<{ name: string; status: string; toolCount: number }> } };
    expect(r.snapshot.servers.map(s => [s.name, s.status, s.toolCount])).toEqual([
      ['ctx', 'connected', 2],
      ['notion', 'needs-auth', 0],
    ]);
    // the servers of the thread, not only CODEX_HOME's config.toml
    expect(server.calls('mcpServerStatus/list').at(-1)).toMatchObject({ threadId: expect.any(String) });
    await expect(t.p.handle(cmd('mcp.action', { sessionId, server: 'ctx', action: 'reconnect' }))).rejects.toMatchObject({ code: 'mcp_not_supported' });
  });
});

describe('ProviderRouter (design D1)', () => {
  const fake = (id: 'claude' | 'codex', live: string[] = [], requests: string[] = []) => {
    const got: string[] = [];
    const p: SessionProvider = {
      id,
      handle: async m => (got.push(m.type), id),
      has: s => live.includes(s),
      ownsRequest: r => requests.includes(r),
      liveSessions: () => live.map(sessionId => ({ sessionId, state: 'waiting' as const })),
      stopAll: async () => undefined,
    };
    return { p, got };
  };
  it('routes by payload provider, by live session and by request; machine commands to Claude', async () => {
    const claude = fake('claude', ['c1']);
    const codex = fake('codex', ['x1'], ['r1']);
    const r = new ProviderRouter(claude.p, [codex.p]);
    expect(await r.handle(cmd('session.start', { provider: 'codex' }))).toBe('codex');
    expect(await r.handle(cmd('session.start', {}))).toBe('claude');
    expect(await r.handle(cmd('session.send', { sessionId: 'x1' }))).toBe('codex');
    expect(await r.handle(cmd('session.send', { sessionId: 'c1' }))).toBe('claude');
    expect(await r.handle(cmd('permission.response', { requestId: 'r1' }))).toBe('codex');
    expect(await r.handle(cmd('permission.response', { requestId: 'r2' }))).toBe('claude');
    expect(await r.handle(cmd('fs.stat', { path: '/' }))).toBe('claude');
    expect(await r.handle(cmd('provider.login.start', { provider: 'codex' }))).toBe('codex');
    expect(r.liveSessions().map(s => s.sessionId)).toEqual(['c1', 'x1']);
  });
  it('a provider the machine does not have: provider_unavailable', async () => {
    const r = new ProviderRouter(fake('claude').p);
    await expect(r.handle(cmd('session.start', { provider: 'codex' }))).rejects.toMatchObject({ code: 'provider_unavailable' });
  });
});
