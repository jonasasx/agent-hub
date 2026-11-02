// Screenshots for the comparison with docs/prototype.html (run with SHOTS_DIR=<dir>; skipped otherwise).
import { expect, test } from '@playwright/test';
import { MockHub } from '../mock/hub.js';

const dir = process.env.SHOTS_DIR;

for (const theme of ['dark', 'light'] as const) {
  test(`shots ${theme}`, async ({ page }) => {
    test.skip(!dir, 'SHOTS_DIR not set');
    await page.addInitScript(t => localStorage.setItem('ah-theme', t), theme);
    const hub = new MockHub({ tabs: [1, 3, 4, 2] });
    await hub.install(page);
    await page.goto('/');
    await expect(page.getByRole('tab').first()).toBeVisible();
    await page.getByRole('tab', { name: /Роллаут/ }).dragTo(page.locator('section.leaf').first(), { targetPosition: { x: 1000, y: 400 } });
    await page.getByRole('tab', { name: /GUI-прототип/ }).click();
    await page.screenshot({ path: `${dir}/pre-${theme}.png` });
    await page
      .locator('details.tool')
      .nth(1)
      .evaluate(d => ((d as HTMLDetailsElement).open = true));
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${dir}/app-desktop-${theme}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await page.getByRole('tab', { name: /Индексация/ }).click();
    await page.screenshot({ path: `${dir}/app-desktop-perm-${theme}.png` });
    await page.getByRole('button', { name: 'Новая сессия' }).click();
    await page.screenshot({ path: `${dir}/app-desktop-new-${theme}.png` });
    const p = await page.context().newPage();
    await p.goto(new URL('../../docs/prototype.html', import.meta.url).href);
    await p.evaluate(t => (document.documentElement.dataset.theme = t), theme);
    await p.waitForTimeout(500);
    await p.screenshot({ path: `${dir}/proto-desktop-${theme}.png` });
  });
}
