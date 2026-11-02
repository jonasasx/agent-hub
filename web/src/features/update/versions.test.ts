// change client-versions: build description helpers (D1, D6) and the desktop app version from the user-agent (D7).
import { describe, expect, it } from 'vitest';
import { buildKey, formatBuild, isBuildInfo, sameBuild } from './buildInfo';
import { desktopVersion } from './desktopVersion';

describe('buildInfo', () => {
  const a = { version: '0.1.0', commit: '72d9dc7', builtAt: '2026-10-28T04:17:07Z' };

  it('checks the shape of /version.json', () => {
    expect(isBuildInfo(a)).toBe(true);
    expect(isBuildInfo({ ...a, commit: 'dev' })).toBe(true);
    expect(isBuildInfo({ ...a, commit: 'XYZ' })).toBe(false);
    expect(isBuildInfo({ ...a, builtAt: 'nope' })).toBe(false);
    expect(isBuildInfo('<!doctype html>')).toBe(false);
  });

  it('compares by commit, dev builds by time; keys follow the same rule', () => {
    expect(sameBuild(a, { ...a, builtAt: '2026-10-29T00:00:00Z' })).toBe(true);
    expect(sameBuild({ ...a, commit: 'dev' }, { ...a, commit: 'dev', builtAt: '2026-10-29T00:00:00Z' })).toBe(false);
    expect(buildKey(a)).toBe('72d9dc7');
    expect(buildKey({ ...a, commit: 'dev' })).toBe('dev@2026-10-28T04:17:07Z');
  });

  it('formats «version · commit · dd.mm hh:mm» in the browser’s zone', () => {
    const local = new Date(2026, 9, 28, 7, 17).toISOString();
    expect(formatBuild({ ...a, builtAt: local })).toBe('0.1.0 · 72d9dc7 · 28.10 07:17');
  });
});

describe('desktopVersion', () => {
  it('the user-agent of the desktop window from task 1.1 — 0.1.1', () => {
    expect(desktopVersion('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) AgentHub/0.1.1 Chrome/156.0.8078.48 Electron/45.0.0 Safari/537.36')).toBe('0.1.1');
  });

  it('plain Chrome, Safari and a token without Electron — no app', () => {
    expect(desktopVersion('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36')).toBeNull();
    expect(desktopVersion('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toBeNull();
    expect(desktopVersion('Mozilla/5.0 AgentHub/0.1.3 Chrome/141.0.0.0 Safari/537.36')).toBeNull();
    expect(desktopVersion('Mozilla/5.0 Chrome/156.0 Electron/45.0.0 Safari/537.36')).toBeNull();
  });
});
