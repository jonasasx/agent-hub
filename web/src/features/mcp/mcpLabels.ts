import type { MessageKey } from '@agent-hub/shared';
import type { McpServerConfig } from '../../api/mcpRegistryTypes';
import { t } from '../../i18n';

/** An object of labels whose values are read through `t()` at the moment of access: a language switch shows at the next render. */
export function lazyLabels<K extends string>(keys: Record<K, MessageKey>): Record<K, string> {
  const labels = {} as Record<K, string>;
  for (const name of Object.keys(keys) as K[]) Object.defineProperty(labels, name, { enumerable: true, get: () => t(keys[name]) });
  return labels;
}

export const MCP_MODE_LABELS: Record<McpServerConfig['mode'], string> = lazyLabels({
  remote: 'mcp.mode.remote',
  'machine-shared': 'mcp.mode.machineShared',
  'per-session': 'mcp.mode.perSession',
});

export const MCP_STATUS_LABELS: Record<string, string> = lazyLabels<string>({
  stopped: 'mcp.status.stopped',
  starting: 'mcp.status.starting',
  ready: 'mcp.status.ready',
  'needs-secret': 'mcp.status.needsSecret',
  failed: 'mcp.status.failed',
  'validation-failed': 'mcp.status.validationFailed',
  checked: 'mcp.status.checked',
  connected: 'mcp.status.connected',
  'needs-login': 'mcp.status.needsLogin',
  pending: 'mcp.status.pending',
  'signed-in': 'mcp.status.signedIn',
  'refresh-error': 'mcp.status.refreshError',
  expired: 'mcp.status.expired',
  'not-required': 'mcp.status.notRequired',
  draft: 'mcp.status.draft',
  validating: 'mcp.status.validating',
  needs_auth: 'mcp.status.needsAuth',
  'saved-unchecked': 'mcp.status.savedUnchecked',
  enabled: 'mcp.status.enabled',
  disabled: 'mcp.status.disabled',
  inherit: 'mcp.status.inherit',
});

export function mcpStatusTone(status: string): 'ok' | 'warn' | 'bad' | 'neutral' {
  if (['ready', 'checked', 'connected', 'signed-in', 'enabled'].includes(status)) return 'ok';
  if (['starting', 'pending', 'needs-secret', 'needs-login', 'expired', 'needs_auth'].includes(status)) return 'warn';
  if (['failed', 'validation-failed', 'refresh-error', 'disabled'].includes(status)) return 'bad';
  return 'neutral';
}

export function mcpStatusLabel(status: string): string {
  return MCP_STATUS_LABELS[status] ?? status;
}
