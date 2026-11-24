// Requirements: Навигация и внешние ссылки; Изоляция окна (design D3, D2).
import { describe, expect, it } from 'vitest';
import { decideNavigation, isFrameAllowed, isHubPage, isImageViewerUrl, isPermissionAllowed, isPermissionCheckAllowed, safeReturnPath } from './navigation.js';

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
  it('hub addresses outside the web are denied (Requirement: Адреса хаба вне веба)', () => {
    const urls = [
      `${HUB}/C:/Users/ivan/work/status-max.md`,
      `${HUB}/C:\\Users\\ivan\\x`,
      `${HUB}/c:`,
      `${HUB}/api/me`,
      `${HUB}/api`,
      `${HUB}/ws/ui`,
      `${HUB}/agent-api/restore/x`,
      `${HUB}/healthz`,
      `${HUB}/metrics`,
      `${HUB}/mcp/oauth/callback?code=1`,
      `${HUB}/assets/index-B8zplin1.js`,
      `${HUB}/version.json`,
    ];
    for (const u of urls) {
      expect(decideNavigation(u, HUB), u).toEqual({ kind: 'deny' });
      expect(isHubPage(u, HUB), u).toBe(false);
    }
  });
  it('web pages stay pages', () => {
    for (const p of ['/', `/s/${ID}`, '/settings/desktop', '/auth/disabled', '/apis', '/s/a.b/x']) {
      expect(isHubPage(`${HUB}${p}`, HUB), p).toBe(true);
    }
    expect(isHubPage('https://gitlab.com/', HUB)).toBe(false);
    expect(isHubPage('not a url', HUB)).toBe(false);
  });
  it('the service paths are the same as the hub fallback answers itself', async () => {
    const { readFile } = await import('node:fs/promises');
    const app = await readFile(new URL('../../../hub/src/app.ts', import.meta.url), 'utf8');
    expect(app).toContain('const NON_SPA = /^\\/(api|auth|ws|agent-api|agent|enroll|healthz|metrics|mcp)(\\/|$)/;');
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

describe('isImageViewerUrl (image-viewer D4)', () => {
  const SHA = 'ab'.repeat(32);
  it('a stored image of the hub opens in the image window', () => {
    expect(isImageViewerUrl(`${HUB}/api/blobs/${SHA}`, HUB)).toBe(true);
    expect(isImageViewerUrl(`${HUB}/api/blobs/${SHA}?retry=1`, HUB)).toBe(true);
  });
  it('other hub pages, nested paths and foreign origins do not', () => {
    expect(isImageViewerUrl(`${HUB}/s/${ID}`, HUB)).toBe(false);
    expect(isImageViewerUrl(`${HUB}/api/blobs/${SHA}/x`, HUB)).toBe(false);
    expect(isImageViewerUrl(`${HUB}/api/blobs/`, HUB)).toBe(false);
    expect(isImageViewerUrl(`${HUB}/api/blobs/../auth/login`, HUB)).toBe(false);
    expect(isImageViewerUrl(`https://evil.example.com/api/blobs/${SHA}`, HUB)).toBe(false);
    expect(isImageViewerUrl('not a url', HUB)).toBe(false);
  });
});

describe('isFrameAllowed (desktop-html-frame)', () => {
  it('the HTML file of the viewer and hub pages load in a sub-frame', () => {
    expect(isFrameAllowed(`${HUB}/api/runners/hp/fs/html?path=${encodeURIComponent('C:\\Users\\ivan\\report.html')}`, HUB)).toBe(true);
    expect(isFrameAllowed(`${HUB}/api/runners/${ID}/fs/html?path=%2Fhome%2Fubuntu%2Fa.html&sessionId=${ID}`, HUB)).toBe(true);
    expect(isFrameAllowed(`${HUB}/s/${ID}`, HUB)).toBe(true);
    expect(isFrameAllowed('about:blank', HUB)).toBe(true);
    expect(isFrameAllowed('about:srcdoc', HUB)).toBe(true);
  });
  it('other hub addresses outside the web, other origins and schemes stay out of a sub-frame', () => {
    const urls = [
      `${HUB}/api/me`,
      `${HUB}/api/runners/hp/fs/file?path=%2Fetc%2Fpasswd`,
      `${HUB}/api/runners/hp/fs/download?path=a.html`,
      `${HUB}/api/runners/hp/fs/html/x`,
      `${HUB}/api/runners/a/b/fs/html`,
      `${HUB}/C:/Users/ivan/report.html`,
      `https://evil.example.com/api/runners/hp/fs/html?path=a.html`,
      'http://hub.example.com/api/runners/hp/fs/html?path=a.html',
      'https://gitlab.com/x',
      'data:text/html,x',
      'javascript:alert(1)',
      'not a url',
    ];
    for (const u of urls) expect(isFrameAllowed(u, HUB), u).toBe(false);
  });
});
