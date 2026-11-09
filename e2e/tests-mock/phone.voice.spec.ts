// Task 3.7 (change voice-input) on 390×844 against the in-memory hub with Chromium's fake microphone.
// Requirements (voice-input): Кнопка микрофона в композере (44×44); Запись голоса; Отмена записи; Завершение записи и
// вставка текста; Ошибки распознавания; Запись при смене контекста.
import { expect, test, type Page } from '@playwright/test';
import { MockHub } from '../mock/hub.js';
import { expectMicReleased, record, watchTracks } from './voice.helpers.js';

async function open(page: Page, title: string, theme?: 'dark' | 'light') {
  const hub = new MockHub({ tabs: [1], voiceInput: true });
  if (theme) await page.addInitScript(t => localStorage.setItem('ah-theme', t), theme);
  await watchTracks(page);
  await hub.install(page);
  await page.goto('/');
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
const field = (page: Page) => page.getByRole('textbox', { name: 'Сообщение' });
const composer = (page: Page) => page.locator('.composer');
const shot = async (page: Page, name: string) => {
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/voice-phone-${name}.png` });
};

test('Размер цели на телефоне: «Диктовка» ≥ 44×44 in the capsule composer; the bar takes the whole width; «Готово» → the text, nothing sent', async ({ page }) => {
  const hub = await open(page, 'GUI-прототип Agent Hub');
  const mic = page.getByRole('button', { name: 'Диктовка' });
  const box = (await mic.boundingBox())!;
  expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
  // the capsule: the field on the full width, the mic in the tool row under it
  const fieldBox = (await field(page).boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(fieldBox.y + fieldBox.height - 4);
  expect(fieldBox.width).toBeGreaterThanOrEqual(300);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await shot(page, 'button');
  const bar = await record(page, composer(page));
  const barBox = (await bar.boundingBox())!;
  const inner = (await page.locator('.composer-inner').boundingBox())!;
  expect(barBox.width).toBeGreaterThanOrEqual(inner.width - 2);
  for (const name of ['Отмена', 'Готово']) {
    const b = (await bar.getByRole('button', { name }).boundingBox())!;
    expect(Math.min(b.width, b.height), name).toBeGreaterThanOrEqual(44);
  }
  await shot(page, 'recording');
  await bar.getByRole('button', { name: 'Готово' }).click();
  await expect(field(page)).toHaveValue('Привет из диктовки');
  await expectMicReleased(page);
  expect(hub.requests.filter(r => r.method === 'POST' && /\/messages$/.test(r.path))).toHaveLength(0);
});

test('Телефон заблокирован: the page going to the background finishes the recording into the draft', async ({ page }) => {
  const hub = await open(page, 'GUI-прототип Agent Hub');
  await record(page, composer(page), 300);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expectMicReleased(page);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(field(page)).toHaveValue('Привет из диктовки');
  expect(hub.voiceRequests).toHaveLength(1);
});

test('Esc / «Отмена»: the draft as it was, nothing sent', async ({ page }) => {
  const hub = await open(page, 'GUI-прототип Agent Hub');
  await field(page).fill('Проверь');
  const bar = await record(page, composer(page), 200);
  await bar.getByRole('button', { name: 'Отмена' }).click();
  await expect(field(page)).toHaveValue('Проверь');
  await expectMicReleased(page);
  expect(hub.voiceRequests).toHaveLength(0);
});

test('Прервать сессию во время диктовки: «Прервать» next to the bar while recording and recognising; the turn stops, the dictation goes on', async ({ page }) => {
  const hub = await open(page, 'Роллаут агента на площадку C, партия 2');
  hub.voiceAnswers.push({ status: 200, body: { text: 'Привет из диктовки' }, delayMs: 800 });
  const bar = await record(page, composer(page), 300);
  const stop = composer(page).getByRole('button', { name: 'Прервать' });
  await expect(stop).toBeVisible();
  const s = (await stop.boundingBox())!;
  const barBox = (await bar.boundingBox())!;
  expect(Math.min(s.width, s.height)).toBeGreaterThanOrEqual(44);
  expect(s.x).toBeGreaterThanOrEqual(barBox.x + barBox.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await shot(page, 'interrupt-recording');
  await stop.click();
  await expect.poll(() => hub.requests.filter(r => r.method === 'POST' && /\/interrupt$/.test(r.path)).length).toBe(1);
  await expect(bar.getByRole('button', { name: 'Готово' })).toBeVisible();
  await expect(stop).toHaveCount(0);
  await bar.getByRole('button', { name: 'Готово' }).click();
  await expect(field(page)).toHaveValue('Привет из диктовки');
  await expectMicReleased(page);
});

test('Сессия только для чтения: «Диктовка» disabled', async ({ page }) => {
  await open(page, 'Сверка трасс кабелей КД');
  await expect(page.getByRole('button', { name: 'Диктовка' })).toBeDisabled();
});

for (const theme of ['dark', 'light'] as const) {
  test(`состояния на телефоне (${theme}): «Распознаю…», квота, «Речь не распознана»`, async ({ page }) => {
    const hub = await open(page, 'GUI-прототип Agent Hub', theme);
    hub.voiceAnswers.push({ status: 402, body: { error: 'voice_quota_exceeded', message: 'Закончилась квота ElevenLabs', resetAt: '2026-11-18T12:00:00Z' }, delayMs: 800 });
    hub.voiceAnswers.push({ status: 200, body: { text: '  ' } });
    const bar = await record(page, composer(page), 200);
    await bar.getByRole('button', { name: 'Готово' }).click();
    await expect(bar.locator('.voice-status', { hasText: 'Распознаю…' })).toBeVisible();
    await shot(page, `transcribing-${theme}`);
    await expect(bar.getByRole('alert')).toHaveText('Закончилась квота ElevenLabs, обновится 18.11');
    for (const name of ['Повторить', 'Отмена']) {
      const b = (await bar.getByRole('button', { name }).boundingBox())!;
      expect(Math.min(b.width, b.height), name).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    // the buttons stay inside the 26px rounding of the bar: 4px inset, pill-shaped (QA, phone-*-error-quota.png)
    const barBox = (await bar.boundingBox())!;
    for (const name of ['Повторить', 'Отмена']) {
      const btn = bar.getByRole('button', { name });
      const b = (await btn.boundingBox())!;
      expect(b.x, name).toBeGreaterThanOrEqual(barBox.x + 3);
      expect(b.x + b.width, name).toBeLessThanOrEqual(barBox.x + barBox.width - 3);
      expect(b.y, name).toBeGreaterThanOrEqual(barBox.y + 3);
      expect(b.y + b.height, name).toBeLessThanOrEqual(barBox.y + barBox.height - 3);
      expect(await btn.evaluate(e => parseFloat(getComputedStyle(e).borderTopRightRadius)), name).toBeGreaterThanOrEqual(b.height / 2 - 1);
    }
    await shot(page, `quota-${theme}`);
    await bar.getByRole('button', { name: 'Повторить' }).click();
    await expect(page.locator('.voice-note')).toHaveText(/Речь не распознана/);
    await expect(field(page)).toHaveValue('');
    // the hint is under the composer: below the field, the clip and the send button (QA: it was above them)
    const note = (await page.locator('.voice-note').boundingBox())!;
    // and under the capsule itself, clear of its border and rounding (task 6.7: it sat inside, on the 22px corner)
    for (const el of [field(page), page.getByRole('button', { name: 'Отправить' }), page.getByRole('button', { name: 'Прикрепить изображение' }), page.locator('.composer-inner')]) {
      const b = (await el.boundingBox())!;
      expect(note.y).toBeGreaterThanOrEqual(b.y + b.height);
    }
    await shot(page, `empty-${theme}`);
  });
}
