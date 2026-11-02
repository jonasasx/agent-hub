// Task 3.9 web on 390×844. Requirement (workspace-ui): Быстрый поиск Ctrl+K; Телефонный режим.
import { expect, test } from '@playwright/test';
import { MockHub } from '../mock/hub.js';

test('Поиск на телефоне: the search button, a hit by reply text, the chat opens over the list', async ({ page }) => {
  const hub = new MockHub({ tabs: [1] });
  await hub.install(page);
  await page.goto('/');
  await expect(page.getByRole('list', { name: 'Машины' })).toBeVisible();
  await page.getByRole('button', { name: /Найти сессию/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Быстрый переход' });
  await dialog.getByRole('combobox').fill('таймаута keycloak');
  const row = dialog.getByRole('option', { name: /Историческая сессия 2/ });
  await expect(row.locator('mark')).toHaveText('таймаута Keycloak');
  const box = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await row.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.mbar')).toContainText('Историческая сессия 2');
});
