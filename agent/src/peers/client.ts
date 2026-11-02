// Requests of the agent-hub tools to the hub (change `session-peers`, design D2): peers.request goes out with an id,
// the hub's peers.reply carries it back in `re`. One pending entry per request; a lost connection fails them all.
import { randomUUID } from 'node:crypto';
import type { PeersReply, PeersRequest } from '@agent-hub/shared';

/** The hub's delivery may include a resume of up to 120 s (SessionService), plus a margin. */
export const PEERS_REQUEST_TIMEOUT_MS = 130_000;

export class PeersError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(message);
  }
}

export interface PeersClientOptions {
  /** Sends `peers.request` with this id; false — the connection is down. */
  send: (payload: PeersRequest, id: string) => boolean;
  timeoutMs?: number;
}

export class PeersClient {
  private readonly pending = new Map<string, { resolve: (r: unknown) => void; reject: (e: PeersError) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly o: PeersClientOptions) {}

  /** The result of the hub's `ok` reply; rejects with PeersError for an error reply, a timeout or a lost connection. */
  request(payload: PeersRequest): Promise<unknown> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PeersError('timeout', 'хаб не ответил вовремя'));
      }, this.o.timeoutMs ?? PEERS_REQUEST_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      if (!this.o.send(payload, id)) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new PeersError('hub_offline', 'нет связи с хабом'));
      }
    });
  }

  onReply(re: string, reply: PeersReply): void {
    const p = this.pending.get(re);
    if (!p) return;
    this.pending.delete(re);
    clearTimeout(p.timer);
    if (reply.ok) p.resolve(reply.result);
    else p.reject(new PeersError(reply.code, reply.message, reply.retryAfterSec));
  }

  failAll(message: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new PeersError('hub_offline', message));
      this.pending.delete(id);
    }
  }
}
