// The service app-server of the Codex provider (change agent-providers, design D10, D11): the machine's ChatGPT
// sign-in (status, device-code sign-in, sign-out), the model list and thread forks. Started on demand, closed after
// 5 minutes without requests or a sign-in in progress. Tokens stay inside the CLI (CODEX_HOME of the machine).
import type { ProviderLogin, ProviderLoginStart, ProviderStatus } from '@agent-hub/shared';
import type { Logger } from '../../log.js';
import type { CodexBin } from './bin.js';
import type { CodexHomes } from './homes.js';
import type { RateLimitsResponse } from './limits.js';
import { initialize, RpcClient, RpcError, spawnAppServer, type RpcTransport } from './rpc.js';

const IDLE_MS = 5 * 60_000;
/** A device code is valid about 15 minutes; the hub shows the time left. */
const DEVICE_CODE_TTL_MS = 15 * 60_000;

export interface CodexModel {
  value: string;
  displayName: string;
}

export interface CodexServiceDeps {
  bin: CodexBin;
  log: Logger;
  agentVersion: string;
  /** The end of a device-code sign-in (provider.login.done). */
  onLoginDone: (loginId: string, ok: boolean, error?: string, credential?: string) => void;
  /** provider-parity: homes of the subscriptions (a sign-in for the registry, limits). Absent — only the machine's sign-in. */
  homes?: CodexHomes;
  /** The status changed (after a sign-in, a sign-out, a refresh). */
  onStatus: (s: ProviderStatus) => void;
  /** Tests: a fake transport instead of a process. */
  transport?: () => RpcTransport;
  now?: () => number;
}

export class CodexService {
  private client: RpcClient | null = null;
  private starting: Promise<RpcClient> | null = null;
  private idle: NodeJS.Timeout | null = null;
  private loginId: string | null = null;
  /** provider-parity D3: sign-ins for the registry, each in its own app-server and temporary CODEX_HOME. */
  private readonly subLogins = new Map<string, { client: RpcClient; home: string }>();
  private models: CodexModel[] | null = null;
  status: ProviderStatus;

  constructor(private readonly d: CodexServiceDeps) {
    this.status = { id: 'codex', version: d.bin.version, login: 'unknown' };
  }

  /** The app-server of the service, started if needed. */
  private async rpc(): Promise<RpcClient> {
    this.touch();
    if (this.client?.alive) return this.client;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const t = this.d.transport ? this.d.transport() : spawnAppServer(this.d.bin, this.d.log);
      const c = new RpcClient(t, {
        log: this.d.log,
        onNotification: (method, params) => this.onNotification(method, params),
        onRequest: async method => {
          throw new RpcError(-32601, `${method} is not handled by the service process`);
        },
      });
      void c.exited.then(() => {
        if (this.client === c) this.client = null;
      });
      await initialize(c, this.d.agentVersion);
      this.client = c;
      return c;
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private touch(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      if (this.loginId) return this.touch();
      this.client?.close();
      this.client = null;
    }, IDLE_MS);
    this.idle.unref?.();
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    if (method === 'account/login/completed') {
      const id = typeof params.loginId === 'string' ? params.loginId : this.loginId;
      const ok = params.success === true;
      const error = typeof params.error === 'string' ? params.error.slice(0, 500) : undefined;
      if (id && id === this.loginId) {
        this.loginId = null;
        this.d.log.info('codex sign-in ended', { ok });
        this.d.onLoginDone(id, ok, ok ? undefined : (error ?? 'sign-in did not complete'));
      }
      void this.refresh();
    } else if (method === 'account/updated') {
      void this.refresh();
    }
  }

  /** account/read → the status of the machine's sign-in (email and plan; never a token). */
  async refresh(): Promise<ProviderStatus> {
    let login: ProviderLogin = 'unknown';
    let account: ProviderStatus['account'];
    try {
      const c = await this.rpc();
      const r = await c.request<{ account: { type?: string; email?: string | null; planType?: string | null } | null; requiresOpenaiAuth?: boolean }>('account/read', { refreshToken: false }, 30_000);
      if (r.account) {
        login = 'ok';
        account = { email: r.account.email ?? null, plan: r.account.planType ?? r.account.type ?? null };
      } else login = 'missing';
    } catch (err) {
      this.d.log.warn('codex account status failed', { error: (err as Error).message });
    }
    let models: CodexModel[] = [];
    if (login === 'ok') models = await this.listModels().catch(() => []);
    const next: ProviderStatus = { id: 'codex', version: this.d.bin.version, login, ...(account ? { account } : {}), ...(models.length ? { models: models.slice(0, 50) } : {}) };
    const changed = JSON.stringify(next) !== JSON.stringify(this.status);
    this.status = next;
    if (changed) this.d.onStatus(next);
    return next;
  }

  /** After a turn failed with an authorization error: the sign-in is no longer valid. */
  markRejected(): void {
    if (this.status.login === 'rejected') return;
    this.status = { id: 'codex', version: this.d.bin.version, login: 'rejected' };
    this.d.onStatus(this.status);
  }

  async loginStart(): Promise<ProviderLoginStart> {
    const c = await this.rpc();
    if (this.loginId) await c.request('account/login/cancel', { loginId: this.loginId }, 15_000).catch(() => undefined);
    const r = await c.request<{ type: string; loginId?: string; verificationUrl?: string; userCode?: string }>('account/login/start', { type: 'chatgptDeviceCode' }, 60_000);
    if (r.type !== 'chatgptDeviceCode' || !r.loginId || !r.verificationUrl || !r.userCode) throw new Error('the CLI returned no device code');
    this.loginId = r.loginId;
    this.d.log.info('codex sign-in started');
    return { loginId: r.loginId, verificationUrl: r.verificationUrl, userCode: r.userCode, expiresAt: (this.d.now?.() ?? Date.now()) + DEVICE_CODE_TTL_MS };
  }

  /** A device-code sign-in in a temporary CODEX_HOME: the machine's own sign-in is not touched; the auth.json goes to the hub. */
  async loginStartForSubscription(): Promise<ProviderLoginStart> {
    const homes = this.d.homes;
    if (!homes) throw new Error('subscriptions are not supported by this agent');
    const home = await homes.tempHome();
    let c: RpcClient | null = null;
    try {
      const t = this.d.transport ? this.d.transport() : spawnAppServer(this.d.bin, this.d.log, [], home);
      let loginId: string | null = null;
      const client = new RpcClient(t, {
        log: this.d.log,
        onNotification: (method, params) => {
          if (method !== 'account/login/completed') return;
          const id = typeof params.loginId === 'string' ? params.loginId : loginId;
          if (!id || id !== loginId) return;
          const ok = params.success === true;
          const error = typeof params.error === 'string' ? params.error.slice(0, 500) : undefined;
          void this.finishSubscriptionLogin(id, ok, error);
        },
        onRequest: async method => {
          throw new RpcError(-32601, `${method} is not handled by the sign-in process`);
        },
      });
      c = client;
      await initialize(client, this.d.agentVersion);
      const r = await client.request<{ type: string; loginId?: string; verificationUrl?: string; userCode?: string }>('account/login/start', { type: 'chatgptDeviceCode' }, 60_000);
      if (r.type !== 'chatgptDeviceCode' || !r.loginId || !r.verificationUrl || !r.userCode) throw new Error('the CLI returned no device code');
      loginId = r.loginId;
      this.subLogins.set(loginId, { client, home });
      this.d.log.info('codex subscription sign-in started');
      return { loginId, verificationUrl: r.verificationUrl, userCode: r.userCode, expiresAt: (this.d.now?.() ?? Date.now()) + DEVICE_CODE_TTL_MS };
    } catch (err) {
      c?.close();
      await homes.dropTemp(home);
      throw err;
    }
  }

  private async finishSubscriptionLogin(loginId: string, ok: boolean, error?: string): Promise<void> {
    const entry = this.subLogins.get(loginId);
    if (!entry) return;
    this.subLogins.delete(loginId);
    const credential = ok ? await this.d.homes!.takeLogin(entry.home) : (await this.d.homes!.dropTemp(entry.home), null);
    entry.client.close();
    this.d.log.info('codex subscription sign-in ended', { ok });
    if (ok && !credential) this.d.onLoginDone(loginId, false, 'sign-in finished but no credentials were found');
    else this.d.onLoginDone(loginId, ok, ok ? undefined : (error ?? 'sign-in did not complete'), credential ?? undefined);
  }

  async loginCancel(loginId: string): Promise<void> {
    const sub = this.subLogins.get(loginId);
    if (sub) {
      this.subLogins.delete(loginId);
      await sub.client.request('account/login/cancel', { loginId }, 15_000).catch(() => undefined);
      sub.client.close();
      await this.d.homes?.dropTemp(sub.home);
      return;
    }
    if (this.loginId !== loginId) return;
    const c = await this.rpc();
    await c.request('account/login/cancel', { loginId }, 15_000).catch(() => undefined);
    this.loginId = null;
  }

  async logout(): Promise<ProviderStatus> {
    const c = await this.rpc();
    await c.request('account/logout', undefined, 30_000);
    this.d.log.info('codex signed out');
    return this.refresh();
  }

  /** model/list without hidden models; cached for the life of the agent. */
  async listModels(): Promise<CodexModel[]> {
    if (this.models) return this.models;
    const c = await this.rpc();
    const out: CodexModel[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const r: { data: Array<{ model?: string; id?: string; displayName?: string; hidden?: boolean }>; nextCursor: string | null } = await c.request('model/list', cursor ? { cursor } : {}, 30_000);
      for (const m of r.data) if (!m.hidden && (m.model ?? m.id)) out.push({ value: (m.model ?? m.id)!, displayName: m.displayName ?? (m.model ?? m.id)! });
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    if (out.length) this.models = out;
    return out;
  }

  /** The rate limits of the sign-in in `home` (a subscription): its own short-lived app-server. */
  async rateLimitsIn(home: string): Promise<RateLimitsResponse> {
    const t = this.d.transport ? this.d.transport() : spawnAppServer(this.d.bin, this.d.log, [], home);
    const c = new RpcClient(t, {
      log: this.d.log,
      onNotification: () => undefined,
      onRequest: async method => {
        throw new RpcError(-32601, `${method} is not handled by the limits process`);
      },
    });
    try {
      await initialize(c, this.d.agentVersion);
      return await c.request<RateLimitsResponse>('account/rateLimits/read', undefined, 30_000);
    } finally {
      c.close();
    }
  }

  /** thread/fork (design D11): a new thread with the history of the source; nothing runs. */
  async fork(threadId: string, cwd: string): Promise<string> {
    const c = await this.rpc();
    const r = await c.request<{ thread: { id: string } }>('thread/fork', { threadId, cwd, excludeTurns: true }, 60_000);
    return r.thread.id;
  }

  stop(): void {
    for (const [id, e] of this.subLogins) {
      e.client.close();
      void this.d.homes?.dropTemp(e.home);
      this.subLogins.delete(id);
    }
    if (this.idle) clearTimeout(this.idle);
    this.client?.close();
    this.client = null;
  }
}
