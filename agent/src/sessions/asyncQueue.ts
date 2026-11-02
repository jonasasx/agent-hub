/** Unbounded async queue: the `prompt` of a live query() (D3). Messages pushed during a turn go next turn. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  /** Pending next() calls in call order (a consumer may call next() again before the previous resolves). */
  private readonly waiters: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;

  get isClosed(): boolean {
    return this.closed;
  }

  get size(): number {
    return this.items.length;
  }

  push(item: T): boolean {
    if (this.closed) return false;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
    return true;
  }

  /** Ends the iteration once the queued items are consumed. */
  close(): void {
    this.closed = true;
    if (this.items.length === 0) for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length > 0) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise(resolve => this.waiters.push(resolve));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
