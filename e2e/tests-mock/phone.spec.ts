// Task 2.13 on 390×844 against the in-memory hub. Requirement (workspace-ui): Телефонный режим;
// Раскладка хранится на сервере (separate phone layout).
import { expect, test, type Page } from '@playwright/test';
import { MockHub } from '../mock/hub.js';

async function start(page: Page, tabs: number[] = [1, 4]) {
  const hub = new MockHub({ tabs });
  await hub.install(page);
  await page.goto('/');
  await expect(page.getByRole('complementary', { name: 'Сессии и проекты' })).toBeVisible();
  return hub;
}
const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test('Открыть сессию на телефоне: left panel first, chat over it, «←» back, no horizontal scroll', async ({ page }) => {
  const hub = await start(page);
  await expect(page.locator('main.pane')).toBeHidden();
  expect(await noHScroll(page)).toBeLessThanOrEqual(0);
  await page.locator('.side-scroll > .srow', { hasText: 'Индексация Notion' }).click();
  await expect(page.getByRole('complementary', { name: 'Сессии и проекты' })).toBeHidden();
  const bar = page.locator('.mbar');
  await expect(bar).toContainText('Индексация Notion: вложенные страницы');
  // mode and model behind «⋯» in the top bar; the fork button comes with M4 (UI review M10, L3)
  await expect(bar.getByRole('button', { name: 'Режим прав и модель' })).toBeVisible();
  await expect(bar.getByRole('img', { name: 'ждёт разрешения' })).toBeVisible();
  // no tab strips and no split on the phone
  await expect(page.getByRole('tablist')).toHaveCount(0);
  await expect(page.locator('section.leaf')).toHaveCount(1);
  await expect(page.getByRole('group', { name: /Запрос разрешения/ })).toBeVisible();
  expect(await noHScroll(page)).toBeLessThanOrEqual(0);
  await bar.getByRole('button', { name: 'К списку' }).click();
  await expect(page.getByRole('complementary', { name: 'Сессии и проекты' })).toBeVisible();
  expect(await noHScroll(page)).toBeLessThanOrEqual(0);
  // the phone layout is stored separately
  await expect.poll(() => hub.requests.some(r => r.method === 'PUT' && (r.body as { device?: string }).device === 'phone')).toBe(true);
  expect(hub.requests.some(r => r.method === 'PUT' && (r.body as { device?: string }).device === 'desktop')).toBe(false);
});

test('Ctrl+\\ does nothing on the phone; the new-session form fits the screen', async ({ page }) => {
  await start(page, [1, 4]);
  await page.locator('.prow').first().waitFor();
  await page.keyboard.press('Control+Backslash');
  await expect(page.getByText('Одно окно', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Новая сессия' }).click();
  await expect(page.getByRole('dialog', { name: 'Новая сессия' })).toBeVisible();
  expect(await noHScroll(page)).toBeLessThanOrEqual(0);
});

test('Review B3 on the phone: «←», the session answers meanwhile, opening it again shows the answer', async ({ page }) => {
  const hub = await start(page, [2]);
  await page.locator('.side-scroll > .srow', { hasText: 'Роллаут' }).click();
  await expect(page.locator('.thinking')).toBeVisible();
  await page.locator('.mbar').getByRole('button', { name: 'К списку' }).click();
  await expect.poll(() => hub.received.filter(m => m.type === 'subscribe').at(-1)).toEqual({ type: 'subscribe', sessionIds: [], subagentIds: [] });
  hub.appendAnswer(2, 'Готово, пока ты был в списке.');
  await page.locator('.side-scroll .srow', { hasText: 'Роллаут' }).first().click();
  await expect(page.getByText('Готово, пока ты был в списке.')).toBeVisible();
});
