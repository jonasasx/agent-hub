// Change `subagents` against the in-memory hub on 1440×900 (Ivan: «хочу видеть список сабагентов и открывать чат с
// ними»). Requirements (subagents): Список субагентов и счётчик; Переход от вызова к чату субагента; Чат субагента
// только для чтения; Живое обновление чата субагента.
import { expect, test, type Page } from '@playwright/test';
import { MockHub } from '../mock/hub.js';
import { SUB_IDS } from '../mock/subagents.js';

async function start(page: Page) {
  const hub = new MockHub({ tabs: [1], subagents: true });
  await hub.install(page);
  await page.goto('/');
  await expect(page.locator('section.leaf .chat-title')).toBeVisible();
  return hub;
}
const chat = (page: Page) => page.locator('section.leaf.focused');

test('счётчик и список: «Субагенты 4 · 1 работает» (the idle teammate is not counted), the tree with the nested fix under the developer, types and statuses', async ({ page }) => {
  await start(page);
  const btn = chat(page).getByRole('button', { name: /Субагенты 4/ });
  await expect(btn).toHaveText('Субагенты 4 · 1 работает');
  await btn.click();
  const list = page.getByRole('dialog', { name: 'Субагенты сессии' });
  const rows = list.locator('.sub-row');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText('Phase 4 code review M1');
  await expect(rows.nth(0)).toContainText('engineering-code-reviewer · завершён');
  await expect(rows.nth(1)).toContainText('Phase 3 Dev M1');
  await expect(rows.nth(1)).toContainText('работает');
  await expect(rows.nth(2)).toContainText('Fix layout ping-pong loop');
  const indent = async (i: number) => await rows.nth(i).evaluate(e => parseFloat(getComputedStyle(e).paddingLeft));
  expect(await indent(2)).toBeGreaterThan(await indent(1));
  await expect(rows.nth(3)).toContainText('тиммейт sa-m4 · ждёт сообщений');
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/subagents-list.png` });
});

test('чат субагента: a tab, «Субагент сессии <родитель> — только чтение», no composer; nested link; parent link', async ({ page }) => {
  const hub = await start(page);
  const parent = hub.session(1);
  await chat(page)
    .getByRole('button', { name: /Субагенты 4/ })
    .click();
  await page.getByRole('dialog', { name: 'Субагенты сессии' }).locator('.sub-row', { hasText: 'Phase 3 Dev M1' }).click();
  await expect(page.getByRole('tab', { name: /Субагент · Phase 3 Dev M1/ })).toHaveAttribute('aria-selected', 'true');
  const sub = chat(page);
  await expect(sub.locator('.sub-banner')).toContainText(`Субагент сессии ${parent.title} — только чтение`);
  await expect(sub.getByText('Каркас собран, хаб поднят.')).toBeVisible();
  await expect(sub.getByRole('textbox', { name: 'Сообщение' })).toHaveCount(0);
  await expect(sub.getByRole('button', { name: '⑂ Форк' })).toHaveCount(0);
  await expect(sub.locator('.pill')).toContainText('работает');
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/subagents-chat.png` });
  // the nested call inside the developer's feed opens the fix; its banner names the caller
  await sub.locator('.tool-wrap', { hasText: 'Agent' }).getByRole('link', { name: 'Открыть чат субагента' }).click();
  await expect(page.getByRole('tab', { name: /Субагент · Fix layout/ })).toHaveAttribute('aria-selected', 'true');
  await expect(chat(page).locator('.sub-banner')).toContainText('вызван Phase 3 Dev M1: scaffold, hub, agent');
  await chat(page).locator('.sub-banner').getByRole('link', { name: parent.title }).click();
  await expect(page.getByRole('tab', { name: new RegExp(parent.title) })).toHaveAttribute('aria-selected', 'true');
});

test('лента сессии: links at Agent/Task and SendMessage, «Сообщение от sa-m4», a queued peer message, the notification note', async ({ page }) => {
  await start(page);
  const feed = chat(page).locator('.messages');
  await expect(feed.locator('.tool-wrap', { hasText: 'Phase 4 code review M1' }).getByRole('link', { name: 'Открыть чат субагента' })).toBeVisible();
  await expect(feed.locator('.tool-wrap', { hasText: 'Phase 4 code review M1' })).toContainText('завершён');
  await expect(feed.locator('.tool-wrap', { hasText: 'SendMessage' }).getByRole('link', { name: 'Чат sa-m4' })).toBeVisible();
  const peer = feed.locator('.msg.peer', { hasText: 'Спека готова' });
  await expect(peer).toContainText('Сообщение от sa-m4');
  await expect(feed.locator('.msg.user', { hasText: 'Спека готова' })).toHaveCount(0);
  await expect(feed.locator('.msg.peer', { hasText: 'Проверь ещё раз тесты' })).toContainText('Сообщение от aef6947385afad951');
  await expect(feed.getByText('Уведомление: Agent "Phase 4 code review M1" completed')).toBeVisible();
  await peer.getByRole('link', { name: 'Чат sa-m4' }).click();
  await expect(page.getByRole('tab', { name: /Субагент · SA: per-window workspace spec/ })).toHaveAttribute('aria-selected', 'true');
});

test('живое обновление: new lines appear, running → completed in the header, the list and the parent counter; a new subagent appears in the open list', async ({ page }) => {
  const hub = await start(page);
  await chat(page)
    .getByRole('button', { name: /Субагенты 4/ })
    .click();
  await page.getByRole('dialog', { name: 'Субагенты сессии' }).locator('.sub-row', { hasText: 'Phase 3 Dev M1' }).click();
  await expect(chat(page).getByText('Каркас собран, хаб поднят.')).toBeVisible();
  hub.subagentLines(SUB_IDS.dev, [
    {
      kind: 'line',
      id: 'l:d:9',
      ts: new Date().toISOString(),
      line: { type: 'assistant', uuid: 'l:d:9', message: { id: 'm-d9', role: 'assistant', content: [{ type: 'text', text: 'Тесты зелёные.' }] } },
    },
  ]);
  await expect(chat(page).getByText('Тесты зелёные.')).toBeVisible();
  const dev = hub.subRows.get(SUB_IDS.dev)!;
  hub.upsertSubagent({ ...dev, status: 'completed', endedAt: new Date().toISOString(), durationMs: 31 * 60_000 });
  await expect(chat(page).locator('.pill')).toContainText('завершён');
  await page.getByRole('tab', { name: new RegExp(hub.session(1).title) }).click();
  // only the idle teammate is left: nobody «работает»
  await expect(chat(page).getByRole('button', { name: /Субагенты 4/ })).toHaveText('Субагенты 4');
  await chat(page)
    .getByRole('button', { name: /Субагенты 4/ })
    .click();
  const list = page.getByRole('dialog', { name: 'Субагенты сессии' });
  hub.upsertSubagent({
    ...dev,
    id: '00000000-0000-4000-a000-000000000009',
    agentId: 'anew000000000000',
    toolUseId: 'tu-new',
    description: 'Новый фоновый',
    status: 'running',
    startedAt: new Date().toISOString(),
    endedAt: null,
    durationMs: null,
  });
  await expect(list.locator('.sub-row', { hasText: 'Новый фоновый' })).toContainText('работает');
  await expect(chat(page).getByRole('button', { name: /Субагенты 5/ })).toHaveText('Субагенты 5 · 1 работает');
});

test('перезагрузка окна: the subagent tab comes back in its place; a subagent gone from the hub loses its tab', async ({ page }) => {
  const hub = await start(page);
  await chat(page)
    .getByRole('button', { name: /Субагенты 4/ })
    .click();
  await page.getByRole('dialog', { name: 'Субагенты сессии' }).locator('.sub-row', { hasText: 'Phase 4 code review' }).click();
  await expect(chat(page).getByText('Замечаний два: имена и тесты.')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('tab', { name: /Субагент · Phase 4 code review M1/ })).toBeVisible();
  await expect(chat(page).getByText('Замечаний два: имена и тесты.')).toBeVisible();
  hub.subRows.delete(SUB_IDS.review);
  await page.reload();
  await expect(page.getByRole('tab', { name: new RegExp(hub.session(1).title) })).toBeVisible();
  await expect(page.getByRole('tab', { name: /Субагент ·/ })).toHaveCount(0);
});

test('подписи: no label over the user message in a session (Ivan: «Вы» is noise), «Лид» in a subagent chat; the bubble stays right', async ({ page }) => {
  await start(page);
  const userMsg = chat(page).locator('.msg.user').first();
  await expect(userMsg).toBeVisible();
  await expect(userMsg.locator('.who')).toHaveCount(0);
  await userMsg.scrollIntoViewIfNeeded();
  const bubble = (await userMsg.locator('.bubble').boundingBox())!;
  const box = (await userMsg.boundingBox())!;
  expect(Math.abs(bubble.x + bubble.width - (box.x + box.width))).toBeLessThanOrEqual(1);
  await expect(chat(page).locator('.msg.assistant .who').first()).toHaveText('Claude');
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/no-you-label-desktop.png` });
  await chat(page)
    .getByRole('button', { name: /Субагенты 4/ })
    .click();
  await page.getByRole('dialog', { name: 'Субагенты сессии' }).locator('.sub-row', { hasText: 'Phase 3 Dev M1' }).click();
  await expect(chat(page).locator('.msg.user .who').first()).toHaveText('Лид');
});
