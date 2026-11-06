import { describe, expect, it } from 'vitest';
import { MCP_MODE_LABELS, MCP_STATUS_LABELS, mcpStatusLabel, mcpStatusTone } from './mcpLabels';

describe('MCP labels', () => {
  it('maps modes and machine statuses to user-facing labels', () => {
    expect(MCP_MODE_LABELS['per-session']).toBe('На сессию');
    expect(MCP_MODE_LABELS['machine-shared']).toBe('Общий на машину');
    expect(MCP_STATUS_LABELS.stopped).toBe('Остановлен');
    expect(mcpStatusLabel('validation-failed')).toBe('Проверка не пройдена');
  });

  it('assigns status tones for pills', () => {
    expect(mcpStatusTone('ready')).toBe('ok');
    expect(mcpStatusTone('starting')).toBe('warn');
    expect(mcpStatusTone('validation-failed')).toBe('bad');
  });
});
