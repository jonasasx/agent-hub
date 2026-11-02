/**
 * Runs async steps one at a time per key, in submission order. Keys with an empty queue are forgotten.
 *
 * Warning: a step must never await `run()` with its own key (directly or through a call that enqueues on it):
 * that step waits behind itself and the key deadlocks. Enqueue without awaiting (fire and forget) instead, as
 * the session service does for launch failures.
 */
export class KeyedSerial {
  private readonly chains = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.chains.set(key, tail);
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return next;
  }

  get size(): number {
    return this.chains.size;
  }
}
