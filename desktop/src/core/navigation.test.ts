// Requirements: Навигация и внешние ссылки; Изоляция окна (design D3, D2).
import { describe, expect, it } from 'vitest';
import { decideNavigation, isPermissionAllowed, isPermissionCheckAllowed, safeReturnPath } from './navigation.js';

const HUB = 'https://hub.example.com';
const ID = 'dd346743-9bbb-5c33-a0c4-38db15ed5df6';

describe('decideNavigation', () => {
  it('hub pages are allowed', () => {
    expect(decideNavigation(`${HUB}/s/${ID}`, HUB)).toEqual({ kind: 'allow' });
    expect(decideNavigation(`${HUB}/`, HUB)).toEqual({ kind: 'allow' });
    expect(decideNavigation(`${HUB}/auth/logout`, HUB)).toEqual({ kind: 'allow' });
  });
  it('/auth/login → sign-in through the browser with the return path', () => {
    expect(decideNavigation(`${HUB}/auth/login?return=/s/${ID}`, HUB)).toEqual({ kind: 'login', returnPath: `/s/${ID}` });
    expect(decideNavigation(`${HUB}/auth/login`, HUB)).toEqual({ kind: 'login', returnPath: '/' });
    expect(decideNavigation(`${HUB}/auth/login?return=https://evil.example/`, HUB)).toEqual({ kind: 'login', returnPath: '/' });
  });
  it('Внешняя ссылка из чата → system browser', () => {
    expect(decideNavigation('https://gitlab.com/x', HUB)).toEqual({ kind: 'external', url: 'https://gitlab.com/x' });
    expect(decideNavigation('http://hub.example.com/', HUB).kind).toBe('external');
    expect(decideNavigation('https://hub.example.com:8443/', HUB).kind).toBe('external');
  });
  it('another host is external, and gets no permissions', () => {
    const OTHER = 'https://hub.internal.example.com';
    expect(decideNavigation(`${OTHER}/s/${ID}`, HUB).kind).toBe('external');
    expect(isPermissionAllowed('media', { hubOrigin: HUB, requestingUrl: `${OTHER}/`, mediaTypes: ['audio'] })).toBe(false);
  });
  it('other schemes are denied', () => {
    for (const u of ['javascript:alert(1)', 'file:///C:/', 'data:text/html,x', 'agenthub://s/x', 'ftp://x', 'not a url']) {
      expect(decideNavigation(u, HUB), u).toEqual({ kind: 'deny' });
    }
  });
  it('a local hub over http', () => {
    expect(decideNavigation('http://localhost:8080/s/x', 'http://localhost:8080')).toEqual({ kind: 'allow' });
  });
});

describe('safeReturnPath', () => {
  it('only own paths, never /auth/*', () => {
    expect(safeReturnPath('/s/abc?x=1')).toBe('/s/abc?x=1');
    expect(safeReturnPath('//evil.example/x')).toBe('/');
    expect(safeReturnPath('/\\evil.example')).toBe('/');
    expect(safeReturnPath('https://evil.example')).toBe('/');
    expect(safeReturnPath('/auth/login')).toBe('/');
    expect(safeReturnPath('/auth')).toBe('/');
    expect(safeReturnPath(null)).toBe('/');
  });
});

describe('permissions', () => {
  it('only clipboard write and fullscreen', () => {
    expect(isPermissionAllowed('clipboard-sanitized-write')).toBe(true);
    expect(isPermissionAllowed('fullscreen')).toBe(true);
    for (const p of ['notifications', 'media', 'geolocation', 'clipboard-read', 'openExternal']) expect(isPermissionAllowed(p)).toBe(false);
  });

  // Requirement: Микрофон в десктоп-приложении (change voice-input, D8).
  describe('media: sound only, from the hub', () => {
    const page = `${HUB}/s/${ID}`;
    const req = (mediaTypes: string[], requestingUrl = page) => isPermissionAllowed('media', { hubOrigin: HUB, requestingUrl, mediaTypes });
    const check = (mediaType: string, requestingUrl = HUB) => isPermissionAllowed('media', { hubOrigin: HUB, requestingUrl, mediaType });

    it('audio from the hub page — allowed (request and check handler)', () => {
      expect(req(['audio'])).toBe(true);
      expect(check('audio')).toBe(true);
      expect(check('audio', `${HUB}/`)).toBe(true);
    });
    it('video, audio+video, an empty list, unknown — refused', () => {
      expect(req(['video'])).toBe(false);
      expect(req(['audio', 'video'])).toBe(false);
      expect(req([])).toBe(false);
      expect(check('video')).toBe(false);
      expect(check('unknown')).toBe(false);
      expect(isPermissionAllowed('media', { hubOrigin: HUB, requestingUrl: page })).toBe(false);
    });
    it('a foreign origin, a missing or broken origin, no hub origin — refused', () => {
      expect(req(['audio'], 'https://evil.example/s/1')).toBe(false);
      expect(req(['audio'], 'http://hub.example.com/')).toBe(false);
      expect(check('audio', 'https://hub.example.com.evil.example')).toBe(false);
      expect(isPermissionAllowed('media', { hubOrigin: HUB, mediaTypes: ['audio'] })).toBe(false);
      expect(req(['audio'], 'not a url')).toBe(false);
      expect(isPermissionAllowed('media', { requestingUrl: page, mediaTypes: ['audio'] })).toBe(false);
    });
    describe('check handler (isPermissionCheckAllowed)', () => {
      const chk = (mediaType: string | undefined, requestingUrl = `${HUB}/`) => isPermissionCheckAllowed('media', { hubOrigin: HUB, requestingUrl, ...(mediaType === undefined ? {} : { mediaType }) });
      it('the hub origin: audio and a check without a type (Chromium after a granted request) — allowed', () => {
        expect(chk('audio')).toBe(true);
        expect(chk(undefined)).toBe(true);
        expect(chk(undefined, page)).toBe(true);
      });
      it('video and unknown — refused', () => {
        expect(chk('video')).toBe(false);
        expect(chk('unknown')).toBe(false);
      });
      it('a foreign, missing or broken origin, no hub origin — refused, with or without a type', () => {
        expect(chk(undefined, 'https://evil.example/')).toBe(false);
        expect(chk('audio', 'https://hub.example.com.evil.example')).toBe(false);
        expect(chk(undefined, 'http://hub.example.com/')).toBe(false);
        expect(isPermissionCheckAllowed('media', { hubOrigin: HUB })).toBe(false);
        expect(isPermissionCheckAllowed('media', { requestingUrl: page })).toBe(false);
        expect(isPermissionCheckAllowed('media')).toBe(false);
      });
      it('the request handler still needs sound alone: no media types — refused', () => {
        expect(isPermissionAllowed('media', { hubOrigin: HUB, requestingUrl: page })).toBe(false);
      });
      it('other permissions follow the same list', () => {
        expect(isPermissionCheckAllowed('clipboard-sanitized-write')).toBe(true);
        expect(isPermissionCheckAllowed('fullscreen')).toBe(true);
        expect(isPermissionCheckAllowed('notifications', { hubOrigin: HUB, requestingUrl: page })).toBe(false);
      });
    });
    it('details do not open other permissions: notifications, geolocation refused; clipboard and fullscreen allowed', () => {
      const d = { hubOrigin: HUB, requestingUrl: page, mediaTypes: ['audio'] };
      expect(isPermissionAllowed('notifications', d)).toBe(false);
      expect(isPermissionAllowed('geolocation', d)).toBe(false);
      expect(isPermissionAllowed('clipboard-sanitized-write', d)).toBe(true);
      expect(isPermissionAllowed('fullscreen', d)).toBe(true);
    });
  });
});
