// A fake `codex app-server` for the unit tests: answers requests with scripted handlers, sends notifications and
// server requests on demand, records everything the client wrote.
import type { RpcTransport } from './rpc.js';

type Handler = (params: Record<string, unknown>) => unknown;

export class FakeAppServer {
  readonly written: Array<Record<string, unknown>> = [];
  private lineCb: ((line: string) => void) | null = null;
  private exitCbs: Array<(code: number | null, error: string | null) => void> = [];
  private nextServerId = 1000;
  private readonly answers = new Map<number, (v: Record<string, unknown>) => void>();
  closed = false;
  readonly handlers: Record<string, Handler> = {
    initialize: () => ({ userAgent: 'fake', codexHome: '/fake' }),
    'thread/start': () => ({ thread: { id: 'thread-1' }, model: 'gpt-test' }),
    'thread/resume': p => ({ thread: { id: String(p.threadId) }, model: 'gpt-test' }),
    'thread/fork': () => ({ thread: { id: 'thread-fork' } }),
    'model/list': () => ({
      data: [
        { model: 'gpt-test', displayName: 'GPT Test', hidden: false },
        { model: 'hidden', displayName: 'H', hidden: true },
      ],
      nextCursor: null,
    }),
    'turn/start': () => ({ turn: { id: 'turn-1', items: [], status: 'inProgress' } }),
    'turn/steer': () => ({ turnId: 'turn-1' }),
    'turn/interrupt': () => ({}),
    'account/read': () => ({ account: { type: 'chatgpt', email: 'ivan@example.com', planType: 'pro' }, requiresOpenaiAuth: true }),
    'account/login/start': () => ({ type: 'chatgptDeviceCode', loginId: 'login-1', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' }),
    'account/login/cancel': () => ({}),
    'account/logout': () => ({}),
    'mcpServerStatus/list': () => ({ data: [], nextCursor: null }),
  };

  transport(): RpcTransport {
    return {
      write: line => this.onClient(JSON.parse(line) as Record<string, unknown>),
      onLine: cb => {
        this.lineCb = cb;
      },
      onExit: cb => this.exitCbs.push(cb),
      close: () => {
        this.closed = true;
        setTimeout(() => this.exit(0, null), 0);
      },
      kill: () => this.exit(null, 'killed'),
    };
  }

  private onClient(m: Record<string, unknown>): void {
    this.written.push(m);
    if (typeof m.method === 'string' && m.id !== undefined) {
      const h = this.handlers[m.method];
      setTimeout(() => {
        try {
          if (!h) return this.send({ id: m.id, error: { code: -32601, message: `no ${m.method}` } });
          this.send({ id: m.id, result: h((m.params ?? {}) as Record<string, unknown>) });
        } catch (err) {
          this.send({ id: m.id, error: { code: -32000, message: (err as Error).message } });
        }
      }, 0);
    } else if (m.id !== undefined && !m.method) {
      this.answers.get(Number(m.id))?.(m);
    }
  }

  private send(m: unknown): void {
    this.lineCb?.(JSON.stringify(m));
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.send({ method, params });
  }

  /** A request of the server; resolves with the client's answer (result or error). */
  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextServerId++;
    return new Promise(resolve => {
      this.answers.set(id, resolve);
      this.send({ id, method, params });
    });
  }

  calls(method: string): Array<Record<string, unknown>> {
    return this.written.filter(m => m.method === method).map(m => (m.params ?? {}) as Record<string, unknown>);
  }

  exit(code: number | null, error: string | null): void {
    const cbs = this.exitCbs;
    this.exitCbs = [];
    for (const cb of cbs) cb(code, error);
  }
}
