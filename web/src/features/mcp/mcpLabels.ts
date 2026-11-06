import type { McpServerConfig } from '../../api/mcpRegistryTypes';

export const MCP_MODE_LABELS: Record<McpServerConfig['mode'], string> = {
  remote: 'Удалённый',
  'machine-shared': 'Общий на машину',
  'per-session': 'На сессию',
};

export const MCP_STATUS_LABELS: Record<string, string> = {
  stopped: 'Остановлен',
  starting: 'Запускается',
  ready: 'Готов',
  'needs-secret': 'Нужен секрет',
  failed: 'Ошибка',
  'validation-failed': 'Проверка не пройдена',
  checked: 'Проверено',
  connected: 'Подключён',
  'needs-login': 'Нужен вход',
  pending: 'Ожидает входа',
  'signed-in': 'Вход выполнен',
  'refresh-error': 'Ошибка обновления токена',
  expired: 'Вход истёк',
  'not-required': 'Вход не требуется',
  draft: 'Черновик',
  validating: 'Проверяется',
  needs_auth: 'Нужен вход',
  'saved-unchecked': 'Сохранён без проверки',
  enabled: 'Включён',
  disabled: 'Выключен',
  inherit: 'Как в реестре',
};

export function mcpStatusTone(status: string): 'ok' | 'warn' | 'bad' | 'neutral' {
  if (['ready', 'checked', 'connected', 'signed-in', 'enabled'].includes(status)) return 'ok';
  if (['starting', 'pending', 'needs-secret', 'needs-login', 'expired', 'needs_auth'].includes(status)) return 'warn';
  if (['failed', 'validation-failed', 'refresh-error', 'disabled'].includes(status)) return 'bad';
  return 'neutral';
}

export function mcpStatusLabel(status: string): string {
  return MCP_STATUS_LABELS[status] ?? status;
}
