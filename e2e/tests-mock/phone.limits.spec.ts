// change subscription-limits on 390×844: the block on the home screen, the summary from 3 subscriptions, the card as
// a bottom sheet, the chip in the session info line; targets ≥ 40 px, no horizontal scroll, both themes.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { MockHub } from '../mock/hub.js';
import { mockWindow } from '../mock/limits.js';
import { LONG_NAMES, LONG_WINDOW, limitRowsFit, longLimitsHub } from './limits-checks.js';

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

for (const theme of ['dark', 'light'] as const) {
  test(`телефон, ${theme}: три подписки — сводка, раскрытие, строки ≥ 40 px, карточка снизу`, async ({ page }) => {
    await page.addInitScript(t => localStorage.setItem('ah-theme', t), theme);
    const hub = hub3();
    await hub.install(page);
    await page.goto('/');
    const block = page.getByRole('region', { name: 'Лимиты подписок' });
    const sum = block.getByRole('button', { name: /^Лимиты, худшая подписка Max рабочая/ });
    await expect(sum).toBeVisible();
    await tall(sum);
    if (shots) await page.screenshot({ path: `${shots}/limits-phone-${theme}-summary.png` });
    await sum.click();
    const rows = block.getByRole('button', { name: /Подробнее$/ });
    await expect(rows).toHaveCount(3);
    await tall(rows);
    await tall(block.getByRole('button', { name: 'свернуть' }));
    // one line each: the name and the right side fit the 390 px panel
    for (const r of await rows.all()) expect(await r.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await noHScroll(page);
    if (shots) await page.screenshot({ path: `${shots}/limits-phone-${theme}.png` });

    await rows.first().click();
    const card = page.getByRole('dialog', { name: /Max личная/ });
    await expect(card).toBeVisible();
    await card.evaluate(el => Promise.all(el.getAnimations().map(x => x.finished)));
    const b = (await card.boundingBox())!;
    expect(Math.round(b.x)).toBe(0);
    expect(Math.round(b.width)).toBe(390);
    expect(Math.abs(b.y + b.height - 844)).toBeLessThanOrEqual(1);
    await tall(card.getByRole('button'));
    await noHScroll(page);
    if (shots) await page.screenshot({ path: `${shots}/limits-phone-${theme}-card.png` });
    // the scrim closes it
    await page.mouse.click(195, 40);
    await expect(card).toHaveCount(0);
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

test('QA 8.1, телефон: 30-символьные имена и «обновите агента» на трёх машинах — сводка и строки в одну линию', async ({ page }) => {
  const hub = longLimitsHub();
  await hub.install(page);
  await page.goto('/');
  const block = page.getByRole('region', { name: 'Лимиты подписок' });
  const sum = block.getByRole('button', { name: /^Лимиты, худшая подписка/ });
  await expect(sum).toBeVisible();
  await limitRowsFit(page, 1);
  await sum.click();
  await expect(block.getByRole('button', { name: /Подробнее$/ })).toHaveCount(3);
  const r = block.getByRole('button', { name: new RegExp(`^${LONG_NAMES[0]}: `) });
  await expect(r.locator('.ll')).toHaveText('нет данных: обновите агента');
  await expect(r).toHaveAccessibleName(/обновите агента на X1-Carbon-Gen13, HP-Elitebook, vault/);
  await expect(block.getByRole('button', { name: new RegExp(`^${LONG_NAMES[2]}: `) }).locator('.ll')).toContainText(LONG_WINDOW);
  await limitRowsFit(page, 3);
  await noHScroll(page);
  if (shots) await page.screenshot({ path: `${shots}/limits-phone-long.png` });
  // a tap leaves no hover background once the card is closed (QA 8.1: hover only on hover-capable devices)
  await r.tap();
  const card = page.getByRole('dialog', { name: /Max личная/ });
  await expect(card).toContainText('Нет данных: обновите агента на X1-Carbon-Gen13, HP-Elitebook, vault.');
  await page.getByRole('button', { name: 'Закрыть' }).click();
  await expect(card).toHaveCount(0);
  const bg = await r.evaluate(e => getComputedStyle(e).backgroundColor);
  expect(bg).toBe('rgba(0, 0, 0, 0)');
});
