import { describe, expect, it } from 'vitest';
import { deviceLabel } from './device.js';

describe('deviceLabel', () => {
  it.each([
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 'Chrome · Windows'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0', 'Edge · Windows'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15', 'Safari · macOS'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1', 'Safari · iPhone'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0', 'Firefox · Linux'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36', 'Chrome · Android'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) AgentHub/0.1.4 Chrome/128.0.0.0 Electron/32.0.0 Safari/537.36', 'Agent Hub app · Windows'],
  ])('%s', (ua, label) => {
    expect(deviceLabel(ua)).toBe(label);
  });

  it('has a label without a User-Agent and keeps it short', () => {
    expect(deviceLabel(undefined)).toBe('Unknown device');
    expect(deviceLabel('  ')).toBe('Unknown device');
    expect(deviceLabel(`curl/8 ${'x'.repeat(500)}`).length).toBeLessThanOrEqual(100);
  });
});
