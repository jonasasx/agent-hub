// Facts about subagents in transcript lines (change `subagents`, design S2): a pure function over the lines of one
// chunk as they came from the machine — before big fields (toolUseResult) are moved to S3, and including lines the hub
// does not store (hook attachments, queue-operation). The registry (repo.ts) applies them.
// Requirement (subagents): Реестр субагентов сессии; Статус субагента.
import { createHash } from 'node:crypto';

/** The file the lines come from: the session's main transcript or `subagents/agent-<agentId>.jsonl`. */
export interface FileCtx {
  kind: 'main' | 'subagent';
  /** agentId of a subagent file (without `agent-`); null for the main file. */
  agentIdOfFile: string | null;
}

export type EndState = 'completed' | 'failed' | 'stopped';

export type Fact =
  /** 1. a call of Agent/Task */
  | {
      t: 'call';
      toolUseId: string;
      parentAgentId: string | null;
      description: string | null;
      agentType: string;
      name: string | null;
      teamName: string | null;
      kind: 'subagent' | 'teammate';
      background: boolean;
      promptSha: Buffer | null;
      ts: Date | null;
    }
  /** 2. the result of a call: the agent, how it ended or that it runs in the background */
  | {
      t: 'result';
      toolUseId: string;
      agentId: string | null;
      state: 'completed' | 'failed' | null;
      kind: 'teammate' | 'skill' | null;
      agentType: string | null;
      model: string | null;
      name: string | null;
      teamName: string | null;
      durationMs: number | null;
      totalTokens: number | null;
      toolUses: number | null;
      /** «Async agent launched»: the call runs in the background */
      background: boolean;
      ts: Date | null;
    }
  /** 3. <task-notification> of a task (a subagent or a background command — the registry ignores unknown ones) */
  | { t: 'notify'; agentId: string | null; toolUseId: string | null; state: EndState; ts: Date | null }
  /** 4. SendMessage resumed a subagent */
  | { t: 'resume'; agentId: string; ts: Date | null }
  /** 5. the first line of a subagent file */
  | { t: 'file'; agentId: string; promptSha: Buffer | null; description: string | null; teammate: { name: string | null } | null; ts: Date | null }
  /** 6. a line of a subagent file (stored lines and hooks) */
  | { t: 'activity'; agentId: string; ts: Date | null; resumes: boolean }
  /** 7. SubagentStop / TeammateIdle hook in a subagent file */
  | { t: 'hook'; agentId: string; state: 'completed' | 'idle'; ts: Date | null }
  /** 8. a background command started (Bash/PowerShell run_in_background) or a monitor (Monitor): its tool result names the task */
  | { t: 'bgstart'; toolUseId: string; taskId: string; kind: BgKind; timeoutMs: number | null; persistent: boolean; ts: Date | null }
  /** 9. the call of a background command or a monitor (change `background-tasks` D2): its metadata, a `pending` row */
  | { t: 'bgcall'; toolUseId: string; kind: BgKind; description: string | null; command: string | null; ts: Date | null }
  /** 10. TaskStop stopped a task (D4) */
  | { t: 'bgstop'; taskId: string; ts: Date | null }
  /** 11. an event of a monitor (D3): a <task-notification> without a status */
  | { t: 'bgevent'; taskId: string; text: string; ts: Date | null }
  /** 12. the monitor's own notice of its timeout («[Monitor expired after 3m …]», QA 2026-10-29) */
  | { t: 'bgexpire'; taskId: string; ts: Date | null };

export type BgKind = 'bash' | 'monitor';
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
/** Stored length of a command and of a monitor event. */
export const BG_COMMAND_MAX = 2000;
export const BG_EVENT_MAX = 500;

const AGENT_TOOLS = new Set(['Agent', 'Task']);
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest();
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const tsOf = (o: Record<string, unknown>): Date | null => {
  const t = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
  return Number.isNaN(t) ? null : new Date(t);
};

/** The text of a message content: a string, or the text blocks of an array. */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Array<{ type?: string; text?: unknown }>).map(b => (b?.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('');
}

/** sha256 of the task text: `prompt` of the call = the first message of the subagent's transcript (byte for byte). */
export function promptSha(prompt: string | null): Buffer | null {
  return prompt ? sha(prompt) : null;
}

/** «Command running in background with ID: <id>.» — the tool result of a run_in_background command. */
const BG_STARTED = /^Command running in background with ID: ([\w-]+)/;

const NOTIFY = /<task-notification>([\s\S]*?)<\/task-notification>/g;
const tag = (body: string, name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(body)?.[1]?.trim() ?? null;

/** «Monitor started (task <id>, expires in …)» — the tool result of a Monitor call (when toolUseResult is not there). */
const MONITOR_STARTED = /^Monitor started \(task ([\w-]+)/;

/** The event Claude Code sends when a monitor times out: the end of the monitor, not an event of its command. */
const MONITOR_EXPIRED = /^\[Monitor expired after /;

/**
 * Events of monitors in a text: <task-notification> without a status whose summary is «Monitor event: …»;
 * `expired` — the notice of the timeout.
 */
export function monitorEvents(text: string): Array<{ taskId: string; text: string; expired: boolean }> {
  if (!text.includes('<task-notification>')) return [];
  const out: Array<{ taskId: string; text: string; expired: boolean }> = [];
  for (const m of text.matchAll(NOTIFY)) {
    const body = m[1]!;
    if (tag(body, 'status') !== null || !/<summary>Monitor event/.test(body)) continue;
    const taskId = tag(body, 'task-id');
    const ev = /<event>([\s\S]*?)<\/event>/.exec(body)?.[1]?.trim() ?? '';
    if (taskId) out.push({ taskId, text: ev.slice(0, BG_EVENT_MAX), expired: MONITOR_EXPIRED.test(ev) });
  }
  return out;
}

/** <task-notification> blocks of a text: task id, call id and the end state (killed/stopped → stopped). */
export function notifications(text: string): Array<{ taskId: string | null; toolUseId: string | null; state: EndState }> {
  if (!text.includes('<task-notification>')) return [];
  const out: Array<{ taskId: string | null; toolUseId: string | null; state: EndState }> = [];
  for (const m of text.matchAll(NOTIFY)) {
    const body = m[1]!;
    const status = tag(body, 'status');
    const state: EndState | null = status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : status === 'killed' || status === 'stopped' ? 'stopped' : null;
    if (!state) continue;
    out.push({ taskId: tag(body, 'task-id'), toolUseId: tag(body, 'tool-use-id'), state });
  }
  return out;
}

/** `<teammate-message teammate_id="…" summary="…">` at the start of a text. */
function teammateHeader(text: string): { summary: string | null } | null {
  const m = /^<teammate-message\b([^>]*)>/.exec(text.trimStart());
  if (!m) return null;
  return { summary: /\bsummary="([^"]*)"/.exec(m[1]!)?.[1] ?? null };
}

const eventFact = (e: { taskId: string; text: string; expired: boolean }, ts: Date | null): Fact =>
  e.expired ? { t: 'bgexpire', taskId: e.taskId, ts } : { t: 'bgevent', taskId: e.taskId, text: e.text, ts };

/** The name of a teammate from its agentId `a<name>-<16 hex>` (`adevops-x1-8db2d007e785553a` → `devops-x1`). */
export function teammateName(agentId: string): string | null {
  return /^a(.+)-[0-9a-f]{16}$/.exec(agentId)?.[1] ?? null;
}

/**
 * The facts of the lines of one chunk, in their order. `ctx` says which file they are from: calls inside a subagent's
 * transcript are nested (parent = that subagent).
 */
export function scanLines(ctx: FileCtx, lines: Array<{ lineNo: number; obj: Record<string, unknown> | null }>): Fact[] {
  const facts: Fact[] = [];
  const parent = ctx.kind === 'subagent' ? ctx.agentIdOfFile : null;
  for (const { lineNo, obj } of lines) {
    if (!obj) continue;
    const ts = tsOf(obj);
    const type = obj.type;
    const message = obj.message as { content?: unknown } | undefined;
    const content = message?.content;

    if (ctx.kind === 'subagent' && ctx.agentIdOfFile) {
      const agentId = ctx.agentIdOfFile;
      // 5. the first line: the task, or the teammate's first message
      if (lineNo === 0 && type === 'user') {
        const text = contentText(content);
        const tm = teammateHeader(text);
        facts.push({
          t: 'file',
          agentId,
          promptSha: text ? sha(text) : null,
          description: tm ? tm.summary : text ? text.slice(0, 80) : null,
          teammate: tm ? { name: teammateName(agentId) } : null,
          ts,
        });
      }
      // 7. hooks (not stored by the hub, seen here)
      const att = obj.attachment as { type?: string; hookEvent?: string } | undefined;
      if (type === 'attachment' && att?.type === 'hook_success' && (att.hookEvent === 'SubagentStop' || att.hookEvent === 'TeammateIdle')) {
        facts.push({ t: 'hook', agentId, state: att.hookEvent === 'SubagentStop' ? 'completed' : 'idle', ts });
      } else if (type === 'assistant' || type === 'user' || (type === 'attachment' && att?.type === 'queued_command')) {
        // 6. activity; a new message or answer after an end or an idle means it works again (not a hook)
        facts.push({ t: 'activity', agentId, ts, resumes: type === 'assistant' || type === 'user' });
      }
    }

    // 1. calls
    if (type === 'assistant' && Array.isArray(content)) {
      for (const b of content as Array<{ type?: string; id?: string; name?: string; input?: Record<string, unknown> }>) {
        if (b?.type !== 'tool_use' || !b.id || !b.name) continue;
        // 9. a monitor or a background command: its metadata, before the result names the task
        const bgKind: BgKind | null = b.name === 'Monitor' ? 'monitor' : SHELL_TOOLS.has(b.name) && b.input?.run_in_background === true ? 'bash' : null;
        if (bgKind) {
          const command = str(b.input?.command);
          facts.push({ t: 'bgcall', toolUseId: b.id, kind: bgKind, description: str(b.input?.description), command: command ? command.slice(0, BG_COMMAND_MAX) : null, ts });
          continue;
        }
        if (!AGENT_TOOLS.has(b.name)) continue;
        const input = b.input ?? {};
        const teamName = str(input.team_name);
        facts.push({
          t: 'call',
          toolUseId: b.id,
          parentAgentId: parent,
          description: str(input.description),
          agentType: str(input.subagent_type) ?? 'general-purpose',
          name: str(input.name),
          teamName,
          kind: teamName ? 'teammate' : 'subagent',
          background: input.run_in_background === true,
          promptSha: promptSha(str(input.prompt)),
          ts,
        });
      }
    }

    if (type === 'user') {
      const tur = obj.toolUseResult;
      const r = tur && typeof tur === 'object' && !Array.isArray(tur) ? (tur as Record<string, unknown>) : null;
      // 4. SendMessage resumed a subagent
      const resumed = str(r?.resumedAgentId);
      if (resumed) facts.push({ t: 'resume', agentId: resumed, ts });
      // 10. TaskStop: `{message, task_id, task_type, command}` — a monitor or a background command
      const stopped = str(r?.task_id);
      if (stopped && typeof r?.task_type === 'string') facts.push({ t: 'bgstop', taskId: stopped, ts });
      // 2. results of calls
      if (Array.isArray(content)) {
        for (const b of content as Array<{ type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown }>) {
          if (b?.type !== 'tool_result' || !b.tool_use_id) continue;
          const text = contentText(b.content);
          // 8. a background command: it ends with a <task-notification> carrying this tool_use_id
          const bg = b.is_error ? null : BG_STARTED.exec(text.trimStart());
          if (bg) {
            facts.push({ t: 'bgstart', toolUseId: b.tool_use_id, taskId: bg[1]!, kind: 'bash', timeoutMs: null, persistent: false, ts });
            continue;
          }
          // a monitor: toolUseResult {taskId, timeoutMs, persistent}, or the text when the result was not kept
          const mon = b.is_error ? null : ((r && typeof r.persistent === 'boolean' ? str(r.taskId) : null) ?? MONITOR_STARTED.exec(text.trimStart())?.[1] ?? null);
          if (mon) {
            facts.push({ t: 'bgstart', toolUseId: b.tool_use_id, taskId: mon, kind: 'monitor', timeoutMs: num(r?.timeoutMs), persistent: r?.persistent === true, ts });
            continue;
          }
          const status = str(r?.status);
          const agentId = str(r?.agentId) ?? str(r?.agent_id) ?? /\bagentId: ([\w-]+)/.exec(text)?.[1] ?? null;
          const agentLike = !!agentId || (status !== null && ['completed', 'async_launched', 'teammate_spawned', 'forked'].includes(status));
          if (!agentLike && !b.is_error) continue;
          facts.push({
            t: 'result',
            toolUseId: b.tool_use_id,
            agentId,
            state: b.is_error ? 'failed' : status === 'completed' ? 'completed' : null,
            kind: status === 'teammate_spawned' ? 'teammate' : status === 'forked' ? 'skill' : null,
            agentType: str(r?.agentType) ?? str(r?.agent_type) ?? str(r?.commandName),
            model: str(r?.resolvedModel) ?? str(r?.model),
            name: status === 'teammate_spawned' ? str(r?.name) : null,
            teamName: str(r?.team_name),
            durationMs: num(r?.totalDurationMs),
            totalTokens: num(r?.totalTokens),
            toolUses: num(r?.totalToolUseCount),
            background: status === 'async_launched' || /^Async agent launched/.test(text.trimStart()),
            ts,
          });
        }
      }
      // 3. notifications as a user line
      for (const n of notifications(contentText(content))) facts.push({ t: 'notify', agentId: n.taskId, toolUseId: n.toolUseId, state: n.state, ts });
      for (const e of monitorEvents(contentText(content))) facts.push(eventFact(e, ts));
    }
    // 11. a monitor event delivered mid-turn (attachment queued_command)
    if (type === 'attachment') {
      const a = obj.attachment as { type?: unknown; prompt?: unknown } | undefined;
      if (a?.type === 'queued_command' && typeof a.prompt === 'string') for (const e of monitorEvents(a.prompt)) facts.push(eventFact(e, ts));
    }
    // 3. notifications in the queue (a queued message is written there before it reaches the conversation)
    if (type === 'queue-operation' && obj.operation === 'enqueue' && typeof obj.content === 'string') {
      for (const n of notifications(obj.content)) facts.push({ t: 'notify', agentId: n.taskId, toolUseId: n.toolUseId, state: n.state, ts });
      for (const e of monitorEvents(obj.content)) facts.push(eventFact(e, ts));
    }
  }
  return facts;
}
