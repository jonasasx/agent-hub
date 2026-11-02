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
  const text = e ? `${e.code}: ${e.message}${e.retryAfterSec !== undefined ? ` (повторить через ${e.retryAfterSec} с)` : ''}` : `error: ${err instanceof Error ? err.message : String(err)}`;
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

/** The tools of one session with this session as the caller (the closure's `sessionId`); `spawn` — the hub is ≥1.12. */
export function peersToolDefs(sessionId: string, client: Pick<PeersClient, 'request'>, o: { spawn?: boolean; mcpDraft?: Pick<McpDraftClient, 'request'>; machineId?: string } = {}): PeerToolDef[] {
  const call = async (payload: Parameters<PeersClient['request']>[0]): Promise<ToolResult> => {
    try {
      return ok(await client.request(payload));
    } catch (err) {
      return fail(err);
    }
  };
  const listShape = {
    machine: z.string().max(200).optional().describe('часть имени машины, например X1'),
    project: z.string().max(1000).optional().describe('часть каталога проекта'),
    status: z.enum(PEER_SESSION_STATUSES).optional(),
    limit: z.number().int().min(1).max(PEER_LIST_MAX).optional().describe('по умолчанию 50'),
  };
  const getShape = { session: z.guid().describe('id сессии из sessions_list') };
  const sendShape = {
    to: z.guid().describe('id сессии-адресата из sessions_list'),
    text: z.string().min(1).max(PEER_TEXT_MAX),
    inReplyTo: z.guid().optional().describe('id peer-сообщения, на которое вы отвечаете (атрибут id тега)'),
  };
  const spawnShape = {
    task: z.string().min(1).max(PEER_TEXT_MAX).describe('задание субагенту: что сделать и что вернуть в итоге'),
    provider: z.enum(PROVIDERS).optional().describe('вендор: claude или codex; по умолчанию — как у этой сессии'),
    machine: z.string().max(200).optional().describe('имя машины (X1, HP, VM…); по умолчанию — эта машина'),
    cwd: z.string().max(1000).optional().describe('каталог; обязателен на другой машине, по умолчанию — каталог этой сессии'),
    model: z.string().max(200).optional().describe('модель; по умолчанию — как у этой сессии при том же вендоре, иначе модель по умолчанию'),
    title: z.string().max(200).optional().describe('заголовок вкладки; по умолчанию — из задания'),
  };
  const defs: PeerToolDef[] = [
    {
      name: PEERS_TOOLS.list,
      description:
        'Список сессий Agent Hub этого владельца на всех машинах (X1, HP, ВМ): id, заголовок, машина, каталог, статус (working, waiting, permission, sleeping, closed), живой ли процесс, время последней активности; своя сессия помечена self. Фильтры — по машине, подстроке каталога проекта, статусу.',
      shape: listShape,
      readOnly: true,
      run: a => call({ op: 'list', ...(a as z.infer<z.ZodObject<typeof listShape>>), sessionId }),
    },
    {
      name: PEERS_TOOLS.get,
      description: 'Подробности одной сессии Agent Hub по id из sessions_list: статус, машина, каталог, число работающих субагентов и фоновых задач.',
      shape: getShape,
      readOnly: true,
      run: a => call({ op: 'get', sessionId, target: String(a.session) }),
    },
    {
      name: PEERS_TOOLS.send,
      description: `Написать другой сессии Agent Hub, в том числе на другой машине: замена SendMessage для связи между сессиями. Сообщение придёт адресату очередным ходом с пометкой, от кого оно; спящая сессия проснётся, занятая получит его после текущего хода. Ответа в этом вызове нет: адресат отвечает отдельным сообщением, а оно приходит вам ходом пользователя с тегом peer-message. Результат: delivered, queued или resumed. Текст до ${PEER_TEXT_MAX} символов; частота ограничена.`,
      shape: sendShape,
      readOnly: false,
      run: a => call({ op: 'send', sessionId, to: String(a.to), text: String(a.text), ...(typeof a.inReplyTo === 'string' ? { inReplyTo: a.inReplyTo } : {}) }),
    },
  ];
  // hub-subagents D1: a child hub session, the result of its turn comes back as <peer-message kind="report">
  if (o.spawn)
    defs.push({
      name: PEERS_TOOLS.spawn,
      description: `Запустить субагента — новую сессию Agent Hub, в том числе другого вендора (claude, codex) или на другой машине. Задание придёт ей первым ходом. Вызов возвращается сразу: id, заголовок, машина, вендор, каталог, модель; итог хода субагента хаб пришлёт вам сам сообщением <peer-message kind="report">, ждать и опрашивать его не нужно. Продолжить работу с субагентом — session_send на его id. Не больше 10 работающих субагентов; частота ограничена, как у session_send.`,
      shape: spawnShape,
      readOnly: false,
      run: a => {
        const v = a as z.infer<z.ZodObject<typeof spawnShape>>;
        const opt = Object.fromEntries(Object.entries({ provider: v.provider, machine: v.machine, cwd: v.cwd, model: v.model, title: v.title }).filter(([, x]) => x !== undefined));
        return call({ op: 'spawn', sessionId, task: v.task, ...opt });
      },
    });
  if (o.mcpDraft && o.machineId) defs.push(...mcpDraftTools(sessionId, o.machineId, o.mcpDraft));
  return defs;
}

/** The tool definitions of one session for the SDK (exported for the tests; createPeersServer wraps them). */
export function peersTools(sessionId: string, client: Pick<PeersClient, 'request'>, o: { spawn?: boolean; mcpDraft?: Pick<McpDraftClient, 'request'>; machineId?: string } = {}) {
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

export function createPeersServer(
  sessionId: string,
  client: Pick<PeersClient, 'request'>,
  o: { spawn?: boolean; mcpDraft?: Pick<McpDraftClient, 'request'>; machineId?: string } = {},
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name: PEERS_SERVER_NAME, version: '1.0.0', tools: peersTools(sessionId, client, o) });
}
