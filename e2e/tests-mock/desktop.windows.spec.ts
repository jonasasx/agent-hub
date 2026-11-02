// Task 2.18: independent browser windows against the in-memory hub — several pages of one browser context share the
// hub (and the cookie) but each has its own sessionStorage, like browser tabs.
// Requirements (workspace-ui): Независимые окна; Раскладка нового окна и перезагрузка; Мои вкладки («Вытеснение не
// задевает другое окно»).
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { MockHub } from '../mock/hub.js';
// two browser windows per test: under the load of the full parallel run 30 s was not always enough (flaky timeouts)
test.describe.configure({ timeout: 90_000 });

const tab = (page: Page, title: string) => page.getByRole('tab', { name: new RegExp(title) });
const panes = (page: Page) => page.locator('section.leaf');

async function openWindow(ctx: BrowserContext, hub: MockHub): Promise<Page> {
  const page = await ctx.newPage();
  await hub.install(page);
  await page.goto('/');
  await expect(page.getByRole('list', { name: 'Машины' })).toBeVisible();
  return page;
}

/** What a window shows: tab titles per pane and the selected tab of each pane. */
async function view(page: Page) {
  return panes(page).evaluateAll(els =>
    els.map(el => ({
      tabs: [...el.querySelectorAll('[role="tab"] .t-title')].map(t => t.textContent),
      selected: el.querySelector('[role="tab"][aria-selected="true"] .t-title')?.textContent ?? null,
    })),
  );
}

test('Переключение, деление, Ctrl+\\ и закрытие вкладки в окне A не меняют окно B', async ({ context }) => {
  const hub = new MockHub({ tabs: [1, 2, 3, 4] });
  const a = await openWindow(context, hub);
  const b = await openWindow(context, hub);
  await expect(tab(b, 'GUI-прототип')).toHaveAttribute('aria-selected', 'true');
  const before = await view(b);
  expect(before).toHaveLength(1);

  await tab(a, 'Индексация').click();
  await a.keyboard.press('Control+3');
  await tab(a, 'Роллаут').dragTo(panes(a).first(), { targetPosition: { x: 1000, y: 400 } });
  await expect(panes(a)).toHaveCount(2);
  await a.keyboard.press('Control+Backslash');
  await expect(panes(a)).toHaveCount(1);
  await a.keyboard.press('Control+Backslash');
  await expect(panes(a)).toHaveCount(2);
  await tab(a, 'подписка').click({ button: 'middle' });
  await expect(tab(a, 'подписка')).toHaveCount(0);

  await b.waitForTimeout(1500);
  expect(await view(b)).toEqual(before);
  await expect(tab(b, 'подписка')).toHaveCount(1);
});

test('Перезагрузка сохраняет своё окно, новое окно получает раскладку последнего изменённого', async ({ context }) => {
  const hub = new MockHub({ tabs: [1, 2, 4] });
  const a = await openWindow(context, hub);
  const b = await openWindow(context, hub);
  // A: two panes
  await tab(a, 'Роллаут').dragTo(panes(a).first(), { targetPosition: { x: 1000, y: 400 } });
  await expect(panes(a)).toHaveCount(2);
  // B changes last: selects another tab and closes one
  await tab(b, 'подписка').click();
  await tab(b, 'Роллаут').click({ button: 'middle' });
  await expect.poll(() => JSON.stringify(hub.layouts.desktop.layout)).not.toContain(MockHub.id(2));

  await a.reload();
  await expect(panes(a)).toHaveCount(2);
  expect((await view(a)).map(p => p.tabs.length)).toEqual([2, 1]);

  const c = await openWindow(context, hub);
  await expect(panes(c)).toHaveCount(1);
  expect(await view(c)).toEqual(await view(b));
});

test('Вытеснение не задевает другое окно: the ninth tab in window A evicts only in A', async ({ context }) => {
  const hub = new MockHub({ tabs: [1, 2, 3, 4, 5, 6, 7, 8] });
  const a = await openWindow(context, hub);
  const b = await openWindow(context, hub);
  // B keeps three tabs
  for (const t of ['Индексация', 'подписка', 'Постмортем', 'Импорт выписки', 'Сверка трасс']) await tab(b, t).click({ button: 'middle' });
  await expect(b.getByRole('tab')).toHaveCount(3);
  const bBefore = await view(b);

  await a.getByRole('button', { name: /^ещё \d+/ }).click();
  await a.getByRole('button', { name: /Историческая сессия 1/ }).click();
  await expect(a.getByRole('tab')).toHaveCount(8);
  await expect(a.getByText('Вкладка убрана из полосы')).toBeVisible();

  await b.waitForTimeout(1000);
  expect(await view(b)).toEqual(bBefore);
  await expect(b.getByText('Вкладка убрана из полосы')).toHaveCount(0);
});
