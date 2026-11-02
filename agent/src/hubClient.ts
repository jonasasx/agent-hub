// Outgoing WebSocket to the hub (design.md D3).
// Requirements: Аутентификация агента по токену; Онлайн-статус и переподключение.
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { CloseCode, HEARTBEAT_TIMEOUT_MS, WS_MAX_PAYLOAD, envelope, parseHubMessage, type HubMessage, type PayloadOf } from '@agent-hub/shared';
import { DEFAULT_BACKOFF, backoffDelay, type BackoffOptions } from './backoff.js';
import type { HelloPayload } from './machine.js';
import type { Logger } from './log.js';

export interface HubClientOptions {
  url: string;
  token: string;
  log: Logger;
  hello: () => HelloPayload;
  backoff?: BackoffOptions;
  /** No ping or message from the hub for this long → the socket is treated as dead. */
  idleTimeoutMs?: number;
}

interface HubClientEvents {
  welcome: [PayloadOf<HubMessage, 'welcome'>];
  message: [HubMessage];
  disconnected: [{ code: number; reason: string }];
}

export type HubClientState = 'idle' | 'connecting' | 'open' | 'stopped';

export class HubClient extends EventEmitter<HubClientEvents> {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private _state: HubClientState = 'idle';
  private readonly backoff: BackoffOptions;
  private readonly idleTimeoutMs: number;

  constructor(private readonly opts: HubClientOptions) {
    super();
    this.backoff = opts.backoff ?? DEFAULT_BACKOFF;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
  }

  get state(): HubClientState {
    return this._state;
  }

  start(): void {
    if (this._state !== 'idle') return;
    this.connect();
  }

  async stop(): Promise<void> {
    this._state = 'stopped';
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.clearIdle();
    const ws = this.ws;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      await new Promise<void>(resolve => {
        ws.once('close', () => resolve());
        ws.close(1000, 'agent stopping');
        setTimeout(() => {
          ws.terminate();
          resolve();
        }, 2000).unref();
      });
    }
  }

  send(type: string, payload: unknown, extra: { id?: string; re?: string } = {}): boolean {
    if (this._state !== 'open' || !this.ws) return false;
    this.ws.send(JSON.stringify(envelope(type, payload, extra)));
    return true;
  }

  /** Binary frame (follows a side.file message, D3). */
  sendBinary(data: Buffer): boolean {
    if (this._state !== 'open' || !this.ws) return false;
    this.ws.send(data, { binary: true });
    return true;
  }

  private connect(): void {
    if (this._state === 'stopped') return;
    this._state = 'connecting';
    const { log } = this.opts;
    log.info('connecting to hub', { url: this.opts.url, attempt: this.attempt });
    const ws = new WebSocket(this.opts.url, {
      headers: { Authorization: `Bearer ${this.opts.token}` },
      maxPayload: WS_MAX_PAYLOAD,
      handshakeTimeout: 15_000,
    });
    this.ws = ws;

    ws.on('open', () => {
      this.touch();
      ws.send(JSON.stringify(envelope('hello', this.opts.hello())));
    });
    ws.on('ping', () => this.touch());
    ws.on('message', data => {
      this.touch();
      const parsed = parseHubMessage(data.toString());
      if (!parsed.ok) {
        if (parsed.reason === 'unknown_type') log.info('unknown hub message type ignored', { type: parsed.type });
        else log.warn('invalid hub message', { reason: parsed.reason, type: parsed.type, error: parsed.error });
        return;
      }
      const m = parsed.message;
      if (m.type === 'welcome') {
        this.attempt = 0;
        this._state = 'open';
        log.info('connected to hub', { runnerId: m.payload.runnerId, protocol: m.payload.protocol });
        this.emit('welcome', m.payload);
        return;
      }
      this.emit('message', m);
      // Commands this agent version does not handle yet still get an answer, so the hub does not wait.
      if (m.id && this.listenerCount('message') === 0) {
        this.send('cmd.error', { code: 'not_implemented', message: `${m.type} is not supported by agent` }, { re: m.id });
      }
    });
    ws.on('unexpected-response', (_req, res) => {
      log.warn('hub rejected the handshake', { status: res.statusCode });
      ws.terminate();
    });
    ws.on('error', err => log.warn('hub connection error', { error: err.message }));
    ws.on('close', (code, reasonBuf) => {
      this.clearIdle();
      if (this.ws === ws) this.ws = null;
      const reason = reasonBuf.toString();
      const wasStopped = this._state === 'stopped';
      if (!wasStopped) this._state = 'connecting';
      this.emit('disconnected', { code, reason });
      if (wasStopped) return;
      let delay = backoffDelay(this.attempt++, this.backoff);
      if (code === CloseCode.InvalidToken) {
        log.error('hub rejected the agent token; check AGENT_TOKEN', { code });
        delay = this.backoff.maxMs;
      } else if (code === CloseCode.IncompatibleVersion) {
        log.error('hub does not support this protocol version; update the agent', { code, reason });
        delay = this.backoff.maxMs;
      } else if (code === CloseCode.Replaced) {
        log.warn('another agent with the same token connected; this one was replaced', { code });
        delay = this.backoff.maxMs;
      } else {
        log.warn('disconnected from hub', { code, reason });
      }
      log.info('reconnect scheduled', { inMs: delay });
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
  }

  private touch(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      this.opts.log.warn('no heartbeat from hub, reconnecting', { idleMs: this.idleTimeoutMs });
      this.ws?.terminate();
    }, this.idleTimeoutMs);
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
