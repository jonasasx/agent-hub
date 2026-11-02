// M3b tails done in M3c against the in-memory hub: «Повторить» on «Сообщение не доставлено» (the note's `undelivered`)
// and «Показать полностью» of a big Bash output saved to tool-results (the line's `sideFiles`).
import { expect, test, type Page } from '@playwright/test';
import { MockHub } from '../mock/hub.js';

async function open(page: Page) {
  const hub = new MockHub({ tabs: [22] });
  await hub.install(page);
  await page.goto('/');
  await expect(page.getByRole('tab', { name: /Историческая сессия 3/ })).toHaveAttribute('aria-selected', 'true');
  return hub;
}

test('Большой вывод Bash: «Показать полностью» opens the hub copy of tool-results; 404 while it has not arrived', async ({ page }) => {
  const hub = await open(page);
  const chat = page.locator('section.leaf');
  await chat.locator('details.tool', { hasText: 'grep -rn match src' }).locator('summary').click();
  const full = chat.getByRole('button', { name: 'Показать полностью · 12.9KB' });
  // first the copy is not on the hub yet
  const text = hub.toolResults.get(`${MockHub.id(22)}/toolu_big.txt`)!;
  hub.toolResults.delete(`${MockHub.id(22)}/toolu_big.txt`);
  await full.click();
  await expect(chat.getByText('Полный вывод ещё не дошёл до хаба — попробуйте позже')).toBeVisible();
  hub.toolResults.set(`${MockHub.id(22)}/toolu_big.txt`, text);
  await full.click();
  await expect(chat.getByText('src/file399.ts:400: match 399')).toBeVisible();
  if (process.env.SHOTS_DIR) await chat.screenshot({ path: `${process.env.SHOTS_DIR}/tails-full-output.png` });
  expect(hub.requests.filter(r => r.path.endsWith('/tool-results/toolu_big.txt'))).toHaveLength(2);
});

test('Сообщение не доставлено: «Повторить» returns the text and the image to the composer, sending delivers it without a new upload', async ({ page }) => {
  const hub = await open(page);
  const chat = page.locator('section.leaf');
  if (process.env.SHOTS_DIR) await chat.screenshot({ path: `${process.env.SHOTS_DIR}/tails-undelivered.png` });
  await chat.locator('.sysnote', { hasText: 'Сообщение не доставлено' }).getByRole('button', { name: 'Повторить' }).click();
  const box = chat.getByRole('textbox', { name: 'Сообщение' });
  await expect(box).toHaveValue('проверь вывод');
  await expect(box).toBeFocused();
  await expect(chat.locator('li.ready img')).toHaveCount(1);
  await box.press('Enter');
  await expect(chat.locator('.msg.user', { hasText: 'проверь вывод' }).locator('img')).toHaveCount(1);
  const sent = hub.requests.find(r => r.method === 'POST' && r.path.endsWith('/messages'))!;
  expect((sent.body as { attachments: unknown[] }).attachments).toHaveLength(1);
  expect(hub.requests.some(r => r.path === '/api/uploads')).toBe(false);
});
