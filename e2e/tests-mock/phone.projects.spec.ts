// Task 4.9 on 390×844. Requirement (workspace-ui): Строка проекта под шапкой чата — on the phone the evidence is
// shortened with the whole text in the tooltip, the button is ≥ 40 px; move with pinning and unpinning.
import { expect, test } from '@playwright/test';
import { MockHub } from '../mock/hub.js';

test('Строка проекта на телефоне: ≥ 40 px, the evidence shortened, «Перенести в…» inside the screen, pin and unpin', async ({ page }) => {
  const hub = new MockHub({ tabs: [1], projects: true });
  await hub.install(page);
  await page.goto('/');
  await expect(page.getByRole('complementary', { name: 'Сессии и проекты' })).toBeVisible();
  const proj = page.locator('.prow', { hasText: '04-copilot' });
  if ((await proj.getAttribute('aria-expanded')) !== 'true') await proj.click();
  await page.locator('.pchildren .srow', { hasText: 'Индексация Notion' }).click();
  const line = page.locator('.classline');
  const btn = line.getByRole('button', { name: 'Проект: 04-copilot' });
  const box = (await btn.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(40);
  const ev = line.locator('.evidence');
  await expect(ev).toHaveAttribute('title', 'определено по путям: 2 правки и 5 чтений в 04-copilot');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await btn.click();
  await page.getByRole('menuitem', { name: 'Перенести в…' }).click();
  const menu = page.getByRole('dialog', { name: 'Перенести в проект' });
  const m = (await menu.boundingBox())!;
  expect(m.x).toBeGreaterThanOrEqual(0);
  expect(m.x + m.width).toBeLessThanOrEqual(390);
  expect(m.y + m.height).toBeLessThanOrEqual(844);
  for (const o of (await menu.getByRole('option').all()).slice(0, 4)) expect((await o.boundingBox())!.height).toBeGreaterThanOrEqual(40);
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/projects-phone-picker.png` });
  await menu.getByRole('combobox').fill('budget');
  await menu.getByRole('option', { name: /01-budget/ }).click();
  await expect(line).toContainText('закреплено вручную');
  await line.getByRole('button', { name: 'Проект: 01-budget, закреплён' }).click();
  await page.getByRole('menuitem', { name: 'Открепить' }).click();
  await expect(line.getByRole('button', { name: 'Проект: 04-copilot' })).toBeVisible();
  expect(hub.requests.filter(r => r.path.endsWith('/pin')).map(r => r.method)).toEqual(['DELETE']);
});
