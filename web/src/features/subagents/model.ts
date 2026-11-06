/**
 * Subagents of a session (change `subagents`, design S9): statuses in words, the tree of the list, durations and the
 * lookups that link a call in the feed to its row. Requirements (subagents): Статус субагента; Список субагентов и
 * счётчик; Переход от вызова к чату субагента.
 */
import { effectiveStatus, sessionAlive, type SessionView, type SubagentStatus, type SubagentView } from '../../api/types';
import { t } from '../../i18n';

/** Getters: the label is translated when it is read (at render), so the language change redraws it. */
export const SUBAGENT_STATUS_LABEL = {
  get running() {
    return t('sessions.subagents.status.running');
  },
  get idle() {
    return t('sessions.subagents.status.idle');
  },
  get completed() {
    return t('sessions.subagents.status.completed');
  },
  get failed() {
    return t('sessions.subagents.status.failed');
  },
  get stopped() {
    return t('sessions.subagents.status.stopped');
  },
  get interrupted() {
    return t('sessions.subagents.status.interrupted');
  },
} as Record<SubagentStatus, string>;

/** The status shown now: the hub's, with the session's liveness applied again (the session may have died since). */
export function subStatus(v: SubagentView, session: SessionView | undefined): SubagentStatus {
  if (!session || (v.status !== 'running' && v.status !== 'idle')) return v.status;
  return effectiveStatus(v.status, sessionAlive(session));
}

/** «Субагент», a teammate's name, or the agent type. */
export function subTitle(v: SubagentView): string {
  return v.description?.trim() || (v.kind === 'teammate' ? (v.name ?? t('sessions.subagents.type.teammate')) : (v.agentType ?? t('sessions.subagents.type.subagent')));
}

/** The agent type, a teammate's name instead. */
export function subType(v: SubagentView): string {
  if (v.kind === 'teammate') return v.name ? t('sessions.subagents.type.teammateNamed', { name: v.name }) : t('sessions.subagents.type.teammate');
  if (v.kind === 'skill') return v.agentType ? t('sessions.subagents.type.skillNamed', { name: v.agentType }) : t('sessions.subagents.type.skill');
  return v.agentType ?? t('sessions.subagents.type.subagent');
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
  if (s < 60) return t('sessions.subagents.duration.sec', { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? t('sessions.subagents.duration.minSec', { m, s: s % 60 }) : t('sessions.subagents.duration.min', { n: m });
  return t('sessions.subagents.duration.hourMin', { h: Math.floor(m / 60), m: m % 60 });
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
  const id = to.replace(/^agent-/, '');
  return list.find(v => v.agentId === id) ?? list.find(v => v.name === to);
}

/** `true` for `Agent`/`Task` calls (the tools that start a subagent). */
export const isAgentCall = (name: string) => name === 'Agent' || name === 'Task';
