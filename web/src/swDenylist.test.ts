import { describe, expect, it } from 'vitest';
import { SW_NAVIGATE_DENYLIST } from './swDenylist';

const denied = (path: string) => SW_NAVIGATE_DENYLIST.some(re => re.test(path));

describe('service worker navigate denylist', () => {
  it('leaves server pages and routes to the hub', () => {
    for (const p of [
      '/invite/72KYbrLy',
      '/auth/login',
      '/auth/disabled',
      '/api/me',
      '/install.sh',
      '/install.ps1',
      '/agent/latest.json',
      '/enroll',
      '/healthz',
      '/mcp/oauth/callback',
      '/mcp/oauth/callback?code=c&state=s',
    ]) {
      expect(denied(p), p).toBe(true);
    }
  });

  it('serves the shell for app routes', () => {
    for (const p of ['/', '/s/abc', '/settings/users', '/settings/machines', '/agents', '/invites', '/mcpx']) {
      expect(denied(p), p).toBe(false);
    }
  });
});
