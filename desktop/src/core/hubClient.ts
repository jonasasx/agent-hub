/**
 * The main process connection to the hub (design D4). Requirement: Соединение приложения с хабом.
 *
 * `/ws/ui?client=desktop` with `Origin` = origin of PUBLIC_URL and `Cookie: ah_session=…`; never sends `presence` or
 * `subscribe`, only `ping` every 25 s (no `pong` for 2 intervals → reconnect). On every (re)connect: socket open →
 * `GET /api/sidebar` → seed the model without notifications → apply messages buffered meanwhile. Reconnect pauses
 * 1-2-5-10-30 s, reset after a successful sidebar. 401 on the handshake or the sidebar, or close 4401 → `signed_out`
 * without retries until `reconnectNow()` (a new `ah_session`). While offline, `GET /healthz` is polled every 5 s and a
 * 200 reconnects at once, so the app is back within ~5 s of the VPN returning instead of waiting out a 30 s pause.
 *
 * Electron-free: socket, fetch, cookie and timers are injected.
 */
import { isLocale, type Locale, type MeResponse, type SidebarResponse, type UiClientKind } from '@agent-hub/shared';
import { backoffDelay } from './backoff.js';

export type HubConnState = 'connecting' | 'online' | 'offline' | 'signed_out';

export interface SocketHandlers {
  onOpen(): void;
  onMessage(data: string): void;
  onClose(code: number): void;
  /** The upgrade was answered with a non-101 HTTP status. */
  onUnexpectedResponse(status: number): void;
  onError(err: Error): void;
}

export interface SocketLike {
  send(data: string): void;
  close(): void;
}

export interface HubClientDeps {
  hubUrl: string;
  userAgent: string;
  getCookie(): Promise<string | null>;
  openSocket(url: string, headers: Record<string, string>, handlers: SocketHandlers): SocketLike;
  fetch(url: string, init: { headers: Record<string, string>; signal?: AbortSignal }): Promise<{ status: number; json(): Promise<unknown> }>;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  onState(state: HubConnState): void;
  /** Model replaced from the sidebar (start, reconnect, `projects.changed`): no notifications. */
  onSeed(sidebar: SidebarResponse): void;
  /** `locale` of `/api/me` (the language chosen in the profile; null — not chosen): after every seed and on the poll while online. */
  onLocale?(locale: Locale | null): void;
  /** A server message after the seed. Returns true when the sidebar must be re-read (`projects.changed`). */
  onMessage(msg: unknown): boolean;
  /** Result of a `/healthz` poll while offline (false — the hub is unreachable, not just a dropped socket). */
  onHealth?(ok: boolean): void;
  log?(line: string): void;
}

const DESKTOP_CLIENT_KIND: UiClientKind = 'desktop';

export const PING_MS = 25_000;
export const SIDEBAR_TIMEOUT_MS = 10_000;
export const OFFLINE_HEALTH_MS = 5_000;
/** How often the profile language is re-read while online: a change in the web reaches the tray within this time. */
export const LOCALE_POLL_MS = 30_000;
const HEALTH_TIMEOUT_MS = 4_000;

export function wsUrl(hubUrl: string): string {
  const u = new URL(hubUrl);
  u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:';
  u.pathname = '/ws/ui';
  u.search = `?client=${DESKTOP_CLIENT_KIND}`;
  return u.toString();
}

export class HubClient {
  private state: HubConnState = 'connecting';
  private socket: SocketLike | null = null;
  /** Bumped on every connect/stop: callbacks of an older socket are ignored. */
  private generation = 0;
  private attempt = 0;
  private retryTimer: unknown = null;
  private pingTimer: unknown = null;
  private healthTimer: unknown = null;
  private localeTimer: unknown = null;
  private lastPongAt = 0;
  private seeded = false;
  private buffer: unknown[] = [];
  private sidebarInFlight = false;
  private sidebarAgain = false;
  private stopped = false;
  private cookie: string | null = null;

  constructor(private readonly d: HubClientDeps) {}

  get current(): HubConnState {
    return this.state;
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.teardown();
    this.stopHealth();
  }

  private stopLocalePoll(): void {
    if (this.localeTimer !== null) this.d.clearTimer(this.localeTimer);
    this.localeTimer = null;
  }

  /** `GET /api/me` → `onLocale`. Errors are ignored: the language stays as it was. */
  private async loadLocale(gen: number): Promise<void> {
    if (!this.d.onLocale) return;
    try {
      const r = await this.d.fetch(`${this.d.hubUrl}/api/me`, { headers: this.headers(), signal: AbortSignal.timeout(SIDEBAR_TIMEOUT_MS) });
      if (r.status !== 200) return;
      const me = (await r.json()) as Partial<MeResponse> | null;
      if (gen !== this.generation) return;
      this.d.onLocale(isLocale(me?.locale) ? me.locale : null);
    } catch {
      /* keep the current language */
    }
  }

  private scheduleLocalePoll(gen: number): void {
    if (!this.d.onLocale || this.localeTimer !== null) return;
    this.localeTimer = this.d.setTimer(() => {
      this.localeTimer = null;
      if (gen !== this.generation || this.state !== 'online') return;
      void this.loadLocale(gen).finally(() => {
        if (gen === this.generation && this.state === 'online') this.scheduleLocalePoll(gen);
      });
    }, LOCALE_POLL_MS);
  }

  private stopHealth(): void {
    if (this.healthTimer !== null) this.d.clearTimer(this.healthTimer);
    this.healthTimer = null;
  }

  /** New cookie (sign-in, sign-out in the window, reissue) or the hub is back: connect again right away. */
  reconnectNow(): void {
    if (this.stopped) return;
    this.attempt = 0;
    void this.connect();
  }

  /** Re-read the sidebar on the live socket (`projects.changed`, a machine back online). */
  reseed(): void {
    this.requestSidebar(this.generation);
  }

  /**
   * Every sidebar read — first seed, reconnect, reseed — buffers the socket's messages from the moment the request is
   * sent and applies them after the snapshot (B1 of QA: upserts applied during a reseed were overwritten by the older
   * snapshot). Messages received before the request are reflected in the snapshot itself. A reseed asked for while a
   * read is in flight runs once more right after it.
   */
  private requestSidebar(gen: number): void {
    if (gen !== this.generation) return;
    if (this.sidebarInFlight) {
      this.sidebarAgain = true;
      return;
    }
    this.sidebarInFlight = true;
    this.seeded = false;
    this.buffer = [];
    void this.loadSidebar(gen);
  }

  private setState(s: HubConnState): void {
    if (this.state === s) return;
    this.state = s;
    if (s !== 'offline') this.stopHealth();
    if (s !== 'online') this.stopLocalePoll();
    this.d.onState(s);
  }

  private teardown(): void {
    this.generation++;
    if (this.retryTimer !== null) this.d.clearTimer(this.retryTimer);
    if (this.pingTimer !== null) this.d.clearTimer(this.pingTimer);
    this.retryTimer = null;
    this.pingTimer = null;
    this.stopLocalePoll();
    const s = this.socket;
    this.socket = null;
    this.seeded = false;
    this.buffer = [];
    this.sidebarInFlight = false;
    this.sidebarAgain = false;
    if (s) {
      try {
        s.close();
      } catch {
        /* already closed */
      }
    }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { Origin: new URL(this.d.hubUrl).origin, 'User-Agent': this.d.userAgent };
    if (this.cookie) h.Cookie = `ah_session=${this.cookie}`;
    return h;
  }

  private async connect(): Promise<void> {
    this.teardown();
    const gen = this.generation;
    const cookie = await this.d.getCookie().catch(() => null);
    if (gen !== this.generation || this.stopped) return;
    if (!cookie) {
      this.setState('signed_out');
      return;
    }
    this.cookie = cookie;
    if (this.state !== 'offline') this.setState('connecting');
    this.socket = this.d.openSocket(wsUrl(this.d.hubUrl), this.headers(), {
      onOpen: () => {
        if (gen !== this.generation) return;
        this.lastPongAt = Date.now();
        this.schedulePing(gen);
        this.requestSidebar(gen);
      },
      onMessage: data => {
        if (gen !== this.generation) return;
        let msg: unknown;
        try {
          msg = JSON.parse(data);
        } catch {
          return;
        }
        if ((msg as { type?: unknown })?.type === 'pong') {
          this.lastPongAt = Date.now();
          return;
        }
        if (!this.seeded) {
          this.buffer.push(msg);
          return;
        }
        if (this.d.onMessage(msg)) this.requestSidebar(gen);
      },
      onClose: code => {
        if (gen !== this.generation) return;
        this.d.log?.(`ws closed ${code}`);
        if (code === 4401) return this.signedOut();
        this.scheduleRetry();
      },
      onUnexpectedResponse: status => {
        if (gen !== this.generation) return;
        this.d.log?.(`ws upgrade answered ${status}`);
        if (status === 401) return this.signedOut();
        this.scheduleRetry();
      },
      onError: err => {
        if (gen !== this.generation) return;
        this.d.log?.(`ws error ${err.message}`);
        // `close` follows `error` in ws; retry is scheduled there. A socket that never opened may only error.
        this.scheduleRetry();
      },
    });
  }

  private signedOut(): void {
    this.teardown();
    this.setState('signed_out');
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer !== null) return;
    // New generation: late callbacks of the dropped socket and a sidebar read still in flight are ignored.
    const gen = ++this.generation;
    const s = this.socket;
    this.socket = null;
    if (s) {
      try {
        s.close();
      } catch {
        /* ignore */
      }
    }
    if (this.pingTimer !== null) this.d.clearTimer(this.pingTimer);
    this.pingTimer = null;
    this.seeded = false;
    this.buffer = [];
    this.sidebarInFlight = false;
    this.sidebarAgain = false;
    this.setState('offline');
    const delay = backoffDelay(this.attempt++);
    this.retryTimer = this.d.setTimer(() => {
      if (gen !== this.generation) return;
      this.retryTimer = null;
      void this.connect();
    }, delay);
    if (this.healthTimer === null) this.scheduleHealth();
  }

  /**
   * While offline: `GET /healthz` every 5 s, independent of the reconnect attempts (a hanging handshake does not stop
   * it); 200 → connect right away (the backoff pause is skipped). Stops when the state leaves `offline`.
   */
  private scheduleHealth(): void {
    this.healthTimer = this.d.setTimer(() => {
      this.healthTimer = null;
      if (this.state !== 'offline' || this.stopped) return;
      void (async () => {
        let ok = false;
        try {
          const r = await this.d.fetch(`${this.d.hubUrl}/healthz`, { headers: { 'User-Agent': this.d.userAgent }, signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
          ok = r.status === 200;
        } catch {
          /* still offline */
        }
        if (this.state !== 'offline' || this.stopped) return;
        this.d.onHealth?.(ok);
        if (ok) {
          this.d.log?.('healthz 200 while offline, reconnecting now');
          this.reconnectNow();
        }
        if (this.state === 'offline' && this.healthTimer === null) this.scheduleHealth();
      })();
    }, OFFLINE_HEALTH_MS);
  }

  private schedulePing(gen: number): void {
    this.pingTimer = this.d.setTimer(() => {
      if (gen !== this.generation) return;
      this.pingTimer = null;
      if (Date.now() - this.lastPongAt > 2 * PING_MS) {
        this.d.log?.('no pong for 2 intervals, reconnecting');
        this.scheduleRetry();
        return;
      }
      try {
        this.socket?.send(JSON.stringify({ type: 'ping' }));
      } catch {
        /* close follows */
      }
      this.schedulePing(gen);
    }, PING_MS);
  }

  private async loadSidebar(gen: number): Promise<void> {
    let status = 0;
    let body: unknown = null;
    try {
      const r = await this.d.fetch(`${this.d.hubUrl}/api/sidebar`, { headers: this.headers(), signal: AbortSignal.timeout(SIDEBAR_TIMEOUT_MS) });
      status = r.status;
      if (status === 200) body = await r.json();
    } catch (e) {
      this.d.log?.(`sidebar failed: ${(e as Error).message}`);
    }
    if (gen !== this.generation) return;
    this.sidebarInFlight = false;
    if (status === 401) return this.signedOut();
    const sb = body as SidebarResponse | null;
    if (status !== 200 || !sb || !Array.isArray(sb.now) || !Array.isArray(sb.runners)) {
      this.scheduleRetry();
      return;
    }
    this.d.onSeed(sb);
    this.seeded = true;
    this.attempt = 0;
    this.setState('online');
    void this.loadLocale(gen);
    this.scheduleLocalePoll(gen);
    const buffered = this.buffer;
    this.buffer = [];
    let reseed = this.sidebarAgain;
    this.sidebarAgain = false;
    for (const m of buffered) reseed = this.d.onMessage(m) || reseed;
    if (reseed) this.requestSidebar(gen);
  }
}
