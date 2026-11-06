import { describe, expect, it } from 'vitest';
import { mcpErrorMessage } from './mcpErrors';

describe('mcpErrorMessage', () => {
  it('explains timeouts and missing local commands in Russian', () => {
    expect(mcpErrorMessage(new Error('Connection timed out after 30000ms'), 'stdio').message).toContain('за 30 с');
    expect(mcpErrorMessage(new Error('HTTP 502: command not found: npx'), 'stdio').message).toContain('команды npx');
  });

  it('explains process exit and access errors', () => {
    expect(mcpErrorMessage(new Error('MCP server process exited with code 17'), 'stdio').message).toContain('кодом 17');
    expect(mcpErrorMessage(new Error('HTTP 401: Unauthorized'), 'http').message).toBe('Сервер отклонил доступ. Проверьте секрет.');
    expect(mcpErrorMessage(new Error('HTTP 403: Forbidden'), 'http').message).toBe('Сервер отклонил доступ. Проверьте секрет.');
  });

  it('shows HTTP address errors only for HTTP transports and keeps the source under details', () => {
    const httpFailure = mcpErrorMessage(new Error('HTTP 502: Bad Gateway'), 'http');
    expect(httpFailure.message).toBe('Адрес не отвечает как MCP-сервер (HTTP 502).');
    expect(httpFailure.details).toBe('HTTP 502: Bad Gateway');

    const stdioFailure = mcpErrorMessage(new Error('HTTP 502: Bad Gateway'), 'stdio');
    expect(stdioFailure.message).not.toContain('HTTP 502');
    expect(stdioFailure.details).toBe('HTTP 502: Bad Gateway');
  });

  it('does not invent timeout durations and prioritizes HTTP 504 responses', () => {
    const timeout = mcpErrorMessage(new Error('Connection timed out'), 'stdio');
    expect(timeout.message).toBe('Connection timed out');

    const gatewayTimeout = mcpErrorMessage(new Error('HTTP 504: Gateway Timeout'), 'http');
    expect(gatewayTimeout.message).toBe('Адрес не отвечает как MCP-сервер (HTTP 504).');

    const nonUnit = mcpErrorMessage(new Error('Request timeout after 3speed'), 'stdio');
    expect(nonUnit.message).toBe('Request timeout after 3speed');
  });

  it('uses a short message for an empty error', () => {
    expect(mcpErrorMessage(new Error(''), 'http').message).toBe('Не выполнено');
  });

  it('does not repeat an unrecognized error in details', () => {
    const error = mcpErrorMessage(new Error('Connection refused'), 'http');
    expect(error.message).toBe('Connection refused');
    expect(error.details).toBe('');
  });
});
