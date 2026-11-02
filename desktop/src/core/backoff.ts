/** Reconnect pauses of `/ws/ui` (design D4): 1, 2, 5, 10, 30 s, then 30 s. */
export const BACKOFF_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000];

export function backoffDelay(attempt: number): number {
  const i = Math.max(0, Math.min(attempt, BACKOFF_MS.length - 1));
  return BACKOFF_MS[i] ?? 30_000;
}
