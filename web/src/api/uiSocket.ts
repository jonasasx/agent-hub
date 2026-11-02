// /ws/ui client: live runner status, sessions, chat events, tabs and layout; reconnects with backoff and resynchronises over REST.
import type { UiClientMessage, UiServerMessage } from './types';

export interface UiSocketHandlers {
  onMessage(msg: UiServerMessage): void;
  /** Called after every (re)connect, to reload state that may have been missed. */
  onOpen(): void;
  /**
   * Called after a close with its code; the caller may check the session (401 means signed out). Codes of
   * UiCloseCode (4401 session ended, 4403 account disabled) are final: the socket does not reconnect after them.
   */
  onClose(code?: number): void;
}

export function wsUrl(loc: Pick<Location, 'protocol' | 'host'> = window.location): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws/ui`;
}

export interface UiSocket {
  /** Sends when connected; messages sent while disconnected are dropped (the caller re-sends state in onOpen). */
  send(msg: UiClientMessage): void;
  close(): void;
}

export function connectUiSocket(h: UiSocketHandlers, url = wsUrl()): UiSocket {
  let ws: WebSocket | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const open = () => {
    ws = new WebSocket(url);
    ws.onopen = () => {
      attempt = 0;
      h.onOpen();
    };
    ws.onmessage = e => {
      try {
        h.onMessage(JSON.parse(String(e.data)) as UiServerMessage);
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = e => {
      ws = null;
      if (stopped) return;
      h.onClose(e?.code);
      if (e?.code === 4401 || e?.code === 4403) return;
      const delay = Math.min(30_000, 1000 * 2 ** attempt++) * (0.5 + Math.random() / 2);
      timer = setTimeout(open, delay);
    };
  };
  open();

  return {
    send(msg) {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
    },
    close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    },
  };
}
