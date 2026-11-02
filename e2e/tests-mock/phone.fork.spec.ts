// Task 4.15 on 390×844: «⋯» → «⑂ Форк…», the form fits the screen, the copy opens as the chat.
import { expect, test } from '@playwright/test';
import { MockHub } from '../mock/hub.js';

test('телефон: «⋯» → «Форк…» → «Создать копию»; the form inside the screen, no horizontal scroll, controls ≥ 40 px', async ({ page }) => {
  const hub = new MockHub({ tabs: [1] });
  await hub.install(page);
  await page.goto(`/s/${MockHub.id(1)}`);
  await expect(page.locator('.mbar')).toContainText(hub.session(1).title);
  await page.locator('.mbar').getByRole('button', { name: 'Режим прав и модель' }).click();
  await page.getByRole('menuitem', { name: '⑂ Форк…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Форк сессии' });
  await expect(dlg).toBeVisible();
  await expect(dlg.getByRole('checkbox')).toHaveCount(0);
  const b = (await dlg.boundingBox())!;
  expect(b.x).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  for (const r of await dlg.getByRole('radio').all()) expect((await r.boundingBox())!.height).toBeGreaterThanOrEqual(40);
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/fork-phone.png` });
  await dlg.getByRole('button', { name: 'Создать копию' }).click();
  await expect(page.locator('.mbar')).toContainText(hub.session(1).title);
  expect(hub.forks).toHaveLength(1);
});
