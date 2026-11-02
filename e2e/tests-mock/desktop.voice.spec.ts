// Task 3.7 (change voice-input) on the desktop against the in-memory hub with Chromium's fake microphone.
// Requirements (voice-input): Включение диктовки; Запись голоса; Отмена записи; Завершение записи и вставка текста;
// Ошибки распознавания; Одна запись на окно.
import { expect, test, type Page } from '@playwright/test';
import { MockHub } from '../mock/hub.js';
import { expectMicReleased, record, watchTracks } from './voice.helpers.js';

async function start(page: Page, opts: ConstructorParameters<typeof MockHub>[0] = {}) {
  const hub = new MockHub({ tabs: [1, 4], voiceInput: true, ...opts });
  await watchTracks(page);
  await hub.install(page);
  await page.goto('/');
  await expect(page.getByRole('tab', { name: /GUI-прототип/ })).toBeVisible();
  return hub;
}
const chat = (page: Page) => page.locator('section.leaf.focused section.chat');
const field = (page: Page) => chat(page).getByRole('textbox', { name: 'Сообщение' });
const sent = (hub: MockHub) => hub.requests.filter(r => r.method === 'POST' && /\/messages$/.test(r.path));
const shot = async (page: Page, name: string) => {
  if (process.env.SHOTS_DIR) await page.locator('section.leaf.focused .composer').screenshot({ path: `${process.env.SHOTS_DIR}/voice-desktop-${name}.png` });
};

test('Ключ не задан: no «Диктовка» in the composer', async ({ page }) => {
  await start(page, { voiceInput: false });
  await expect(chat(page).getByRole('button', { name: 'Прикрепить изображение' })).toBeVisible();
  await expect(chat(page).getByRole('button', { name: 'Диктовка' })).toHaveCount(0);
});

test('Пустой черновик / Дописывание: record → «Готово» → «Распознаю…» → the text in the field, cursor at the end, nothing sent', async ({ page }) => {
  const hub = await start(page);
  hub.voiceAnswers.push({ status: 200, body: { text: 'проверь логи' }, delayMs: 700 });
  await field(page).fill('Сделай так:');
  await shot(page, 'button');
  const bar = await record(page, chat(page));
  await expect(bar.locator('.voice-timer')).toHaveText(/^0:0[1-9]$/);
  await expect(chat(page).getByRole('textbox', { name: 'Сообщение' })).toHaveCount(0);
  await shot(page, 'recording');
  await bar.getByRole('button', { name: 'Готово' }).click();
  await expect(bar.locator('.voice-status', { hasText: 'Распознаю…' })).toBeVisible();
  await shot(page, 'transcribing');
  await expectMicReleased(page);
  await expect(field(page)).toHaveValue('Сделай так: проверь логи');
  await expect(field(page)).toBeFocused();
  expect(await field(page).evaluate((t: HTMLTextAreaElement) => t.selectionStart === t.value.length)).toBe(true);
  expect(hub.voiceRequests).toHaveLength(1);
  expect(hub.voiceRequests[0]!.contentType).toMatch(/^audio\/webm/);
  expect(hub.voiceRequests[0]!.size).toBeGreaterThan(500);
  expect(sent(hub)).toHaveLength(0);
});

test('Прервать сессию во время диктовки: «Прервать» next to the bar; the turn stops, the recording goes on into the draft', async ({ page }) => {
  const hub = new MockHub({ tabs: [2], voiceInput: true });
  await watchTracks(page);
  await hub.install(page);
  await page.goto('/');
  await expect(page.getByRole('tab', { name: /Роллаут агента/ })).toBeVisible();
  const bar = await record(page, chat(page), 300);
  const stop = chat(page).locator('.composer').getByRole('button', { name: 'Прервать' });
  await expect(stop).toBeVisible();
  await shot(page, 'interrupt-recording');
  await stop.click();
  await expect.poll(() => hub.requests.filter(r => r.method === 'POST' && r.path.endsWith('/interrupt')).length).toBe(1);
  await expect(stop).toHaveCount(0);
  await bar.getByRole('button', { name: 'Готово' }).click();
  await expect(field(page)).toHaveValue('Привет из диктовки');
  await expectMicReleased(page);
  expect(sent(hub)).toHaveLength(0);
});

test('Esc во время записи: the recording is dropped, the microphone released, no request, the draft as it was', async ({ page }) => {
  const hub = await start(page);
  await field(page).fill('Проверь');
  await record(page, chat(page), 300);
  await page.keyboard.press('Escape');
  await expect(field(page)).toHaveValue('Проверь');
  await expectMicReleased(page);
  await page.waitForTimeout(300);
  expect(hub.voiceRequests).toHaveLength(0);
});

test('Отмена во время распознавания: a late answer does not reach the draft', async ({ page }) => {
  const hub = await start(page);
  hub.voiceAnswers.push({ status: 200, body: { text: 'поздно' }, delayMs: 1500 });
  const bar = await record(page, chat(page), 300);
  await bar.getByRole('button', { name: 'Готово' }).click();
  await expect(bar.locator('.voice-status', { hasText: 'Распознаю…' })).toBeVisible();
  await bar.getByRole('button', { name: 'Отмена' }).click();
  await expect(field(page)).toHaveValue('');
  await page.waitForTimeout(1800);
  await expect(field(page)).toHaveValue('');
  expect(hub.voiceRequests).toHaveLength(1);
});

test('Квота исчерпана: «Закончилась квота ElevenLabs, обновится 18.11», «Повторить» sends the same recording', async ({ page }) => {
  const hub = await start(page);
  hub.voiceAnswers.push({ status: 402, body: { error: 'voice_quota_exceeded', message: 'Закончилась квота ElevenLabs', resetAt: '2026-11-18T12:00:00Z' } });
  const bar = await record(page, chat(page), 300);
  await bar.getByRole('button', { name: 'Готово' }).click();
  await expect(bar.getByRole('alert')).toHaveText('Закончилась квота ElevenLabs, обновится 18.11');
  await expect(bar.getByRole('button', { name: 'Отмена' })).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Повторить' })).toBeFocused();
  await shot(page, 'quota');
  await expectMicReleased(page);
  const before = await page.evaluate(() => (window as unknown as { __tracks: unknown[] }).__tracks.length);
  await bar.getByRole('button', { name: 'Повторить' }).click();
  await expect(field(page)).toHaveValue('Привет из диктовки');
  expect(hub.voiceRequests).toHaveLength(2);
  expect(hub.voiceRequests[1]!.size).toBe(hub.voiceRequests[0]!.size);
  // «микрофон повторно не запрашивается»
  expect(await page.evaluate(() => (window as unknown as { __tracks: unknown[] }).__tracks.length)).toBe(before);
});

test('Повтор после ошибки: voice_upstream_error → «Не удалось распознать» → «Повторить» → the text', async ({ page }) => {
  const hub = await start(page);
  hub.voiceAnswers.push({ status: 502, body: { error: 'voice_upstream_error', message: 'x' } });
  const bar = await record(page, chat(page), 300);
  await bar.getByRole('button', { name: 'Готово' }).click();
  await expect(bar.getByRole('alert')).toHaveText('Не удалось распознать');
  await bar.getByRole('button', { name: 'Повторить' }).click();
  await expect(field(page)).toHaveValue('Привет из диктовки');
});

test('Обрыв связи: the connection breaks during «Распознаю…» → «Не удалось распознать» with «Повторить»; Esc keeps the recording', async ({ page }) => {
  const hub = await start(page);
  hub.voiceAnswers.push({ status: 0, body: {}, delayMs: 300, abort: true });
  await field(page).fill('было');
  const bar = await record(page, chat(page), 300);
  await bar.getByRole('button', { name: 'Готово' }).click();
  await expect(bar.getByRole('alert')).toHaveText('Не удалось распознать');
  await expect(bar.getByRole('button', { name: 'Повторить' })).toBeFocused();
  // Esc cancels a recording only, not the one kept for «Повторить»
  await page.keyboard.press('Escape');
  await expect(bar.getByRole('button', { name: 'Повторить' })).toBeVisible();
  await bar.getByRole('button', { name: 'Повторить' }).click();
  await expect(field(page)).toHaveValue('было Привет из диктовки');
  expect(hub.voiceRequests).toHaveLength(2);
  expect(hub.voiceRequests[1]!.size).toBe(hub.voiceRequests[0]!.size);
});

test('Тишина: an empty result — the composer back with «Речь не распознана», the draft as it was', async ({ page }) => {
  const hub = await start(page);
  hub.voiceAnswers.push({ status: 200, body: { text: '' } });
  await field(page).fill('было');
  const bar = await record(page, chat(page), 300);
  await bar.getByRole('button', { name: 'Готово' }).click();
  await expect(field(page)).toHaveValue('было');
  await expect(chat(page).locator('.voice-note')).toHaveText(/Речь не распознана/);
  await shot(page, 'empty');
});

test('Вторая панель: while the left pane records, «Диктовка» on the right is disabled with «Идёт запись в другой панели»', async ({ page }) => {
  await start(page);
  const panes = page.locator('section.leaf');
  await page.getByRole('tab', { name: /подписка/ }).dragTo(panes.first(), { targetPosition: { x: 1000, y: 400 } });
  await expect(panes).toHaveCount(2);
  const left = panes.nth(0);
  const right = panes.nth(1);
  await record(page, left.locator('section.chat'), 200);
  const other = right.getByRole('button', { name: 'Диктовка' });
  await expect(other).toBeDisabled();
  await expect(other).toHaveAttribute('title', 'Идёт запись в другой панели');
  await page.keyboard.press('Escape');
  await expect(other).toBeEnabled();
});

for (const theme of ['dark', 'light'] as const) {
  test(`полоса записи в теме ${theme}: the timer and the buttons readable, the countdown differs from the timer`, async ({ page }) => {
    await page.addInitScript(t => localStorage.setItem('ah-theme', t), theme);
    await start(page);
    const bar = await record(page, chat(page), 100);
    const timer = bar.locator('.voice-timer');
    const plain = await timer.evaluate(e => ({ c: getComputedStyle(e).color, bg: getComputedStyle(e).backgroundColor }));
    // the last 30 s: the same element switches to the countdown look
    await timer.evaluate(e => e.classList.add('countdown'));
    const countdown = await timer.evaluate(e => ({ c: getComputedStyle(e).color, bg: getComputedStyle(e).backgroundColor }));
    expect(countdown.bg).not.toBe(plain.bg);
    if (process.env.SHOTS_DIR) await page.locator('section.leaf.focused .composer').screenshot({ path: `${process.env.SHOTS_DIR}/voice-desktop-countdown-${theme}.png` });
    await timer.evaluate(e => e.classList.remove('countdown'));
    if (process.env.SHOTS_DIR) await page.locator('section.leaf.focused .composer').screenshot({ path: `${process.env.SHOTS_DIR}/voice-desktop-recording-${theme}.png` });
    await page.keyboard.press('Escape');
  });
}
