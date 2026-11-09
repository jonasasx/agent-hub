import { describe, expect, it } from 'vitest';
import { isSafePushEndpoint } from './endpoint.js';

describe('isSafePushEndpoint', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/QGx',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
    'https://push.example.com:443/send',
  ])('accepts %s', url => {
    expect(isSafePushEndpoint(url)).toBe(true);
  });

  it.each([
    ['http scheme', 'http://fcm.googleapis.com/x'],
    ['not a url', 'not a url'],
    ['empty', ''],
    ['ftp', 'ftp://push.example.com/x'],
    ['custom port', 'https://push.example.com:8443/x'],
    ['ipv4 literal', 'https://10.0.0.3/x'],
    ['public ipv4 literal', 'https://8.8.8.8/x'],
    ['ipv6 literal', 'https://[::1]/x'],
    ['localhost', 'https://localhost/x'],
    ['subdomain of localhost', 'https://a.localhost/x'],
    ['.local', 'https://printer.local/x'],
    ['.lan', 'https://nas.lan/x'],
    ['.internal', 'https://hub.internal/x'],
    ['.localdomain', 'https://host.localdomain/x'],
    ['no dot', 'https://intranet/x'],
    ['credentials', 'https://user:pass@push.example.com/x'],
    ['too long', `https://push.example.com/${'a'.repeat(2100)}`],
  ])('rejects %s', (_name, url) => {
    expect(isSafePushEndpoint(url)).toBe(false);
  });
});
