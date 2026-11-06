/** Serializes MCP registry operations while bounding how long the hub waits for a reply. */
export class McpRegistryQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly responseTimeoutMs = 15_000) {}

  enqueue<T>(operation: () => Promise<T>, onLateResult?: (result: T) => void): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    let responseTimedOut = false;
    let rejectTimeout!: (error: Error) => void;
    const timeout = new Promise<never>((_, reject) => {
      rejectTimeout = reject;
    });
    const operationResult = this.tail.then(async () => {
      timer = setTimeout(() => {
        responseTimedOut = true;
        rejectTimeout(new Error('MCP registry operation timed out'));
      }, this.responseTimeoutMs);
      timer.unref();
      try {
        const result = await operation();
        if (responseTimedOut) onLateResult?.(result);
        return result;
      } finally {
        if (timer) clearTimeout(timer);
      }
    });
    this.tail = operationResult.then(
      () => undefined,
      () => undefined,
    );
    return Promise.race([operationResult, timeout]);
  }
}
