// Task 4.10 on the live stand (QA M4a), read-only: the tree by projects («Без проекта» last, path in the tooltip),
// a session classified by git remote shows its evidence, Ctrl+K finds sessions by project name, phone «назад» returns
// to the list (chat, lightbox, /s/<id>). Requirements: spec project-grouping (Справочник проектов, Сигналы путей,
// Классификация по путям), workspace-ui (Быстрый поиск Ctrl+K, Телефонный режим).
//
//   E2E_BASE_URL=https://hub.internal.example.com E2E_COOKIE=<ah_session> [E2E_REMOTE_SESSION=<id of an Orca session>] \
//   [E2E_PICTURE_TITLE=<title of a session with an image>] E2E_CHANNEL=msedge npx playwright test tests/m4.projects.spec.ts
// The desktop and phone layout templates are read before the suite and put back after it.
import { expect, request as pwRequest, test, type APIRequestContext, type Page } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:8080';
const COOKIE = process.env.E2E_COOKIE ?? '';
const REMOTE_SESSION = process.env.E2E_REMOTE_SESSION ?? '';
const PICTURE_TITLE = process.env.E2E_PICTURE_TITLE ?? '';

test.skip(!COOKIE, 'needs E2E_COOKIE');

let api: APIRequestContext;
const templates: Record<string, { layout: unknown; savedLayout: unknown; openedAt: unknown }> = {};

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { cookie: `ah_session=${COOKIE}`, origin: BASE } });
  for (const d of ['desktop', 'phone']) templates[d] = await (await api.get(`/api/layout?device=${d}`)).json();
});
test.afterAll(async () => {
  for (const [device, t] of Object.entries(templates)) await api.put('/api/layout', { data: { device, layout: t.layout, savedLayout: t.savedLayout, openedAt: t.openedAt } });
});

async function start(page: Page, path = '/') {
  await page.context().addCookies([{ name: 'ah_session', value: COOKIE, url: BASE, secure: BASE.startsWith('https'), httpOnly: true, sameSite: 'Lax' }]);
  await page.goto(path);
  // the app is ready when the machines footer is rendered (hidden under the chat on the phone)
  await page.getByRole('list', { name: 'Машины' }).waitFor({ state: 'attached' });
}
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Быстрый переход' });
async function search(page: Page, q: string) {
  if (!(await dialog(page).count())) {
    if (page.viewportSize()!.width <= 760) await page.getByRole('button', { name: /Найти сессию/ }).click();
    else await page.keyboard.press('Control+k');
  }
  await dialog(page).getByRole('combobox', { name: 'Сессия или проект' }).fill(q);
  await expect(dialog(page).getByText('Поиск…')).toHaveCount(0);
  await expect(dialog(page).getByRole('option').first()).toBeVisible();
  return dialog(page).getByRole('option');
}
const listShown = (page: Page) => page.locator('aside');
const chatShown = (page: Page) => page.locator('section.chat').first();

test('Дерево «Проекты»: projects by the hub order, «Без проекта» last, path in the tooltip, area colour', async ({ page, isMobile }) => {
  test.skip(isMobile, 'desktop');
  await start(page);
  const rows = page.locator('aside .prow');
  await expect(rows.first()).toBeVisible();
  const names = await rows.locator('.pname').allInnerTexts();
  expect(names.length).toBeGreaterThan(2);
  expect(names.at(-1)).toBe('Без проекта');
  const sb = (await (await api.get('/api/sidebar?cron=0')).json()) as { projects: Array<{ project: { title: string; path: string } }> };
  expect(names).toEqual(sb.projects.map(p => p.project.title));
  await expect(rows.first()).toHaveAttribute('title', sb.projects[0]!.project.path || 'Проект не определён');
  const colours = await rows.locator('.pdot').evaluateAll(els => new Set(els.map(e => getComputedStyle(e).backgroundColor)).size);
  expect(colours).toBeGreaterThan(2);
});

test('Клон вне vault: an Orca session is in its project by git remote', async ({ page, isMobile }) => {
  test.skip(isMobile || !REMOTE_SESSION, 'desktop, needs E2E_REMOTE_SESSION');
  const s = (await (await api.get(`/api/sessions/${REMOTE_SESSION}`)).json()) as { title: string; project: { title: string }; projectEvidence: string };
  expect(s.projectEvidence).toMatch(/^git remote /);
  // opened through Ctrl+K: a cold /s/<id> may leave the tab at «Загрузка…» (QA M4a, the card is not fetched)
  await start(page);
  await (await search(page, s.title)).filter({ hasText: s.title }).filter({ hasText: s.project.title }).first().click();
  const chat = page.locator('section.leaf.focused section.chat');
  await expect(chat.getByRole('button', { name: new RegExp(`^Проект: ${s.project.title}`) })).toBeVisible({ timeout: 15_000 });
  await expect(chat.getByText(/определено по путям: git remote /).first()).toBeVisible();
});

test('Ctrl+K by project name: «scanner-fleet» finds sessions of 02-scanner-fleet', async ({ page, isMobile }) => {
  test.skip(isMobile, 'desktop');
  const r = (await (await api.get('/api/search', { params: { q: '02-scanner-fleet', limit: 12, cron: 0 } })).json()) as { results: Array<{ match: string; session: { project: { title: string } } }> };
  expect(r.results.some(x => x.match === 'project' && x.session.project.title === '02-scanner-fleet')).toBe(true);
  await start(page);
  const opts = await search(page, '02-scanner-fleet');
  await expect(opts.filter({ hasText: '02-scanner-fleet' }).first()).toBeVisible();
});

test('Телефон: «назад» from the chat, from the lightbox and from /s/<id> returns to the list, not out of the app', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'phone');
  await start(page);
  await expect(listShown(page)).toBeVisible();
  const opts = await search(page, 'Запоминание');
  await opts.first().click();
  await expect(chatShown(page)).toBeVisible();
  const feed = (await page.locator('section.chat .messages').first().boundingBox())!;
  expect(feed.height / page.viewportSize()!.height).toBeGreaterThanOrEqual(0.75);
  await page.goBack();
  await expect(listShown(page)).toBeVisible();
  expect(page.url().startsWith(BASE)).toBe(true);

  if (PICTURE_TITLE) {
    await (await search(page, PICTURE_TITLE)).first().click();
    const img = chatShown(page).locator('img').last();
    await img.scrollIntoViewIfNeeded();
    await img.tap();
    await expect(page.getByRole('dialog', { name: /Изображение/ })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('dialog', { name: /Изображение/ })).toHaveCount(0);
    await expect(chatShown(page)).toBeVisible();
    await page.goBack();
    await expect(listShown(page)).toBeVisible();
  }

  const sid = ((await (await api.get('/api/sidebar?cron=0')).json()) as { projects: Array<{ sessions: Array<{ id: string }> }> }).projects[0]!.sessions[0]!.id;
  await page.goto(`/s/${sid}`);
  await expect(chatShown(page)).toBeVisible();
  await page.goBack();
  await expect(listShown(page)).toBeVisible();
  expect(page.url().startsWith(BASE)).toBe(true);
});
