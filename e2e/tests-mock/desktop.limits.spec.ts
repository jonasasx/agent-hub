// change subscription-limits (tasks 6.2–6.5) in the layout of tool-windows: the limits live in the «Подписки» window
// (rings and rows) and in the card under the chip of the tab head, against the in-memory hub on 1440×900.
// Requirements: Карточка лимитов и расшифровки; Ручное обновление; Метка лимита в шапке вкладки; Состояния «нет данных».
import { expect, test, type Page } from '@playwright/test';
import { MockHub } from '../mock/hub.js';
import { mockWindow } from '../mock/limits.js';
import { LONG_NAMES, LONG_WINDOW, limitRowsFit, longLimitsHub } from './limits-checks.js';

const shots = process.env.SHOTS_DIR;

async function start(page: Page, hub = new MockHub({ tabs: [1], subscriptions: true, limits: true }), theme: 'dark' | 'light' = 'dark') {
  await page.addInitScript(t => localStorage.setItem('ah-theme', t), theme);
  await hub.install(page);
  await page.goto('/');
  await expect(page.getByRole('complementary', { name: 'Сессии и проекты' })).toBeVisible();
  return hub;
}

/** A hub whose session subscription was never polled: the card offers the first probe. */
function unpolledHub() {
  const hub = new MockHub({ tabs: [1], subscriptions: true, limits: true });
  const max = hub.subReg!.list[0]!;
  hub.limReg!.set(max.id, { state: 'unavailable', reason: 'not_polled', windows: [], lastOkAt: null });
  return { hub, max };
}

const win = (page: Page) => page.locator('.tw-subs');
const sub = (page: Page, name: string) => win(page).locator('.tw-sub').filter({ hasText: name });
const head = (page: Page, name: string) => sub(page, name).locator('.tw-sh');
const chipOf = (page: Page) => page.locator('section.leaf.focused .chat-head .lchip');

async function inViewport(page: Page, el: ReturnType<Page['locator']>) {
  const b = (await el.boundingBox())!;
  const vp = page.viewportSize()!;
  expect(b.x).toBeGreaterThanOrEqual(0);
  expect(b.y).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width).toBeLessThanOrEqual(vp.width + 0.5);
  expect(b.y + b.height).toBeLessThanOrEqual(vp.height + 0.5);
}

test('окно «Подписки»: кольцо худшего окна у свёрнутой, раскрытие даёт строки окон, выбор переживает перезагрузку', async ({ page }) => {
  await start(page);
  const max = head(page, 'Max личная');
  await expect(max).toHaveAttribute('aria-expanded', 'false');
  await expect(max.getByRole('img', { name: /^5 ч — 82%, сброс / })).toBeVisible();
  await expect(max).toContainText('● сейчас');
  // a subscription that was never polled has no ring
  await expect(head(page, 'Pro рабочая').getByRole('img')).toHaveCount(0);
  await max.click();
  await expect(max).toHaveAttribute('aria-expanded', 'true');
  const lines = sub(page, 'Max личная').locator('.tw-lim');
  await expect(lines).toHaveCount(2);
  await expect(lines.nth(0)).toContainText('5 ч');
  await expect(lines.nth(0).locator('.tw-pc')).toHaveText('82%');
  await expect(lines.nth(1).locator('.tw-pc')).toHaveText('34%');
  await head(page, 'Pro рабочая').click();
  await expect(win(page).locator('.tw-nodata')).toHaveText('нет данных');
  if (shots) await page.screenshot({ path: `${shots}/limits-desktop-dark-window.png` });
  await page.reload();
  await expect(head(page, 'Max личная')).toHaveAttribute('aria-expanded', 'true');
  await expect(head(page, 'Pro рабочая')).toHaveAttribute('aria-expanded', 'true');
});

test('карточка под меткой: расшифровки, Esc возвращает фокус на метку, клик вне закрывает, refresh не вызывается', async ({ page }) => {
  const hub = await start(page);
  const chip = chipOf(page);
  await expect(chip).toHaveText('!82% · 5 ч');
  await chip.click();
  const card = page.getByRole('dialog', { name: /Max личная/ });
  await expect(card).toBeVisible();
  await expect(card).toBeFocused();
  await expect(card.getByText(/Скользящее окно: начинается с первого запроса после паузы/)).toBeVisible();
  await expect(card.getByText('7 дней', { exact: true })).toBeVisible();
  await expect(card.getByText(/Включён, но недоступен/)).toBeVisible();
  await inViewport(page, card);
  // under the chip, and not modal: the rails stay usable
  expect((await card.boundingBox())!.y).toBeGreaterThan((await chip.boundingBox())!.y);
  if (shots) await page.screenshot({ path: `${shots}/limits-desktop-dark-card.png` });
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await expect(chip).toBeFocused();

  await chip.click();
  await expect(page.getByRole('dialog', { name: /Max личная/ })).toBeVisible();
  await page.mouse.click(700, 860); // the composer area, far from the card
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(hub.limReg!.refreshes).toHaveLength(0);
});

test('событие сессии обновляет метку и окно «Подписки» без перезагрузки; исчерпанная подписка — «×100% · 7 дн»', async ({ page }) => {
  const hub = await start(page);
  const max = hub.subReg!.list[0]!;
  const chip = chipOf(page);
  await expect(chip).toHaveText('!82% · 5 ч');
  const loads = hub.requests.filter(r => r.path === '/api/subscriptions/limits').length;
  hub.limitsEvent(max.id, [mockWindow('five_hour', 96, 60, 'allowed_warning'), mockWindow('seven_day', 40, 5000)]);
  await expect(chip).toHaveText('!96% · 5 ч');
  await expect(head(page, 'Max личная').getByRole('img', { name: /^5 ч — 96%/ })).toBeVisible();
  expect(hub.requests.filter(r => r.path === '/api/subscriptions/limits').length).toBe(loads + 1);

  max.limitResetsAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
  max.limitKind = 'seven_day';
  hub.push({ type: 'subscriptions.changed' });
  await expect(chip).toHaveText('×100% · 7 дн');
});

test('«Обновить»: пробный ход → «ниже порога», обратный отсчёт', async ({ page }) => {
  const { hub, max } = unpolledHub();
  await start(page, hub);
  await chipOf(page).click();
  const card = page.getByRole('dialog', { name: /Max личная/ });
  await expect(card.getByText(/Нет данных: ещё не проверялась/)).toBeVisible();
  await card.getByRole('button', { name: 'Обновить' }).click();
  await expect(card.getByRole('button', { name: /^Обновить через \d+ с$/ })).toBeDisabled();
  await expect(card.getByText(/Пробный ход запрошен/)).toBeVisible();
  await expect(chipOf(page)).toContainText(/ниже порога/);
  await expect(card.getByText(/Ниже порога предупреждения/)).toBeVisible();
  expect(hub.limReg!.refreshes).toEqual([max.id]);
  if (shots) await page.screenshot({ path: `${shots}/limits-desktop-dark-refresh.png` });
});

test('429 при частом обновлении: окно хаба ещё закрыто, а браузер считает его открытым', async ({ page }) => {
  const { hub, max } = unpolledHub();
  await start(page, hub);
  await chipOf(page).click();
  const card = page.getByRole('dialog', { name: /Max личная/ });
  await expect(card.getByRole('button', { name: 'Обновить' })).toBeEnabled();
  hub.limReg!.set(max.id, { refreshableAt: new Date(Date.now() + 20_000).toISOString() });
  await card.getByRole('button', { name: 'Обновить' }).click();
  await expect(card.getByText(/Слишком часто: повторить можно через (19|20) с/)).toBeVisible();
  await expect(card.getByRole('button', { name: /^Обновить через \d+ с$/ })).toBeDisabled();
  expect(hub.limReg!.refreshes).toEqual([]);
});

test('4 подписки; токен отклонён — «нет данных»; окно без описания показывает ключ; светлая тема', async ({ page }) => {
  const hub = new MockHub({ tabs: [1], subscriptions: true, limits: true });
  const third = hub.subReg!.add('Max рабочая');
  const fourth = hub.subReg!.add('Pro старая', { tokenRejected: true });
  hub.limReg!.set(third.id, { state: 'ok', reason: null, windows: [mockWindow('five_hour', 96, 70, 'allowed_warning'), mockWindow('seven_day_future', 20, null)], lastOkAt: new Date().toISOString() });
  hub.limReg!.set(fourth.id, { state: 'unavailable', reason: 'token_rejected' });
  await start(page, hub, 'light');
  await expect(win(page).locator('.tw-sh')).toHaveCount(4);
  await expect(head(page, 'Max рабочая').getByRole('img', { name: /^5 ч — 96%/ })).toBeVisible();
  await expect(head(page, 'Pro старая').getByRole('img')).toHaveCount(0);
  await head(page, 'Max рабочая').click();
  await head(page, 'Pro старая').click();
  await expect(sub(page, 'Max рабочая').locator('.tw-lim').nth(1)).toContainText('seven_day_future');
  await expect(sub(page, 'Pro старая').locator('.tw-nodata')).toHaveText('нет данных');
  if (shots) await page.screenshot({ path: `${shots}/limits-desktop-light-window.png` });
});

test('фикс 2026-10-29: ход без события не прячет окно 97% — «почти», без плашки «ниже порога»', async ({ page }) => {
  const hub = new MockHub({ tabs: [1], subscriptions: true, limits: true });
  const max = hub.subReg!.list[0]!;
  const now = Date.now();
  hub.limReg!.set(max.id, {
    state: 'ok',
    reason: null,
    windows: [mockWindow('five_hour', 26, 150), mockWindow('seven_day', 97, 6000)],
    lastOkAt: new Date(now - 4 * 60_000).toISOString(),
    quietAt: new Date(now).toISOString(),
  });
  await start(page, hub);
  await expect(chipOf(page)).toHaveText('!97% · 7 дн');
  await expect(chipOf(page)).not.toContainText('ниже порога');
  await chipOf(page).click();
  const card = page.getByRole('dialog', { name: /Max личная/ });
  await expect(card.getByText(/Ход в \d\d:\d\d прошёл, лимит не исчерпан\./)).toBeVisible();
  await expect(card.getByText('почти исчерпано')).toBeVisible();
  await expect(card.getByText(/Ниже порога предупреждения/)).toHaveCount(0);
  if (shots) await page.screenshot({ path: `${shots}/limits-desktop-dark-held.png` });
});

test('хаб без API лимитов (404): метки нет, окно «Подписки» пусто', async ({ page }) => {
  await start(page, new MockHub({ tabs: [1], subscriptions: true }));
  await expect(page.locator('section.leaf.focused .chat-head select[aria-label="Подписка"]')).toBeVisible();
  await expect(page.locator('.lchip')).toHaveCount(0);
  await expect(page.getByText('Нет подписок с лимитами')).toBeVisible();
});

test('QA 8.1: 30-символьные имена — заголовки окна «Подписки» в одну линию; «обновите агента» и длинное окно', async ({ page }) => {
  for (const n of LONG_NAMES) expect(n).toHaveLength(30);
  await start(page, longLimitsHub());
  await limitRowsFit(page, 3);
  // the unknown window key shows in the expanded row
  await head(page, LONG_NAMES[2]).click();
  await expect(sub(page, LONG_NAMES[2]).locator('.tw-ln')).toContainText(LONG_WINDOW.slice(0, 12));
  await limitRowsFit(page, 3);
  if (shots) await page.screenshot({ path: `${shots}/limits-desktop-long.png` });
  // the session's subscription is the first one: its card still names the machines
  await chipOf(page).click();
  await expect(page.getByRole('dialog', { name: /Max личная/ })).toContainText('Нет данных: обновите агента на X1-Carbon-Gen13, HP-Elitebook, vault.');
});
