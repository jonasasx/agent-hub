/**
 * Subagents of a session (change `subagents`, design S9): statuses in words, the tree of the list, durations and the
 * lookups that link a call in the feed to its row. Requirements (subagents): Статус субагента; Список субагентов и
 * счётчик; Переход от вызова к чату субагента.
 */
import { effectiveStatus, sessionAlive, type SessionView, type SubagentStatus, type SubagentView } from '../../api/types';

export const SUBAGENT_STATUS_LABEL: Record<SubagentStatus, string> = {
  running: 'работает',
  idle: 'ждёт сообщений',
  completed: 'завершён',
  failed: 'ошибка',
  stopped: 'остановлен',
  interrupted: 'прерван',
};

/** The status shown now: the hub's, with the session's liveness applied again (the session may have died since). */
export function subStatus(v: SubagentView, session: SessionView | undefined): SubagentStatus {
  if (!session || (v.status !== 'running' && v.status !== 'idle')) return v.status;
  return effectiveStatus(v.status, sessionAlive(session));
}

/** «Субагент», a teammate's name, or the agent type. */
export function subTitle(v: SubagentView): string {
  return v.description?.trim() || (v.kind === 'teammate' ? (v.name ?? 'тиммейт') : (v.agentType ?? 'субагент'));
}

/** The agent type, a teammate's name instead. */
export function subType(v: SubagentView): string {
  if (v.kind === 'teammate') return v.name ? `тиммейт ${v.name}` : 'тиммейт';
  if (v.kind === 'skill') return v.agentType ? `скилл ${v.agentType}` : 'скилл';
  return v.agentType ?? 'субагент';
}

/** Until the end, until now for a running one, until the last line for an interrupted one. */
export function subDurationMs(v: SubagentView, status: SubagentStatus, now = Date.now()): number | null {
  if (v.durationMs != null && status !== 'running' && status !== 'idle') return v.durationMs;
  const start = v.startedAt ? Date.parse(v.startedAt) : NaN;
  if (Number.isNaN(start)) return null;
  const end = status === 'running' || status === 'idle' ? now : Date.parse(v.endedAt ?? v.lastEventAt ?? '') || start;
  return Math.max(0, end - start);
}

export function durationLabel(ms: number | null): string {
  if (ms == null) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин${s % 60 ? ` ${s % 60} с` : ''}`;
  return `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

/** The list as a tree: by start time (the hub's order), nested rows right under their parent with their depth. */
export function subTree(list: SubagentView[]): { v: SubagentView; depth: number }[] {
  const ids = new Set(list.map(v => v.id));
  const byAgent = new Map(list.flatMap(v => (v.agentId ? [[v.agentId, v.id] as const] : [])));
  const parentOf = (v: SubagentView) => (v.parentId && ids.has(v.parentId) ? v.parentId : v.parentAgentId ? (byAgent.get(v.parentAgentId) ?? null) : null);
  const kids = new Map<string | null, SubagentView[]>();
  for (const v of list) {
    const p = parentOf(v);
    const key = p && p !== v.id ? p : null;
    kids.set(key, [...(kids.get(key) ?? []), v]);
  }
  const out: { v: SubagentView; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const v of kids.get(parent) ?? []) {
      if (seen.has(v.id)) continue;
      seen.add(v.id);
      out.push({ v, depth });
      walk(v.id, depth + 1);
    }
  };
  walk(null, 0);
  // rows in a cycle of parents (should not happen) are still listed
  for (const v of list) if (!seen.has(v.id)) out.push({ v, depth: 0 });
  return out;
}

/** The row of a call `Agent`/`Task` by its tool_use id. */
export function forCall(list: SubagentView[] | undefined, toolUseId: string): SubagentView | undefined {
  return list?.find(v => v.toolUseId === toolUseId);
}

/** The addressee of `SendMessage {to}` or the sender of a teammate message: by agentId, then by name. */
export function forTarget(list: SubagentView[] | undefined, to: string | undefined): SubagentView | undefined {
  if (!list || !to) return undefined;
  const t = to.replace(/^agent-/, '');
  return list.find(v => v.agentId === t) ?? list.find(v => v.name === to);
}

/** `true` for `Agent`/`Task` calls (the tools that start a subagent). */
export const isAgentCall = (name: string) => name === 'Agent' || name === 'Task';
