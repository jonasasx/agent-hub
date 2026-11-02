// Bug from Ivan (M4b): a message sent with an image stayed «доставляется…» at the bottom of the feed and Claude's
// answers were drawn above it — the user line came back with a uuid other than the clientUuid. One copy, in its
// place, the answers below it; with and without an image; to a sleeping session.
import { expect, test, type Page } from '@playwright/test';
import { MockHub } from '../mock/hub.js';
import { makePng } from '../mock/images.js';

async function start(page: Page, n: number) {
  const hub = new MockHub({ tabs: [n] });
  hub.foreignLineUuid = true;
  await hub.install(page);
  await page.goto('/');
  await expect(page.locator('section.leaf .chat-title')).toBeVisible();
  return hub;
}
const feed = (page: Page) => page.locator('.messages');
/** The texts of the feed's messages in order (user bubbles and answers). */
const order = (page: Page) =>
  feed(page)
    .locator('.msg')
    .evaluateAll(els => els.map(e => `${e.classList.contains('pending') ? 'P:' : ''}${e.textContent?.replace(/\s+/g, ' ').trim().slice(0, 60)}`));

for (const withImage of [true, false]) {
  test(`отправка ${withImage ? 'с картинкой' : 'текстом'}: the line comes with its own uuid → one message, the answer below it`, async ({ page }) => {
    const hub = await start(page, 1);
    hub.lineDelayMs = 700;
    if (withImage) {
      await page.locator('section.leaf input[type=file]').setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: makePng(200, 120) });
      await expect(page.getByRole('list', { name: 'Прикреплённые изображения' }).getByRole('listitem')).toHaveCount(1);
      await expect(page.getByRole('progressbar')).toHaveCount(0);
    }
    await page.getByRole('textbox', { name: 'Сообщение' }).fill('Давай эту');
    await page.keyboard.press('Enter');
    await expect(page.locator('.msg.user.pending', { hasText: 'Давай эту' })).toBeVisible();
    await expect(page.getByText('Принято: «Давай эту». Готово.')).toBeVisible();
    await expect(page.locator('.msg.user.pending')).toHaveCount(0);
    await expect(feed(page).locator('.msg.user', { hasText: 'Давай эту' })).toHaveCount(1);
    const o = await order(page);
    const mine = o.findIndex(t => t.includes('Давай эту') && !t.startsWith('Claude'));
    const answer = o.findIndex(t => t.includes('Принято: «Давай эту»'));
    expect(mine).toBeGreaterThanOrEqual(0);
    expect(answer).toBeGreaterThan(mine);
    if (withImage) await expect(feed(page).locator('.msg.user', { hasText: 'Давай эту' }).locator('img')).toHaveCount(1);
  });
}

test('в спящую сессию: the copy stands in its place while the session wakes, then one message and the answer below', async ({ page }) => {
  const hub = await start(page, 6);
  hub.lineDelayMs = 900;
  await page.getByRole('textbox', { name: 'Сообщение' }).fill('Продолжай');
  await page.keyboard.press('Enter');
  const copy = page.locator('.msg.user.pending', { hasText: 'Продолжай' });
  await expect(copy).toBeVisible();
  await expect(page.getByText('Принято: «Продолжай». Готово.')).toBeVisible();
  await expect(copy).toHaveCount(0);
  await expect(feed(page).locator('.msg.user', { hasText: 'Продолжай' })).toHaveCount(1);
  const o = await order(page);
  expect(o.findIndex(t => t.includes('Принято: «Продолжай»'))).toBeGreaterThan(o.findIndex(t => t.includes('Продолжай') && !t.includes('Принято')));
});
