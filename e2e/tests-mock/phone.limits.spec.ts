// change subscription-limits on 390×844: the «Подписки» window of the drawer, the card as a bottom sheet from the chip
// in the session info line; targets ≥ 40 px, no horizontal scroll, both themes.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { MockHub } from '../mock/hub.js';
import { mockWindow } from '../mock/limits.js';
import { LONG_WINDOW, limitRowsFit, longLimitsHub } from './limits-checks.js';

const shots = process.env.SHOTS_DIR;

async function noHScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}

async function tall(controls: Locator) {
  for (const c of await controls.all()) {
    if (!(await c.isVisible())) continue;
    const h = (await c.boundingBox())!.height;
    expect(h, await c.evaluate(e => e.outerHTML.slice(0, 120))).toBeGreaterThanOrEqual(40);
  }
}

function hub3() {
  const hub = new MockHub({ tabs: [1], subscriptions: true, limits: true });
  const third = hub.subReg!.add('Max рабочая');
  hub.limReg!.set(third.id, { state: 'ok', reason: null, windows: [mockWindow('five_hour', 96, 70, 'allowed_warning'), mockWindow('seven_day', 61, 4000)], lastOkAt: new Date().toISOString() });
  return hub;
}

/** The «Подписки» window of the phone: ☰ «Окна» → «Подписки». */
async function openSubsWindow(page: Page) {
  await page.getByRole('button', { name: 'Окна' }).click();
  await page.getByRole('menuitem', { name: /^Подписки/ }).click();
  const w = page.getByRole('region', { name: 'Подписки' });
  await expect(w.locator('.tw-subs')).toBeVisible();
  return w;
}

for (const theme of ['dark', 'light'] as const) {
  test(`телефон, ${theme}: окно «Подписки» — кольца, раскрытие, заголовки ≥ 40 px, карточка снизу из метки`, async ({ page }) => {
    await page.addInitScript(t => localStorage.setItem('ah-theme', t), theme);
    const hub = hub3();
    await hub.install(page);
    await page.goto('/');
    await expect(page.getByRole('complementary', { name: 'Сессии и проекты' })).toBeVisible();
    const w = await openSubsWindow(page);
    const heads = w.locator('.tw-sh');
    await expect(heads).toHaveCount(3);
    await tall(heads);
    await expect(w.getByRole('img', { name: /^5 ч — 96%/ })).toBeVisible();
    if (shots) await page.screenshot({ path: `${shots}/limits-phone-${theme}-summary.png` });
    await heads.first().click();
    await expect(w.locator('.tw-lim').first()).toBeVisible();
    // one line each: the name fits the 390 px column
    for (const r of await heads.all()) expect(await r.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await noHScroll(page);
    if (shots) await page.screenshot({ path: `${shots}/limits-phone-${theme}.png` });
  });
}

test('телефон: метка в строке сессии, тап — нижняя панель той же карточки', async ({ page }) => {
  const hub = new MockHub({ tabs: [1], subscriptions: true, limits: true });
  await hub.install(page);
  await page.goto(`/s/${MockHub.id(1)}`);
  await expect(page.locator('.mbar')).toContainText(hub.session(1).title);
  const chip = page.locator('.phone-info .lchip');
  await expect(chip).toHaveText('!82% · 5 ч');
  await tall(chip);
  await noHScroll(page);
  if (shots) await page.screenshot({ path: `${shots}/limits-phone-dark-chip.png` });
  await chip.click();
  const card = page.getByRole('dialog', { name: /Max личная/ });
  await expect(card).toBeVisible();
  expect(Math.round((await card.boundingBox())!.width)).toBe(390);
  await page.getByRole('button', { name: 'Закрыть' }).click();
  await expect(card).toHaveCount(0);
  await expect(chip).toBeFocused();
});

test('QA 8.1, телефон: 30-символьные имена — заголовки окна «Подписки» в одну линию, «обновите агента» в карточке', async ({ page }) => {
  const hub = longLimitsHub();
  await hub.install(page);
  await page.goto('/');
  await expect(page.getByRole('complementary', { name: 'Сессии и проекты' })).toBeVisible();
  const w = await openSubsWindow(page);
  await limitRowsFit(page, 3);
  await w.locator('.tw-sh').nth(2).click();
  await expect(w.locator('.tw-sub').nth(2).locator('.tw-ln')).toContainText(LONG_WINDOW.slice(0, 12));
  await limitRowsFit(page, 3);
  await noHScroll(page);
  if (shots) await page.screenshot({ path: `${shots}/limits-phone-long.png` });
  // the card of the session's subscription still names the machines
  await page.getByRole('button', { name: 'Назад' }).click();
  await page.goto(`/s/${MockHub.id(1)}`);
  const chip = page.locator('.phone-info .lchip');
  await chip.tap();
  const card = page.getByRole('dialog', { name: /Max личная/ });
  await expect(card).toContainText('Нет данных: обновите агента на X1-Carbon-Gen13, HP-Elitebook, vault.');
  await page.getByRole('button', { name: 'Закрыть' }).click();
  await expect(card).toHaveCount(0);
});
