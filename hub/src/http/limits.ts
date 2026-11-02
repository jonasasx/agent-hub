// Requirement: Лимиты запросов (spec public-access, design M9): fixed one-minute windows per client address, the address
// from X-Forwarded-For only behind a trusted proxy (TRUSTED_PROXIES, the same list as Fastify trustProxy).
import type { IncomingMessage } from 'node:http';
import proxyAddr from 'proxy-addr';

export type TrustFn = (addr: string, i: number) => boolean;

/** proxy-addr trust function of the TRUSTED_PROXIES list. */
export function trustFn(list: readonly string[]): TrustFn {
  return proxyAddr.compile([...list]);
}

/** The client address of a raw request (WebSocket upgrades): the socket address unless it is a trusted proxy. */
export function clientIp(req: IncomingMessage, trust: TrustFn): string {
  try {
    return proxyAddr(req, trust);
  } catch {
    return req.socket.remoteAddress ?? 'unknown';
  }
}

/** Limits of the spec, per minute and address. */
export const LIMITS = {
  /** Start of a login (/auth/login, /auth/desktop/start). */
  loginStart: 20,
  /** Wrong enrollment codes (POST /enroll). */
  enrollBad: 10,
  /** Opening an invite page. */
  invitePage: 20,
  /** /ws/agent with a wrong token. */
  agentBadToken: 10,
} as const;

export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {
    this.timer = setInterval(() => this.sweep(), windowMs);
    this.timer.unref();
  }

  /** Is the key over the limit now (without counting)? */
  blocked(key: string): boolean {
    const w = this.current(key);
    return w !== null && w.count >= this.limit;
  }

  /** Counts one hit; true — the hit is within the limit. */
  hit(key: string): boolean {
    const t = this.now();
    let w = this.current(key);
    if (!w) {
      w = { start: t, count: 0 };
      this.windows.set(key, w);
    }
    w.count++;
    return w.count <= this.limit;
  }

  /** Takes back one hit counted by hit() (an attempt that turned out legitimate). */
  release(key: string): void {
    const w = this.current(key);
    if (w && w.count > 0) w.count--;
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private current(key: string): { start: number; count: number } | null {
    const w = this.windows.get(key);
    if (!w) return null;
    if (this.now() - w.start >= this.windowMs) {
      this.windows.delete(key);
      return null;
    }
    return w;
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, w] of this.windows) if (t - w.start >= this.windowMs) this.windows.delete(k);
  }
}

export interface HubLimits {
  loginStart: RateLimiter;
  enrollBad: RateLimiter;
  invitePage: RateLimiter;
  agentBadToken: RateLimiter;
  stop(): void;
}

/** The limits of the spec; tests raise them (`overrides`) where many logins come from one address. */
export function createLimits(opts: { now?: () => number; overrides?: Partial<Record<keyof typeof LIMITS, number>> } = {}): HubLimits {
  const n = { ...LIMITS, ...opts.overrides };
  const l = {
    loginStart: new RateLimiter(n.loginStart, 60_000, opts.now),
    enrollBad: new RateLimiter(n.enrollBad, 60_000, opts.now),
    invitePage: new RateLimiter(n.invitePage, 60_000, opts.now),
    agentBadToken: new RateLimiter(n.agentBadToken, 60_000, opts.now),
  };
  return { ...l, stop: () => Object.values(l).forEach(x => x.stop()) };
}
