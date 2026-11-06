import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpRegistryQueue } from './registryQueue.js';

describe('MCP registry queue', () => {
  afterEach(() => vi.useRealTimers());

  it('starts the timeout when an operation enters the queue', async () => {
    vi.useFakeTimers();
    const queue = new McpRegistryQueue(15_000);
    const events: string[] = [];
    let releaseStart!: () => void;
    const startGate = new Promise<void>(resolve => {
      releaseStart = resolve;
    });
    const start = queue.enqueue(
      async () => {
        events.push('start-begin');
        await startGate;
        events.push('start-end');
      },
      () => events.push('late-stop'),
    );
    const next = queue.enqueue(async () => {
      events.push('sync');
    });

    const startRejection = expect(start).rejects.toThrow('MCP registry operation timed out');
    await vi.advanceTimersByTimeAsync(15_000);
    await startRejection;
    expect(events).toEqual(['start-begin']);
    releaseStart();
    await next;
    expect(events).toEqual(['start-begin', 'start-end', 'late-stop', 'sync']);
  });
});
