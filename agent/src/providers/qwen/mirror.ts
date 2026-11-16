// The mirror transcript of a Qwen session (change qwen-provider, design D3): the writer of the Codex mirror with the
// folder agent-hub-qwen, plus the translation of Qwen SDK messages. The SDK speaks the Claude Code message shape
// (assistant with tool_use, user with tool_result), so blocks are written almost as they are; only the names and
// parameters of Qwen's built-in tools are mapped to the names the hub's views know (Bash, Read, Write, Edit, ...).
import { readLines, stableUuid, type MirrorKind, type MirrorWriter } from '../codex/mirror.js';
import type { QwenContentBlock, QwenMessage } from './sdk.js';

export const QWEN_MIRROR_DIR = 'agent-hub-qwen';
export const QWEN_MIRROR: MirrorKind = { dir: QWEN_MIRROR_DIR, entrypoint: 'agent-hub-qwen', provider: 'qwen', label: 'Qwen' };

type Input = Record<string, unknown>;

function pick(input: Input, ...keys: string[]): unknown {
  for (const k of keys) if (input[k] !== undefined && input[k] !== null) return input[k];
  return undefined;
}

function rest(input: Input, ...used: string[]): Input {
  const out: Input = {};
  for (const [k, v] of Object.entries(input)) if (!used.includes(k)) out[k] = v;
  return out;
}

function todoStatus(s: unknown): string {
  const v = String(s ?? 'pending');
  return v === 'completed' ? 'completed' : v === 'in_progress' || v === 'inProgress' ? 'in_progress' : 'pending';
}

/**
 * Design D3: a Qwen tool call → the name and input of the matching Claude tool. Tolerant to parameter variants: what is
 * not recognised stays under its own name, an unknown tool keeps its name and input.
 */
export function normalizeTool(name: string, raw: unknown): { name: string; input: Input } {
  const input: Input = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Input) : {};
  switch (name) {
    case 'run_shell_command':
    case 'shell':
      return { name: 'Bash', input: { command: String(pick(input, 'command', 'cmd') ?? ''), ...rest(input, 'command', 'cmd') } };
    case 'read_file':
    case 'read_many_files':
      return { name: 'Read', input: { file_path: String(pick(input, 'file_path', 'absolute_path', 'path') ?? ''), ...rest(input, 'file_path', 'absolute_path', 'path') } };
    case 'write_file':
      return {
        name: 'Write',
        input: { file_path: String(pick(input, 'file_path', 'absolute_path', 'path') ?? ''), content: String(input.content ?? ''), ...rest(input, 'file_path', 'absolute_path', 'path', 'content') },
      };
    case 'edit':
    case 'replace':
      return {
        name: 'Edit',
        input: {
          file_path: String(pick(input, 'file_path', 'absolute_path', 'path') ?? ''),
          old_string: String(input.old_string ?? ''),
          new_string: String(input.new_string ?? ''),
          ...rest(input, 'file_path', 'absolute_path', 'path', 'old_string', 'new_string'),
        },
      };
    case 'grep_search':
    case 'search_file_content':
      return { name: 'Grep', input: { pattern: String(input.pattern ?? ''), ...rest(input, 'pattern') } };
    case 'glob':
      return { name: 'Glob', input: { pattern: String(input.pattern ?? ''), ...rest(input, 'pattern') } };
    case 'list_directory':
      return { name: 'LS', input: { path: String(pick(input, 'path', 'dir_path') ?? ''), ...rest(input, 'path', 'dir_path') } };
    case 'web_fetch':
      return { name: 'WebFetch', input };
    case 'web_search':
      return { name: 'WebSearch', input };
    case 'todo_write': {
      const todos = Array.isArray(input.todos) ? (input.todos as Array<{ content?: unknown; status?: unknown }>) : [];
      return { name: 'TodoWrite', input: { todos: todos.map(t => ({ content: String(t.content ?? ''), status: todoStatus(t.status), activeForm: String(t.content ?? '') })) } };
    }
    default:
      return { name, input };
  }
}

/** The text of a tool_result content (a string or blocks). */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content === undefined || content === null ? '' : JSON.stringify(content);
  return content
    .map(c =>
      typeof c === 'string' ? c : (c as { type?: string; text?: string }).type === 'text' ? String((c as { text?: string }).text ?? '') : `[${String((c as { type?: string }).type ?? 'block')}]`,
    )
    .join('\n');
}

/**
 * One message of the SDK stream → lines of the mirror. Returns the text of an assistant message (the provider keeps the
 * last one as the result of the turn). User messages of the stream carry tool results only: the user's own text is
 * written by the provider before the turn. Messages of sub-agents (parent_tool_use_id) are not mirrored.
 */
export function mirrorMessage(w: MirrorWriter, msg: QwenMessage, model: string | null, seq: () => number): { text: string } | null {
  if (msg.parent_tool_use_id) return null;
  const content = msg.message?.content;
  if (msg.type === 'assistant') {
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    const out: QwenContentBlock[] = [];
    let text = '';
    for (const b of blocks) {
      if (b.type === 'text') {
        const t = String(b.text ?? '');
        if (!t.trim()) continue;
        text += (text ? '\n' : '') + t;
        out.push({ type: 'text', text: t });
      } else if (b.type === 'thinking') {
        const t = String(b.thinking ?? '');
        if (t.trim()) out.push({ type: 'thinking', thinking: t, signature: '' });
      } else if (b.type === 'tool_use') {
        const n = normalizeTool(String(b.name ?? ''), b.input);
        out.push({ type: 'tool_use', id: String(b.id ?? stableUuid(w.sessionId, 'tool', String(seq()))), name: n.name, input: n.input });
      }
    }
    if (!out.length) return null;
    // one message can arrive in pieces: the uuid of the SDK (or a counter) keeps every piece a line of its own
    const id = msg.uuid ?? `${msg.message?.id ?? 'msg'}-${seq()}`;
    w.assistant(id, out, msg.message?.model ?? model);
    return { text };
  }
  if (msg.type === 'user' && Array.isArray(content)) {
    for (const b of content) {
      if (b.type !== 'tool_result') continue;
      w.toolResult(String(b.tool_use_id ?? ''), resultText(b.content), b.is_error === true);
    }
  }
  return null;
}

/** What a resume of a mirror does with the SDK (design D4). */
export interface QwenResumePlan {
  /** The SDK session to resume. */
  resume: string;
  /** Fork the chat of `resume` into the hub's session id (a forked mirror whose chat is not made yet). */
  fork: boolean;
  cwd: string;
}

/**
 * The first line of a mirror names the SDK session (`threadId`). A forked copy names the session it was forked from
 * (`forkedFrom`) and the fork of the CLI chat is made at its first resume; the line `qwen_fork_materialized` marks it done.
 */
export async function readResumePlan(projectsDir: string, sessionId: string): Promise<QwenResumePlan | null> {
  let lines: Array<Record<string, unknown>>;
  try {
    lines = await readLines(projectsDir, sessionId, QWEN_MIRROR_DIR);
  } catch {
    return null;
  }
  const header = lines.find(l => l.type === 'system' && l.subtype === 'agent_provider' && typeof l.threadId === 'string');
  if (!header) return null;
  const cwd = typeof header.cwd === 'string' ? header.cwd : '';
  const forkedFrom = typeof header.forkedFrom === 'string' ? header.forkedFrom : null;
  const done = lines.some(l => l.type === 'system' && l.subtype === 'qwen_fork_materialized');
  if (forkedFrom && !done) return { resume: forkedFrom, fork: true, cwd };
  return { resume: header.threadId as string, fork: false, cwd };
}
