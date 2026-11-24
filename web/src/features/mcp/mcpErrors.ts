import type { McpServerGatewayIssue } from '@agent-hub/shared';
import { t } from '../../i18n';

export type McpTransport = 'stdio' | 'http' | 'sse';

export interface McpErrorMessage {
  message: string;
  details: string;
}

export interface McpGatewayMessage extends McpErrorMessage {
  /** mcp-gateway-session-limits: next steps of a limit refusal, in the order of the spec. */
  hints: string[];
}

export function mcpErrorMessage(error: unknown, transport: McpTransport): McpErrorMessage {
  const details = errorText(error);
  const status = details.match(/\bHTTP\s+(\d{3})\b/i)?.[1];
  const timeoutSeconds = getTimeoutSeconds(details);
  const missingCommand = getMissingCommand(details);
  const exitCode = details.match(/(?:process\s+)?exited with code\s+(-?\d+)/i)?.[1];

  if (transport !== 'stdio' && status && (status === '404' || Number(status) >= 500)) {
    return { message: t('mcp.error.httpNotMcp', { status }), details };
  }

  if (timeoutSeconds) {
    const message = t('mcp.error.timeout', { seconds: timeoutSeconds });
    return {
      message,
      details: details === message ? '' : details,
    };
  }

  if (missingCommand) {
    return { message: t('mcp.error.noCommand', { command: missingCommand }), details };
  }

  if (exitCode) return { message: t('mcp.error.exitCode', { code: exitCode }), details };

  if (status === '401' || status === '403') return { message: t('mcp.error.accessDenied'), details };

  if (transport === 'stdio' && status) {
    return { message: t('mcp.error.processFailed'), details };
  }

  const message = details || t('mcp.error.failed');
  return { message, details: message === details ? '' : details };
}

/**
 * Причина ошибки сервера реестра в панели сессии: the machine gateway's reason, with the machine and the next step.
 * mcp-gateway-session-limits: a refusal with `reason` names the limit and its use; a limit refusal adds three hints.
 */
export function mcpGatewayMessage(gateway: McpServerGatewayIssue, machine: string, server: string): McpGatewayMessage {
  const details = gateway.error ?? '';
  if (gateway.status === 'needs-secret') return { message: t('mcp.gateway.needsSecret', { machine }), details, hints: [] };
  const reason = gateway.reason;
  if (reason?.kind === 'server-limit' || reason?.kind === 'machine-limit') {
    const count = reason.limit ?? reason.inUse ?? 0;
    const head = reason.kind === 'server-limit' ? t('mcp.gateway.serverLimit', { machine, server, count }) : t('mcp.gateway.machineLimit', { machine, count });
    const inUse = reason.inUse !== undefined && reason.inUse !== reason.limit ? ` ${t('mcp.gateway.inUse', { inUse: reason.inUse })}` : '';
    const hints = [t('mcp.gateway.hint.shared'), t('mcp.gateway.hint.sleep', { server }), t('mcp.gateway.hint.raise')];
    return { message: `${head}.${inUse}`, details, hints };
  }
  if (reason?.kind === 'backoff') return { message: t('mcp.gateway.backoff', { machine }), details, hints: [] };
  if (reason?.kind === 'restart-limit') return { message: t('mcp.gateway.restartLimit', { machine }), details, hints: [] };
  if (reason?.kind === 'unavailable') return { message: t('mcp.gateway.unavailable', { machine }), details, hints: [] };
  if (reason?.kind === 'upstream') return { message: upstreamMessage(reason.httpStatus, machine), details, hints: [] };
  const command = getMissingCommand(details);
  if (command) return { message: t('mcp.gateway.noCommand', { machine, command }), details, hints: [] };
  const parsed = mcpErrorMessage(gateway.error, 'http');
  return { message: t('mcp.gateway.failed', { machine, message: parsed.message }), details: parsed.details, hints: [] };
}

/** mcp-remote-upstream-errors: the answer of a remote server to the machine gateway; no status — the address did not answer. */
function upstreamMessage(status: number | undefined, machine: string): string {
  if (status === undefined) return t('mcp.gateway.upstreamUnreachable', { machine });
  if (status === 401 || status === 403) return t('mcp.gateway.upstreamDenied', { machine, status });
  if (status === 502 || status === 503 || status === 504) return t('mcp.gateway.upstreamUnavailable', { machine, status });
  return t('mcp.gateway.upstreamError', { machine, status });
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const serverMessage = 'serverMessage' in error && typeof error.serverMessage === 'string' ? error.serverMessage : '';
    return serverMessage || error.message || t('mcp.error.failed');
  }

  if (typeof error === 'string') return error || t('mcp.error.failed');
  return error == null ? t('mcp.error.failed') : String(error);
}

function getTimeoutSeconds(details: string): string | null {
  if (!/timeout|timed out/i.test(details)) return null;
  const milliseconds = details.match(/(\d+)\s*ms\b/i)?.[1];
  if (milliseconds) return String(Math.max(1, Math.round(Number(milliseconds) / 1000)));
  return details.match(/\b(\d+)\s*(?:sec(?:ond)?s?|s)(?![a-z])/i)?.[1] ?? null;
}

function getMissingCommand(details: string): string | null {
  const explicit = details.match(/command not found:\s*([^\s,;]+)/i)?.[1];
  if (explicit) return explicit;
  return details.match(/spawn\s+([^\s]+)\s+ENOENT/i)?.[1] ?? null;
}
