// Tasks 3.8, 3.15, 3.18, 3.19 (web) against the in-memory hub, real browser decoding and canvas.
// Requirements (chat-images): Изображения от агента в чате; Полный размер изображения; Изображения в ответе
// ассистента; Прикрепление изображений к сообщению; Форматы и размеры изображений пользователя; Изображения
// пользователя в истории.
import { expect, test, type Page } from '@playwright/test';
import { MockHub } from '../mock/hub.js';

async function start(page: Page, opts: ConstructorParameters<typeof MockHub>[0] = {}) {
  const hub = new MockHub({ tabs: [9, 4], ...opts });
  await hub.install(page);
  await page.goto('/');
  await expect(page.getByRole('tab', { name: /Скриншоты сайта/ })).toBeVisible();
  return hub;
}
const chat = (page: Page) => page.locator('section.leaf.focused section.chat');

/** Creates image files in the page: a canvas of the size, encoded to the type. */
async function makeFiles(page: Page, specs: { w: number; h: number; type: string; name: string; noise?: boolean }[]) {
  return page.evaluateHandle(async list => {
    const dt = new DataTransfer();
    for (const s of list) {
      const c = document.createElement('canvas');
      c.width = s.w;
      c.height = s.h;
      const g = c.getContext('2d')!;
      if (s.noise) {
        // a photo-like picture that does not compress well
        const d = g.createImageData(s.w, s.h);
        for (let i = 0; i < d.data.length; i++) d.data[i] = (i * 2654435761) >>> 24;
        g.putImageData(d, 0, 0);
      } else {
        g.fillStyle = '#3c82dc';
        g.fillRect(0, 0, s.w, s.h);
        g.fillStyle = '#f0b446';
        g.fillRect(0, 0, s.w, Math.max(1, s.h >> 3));
      }
      const blob = await new Promise<Blob>(r => c.toBlob(b => r(b!), s.type, 0.95));
      dt.items.add(new File([blob], s.name, { type: s.type }));
    }
    return dt;
  }, specs);
}

test('Скриншот Playwright: the preview under the collapsed call with the caption; the lightbox steps through the message images', async ({ page }) => {
  await start(page);
  const tool = chat(page).locator('.tool-wrap', { hasText: 'browser_take_screenshot' });
  await expect(tool.locator('details')).not.toHaveAttribute('open');
  await expect(tool.getByRole('group', { name: 'Изображение' })).toContainText(/PNG · 1280×720 · \d+ КБ/);
  const shot = tool.locator('img');
  await expect(shot).toHaveJSProperty('complete', true);
  expect(await shot.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1280);

  const msg = chat(page).locator('.msg.user', { hasText: 'Сравни эти три варианта' });
  await expect(msg.locator('img')).toHaveCount(3);
  if (process.env.SHOTS_DIR) {
    await msg.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${process.env.SHOTS_DIR}/images-chat.png` });
  }
  await msg.getByRole('button', { name: 'Открыть изображение 1 из 3' }).click();
  // the lightbox steps through all images of the session: the screenshot of the tool comes first (change image-viewer)
  const box = page.getByRole('dialog', { name: 'Изображение 2 из 4' });
  await expect(box).toBeVisible();
  await expect(box.locator('.lb-caption')).toContainText('2 / 4');
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/images-lightbox.png` });
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('dialog', { name: 'Изображение 1 из 4' })).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('dialog', { name: 'Изображение 3 из 4' })).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('dialog', { name: 'Изображение 2 из 4' })).toBeVisible();
  // the feed with the lightbox open, once still: the click may have scrolled it a few pixels to reach the button
  // (Playwright brings the target into view), which is not the lightbox's doing
  const settled = async () => {
    const read = () =>
      chat(page)
        .locator('.messages')
        .evaluate(m => m.scrollTop);
    let seen = [await read()];
    for (let i = 0; i < 40 && !(seen.length >= 3 && seen.slice(-3).every(v => v === seen.at(-1))); i++) {
      await page.waitForTimeout(150);
      seen = [...seen, await read()];
    }
    return seen.at(-1)!;
  };
  // web fonts (display=swap) change the composer's height when they arrive, and the feed pinned to the bottom follows
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const scroll = await settled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // back to the same place of the feed: the focus returns to the preview button without scrolling to it
  expect(Math.abs((await settled()) - scroll)).toBeLessThanOrEqual(1);
});

test('Масштаб и перемещение: «+», the wheel at the cursor, a drag moves the zoomed picture and does not close it', async ({ page }) => {
  // a screenshot 1280×720 in a stage narrower than it: «Вписать» is below 100 %
  await page.setViewportSize({ width: 1000, height: 700 });
  await start(page);
  const tool = chat(page).locator('.tool-wrap', { hasText: 'browser_take_screenshot' });
  await tool.getByRole('button', { name: 'Открыть изображение' }).click();
  const box = page.getByRole('dialog', { name: 'Изображение 1 из 4' });
  const pct = box.locator('.lb-pct');
  const img = box.locator('.lb-stage img');
  await expect(img).toHaveJSProperty('complete', true);
  const fit = Number((await pct.innerText()).replace('%', ''));
  expect(fit).toBeLessThan(100);
  await box.getByRole('button', { name: 'Увеличить' }).click();
  // the shown percentage is rounded: one step is ×1,25 of the exact scale
  await expect.poll(async () => Math.abs(Number((await pct.innerText()).replace('%', '')) - fit * 1.25)).toBeLessThanOrEqual(1);
  await box.getByRole('button', { name: '100%' }).click();
  await expect(pct).toHaveText('100%');
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/images-lightbox-zoom.png` });
  // a drag down shows the top of the picture: the image moves with the mouse, the lightbox stays, no other image
  const before = (await img.boundingBox())!;
  const stage = (await box.locator('.lb-frame').boundingBox())!;
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
  await page.mouse.down();
  await page.mouse.move(stage.x + stage.width / 2 - 100, stage.y + stage.height / 2 + 40, { steps: 5 });
  await page.mouse.up();
  const after = (await img.boundingBox())!;
  expect(Math.round(after.x - before.x)).toBe(-100);
  expect(Math.round(after.y - before.y)).toBe(40);
  await expect(page.getByRole('dialog', { name: 'Изображение 1 из 4' })).toBeVisible();
  // the edge of the picture never comes inside the stage
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  expect(Math.round((await img.boundingBox())!.y)).toBe(Math.round(stage.y));
  // «Вписать», then the wheel up at the cursor enlarges
  await box.getByRole('button', { name: 'Вписать' }).click();
  await expect(pct).toHaveText(`${fit}%`);
  await page.mouse.move(stage.x + stage.width / 4, stage.y + stage.height / 4);
  await page.mouse.wheel(0, -300);
  await expect.poll(async () => Number((await pct.innerText()).replace('%', ''))).toBeGreaterThan(fit);
  await page.keyboard.press('0');
  await expect(pct).toHaveText(`${fit}%`);
  // a click on the picture: 100 % and back; a click beside it closes the lightbox
  await img.click();
  await expect(pct).toHaveText('100%');
  await img.click();
  await expect(pct).toHaveText(`${fit}%`);
  const shown = (await img.boundingBox())!;
  await page.mouse.click(stage.x + 4, shown.y + shown.height + 6);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('Изображения в ответе: an external image is a link and is not loaded; a local path is shown on request; a missing file says so', async ({ page }) => {
  const external: string[] = [];
  page.on('request', r => {
    if (r.url().includes('example.com')) external.push(r.url());
  });
  const hub = await start(page);
  await expect(chat(page).getByRole('link', { name: 'logo (https://example.com/logo.png)' })).toBeVisible();
  await page.waitForTimeout(500);
  expect(external).toEqual([]);
  const answer = chat(page).locator('.msg.assistant', { hasText: 'График' });
  await answer.getByRole('button', { name: 'Показать изображение' }).first().click();
  await expect(answer.getByText('PNG · 600×300')).toBeVisible();
  expect(hub.requests.find(r => r.path.endsWith('/images'))?.body).toEqual({ path: '/home/ubuntu/vault/.tmp/chart.png' });
  await answer.getByRole('button', { name: 'Показать изображение' }).click();
  await expect(answer.getByRole('alert')).toHaveText('Файл не найден на X1');
});

test('Вставка скриншота: Ctrl+V adds a thumbnail, Enter sends the image without text, the message shows it after the replica', async ({ page }) => {
  const hub = await start(page);
  const box = chat(page).getByRole('textbox', { name: 'Сообщение' });
  await box.focus();
  const dt = await makeFiles(page, [{ w: 900, h: 500, type: 'image/png', name: 'clip.png' }]);
  await box.evaluate((el, d) => el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: d as DataTransfer, bubbles: true, cancelable: true })), dt);
  const thumbs = chat(page).getByRole('list', { name: 'Прикреплённые изображения' });
  await expect(thumbs.locator('li')).toHaveCount(1);
  await expect(thumbs.locator('li.ready')).toHaveCount(1);
  await box.press('Enter');
  await expect(thumbs).toHaveCount(0);
  const sent = hub.requests.find(r => r.path.endsWith('/messages'))!.body as { text: string; attachments: { sha256: string }[] };
  expect(sent.text).toBe('');
  expect(sent.attachments).toHaveLength(1);
  // the user line from the replica replaces the optimistic one and shows the image from the hub
  const mine = chat(page).locator('.msg.user').last();
  await expect(mine.locator('img')).toHaveAttribute('src', `/api/blobs/${sent.attachments[0]!.sha256}`);
  await expect(mine).not.toHaveClass(/pending/);
  await expect(mine.getByText('PNG · 900×500')).toBeVisible();
});

test('Перетаскивание нескольких файлов: the panel is highlighted, three thumbnails; «Убрать» removes one; Фото 12 Мп is reduced', async ({ page }) => {
  const hub = await start(page);
  const panel = chat(page);
  const dt = await makeFiles(page, [
    { w: 400, h: 300, type: 'image/png', name: 'a.png' },
    { w: 4000, h: 3000, type: 'image/jpeg', name: 'photo.jpg', noise: true },
    { w: 300, h: 200, type: 'image/png', name: 'c.png' },
  ]);
  await panel.dispatchEvent('dragenter', { dataTransfer: dt });
  await panel.dispatchEvent('dragover', { dataTransfer: dt });
  await expect(panel).toHaveClass(/file-drop/);
  await expect(page.getByText('Отпустите, чтобы прикрепить изображения')).toBeVisible();
  await panel.dispatchEvent('drop', { dataTransfer: dt });
  await expect(panel).not.toHaveClass(/file-drop/);
  const thumbs = panel.getByRole('list', { name: 'Прикреплённые изображения' }).locator('li');
  await expect(thumbs).toHaveCount(3);
  await expect(panel.locator('li.ready')).toHaveCount(3, { timeout: 15_000 });
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/images-attach.png` });
  // the 12 MP photo went up as 2000×1500 within 3.75 MB
  const big = hub.requests.filter(r => r.path === '/api/uploads').map(r => r.body as { size: number; contentType: string });
  expect(big.some(u => u.contentType === 'image/jpeg' && u.size <= 3.75 * 1024 * 1024)).toBe(true);
  expect([...hub.blobs.values()].some(b => b.mime === 'image/jpeg' && b.bytes.readUInt16BE(0) === 0xffd8)).toBe(true);
  await panel.getByRole('button', { name: 'Убрать a.png' }).click();
  await expect(thumbs).toHaveCount(2);
  await panel.getByRole('textbox', { name: 'Сообщение' }).fill('два варианта');
  await panel.getByRole('button', { name: 'Отправить' }).click();
  const sent = hub.requests.filter(r => r.path.endsWith('/messages')).at(-1)!.body as { attachments: unknown[] };
  expect(sent.attachments).toHaveLength(2);
  const mine = panel.locator('.msg.user', { hasText: 'два варианта' });
  await expect(mine.locator('img')).toHaveCount(2);
  await expect(mine.getByText(/JPEG · 2000×1500/)).toBeVisible();
});

test('Не картинка: a PDF named .png is refused at its thumbnail, the other image is attached', async ({ page }) => {
  await start(page);
  const dt = await page.evaluateHandle(() => {
    const d = new DataTransfer();
    d.items.add(new File(['%PDF-1.7 not an image'], 'scan.png', { type: 'image/png' }));
    return d;
  });
  const extra = await makeFiles(page, [{ w: 200, h: 100, type: 'image/png', name: 'ok.png' }]);
  await chat(page).dispatchEvent('drop', { dataTransfer: dt });
  await chat(page).dispatchEvent('drop', { dataTransfer: extra });
  await expect(chat(page).getByText('Формат не поддерживается: PNG, JPEG, GIF, WebP')).toBeVisible();
  await expect(chat(page).locator('li.ready')).toHaveCount(1);
  // no broken picture; the refused tile has the size of the others, its name on it, the whole reason under the strip
  const refused = chat(page).locator('li.error');
  await expect(refused.locator('img')).toHaveCount(0);
  await expect(refused.locator('.attach-error-name')).toHaveText('scan.png');
  const sizes = await chat(page)
    .locator('.attach-list > li')
    .evaluateAll(els => els.map(el => `${el.getBoundingClientRect().width}×${el.getBoundingClientRect().height}`));
  expect(new Set(sizes).size).toBe(1);
  await expect(chat(page).locator('.attach-errors li')).toHaveText('scan.png — Формат не поддерживается: PNG, JPEG, GIF, WebP');
  await expect(refused).toHaveAccessibleDescription('scan.png — Формат не поддерживается: PNG, JPEG, GIF, WebP');
  await chat(page)
    .locator('.attach-strip')
    .screenshot({ path: test.info().outputPath('strip.png') });
});

test('Агент старой версии: «Обновите агент на X1», text and images stay in the composer', async ({ page }) => {
  await start(page, { outdated: ['x1'] });
  const box = chat(page).getByRole('textbox', { name: 'Сообщение' });
  const dt = await makeFiles(page, [{ w: 300, h: 300, type: 'image/png', name: 'err.png' }]);
  await box.evaluate((el, d) => el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: d as DataTransfer, bubbles: true, cancelable: true })), dt);
  await expect(chat(page).locator('li.ready')).toHaveCount(1);
  await box.fill('какой код на скриншоте?');
  await box.press('Enter');
  await expect(chat(page).getByRole('alert')).toHaveText('Обновите агент на X1: он не принимает изображения');
  await expect(box).toHaveValue('какой код на скриншоте?');
  await expect(chat(page).locator('li.ready')).toHaveCount(1);
});

test('Картинки не дошли до машины: text and thumbnails stay with «Повторить»; the repeat is delivered once', async ({ page }) => {
  const hub = await start(page, { failDeliveries: 1 });
  const box = chat(page).getByRole('textbox', { name: 'Сообщение' });
  const dt = await makeFiles(page, [{ w: 300, h: 300, type: 'image/png', name: 'err.png' }]);
  await box.evaluate((el, d) => el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: d as DataTransfer, bubbles: true, cancelable: true })), dt);
  await expect(chat(page).locator('li.ready')).toHaveCount(1);
  await box.fill('какой код?');
  await box.press('Enter');
  await expect(chat(page).getByRole('alert')).toContainText('Изображения не дошли до X1 — сообщение не отправлено');
  await expect(box).toHaveValue('какой код?');
  await expect(chat(page).locator('li.ready')).toHaveCount(1);
  await chat(page).getByRole('button', { name: 'Повторить' }).click();
  await expect(box).toHaveValue('');
  await expect(chat(page).locator('li.ready')).toHaveCount(0);
  const posts = hub.requests.filter(r => r.path.endsWith('/messages'));
  expect(posts).toHaveLength(2);
  expect((posts[1]!.body as { clientUuid: string }).clientUuid).toBe((posts[0]!.body as { clientUuid: string }).clientUuid);
  await expect(chat(page).locator('.msg.user').last().locator('img')).toHaveCount(1);
});
