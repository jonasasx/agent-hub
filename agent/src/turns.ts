// Whether the agent is busy (Requirement: Занятость агента, openspec change update-waits-background-tasks,
// specs/agent-busy): a session runs a turn (seen from the outgoing session.state / session.exited) OR its live process
// has an active background task (system/background_tasks_changed, fed by the session manager), or its active tasks
// ended less than 30 s ago (the release hold).
// Consumers: caffeinate on macOS (onChange → Caffeinator.setBusy) and the self-update (Updater.isBusy), which waits
// until the agent is not busy.

/** One element of system/background_tasks_changed, normalised by the session manager. */
export interface BackgroundTask {
  taskId: string;
  /** null when the CLI sent none: counted as active (unknown → busy, bounded by the 120-min guard). */
  taskType: string | null;
  ambient: boolean;
}

/** Background tasks of a session without any SDK message for this long do not keep the agent busy (as the hub, 120 min). */
export const BACKGROUND_STALE_MS = 120 * 60_000;

/**
 * The set of a session became free of active tasks: the session stays busy this long, closing the gap before the CLI
 * starts the follow-up turn on the task's notification (session_state_changed running). Not after session.exited.
 */
export const BACKGROUND_RELEASE_HOLD_MS = 30_000;

/** Teammates: the set does not tell a working teammate from one waiting for messages (design D3). */
const TEAMMATE = 'in_process_teammate';

interface Background {
  tasks: BackgroundTask[];
  /** Time of the last SDK message of the session process. */
  lastAt: number;
  /** Tracker time until which the session stays busy after its active tasks ended (BACKGROUND_RELEASE_HOLD_MS). */
  releaseAt: number | null;
}

export class TurnTracker {
  private readonly states = new Map<string, string>();
  private readonly background = new Map<string, Background>();
  private listeners: Array<(busy: boolean) => void> = [];
  private last = false;
  private readonly now: () => number;
  private readonly staleMs: number;
  private readonly holdMs: number;
  private timer: NodeJS.Timeout | null = null;
  private timerAt: number | null = null;

  constructor(o: { now?: () => number; staleMs?: number; holdMs?: number } = {}) {
    this.now = o.now ?? Date.now;
    this.staleMs = o.staleMs ?? BACKGROUND_STALE_MS;
    this.holdMs = o.holdMs ?? BACKGROUND_RELEASE_HOLD_MS;
  }

  /** Feed every outgoing message. */
  observe(type: string, payload: unknown): void {
    const p = payload as { sessionId?: unknown; state?: unknown };
    if (typeof p?.sessionId !== 'string') return;
    if (type === 'session.state' && typeof p.state === 'string') this.states.set(p.sessionId, p.state);
    else if (type === 'session.exited') {
      // the process ended (stop, sleep, crash): its turn and its background tasks are gone at once, no hold (design D5)
      this.states.delete(p.sessionId);
      this.background.delete(p.sessionId);
    } else return;
    this.update();
  }

  /** system/background_tasks_changed: the full set of the session process replaces the previous one (REPLACE, D1). */
  setBackground(sessionId: string, tasks: BackgroundTask[], at: number): void {
    const b = this.background.get(sessionId);
    const now = this.now();
    let releaseAt: number | null = null;
    if (!tasks.some(isActiveTask) && b) {
      // active (not stale) tasks just ended → hold; an empty set during a hold keeps it
      if (this.holds(b, now)) releaseAt = now + this.holdMs;
      else if (b.releaseAt !== null && now < b.releaseAt) releaseAt = b.releaseAt;
    }
    this.background.set(sessionId, { tasks: [...tasks], lastAt: Math.max(at, b?.lastAt ?? at), releaseAt });
    this.update();
  }

  /** Any SDK message of the session process (subagents and task_progress included): the 120-min guard restarts. */
  touch(sessionId: string, at: number): void {
    const b = this.background.get(sessionId);
    if (!b) {
      // nothing to hold: remember the time only (a later set keeps it), without a recompute
      this.background.set(sessionId, { tasks: [], lastAt: at, releaseAt: null });
      return;
    }
    if (at <= b.lastAt) return;
    b.lastAt = at;
    if (b.tasks.some(isActiveTask)) this.update();
  }

  /** The process of the session is gone: its set and time are dropped, without the release hold. */
  clear(sessionId: string): void {
    if (!this.background.delete(sessionId)) return;
    this.update();
  }

  /** A turn is running (working / permission), or a session process has an active background task (Requirement: Занятость агента). */
  get busy(): boolean {
    for (const s of this.states.values()) if (s !== 'waiting') return true;
    const now = this.now();
    for (const b of this.background.values()) if (this.holds(b, now) || this.held(b, now)) return true;
    return false;
  }

  onChange(l: (busy: boolean) => void): void {
    this.listeners.push(l);
  }

  /** Removes the guard / hold timer (agent.stop). */
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.timerAt = null;
  }

  private holds(b: Background, now: number): boolean {
    return now - b.lastAt <= this.staleMs && b.tasks.some(isActiveTask);
  }

  private held(b: Background, now: number): boolean {
    return b.releaseAt !== null && now < b.releaseAt;
  }

  /** Recomputes busy, notifies on a change and re-arms the timer on the nearest expiry: the guard (D4) or a hold. */
  private update(): void {
    const busy = this.busy;
    if (busy !== this.last) {
      this.last = busy;
      for (const l of this.listeners) l(busy);
    }
    this.arm();
  }

  private arm(): void {
    const now = this.now();
    let next: number | null = null;
    for (const b of this.background.values()) {
      // +1: «stale» is strictly more than staleMs since the last message; a hold ends at releaseAt itself
      const at = this.holds(b, now) ? b.lastAt + this.staleMs + 1 : this.held(b, now) ? b.releaseAt! : null;
      if (at !== null && (next === null || at < next)) next = at;
    }
    // an earlier timer stays (it recomputes and re-arms when it fires): no clear/set on every stream_event
    if (next !== null && this.timerAt !== null && this.timerAt <= next) return;
    if (next === this.timerAt) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.timerAt = next;
    if (next === null) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.timerAt = null;
        this.update();
      },
      Math.max(0, next - now),
    );
    this.timer.unref?.();
  }
}

/** An active task keeps the agent busy: not ambient, not a teammate (Requirement: Занятость агента). */
export function isActiveTask(t: BackgroundTask): boolean {
  return !t.ambient && t.taskType !== TEAMMATE;
}
