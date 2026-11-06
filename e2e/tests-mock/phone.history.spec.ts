// The phone «назад» (bug from Ivan: «назад» in a chat left the app). Requirement (workspace-ui): Телефонный режим.
import { expect, test, type Page } from '@playwright/test';
import { MockHub } from '../mock/hub.js';

async function start(page: Page, path = '/') {
  const hub = new MockHub({ tabs: [9] });
  await hub.install(page);
  // a page of another site before the app: leaving the app would land there
  await page.goto('about:blank');
  await page.goto(path);
  await expect(page.locator('.app')).toBeAttached();
  return hub;
}
const list = (page: Page) => page.getByRole('complementary', { name: 'Сессии и проекты' });
const inApp = (page: Page) => expect(page).toHaveURL(/localhost:\d+\/$/);

test('список → чат → «назад» → список; a second chat replaces the entry; «←» also goes back', async ({ page }) => {
  await start(page);
  await page.locator('.side-scroll > .srow', { hasText: 'Индексация Notion' }).click();
  await expect(list(page)).toBeHidden();
  await page.goBack();
  await expect(list(page)).toBeVisible();
  await inApp(page);
  // two chats one after another: one «назад» is enough
  await page.locator('.side-scroll > .srow', { hasText: 'Индексация Notion' }).click();
  await page.getByRole('button', { name: 'К списку' }).click();
  await expect(list(page)).toBeVisible();
  await page.locator('.side-scroll > .srow', { hasText: '+N подписка' }).click();
  await expect(page.locator('.mbar')).toContainText('+N подписка');
  await page.goBack();
  await expect(list(page)).toBeVisible();
  await inApp(page);
  // from the list «назад» is the browser's: it leaves the app
  await page.goBack();
  await expect(page).toHaveURL('about:blank');
});

test('лайтбокс → «назад» → чат → «назад» → список', async ({ page }) => {
  await start(page);
  await page.getByRole('button', { name: /^ещё \d+/ }).click();
  await page.locator('.side-scroll .srow', { hasText: 'Скриншоты сайта' }).first().click();
  await page.locator('.msg.user', { hasText: 'Сравни эти три варианта' }).getByRole('button', { name: 'Открыть изображение 2 из 3' }).click();
  await expect(page.getByRole('dialog', { name: 'Изображение 3 из 4' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.mbar')).toContainText('Скриншоты сайта');
  await expect(list(page)).toBeHidden();
  await page.goBack();
  await expect(list(page)).toBeVisible();
  await inApp(page);
});

test('/s/<id> on the phone → «назад» → список', async ({ page }) => {
  await start(page, `/s/${MockHub.id(3)}`);
  await expect(page.locator('.mbar')).toContainText('Индексация Notion');
  await page.goBack();
  await expect(list(page)).toBeVisible();
  await inApp(page);
});
