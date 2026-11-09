// Screenshots of every dictation state for the ui-ux review (change voice-input, task 6.7): both themes, full page.
// Runs only with SHOTS_DIR set; files `voice-<device>-<theme>-<state>.png`.
import { expect, test, type Page } from '@playwright/test';
import { MockHub } from '../mock/hub.js';
import { record } from './voice.helpers.js';

// mock sessions: 1 waits, 2 runs a turn («Прервать»)
const TITLES: Record<number, string> = { 1: 'GUI-прототип Agent Hub', 2: 'Роллаут агента на площадку C, партия 2' };

async function open(page: Page, device: 'desktop' | 'phone', theme: 'dark' | 'light', n: number) {
  const title = TITLES[n]!;
  // the desktop opens the session from the saved layout, the phone (no tab strip) through the session search
  const hub = new MockHub({ tabs: device === 'desktop' ? [n] : [1], voiceInput: true });
  await page.addInitScript(t => localStorage.setItem('ah-theme', t), theme);
  await hub.install(page);
  await page.goto('/');
  if (device === 'desktop') {
    await expect(page.getByRole('tab', { name: new RegExp(title) })).toBeVisible();
    return hub;
  }
  await expect(page.getByRole('complementary', { name: 'Сессии и проекты' })).toBeVisible();
  await page.getByRole('button', { name: 'Найти сессию' }).click();
  await page.getByRole('combobox', { name: 'Сессия или проект' }).fill(title);
  await page
    .getByRole('option', { name: new RegExp(title) })
    .first()
    .click();
  await expect(page.locator('.mbar')).toContainText(title);
  return hub;
}

const composer = (page: Page) => page.locator('section.leaf.focused .composer, .chat.phone .composer').first();

export function voiceShots(device: 'desktop' | 'phone') {
  const dir = process.env.SHOTS_DIR;
  for (const theme of ['dark', 'light'] as const) {
    const shot = (page: Page, state: string) => page.screenshot({ path: `${dir}/voice-${device}-${theme}-${state}.png` });
    test.describe(`скриншоты диктовки (${device}, ${theme})`, () => {
      test.skip(!dir, 'SHOTS_DIR is not set');

      test('кнопка, запись, отсчёт, «Распознаю…», квота, «Речь не распознана»', async ({ page }) => {
        const hub = await open(page, device, theme, 1);
        hub.voiceAnswers.push({ status: 402, body: { error: 'voice_quota_exceeded', message: 'Закончилась квота ElevenLabs', resetAt: '2026-11-18T12:00:00Z' }, delayMs: 1500 });
        hub.voiceAnswers.push({ status: 200, body: { text: '  ' } });
        await shot(page, '1-button');
        const bar = await record(page, composer(page), 600);
        await shot(page, '2-recording');
        await bar.locator('.voice-timer').evaluate(e => e.classList.add('countdown'));
        await shot(page, '3-countdown');
        await bar.locator('.voice-timer').evaluate(e => e.classList.remove('countdown'));
        await bar.getByRole('button', { name: 'Готово' }).click();
        await expect(bar.locator('.voice-status', { hasText: 'Распознаю…' })).toBeVisible();
        await shot(page, '4-transcribing');
        await expect(bar.getByRole('alert')).toHaveText(/Закончилась квота/);
        await shot(page, '5-quota');
        await bar.getByRole('button', { name: 'Повторить' }).click();
        await expect(page.locator('.voice-note')).toHaveText(/Речь не распознана/);
        await shot(page, '6-empty');
      });

      test('«Прервать» рядом с полосой: запись, «Распознаю…», ошибка', async ({ page }) => {
        const hub = await open(page, device, theme, 2);
        hub.voiceAnswers.push({ status: 502, body: { error: 'voice_upstream_error', message: 'Не удалось распознать' }, delayMs: 1500 });
        const bar = await record(page, composer(page), 300);
        await expect(composer(page).getByRole('button', { name: 'Прервать' })).toBeVisible();
        await shot(page, '7-interrupt-recording');
        await bar.getByRole('button', { name: 'Готово' }).click();
        await expect(bar.locator('.voice-status', { hasText: 'Распознаю…' })).toBeVisible();
        await shot(page, '8-interrupt-transcribing');
        await expect(bar.getByRole('alert')).toBeVisible();
        await shot(page, '9-interrupt-error');
      });

      test('нет доступа к микрофону', async ({ page }) => {
        await page.addInitScript(() => {
          navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
        });
        await open(page, device, theme, 1);
        await composer(page).getByRole('button', { name: 'Диктовка' }).click();
        await expect(page.locator('.voice-note')).toHaveText(/Нет доступа к микрофону/);
        await shot(page, '10-no-mic');
      });
    });
  }
}
