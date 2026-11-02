// Tasks 4.8 and 4.9 against the in-memory hub on 1440×900. Requirements: workspace-ui «Дерево „Проекты“», «Строка
// проекта под шапкой чата», «Быстрый поиск Ctrl+K» (по проекту); project-grouping «Ручной перенос и закрепление».
import { expect, test, type Page } from '@playwright/test';
import { MockHub } from '../mock/hub.js';

async function start(page: Page, tabs = [1]) {
  const hub = new MockHub({ tabs, projects: true });
  await hub.install(page);
  await page.goto('/');
  await expect(page.getByRole('list', { name: 'Машины' })).toBeVisible();
  return hub;
}

test('Дерево по проектам: by freshness, «Без проекта» last, path in the tooltip, the project of the open session is open, archived muted', async ({ page }) => {
  await start(page);
  const names = await page.locator('.prow .pname').allTextContents();
  expect(names.at(-1)).toBe('Без проекта');
  expect(names.slice(0, 3)).toEqual(['04-site-c', '05-agent-hub', '04-copilot']);
  const hubRow = page.locator('.prow', { hasText: '05-agent-hub' });
  await expect(hubRow).toHaveAttribute('title', '20-personal/05-pos/systems/05-agent-hub');
  await expect(hubRow).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.prow', { hasText: '04-twenty-crm' })).toHaveClass(/archived/);
  // the tab has the square of its project colour
  const square = await page.locator('.tab.active .pdot').evaluate(el => getComputedStyle(el).backgroundColor);
  const personal = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--g-personal').trim());
  expect(square).not.toBe('rgba(0, 0, 0, 0)');
  expect(personal).not.toBe('');
});

test('Перенос с закреплением и открепление: «05-agent-hub ▾» → «Перенести в…» → 03-mm-sms-bridge; the tree follows; «Открепить» returns to the classifier', async ({ page }) => {
  const hub = await start(page);
  const head = page.locator('section.leaf .classline');
  await expect(head).toContainText('определено по путям: 3 правки в 05-agent-hub');
  await expect(head.getByText('+ 03-mm-sms-bridge')).toBeVisible();
  const btn = head.getByRole('button', { name: 'Проект: 05-agent-hub' });
  await btn.click();
  await expect(page.getByRole('menuitem')).toHaveText(['Перенести в…', 'Закрепить']);
  await page.getByRole('menuitem', { name: 'Перенести в…' }).click();
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/projects-picker.png` });
  await page.getByRole('combobox', { name: 'Найти проект' }).fill('sms');
  await expect(page.getByRole('listbox', { name: 'Проекты' }).getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(head).toContainText('закреплено вручную');
  await expect(head.getByRole('button', { name: 'Проект: 03-mm-sms-bridge, закреплён' })).toBeFocused();
  await expect(page.getByText('Проект закреплён')).toBeVisible();
  const put = hub.requests.find(r => r.method === 'PUT' && r.path.endsWith('/project'))!;
  expect(put.body).toEqual({ projectId: 'p-sms' });
  // the row is now under 03-mm-sms-bridge in the tree
  const smsGroup = page.locator('.prow', { hasText: '03-mm-sms-bridge' });
  await expect(smsGroup).toHaveAttribute('aria-expanded', 'true');
  await expect(smsGroup.locator('xpath=following-sibling::div[1]').getByText('GUI-прототип Agent Hub')).toBeVisible();
  // unpin: the classifier puts it back into 05-agent-hub
  await head.getByRole('button', { name: /Проект: 03-mm-sms-bridge/ }).click();
  await page.getByRole('menuitem', { name: 'Открепить' }).click();
  await expect(page.getByText('03-mm-sms-bridge → 05-agent-hub')).toBeVisible();
  await expect(head).toContainText('определено по путям: 3 правки в 05-agent-hub');
  await expect(head.getByRole('button', { name: 'Проект: 05-agent-hub' })).toBeVisible();
  await expect(page.locator('.prow', { hasText: '05-agent-hub' }).locator('xpath=following-sibling::div[1]').getByText('GUI-прототип Agent Hub')).toBeVisible();
});

test('Закрепить автоматическое решение: the evidence becomes «закреплено вручную», the item becomes «Открепить», the toast', async ({ page }) => {
  await start(page, [3]);
  const head = page.locator('section.leaf .classline');
  await head.getByRole('button', { name: 'Проект: 04-copilot' }).click();
  await page.getByRole('menuitem', { name: 'Закрепить' }).click();
  await expect(head).toContainText('закреплено вручную');
  await expect(page.getByText('Проект закреплён')).toBeVisible();
  await head.getByRole('button', { name: 'Проект: 04-copilot, закреплён' }).click();
  await expect(page.getByRole('menuitem')).toHaveText(['Перенести в…', 'Открепить']);
  await page.keyboard.press('Escape');
});

test('Проект определён: a session reclassified by the hub moves in the tree, the focused row keeps the focus', async ({ page }) => {
  const hub = await start(page, [1]);
  await page.locator('.prow', { hasText: 'Без проекта' }).click();
  const row = page.locator('.pchildren .srow', { hasText: 'Историческая сессия 5' });
  await row.focus();
  const s = hub.session(24);
  hub.upsert({
    ...s,
    project: { id: 'p-ledger', title: '01-ledger', colorKey: 'personal', path: '20-personal/01-finance/systems/01-ledger' },
    projectSource: 'auto',
    projectEvidence: '2 правки в 01-ledger',
  });
  hub.push({ type: 'toast', kind: 'project_auto', sessionId: s.id, title: s.title, text: 'Проект определён: Историческая сессия 5 → 01-ledger' });
  await expect(page.getByText('Проект определён: Историческая сессия 5 → 01-ledger')).toBeVisible();
  const moved = page.locator('.prow', { hasText: '01-ledger' }).locator('xpath=following-sibling::div[1]').locator('.srow', { hasText: 'Историческая сессия 5' });
  await expect(moved).toBeFocused();
});

test('Ctrl+K по проекту: «ledger» finds the sessions of 01-ledger', async ({ page }) => {
  await start(page);
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox', { name: 'Сессия или проект' }).fill('ledger');
  await expect(page.getByRole('option', { name: /Импорт выписки Т-Банка/ })).toBeVisible();
});
