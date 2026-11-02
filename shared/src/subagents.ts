// Subagents of a session (change `subagents`, design S3): the stored state and the status shown, shared by the hub
// and web so both compute it the same way. Requirement (subagents): Статус субагента.

/** Stored state of a registry row: from signs in the transcripts (results, notifications, hooks), not from liveness. */
export const SUBAGENT_STATES = ['running', 'idle', 'completed', 'failed', 'stopped'] as const;
export type SubagentState = (typeof SUBAGENT_STATES)[number];

/** Shown status: the state, or `interrupted` when the session's process ended before a sign of the end arrived. */
export type SubagentStatus = SubagentState | 'interrupted';

/**
 * running / idle with a session that is not alive (no hub process and not running outside the hub) → interrupted;
 * every other state as it is. `sessionAlive` = `processAlive || externalActive` of the SessionView.
 */
export function effectiveStatus(state: SubagentState, sessionAlive: boolean): SubagentStatus {
  if ((state === 'running' || state === 'idle') && !sessionAlive) return 'interrupted';
  return state;
}

/** A session is alive for its subagents while the hub runs its process or it is written outside the hub. */
export function sessionAlive(s: { processAlive: boolean; externalActive?: boolean | undefined }): boolean {
  return s.processAlive || s.externalActive === true;
}
