// Session lifecycle (design.md D8). Requirement: Статусы сессии; Засыпание по простою; Продолжение (resume).
import type { SessionStatus } from '@agent-hub/shared';

/** What happened to a session. Initial events have no source status. */
export type SessionEvent =
  | 'start' // POST /api/sessions, handoff
  | 'fork_copy' // full copy created, process not started
  | 'discovered' // seen by replication, started outside the hub
  | 'result' // end of turn
  | 'permission_request' // canUseTool asked
  | 'permission_resolved' // last open request answered
  | 'interrupt'
  | 'send' // message to a live process
  | 'idle_timeout' // waiting longer than the idle timeout
  | 'permission_timeout' // waiting for permission longer than 2 h; the request is denied
  | 'resume_send' // message to a sleeping/closed session (resume with a prompt)
  | 'wake' // «Продолжить»: resume without a message
  | 'crashed'; // process exited unexpectedly

export const INITIAL: Partial<Record<SessionEvent, SessionStatus>> = {
  start: 'working',
  fork_copy: 'waiting',
  discovered: 'closed',
};

/** Transition table: TRANSITIONS[from][event] = to. Anything absent is not a transition of D8. */
export const TRANSITIONS: Record<SessionStatus, Partial<Record<SessionEvent, SessionStatus>>> = {
  working: {
    result: 'waiting',
    permission_request: 'permission',
    interrupt: 'waiting',
    crashed: 'waiting',
  },
  permission: {
    permission_resolved: 'working',
    permission_timeout: 'sleeping',
    // The turn may end while a request is open only through interrupt (the SDK cancels canUseTool).
    interrupt: 'waiting',
    crashed: 'waiting',
  },
  waiting: {
    send: 'working',
    idle_timeout: 'sleeping',
    crashed: 'waiting',
  },
  sleeping: {
    resume_send: 'working',
    wake: 'waiting',
  },
  closed: {
    resume_send: 'working',
    wake: 'waiting',
  },
};

export function initialStatus(event: SessionEvent): SessionStatus | null {
  return INITIAL[event] ?? null;
}

/** Next status, or null when the event is not allowed in this status. */
export function nextStatus(from: SessionStatus, event: SessionEvent): SessionStatus | null {
  return TRANSITIONS[from][event] ?? null;
}

/** Statuses in which a session has (or should have) a live process. */
export function isLiveStatus(s: SessionStatus): boolean {
  return s === 'working' || s === 'waiting' || s === 'permission';
}

export const DEFAULT_IDLE_TIMEOUT_MIN = 30;
export const PERMISSION_IDLE_TIMEOUT_MIN = 120;

/**
 * Idle timeout in minutes the scheduler applies now; 0 = never. `working` never sleeps.
 * The user override (0 = «не усыплять») applies to both waiting and permission.
 */
export function effectiveIdleTimeoutMin(
  status: SessionStatus,
  override: number | null,
  defaults: { idle: number; permission: number } = { idle: DEFAULT_IDLE_TIMEOUT_MIN, permission: PERMISSION_IDLE_TIMEOUT_MIN },
): number {
  if (override === 0) return 0;
  if (status === 'permission') return defaults.permission;
  if (status === 'waiting') return override ?? defaults.idle;
  return 0;
}

export interface SleepInput {
  status: SessionStatus;
  processAlive: boolean;
  idleTimeoutMin: number | null;
  lastTurnEndAt: Date | null;
  lastInputAt: Date | null;
  permissionSince?: Date | null;
  /**
   * The latest activity of the session as a whole seen in its transcripts: the last line of the main transcript, the
   * last event of any subagent, the start or end of a background command (runner clock).
   */
  lastActivityAt?: Date | null;
  /** Subagents in state «running» plus background commands still running, of the current process. */
  workingChildren?: number;
}

/**
 * When the session falls asleep if nothing happens; null if it is not counting down. The only rule of sleep: the
 * scheduler (checkIdle) and the countdown in the UI (SessionView.sleepsAt) both call it.
 *
 * Idle time starts at the latest of: end of turn, last input, (for permission) the open request, and the last
 * activity of the session as a whole (its subagents and background commands included). While a subagent or a
 * background command works, the idle timeout does not apply: only the stall guard does — no event of the session or
 * of its children for the permission timeout (120 min) — so a registry row that never ends cannot keep the process
 * forever.
 */
export function sleepsAt(s: SleepInput, defaults: { idle: number; permission: number } = { idle: DEFAULT_IDLE_TIMEOUT_MIN, permission: PERMISSION_IDLE_TIMEOUT_MIN }): Date | null {
  if (!s.processAlive || (s.status !== 'waiting' && s.status !== 'permission')) return null;
  let min = effectiveIdleTimeoutMin(s.status, s.idleTimeoutMin, defaults);
  if (min === 0) return null;
  if ((s.workingChildren ?? 0) > 0) min = Math.max(min, defaults.permission);
  const from = Math.max(s.lastTurnEndAt?.getTime() ?? 0, s.lastInputAt?.getTime() ?? 0, s.status === 'permission' ? (s.permissionSince?.getTime() ?? 0) : 0, s.lastActivityAt?.getTime() ?? 0);
  if (from === 0) return null;
  return new Date(from + min * 60_000);
}
