// «Показать раньше» keeps the reading position (UI review M3b). Requirement (chat-view): История сессии подгружается
// страницами.
import { expect, test } from '@playwright/test';
import { MockHub } from '../mock/hub.js';

test('Показать раньше: older events come in above, the first visible message stays where it was', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 420 });
  const hub = new MockHub({ tabs: [1], pageSize: 10 });
  await hub.install(page);
  await page.goto('/');
  const feed = page.locator('section.leaf .messages');
  const more = feed.getByRole('button', { name: 'Показать раньше' });
  await expect(more).toBeVisible();
  await feed.evaluate(el => (el.scrollTop = 0));
  // mark a text under the reader's eyes and remember its offset in the feed
  const before = await feed.evaluate(el => {
    const { top, bottom } = el.getBoundingClientRect();
    // the last text visible at the bottom of the feed (the first item may grow: older events of the same turn join it)
    const first = [...el.querySelectorAll('*')]
      .filter(c => [...c.childNodes].some(n => n.nodeType === 3 && n.textContent?.trim()) && c.getBoundingClientRect().top >= top && c.getBoundingClientRect().bottom <= bottom)
      .at(-1)!;
    first.setAttribute('data-anchor', '1');
    return { offset: first.getBoundingClientRect().top - top, height: el.scrollHeight };
  });
  await more.click();
  await expect.poll(() => feed.evaluate(el => el.scrollHeight)).toBeGreaterThan(before.height);
  const after = await feed.evaluate(el => {
    const a = el.querySelector('[data-anchor]')!;
    return { offset: a.getBoundingClientRect().top - el.getBoundingClientRect().top, scrollTop: el.scrollTop };
  });
  expect(after.scrollTop).toBeGreaterThan(0);
  expect(Math.abs(after.offset - before.offset)).toBeLessThanOrEqual(2);
  expect(hub.requests.filter(r => r.path.endsWith('/events')).length).toBeGreaterThanOrEqual(2);
});
