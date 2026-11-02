// Why a turn failed, as far as the subscription or the account is concerned (claude-subscriptions design P5).
// Requirements: Исчерпан лимит подписки; Токен отклонён; Учёт ходов и расход по подпискам.
import * as sdk from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { TurnFailure, TurnUsage } from '@agent-hub/shared';

/** Used when the SDK stops exporting the list (it is marked @alpha): the prefixes of SDK 0.3.310. */
const FALLBACK_LIMIT_PREFIXES: readonly string[] = [
  "You've hit your",
  "You've reached your",
  "You're out of usage credits",
  'Your org is out of usage',
  "Your seat type doesn't include usage",
  'Your usage allocation has been disabled by your admin',
  "Your group's usage limit is set to $0",
  "You're out of extra usage",
  "Your seat type doesn't include extra usage",
];

/** The SDK's prefixes of usage-limit errors (`USAGE_LIMIT_ERROR_PREFIXES`), else the local copy. */
export const LIMIT_PREFIXES: readonly string[] = (sdk as { USAGE_LIMIT_ERROR_PREFIXES?: readonly string[] }).USAGE_LIMIT_ERROR_PREFIXES ?? FALLBACK_LIMIT_PREFIXES;

/**
 * The SDK's error when a turn ended with an error result (auth failure, a limit, …): the process is gone, not crashed.
 * SDK 0.3.310 Query.readMessages: after a result with is_error the CLI exits non-zero and the SDK replaces the exit error
 * with Error(«Claude Code returned an error result: <text>») — the iterator throws after it has yielded that result.
 */
export const ERROR_RESULT_THROW = /^Claude Code returned an error result/;

const ACCOUNT_ERRORS = new Set(['billing_error', 'account_on_hold', 'oauth_org_not_allowed', 'verification_required']);

/** What one turn told about its failure before its result (reset on every result). */
export interface TurnSignals {
  /** rate_limit_event with status 'rejected'. */
  rateLimitRejected?: { resetsAt?: number; limitType?: string };
  /** SDKAssistantMessage.error of the main loop (parent_tool_use_id null) and the text of that message. */
  assistantError?: { error: string; text?: string };
}

/** Collects the signals of the turn from one SDK message; api_retry (a temporary error the CLI retries) is ignored. */
export function collectSignal(signals: TurnSignals, m: SDKMessage): void {
  if (m.type === 'rate_limit_event') {
    const info = (m as { rate_limit_info?: { status?: string; resetsAt?: number; rateLimitType?: string } }).rate_limit_info;
    if (info?.status === 'rejected') {
      signals.rateLimitRejected = {
        ...(typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt) ? { resetsAt: info.resetsAt } : {}),
        ...(typeof info.rateLimitType === 'string' ? { limitType: info.rateLimitType } : {}),
      };
    }
    return;
  }
  if (m.type === 'assistant') {
    const a = m as { error?: unknown; parent_tool_use_id?: string | null; message?: { content?: unknown } };
    if (typeof a.error !== 'string' || a.parent_tool_use_id) return;
    const content = Array.isArray(a.message?.content) ? (a.message.content as Array<{ type?: string; text?: unknown }>) : [];
    const text = content.find(b => b.type === 'text' && typeof b.text === 'string')?.text as string | undefined;
    signals.assistantError = { error: a.error, ...(text ? { text } : {}) };
  }
}

/** The part of SDKResultMessage the classification reads. */
export interface ResultLike {
  is_error?: boolean;
  result?: unknown;
  api_error_status?: number | null;
  terminal_reason?: string | null;
  usage?: Record<string, unknown> | null;
}

const startsWithLimit = (text: string | undefined): boolean => !!text && LIMIT_PREFIXES.some(p => text.trimStart().startsWith(p));

/** rate_limit_event.resetsAt is in seconds (seen on SDK 0.3.310); a value ≥ 10¹² is taken as milliseconds already. */
export function resetsAtMs(v: number | undefined): number | undefined {
  if (v === undefined || !Number.isFinite(v) || v <= 0) return undefined;
  return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
}

const clip = (s: string | undefined) => (s ? s.slice(0, 2000) : undefined);

/** The table of design P5: subscription_limit, auth_rejected, account_unavailable, or none. */
export function classifyFailure(signals: TurnSignals, result: ResultLike): TurnFailure | undefined {
  const err = signals.assistantError?.error;
  const resultText = typeof result.result === 'string' ? result.result : undefined;
  const rejected = signals.rateLimitRejected;
  const limit =
    (err === 'rate_limit' && (!!rejected || startsWithLimit(signals.assistantError?.text))) ||
    (result.is_error === true && startsWithLimit(resultText)) ||
    (result.terminal_reason === 'blocking_limit' && !!rejected);
  if (limit) {
    const resetsAt = resetsAtMs(rejected?.resetsAt);
    const message = clip(signals.assistantError?.text ?? resultText);
    return {
      kind: 'subscription_limit',
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      ...(rejected?.limitType ? { limitType: rejected.limitType.slice(0, 64) } : {}),
      ...(message ? { message } : {}),
    };
  }
  if (err === 'authentication_failed' || result.api_error_status === 401) {
    const message = clip(signals.assistantError?.text ?? resultText);
    return { kind: 'auth_rejected', ...(message ? { message } : {}) };
  }
  if (err && ACCOUNT_ERRORS.has(err)) {
    const message = clip(signals.assistantError?.text ?? resultText);
    return { kind: 'account_unavailable', ...(message ? { message } : {}) };
  }
  return undefined;
}

const tokens = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/** Tokens of the turn from result.usage (the main loop only); missing fields are 0. */
export function turnUsage(usage: Record<string, unknown> | null | undefined): TurnUsage {
  return {
    inputTokens: tokens(usage?.input_tokens),
    outputTokens: tokens(usage?.output_tokens),
    cacheReadTokens: tokens(usage?.cache_read_input_tokens),
    cacheCreationTokens: tokens(usage?.cache_creation_input_tokens),
  };
}
