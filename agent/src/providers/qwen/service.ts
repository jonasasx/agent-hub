// The status of the Qwen endpoint (change qwen-provider, design D2): there is no sign-in, «ok» means that
// GET <base>/models answers 200 to the key of agent.env. The models come from the same answer. The key stays in this
// process and in the environment of the CLI; it is never part of a status, a log line or a message to the hub.
import type { ProviderLogin, ProviderStatus } from '@agent-hub/shared';
import type { QwenConfig } from '../../config.js';
import type { Logger } from '../../log.js';

/** The answer of /models is reused for this long; a failed turn or a refresh with `force` skips it. */
export const STATUS_TTL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 5_000;
const MODELS_MAX = 50;

export interface QwenModel {
  value: string;
  displayName: string;
}

export interface QwenServiceDeps {
  config: QwenConfig;
  log: Logger;
  /** Version of the SDK package (null when it is not installed: the status stays «unknown»). */
  version: string | null;
  /** false — the package is missing; the endpoint is not asked. */
  sdkAvailable?: boolean;
  onStatus: (s: ProviderStatus) => void;
  /** Tests: a fake fetch. */
  fetch?: typeof fetch;
  now?: () => number;
}

/** A text without the value of the key (errors of the SDK and of the server can repeat it). */
export function redactKey(text: string, key: string): string {
  return key ? text.split(key).join('•••') : text;
}

export class QwenService {
  status: ProviderStatus;
  private models: QwenModel[] = [];
  private checkedAt = 0;
  private inflight: Promise<ProviderStatus> | null = null;

  constructor(private readonly d: QwenServiceDeps) {
    this.status = { id: 'qwen', version: d.version, login: 'unknown' };
  }

  private clock(): number {
    return this.d.now?.() ?? Date.now();
  }

  private modelsUrl(): string {
    return `${this.d.config.baseUrl}/models`;
  }

  /** GET /models → the status; cached for STATUS_TTL_MS, concurrent calls share one request. */
  refresh(force = false): Promise<ProviderStatus> {
    if (!force && this.checkedAt && this.clock() - this.checkedAt < STATUS_TTL_MS) return Promise.resolve(this.status);
    if (!this.inflight) {
      this.inflight = this.check().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async check(): Promise<ProviderStatus> {
    let login: ProviderLogin = 'unknown';
    let models: QwenModel[] = [];
    if (this.d.sdkAvailable === false) {
      this.d.log.warn('qwen is configured but @qwen-code/sdk is not installed next to the agent');
    } else {
      try {
        const res = await (this.d.fetch ?? fetch)(this.modelsUrl(), {
          headers: { Authorization: `Bearer ${this.d.config.apiKey}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (res.status === 200) {
          login = 'ok';
          models = this.parseModels(await res.json().catch(() => null));
        } else if (res.status === 401 || res.status === 403) {
          login = 'rejected';
        } else {
          this.d.log.warn('qwen endpoint answered with an unexpected status', { status: res.status });
        }
      } catch (err) {
        this.d.log.warn('qwen endpoint is not reachable', { error: redactKey(err instanceof Error ? err.message : String(err), this.d.config.apiKey) });
      }
    }
    this.checkedAt = this.clock();
    this.models = models;
    const next: ProviderStatus = { id: 'qwen', version: this.d.version, login, ...(models.length ? { models } : {}) };
    const changed = JSON.stringify(next) !== JSON.stringify(this.status);
    this.status = next;
    if (changed) this.d.onStatus(next);
    return next;
  }

  /** data[].id of the OpenAI model list; QWEN_MODEL (when the server has it) goes first. */
  private parseModels(body: unknown): QwenModel[] {
    const data = (body as { data?: unknown } | null)?.data;
    const ids = Array.isArray(data) ? data.flatMap(m => (typeof (m as { id?: unknown })?.id === 'string' && (m as { id: string }).id ? [(m as { id: string }).id] : [])) : [];
    const unique = [...new Set(ids)];
    const preferred = this.d.config.model;
    if (preferred && unique.includes(preferred)) unique.sort((a, b) => Number(b === preferred) - Number(a === preferred));
    return unique.slice(0, MODELS_MAX).map(id => ({ value: id, displayName: id }));
  }

  /** The models of the last status (what session.start answers with). */
  listModels(): QwenModel[] {
    return this.models;
  }

  /** After a turn failed with 401/403 the key is not valid any more. */
  markRejected(): void {
    if (this.status.login === 'rejected') return;
    this.status = { id: 'qwen', version: this.d.version, login: 'rejected' };
    this.models = [];
    this.d.onStatus(this.status);
  }
}
