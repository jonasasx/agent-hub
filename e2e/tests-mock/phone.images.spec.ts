// Tasks 3.15 and 3.18 on 390×844 against the in-memory hub. Requirements (chat-images): Полный размер изображения
// («назад» on the phone closes the lightbox); Прикрепление изображений к сообщению (gallery and camera).
import { expect, test } from '@playwright/test';
import { MockHub } from '../mock/hub.js';

test('«назад» closes the lightbox and does not leave the page; «Прикрепить» offers gallery and camera', async ({ page }) => {
  const hub = new MockHub({ tabs: [9] });
  await hub.install(page);
  await page.goto('/');
  await page.getByRole('button', { name: /^ещё \d+/ }).click();
  await page.locator('.side-scroll .srow', { hasText: 'Скриншоты сайта' }).first().click();
  const msg = page.locator('.msg.user', { hasText: 'Сравни эти три варианта' });
  await msg.getByRole('button', { name: 'Открыть изображение 2 из 3' }).click();
  const lb = page.getByRole('dialog', { name: 'Изображение 2 из 3' });
  await expect(lb).toBeVisible();
  // UI review M3b: buttons and arrows ≥ 40 px; the caption on its own translucent panel, wrapped, not clipped
  for (const b of await lb.getByRole('button').all()) {
    const r = (await b.boundingBox())!;
    expect(Math.min(r.width, r.height), await b.innerText()).toBeGreaterThanOrEqual(40);
  }
  const cap = await lb.locator('.lb-caption').evaluate(el => ({ fits: el.scrollWidth <= el.clientWidth, bg: getComputedStyle(el.parentElement!).backgroundColor }));
  expect(cap.fits).toBe(true);
  expect(cap.bg).not.toBe('rgba(0, 0, 0, 0)');
  const url = page.url();
  await page.goBack();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(page.url()).toBe(url);
  await expect(page.locator('.mbar')).toContainText('Скриншоты сайта');
  // the preview fits the feed on the phone, no horizontal scroll
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  // image/* without capture: Android and iOS offer the gallery and the camera
  const input = page.locator('input[type="file"]');
  await expect(input).toHaveAttribute('accept', 'image/*');
  expect(await input.getAttribute('capture')).toBeNull();
  const attach = (await page.getByRole('button', { name: 'Прикрепить изображение' }).boundingBox())!;
  expect(Math.min(attach.width, attach.height)).toBeGreaterThanOrEqual(40);
  await input.setInputFiles({ name: 'camera.png', mimeType: 'image/png', buffer: (await import('../mock/images.js')).makePng(1200, 1600) });
  await expect(page.locator('li.ready')).toHaveCount(1);
  await page.getByRole('button', { name: 'Отправить' }).click();
  await expect(page.locator('.msg.user').last().locator('img')).toHaveCount(1);
});

test('«Убрать» on the phone: a 40×40 button on top of a white picture; a refused tile has no picture', async ({ page }) => {
  const hub = new MockHub({ tabs: [9] });
  await hub.install(page);
  await page.goto('/');
  await page.getByRole('button', { name: /^ещё \d+/ }).click();
  await page.locator('.side-scroll .srow', { hasText: 'Скриншоты сайта' }).first().click();
  const { makePng } = await import('../mock/images.js');
  const input = page.locator('input[type="file"]');
  await input.setInputFiles([
    { name: 'white.png', mimeType: 'image/png', buffer: makePng(400, 400, [255, 255, 255]) },
    { name: 'scan.png', mimeType: 'image/png', buffer: Buffer.from('%PDF-1.7 not an image') },
  ]);
  await expect(page.locator('li.ready')).toHaveCount(1);
  await expect(page.locator('li.error')).toHaveCount(1);
  for (const name of ['white.png', 'scan.png']) {
    const btn = page.getByRole('button', { name: `Убрать ${name}` });
    const hit = await btn.evaluate(el => {
      const r = el.getBoundingClientRect();
      const tile = el.closest('li')!.getBoundingClientRect();
      // the part not clipped by the tile's overflow: hidden
      const w = Math.min(r.right, tile.right) - Math.max(r.left, tile.left);
      const h = Math.min(r.bottom, tile.bottom) - Math.max(r.top, tile.top);
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { w, h, self: top === el, bg: getComputedStyle(el).backgroundImage };
    });
    expect(hit.self).toBe(true);
    expect(hit.w).toBeGreaterThanOrEqual(40);
    expect(hit.h).toBeGreaterThanOrEqual(40);
    expect(hit.bg).toContain('radial-gradient'); // the dark disc is the button's own background, not under the img
  }
  const refused = page.locator('li.error');
  await expect(refused.locator('img')).toHaveCount(0);
  await expect(refused.locator('.attach-error-name')).toHaveText('scan.png');
  await expect(page.locator('.attach-errors .attach-error-why')).toHaveText('Формат не поддерживается: PNG, JPEG, GIF, WebP');
  // all tiles are one size (UI review M3b)
  const sizes = await page.locator('.attach-list > li').evaluateAll(els => els.map(el => `${el.getBoundingClientRect().width}×${el.getBoundingClientRect().height}`));
  expect(new Set(sizes).size).toBe(1);
  // the name on the refused tile is not covered by the 40×40 «Убрать»
  const clear = await refused.locator('.attach-error-name').evaluate(el => {
    const r = el.getBoundingClientRect();
    const b = el.closest('li')!.querySelector('button')!.getBoundingClientRect();
    return r.top >= b.bottom || r.right <= b.left;
  });
  expect(clear).toBe(true);
  await refused.screenshot({ path: test.info().outputPath('refused.png') });
  await page.locator('li.ready').screenshot({ path: test.info().outputPath('white.png') });
  await page.getByRole('button', { name: 'Убрать scan.png' }).click();
  await expect(page.locator('li.error')).toHaveCount(0);
});
