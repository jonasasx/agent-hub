// QA M4a: a cold load of /s/<id> (a link from a notification) sometimes stayed on «Загрузка сессии…» forever — the card
// of the new tab was fetched only at the end of the layout load or when the socket opened. Twenty cold loads in a row.
import { expect, test } from '@playwright/test';
import { MockHub } from '../mock/hub.js';

test('20 cold loads of /s/<id> in a row open the chat every time', async ({ browser }) => {
  test.setTimeout(240_000);
  for (let i = 0; i < 20; i++) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const hub = new MockHub({ tabs: [1] });
    await hub.install(page);
    await page.goto(`/s/${MockHub.id(25)}`);
    // not among the five freshest rows of its project: only the card request can bring its title
    await expect(page.getByRole('tab', { name: /Историческая сессия 6/ }), `load ${i + 1}`).toBeVisible();
    await expect(page.locator('section.leaf.focused .chat-title'), `load ${i + 1}`).toContainText('Историческая сессия 6');
    await expect(page.getByText('Загрузка сессии…')).toHaveCount(0);
    expect(
      hub.requests.some(r => r.method === 'GET' && r.path === `/api/sessions/${MockHub.id(25)}`),
      `load ${i + 1}: the card was requested`,
    ).toBe(true);
    await ctx.close();
  }
});
