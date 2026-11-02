// The question card on 390×844: options and buttons ≥ 40 px, no horizontal scroll.
import { expect, test } from '@playwright/test';
import { MockHub } from '../mock/hub.js';
import { QUESTIONS } from '../mock/ask.js';

test('телефон: the question card fits, touch targets ≥ 40 px, answer goes', async ({ page }) => {
  const hub = new MockHub({ tabs: [1] });
  await hub.install(page);
  await page.goto(`/s/${MockHub.id(1)}`);
  await expect(page.locator('.mbar')).toContainText(hub.session(1).title);
  hub.ask(1, 'question', QUESTIONS);
  const card = page.getByRole('group', { name: 'Claude задаёт вопрос' });
  await expect(card).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  for (const el of [...(await card.locator('.ask-opt').all()), ...(await card.getByRole('button').all()), ...(await card.getByRole('textbox').all())]) {
    const b = (await el.boundingBox())!;
    expect(b.height, (await el.textContent()) ?? '').toBeGreaterThanOrEqual(40);
    expect(b.x + b.width).toBeLessThanOrEqual(390);
  }
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/ask-phone.png`, fullPage: false });
  await card.getByRole('radio', { name: /SQLite/ }).check();
  await card.getByRole('checkbox', { name: /Нагрузку/ }).check();
  await card.getByRole('radio', { name: /money/ }).check();
  await card.getByRole('button', { name: 'Ответить' }).click();
  await expect(page.locator('.sysnote', { hasText: 'Какую базу взять? — SQLite' }).filter({ hasText: 'Как назвать сервис? — money' })).toBeVisible();
});
