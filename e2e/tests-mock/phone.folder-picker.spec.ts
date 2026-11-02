import { expect, test, type Page } from '@playwright/test';
import { MockHub } from '../mock/hub.js';

async function openNewSession(page: Page) {
  const hub = new MockHub({ tabs: [1] });
  await hub.install(page);
  await page.route('**/api/catalog/projects*', route =>
    route.fulfill({ json: [{ id: 'picker-project', name: 'Picker Project', description: '', remote: null, archived: false, lastEventAt: null, bindings: [] }] }),
  );
  await page.route('**/api/runners/*/directories*', async route => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get('path') || '/home/test';
    const hidden = url.searchParams.get('showHidden') === 'true';
    const entries =
      path === '/home/test'
        ? [
            { name: 'alpha', path: '/home/test/alpha' },
            { name: 'beta', path: '/home/test/beta' },
            { name: 'gamma', path: '/home/test/gamma' },
            { name: 'delta', path: '/home/test/delta' },
            { name: 'epsilon', path: '/home/test/epsilon' },
          ]
        : [{ name: 'child', path: `${path}/child` }];
    await route.fulfill({
      json: { path, parent: path === '/' ? null : path.slice(0, path.lastIndexOf('/')) || '/', directories: hidden ? [...entries, { name: '.hidden', path: `${path}/.hidden` }] : entries },
    });
  });
  await page.goto('/');
  await expect(page.locator('.side button.btn.primary')).toBeVisible();
  await page.locator('.side button.btn.primary').click();
  return { hub, dialog: page.locator('.modal[role=dialog]').first() };
}

for (const theme of ['light', 'dark'] as const) {
  test(`remote folder picker ${theme}: create and bind paths, navigation and mobile fit`, async ({ page }, testInfo) => {
    await page.addInitScript(value => localStorage.setItem('ah-theme', value), theme);
    const { dialog } = await openNewSession(page);
    const createProject = dialog.locator('.project-list .seg-opt').last();
    await createProject.click();
    await dialog.locator('input[id$="-ppath"]').fill('/home/test');
    await dialog.locator('.folder-path-row button').first().click();
    const picker = page.locator('.folder-picker');
    await expect(picker.locator('.folder-entry').nth(4)).toBeVisible();
    if (process.env.SHOTS_DIR) await picker.screenshot({ path: `${process.env.SHOTS_DIR}/folder-picker-${testInfo.project.name}-${theme}.png` });
    await picker.locator('.folder-entry').first().click();
    await expect(picker.locator('.folder-entry').first()).toContainText('child');
    await picker.locator('input[type=checkbox]').check();
    await expect(picker.locator('.folder-entry').last()).toContainText('.hidden');
    await picker.locator('.modal-foot button.primary').click();
    await expect(dialog.locator('input[id$="-ppath"]')).toHaveValue('/home/test/alpha');
    await dialog.locator('.project-list .seg-opt').nth(1).click();
    await dialog.locator('.folder-path-row button').last().click();
    await expect(page.locator('.folder-picker')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 360, height: 640 },
  ]) {
    test(`folder picker layout ${viewport.width}x${viewport.height} ${theme}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.addInitScript(value => localStorage.setItem('ah-theme', value), theme);
      const { dialog } = await openNewSession(page);
      await dialog.locator('.project-list .seg-opt').last().click();
      await dialog.locator('input[id$="-ppath"]').fill('/home/test');
      await dialog.locator('.folder-path-row button').first().click();

      const picker = page.locator('.folder-picker');
      const crumbs = picker.locator('.folder-crumbs');
      const crumb = crumbs.locator('button').first();
      const headingBox = await picker.locator('.modal-head b').boundingBox();
      const closeBox = await picker.locator('.modal-head .icon-btn').boundingBox();
      await expect(crumb).toBeVisible();
      const crumbBox = await crumb.boundingBox();
      const crumbsBox = await crumbs.boundingBox();
      const footerBox = await picker.locator('.modal-foot').boundingBox();
      expect(crumbBox?.height).toBeGreaterThan(0);
      expect(closeBox!.x).toBeGreaterThan(headingBox!.x + headingBox!.width);
      expect(Math.abs(closeBox!.y + closeBox!.height / 2 - (headingBox!.y + headingBox!.height / 2))).toBeLessThan(12);
      expect(crumbsBox?.height).toBeGreaterThanOrEqual(24);
      expect(crumbBox!.y).toBeGreaterThanOrEqual(0);
      expect(crumbBox!.y + crumbBox!.height).toBeLessThanOrEqual(viewport.height);
      expect(footerBox!.y + footerBox!.height).toBeLessThanOrEqual(viewport.height);
      await expect(picker.getByRole('button', { name: 'Выбрать эту папку' })).toBeVisible();

      if (process.env.SHOTS_DIR) await picker.screenshot({ path: `${process.env.SHOTS_DIR}/folder-picker-phone-${viewport.width}x${viewport.height}-${theme}.png` });
    });
  }
}
