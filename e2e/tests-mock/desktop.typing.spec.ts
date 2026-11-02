// Bug from Ivan (M4b, 1299 px): typing knocked the feed off the bottom while the turn was running — the last message
// ended under the composer. Rules: at the bottom → stays at the bottom (the field grows, events arrive); scrolled up →
// the position does not move; typing does not lose the text or the caret.
import { expect, test, type Page } from '@playwright/test';
import { MockHub } from '../mock/hub.js';

test.use({ viewport: { width: 1299, height: 860 } });

const feed = (page: Page) => page.locator('section.leaf.focused .messages');
const gap = (page: Page) => feed(page).evaluate(m => m.scrollHeight - m.scrollTop - m.clientHeight);
const lastVisible = (page: Page) =>
  feed(page).evaluate(m => {
    const items = m.querySelectorAll('.msg, .tool-wrap, details.tool, .sysnote, .thinking');
    const last = items[items.length - 1]!.getBoundingClientRect();
    return last.bottom <= m.getBoundingClientRect().bottom + 1;
  });
const TEXT = Array.from({ length: 12 }, (_, i) => `строка ${i + 1}: ${'текст '.repeat(3)}`)
  .join('\n')
  .slice(0, 300);

async function start(page: Page) {
  const hub = new MockHub({ tabs: [1] });
  await hub.install(page);
  await page.goto('/');
  await expect(page.locator('section.leaf .chat-title')).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
  return hub;
}

async function typeSlowly(page: Page, text: string, during?: (i: number) => void) {
  const box = page.getByRole('textbox', { name: 'Сообщение' });
  await box.click();
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\n') await page.keyboard.press('Shift+Enter');
    else await page.keyboard.type(ch);
    during?.(i);
  }
}

test('у низа: 300 characters with line breaks — the field grows up to 5 lines, the feed stays at the bottom, the last message whole', async ({ page }) => {
  await start(page);
  const box = page.getByRole('textbox', { name: 'Сообщение' });
  const h0 = (await box.boundingBox())!.height;
  await typeSlowly(page, TEXT);
  const h1 = (await box.boundingBox())!.height;
  expect(h1).toBeGreaterThan(h0);
  expect(h1).toBeLessThanOrEqual(5 * 22 + 24);
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
  expect(await lastVisible(page)).toBe(true);
  await expect(box).toHaveValue(TEXT);
});

test('прокрутил вверх: typing does not move the feed (scrollTop and the first visible message stay)', async ({ page }) => {
  await start(page);
  const top = await feed(page).evaluate(m => {
    m.scrollTop = Math.round((m.scrollHeight - m.clientHeight) / 2);
    return m.scrollTop;
  });
  const first = () =>
    feed(page).evaluate(m => {
      const r = m.getBoundingClientRect();
      const el = [...m.querySelectorAll('.msg, details.tool, .sysnote')].find(e => e.getBoundingClientRect().bottom > r.top + 1);
      return el?.textContent?.slice(0, 40) ?? '';
    });
  const before = await first();
  await typeSlowly(page, TEXT);
  expect(await feed(page).evaluate(m => m.scrollTop)).toBe(top);
  expect(await first()).toBe(before);
});

test('ответ приходит во время набора: at the bottom the feed follows it, the text and the caret stay', async ({ page }) => {
  const hub = await start(page);
  const s = hub.session(1);
  hub.upsert({ ...s, status: 'working' });
  let n = 0;
  await typeSlowly(page, TEXT.slice(0, 160), i => {
    if (i % 8 === 0) hub.push({ type: 'session.partial', sessionId: s.id, messageId: 'm-live', blockIndex: 0, textDelta: `кусок ответа ${++n}. ${'слово '.repeat(12)}\n\n` });
    if (i === 80)
      hub.push({
        type: 'session.events',
        sessionId: s.id,
        events: [
          {
            kind: 'line',
            id: 'l:1:0:900',
            ts: new Date().toISOString(),
            line: { type: 'assistant', uuid: 'a-900', message: { id: 'm-tool', role: 'assistant', content: [{ type: 'tool_use', id: 'tu-900', name: 'Bash', input: { command: 'npm test' } }] } },
          },
        ],
      });
  });
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
  expect(await lastVisible(page)).toBe(true);
  const box = page.getByRole('textbox', { name: 'Сообщение' });
  await expect(box).toHaveValue(TEXT.slice(0, 160));
  expect(await box.evaluate(t => (t as HTMLTextAreaElement).selectionStart)).toBe(160);
  await page.keyboard.type('!');
  await expect(box).toHaveValue(`${TEXT.slice(0, 160)}!`);
});

test('отправка у низа: the «доставляется…» copy and then the message are whole above the composer', async ({ page }) => {
  const hub = await start(page);
  hub.lineDelayMs = 800;
  await typeSlowly(page, 'Прочитай Леонова');
  await page.keyboard.press('Enter');
  const copy = feed(page).locator('.msg.user.pending', { hasText: 'Прочитай Леонова' });
  await expect(copy).toBeVisible();
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
  expect(await lastVisible(page)).toBe(true);
  await expect(page.getByText('Принято: «Прочитай Леонова». Готово.')).toBeVisible();
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
  expect(await lastVisible(page)).toBe(true);
});
