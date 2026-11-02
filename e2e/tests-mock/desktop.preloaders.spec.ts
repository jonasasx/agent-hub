// Preloaders (Ivan, M4a): a skeleton while the history loads, gone after; no animation with reduced motion.
import { expect, test, type Page } from '@playwright/test';
import { MockHub } from '../mock/hub.js';

async function start(page: Page) {
  const hub = new MockHub({ tabs: [1], eventsDelayMs: 1500 });
  await hub.install(page);
  await page.goto('/');
  return hub;
}

test('the history skeleton shimmers while /events answers and goes away after', async ({ page }) => {
  await start(page);
  const sk = page.getByRole('status', { name: 'Загрузка истории' });
  await expect(sk).toBeVisible();
  expect(
    await sk
      .locator('.skeleton')
      .first()
      .evaluate(el => getComputedStyle(el).animationName),
  ).toBe('ah-shimmer');
  await expect(page.locator('details.tool').first()).toBeVisible();
  await expect(sk).toHaveCount(0);
});

test('reduced motion: the skeleton, the dots and the spinner stand still', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await start(page);
  const sk = page.getByRole('status', { name: 'Загрузка истории' });
  await expect(sk).toBeVisible();
  expect(
    await sk
      .locator('.skeleton')
      .first()
      .evaluate(el => getComputedStyle(el).animationName),
  ).toBe('none');
  const still = await page.evaluate(() => {
    const host = document.createElement('div');
    host.innerHTML = '<span class="spinner"></span><span class="dots"><i></i></span>';
    document.body.append(host);
    const r = [getComputedStyle(host.querySelector('.spinner')!).animationName, getComputedStyle(host.querySelector('.dots i')!).animationName];
    host.remove();
    return r;
  });
  expect(still).toEqual(['none', 'none']);
});
