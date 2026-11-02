import { randomUUID } from 'node:crypto';
import type { McpDraftRequest, McpDraftResult } from '@agent-hub/shared';

export const MCP_DRAFT_TIMEOUT_MS = 120_000;
type DraftInput = McpDraftRequest extends infer Request ? (Request extends { requestId: string } ? Omit<Request, 'requestId'> : never) : never;

/** Correlates the dedicated draft messages; never logs payloads because add/update may contain secrets. */
export class McpDraftClient {
  private pending = new Map<string, { resolve: (result: McpDraftResult) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  constructor(
    private readonly send: (type: string, payload: unknown) => boolean,
    private readonly timeoutMs = MCP_DRAFT_TIMEOUT_MS,
  ) {}

  request(input: DraftInput): Promise<McpDraftResult> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('MCP draft request timed out'));
      }, this.timeoutMs);
      timer.unref();
      this.pending.set(requestId, { resolve, reject, timer });
      if (!this.send('mcp.draft.request', { ...input, requestId })) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new Error('MCP draft API is unavailable while the hub is disconnected'));
      }
    });
  }

  onResult(result: McpDraftResult): void {
    const request = this.pending.get(result.requestId);
    if (!request) return;
    this.pending.delete(result.requestId);
    clearTimeout(request.timer);
    request.resolve(result);
  }

  failAll(reason = 'hub connection lost'): void {
    for (const [id, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(new Error(reason));
      this.pending.delete(id);
    }
  }
}
