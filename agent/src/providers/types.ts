// The «agent» layer (change agent-providers, design D1): a vendor of sessions behind one interface. The hub's commands
// about a session go to the provider that runs it; a new vendor is a new implementation of SessionProvider.
import type { HubMessage, LiveSessionState, Provider, ProviderStatus } from '@agent-hub/shared';

export interface SessionProvider {
  readonly id: Provider;
  /** Handles a hub command of this provider. Resolves with the cmd.ok result, rejects with CmdError. */
  handle(m: HubMessage): Promise<unknown>;
  /** A live process of the session runs here. */
  has(sessionId: string): boolean;
  /** permission.response carries no session: does this provider wait for the request. */
  ownsRequest?(requestId: string): boolean;
  /** For hello.liveSessions. */
  liveSessions(): Array<{ sessionId: string; state: LiveSessionState }>;
  stopAll(graceMs?: number): Promise<void>;
  /** After a welcome (MCP snapshots again). */
  onWelcome?(): void;
  /** The status for hello.providers / agent.status.providers; null — Claude (reported as hello.claude) or not installed. */
  status?(): ProviderStatus | null;
}
