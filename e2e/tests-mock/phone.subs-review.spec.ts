// change claude-subscriptions, task 6.6: the UI review fixes on 390×844 against the in-memory hub.
// C1 «Идёт ход: прервать и переключить?» from «⋯» is on top and clickable; C2 the note menu above the composer;
// P12 «Настройки → Подписки»: the auto-switch checkbox has a ≥ 40×40 target (10.4), long names are cut, «Заменить
// токен» from the note and «Назад» back to the chat.
import { expect, test } from '@playwright/test';
import { MockHub } from '../mock/hub.js';
import { menuAboveComposer, onTop, openSettingsSection } from './subs-checks.js';

test('C1: a pick in «⋯» of a working session closes the menu; «Прервать и переключить» is on top and switches with interrupt', async ({ page }) => {
  const hub = new MockHub({ tabs: [1, 2], subscriptions: true });
  await hub.install(page);
  await page.goto(`/s/${MockHub.id(2)}`);
  await expect(page.locator('.mbar')).toContainText(hub.session(2).title);
  const pro = hub.subReg!.list[1]!;
  await page.locator('.mbar').getByRole('button', { name: 'Режим прав и модель' }).click();
  await page.getByRole('menu').getByLabel('Подписка', { exact: true }).selectOption(pro.id);
  const dlg = page.getByRole('alertdialog', { name: 'Идёт ход: прервать и переключить?' });
  await expect(dlg).toBeVisible();
  await expect(page.getByRole('menu', { name: 'Режим прав и модель' })).toHaveCount(0);
  const go = dlg.getByRole('button', { name: 'Прервать и переключить' });
  await expect(go).toHaveClass(/\bdanger\b/);
  await expect(dlg.getByRole('button', { name: 'Отмена' })).toBeFocused();
  await onTop(page, go);
  await onTop(page, dlg.getByRole('button', { name: 'Отмена' }));
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/subs-confirm-phone.png` });
  await go.click();
  await expect(dlg).toHaveCount(0);
  expect(hub.subReg!.switches).toEqual([{ subscriptionId: pro.id }, { subscriptionId: pro.id, interrupt: true }]);
});

test('C2: the menu of the limit note opens above the composer and inside the screen', async ({ page }) => {
  const hub = new MockHub({ tabs: [1], subscriptions: true });
  await hub.install(page);
  await page.goto(`/s/${MockHub.id(1)}`);
  await expect(page.locator('.mbar')).toContainText(hub.session(1).title);
  hub.limitNote(1);
  const note = page.locator('.sysnote.sub-note.limit');
  await note.getByRole('button', { name: 'Продолжить под другой подпиской' }).click();
  const menu = page.getByRole('menu', { name: 'Продолжить под подпиской' });
  await expect(menu).toBeVisible();
  await menuAboveComposer(page, menu);
  await onTop(page, menu.getByRole('menuitem').first());
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/subs-limit-phone.png` });
});

test('10.4/M5: the auto-switch target is ≥ 40×40 and its edge toggles; long names are cut; no horizontal scroll', async ({ page }) => {
  const hub = new MockHub({ subscriptions: true });
  for (let i = 0; i < 6; i++) hub.subReg!.add(`Подписка с очень длинным именем номер ${i} для проверки обрезки`);
  await hub.install(page);
  await page.goto('/');
  const set = await openSettingsSection(page, 'Подписки');
  await expect(set.locator('.subs-name')).toHaveCount(8);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  for (const label of await set.locator('label.subs-auto').all()) {
    const r = await label.evaluate(e => {
      const b = e.getBoundingClientRect();
      return { w: b.width, h: b.height };
    });
    expect(r.w).toBeGreaterThanOrEqual(40);
    expect(r.h).toBeGreaterThanOrEqual(40);
  }
  // a tap at the edge of the target (not on the 18 px box) toggles the checkbox
  const first = set.locator('label.subs-auto').first();
  const box = (await first.boundingBox())!;
  const cb = first.locator('input[type="checkbox"]');
  await expect(cb).not.toBeChecked();
  await page.mouse.click(box.x + box.width - 2, box.y + box.height - 2);
  await expect(cb).toBeChecked();
  await expect.poll(() => hub.subReg!.list[0]!.autoSwitch).toBe(true);
  // M5: a long name is cut with an ellipsis and stays whole in the tooltip; grip and name on one line
  const long = set.locator('.subs-name', { hasText: 'номер 5' });
  await expect(long).toHaveCSS('text-overflow', 'ellipsis');
  expect(await long.evaluate(e => e.scrollWidth > e.clientWidth)).toBe(true);
  await expect(long).toHaveAttribute('title', /для проверки обрезки$/);
  const row = long.locator('xpath=ancestor::li');
  const grip = (await row.locator('.subs-grip').boundingBox())!;
  const name = (await long.boundingBox())!;
  expect(Math.abs(grip.y + grip.height / 2 - (name.y + name.height / 2))).toBeLessThanOrEqual(4);
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/subs-settings-phone.png` });
});

test('P12: «Заменить токен» в заметке чата открывает раздел с формой и фокусом; «Назад» возвращает в чат', async ({ page }) => {
  const hub = new MockHub({ tabs: [1], subscriptions: true });
  await hub.install(page);
  await page.goto(`/s/${MockHub.id(1)}`);
  await expect(page.locator('.mbar')).toContainText(hub.session(1).title);
  hub.authNote(1);
  await page.locator('.sysnote.sub-note.auth').getByRole('button', { name: 'Заменить токен' }).click();
  const set = page.getByRole('region', { name: 'Настройки' });
  await expect(page).toHaveURL(/\/settings\/subscriptions$/);
  await expect(set.getByLabel(/Новый токен «Max личная»/)).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.goBack();
  await expect(set).toHaveCount(0);
  await expect(page.locator('.mbar')).toContainText(hub.session(1).title);
  await expect(page.locator('.sysnote.sub-note.auth')).toBeVisible();
});
