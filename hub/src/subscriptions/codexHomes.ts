// provider-parity R3 (design.md): the hub tells every machine of a user which Codex subscription homes may live. The
// keep-list is the source of truth, so a machine that was offline at a retire catches up on its next hello.
import type { FastifyBaseLogger } from 'fastify';
import { CODEX_HOMES_SYNC_CAPABILITY } from '@agent-hub/shared';
import type { Db } from '../db/db.js';
import type { HubBus } from '../bus.js';
import type { AgentConnection, AgentGateway } from '../runners/agentGateway.js';

export interface CodexHomesSyncOptions {
  db: Db;
  bus: HubBus;
  agents: Pick<AgentGateway, 'get' | 'ofUser'>;
  log: Pick<FastifyBaseLogger, 'warn'>;
}

export class CodexHomesSync {
  constructor(private readonly o: CodexHomesSyncOptions) {
    o.bus.on('agent.hello', runnerId => {
      const conn = o.agents.get(runnerId);
      if (conn) void this.sendTo([conn]);
    });
  }

  /** After a retire, a bring-back or a replaced credential (`forget`): every online machine of the user. */
  async sync(userId: string, forget: string[] = []): Promise<void> {
    await this.sendTo(this.o.agents.ofUser(userId), forget);
  }

  private async sendTo(conns: AgentConnection[], forget: string[] = []): Promise<void> {
    const capable = conns.filter(c => c.capabilities.includes(CODEX_HOMES_SYNC_CAPABILITY));
    if (!capable.length) return;
    const keep = await this.keep(capable[0]!.userId).catch((err: unknown) => {
      this.o.log.warn({ errorClass: err instanceof Error ? err.name : 'unknown' }, 'codex homes keep-list failed');
      return null;
    });
    if (!keep) return;
    await Promise.all(
      capable.map(c =>
        c
          .request('provider.credentials.sync', { provider: 'codex', keep, ...(forget.length ? { forget } : {}) })
          .catch((err: unknown) => this.o.log.warn({ runnerId: c.runnerId, errorClass: err instanceof Error ? err.name : 'unknown' }, 'codex homes sync failed')),
      ),
    );
  }

  private async keep(userId: string): Promise<string[]> {
    const rows = await this.o.db.selectFrom('subscriptions').select('id').where('user_id', '=', userId).where('provider', '=', 'codex').where('retired_at', 'is', null).limit(1000).execute();
    return rows.map(r => r.id);
  }
}
