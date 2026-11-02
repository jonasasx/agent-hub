// Small pure parts: config (D17), window state (D2), offline (D14), tray (D5), updates (D15), pages, backoff, hotkey.
import { describe, expect, it } from 'vitest';
import { BACKOFF_MS, backoffDelay } from './backoff.js';
import { DEFAULT_CONFIG, DEFAULT_HUB_URL, effectiveConfig, loadStoredConfig, parseStoredConfig, validateHubUrl } from './config.js';
import { conflictMessage, hotkeyMenuLabel } from './hotkey.js';
import { actionOnHubBack, actionOnHubUnreachable, isOfflineHttpStatus, isOfflineLoadError } from './offline.js';
import { escapeHtml, offlinePage, signInPage, toDataUrl } from './pages.js';
import { SIGN_IN_GRACE_MS, countIcon, displayConnState, menuStateKey, shouldHideOnToggle, trayView } from './trayView.js';
import { SingleFlight, manualCheckMessage, updateErrorText, updateFeedUrl, updateRequestHeaders } from './updates.js';
import { restoreWindowState } from './windowState.js';

describe('config (D17)', () => {
  it('http://localhost:8080 accepted, http://evil.example rejected, https anywhere', () => {
    expect(validateHubUrl('http://localhost:8080')).toBe('http://localhost:8080');
    expect(validateHubUrl('http://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080');
    expect(validateHubUrl('http://evil.example')).toBeNull();
    expect(validateHubUrl('https://hub.example.com/')).toBe(DEFAULT_HUB_URL);
    expect(validateHubUrl('https://x.example/path')).toBeNull();
    expect(validateHubUrl('https://u:p@x.example')).toBeNull();
    expect(validateHubUrl('file:///C:/')).toBeNull();
  });
  it('broken JSON or no file → defaults; an invalid hubUrl falls back to the default', () => {
    expect(parseStoredConfig(null)).toEqual({ hubUrl: DEFAULT_HUB_URL, hotkey: 'Ctrl+Alt+Space', autostart: true });
    expect(parseStoredConfig('{not json')).toEqual({ hubUrl: DEFAULT_HUB_URL, hotkey: 'Ctrl+Alt+Space', autostart: true });
    expect(parseStoredConfig('{"hubUrl":"http://evil.example","hotkey":null,"autostart":false}')).toEqual({ hubUrl: DEFAULT_HUB_URL, hotkey: null, autostart: false });
    expect(parseStoredConfig('\uFEFF{"hotkey":"Ctrl+Alt+A"}').hotkey).toBe('Ctrl+Alt+A');
  });
  // Requirement: Адрес хаба по умолчанию.
  it('the default hub is the placeholder without AGENTHUB_DEFAULT_URL at build time', () => {
    expect(DEFAULT_HUB_URL).toBe('https://hub.example.com');
    expect(DEFAULT_CONFIG.hubUrl).toBe('https://hub.example.com');
  });
  it('a stored config.json is kept as is', () => {
    expect(loadStoredConfig('{"hubUrl":"https://hub.example.com"}').changed).toBe(false);
    expect(loadStoredConfig('{"hubUrl":"https://other.example"}')).toEqual({ stored: { hubUrl: 'https://other.example', hotkey: 'Ctrl+Alt+Space', autostart: true }, changed: false });
    expect(loadStoredConfig(null)).toEqual({ stored: { ...DEFAULT_CONFIG }, changed: false });
  });
  it('AGENTHUB_URL overrides hubUrl only when valid', () => {
    const st = parseStoredConfig(null);
    expect(effectiveConfig(st, { AGENTHUB_URL: 'http://localhost:8080' }).hubUrl).toBe('http://localhost:8080');
    expect(effectiveConfig(st, { AGENTHUB_URL: 'http://evil.example' }).hubUrl).toBe(DEFAULT_HUB_URL);
    expect(effectiveConfig(st, {}).hubUrl).toBe(DEFAULT_HUB_URL);
  });
});

describe('window state (D2)', () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1040 };
  const second = { x: 1920, y: 0, width: 2560, height: 1400 };
  it('outside all displays → centre of the primary, 1280×800', () => {
    expect(restoreWindowState({ x: 5000, y: 5000, width: 1000, height: 700, maximized: true }, [primary, second], primary)).toEqual({ x: 320, y: 120, width: 1280, height: 800, maximized: false });
    expect(restoreWindowState(null, [primary], primary)).toEqual({ x: 320, y: 120, width: 1280, height: 800, maximized: false });
  });
  it('Восстановление положения: maximized on the second display stays there', () => {
    const saved = { x: 2000, y: 50, width: 1400, height: 900, maximized: true };
    expect(restoreWindowState(saved, [primary, second], primary)).toEqual(saved);
  });
  it('too small saved size is ignored', () => {
    expect(restoreWindowState({ x: 0, y: 0, width: 10, height: 10, maximized: false }, [primary], primary).width).toBe(1280);
  });
});

describe('offline classifier (D14)', () => {
  it('listed net errors and 502–504', () => {
    for (const c of [-105, -102, -118, -106, -109, -7, -21, -137, -101, -100, -324]) expect(isOfflineLoadError(c)).toBe(true);
    for (const c of [-3, -6, -200, 0]) expect(isOfflineLoadError(c)).toBe(false);
    expect([502, 503, 504].every(isOfflineHttpStatus)).toBe(true);
    expect([200, 401, 500].some(isOfflineHttpStatus)).toBe(false);
  });
});

describe('outage with the web service worker (B2, D14)', () => {
  const v = (o: Partial<{ offlineScreen: boolean; onHubPage: boolean; loadedDuringOutage: boolean }>) => ({ offlineScreen: false, onHubPage: true, loadedDuringOutage: false, ...o });
  it('hub unreachable: «Нет связи» over a hub page (even one served from the cache), not over the app screens', () => {
    expect(actionOnHubUnreachable(v({}))).toBe('show_offline');
    expect(actionOnHubUnreachable(v({ loadedDuringOutage: true }))).toBe('show_offline');
    expect(actionOnHubUnreachable(v({ offlineScreen: true, onHubPage: false }))).toBe('none');
    expect(actionOnHubUnreachable(v({ onHubPage: false }))).toBe('none');
  });
  it('hub back: return from «Нет связи», reload a page loaded during the outage, leave a live page alone', () => {
    expect(actionOnHubBack(v({ offlineScreen: true, onHubPage: false }))).toBe('return');
    expect(actionOnHubBack(v({ loadedDuringOutage: true }))).toBe('reload');
    expect(actionOnHubBack(v({}))).toBe('none');
    expect(actionOnHubBack(v({ onHubPage: false, loadedDuringOutage: true }))).toBe('none');
  });
});

describe('pages', () => {
  it('escape and no scripts', () => {
    const html = offlinePage('https://h"<x>', 'https://h/s/1?a=1&b=2');
    expect(html).toContain('Нет связи с хабом — проверьте VPN');
    expect(html).toContain('https://h&quot;&lt;x&gt;');
    expect(html).toContain('href="https://h/s/1?a=1&amp;b=2"');
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("default-src 'none'");
    expect(escapeHtml(`'`)).toBe('&#39;');
  });
  it('sign-in button goes to /auth/login with the return path (intercepted by the navigation policy)', () => {
    expect(signInPage('https://h', '/s/1')).toContain('href="https://h/auth/login?return=%2Fs%2F1"');
    expect(toDataUrl('<p>я</p>')).toMatch(/^data:text\/html;charset=utf-8;base64,/);
  });
});

describe('tray (D5)', () => {
  it('icons: 0, 1–9, 9+', () => {
    expect([0, 1, 9, 10, 42].map(countIcon)).toEqual(['tray-0', 'tray-1', 'tray-9', 'tray-9plus', 'tray-9plus']);
  });
  it('tooltips and overlay by state', () => {
    expect(trayView('online', 2)).toEqual({ icon: 'tray-2', tooltip: 'Agent Hub — ждут: 2', overlay: 'tray-2', overlayText: 'Ждут: 2' });
    expect(trayView('online', 0)).toMatchObject({ icon: 'tray-0', tooltip: 'Agent Hub — ждут: 0', overlay: null });
    expect(trayView('offline', 3)).toMatchObject({ icon: 'tray-offline', tooltip: 'Agent Hub — нет связи с хабом', overlay: null });
    expect(trayView('online', 3, true).icon).toBe('tray-offline');
    expect(trayView('signed_out', 3)).toMatchObject({ icon: 'tray-signedout', tooltip: 'Agent Hub — нужен вход' });
  });
  it('toggle: hide only a visible focused window (or just blurred by the tray click)', () => {
    expect(shouldHideOnToggle({ visible: true, minimized: false, focused: true, msSinceBlur: 10_000 })).toBe(true);
    expect(shouldHideOnToggle({ visible: true, minimized: false, focused: false, msSinceBlur: 100 })).toBe(true);
    expect(shouldHideOnToggle({ visible: true, minimized: false, focused: false, msSinceBlur: 10_000 })).toBe(false);
    expect(shouldHideOnToggle({ visible: false, minimized: false, focused: false, msSinceBlur: 0 })).toBe(false);
    expect(shouldHideOnToggle({ visible: true, minimized: true, focused: false, msSinceBlur: 0 })).toBe(false);
  });
});

describe('tray state during sign-in and menu diff (A5, A6)', () => {
  it('signed_out while exchanging or just after a sign-in is shown as connecting', () => {
    expect(displayConnState('signed_out', { exchanging: true, msSinceSignIn: 1e9 })).toBe('connecting');
    expect(displayConnState('signed_out', { exchanging: false, msSinceSignIn: 100 })).toBe('connecting');
    expect(displayConnState('signed_out', { exchanging: false, msSinceSignIn: SIGN_IN_GRACE_MS + 1 })).toBe('signed_out');
    expect(displayConnState('online', { exchanging: true, msSinceSignIn: 0 })).toBe('online');
  });
  it('menu key changes only with the menu state', () => {
    const m = { version: '0.1.0', windowVisible: true, signedOut: false, hotkey: 'Ctrl+Alt+A', hotkeyRegistered: true, autostart: true, updateReady: false };
    expect(menuStateKey({ ...m })).toBe(menuStateKey(m));
    for (const k of Object.keys(m) as (keyof typeof m)[]) {
      const changed = { ...m, [k]: typeof m[k] === 'boolean' ? !m[k] : 'x' };
      expect(menuStateKey(changed), k).not.toBe(menuStateKey(m));
    }
  });
});

describe('updates (D15)', () => {
  it('a manual check during a running one gets its result (single flight)', async () => {
    const f = new SingleFlight<number>();
    let resolve!: (n: number) => void;
    let calls = 0;
    const first = f.run(() => {
      calls++;
      return new Promise<number>(r => (resolve = r));
    });
    const second = f.run(async () => {
      calls++;
      return 2;
    });
    resolve(1);
    expect(await first).toBe(1);
    expect(await second).toBe(1);
    expect(calls).toBe(1);
    expect(await f.run(async () => 3)).toBe(3);
  });
  it('feed URL on the hub', () => {
    expect(updateFeedUrl('https://hub.example.com')).toBe('https://hub.example.com/api/desktop/updates/');
    expect(updateFeedUrl('http://localhost:8080/')).toBe('http://localhost:8080/api/desktop/updates/');
  });
  it('cookie header only when signed in', () => {
    expect(updateRequestHeaders('tok', 'AgentHubDesktop/0.1.0')).toEqual({ Cookie: 'ah_session=tok', 'User-Agent': 'AgentHubDesktop/0.1.0' });
    expect(updateRequestHeaders(null, 'UA')).toEqual({ 'User-Agent': 'UA' });
  });
  it('messages', () => {
    expect(manualCheckMessage({ kind: 'latest', version: '0.1.0' })).toBe('Установлена последняя версия 0.1.0');
    expect(updateErrorText(new Error('HttpError: 401 Unauthorized'))).toBe('нужен вход в хаб');
    expect(updateErrorText(new Error('net::ERR_NAME_NOT_RESOLVED'))).toBe('нет связи с хабом');
  });
});

describe('backoff and hotkey', () => {
  it('1, 2, 5, 10, 30, then 30 s', () => {
    expect([0, 1, 2, 3, 4, 5, 20].map(backoffDelay)).toEqual([...BACKOFF_MS, 30_000, 30_000]);
  });
  it('hotkey texts', () => {
    expect(conflictMessage('Ctrl+Alt+Space')).toBe('Сочетание Ctrl+Alt+Space занято другой программой — выберите другое в меню трея');
    expect(hotkeyMenuLabel('Ctrl+Alt+A', false)).toBe('Горячая клавиша: не назначена');
    expect(hotkeyMenuLabel('Ctrl+Alt+A', true)).toBe('Горячая клавиша: Ctrl+Alt+A');
    expect(hotkeyMenuLabel(null, false)).toBe('Горячая клавиша: отключена');
  });
});
