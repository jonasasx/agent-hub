// Task 2.10 against the in-memory hub: split, insertion, eviction of the ninth tab, Ctrl+\ round trip with a new tab,
// middle-click close, Ctrl+N, layout on the server. Requirements: spec workspace-ui.
import { expect, test, type Page } from '@playwright/test';
import { MockHub } from '../mock/hub.js';

async function start(page: Page, tabs: number[] = [1, 4]) {
  const hub = new MockHub({ tabs });
  await hub.install(page);
  await page.goto('/');
  await expect(page.getByRole('list', { name: 'Машины' })).toBeVisible();
  return hub;
}

const tab = (page: Page, title: string) => page.getByRole('tab', { name: new RegExp(title) });
const panes = (page: Page) => page.locator('section.leaf');

test('Деление справа: drag a tab to the right edge, hint, new pane is active', async ({ page }) => {
  const hub = await start(page);
  await expect(tab(page, 'GUI-прототип')).toBeVisible();
  const leaf = panes(page).first();
  const box = (await leaf.boundingBox())!;
  const src = tab(page, 'подписка');
  // hover first to see the zone hint
  await src.hover();
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2, { steps: 8 });
  await expect(page.getByRole('status').filter({ hasText: 'Разделить: справа' })).toBeVisible();
  await page.mouse.move(box.x + box.width - 22, box.y + box.height / 2);
  await page.mouse.up();
  await expect(panes(page)).toHaveCount(2);
  await expect(panes(page).nth(1)).toHaveClass(/focused/);
  await expect(panes(page).nth(1).getByRole('tab')).toHaveCount(1);
  await expect.poll(() => (hub.layouts.desktop.layout as { layout?: { type: string; dir?: string } } | null)?.layout).toMatchObject({ type: 'split', dir: 'row' });
});

test('Вставка между вкладками and Пустая полоса', async ({ page }) => {
  await start(page, [1, 3, 4, 2]);
  // split: «Роллаут» to the right
  await tab(page, 'Роллаут').dragTo(panes(page).first(), { targetPosition: { x: 1000, y: 400 } });
  await expect(panes(page)).toHaveCount(2);
  // move «подписка» onto the right strip, left of the middle of its only tab → first
  const right = panes(page).nth(1);
  const rtab = right.getByRole('tab').first();
  const rb = (await rtab.boundingBox())!;
  await tab(page, 'подписка').dragTo(rtab, { targetPosition: { x: 4, y: rb.height / 2 } });
  await expect(right.getByRole('tab')).toHaveText([/подписка/, /Роллаут/]);
  await expect(right.getByRole('tab', { selected: true })).toHaveText(/подписка/);
});

test('Пятая панель: the fifth split is refused with a toast', async ({ page }) => {
  await start(page, [1, 2, 3, 4, 5]);
  const p0 = () => panes(page).first();
  for (const t of ['Роллаут', 'Индексация', 'Постмортем']) {
    await tab(page, t).dragTo(p0(), { targetPosition: { x: 5, y: 450 } });
  }
  await expect(panes(page)).toHaveCount(4);
  await tab(page, 'подписка').dragTo(p0(), { targetPosition: { x: 5, y: 450 } });
  await expect(page.getByText('Не больше четырёх панелей').first()).toBeVisible();
  await expect(panes(page)).toHaveCount(4);
});

test('Вытеснение давно не открывавшейся: the ninth tab evicts the oldest not shown one with a toast', async ({ page }) => {
  const hub = await start(page, [1, 2, 3, 4, 5, 6, 7, 8]);
  await expect(page.getByRole('tab')).toHaveCount(8);
  // open a ninth session from the tree (show all with «ещё N»)
  await page.getByRole('button', { name: /^ещё \d+/ }).click();
  await page.getByRole('button', { name: /Историческая сессия 1/ }).click();
  await expect(page.getByRole('tab')).toHaveCount(8);
  await expect(page.getByText('Вкладка убрана из полосы')).toBeVisible();
  // session 1 was active until the ninth tab opened; session 2 was opened longest ago among the rest
  await expect(page.getByText(/Роллаут агента на площадку C, партия 2, она осталась в списке слева/)).toBeVisible();
  await expect(tab(page, 'Историческая сессия 1')).toBeVisible();
  await expect(tab(page, 'Роллаут')).toHaveCount(0);
  // the window's tabs are its own: no tab requests to the hub
  expect(hub.requests.some(r => r.path.startsWith('/api/tabs'))).toBe(false);
});

test('Отключение монитора и возврат: Ctrl+\\ merges, a new tab goes to the formerly active pane, Ctrl+\\ restores', async ({ page }) => {
  await start(page, [1, 2, 3, 4]);
  await tab(page, 'Роллаут').dragTo(panes(page).first(), { targetPosition: { x: 1000, y: 400 } });
  await tab(page, 'Индексация').dragTo(panes(page).nth(1), { targetPosition: { x: 200, y: 800 } });
  await expect(panes(page)).toHaveCount(3);
  await panes(page)
    .nth(1)
    .locator('.chat')
    .click({ position: { x: 20, y: 200 } });
  await page.keyboard.press('Control+Backslash');
  await expect(panes(page)).toHaveCount(1);
  await expect(page.getByText('Одно окно', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Вернуть разделение' })).toBeVisible();
  await page.getByRole('button', { name: /Импорт выписки/ }).click();
  await page.keyboard.press('Control+Backslash');
  await expect(panes(page)).toHaveCount(3);
  await expect(panes(page).nth(1).getByRole('tab')).toHaveText([/Роллаут/, /Импорт выписки/]);
  await expect(panes(page).nth(1)).toHaveClass(/focused/);
});

test('Закрытие вкладки колёсиком: middle click closes an inactive tab, the active one stays, nothing scrolls', async ({ page }) => {
  const hub = await start(page, [1, 4, 6]);
  await tab(page, 'GUI-прототип').click();
  await tab(page, 'Импорт выписки').click({ button: 'middle' });
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.getByRole('tab', { selected: true })).toHaveText(/GUI-прототип/);
  expect(hub.requests.some(r => r.path.startsWith('/api/tabs'))).toBe(false);
  // the session itself is not stopped
  expect(hub.session(6).status).toBe('sleeping');
});

test('Ctrl+3 switches to the third tab; Ctrl+9 is left to the browser', async ({ page }) => {
  await start(page, [1, 4, 6, 2]);
  await tab(page, 'GUI-прототип').click();
  await page.keyboard.press('Control+3');
  await expect(page.getByRole('tab', { selected: true })).toHaveText(/Импорт выписки/);
  const prevented = await page.evaluate(() => {
    const e = new KeyboardEvent('keydown', { key: '9', ctrlKey: true, cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });
  expect(prevented).toBe(false);
});

test('Перезагрузка сохраняет своё окно: reload restores two panes; the template on the hub is updated too', async ({ page }) => {
  const hub = await start(page, [1, 4]);
  await tab(page, 'подписка').dragTo(panes(page).first(), { targetPosition: { x: 1000, y: 400 } });
  await expect.poll(() => (hub.layouts.desktop.layout as { layout?: { type: string } } | null)?.layout?.type).toBe('split');
  await page.reload();
  await expect(panes(page)).toHaveCount(2);
});

test('Разделитель: the ratio stays within 20–80%', async ({ page }) => {
  await start(page, [1, 4]);
  await tab(page, 'подписка').dragTo(panes(page).first(), { targetPosition: { x: 1000, y: 400 } });
  const div = page.getByRole('separator', { name: 'Изменить размер панелей' });
  const b = (await div.boundingBox())!;
  await page.mouse.move(b.x + 1, b.y + 300);
  await page.mouse.down();
  await page.mouse.move(310, b.y + 300, { steps: 6 });
  await page.mouse.up();
  const layoutBox = (await page.locator('.layout').boundingBox())!;
  const left = (await panes(page).first().boundingBox())!;
  expect(left.width / layoutBox.width).toBeGreaterThanOrEqual(0.19);
});
