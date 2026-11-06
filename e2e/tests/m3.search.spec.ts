// Task 3.9 on the live stand (QA M3c): Ctrl+K over the whole history — morphology ru+en, highlight without HTML,
// cron switch, Enter into the active pane, Esc, phone; latency of GET /api/search.
// Requirements: spec workspace-ui «Быстрый поиск Ctrl+K», «Дерево „Проекты“» (cron hidden by default); D10 /api/search.
//
// Read-only against the user's real history (opens tabs in its own window, creates and stops nothing):
//   E2E_BASE_URL=https://hub.internal.example.com E2E_COOKIE=<ah_session> [E2E_CRON_TITLE=<title of a cron session>] \
//   E2E_CHANNEL=msedge npx playwright test tests/m3.search.spec.ts
// The desktop and phone layout templates are read before the suite and put back after it.
import { expect, request as pwRequest, test, type APIRequestContext, type Page } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:8080';
const COOKIE = process.env.E2E_COOKIE ?? '';
const CRON_TITLE = process.env.E2E_CRON_TITLE ?? '';

test.skip(!COOKIE, 'needs E2E_COOKIE');

type SearchResponse = { results: Array<{ session: { id: string; title: string }; match: string; snippet: { text: string; highlights: [number, number][] } | null }> };
let api: APIRequestContext;
const templates: Record<string, { layout: unknown; savedLayout: unknown; openedAt: unknown }> = {};

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { cookie: `ah_session=${COOKIE}`, origin: BASE } });
  for (const d of ['desktop', 'phone']) templates[d] = await (await api.get(`/api/layout?device=${d}`)).json();
});
test.afterAll(async () => {
  for (const [device, t] of Object.entries(templates)) await api.put('/api/layout', { data: { device, layout: t.layout, savedLayout: t.savedLayout, openedAt: t.openedAt } });
});

async function start(page: Page) {
  await page.context().addCookies([{ name: 'ah_session', value: COOKIE, url: BASE, secure: BASE.startsWith('https'), httpOnly: true, sameSite: 'Lax' }]);
  await page.goto('/');
  await expect(page.getByRole('complementary', { name: 'Сессии и проекты' })).toBeVisible();
}
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Быстрый переход' });
async function search(page: Page, q: string) {
  if (!(await dialog(page).count())) {
    if (page.viewportSize()!.width <= 760) await page.getByRole('button', { name: /Найти сессию/ }).click();
    else await page.keyboard.press('Control+k');
  }
  await dialog(page).getByRole('combobox', { name: 'Сессия или проект' }).fill(q);
  await expect(dialog(page).getByText('Поиск…')).toHaveCount(0);
  return dialog(page).getByRole('option');
}

const forms = (r: SearchResponse) => new Set(r.results.flatMap(x => (x.snippet ? x.snippet.highlights.map(([a, b]) => x.snippet!.text.slice(a, b).toLowerCase()) : [])));

test('API: morphology ru+en — «перезапуск» and «deployment» highlight other word forms', async () => {
  const ru = (await (await api.get('/api/search', { params: { q: 'перезапуск', limit: 12, cron: 0 } })).json()) as SearchResponse;
  const en = (await (await api.get('/api/search', { params: { q: 'deployment', limit: 12, cron: 0 } })).json()) as SearchResponse;
  expect(ru.results.length).toBeGreaterThan(0);
  expect([...forms(ru)].some(f => f !== 'перезапуск' && f.startsWith('перезапуск'))).toBe(true);
  expect([...forms(en)].some(f => f !== 'deployment' && f.startsWith('deploy'))).toBe(true);
});

test('API: p95 of 20 different queries is under 500 ms', async () => {
  const qs = [
    '',
    'hostname',
    'барабан',
    'перезапуск',
    'перезапустить',
    'deployment',
    'deploy',
    'тайминги очереди',
    '4817',
    'vault',
    'agent-hub',
    'Запоминание',
    'scanner',
    'kubectl get pods',
    'Jellyfin',
    'ClickHouse',
    'миграция',
    'ошибка',
    '"сертификат" -ошибка',
    'README',
  ];
  const ms: number[] = [];
  for (const q of qs) {
    const t = performance.now();
    const r = await api.get('/api/search', { params: { q, limit: 12, cron: 0 } });
    expect(r.status()).toBe(200);
    await r.json();
    ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  const p95 = ms[Math.ceil(0.95 * ms.length) - 1]!;
  test.info().annotations.push({ type: 'p95', description: `${p95.toFixed(0)} ms` });
  expect(p95).toBeLessThan(500);
});

test('Ctrl+K: fragment highlighted with <mark> only, arrows + Enter open in the active pane, Esc closes', async ({ page, isMobile }) => {
  test.skip(isMobile, 'desktop');
  await start(page);
  const opts = await search(page, 'перезапуск');
  await expect(opts.first()).toBeVisible();
  expect(await opts.count()).toBeLessThanOrEqual(12);
  await expect(dialog(page).locator('mark').first()).toBeVisible();
  const tags = await dialog(page)
    .locator('[role="option"] *')
    .evaluateAll(els => [...new Set(els.map(e => e.tagName.toLowerCase()))]);
  expect(
    tags.every(t => ['span', 'mark', 'b', 'small', 'em', 'div'].includes(t)),
    tags.join(','),
  ).toBe(true);
  const second = (await opts.nth(1).innerText()).split('\n')[0]!;
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator('section.leaf.focused [role="tab"][aria-selected="true"]')).toContainText(second.slice(0, 12));
  await page.keyboard.press('Control+k');
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
});

test('Cron скрыт по умолчанию: a cron session is not found until «показать cron», then opens read-only', async ({ page, isMobile }) => {
  test.skip(isMobile || !CRON_TITLE, 'desktop, needs E2E_CRON_TITLE');
  await start(page);
  let opts = await search(page, CRON_TITLE);
  expect((await opts.allInnerTexts()).some(t => t.includes(CRON_TITLE))).toBe(false);
  await page.keyboard.press('Escape');
  await page.locator('aside').getByRole('button', { name: 'показать cron' }).click();
  try {
    opts = await search(page, CRON_TITLE);
    await expect(opts.filter({ hasText: CRON_TITLE }).first()).toBeVisible();
    await opts.filter({ hasText: CRON_TITLE }).first().click();
    const chat = page.locator('section.leaf.focused section.chat');
    await expect(chat.getByText('Cron-сессия, только чтение')).toBeVisible();
    await expect(chat.getByLabel('Сообщение')).toBeDisabled();
  } finally {
    await page.locator('aside').getByRole('button', { name: 'скрыть cron' }).click();
  }
});

test('Phone: «Найти сессию», Enter opens the chat over the list, no horizontal scroll', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'phone');
  await start(page);
  const opts = await search(page, 'барабан');
  await expect(opts.first()).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'К списку' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});
