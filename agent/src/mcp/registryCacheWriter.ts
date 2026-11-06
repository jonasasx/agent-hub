import type { Logger } from '../log.js';
import type { RegistryCache, RegistrySnapshot } from './registryCache.js';

/** Keeps one cache write in flight and replaces any queued snapshot with the latest one. */
export class RegistryCacheWriter {
  private inFlight: Promise<void> | null = null;
  private pending: RegistrySnapshot | null = null;

  constructor(
    private readonly cache: RegistryCache,
    private readonly log: Logger,
  ) {}

  enqueue(snapshot: RegistrySnapshot): void {
    this.pending = snapshot;
    if (!this.inFlight) this.startDrain();
  }

  async flush(timeoutMs = 5000): Promise<boolean> {
    const current = this.inFlight;
    if (!current) return true;
    let timer: NodeJS.Timeout | undefined;
    const completed = await Promise.race([
      current.then(() => true),
      new Promise<false>(resolve => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return completed;
  }

  private startDrain(): void {
    const drain = this.drain();
    this.inFlight = drain;
    void drain.finally(() => {
      if (this.inFlight !== drain) return;
      this.inFlight = null;
      if (this.pending) this.startDrain();
    });
  }

  private async drain(): Promise<void> {
    while (this.pending) {
      const snapshot = this.pending;
      this.pending = null;
      try {
        await this.cache.write(snapshot);
      } catch (error) {
        this.log.warn('MCP registry cache write failed', {
          revision: snapshot.revision,
          errorClass: error instanceof Error ? error.name : 'unknown',
        });
      }
    }
  }
}
