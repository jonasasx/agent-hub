import { expect, test } from '@playwright/test';

const devLogin = process.env.E2E_DEV_LOGIN !== '0';

test('healthz answers 200', async ({ request }) => {
  const r = await request.get('/healthz');
  expect(r.status()).toBe(200);
});

test('API without a session answers 401', async ({ request }) => {
  const r = await request.get('/api/sessions');
  expect(r.status()).toBe(401);
  expect(await r.json()).toEqual({ error: 'unauthenticated' });
});

test('signed in: machines footer and theme switch', async ({ page }) => {
  test.skip(!devLogin, 'needs AUTH_DEV_EMAIL on the hub');
  await page.goto('/auth/dev-login?return=/');
  const machines = page.getByRole('complementary', { name: 'Сессии и проекты' });
  await expect(machines).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Светлая тема' }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const width = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(width).toBeLessThanOrEqual(0);
});
