import { describe, expect, it } from 'vitest';
import { PEERS_READ_TOOL_NAMES, PEERS_SERVER_NAME, wrapPeerMessage } from '@agent-hub/shared';
import { PeersError } from './client.js';
import { HUB_SYSTEM_PROMPT_APPEND, PEERS_SYSTEM_PROMPT_APPEND, PROJECTS_SYSTEM_PROMPT_APPEND, SPAWN_SYSTEM_PROMPT_APPEND, systemPromptAppend } from '../sessions/manager.js';
import { createPeersServer, peersTools, peersToolDefs } from './tools.js';

const SID = '0b3c1b3e-6b0a-4a52-9a4e-1d0a8d6f2f11';
const OTHER = '5f1d8f7e-2b6f-4d3a-8a55-0c7a3c0b9e22';

function setup(answer: (p: unknown) => unknown = () => ({ ok: true }), o: { spawn?: boolean; projects?: boolean } = {}) {
  const requests: unknown[] = [];
  const client = {
    request: async (p: unknown) => {
      requests.push(p);
      const a = answer(p);
      if (a instanceof Error) throw a;
      return a;
    },
  };
  const tools = Object.fromEntries(peersTools(SID, client as never, o).map(t => [t.name, t]));
  const run = (name: string, args: Record<string, unknown>) => tools[name]!.handler(args as never, {}) as Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
  return { requests, run, tools };
}

const CYRILLIC = /[Ѐ-ӿ]/;

describe('model-facing texts are English (i18n D7)', () => {
  it('the system prompt additions have no Cyrillic', () => {
    for (const text of [HUB_SYSTEM_PROMPT_APPEND, PEERS_SYSTEM_PROMPT_APPEND, SPAWN_SYSTEM_PROMPT_APPEND, PROJECTS_SYSTEM_PROMPT_APPEND]) expect(text).not.toMatch(CYRILLIC);
  });

  it('names, descriptions and parameter descriptions of every agent-hub tool have no Cyrillic', () => {
    const client = { request: async () => ({}) };
    const defs = peersToolDefs(SID, client as never, { spawn: true, projects: true, mcpDraft: client as never, machineId: 'm1' });
    expect(defs.map(d => d.name)).toEqual(
      expect.arrayContaining(['sessions_list', 'session_get', 'session_send', 'session_spawn', 'mcp_add', 'mcp_list', 'mcp_update', 'projects_list', 'project_create', 'project_update']),
    );
    for (const d of defs) {
      expect(d.name).not.toMatch(CYRILLIC);
      expect(d.description).not.toMatch(CYRILLIC);
      for (const [key, schema] of Object.entries(d.shape)) {
        expect(key).not.toMatch(CYRILLIC);
        expect((schema as { description?: string }).description ?? '').not.toMatch(CYRILLIC);
      }
    }
  });

  it('the peer-message wrapper has no Cyrillic', () => {
    const w = wrapPeerMessage({ from: SID, title: 'Deploy', machine: 'X1', id: OTHER, kind: 'report', parent: true, inReplyTo: SID }, 'hello');
    expect(w).not.toMatch(CYRILLIC);
  });
});

describe('agent-hub tools', () => {
  it('three tools; the read-only ones are exactly those allowed without a request', () => {
    const { tools } = setup();
    expect(Object.keys(tools).sort()).toEqual(['session_get', 'session_send', 'sessions_list']);
    expect(PEERS_READ_TOOL_NAMES).toEqual([`mcp__${PEERS_SERVER_NAME}__sessions_list`, `mcp__${PEERS_SERVER_NAME}__session_get`, `mcp__${PEERS_SERVER_NAME}__projects_list`]);
  });

  it('the caller is always the closure session, whatever the model passes', async () => {
    const { requests, run } = setup();
    await run('sessions_list', { status: 'waiting', machine: 'HP', sessionId: OTHER });
    await run('session_get', { session: OTHER });
    await run('session_send', { to: OTHER, text: 'привет', inReplyTo: SID });
    expect(requests).toEqual([
      { op: 'list', sessionId: SID, status: 'waiting', machine: 'HP' },
      { op: 'get', sessionId: SID, target: OTHER },
      { op: 'send', sessionId: SID, to: OTHER, text: 'привет', inReplyTo: SID },
    ]);
  });

  it('the result is the hub result as JSON text', async () => {
    const { run } = setup(() => ({ result: 'delivered', messageId: OTHER }));
    const r = await run('session_send', { to: OTHER, text: 'x' });
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content[0]!.text)).toEqual({ result: 'delivered', messageId: OTHER });
  });

  it('an error of the hub is a tool error with the code, the message and the retry hint', async () => {
    const { run } = setup(() => new PeersError('rate_limited', 'слишком часто', 42));
    const r = await run('session_send', { to: OTHER, text: 'x' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe('rate_limited: слишком часто (retry in 42 s)');
    const other = await setup(() => new Error('boom')).run('sessions_list', {});
    expect(other).toMatchObject({ isError: true });
    expect(other.content[0]!.text).toBe('error: boom');
  });

  // hub-subagents D1: session_spawn only with a hub ≥1.12, not read-only, the caller is the closure session
  it('session_spawn: only with the spawn option; passes only the given fields, never a folder (session-folder D3)', async () => {
    expect(Object.keys(setup().tools)).not.toContain('session_spawn');
    const { tools, requests, run } = setup(() => ({ sessionId: OTHER }), { spawn: true });
    expect(Object.keys(tools).sort()).toEqual(['session_get', 'session_send', 'session_spawn', 'sessions_list']);
    expect(PEERS_READ_TOOL_NAMES).not.toContain(`mcp__${PEERS_SERVER_NAME}__session_spawn`);
    const r = await run('session_spawn', { task: 'проверь логи', provider: 'codex', machine: 'vm', cwd: '/home/ubuntu/vault', sessionId: OTHER });
    expect(JSON.parse(r.content[0]!.text)).toEqual({ sessionId: OTHER });
    await run('session_spawn', { task: 'ещё' });
    expect(requests).toEqual([
      { op: 'spawn', sessionId: SID, task: 'проверь логи', provider: 'codex', machine: 'vm' },
      { op: 'spawn', sessionId: SID, task: 'ещё' },
    ]);
  });

  // agent-project-tools D1, D5: the project tools only with a hub ≥1.18; projects_list read-only; the caller is the closure session
  it('project tools: only with the projects option; pass only the given fields', async () => {
    expect(Object.keys(setup().tools)).not.toContain('projects_list');
    const { tools, requests, run } = setup(() => ({ projects: [] }), { projects: true });
    expect(Object.keys(tools).sort()).toEqual(['project_create', 'project_update', 'projects_list', 'session_get', 'session_send', 'sessions_list']);
    expect(PEERS_READ_TOOL_NAMES).not.toContain(`mcp__${PEERS_SERVER_NAME}__project_create`);
    expect(PEERS_READ_TOOL_NAMES).not.toContain(`mcp__${PEERS_SERVER_NAME}__project_update`);
    const r = await run('projects_list', { sessionId: OTHER });
    expect(JSON.parse(r.content[0]!.text)).toEqual({ projects: [] });
    await run('project_create', { name: 'Personal OS', folder: '/Users/polina/personal-os', linkSession: true, sessionId: OTHER });
    await run('project_create', { name: 'Разное' });
    await run('project_update', { id: OTHER, folder: null, sessionId: SID });
    expect(requests).toEqual([
      { op: 'projects', sessionId: SID },
      { op: 'project_create', sessionId: SID, name: 'Personal OS', folder: '/Users/polina/personal-os', linkSession: true },
      { op: 'project_create', sessionId: SID, name: 'Разное' },
      { op: 'project_update', sessionId: SID, id: OTHER, folder: null },
    ]);
  });

  it('the system prompt names the project tools only when they are on', () => {
    expect(systemPromptAppend(true, false, '', true)).toContain(PROJECTS_SYSTEM_PROMPT_APPEND);
    expect(systemPromptAppend(true, false, '')).not.toContain(PROJECTS_SYSTEM_PROMPT_APPEND);
    expect(systemPromptAppend(false, false, '', true)).not.toContain(PROJECTS_SYSTEM_PROMPT_APPEND);
  });

  it('createPeersServer is an in-process SDK server named agent-hub', () => {
    const s = createPeersServer(SID, { request: async () => ({}) });
    expect(s).toMatchObject({ type: 'sdk', name: 'agent-hub' });
  });
});
