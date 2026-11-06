// change client-versions on 390 px: the banner at the top under the bar with 44 px buttons, the profile menu as a
// bottom sheet with the versions, «Обновить» → the new build, a hidden page with a draft is not reloaded.
import { expect, test, type Page } from '@playwright/test';
import { MockHub } from '../mock/hub.js';

const banner = (page: Page) => page.getByRole('status', { name: 'Доступна новая версия' });

async function start(page: Page) {
  const hub = new MockHub({ tabs: [1, 4] });
  await hub.install(page);
  await page.goto('/');
  await expect(page.getByRole('complementary', { name: 'Сессии и проекты' })).toBeVisible();
  await expect.poll(() => hub.versionRequests).toBeGreaterThan(0);
  await page.evaluate(() => ((window as unknown as { __mark: number }).__mark = 1));
  return hub;
}
const sameDocument = (page: Page) => page.evaluate(() => (window as unknown as { __mark?: number }).__mark === 1).catch(() => false);

async function setHidden(page: Page, hidden: boolean) {
  await page.evaluate(h => {
    Object.defineProperty(document, 'visibilityState', { value: h ? 'hidden' : 'visible', configurable: true });
    Object.defineProperty(document, 'hidden', { value: h, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

test('banner on the phone: on top, 44 px buttons, the composer free; the bottom-sheet menu keeps it usable; «Обновить» → new build', async ({ page }) => {
  const hub = await start(page);
  hub.deploy('2222222');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(banner(page)).toBeVisible();
  for (const name of ['Позже', 'Обновить']) {
    const box = (await banner(page).getByRole('button', { name }).boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  const b = (await banner(page).boundingBox())!;
  expect(b.y).toBeLessThan(200);
  expect(b.x + b.width).toBeLessThanOrEqual(390);

  // the composer of an open chat is not covered
  await page.locator('.side-scroll > .srow', { hasText: 'Индексация Notion' }).click();
  const c = (await page.getByRole('textbox', { name: 'Сообщение' }).boundingBox())!;
  expect(b.y + b.height).toBeLessThan(c.y);
  await page.locator('.mbar').getByRole('button', { name: 'К списку' }).click();

  // profile menu: a bottom sheet with the versions, the banner above it stays clickable
  await page.getByRole('button', { name: 'Профиль' }).click();
  const menu = page.getByRole('menu', { name: 'Профиль' });
  const m = (await menu.boundingBox())!;
  expect(Math.round(m.y + m.height)).toBeGreaterThanOrEqual(843);
  expect(Math.round(m.width)).toBe(390);
  await expect(menu.getByLabel('Версии')).toContainText(/Клиент0\.1\.0 · 1111111/);
  await expect(menu.getByLabel('Версии')).toContainText(/Хаб0\.1\.0 · 2222222/);
  await expect(menu.getByRole('menuitem', { name: 'Обновить до новой версии' })).toBeVisible();
  await Promise.all([page.waitForEvent('load'), banner(page).getByRole('button', { name: 'Обновить' }).click()]);
  await expect(page.getByRole('complementary', { name: 'Сессии и проекты' })).toBeVisible();
  expect(await sameDocument(page)).toBe(false);
  await expect(banner(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Профиль' }).click();
  await expect(page.getByRole('menu', { name: 'Профиль' }).getByLabel('Версии')).toContainText(/Клиент0\.1\.0 · 2222222/);
});

test('PWA in the background with a draft: no reload, the draft is there on return', async ({ page }) => {
  const hub = await start(page);
  await page.locator('.side-scroll > .srow', { hasText: 'Индексация Notion' }).click();
  const box = page.getByRole('textbox', { name: 'Сообщение' });
  await box.fill('черновик с телефона');
  await setHidden(page, true);
  hub.deploy('2222222');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => hub.versionRequests).toBeGreaterThan(1);
  await page.waitForTimeout(800);
  expect(await sameDocument(page)).toBe(true);
  await setHidden(page, false);
  await expect(box).toHaveValue('черновик с телефона');
  await expect(banner(page)).toContainText('Черновик пропадёт');
});

test('PWA in the background without input: reloads silently onto the new build', async ({ page }) => {
  const hub = await start(page);
  await setHidden(page, true);
  hub.deploy('2222222');
  await Promise.all([page.waitForEvent('load'), page.evaluate(() => window.dispatchEvent(new Event('online')))]);
  await expect(page.getByRole('complementary', { name: 'Сессии и проекты' })).toBeVisible();
  await page.getByRole('button', { name: 'Профиль' }).click();
  await expect(page.getByRole('menu', { name: 'Профиль' }).getByLabel('Версии')).toContainText(/Клиент0\.1\.0 · 2222222/);
});
