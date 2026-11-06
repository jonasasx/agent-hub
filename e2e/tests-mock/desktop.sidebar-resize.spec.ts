// change sidebar-resize: the left panel is resized by dragging its right edge with the mouse; the width survives a reload.
import { expect, test } from '@playwright/test';
import { MockHub } from '../mock/hub.js';

test('dragging the right edge of the panel changes its width, a reload keeps it, double click resets', async ({ page }) => {
  const hub = new MockHub({ tabs: [1] });
  await hub.install(page);
  await page.goto('/');
  const side = page.locator('.tw-col[data-side="left"]');
  const handle = side.getByRole('separator', { name: 'Ширина панели' });
  await expect(handle).toBeVisible();
  expect((await side.boundingBox())!.width).toBeCloseTo(320, 0);

  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y, { steps: 5 });
  await page.mouse.move(x + 130, y, { steps: 5 });
  await page.mouse.up();
  expect((await side.boundingBox())!.width).toBeCloseTo(450, 0);
  // the work area follows the panel
  const pane = (await page.locator('section.leaf').first().boundingBox())!;
  expect(pane.x).toBeGreaterThanOrEqual(450 + 44); // the rail and the column

  await page.reload();
  await expect(handle).toBeVisible();
  expect((await side.boundingBox())!.width).toBeCloseTo(450, 0);

  // not wider than the limit
  const b2 = (await handle.boundingBox())!;
  await page.mouse.move(b2.x + b2.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(b2.x + 600, y, { steps: 5 });
  await page.mouse.up();
  expect((await side.boundingBox())!.width).toBeCloseTo(560, 0);

  await handle.dblclick();
  expect((await side.boundingBox())!.width).toBeCloseTo(320, 0);
});
