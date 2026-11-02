// Change `subagents` on 390×844. Requirement (subagents): Субагенты на телефоне — the list as a sheet from the
// bottom, rows ≥ 44 px, no horizontal scroll; the subagent's chat over the parent's; «назад» → parent → list.
import { expect, test } from '@playwright/test';
import { MockHub } from '../mock/hub.js';

test('телефон: «Субагенты 4» → sheet → the subagent chat over the parent → «назад» to the parent → «назад» to the list', async ({ page }) => {
  const hub = new MockHub({ tabs: [1], subagents: true });
  await hub.install(page);
  await page.goto('about:blank');
  await page.goto('/');
  await expect(page.getByRole('list', { name: 'Машины' })).toBeAttached();
  await page
    .locator('.side-scroll .srow', { hasText: hub.session(1).title })
    .first()
    .click();
  await expect(page.locator('.mbar')).toContainText(hub.session(1).title);
  await page.getByRole('button', { name: /Субагенты 4/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Субагенты сессии' });
  await expect(sheet).toBeVisible();
  const b = (await sheet.boundingBox())!;
  expect(b.x).toBeLessThanOrEqual(1);
  expect(b.width).toBeGreaterThanOrEqual(388);
  expect(b.y + b.height).toBeGreaterThanOrEqual(843);
  for (const r of await sheet.locator('.sub-row').all()) expect((await r.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/subagents-phone-sheet.png` });
  await sheet.locator('.sub-row', { hasText: 'Phase 3 Dev M1' }).click();
  await expect(page.locator('.mbar')).toContainText('Субагент · Phase 3 Dev M1');
  await expect(page.getByText('Каркас собран, хаб поднят.')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Сообщение' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/subagents-phone-chat.png` });
  await page.goBack();
  await expect(page.locator('.mbar')).toContainText(hub.session(1).title);
  await expect(page.getByRole('textbox', { name: 'Сообщение' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('complementary', { name: 'Сессии и проекты' })).toBeVisible();
});

test('телефон: nested subagent → «назад» to the parent subagent; the parent link in the banner adds no duplicate entry', async ({ page }) => {
  const hub = new MockHub({ tabs: [1], subagents: true });
  await hub.install(page);
  await page.goto('about:blank');
  await page.goto('/');
  await expect(page.getByRole('list', { name: 'Машины' })).toBeAttached();
  const parent = hub.session(1).title;
  await page.locator('.side-scroll .srow', { hasText: parent }).first().click();
  await page.getByRole('button', { name: /Субагенты 4/ }).click();
  await page.getByRole('dialog', { name: 'Субагенты сессии' }).locator('.sub-row', { hasText: 'Phase 3 Dev M1' }).click();
  await expect(page.locator('.mbar')).toContainText('Субагент · Phase 3 Dev M1');
  // the nested fix from the developer's feed
  await page.locator('.tool-wrap', { hasText: 'Agent' }).getByRole('link', { name: 'Открыть чат субагента' }).click();
  await expect(page.locator('.mbar')).toContainText('Субагент · Fix layout');
  await page.goBack();
  await expect(page.locator('.mbar')).toContainText('Субагент · Phase 3 Dev M1');
  // the parent session from the banner: one step, «назад» then leaves to the list (no second parent entry)
  const depth = await page.evaluate(() => history.length);
  await page.locator('.sub-banner').getByRole('link', { name: parent }).click();
  await expect(page.locator('.mbar')).toContainText(parent);
  await expect(page.getByRole('textbox', { name: 'Сообщение' })).toBeVisible();
  expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(depth);
  await page.goBack();
  await expect(page.getByRole('complementary', { name: 'Сессии и проекты' })).toBeVisible();
});

test('телефон: no label over the user message in a session, the bubble on the right, no horizontal scroll', async ({ page }) => {
  const hub = new MockHub({ tabs: [1], subagents: true });
  await hub.install(page);
  await page.goto('/');
  await expect(page.getByRole('list', { name: 'Машины' })).toBeAttached();
  await page
    .locator('.side-scroll .srow', { hasText: hub.session(1).title })
    .first()
    .click();
  const userMsg = page.locator('.msg.user').first();
  await expect(userMsg).toBeVisible();
  await expect(userMsg.locator('.who')).toHaveCount(0);
  await userMsg.scrollIntoViewIfNeeded();
  const bubble = (await userMsg.locator('.bubble').boundingBox())!;
  const box = (await userMsg.boundingBox())!;
  expect(Math.abs(bubble.x + bubble.width - (box.x + box.width))).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/no-you-label-phone.png` });
});
