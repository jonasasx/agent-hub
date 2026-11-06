// Phone chat uses the screen for the feed (Ivan, M4a): top bar 48 px, one line for the state and the project, a
// one-row composer; on 390×844 the feed gets ≥ 75% of the height. Requirement (workspace-ui): Телефонный режим.
import { expect, test, type Page } from '@playwright/test';
import { MockHub } from '../mock/hub.js';

async function open(page: Page, title: string) {
  const hub = new MockHub({ tabs: [1], projects: true });
  await hub.install(page);
  await page.goto('/');
  await expect(page.getByRole('complementary', { name: 'Сессии и проекты' })).toBeVisible();
  await page.getByRole('button', { name: 'Найти сессию' }).click();
  await page.getByRole('combobox', { name: 'Сессия или проект' }).fill(title);
  await page
    .getByRole('option', { name: new RegExp(title) })
    .first()
    .click();
  await expect(page.locator('.mbar')).toContainText(title);
  return hub;
}

const feedShare = (page: Page) => page.evaluate(() => document.querySelector('.messages')!.getBoundingClientRect().height / window.innerHeight);

for (const [title, kind] of [
  ['Сверка трасс кабелей КД', 'closed, read-only'],
  ['Импорт выписки Т-Банка', 'sleeping'],
  ['GUI-прототип Agent Hub', 'waiting'],
] as const) {
  test(`${kind}: top bar 48 px, one info line, one-row composer, the feed ≥ 75% of the height`, async ({ page }) => {
    await open(page, title);
    expect((await page.locator('.mbar').boundingBox())!.height).toBeLessThanOrEqual(49);
    await expect(page.locator('.banner')).toHaveCount(0);
    const info = (await page.locator('.phone-info').boundingBox())!;
    expect(info.height).toBeLessThanOrEqual(44);
    expect(await feedShare(page)).toBeGreaterThanOrEqual(0.75);
    if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/phone-compact-${kind.split(',')[0]}.png` });
  });
}

test('composer in one row: clip, field, send icon ≥ 40 px; the field grows up to five lines; model, mode, sleep timeout behind «⋯»', async ({ page }) => {
  await open(page, 'GUI-прототип Agent Hub');
  const box = page.getByRole('textbox', { name: 'Сообщение' });
  const send = page.getByRole('button', { name: 'Отправить' });
  const clip = page.getByRole('button', { name: 'Прикрепить изображение' });
  const [b, s, c] = [(await box.boundingBox())!, (await send.boundingBox())!, (await clip.boundingBox())!];
  expect(Math.abs(b.y + b.height - (s.y + s.height))).toBeLessThanOrEqual(2);
  expect(c.x).toBeLessThan(b.x);
  expect(s.x).toBeGreaterThan(b.x + b.width - 1);
  expect(Math.min(s.width, s.height, c.width, c.height)).toBeGreaterThanOrEqual(40);
  await expect(page.locator('.composer .pill.bypass')).toBeVisible();
  await box.fill('1\n2\n3\n4\n5\n6\n7\n8');
  const grown = (await box.boundingBox())!.height;
  expect(grown).toBeGreaterThan(b.height + 40);
  expect(grown).toBeLessThanOrEqual(5 * 22 + 20);
  await page.getByRole('button', { name: 'Режим прав и модель' }).click();
  await expect(page.getByRole('combobox', { name: 'Модель' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Усыплять при простое' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});
