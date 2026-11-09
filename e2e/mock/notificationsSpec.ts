/**
 * «Настройки → Уведомления» at one viewport and theme (change web-push-notifications, tasks 3.6–3.7, mock hub): the page
 * opens, shows the status and the list of devices, no horizontal scroll; screenshots when SHOTS_DIR is set.
 */
import { expect, test, type Page } from '@playwright/test';
import { MockHub } from './hub.js';

const dir = process.env.SHOTS_DIR;
const VAPID = 'BAUQ-' + 'A'.repeat(82);

async function noHScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}

const devices = [
  { id: 'd1', label: 'Chrome · Windows', endpointHash: 'a'.repeat(64), createdAt: '2026-11-01T10:00:00Z', lastSuccessAt: '2026-11-05T12:30:00Z', lastFailureAt: null, failureCount: 0 },
  { id: 'd2', label: 'Safari · iOS', endpointHash: 'b'.repeat(64), createdAt: '2026-11-03T09:00:00Z', lastSuccessAt: null, lastFailureAt: '2026-11-05T12:00:00Z', failureCount: 3 },
];

export function notificationsSpecs(device: 'desktop' | 'phone') {
  for (const theme of ['dark', 'light'] as const) {
    test(`${device} ${theme}: push is not configured on the hub`, async ({ page }) => {
      await page.addInitScript(t => localStorage.setItem('ah-theme', t), theme);
      const hub = new MockHub({ tabs: [] });
      await hub.install(page);
      await page.goto('/settings/notifications');
      await expect(page.getByRole('heading', { name: 'Notifications', level: 2 })).toBeVisible();
      await expect(page.getByText('Push is not configured on the server')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Enable push on this device' })).toHaveCount(0);
      await noHScroll(page);
      if (dir) await page.screenshot({ path: `${dir}/push-${device}-${theme}-off.png`, fullPage: true });
    });

    test(`${device} ${theme}: configured hub lists the devices`, async ({ page }) => {
      await page.addInitScript(t => localStorage.setItem('ah-theme', t), theme);
      const hub = new MockHub({ tabs: [], push: { vapidPublicKey: VAPID, devices } });
      await hub.install(page);
      await page.goto('/settings/notifications');
      await expect(page.getByText('Safari · iOS')).toBeVisible();
      await expect(page.getByText('Delivery is failing: 3 in a row')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Disconnect: Safari · iOS' })).toBeVisible();
      await noHScroll(page);
      if (dir) await page.screenshot({ path: `${dir}/push-${device}-${theme}-devices.png`, fullPage: true });
    });
  }
}
