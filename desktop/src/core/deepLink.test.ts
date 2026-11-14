// Requirement: Один экземпляр и deep links; Автозапуск (--hidden).
import { describe, expect, it } from 'vitest';
import { findDeepLinkArg, hasHiddenFlag, launchAction, parseDeepLink } from './deepLink.js';

const ID = 'dd346743-9bbb-5c33-a0c4-38db15ed5df6';

describe('parseDeepLink', () => {
  it('agenthub://s/<uuid> → session (case-insensitive id, trailing slash tolerated)', () => {
    expect(parseDeepLink(`agenthub://s/${ID}`)).toEqual({ kind: 'session', id: ID });
    expect(parseDeepLink(`agenthub://s/${ID.toUpperCase()}`)).toEqual({ kind: 'session', id: ID });
    expect(parseDeepLink(`agenthub://s/${ID}/`)).toEqual({ kind: 'session', id: ID });
  });
  it('Невалидная ссылка → null', () => {
    for (const raw of [
      'agenthub://s/../../etc',
      'agenthub://s/%2e%2e/etc',
      'agenthub://evil',
      `agenthub://s/${ID}/x`,
      'agenthub://s/not-a-uuid',
      `agenthub://s/${ID}?x=1`,
      `agenthub://user:pw@s/${ID}`,
      `https://s/${ID}`,
      'agenthub:',
      '',
      `agenthub://s/${ID}`.padEnd(2049, 'a'),
    ]) {
      expect(parseDeepLink(raw), raw).toBeNull();
    }
  });
  it('agenthub://auth?code&state → auth; without one of them → null', () => {
    expect(parseDeepLink('agenthub://auth?code=abc_DEF-1&state=st4te')).toEqual({ kind: 'auth', code: 'abc_DEF-1', state: 'st4te' });
    expect(parseDeepLink('agenthub://auth/?code=a&state=b')).toEqual({ kind: 'auth', code: 'a', state: 'b' });
    expect(parseDeepLink('agenthub://auth?code=a')).toBeNull();
    expect(parseDeepLink('agenthub://auth?state=b')).toBeNull();
    expect(parseDeepLink('agenthub://auth/x?code=a&state=b')).toBeNull();
  });
});

describe('agenthub://connect', () => {
  it('a valid hub origin → connect', () => {
    expect(parseDeepLink('agenthub://connect?hub=https%3A%2F%2Fhub.example.com')).toEqual({ kind: 'connect', hub: 'https://hub.example.com' });
    expect(parseDeepLink('agenthub://connect/?hub=https%3A%2F%2Fhub.example.com%3A8443')).toEqual({ kind: 'connect', hub: 'https://hub.example.com:8443' });
  });
  it('no hub, an invalid hub or an extra path → null', () => {
    expect(parseDeepLink('agenthub://connect')).toBeNull();
    expect(parseDeepLink('agenthub://connect?hub=javascript%3Aalert(1)')).toBeNull();
    expect(parseDeepLink('agenthub://connect?hub=http%3A%2F%2Fhub.example.com')).toBeNull();
    expect(parseDeepLink('agenthub://connect/x?hub=https%3A%2F%2Fhub.example.com')).toBeNull();
  });
});

describe('single-instance argv', () => {
  it('finds the link among Chromium/Electron arguments', () => {
    const argv = ['C:\\Program Files\\Agent Hub\\Agent Hub.exe', '--allow-file-access-from-files', `agenthub://s/${ID}`];
    expect(findDeepLinkArg(argv)).toBe(`agenthub://s/${ID}`);
    expect(launchAction(argv)).toEqual({ kind: 'link', link: { kind: 'session', id: ID } });
  });
  it('invalid link is reported as ignored, not shown as a session', () => {
    expect(launchAction(['app.exe', 'agenthub://evil'])).toEqual({ kind: 'ignoredLink' });
  });
  it('--hidden (autostart) vs plain start', () => {
    expect(hasHiddenFlag(['app.exe', '--hidden'])).toBe(true);
    expect(launchAction(['app.exe', '--hidden'])).toEqual({ kind: 'hidden' });
    expect(launchAction(['app.exe'])).toEqual({ kind: 'show' });
    // A link wins over --hidden: the user asked for a session.
    expect(launchAction(['app.exe', '--hidden', `agenthub://s/${ID}`]).kind).toBe('link');
  });
});
