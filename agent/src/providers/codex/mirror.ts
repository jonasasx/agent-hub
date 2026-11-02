// The mirror transcript of a Codex session (change agent-providers, design D4): lines of the hub's canonical format (the
// .jsonl lines of Claude Code) in ~/.claude/projects/agent-hub-codex/<sessionId>.jsonl. The replication, the store,
// the search, handoff and the web read it like any Claude transcript. The first line names the Codex thread.
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The project folder of the mirrors under ~/.claude/projects: `claude --resume` of a project never lists them. */
export const CODEX_MIRROR_DIR = 'agent-hub-codex';
export const CODEX_ENTRYPOINT = 'agent-hub-codex';

export function mirrorPath(projectsDir: string, sessionId: string): string {
  return join(projectsDir, CODEX_MIRROR_DIR, `${sessionId}.jsonl`);
}

/** A stable UUID of a line: the same item written again gives the same uuid (design D4). */
export function stableUuid(...parts: string[]): string {
  const h = createHash('sha256').update(parts.join('\u0000')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface MirrorHeader {
  threadId: string;
  cwd: string;
}

/** The Codex thread of a mirror (its first line); null when there is no mirror or no header. */
export async function readHeader(projectsDir: string, sessionId: string): Promise<MirrorHeader | null> {
  let text: string;
  try {
    text = await readFile(mirrorPath(projectsDir, sessionId), 'utf8');
  } catch {
    return null;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as { type?: string; subtype?: string; threadId?: string; cwd?: string };
      if (o.type === 'system' && o.subtype === 'agent_provider' && typeof o.threadId === 'string') return { threadId: o.threadId, cwd: o.cwd ?? '' };
    } catch {
      // a broken line: keep looking
    }
  }
  return null;
}

/** All lines of a mirror (fork copies them). */
export async function readLines(projectsDir: string, sessionId: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(mirrorPath(projectsDir, sessionId), 'utf8');
  return text
    .split('\n')
    .filter(l => l.trim())
    .flatMap(l => {
      try {
        return [JSON.parse(l) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

type Block = Record<string, unknown>;

/** A Codex item as the app-server reports it (ThreadItem; only the fields the mirror reads). */
export interface CodexItem {
  type: string;
  id: string;
  [k: string]: unknown;
}

/** Text of an MCP result (content blocks of type text; others named). */
function mcpResultText(result: unknown, error: unknown): { text: string; isError: boolean } {
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') return { text: (error as { message: string }).message, isError: true };
  const content = (result as { content?: unknown[] } | null)?.content;
  if (!Array.isArray(content)) return { text: result === null || result === undefined ? '' : JSON.stringify(result), isError: false };
  const parts = content.map(c => {
    const b = c as { type?: string; text?: string };
    return b.type === 'text' && typeof b.text === 'string' ? b.text : `[${b.type ?? 'content'}]`;
  });
  return { text: parts.join('\n'), isError: false };
}

function kindOf(kind: unknown): string {
  const t = (kind as { type?: string } | null)?.type;
  return t === 'add' || t === 'delete' || t === 'update' ? t : 'update';
}

/**
 * Codex reports a command as the whole shell invocation (`"C:\WINDOWS\...\powershell.exe" -Command "<script>"`, also
 * `bash -lc '<script>'`, `cmd /c <script>`). Only the script is the command to a reader: the shell wrapper repeats on
 * every call. A string that is not such a wrapper (or whose quoting cannot be read) is returned as it is.
 */
export function unwrapShell(command: string): string {
  const c = command.trim();
  const body = (rest: string): string | null => {
    const r = rest.trim();
    if (r.length >= 2 && (r[0] === '"' || r[0] === "'") && r.endsWith(r[0]!)) {
      const inner = r.slice(1, -1);
      return r[0] === '"' ? inner.replace(/\\"/g, '"') : inner.replace(/'\\''/g, "'");
    }
    return r.includes('"') || r.includes("'") ? null : r;
  };
  const ps = /^(?:"[^"]*[\\/](?:powershell|pwsh)(?:\.exe)?"|(?:[^\s"]*[\\/])?(?:powershell|pwsh)(?:\.exe)?)\s+(?:-(?!command\b)\w+(?:\s+\w+)?\s+)*-Command\s+([\s\S]+)$/i.exec(c);
  const sh = /^"?(?:[^"\s]*[\\/])?(?:bash|sh|zsh)(?:\.exe)?"?\s+-l?c\s+([\s\S]+)$/i.exec(c);
  const cmd = /^"?(?:[^"\s]*[\\/])?cmd(?:\.exe)?"?\s+\/[cC]\s+([\s\S]+)$/i.exec(c);
  const m = ps ?? sh ?? cmd;
  return (m && body(m[1]!)) || command;
}

/** The tool call of an item: name, input and its result. null — the item is not a tool call. */
export function toolOf(item: CodexItem): { name: string; input: Record<string, unknown>; result: string; isError: boolean } | null {
  switch (item.type) {
    case 'commandExecution': {
      const out = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '';
      const code = typeof item.exitCode === 'number' ? item.exitCode : null;
      const status = String(item.status ?? '');
      const tail = code !== null && code !== 0 ? `\n[exit code ${code}]` : status === 'declined' ? '[отклонено]' : '';
      return {
        name: 'Bash',
        input: { command: unwrapShell(String(item.command ?? '')), cwd: String(item.cwd ?? '') },
        result: (out + tail).trim(),
        isError: (code !== null && code !== 0) || status === 'failed' || status === 'declined',
      };
    }
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? (item.changes as Array<{ path?: unknown; kind?: unknown; diff?: unknown }>) : [];
      const status = String(item.status ?? '');
      return {
        name: 'ApplyPatch',
        input: { changes: changes.map(c => ({ path: String(c.path ?? ''), kind: kindOf(c.kind), diff: String(c.diff ?? '') })) },
        result: status === 'completed' ? `Изменено файлов: ${changes.length}` : status === 'declined' ? 'Правка отклонена' : `Правка не применена (${status || 'неизвестно'})`,
        isError: status !== 'completed',
      };
    }
    case 'mcpToolCall': {
      const r = mcpResultText(item.result, item.error);
      return { name: `mcp__${String(item.server)}__${String(item.tool)}`, input: (item.arguments ?? {}) as Record<string, unknown>, result: r.text, isError: r.isError || item.status === 'failed' };
    }
    case 'dynamicToolCall': {
      const items = Array.isArray(item.contentItems) ? (item.contentItems as Array<{ type?: string; text?: string }>) : [];
      const ns = typeof item.namespace === 'string' && item.namespace ? item.namespace : 'agent-hub';
      return {
        name: `mcp__${ns}__${String(item.tool)}`,
        input: (item.arguments ?? {}) as Record<string, unknown>,
        result: items.map(c => (c.type === 'inputText' ? (c.text ?? '') : `[${c.type}]`)).join('\n'),
        isError: item.success === false,
      };
    }
    case 'webSearch': {
      const q = typeof item.query === 'string' ? item.query : JSON.stringify((item as { action?: unknown }).action ?? '');
      return { name: 'WebSearch', input: { query: q }, result: 'Поиск выполнен', isError: false };
    }
    case 'imageView':
      return { name: 'Read', input: { file_path: String(item.path ?? '') }, result: String(item.path ?? ''), isError: false };
    default:
      return null;
  }
}

/** One line of the plan (turn/plan/updated): Codex statuses → TodoWrite statuses. */
export function todosOf(plan: Array<{ step?: unknown; status?: unknown }>): Array<{ content: string; status: string; activeForm: string }> {
  return plan.map(p => {
    const s = String(p.status ?? 'pending');
    const status = s === 'completed' ? 'completed' : s === 'inProgress' || s === 'in_progress' ? 'in_progress' : 'pending';
    return { content: String(p.step ?? ''), status, activeForm: String(p.step ?? '') };
  });
}

/** Writes the mirror of one session; lines are appended in order (one write at a time). */
export class MirrorWriter {
  private parent: string | null = null;
  private chain: Promise<void> = Promise.resolve();
  readonly path: string;

  constructor(
    projectsDir: string,
    readonly sessionId: string,
    private cwd: string,
    private readonly now: () => number = Date.now,
    /** A failed write (disk full, folder removed): logged by the provider; the next lines are still tried. */
    private readonly onError: (err: Error) => void = () => undefined,
  ) {
    this.path = mirrorPath(projectsDir, sessionId);
    this.dir = join(projectsDir, CODEX_MIRROR_DIR);
  }

  private readonly dir: string;

  /** Continues an existing mirror: the next line links to its last uuid. */
  async open(): Promise<void> {
    try {
      const text = await readFile(this.path, 'utf8');
      const last = text.trimEnd().split('\n').pop();
      if (last) this.parent = (JSON.parse(last) as { uuid?: string }).uuid ?? null;
    } catch {
      this.parent = null;
    }
  }

  /** Waits for every queued line. */
  flush(): Promise<void> {
    return this.chain;
  }

  private base(uuid: string): Record<string, unknown> {
    return {
      parentUuid: this.parent,
      isSidechain: false,
      userType: 'external',
      entrypoint: CODEX_ENTRYPOINT,
      cwd: this.cwd,
      sessionId: this.sessionId,
      uuid,
      timestamp: new Date(this.now()).toISOString(),
    };
  }

  private write(line: Record<string, unknown>): void {
    this.parent = line.uuid as string;
    const text = JSON.stringify(line) + '\n';
    this.chain = this.chain
      .then(async () => {
        await mkdir(this.dir, { recursive: true });
        await appendFile(this.path, text, 'utf8');
      })
      .catch((err: unknown) => this.onError(err instanceof Error ? err : new Error(String(err))));
  }

  header(threadId: string, model: string | null): void {
    this.write({ ...this.base(randomUUID()), type: 'system', subtype: 'agent_provider', provider: 'codex', threadId, model, content: `Codex · поток ${threadId}`, level: 'info', isMeta: true });
  }

  user(text: string, uuid: string, images: Array<{ mime: string; data: Buffer }> = [], origin: 'human' | 'peer' = 'human'): void {
    const content = images.length
      ? [...images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data.toString('base64') } })), ...(text.trim() ? [{ type: 'text', text }] : [])]
      : text;
    this.write({ ...this.base(uuid), type: 'user', message: { role: 'user', content }, promptSource: 'sdk', turnOrigin: origin === 'human' ? 'human' : 'sdk' });
  }

  assistant(itemId: string, blocks: Block[], model: string | null): void {
    this.write({
      ...this.base(stableUuid(this.sessionId, itemId, 'assistant')),
      type: 'assistant',
      message: { id: itemId, type: 'message', role: 'assistant', model: model ?? 'codex', content: blocks, stop_reason: null, usage: null },
    });
  }

  toolUse(itemId: string, name: string, input: Record<string, unknown>, model: string | null): void {
    this.assistant(itemId, [{ type: 'tool_use', id: itemId, name, input }], model);
  }

  toolResult(itemId: string, text: string, isError: boolean): void {
    this.write({
      ...this.base(stableUuid(this.sessionId, itemId, 'result')),
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: itemId, content: text, ...(isError ? { is_error: true } : {}) }] },
    });
  }

  system(subtype: string, text: string, key?: string): void {
    this.write({ ...this.base(key ? stableUuid(this.sessionId, key, subtype) : randomUUID()), type: 'system', subtype, content: text, level: subtype === 'api_error' ? 'error' : 'info' });
  }

  /** A completed Codex item → its lines. Returns false for an item that is not written (user messages, deltas). */
  item(item: CodexItem, model: string | null): boolean {
    if (item.type === 'agentMessage') {
      const text = typeof item.text === 'string' ? item.text : '';
      if (!text.trim()) return false;
      this.assistant(item.id, [{ type: 'text', text }], model);
      return true;
    }
    if (item.type === 'reasoning') {
      const summary = Array.isArray(item.summary) ? (item.summary as string[]).join('\n\n') : '';
      const content = Array.isArray(item.content) ? (item.content as string[]).join('\n\n') : '';
      const thinking = summary || content;
      if (!thinking.trim()) return false;
      this.assistant(item.id, [{ type: 'thinking', thinking, signature: '' }], model);
      return true;
    }
    if (item.type === 'userMessage' || item.type === 'hookPrompt') return false;
    const tool = toolOf(item);
    if (tool) {
      this.toolUse(item.id, tool.name, tool.input, model);
      this.toolResult(item.id, tool.result, tool.isError);
      return true;
    }
    if (item.type === 'contextCompaction') {
      this.system('compact_boundary', 'Контекст сжат', item.id);
      return true;
    }
    this.system('codex_item', `Codex: ${item.type}`, item.id);
    return true;
  }

  plan(turnId: string, version: number, plan: Array<{ step?: unknown; status?: unknown }>, model: string | null): void {
    const id = `plan-${turnId}-${version}`;
    this.toolUse(id, 'TodoWrite', { todos: todosOf(plan) }, model);
    this.toolResult(id, 'План обновлён', false);
  }

  /** A fork (design D11): the lines of the source with this session, new uuids and the new thread. */
  copyFrom(lines: Array<Record<string, unknown>>, threadId: string): void {
    for (const l of lines) {
      const uuid = randomUUID();
      const copy: Record<string, unknown> = { ...l, sessionId: this.sessionId, uuid, parentUuid: this.parent };
      if (l.type === 'system' && l.subtype === 'agent_provider') {
        copy.threadId = threadId;
        copy.content = `Codex · поток ${threadId}`;
      }
      this.write(copy);
    }
  }

  setCwd(cwd: string): void {
    this.cwd = cwd;
  }
}
