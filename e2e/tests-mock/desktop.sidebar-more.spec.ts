// QA (prod c369743): «ещё N» asked the hub for limit=500, the hub answers 400 (limit ≤ 200) and the rest of the
// project stayed unreachable. MockHub validates limit like the hub. Requirement: spec workspace-ui, левая панель.
import { expect, test } from '@playwright/test';
import { MockHub } from '../mock/hub.js';

test('Ещё N: more than 200 hidden sessions all appear, no page errors', async ({ page }) => {
  const hub = new MockHub({ history: 250, tabs: [1] });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(String(e)));
  await hub.install(page);
  await page.goto('/');
  const more = page.getByRole('button', { name: /^ещё \d+/ });
  await expect(more).toBeVisible();
  await more.click();
  await expect(page.getByText('Историческая сессия 250', { exact: true })).toBeAttached();
  await expect(page.getByText('Историческая сессия 1', { exact: true })).toBeAttached();
  await expect(more).toHaveCount(0);
  const asked = hub.requests.filter(r => /^\/api\/projects\/[^/]+\/sessions$/.test(r.path));
  expect(asked.length).toBeGreaterThanOrEqual(2);
  expect(errors).toEqual([]);
});
