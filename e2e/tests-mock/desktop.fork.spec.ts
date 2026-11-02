// Task 4.15 against the in-memory hub on 1440×900. Requirements (session-fork): Форма форка; Полная копия; Handoff;
// Пометка и размещение форка; (sessions) Офлайн-машина — «Handoff на другую машину».
import { expect, test, type Page } from '@playwright/test';
import { MockHub } from '../mock/hub.js';

async function start(page: Page, tabs = [1]) {
  const hub = new MockHub({ tabs });
  await hub.install(page);
  await page.goto('/');
  await expect(page.getByRole('list', { name: 'Машины' })).toBeVisible();
  return hub;
}

test('Форк справа: «⑂ Форк» → «Полная копия» → a pane right of the source; «форк от …» opens the source; «⑂» in the tree', async ({ page }) => {
  const hub = await start(page);
  const src = hub.session(1);
  await page.getByRole('button', { name: '⑂ Форк' }).click();
  const dlg = page.getByRole('dialog', { name: 'Форк сессии' });
  await expect(dlg.getByRole('radio', { name: /Полная копия/ })).toHaveAttribute('aria-checked', 'true');
  await expect(dlg.getByRole('checkbox', { name: 'Открыть справа, рядом с исходной' })).toBeChecked();
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/fork-copy.png` });
  await dlg.getByRole('button', { name: 'Создать копию' }).click();
  await expect(dlg).toHaveCount(0);
  const panes = page.locator('section.leaf');
  await expect(panes).toHaveCount(2);
  await expect(panes.nth(1)).toHaveClass(/focused/);
  await expect(panes.nth(1).locator('.chat-title')).toContainText(`форк от ${src.title}`);
  expect(hub.forks).toEqual([{ mode: 'copy', source: src.id, body: { mode: 'copy' } }]);
  await expect(page.locator('.srow', { hasText: '⑂' }).first()).toBeVisible();
  await panes.nth(1).getByRole('link', { name: src.title }).click();
  await expect(panes.nth(0)).toHaveClass(/focused/);
});

test('Офлайн-машина → «Handoff на другую машину»: the prompt from the hub, edited; ВМ .3 and its vault; the session starts there', async ({ page }) => {
  const hub = await start(page, [5]);
  const src = hub.session(5);
  await page.getByRole('button', { name: 'Handoff на другую машину' }).click();
  const dlg = page.getByRole('dialog', { name: 'Форк сессии' });
  await expect(dlg.getByRole('radio', { name: /Полная копия/ })).toBeDisabled();
  await expect(dlg.getByText('Полная копия: недоступно: машина офлайн')).toBeVisible();
  await expect(dlg.getByText(/Хаб готовит промпт/)).toBeVisible();
  const prompt = dlg.getByLabel('Промпт для новой сессии');
  await expect(prompt).toHaveValue(/## Цель/);
  await prompt.fill('## Цель\nдоделать постмортем');
  await dlg.getByRole('radio', { name: /ВМ \.3/ }).click();
  await expect(dlg.getByLabel('Каталог')).toHaveValue('/home/ubuntu/vault');
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/fork-handoff.png` });
  await dlg.getByRole('button', { name: 'Запустить handoff' }).click();
  await expect(dlg).toHaveCount(0);
  expect(hub.forks[0]).toMatchObject({ mode: 'handoff', source: src.id, body: { prompt: '## Цель\nдоделать постмортем', runnerId: 'vm', cwd: '/home/ubuntu/vault' } });
  await expect(page.locator('section.leaf.focused .chat-title')).toContainText(`форк от ${src.title}`);
  await expect(page.locator('section.leaf.focused .chat-title')).toContainText('ВМ .3');
});

test('a draft that failed shows the reason and «Повторить»; cwd_not_found stays in the form', async ({ page }) => {
  const hub = await start(page);
  hub.handoffFailures = 1;
  await page.getByRole('button', { name: '⑂ Форк' }).click();
  const dlg = page.getByRole('dialog', { name: 'Форк сессии' });
  await dlg.getByRole('radio', { name: /Handoff/ }).click();
  await expect(dlg.getByRole('alert')).toContainText('Модель не ответила за 120 с');
  await dlg.getByRole('button', { name: 'Повторить' }).click();
  await expect(dlg.getByLabel('Промпт для новой сессии')).toHaveValue(/## Цель/);
  await dlg.getByLabel('Каталог').fill('C:/Users/nope');
  await dlg.getByRole('button', { name: 'Запустить handoff' }).click();
  await expect(dlg.getByText('Каталог не найден на X1')).toBeVisible();
});
