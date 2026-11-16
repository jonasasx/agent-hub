// The Qwen Code SDK behind a narrow interface (change qwen-provider, design D8): the package is an optional dependency
// of the agent loaded by a dynamic import, so an agent without it still runs and reports Qwen as unavailable. The
// types below are the part of @qwen-code/sdk 0.1.x the provider uses; tests substitute a fake of this interface.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export type QwenPermissionMode = 'default' | 'plan' | 'auto-edit' | 'auto' | 'yolo';

export type QwenContentBlock = Record<string, unknown>;

export interface QwenUserMessage {
  type: 'user';
  uuid?: string;
  session_id: string;
  message: { role: 'user'; content: string | QwenContentBlock[] };
  parent_tool_use_id: null;
}

export interface QwenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** A message of the SDK stream; only the fields the provider reads are typed. */
export interface QwenMessage {
  type: 'system' | 'assistant' | 'user' | 'result' | 'stream_event' | string;
  subtype?: string;
  uuid?: string;
  session_id?: string;
  parent_tool_use_id?: string | null;
  model?: string;
  message?: { id?: string; model?: string; content?: string | QwenContentBlock[]; usage?: QwenUsage };
  event?: { type?: string; index?: number; delta?: { type?: string; text?: string }; message?: { id?: string } };
  is_error?: boolean;
  duration_ms?: number;
  result?: string;
  usage?: QwenUsage;
  modelUsage?: Record<string, { contextWindow?: number; inputTokens?: number }>;
  error?: { message?: string; type?: string };
}

export type QwenPermissionResult = { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string; interrupt?: boolean };

export type QwenCanUseTool = (toolName: string, input: Record<string, unknown>, options: { signal: AbortSignal; suggestions?: unknown[] | null }) => Promise<QwenPermissionResult>;

export interface QwenQuery extends AsyncIterable<QwenMessage> {
  readonly initialized: Promise<void>;
  interrupt(): Promise<void>;
  setPermissionMode(mode: QwenPermissionMode): Promise<void>;
  setModel(model: string): Promise<void>;
  endInput(): void;
  close(): Promise<void>;
}

export interface QwenQueryOptions {
  cwd: string;
  model?: string;
  env?: Record<string, string>;
  systemPrompt?: string | { type: 'preset'; preset: 'qwen_code'; append?: string };
  permissionMode?: QwenPermissionMode;
  canUseTool?: QwenCanUseTool;
  mcpServers?: Record<string, unknown>;
  abortController?: AbortController;
  resume?: string;
  sessionId?: string;
  forkSession?: boolean;
  timeout?: { canUseTool?: number };
  includePartialMessages?: boolean;
  authType?: 'openai';
  stderr?: (message: string) => void;
}

/** A client tool of the SDK MCP server (zod raw shape, handler with MCP content). */
export interface QwenToolDef {
  name: string;
  description: string;
  shape: Record<string, unknown>;
  run: (args: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>;
}

export interface QwenSdk {
  query(args: { prompt: string | AsyncIterable<QwenUserMessage>; options: QwenQueryOptions }): QwenQuery;
  /** An in-process MCP server for `mcpServers` with the given tools. */
  mcpServer(name: string, tools: QwenToolDef[]): unknown;
}

/** The real SDK: `import('@qwen-code/sdk')`; throws when the package is not installed next to the agent. */
export async function loadQwenSdk(): Promise<QwenSdk> {
  const mod = (await import('@qwen-code/sdk')) as unknown as {
    query: QwenSdk['query'];
    createSdkMcpServer: (o: { name: string; tools: unknown[] }) => unknown;
    tool: (name: string, description: string, shape: unknown, handler: (args: unknown) => Promise<unknown>) => unknown;
  };
  return {
    query: args => mod.query(args),
    mcpServer: (name, tools) => mod.createSdkMcpServer({ name, tools: tools.map(t => mod.tool(t.name, t.description, t.shape, a => t.run(a))) }),
  };
}

/** The version of the installed SDK package and of the CLI bundled in it; null when the package is missing. */
export function qwenPackageVersion(): { sdk: string; cli: string | null } | null {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve('@qwen-code/sdk/package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    let cli: string | null = null;
    try {
      cli = readFileSync(join(dirname(pkgPath), 'dist', 'BUNDLED_CLI_VERSION'), 'utf8').trim() || null;
    } catch {
      cli = null;
    }
    return { sdk: pkg.version ?? '0', cli };
  } catch {
    return null;
  }
}
