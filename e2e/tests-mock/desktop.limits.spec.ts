// change subscription-limits, tasks 6.2–6.5, against the in-memory hub on 1440×900.
// Requirements: Блок «Лимиты» в левой панели; Строка подписки; Карточка лимитов и расшифровки; Ручное обновление;
// Метка лимита в шапке вкладки; Состояния «нет данных»; Внешний вид в обеих темах.
import { expect, test, type Page } from '@playwright/test';
import { MockHub } from '../mock/hub.js';
import { mockWindow } from '../mock/limits.js';
import { LONG_NAMES, LONG_WINDOW, limitRowsFit, longLimitsHub } from './limits-checks.js';

const shots = process.env.SHOTS_DIR;

async function start(page: Page, hub = new MockHub({ tabs: [1], subscriptions: true, limits: true }), theme: 'dark' | 'light' = 'dark') {
  await page.addInitScript(t => localStorage.setItem('ah-theme', t), theme);
  await hub.install(page);
  await page.goto('/');
  await expect(page.getByRole('list', { name: 'Машины' })).toBeVisible();
  return hub;
}

const block = (page: Page) => page.getByRole('region', { name: 'Лимиты подписок' });
const row = (page: Page, name: string) => block(page).getByRole('button', { name: new RegExp(`^${name}: `) });

async function inViewport(page: Page, el: ReturnType<Page['locator']>) {
  const b = (await el.boundingBox())!;
  const vp = page.viewportSize()!;
  expect(b.x).toBeGreaterThanOrEqual(0);
  expect(b.y).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width).toBeLessThanOrEqual(vp.width + 0.5);
  expect(b.y + b.height).toBeLessThanOrEqual(vp.height + 0.5);
}

test('блок над машинами: строки, полоса, карточка с расшифровками, Esc и клик вне закрывают, refresh не вызывается', async ({ page }) => {
  const hub = await start(page);
  const b = block(page);
  await expect(b).toBeVisible();
  // above the machines footer, outside the scrolling list
  expect(await b.evaluate(el => el.nextElementSibling?.classList.contains('side-bottom') && !el.closest('.side-scroll'))).toBe(true);
  const max = row(page, 'Max личная');
  await expect(max).toContainText('близко · 5 ч · 82%');
  // the percent is in the row's name; the bar inside the button is decorative (review A7)
  await expect(max.getByRole('progressbar')).toHaveCount(0);
  await expect(max.locator('.lbar')).toHaveAttribute('data-value', '82');
  await expect(row(page, 'Pro рабочая')).toContainText('нет данных: ещё не проверялась');
  // the row is one line high
  expect((await max.boundingBox())!.height).toBeLessThan(40);

  await max.click();
  const card = page.getByRole('dialog', { name: /Max личная/ });
  await expect(card).toBeVisible();
  await expect(card).toBeFocused();
  await expect(card.getByText(/Скользящее окно: начинается с первого запроса после паузы/)).toBeVisible();
  await expect(card.getByText('7 дней', { exact: true })).toBeVisible();
  await expect(card.getByText(/Включён, но недоступен/)).toBeVisible();
  await inViewport(page, card);
  // a popover to the right of the panel, the panel stays usable (not modal)
  const side = (await page.locator('aside.side').boundingBox())!;
  expect((await card.boundingBox())!.x).toBeGreaterThanOrEqual(side.x + side.width);
  if (shots) await page.screenshot({ path: `${shots}/limits-desktop-dark-card.png` });
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await expect(max).toBeFocused();

  await max.click();
  await expect(page.getByRole('dialog', { name: /Max личная/ })).toBeVisible();
  await page.mouse.click(1400, 120); // the head of the chat, far from the card
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(hub.limReg!.refreshes).toHaveLength(0);
});

test('метка в шапке «82% · 5 ч», карточка под меткой; событие сессии обновляет строку и метку без перезагрузки', async ({ page }) => {
  const hub = await start(page);
  const max = hub.subReg!.list[0]!;
  const chip = page.locator('section.leaf.focused .chat-head .lchip');
  await expect(chip).toHaveText('!82% · 5 ч');
  await chip.click();
  const card = page.getByRole('dialog', { name: /Max личная/ });
  await expect(card).toBeVisible();
  await inViewport(page, card);
  expect((await card.boundingBox())!.y).toBeGreaterThan((await chip.boundingBox())!.y);
  await page.keyboard.press('Escape');
  await expect(chip).toBeFocused();
  if (shots) await page.screenshot({ path: `${shots}/limits-desktop-dark.png` });

  const loads = hub.requests.filter(r => r.path === '/api/subscriptions/limits').length;
  hub.limitsEvent(max.id, [mockWindow('five_hour', 96, 60, 'allowed_warning'), mockWindow('seven_day', 40, 5000)]);
  await expect(row(page, 'Max личная')).toContainText('почти · 5 ч · 96%');
  await expect(chip).toHaveText('!96% · 5 ч');
  expect(hub.requests.filter(r => r.path === '/api/subscriptions/limits').length).toBe(loads + 1);

  // the exhausted subscription: «исчерпана до» in the row, «100% · 7 дн» in the chip
  max.limitResetsAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
  max.limitKind = 'seven_day';
  hub.push({ type: 'subscriptions.changed' });
  await expect(chip).toHaveText('×100% · 7 дн');
  await expect(row(page, 'Max личная')).toContainText('исчерпана до');
});

test('«Обновить»: пробный ход → «ниже порога · проверено», обратный отсчёт; 429 при частом обновлении', async ({ page }) => {
  const hub = await start(page);
  const pro = hub.subReg!.list[1]!;
  await row(page, 'Pro рабочая').click();
  const card = page.getByRole('dialog', { name: /Pro рабочая/ });
  await expect(card.getByText(/Нет данных: ещё не проверялась/)).toBeVisible();
  await card.getByRole('button', { name: 'Обновить' }).click();
  await expect(card.getByRole('button', { name: /^Обновить через \d+ с$/ })).toBeDisabled();
  await expect(card.getByText(/Пробный ход запрошен/)).toBeVisible();
  await expect(row(page, 'Pro рабочая')).toContainText(/ниже порога · проверено \d\d:\d\d/);
  await expect(card.getByText(/Ниже порога предупреждения/)).toBeVisible();
  expect(hub.limReg!.refreshes).toEqual([pro.id]);
  if (shots) await page.screenshot({ path: `${shots}/limits-desktop-dark-refresh.png` });
  await page.keyboard.press('Escape');

  // the hub's window is still closed while the browser thinks it is open (another window refreshed): 429
  const max = hub.subReg!.list[0]!;
  hub.limReg!.set(max.id, { refreshableAt: new Date(Date.now() + 20_000).toISOString() });
  await row(page, 'Max личная').click();
  const card2 = page.getByRole('dialog', { name: /Max личная/ });
  await card2.getByRole('button', { name: 'Обновить' }).click();
  await expect(card2.getByText(/Слишком часто: повторить можно через (19|20) с/)).toBeVisible();
  await expect(card2.getByRole('button', { name: /^Обновить через \d+ с$/ })).toBeDisabled();
  expect(hub.limReg!.refreshes).toEqual([pro.id]);
});

test('сводка на десктопе с 4 подписок; токен отклонён — «нет данных»; светлая тема', async ({ page }) => {
  const hub = new MockHub({ tabs: [1], subscriptions: true, limits: true });
  const third = hub.subReg!.add('Max рабочая');
  const fourth = hub.subReg!.add('Pro старая', { tokenRejected: true });
  hub.limReg!.set(third.id, { state: 'ok', reason: null, windows: [mockWindow('five_hour', 96, 70, 'allowed_warning'), mockWindow('seven_day_future', 20, null)], lastOkAt: new Date().toISOString() });
  hub.limReg!.set(fourth.id, { state: 'unavailable', reason: 'token_rejected' });
  await start(page, hub, 'light');
  const sum = block(page).getByRole('button', { name: /^Лимиты, худшая подписка Max рабочая/ });
  await expect(sum).toContainText('худшая: Max рабочая 96%');
  if (shots) await page.screenshot({ path: `${shots}/limits-desktop-light-summary.png` });
  await sum.click();
  await expect(block(page).getByRole('button', { name: /Подробнее$/ })).toHaveCount(4);
  await expect(row(page, 'Pro старая')).toContainText('нет данных: токен отклонён');
  await row(page, 'Max рабочая').click();
  const card = page.getByRole('dialog', { name: /Max рабочая/ });
  await expect(card.getByText('seven_day_future')).toBeVisible();
  await expect(card.getByText(/Окно без описания/)).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/limits-desktop-light-card.png` });
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
  await expect(row(page, 'Max личная')).toContainText(/почти · 7 дн · 97% · данные от \d\d:\d\d/);
  await expect(row(page, 'Max личная')).not.toContainText('ниже порога');
  await row(page, 'Max личная').click();
  const card = page.getByRole('dialog', { name: /Max личная/ });
  await expect(card.getByText(/Ход в \d\d:\d\d прошёл, лимит не исчерпан\./)).toBeVisible();
  await expect(card.getByText('почти исчерпано')).toBeVisible();
  await expect(card.getByText(/Ниже порога предупреждения/)).toHaveCount(0);
  if (shots) await page.screenshot({ path: `${shots}/limits-desktop-dark-held.png` });
});

test('хаб без API лимитов (404): блока и метки нет', async ({ page }) => {
  await start(page, new MockHub({ tabs: [1], subscriptions: true }));
  await expect(page.locator('section.leaf.focused .chat-head select[aria-label="Подписка"]')).toBeVisible();
  await expect(block(page)).toHaveCount(0);
  await expect(page.locator('.lchip')).toHaveCount(0);
});

test('QA 8.1: 30-символьные имена и «обновите агента» на трёх машинах — строки в одну линию, внутри панели', async ({ page }) => {
  for (const n of LONG_NAMES) expect(n).toHaveLength(30);
  await start(page, longLimitsHub());
  const r = row(page, LONG_NAMES[0]);
  await expect(r.locator('.ll')).toHaveText('нет данных: обновите агента');
  await expect(r).toHaveAccessibleName(/обновите агента на X1-Carbon-Gen13, HP-Elitebook, vault/);
  await expect(row(page, LONG_NAMES[1]).locator('.ll')).toContainText('почти · 7 дн · 96%');
  await expect(row(page, LONG_NAMES[2]).locator('.ll')).toContainText(`близко · ${LONG_WINDOW} · 88%`);
  await limitRowsFit(page, 3);
  if (shots) await page.screenshot({ path: `${shots}/limits-desktop-long.png` });
  // the card still names the machines
  await r.click();
  await expect(page.getByRole('dialog', { name: /Max личная/ })).toContainText('Нет данных: обновите агента на X1-Carbon-Gen13, HP-Elitebook, vault.');
});
