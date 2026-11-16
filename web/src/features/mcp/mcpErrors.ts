import type { McpServerGatewayIssue } from '@agent-hub/shared';
import { t } from '../../i18n';

export type McpTransport = 'stdio' | 'http' | 'sse';

export interface McpErrorMessage {
  message: string;
  details: string;
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

/** Причина ошибки сервера реестра в панели сессии: the machine gateway's reason, with the machine and the next step. */
export function mcpGatewayMessage(gateway: McpServerGatewayIssue, machine: string): McpErrorMessage {
  const details = gateway.error ?? '';
  if (gateway.status === 'needs-secret') return { message: t('mcp.gateway.needsSecret', { machine }), details };
  const command = getMissingCommand(details);
  if (command) return { message: t('mcp.gateway.noCommand', { machine, command }), details };
  const parsed = mcpErrorMessage(gateway.error, 'http');
  return { message: t('mcp.gateway.failed', { machine, message: parsed.message }), details: parsed.details };
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
