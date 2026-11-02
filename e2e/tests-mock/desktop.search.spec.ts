// Task 3.9 web against the in-memory hub. Requirement (workspace-ui): Быстрый поиск Ctrl+K.
import { expect, test, type Page } from '@playwright/test';
import { MockHub } from '../mock/hub.js';

async function start(page: Page) {
  const hub = new MockHub({ tabs: [1, 4] });
  await hub.install(page);
  await page.goto('/');
  await expect(page.getByRole('tab')).toHaveCount(2);
  return hub;
}

test('Поиск по тексту реплики: Ctrl+K finds a session by its reply, the fragment is text, Enter opens it in the active pane', async ({ page }) => {
  const hub = await start(page);
  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog', { name: 'Быстрый переход' });
  const input = dialog.getByRole('combobox', { name: 'Сессия или проект' });
  await expect(input).toHaveAttribute('placeholder', 'Название, проект или текст реплики…');
  // an empty query: the recent sessions, at most 12
  await expect(dialog.getByRole('option').first()).toBeVisible();
  expect(await dialog.getByRole('option').count()).toBeLessThanOrEqual(12);
  await input.fill('ретрай вебхука');
  const row = dialog.getByRole('option', { name: /Историческая сессия 2/ });
  await expect(row).toBeVisible();
  await expect(row.locator('mark')).toHaveText('ретрай вебхука');
  // the markup in the reply is shown as text, never parsed
  await expect(row.locator('.qs-snippet')).toContainText('<img src=x onerror="window.__xss=1">');
  await expect(dialog.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  expect(hub.requests.some(r => r.path === '/api/search')).toBe(true);
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /Историческая сессия 2/ })).toHaveAttribute('aria-selected', 'true');
});

test('Ничего не найдено, стрелки, Esc, cron', async ({ page }) => {
  await start(page);
  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog', { name: 'Быстрый переход' });
  const input = dialog.getByRole('combobox');
  const searches: string[] = [];
  page.on('request', r => r.url().includes('/api/search') && searches.push(r.url()));
  await input.fill('такого нигде нет');
  await expect(dialog.getByText('Ничего не найдено')).toBeVisible();
  await input.fill('сессия');
  await expect(dialog.getByRole('option').nth(1)).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(dialog.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
  expect(searches.every(u => u.includes('cron=0'))).toBe(true);
  await expect(dialog).toContainText('cron скрыт');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});
