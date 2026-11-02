/** Electron/Node adapter of `core/hubClient.ts`: `ws` socket, Node fetch, the window's `ah_session` cookie (D4). */
import WebSocket from 'ws';
import type { Session } from 'electron';
import { HubClient, type HubClientDeps, type SocketHandlers, type SocketLike } from '../core/hubClient.js';
import { log } from './files.js';

export async function readSessionCookie(s: Session, hubUrl: string): Promise<string | null> {
  const list = await s.cookies.get({ url: hubUrl, name: 'ah_session' });
  return list[0]?.value ?? null;
}

function openSocket(url: string, headers: Record<string, string>, h: SocketHandlers): SocketLike {
  const ws = new WebSocket(url, { headers, handshakeTimeout: 10_000, perMessageDeflate: false });
  ws.on('open', () => h.onOpen());
  ws.on('message', (data, isBinary) => {
    if (!isBinary) h.onMessage(data.toString());
  });
  ws.on('close', code => h.onClose(code));
  ws.on('unexpected-response', (_req, res) => {
    h.onUnexpectedResponse(res.statusCode ?? 0);
    ws.terminate();
  });
  ws.on('error', err => h.onError(err));
  return {
    send: d => ws.send(d),
    close: () => ws.terminate(),
  };
}

export function createHubClient(s: Session, hubUrl: string, userAgent: string, handlers: Pick<HubClientDeps, 'onState' | 'onSeed' | 'onMessage' | 'onHealth'>): HubClient {
  const client = new HubClient({
    hubUrl,
    userAgent,
    getCookie: () => readSessionCookie(s, hubUrl),
    openSocket,
    fetch: (url, init) => fetch(url, init),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: t => clearTimeout(t as NodeJS.Timeout),
    log: l => log(`hub: ${l}`),
    ...handlers,
  });
  // Sign-in, sign-out in the window, reissue of ah_session → reconnect with the new cookie (debounced).
  let t: NodeJS.Timeout | null = null;
  s.cookies.on('changed', (_e, cookie, cause) => {
    if (cookie.name !== 'ah_session') return;
    log(`ah_session cookie changed (${cause})`);
    if (t) clearTimeout(t);
    t = setTimeout(() => client.reconnectNow(), 300);
  });
  return client;
}
