// Change i18n, design D8: texts of the main process in the language of the hub profile, the system language before it.
import { afterEach, describe, expect, it } from 'vitest';
import { RUNNERS, session } from '../test/factories.js';
import { currentLocale, dt, resolveLocale, setLocale } from './i18n.js';
import { conflictMessage, hotkeyMenuLabel } from './hotkey.js';
import { exchangeErrorText } from './exchange.js';
import { decideNotification } from './notify.js';
import { offlinePage } from './pages.js';
import { trayView } from './trayView.js';
import { manualCheckMessage } from './updates.js';

afterEach(async () => {
  await setLocale('ru');
});

describe('resolveLocale', () => {
  it('takes the profile language of /api/me', () => {
    expect(resolveLocale('de', ['ru-RU'])).toBe('de');
  });

  it('falls back to the system language when the profile has none or before sign-in', () => {
    expect(resolveLocale(null, ['pt-PT', 'en-US'])).toBe('pt-BR');
    expect(resolveLocale(undefined, ['ru'])).toBe('ru');
    expect(resolveLocale(null, ['xx'])).toBe('en');
  });
});

describe('texts follow the language', () => {
  it('notification and tray on ru and en', async () => {
    const prev = session({ status: 'working' });
    const next = { ...prev, status: 'permission' as const };
    const input = { prev, next, runners: RUNNERS, activeVisible: false, windowVisibleAndFocused: false };
    expect(decideNotification(input)?.title).toBe('Ждёт разрешения: Ревизия DNS');
    expect(trayView('online', 2).tooltip).toBe('Agent Hub — ждут: 2');
    expect(await setLocale('en')).toBe(true);
    expect(currentLocale()).toBe('en');
    expect(decideNotification(input)?.title).toBe('Waiting for permission: Ревизия DNS');
    expect(trayView('online', 2)).toMatchObject({ tooltip: 'Agent Hub — waiting: 2', overlayText: 'Waiting: 2' });
    expect(trayView('signed_out', 0).tooltip).toBe('Agent Hub — sign-in required');
  });

  it('hotkey, exchange, updates and pages on en', async () => {
    await setLocale('en');
    expect(hotkeyMenuLabel(null, false)).toBe('Hotkey: disabled');
    expect(conflictMessage('Ctrl+Alt+A')).toContain('Ctrl+Alt+A');
    expect(exchangeErrorText({ ok: false, error: 'network', status: 0 })).toBe('Cannot reach the hub.');
    expect(manualCheckMessage({ kind: 'latest', version: '1.0.0' })).toBe('You have the latest version, 1.0.0');
    const html = offlinePage('https://h', 'https://h/');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('Retry');
    expect(html).not.toMatch(/[А-Яа-я]/);
  });

  it('switching back updates later texts', async () => {
    await setLocale('en');
    await setLocale('ru');
    expect(dt('desktop.tray.quit')).toBe('Выход');
    expect(await setLocale('ru')).toBe(false);
  });
});
