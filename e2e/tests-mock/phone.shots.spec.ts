// Phone screenshots for the comparison with docs/prototype.html (run with SHOTS_DIR=<dir>; skipped otherwise).
import { expect, test } from '@playwright/test';
import { MockHub } from '../mock/hub.js';

const dir = process.env.SHOTS_DIR;

for (const theme of ['dark', 'light'] as const) {
  test(`phone shots ${theme}`, async ({ page }) => {
    test.skip(!dir, 'SHOTS_DIR not set');
    await page.addInitScript(t => localStorage.setItem('ah-theme', t), theme);
    const hub = new MockHub({ tabs: [1, 4] });
    await hub.install(page);
    await page.goto('/');
    await expect(page.locator('.prow').first()).toBeVisible();
    await page.screenshot({ path: `${dir}/app-phone-list-${theme}.png` });
    await page.locator('.side-scroll > .srow', { hasText: 'Индексация Notion' }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${dir}/app-phone-chat-${theme}.png` });
    const p = await page.context().newPage();
    await p.goto(new URL('../../docs/prototype.html', import.meta.url).href);
    await p.evaluate(t => (document.documentElement.dataset.theme = t), theme);
    await p.waitForTimeout(400);
    await p.screenshot({ path: `${dir}/proto-phone-list-${theme}.png` });
  });
}
