// The agent-hub MCP server of a session (change `session-peers`, design D1): an in-process SDK server whose tools go to
// the hub through the agent's connection. The session is the closure's `sessionId`, so «from whom» cannot be forged.
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { PEERS_SERVER_NAME, PEERS_TOOLS, PEER_LIST_MAX, PEER_SESSION_STATUSES, PEER_TEXT_MAX, PROVIDERS } from '@agent-hub/shared';
import { z } from 'zod';
import { PeersError, type PeersClient } from './client.js';
import { mcpDraftTools } from '../mcp/tools.js';
import type { McpDraftClient } from '../mcp/draftClient.js';

export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const ok = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const fail = (err: unknown): ToolResult => {
  const e = err instanceof PeersError ? err : null;
  const text = e ? `${e.code}: ${e.message}${e.retryAfterSec !== undefined ? ` (retry in ${e.retryAfterSec} s)` : ''}` : `error: ${err instanceof Error ? err.message : String(err)}`;
  return { content: [{ type: 'text', text }], isError: true };
};

/** A vendor-neutral tool of the agent-hub server (change agent-providers, design D9): Claude wraps it into an SDK MCP
 * server, Codex passes it as a client tool of the app-server. */
export interface PeerToolDef {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  readOnly: boolean;
  run: (args: Record<string, unknown>) => Promise<ToolResult>;
}

/** `spawn` — the hub is ≥1.12; `projects` — the hub is ≥1.18 (agent-project-tools D5). */
export interface PeerToolOptions {
  spawn?: boolean;
  projects?: boolean;
  mcpDraft?: Pick<McpDraftClient, 'request'>;
  machineId?: string;
}

/** The tools of one session with this session as the caller (the closure's `sessionId`). */
export function peersToolDefs(sessionId: string, client: Pick<PeersClient, 'request'>, o: PeerToolOptions = {}): PeerToolDef[] {
  const call = async (payload: Parameters<PeersClient['request']>[0]): Promise<ToolResult> => {
    try {
      return ok(await client.request(payload));
    } catch (err) {
      return fail(err);
    }
  };
  const listShape = {
    machine: z.string().max(200).optional().describe('part of the machine name, e.g. X1'),
    project: z.string().max(1000).optional().describe('part of the project directory'),
    status: z.enum(PEER_SESSION_STATUSES).optional(),
    query: z.string().max(200).optional().describe('words that must all occur in the session title, any order, case-insensitive; searches the whole history'),
    limit: z.number().int().min(1).max(PEER_LIST_MAX).optional().describe('default 50'),
  };
  const getShape = { session: z.guid().describe('session id from sessions_list') };
  const sendShape = {
    to: z.guid().describe('id of the recipient session from sessions_list'),
    text: z.string().min(1).max(PEER_TEXT_MAX),
    inReplyTo: z.guid().optional().describe('id of the peer message you are replying to (the id attribute of the tag)'),
  };
  const spawnShape = {
    task: z.string().min(1).max(PEER_TEXT_MAX).describe('task for the subagent: what to do and what to return in the end'),
    provider: z.enum(PROVIDERS).optional().describe('vendor: claude or codex; defaults to the vendor of this session'),
    machine: z.string().max(200).optional().describe('machine name (X1, HP, VM...); defaults to this machine'),
    model: z.string().max(200).optional().describe('model; defaults to the model of this session for the same vendor, otherwise the default model'),
    title: z.string().max(200).optional().describe('tab title; defaults to one derived from the task'),
  };
  const defs: PeerToolDef[] = [
    {
      name: PEERS_TOOLS.list,
      description:
        'List the Agent Hub sessions of this owner on all machines (X1, HP, VM): id, title, machine, directory, status (working, waiting, permission, sleeping, closed), whether the process is alive, time of last activity; your own session is marked self; readOnly: true marks a terminal or desktop session that the hub does not run: it can be found and read here, not messaged. Filters: by machine, by a substring of the project directory, by status, by words of the title (query). Newest activity first. To find a session by topic, pass a key word or two as query and retry with other spellings (Latin and Cyrillic, synonyms) if nothing is found.',
      shape: listShape,
      readOnly: true,
      run: a => call({ op: 'list', ...(a as z.infer<z.ZodObject<typeof listShape>>), sessionId }),
    },
    {
      name: PEERS_TOOLS.get,
      description: 'Details of one Agent Hub session by id from sessions_list: status, machine, directory, readOnly, number of running subagents and background tasks.',
      shape: getShape,
      readOnly: true,
      run: a => call({ op: 'get', sessionId, target: String(a.session) }),
    },
    {
      name: PEERS_TOOLS.send,
      description: `Send a message to another Agent Hub session, including one on another machine: a replacement for SendMessage for communication between sessions. The recipient gets the message as its next turn, marked with who sent it; a sleeping session wakes up, a busy one receives it after the current turn. There is no reply in this call: the recipient answers with a separate message, which reaches you as a user turn with a peer-message tag. Result: delivered, queued or resumed. A session with readOnly: true in sessions_list cannot be messaged (invalid_target). Text up to ${PEER_TEXT_MAX} characters; rate limited.`,
      shape: sendShape,
      readOnly: false,
      run: a => call({ op: 'send', sessionId, to: String(a.to), text: String(a.text), ...(typeof a.inReplyTo === 'string' ? { inReplyTo: a.inReplyTo } : {}) }),
    },
  ];
  // hub-subagents D1: a child hub session, the result of its turn comes back as <peer-message kind="report">
  if (o.spawn)
    defs.push({
      name: PEERS_TOOLS.spawn,
      description: `Start a subagent: a new Agent Hub session, including one of another vendor (claude, codex) or on another machine. The task is delivered to it as the first turn. The call returns immediately: id, title, machine, vendor, directory, model; the hub sends you the result of the subagent's turn itself as a <peer-message kind="report"> message, so there is no need to wait or poll. To continue working with the subagent, use session_send with its id. At most 10 running subagents; rate limited like session_send.`,
      shape: spawnShape,
      readOnly: false,
      run: a => {
        const v = a as z.infer<z.ZodObject<typeof spawnShape>>;
        const opt = Object.fromEntries(Object.entries({ provider: v.provider, machine: v.machine, model: v.model, title: v.title }).filter(([, x]) => x !== undefined));
        return call({ op: 'spawn', sessionId, task: v.task, ...opt });
      },
    });
  // agent-project-tools: the catalogue of the owner's projects and their folders
  if (o.projects) defs.push(...projectToolDefs(sessionId, call));
  if (o.mcpDraft && o.machineId) defs.push(...mcpDraftTools(sessionId, o.machineId, o.mcpDraft));
  return defs;
}

const folderDescription =
  'folder of the project: a path relative to the default folder of the machine (e.g. personal-os) or an absolute path on the machine of this session ' +
  'inside that default folder; new sessions of the project start there on every machine; null or empty — no folder';

function projectToolDefs(sessionId: string, call: (payload: Parameters<PeersClient['request']>[0]) => Promise<ToolResult>): PeerToolDef[] {
  const createShape = {
    name: z.string().min(1).max(120).describe('project name, unique among active projects'),
    description: z.string().max(2000).optional().describe('what the project is about; helps the hub put sessions into it'),
    remote: z.string().max(2000).nullable().optional().describe('git remote of the project repository'),
    folder: z.string().max(4096).nullable().optional().describe(folderDescription),
    linkSession: z.boolean().optional().describe('also move this session into the project'),
  };
  const updateShape = {
    id: z.guid().describe('project id from projects_list'),
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(2000).optional(),
    remote: z.string().max(2000).nullable().optional(),
    folder: z.string().max(4096).nullable().optional().describe(folderDescription),
    linkSession: z.boolean().optional().describe('also move this session into the project'),
  };
  const pick = (a: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter(k => a[k] !== undefined).map(k => [k, a[k]]));
  return [
    {
      name: PEERS_TOOLS.projects,
      description:
        "List the projects of the owner's Agent Hub catalogue: id, name, description, git remote, folder relative to the machine's default folder, " +
        'and dir — the folder where a new session of the project starts on the machine of this session.',
      shape: {},
      readOnly: true,
      run: () => call({ op: 'projects', sessionId }),
    },
    {
      name: PEERS_TOOLS.projectCreate,
      description:
        "Create a project in the owner's Agent Hub catalogue. Set folder to the project's repository so that new sessions of the project start there. " +
        'A name already taken is a conflict error: find the project with projects_list and change it with project_update.',
      shape: createShape,
      readOnly: false,
      run: a => call({ op: 'project_create', sessionId, name: String(a.name), ...pick(a, ['description', 'remote', 'folder', 'linkSession']) }),
    },
    {
      name: PEERS_TOOLS.projectUpdate,
      description: "Change the name, description, git remote or folder of a project of the owner's Agent Hub catalogue; fields not given stay as they are.",
      shape: updateShape,
      readOnly: false,
      run: a => call({ op: 'project_update', sessionId, id: String(a.id), ...pick(a, ['name', 'description', 'remote', 'folder', 'linkSession']) }),
    },
  ];
}

/** The tool definitions of one session for the SDK (exported for the tests; createPeersServer wraps them). */
export function peersTools(sessionId: string, client: Pick<PeersClient, 'request'>, o: PeerToolOptions = {}) {
  return peersToolDefs(sessionId, client, o).map(d => tool(d.name, d.description, d.shape, a => d.run(a as Record<string, unknown>), d.readOnly ? { annotations: { readOnlyHint: true } } : undefined));
}

/**
 * Validates the arguments of a client tool call against its schema (Codex sends what the model wrote): an invalid call
 * is an error result, as the SDK server answers it.
 */
export async function runPeerTool(defs: PeerToolDef[], name: string, args: unknown): Promise<ToolResult> {
  const d = defs.find(x => x.name === name);
  if (!d) return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true };
  const parsed = z.object(d.shape).safeParse(args ?? {});
  if (!parsed.success) return { content: [{ type: 'text', text: `invalid arguments: ${z.prettifyError(parsed.error)}` }], isError: true };
  return d.run(parsed.data as Record<string, unknown>);
}

export function createPeersServer(sessionId: string, client: Pick<PeersClient, 'request'>, o: PeerToolOptions = {}): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name: PEERS_SERVER_NAME, version: '1.0.0', tools: peersTools(sessionId, client, o) });
}
