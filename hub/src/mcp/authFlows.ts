// Sign-in attempts of remote MCP servers, in the hub's memory (mcp-management design M7). A restart of the hub loses
// them: the user presses «Войти» again (the CLI process accepts a new attempt). The code of the provider is never kept.
// Requirement: Защита потока входа MCP.
import type { McpAuthFlowView } from '@agent-hub/shared';

export const MCP_AUTH_TTL_MS = 10 * 60_000;
export const MCP_AUTH_PER_USER = 8;

export interface McpAuthFlow {
  /** `state` the CLI issued: the key of the attempt. */
  state: string;
  userId: string;
  sessionId: string;
  runnerId: string;
  claudeSessionId: string;
  server: string;
  authUrl: string;
  redirect: 'hub' | 'localhost';
  callbackPort?: number;
  /**
   * mcp-auth-controls (review fix): the server was `connected` when the attempt started («Войти заново») — the CLI has
   * already dropped its token, but the process keeps the old connection, so a `connected` snapshot proves nothing until
   * the server has left `connected` once (`leftConnected`) or the agent reported mcp.auth.done.
   */
  startedConnected?: boolean;
  leftConnected?: boolean;
  createdAt: number;
  expiresAt: number;
}

export function flowView(f: McpAuthFlow): McpAuthFlowView {
  return { server: f.server, authUrl: f.authUrl, redirect: f.redirect, ...(f.callbackPort !== undefined ? { callbackPort: f.callbackPort } : {}), expiresAt: new Date(f.expiresAt).toISOString() };
}

export class McpAuthFlows {
  private readonly byState = new Map<string, McpAuthFlow>();
  private readonly ttlMs: number;
  private readonly perUser: number;
  private readonly now: () => number;
  private readonly onExpire: ((f: McpAuthFlow) => void) | undefined;

  constructor(o: { ttlMs?: number; perUser?: number; now?: () => number; /** An attempt expired (dropped by any sweep). */ onExpire?: (f: McpAuthFlow) => void } = {}) {
    this.ttlMs = o.ttlMs ?? MCP_AUTH_TTL_MS;
    this.perUser = o.perUser ?? MCP_AUTH_PER_USER;
    this.now = o.now ?? Date.now;
    this.onExpire = o.onExpire;
  }

  /** Drops the expired attempts and returns them (the caller tells the UI `expired`). */
  sweep(): McpAuthFlow[] {
    const t = this.now();
    const gone: McpAuthFlow[] = [];
    for (const [k, f] of this.byState) {
      if (f.expiresAt <= t) {
        this.byState.delete(k);
        gone.push(f);
      }
    }
    for (const f of gone) this.onExpire?.(f);
    return gone;
  }

  /**
   * A new attempt (M7): it replaces the attempt of the same session and server; beyond 8 attempts of the user the
   * oldest is dropped. Returns the attempts that were removed (replaced or evicted).
   */
  add(f: Omit<McpAuthFlow, 'createdAt' | 'expiresAt'>): { flow: McpAuthFlow; removed: McpAuthFlow[] } {
    this.sweep();
    const removed: McpAuthFlow[] = [];
    for (const [k, o] of this.byState) {
      if (o.sessionId === f.sessionId && o.server === f.server) {
        this.byState.delete(k);
        removed.push(o);
      }
    }
    const t = this.now();
    const flow: McpAuthFlow = { ...f, createdAt: t, expiresAt: t + this.ttlMs };
    this.byState.delete(flow.state);
    this.byState.set(flow.state, flow);
    const mine = [...this.byState.values()].filter(o => o.userId === f.userId).sort((a, b) => a.createdAt - b.createdAt);
    while (mine.length > this.perUser) {
      const old = mine.shift()!;
      this.byState.delete(old.state);
      removed.push(old);
    }
    return { flow, removed };
  }

  /** The attempt of `state`, if it has not expired. */
  get(state: string): McpAuthFlow | undefined {
    this.sweep();
    return this.byState.get(state);
  }

  find(sessionId: string, server: string): McpAuthFlow | undefined {
    this.sweep();
    return [...this.byState.values()].find(f => f.sessionId === sessionId && f.server === server);
  }

  ofSession(sessionId: string): McpAuthFlow[] {
    this.sweep();
    return [...this.byState.values()].filter(f => f.sessionId === sessionId);
  }

  /** Removes one attempt; true when it was there. */
  remove(f: Pick<McpAuthFlow, 'state'>): boolean {
    return this.byState.delete(f.state);
  }

  /** mcp-auth-controls A3: every attempt into `server` of the sessions of a machine (a sign-out there). */
  removeFor(runnerId: string, server: string): McpAuthFlow[] {
    const gone = [...this.byState.values()].filter(f => f.runnerId === runnerId && f.server === server);
    for (const f of gone) this.byState.delete(f.state);
    return gone;
  }

  /** Every attempt of a session (its process exited). */
  removeSession(sessionId: string): McpAuthFlow[] {
    const gone = [...this.byState.values()].filter(f => f.sessionId === sessionId);
    for (const f of gone) this.byState.delete(f.state);
    return gone;
  }

  /** Requirement «Простой во время входа»: the session must not fall asleep before this time (null — no attempt). */
  holdUntil(sessionId: string): Date | null {
    const t = this.now();
    let max = 0;
    for (const f of this.byState.values()) if (f.sessionId === sessionId && f.expiresAt > t && f.expiresAt > max) max = f.expiresAt;
    return max ? new Date(max) : null;
  }

  get size(): number {
    return this.byState.size;
  }
}
