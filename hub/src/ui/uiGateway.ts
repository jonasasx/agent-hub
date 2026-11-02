// /ws/ui — browser connections (design.md D10).
// Requirements: Защита API и WebSocket UI; Онлайн-статус и переподключение (status reaches the UI ≤5 s).
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { UiCloseCode, parseUiClientKind, uiClientMessageSchema, type UiClientKind, type UiServerMessage } from '@agent-hub/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/db.js';
import type { HubBus } from '../bus.js';
import { findSession, SESSION_COOKIE } from '../auth/sessions.js';

/** Close code for a browser socket whose session ended (logout, expiry). */
export const UI_CLOSE_SESSION_ENDED = UiCloseCode.SessionEnded;

interface UiClient {
  ws: WebSocket;
  userId: string;
  /** sha256 of the session cookie the socket was opened with. */
  sessionHash: Buffer;
  expiresAt: Date;
  alive: boolean;
  /** `?client=` of the handshake (change desktop-app, D7): a `desktop` client is never visible. */
  kind: UiClientKind;
  visible: boolean;
  activeSessionIds: string[];
  subscribed: Set<string>;
}

export class UiGateway {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  private readonly clients = new Set<UiClient>();
  private readonly pingTimer: NodeJS.Timeout;

  constructor(
    private readonly opts: {
      db: Db;
      bus: HubBus;
      log: FastifyBaseLogger;
      publicOrigin: string;
      parseCookie: (header: string) => Record<string, string | undefined>;
      pingIntervalMs?: number;
      /** A client reported what it shows: the hub clears «unread» of visible active sessions. */
      onPresence?: (userId: string, visibleActiveSessionIds: string[]) => void;
    },
  ) {
    opts.bus.on('runner.status', (userId, runner) => this.broadcast(userId, { type: 'runner.status', runner }));
    opts.bus.on('runner.enroll', (userId, runnerId, stage, runner) => this.broadcast(userId, { type: 'runner.enroll', runnerId, stage, runner }));
    this.pingTimer = setInterval(() => this.ping(), opts.pingIntervalMs ?? 30_000);
    this.pingTimer.unref();
  }

  /** Number of connected browser sockets (for tests and metrics). */
  get size(): number {
    return this.clients.size;
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const reject = (status: number, text: string) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    const token = this.opts.parseCookie(req.headers.cookie ?? '')[SESSION_COOKIE];
    findSession(this.opts.db, token)
      .then(session => {
        if (!session) return reject(401, 'Unauthorized');
        // Cross-site WebSocket hijacking guard: browsers always send Origin on WebSocket handshakes.
        if (req.headers.origin !== this.opts.publicOrigin) return reject(403, 'Forbidden');
        const kind = parseUiClientKind(new URL(req.url ?? '/', 'http://x').searchParams.get('client'));
        this.wss.handleUpgrade(req, socket, head, ws => this.onConnection(ws, session.user.id, session.idHash, session.expiresAt, kind));
      })
      .catch((err: unknown) => {
        this.opts.log.error({ err }, 'ui upgrade failed');
        reject(500, 'Internal Server Error');
      });
  }

  broadcast(userId: string, msg: UiServerMessage): void {
    const data = JSON.stringify(msg);
    for (const c of this.clients) {
      if (c.userId === userId && c.ws.readyState === c.ws.OPEN) c.ws.send(data);
    }
  }

  /** Sends to the user's clients that subscribed to this session (chat items, partial text, permissions). */
  sendToSubscribers(userId: string, sessionId: string, msg: UiServerMessage): void {
    const data = JSON.stringify(msg);
    for (const c of this.clients) {
      if (c.userId === userId && c.subscribed.has(sessionId) && c.ws.readyState === c.ws.OPEN) c.ws.send(data);
    }
  }

  /** Has a client (of this user, when given) subscribed to the session — its `subscribe` processed? */
  isSubscribed(sessionId: string, userId?: string): boolean {
    for (const c of this.clients) if ((!userId || c.userId === userId) && c.subscribed.has(sessionId)) return true;
    return false;
  }

  /** Is the session active in a visible panel of any client of the user (D8 «unread», D13 presence). */
  isActiveVisible(userId: string, sessionId: string): boolean {
    for (const c of this.clients) if (c.userId === userId && c.visible && c.activeSessionIds.includes(sessionId)) return true;
    return false;
  }

  /** Has the user a live connection of this kind (the `desktop` delivery channel of M5, D8). */
  hasClient(userId: string, kind: UiClientKind): boolean {
    for (const c of this.clients) if (c.userId === userId && c.kind === kind && c.ws.readyState === c.ws.OPEN) return true;
    return false;
  }

  /** Closes every socket opened with this browser session (logout, denied re-login). */
  closeAuthSession(sessionHash: Buffer): number {
    let n = 0;
    for (const c of this.clients) {
      if (c.sessionHash.equals(sessionHash)) {
        c.ws.close(UI_CLOSE_SESSION_ENDED, 'session ended');
        this.clients.delete(c);
        n++;
      }
    }
    return n;
  }

  /** Requirement: Отключение пользователя — every socket of the user, closed with 4403 («Доступ отключён»). */
  closeUser(userId: string): number {
    let n = 0;
    for (const c of this.clients) {
      if (c.userId === userId) {
        c.ws.close(UiCloseCode.AccountDisabled, 'account disabled');
        this.clients.delete(c);
        n++;
      }
    }
    return n;
  }

  async close(): Promise<void> {
    clearInterval(this.pingTimer);
    for (const c of this.clients) c.ws.close(1001, 'hub shutting down');
    await new Promise<void>(r => this.wss.close(() => r()));
  }

  private onConnection(ws: WebSocket, userId: string, sessionHash: Buffer, expiresAt: Date, kind: UiClientKind = 'web'): void {
    const client: UiClient = { ws, userId, sessionHash, expiresAt, alive: true, kind, visible: kind !== 'desktop', activeSessionIds: [], subscribed: new Set() };
    this.clients.add(client);
    ws.on('pong', () => (client.alive = true));
    ws.on('close', () => this.clients.delete(client));
    ws.on('error', () => undefined);
    ws.on('message', data => {
      let json: unknown;
      try {
        json = JSON.parse(data.toString());
      } catch {
        return;
      }
      const r = uiClientMessageSchema.safeParse(json);
      if (!r.success) return;
      const m = r.data;
      if (m.type === 'ping') ws.send(JSON.stringify({ type: 'pong' } satisfies UiServerMessage));
      // Requirement: Вид клиента и признак видимости в хабе — presence of a desktop client is ignored.
      else if (m.type === 'presence' && client.kind !== 'desktop') {
        client.visible = m.visible;
        client.activeSessionIds = m.activeSessionIds;
        if (m.visible && m.activeSessionIds.length > 0) this.opts.onPresence?.(userId, m.activeSessionIds);
      } else if (m.type === 'subscribe') {
        const sessions = new Set(m.sessionIds);
        client.subscribed = sessions;
        // chats of subagents (change `subagents`): only the user's own registry rows are added
        const ids = (m.subagentIds ?? []).filter(x => /^[0-9a-f-]{36}$/i.test(x));
        if (ids.length) {
          void this.opts.db
            .selectFrom('subagent_runs')
            .select('id')
            .where('user_id', '=', userId)
            .where('id', 'in', ids)
            .execute()
            .then(own => {
              // a later subscribe replaced this one: nothing to add
              if (client.subscribed !== sessions) return;
              for (const r of own) sessions.add(r.id);
            })
            .catch((err: unknown) => this.opts.log.warn({ err }, 'subagent subscription failed'));
        }
      }
    });
  }

  private ping(): void {
    const now = Date.now();
    for (const c of this.clients) {
      if (c.expiresAt.getTime() <= now) {
        c.ws.close(UI_CLOSE_SESSION_ENDED, 'session expired');
        this.clients.delete(c);
        continue;
      }
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }
}
