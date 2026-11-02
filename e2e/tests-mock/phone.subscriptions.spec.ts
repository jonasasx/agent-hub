// change claude-subscriptions on 390×844: the registry, the usage, the form and «⋯» of the top bar fit the screen
// without horizontal scroll, controls ≥ 40 px.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { MockHub } from '../mock/hub.js';
import { openSettingsSection, settingsNav } from './subs-checks.js';

async function noHScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}

async function inside(l: Locator) {
  const b = (await l.boundingBox())!;
  expect(b.x).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width).toBeLessThanOrEqual(390.5);
}

async function tall(controls: Locator) {
  for (const c of await controls.all()) {
    if (!(await c.isVisible())) continue;
    const h = (await c.boundingBox())!.height;
    expect(h, await c.evaluate(e => e.outerHTML.slice(0, 120))).toBeGreaterThanOrEqual(40);
  }
}

test('телефон: «Настройки → Подписки» и «Расход» помещаются, контролы ≥ 40 px', async ({ page }) => {
  test.setTimeout(60_000); // one size check per control of the screen
  const hub = new MockHub({ subscriptions: true });
  await hub.install(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Подписки Claude' })).toHaveCount(0);
  // review 10.x M2: the items of the profile menu are ≥ 40 px on the phone
  await page.getByRole('button', { name: 'Профиль' }).click();
  await tall(page.getByRole('menu', { name: 'Профиль' }).getByRole('menuitem'));
  await page.keyboard.press('Escape');
  const set = await openSettingsSection(page, 'Подписки');
  // review 10.x M1: the five sections fit the 390 px screen (two lines), each ≥ 40 px
  const navItems = page.getByRole('navigation', { name: 'Разделы настроек' }).getByRole('button');
  await expect(navItems).toHaveCount(5);
  await tall(navItems);
  for (const b of await navItems.all()) await inside(b);
  const dlg = set.locator('.set-body');
  await expect(dlg.locator('.subs-name')).toHaveCount(2);
  await inside(dlg);
  await noHScroll(page);
  await tall(dlg.locator('button, input:not([type="checkbox"]), select, label.check'));
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/subs-registry-phone.png`, fullPage: true });
  await dlg.getByRole('button', { name: 'Max личная: действия' }).click();
  await page.getByRole('menuitem', { name: 'Заменить токен' }).click();
  await inside(dlg.getByLabel(/Новый токен/));
  await noHScroll(page);
  await settingsNav(page, 'Расход');
  await expect(dlg.getByRole('rowheader', { name: 'Вход машины' })).toBeVisible();
  await inside(dlg.locator('table'));
  await noHScroll(page);
  await tall(dlg.getByRole('radio'));
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/subs-usage-phone.png`, fullPage: true });
});

test('телефон: «Подписка» в «⋯» верхней панели', async ({ page }) => {
  const hub = new MockHub({ tabs: [1], subscriptions: true });
  await hub.install(page);
  await page.goto(`/s/${MockHub.id(1)}`);
  await expect(page.locator('.mbar')).toContainText(hub.session(1).title);
  await page.locator('.mbar').getByRole('button', { name: 'Режим прав и модель' }).click();
  const sel = page.getByRole('menu').getByLabel('Подписка', { exact: true });
  await expect(sel).toHaveValue(hub.subReg!.list[0]!.id);
  await tall(sel);
  await noHScroll(page);
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/subs-head-phone.png` });
});

test('телефон: «Подписка» в форме «Новая сессия»', async ({ page }) => {
  const hub = new MockHub({ subscriptions: true });
  await hub.install(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Новая сессия' }).click();
  const dlg = page.getByRole('dialog', { name: 'Новая сессия' });
  await tall(dlg.getByLabel('Подписка'));
  await inside(dlg);
  await noHScroll(page);
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/subs-new-phone.png` });
});
