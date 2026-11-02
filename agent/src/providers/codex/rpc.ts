// JSON-RPC client of `codex app-server` (change agent-providers, design D5): one line per message on stdio, no
// `jsonrpc` field. Requests of the client have numeric ids; the server sends responses, notifications and its own
// requests (approvals, user input, client tool calls) that the client answers.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Logger } from '../../log.js';
import type { CodexBin } from './bin.js';

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export type NotificationHandler = (method: string, params: Record<string, unknown>) => void;
/** A request of the server: resolves with its result, rejects to answer with an error. */
export type ServerRequestHandler = (method: string, params: Record<string, unknown>, id: number | string) => Promise<unknown>;

/** The process and the transport, separated for the tests (a fake server answers over streams). */
export interface RpcTransport {
  write(line: string): void;
  onLine(cb: (line: string) => void): void;
  onExit(cb: (code: number | null, error: string | null) => void): void;
  close(): void;
  kill(): void;
}

/** Environment of the app-server: the agent's, without the agent's own secret. */
export function codexEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.AGENT_TOKEN;
  return env;
}

/** `codexHome`: a CODEX_HOME of a subscription (provider-parity D2); absent — the machine's own. */
export function spawnAppServer(bin: CodexBin, log: Logger, args: string[] = [], codexHome?: string): RpcTransport {
  const child: ChildProcessWithoutNullStreams = spawn(bin.command, [...bin.args, 'app-server', ...args], {
    env: codexHome ? { ...codexEnv(), CODEX_HOME: codexHome } : codexEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let lastErr = '';
  const errLines = createInterface({ input: child.stderr });
  errLines.on('line', l => {
    // the CLI logs with ANSI colours; tokens are never printed by it, the text is still cut
    // eslint-disable-next-line no-control-regex -- ANSI colour codes of the CLI log
    const text = l.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 2000);
    if (/\b(ERROR|WARN)\b/.test(text)) lastErr = text;
    log.debug('codex stderr', { text });
  });
  const lines = createInterface({ input: child.stdout });
  const exitCbs: Array<(code: number | null, error: string | null) => void> = [];
  let exited = false;
  const fire = (code: number | null, error: string | null) => {
    if (exited) return;
    exited = true;
    for (const cb of exitCbs) cb(code, error);
  };
  child.on('error', err => fire(null, err.message));
  child.on('exit', code => fire(code, code === 0 ? null : lastErr || `codex app-server exited with code ${code}`));
  child.stdin.on('error', () => undefined);
  return {
    write: line => {
      if (!child.stdin.destroyed) child.stdin.write(line + '\n');
    },
    onLine: cb => lines.on('line', cb),
    onExit: cb => exitCbs.push(cb),
    close: () => child.stdin.end(),
    kill: () => {
      if (child.exitCode === null) child.kill();
    },
  };
}

export class RpcClient {
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string }>();
  private closedWith: Error | null = null;
  /** Resolves when the process has ended. */
  readonly exited: Promise<{ code: number | null; error: string | null }>;

  constructor(
    private readonly t: RpcTransport,
    private readonly o: { log: Logger; onNotification: NotificationHandler; onRequest: ServerRequestHandler },
  ) {
    t.onLine(line => this.onLine(line));
    this.exited = new Promise(resolve =>
      t.onExit((code, error) => {
        this.closedWith = new RpcError(-1, error ?? 'codex app-server ended');
        for (const w of this.waiting.values()) w.reject(this.closedWith);
        this.waiting.clear();
        resolve({ code, error });
      }),
    );
  }

  get alive(): boolean {
    return this.closedWith === null;
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 120_000): Promise<T> {
    if (this.closedWith) return Promise.reject(this.closedWith);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiting.delete(id)) reject(new RpcError(-2, `${method}: no answer in ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      timer.unref?.();
      this.waiting.set(id, {
        method,
        resolve: v => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: e => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.t.write(JSON.stringify(params === undefined ? { id, method } : { id, method, params }));
    });
  }

  notify(method: string, params?: unknown): void {
    this.t.write(JSON.stringify(params === undefined ? { method } : { method, params }));
  }

  close(): void {
    this.t.close();
  }

  kill(): void {
    this.t.kill();
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let m: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
    try {
      m = JSON.parse(line);
    } catch {
      this.o.log.warn('codex: not a JSON line', { line: line.slice(0, 200) });
      return;
    }
    if (m.method && m.id !== undefined) {
      const id = m.id;
      this.o.onRequest(m.method, (m.params ?? {}) as Record<string, unknown>, id).then(
        result => this.t.write(JSON.stringify({ id, result: result ?? {} })),
        (err: unknown) => this.t.write(JSON.stringify({ id, error: { code: err instanceof RpcError ? err.code : -32603, message: err instanceof Error ? err.message : String(err) } })),
      );
      return;
    }
    if (m.method) {
      try {
        this.o.onNotification(m.method, (m.params ?? {}) as Record<string, unknown>);
      } catch (err) {
        this.o.log.error('codex notification handler failed', { method: m.method, error: (err as Error).message });
      }
      return;
    }
    if (typeof m.id === 'number') {
      const w = this.waiting.get(m.id);
      if (!w) return;
      this.waiting.delete(m.id);
      if (m.error) w.reject(new RpcError(m.error.code ?? -32603, m.error.message ?? `${w.method} failed`, m.error.data));
      else w.resolve(m.result);
    }
  }
}

/** initialize + initialized (design D5): experimental API for client tools and user input. */
export async function initialize(c: RpcClient, version: string): Promise<{ codexHome?: string; userAgent?: string }> {
  const r = await c.request<{ codexHome?: string; userAgent?: string }>(
    'initialize',
    { clientInfo: { name: 'agent_hub', title: 'Agent Hub', version }, capabilities: { experimentalApi: true, requestAttestation: false } },
    60_000,
  );
  c.notify('initialized');
  return r;
}
