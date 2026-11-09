// Routes the hub's commands to the provider of the session (change agent-providers, design D1).
import { providerSchema, type HubMessage, type LiveSessionState, type Provider, type ProviderStatus } from '@agent-hub/shared';
import { CmdError } from '../sessions/manager.js';
import type { SessionProvider } from './types.js';

/** Commands that name their provider in the payload (absent — claude, as every hub before 1.10 sends them). */
const BY_PAYLOAD = new Set(['session.start', 'session.resume', 'session.fork']);
/** Commands of a provider's machine sign-in and its subscription homes: `provider` is required. */
const LOGIN = new Set(['provider.login.start', 'provider.login.cancel', 'provider.logout', 'provider.credentials.sync']);

export class ProviderRouter {
  private readonly byId = new Map<Provider, SessionProvider>();

  constructor(
    private readonly claude: SessionProvider,
    others: SessionProvider[] = [],
  ) {
    this.byId.set('claude', claude);
    for (const p of others) this.byId.set(p.id, p);
  }

  get(id: Provider): SessionProvider | undefined {
    return this.byId.get(id);
  }

  /** The provider of a hub command; Claude for the commands of the machine (fs.stat, limits.probe, attachments…). */
  route(m: HubMessage): SessionProvider {
    const payload = m.payload as { provider?: unknown; sessionId?: unknown; requestId?: unknown };
    if (BY_PAYLOAD.has(m.type) || LOGIN.has(m.type)) {
      const parsed = providerSchema.safeParse(payload.provider ?? 'claude');
      const p = parsed.success ? this.byId.get(parsed.data) : undefined;
      if (!p) throw new CmdError('provider_unavailable', `provider ${String(payload.provider)} is not available on this machine`);
      return p;
    }
    if (m.type === 'limits.probe') {
      // provider-parity: a probe under a Codex subscription is Codex's; Claude's stays on the machine's default route
      const sub = (m.payload as { subscription?: { provider?: unknown } }).subscription;
      const p = sub?.provider === 'codex' ? this.byId.get('codex') : undefined;
      if (sub?.provider === 'codex' && !p) throw new CmdError('provider_unavailable', 'Codex is not available on this machine');
      if (p) return p;
    }
    if (m.type === 'permission.response' && typeof payload.requestId === 'string') {
      for (const p of this.byId.values()) if (p !== this.claude && p.ownsRequest?.(payload.requestId)) return p;
      return this.claude;
    }
    if (typeof payload.sessionId === 'string') {
      for (const p of this.byId.values()) if (p !== this.claude && p.has(payload.sessionId)) return p;
    }
    return this.claude;
  }

  handle(m: HubMessage): Promise<unknown> {
    // provider-parity R3: a machine without the Codex CLI has no Codex homes to remove
    if (m.type === 'provider.credentials.sync' && !this.byId.has(m.payload.provider)) return Promise.resolve({ removed: 0, deferred: 0 });
    let p: SessionProvider;
    try {
      p = this.route(m);
    } catch (err) {
      return Promise.reject(err);
    }
    return p.handle(m);
  }

  liveSessions(): Array<{ sessionId: string; state: LiveSessionState }> {
    return [...this.byId.values()].flatMap(p => p.liveSessions());
  }

  async stopAll(graceMs?: number): Promise<void> {
    await Promise.all([...this.byId.values()].map(p => p.stopAll(graceMs)));
  }

  onWelcome(): void {
    for (const p of this.byId.values()) p.onWelcome?.();
  }

  /** hello.providers: the other providers installed on the machine. */
  statuses(): ProviderStatus[] {
    return [...this.byId.values()].flatMap(p => {
      const s = p.status?.();
      return s ? [s] : [];
    });
  }
}
