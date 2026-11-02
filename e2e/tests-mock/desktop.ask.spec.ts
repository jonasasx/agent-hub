// AskUserQuestion and ExitPlanMode cards (Ivan, M4b: the question showed as a permission card with raw JSON).
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { MockHub } from '../mock/hub.js';
import { QUESTIONS } from '../mock/ask.js';

async function start(page: Page) {
  const hub = new MockHub({ tabs: [1] });
  await hub.install(page);
  await page.goto('/');
  await expect(page.locator('section.leaf .chat-title')).toBeVisible();
  return hub;
}

test('вопрос: 3 questions — single with a recommended option, multi, own answer; «Ответить» once all answered; the card becomes «Вы ответили: …»', async ({ page }) => {
  const hub = await start(page);
  hub.ask(1, 'question', QUESTIONS);
  const card = page.getByRole('group', { name: 'Claude задаёт вопрос' });
  await expect(card).toBeVisible();
  await expect(card).not.toContainText('(Recommended)');
  await expect(card).not.toContainText('"questions"');
  await expect(card.getByText('рекомендуется')).toBeVisible();
  const send = card.getByRole('button', { name: 'Ответить' });
  await expect(send).toBeDisabled();
  await card.getByRole('radio', { name: /Postgres/ }).check();
  await card.getByRole('checkbox', { name: /Юнит-тесты/ }).check();
  await card.getByRole('checkbox', { name: /e2e/ }).check();
  await expect(send).toBeDisabled();
  await card
    .getByRole('group', { name: /Как назвать сервис/ })
    .getByRole('textbox', { name: 'Свой ответ' })
    .fill('ledger-core');
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/ask-desktop.png` });
  await send.click();
  await expect(card).toHaveCount(0);
  await expect(
    page
      .locator('.sysnote', { hasText: 'Вы ответили:' })
      .filter({ hasText: 'Какую базу взять? — Postgres' })
      .filter({ hasText: 'Что прогнать перед выкаткой? — Юнит-тесты, e2e' })
      .filter({ hasText: 'Как назвать сервис? — ledger-core' }),
  ).toBeVisible();
  expect(hub.decisions.at(-1)).toEqual({
    requestId: expect.any(String),
    decision: 'allow',
    answers: { 'Какую базу взять?': 'Postgres (Recommended)', 'Что прогнать перед выкаткой?': ['Юнит-тесты', 'e2e'], 'Как назвать сервис?': 'ledger-core' },
  });
});

test('«Не отвечать» denies; a decision from another window closes the card', async ({ page }) => {
  const hub = await start(page);
  hub.ask(1, 'question', QUESTIONS);
  const card = page.getByRole('group', { name: 'Claude задаёт вопрос' });
  await card.getByRole('button', { name: 'Не отвечать' }).click();
  await expect(card).toHaveCount(0);
  expect(hub.decisions.at(-1)).toEqual({ requestId: expect.any(String), decision: 'deny' });
  const rid = hub.ask(1, 'question', QUESTIONS);
  await expect(card).toBeVisible();
  hub.push({ type: 'permission.resolved', sessionId: hub.session(1).id, requestId: rid, decision: 'allow' });
  await expect(card).toHaveCount(0);
});

test('план: Markdown, «Утвердить план»; «Продолжить планирование» with a comment', async ({ page }) => {
  const hub = await start(page);
  hub.ask(1, 'plan', { plan: '## План\n1. Миграция\n2. **API**' });
  const card = page.getByRole('group', { name: 'План Claude' });
  await expect(card.getByRole('heading', { name: 'План' })).toBeVisible();
  await expect(card.locator('strong', { hasText: 'API' })).toBeVisible();
  await card.getByRole('button', { name: 'Продолжить планирование' }).click();
  await card.getByLabel('Что поправить в плане').fill('сначала тесты');
  await card.getByRole('button', { name: 'Отправить и продолжить планирование' }).click();
  await expect(page.getByText('План: продолжить планирование — сначала тесты')).toBeVisible();
  expect(hub.decisions.at(-1)).toMatchObject({ decision: 'deny', message: 'сначала тесты' });
  hub.ask(1, 'plan', { plan: '## План 2' });
  await page.getByRole('group', { name: 'План Claude' }).getByRole('button', { name: 'Утвердить план' }).click();
  await expect(page.getByText('План утверждён')).toBeVisible();
});

for (const theme of ['dark', 'light'] as const) {
  test(`контраст карточек вопроса и плана (${theme})`, async ({ page }) => {
    await page.addInitScript(t => localStorage.setItem('ah-theme', t), theme);
    const hub = await start(page);
    hub.ask(1, 'question', QUESTIONS);
    hub.ask(1, 'plan', { plan: '## План\n1. Миграция' });
    await expect(page.getByRole('group', { name: 'План Claude' })).toBeVisible();
    await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
    const r = await new AxeBuilder({ page }).include('.perm.ask').withRules(['color-contrast']).analyze();
    expect(r.violations.flatMap(v => v.nodes.map(n => n.target.join(' ')))).toEqual([]);
  });
}
