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
    if (/^[A-Z]:\\/i.test(path)) {
      const parent = path.length <= 3 ? null : path.slice(0, path.lastIndexOf('\\')) || path.slice(0, 3);
      const childPath = path.endsWith('\\') ? `${path}child` : `${path}\\child`;
      await route.fulfill({ json: { path, parent, directories: [{ name: 'child', path: childPath }] } });
      return;
    }
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

test('Windows mock: breadcrumb navigation uses each accumulated path and Escape restores focus', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ah-theme', 'light'));
  const { dialog } = await openNewSession(page);
  await expect(page.locator('.app')).toHaveAttribute('inert', '');
  await dialog.locator('.project-list .seg-opt').last().click();
  const pathInput = dialog.locator('input[id$="-ppath"]');
  await pathInput.fill('C:\\Users\\Alice\\work');
  const trigger = dialog.locator('.folder-path-row button').first();
  await trigger.click();
  const picker = page.locator('.folder-picker');
  await expect(dialog).toHaveAttribute('aria-hidden', 'true');
  const close = picker.locator('.modal-head button');
  await expect(close).toBeFocused();
  const crumbs = picker.locator('.folder-crumbs button');
  await crumbs.nth(0).click();
  await expect(picker.locator('.folder-current span')).toHaveText('C:\\');
  await picker.locator('.folder-entry').click();
  await expect(picker.locator('.folder-current span')).toHaveText('C:\\child');
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-hidden', 'false');
  await expect(page.locator('.app')).toHaveAttribute('inert', '');
  await dialog.locator('.modal-foot button.btn.ghost').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.app')).not.toHaveAttribute('inert', '');
});

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
}
