// Requirement: Онлайн-статус и переподключение — exponential delay from 1 to 60 s with jitter.

export interface BackoffOptions {
  minMs: number;
  maxMs: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { minMs: 1000, maxMs: 60_000 };

/**
 * Delay before reconnect attempt `attempt` (0-based): the exponential ceiling min(max, min·2^attempt),
 * then "equal jitter" — a uniform value in [ceiling/2, ceiling], never below `minMs`.
 */
export function backoffDelay(attempt: number, opts: BackoffOptions = DEFAULT_BACKOFF, random: () => number = Math.random): number {
  const ceiling = Math.min(opts.maxMs, opts.minMs * 2 ** Math.max(0, Math.min(attempt, 30)));
  const jittered = ceiling / 2 + random() * (ceiling / 2);
  return Math.round(Math.max(opts.minMs, Math.min(opts.maxMs, jittered)));
}
