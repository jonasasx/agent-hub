// Claude Code as a provider (change agent-providers, design D1): the existing SessionManager behind the interface,
// its behaviour unchanged.
import type { HubMessage } from '@agent-hub/shared';
import type { SessionManager } from '../sessions/manager.js';
import type { SessionProvider } from './types.js';

export class ClaudeProvider implements SessionProvider {
  readonly id = 'claude' as const;

  constructor(readonly manager: SessionManager) {}

  handle(m: HubMessage): Promise<unknown> {
    return this.manager.handle(m);
  }

  has(sessionId: string): boolean {
    return this.manager.has(sessionId);
  }

  liveSessions() {
    return this.manager.liveSessions();
  }

  stopAll(graceMs?: number): Promise<void> {
    return this.manager.stopAll(graceMs);
  }

  onWelcome(): void {
    this.manager.resyncMcp();
  }
}
