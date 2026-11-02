// Tasks 2.10 and 2.19 on the live stand (QA), M2.1 model: every browser window has its own tabs and layout
// (sessionStorage), the hub keeps only the last changed layout of a device class as the template of a new window.
// Covers: split with the hint, insertion slot, fifth pane, closing a pane, eviction of the ninth tab, tabs_full,
// Ctrl+\ round trip with a new tab (and a reload in between), «Новое разделение сбрасывает запомненное», re-opening,
// middle-click close, Ctrl+N, and independent windows (2–3 browser contexts with one cookie).
// Requirements: spec workspace-ui (Мои вкладки; Сплит; Место вставки; Разделитель и закрытие панели; Одно окно и
// Вернуть разделение; Горячие клавиши; Независимые окна; Раскладка нового окна и перезагрузка).
//
// Runs against a real hub with a real user cookie and the user's existing sessions (nothing is created or stopped):
//   E2E_BASE_URL=https://hub.internal.example.com E2E_COOKIE=<ah_session> E2E_SESSIONS=<id,id,…(≥10)> \
//   E2E_CHANNEL=msedge npx playwright test tests/m2.workspace.spec.ts --project=desktop
// Each test sets the desktop template with PUT /api/layout and opens fresh windows (contexts without sessionStorage),
// so they start from it. The user's desktop and phone templates are read before the suite and put back after it.
// Windows the user already has open are not affected (they never read the template after their start), but
// во время прогона не менять раскладку в открытых окнах хаба: their PUT would replace the template a test relies on.
// Before a test window is closed it gets pagehide and the suite waits for its last PUT, so no late keepalive PUT lands
// on the next test's template.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, request as pwRequest, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:8080';
const COOKIE = process.env.E2E_COOKIE ?? '';
const IDS = (process.env.E2E_SESSIONS ?? '').split(',').filter(Boolean);

test.skip(!COOKIE || IDS.length < 10, 'needs E2E_COOKIE and ≥10 session ids in E2E_SESSIONS');
test.skip(({ isMobile }) => isMobile, 'desktop only');

type Template = { layout: unknown; savedLayout: unknown; openedAt: Record<string, string> | null };
const SNAP = join(tmpdir(), 'agent-hub-e2e-m21-templates.json');
let api: APIRequestContext;
const titles: Record<string, string> = {};
let saved: Record<'desktop' | 'phone', Template> | null = null;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const re = (sid: string) => new RegExp(esc(titles[sid]!));
const tab = (page: Page, sid: string) => page.getByRole('tab', { name: re(sid) });
const panes = (page: Page) => page.locator('section.leaf');
const treeRow = (page: Page, sid: string) =>
  page
    .locator('aside')
    .getByRole('button', { name: re(sid) })
    .last();
/** Clicks the session in the tree; sessions past the five freshest need «ещё N» first. */
async function openFromTree(page: Page, sid: string) {
  const more = page.locator('aside').getByRole('button', { name: /^ещё \d+/ });
  if (!(await treeRow(page, sid).isVisible()) && (await more.count())) await more.first().click();
  await treeRow(page, sid).click();
}

async function templateNow(device: 'desktop' | 'phone' = 'desktop'): Promise<Template> {
  const r = await api.get(`/api/layout?device=${device}`);
  expect(r.status()).toBe(200);
  const b = (await r.json()) as Template;
  return { layout: b.layout, savedLayout: b.savedLayout, openedAt: b.openedAt };
}
async function putTemplate(t: Template, device: 'desktop' | 'phone' = 'desktop') {
  const r = await api.put('/api/layout', { data: { device, layout: t.layout, savedLayout: t.savedLayout, openedAt: t.openedAt } });
  expect(r.status(), await r.text()).toBe(200);
}
const pane = (id: string, tabs: string[], active: string | null = tabs[0] ?? null) => ({ id, tabs, active });
function single(tabs: string[], active = tabs[0] ?? null) {
  return { layout: { type: 'leaf', pane: 'p1' }, panes: { p1: pane('p1', tabs, active) }, focus: 'p1', seq: 1 };
}
/** openedAt where the first tab was opened longest ago. */
function ages(tabs: string[]): Record<string, string> {
  const t0 = Date.now() - 3_600_000;
  return Object.fromEntries(tabs.map((id, i) => [id, new Date(t0 + i * 60_000).toISOString()]));
}
/** The desktop template every new window of this test starts from (a body without clientTs is always applied). */
async function setTemplate(layout: unknown, savedLayout: unknown = null, openedAt: Record<string, string> | null = null) {
  await putTemplate({ layout, savedLayout, openedAt });
}

/**
 * Lets a window send its last layout snapshot before it is closed: pagehide flushes an unsent change with a keepalive
 * PUT; the suite waits for its answer. A window without an unsent change sends nothing — then 1 s passes quietly.
 */
async function settle(page: Page) {
  if (page.isClosed()) return;
  const put = page.waitForResponse(r => r.url().endsWith('/api/layout') && r.request().method() === 'PUT', { timeout: 1000 }).catch(() => null);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide'))).catch(() => undefined);
  await put;
}
async function closeWindow(page: Page | null) {
  if (!page) return;
  await settle(page);
  await page.context().close();
}

/** A new browser window: own context (own sessionStorage), the user's cookie, desktop size. */
async function newWindow(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: BASE });
  await ctx.addCookies([{ name: 'ah_session', value: COOKIE, url: BASE, secure: BASE.startsWith('https'), httpOnly: true, sameSite: 'Lax' }]);
  const page = await ctx.newPage();
  await page.goto('/');
  await expect(page.getByRole('list', { name: 'Машины' })).toBeVisible();
  return page;
}
async function start(page: Page) {
  await page.context().addCookies([{ name: 'ah_session', value: COOKIE, url: BASE, secure: BASE.startsWith('https'), httpOnly: true, sameSite: 'Lax' }]);
  await page.goto('/');
  await expect(page.getByRole('list', { name: 'Машины' })).toBeVisible();
}
/** What a window shows: tab titles per pane and the selected tab of each pane. */
async function view(page: Page) {
  return panes(page).evaluateAll(els =>
    els.map(el => ({
      tabs: [...el.querySelectorAll('[role="tab"] .t-title')].map(t => t.textContent),
      selected: el.querySelector('[role="tab"][aria-selected="true"] .t-title')?.textContent ?? null,
    })),
  );
}
/** Drags `from` to the page point (x, y). */
async function dragTo(page: Page, from: ReturnType<Page['locator']>, x: number, y: number) {
  await from.dragTo(page.locator('body'), { targetPosition: { x, y } });
}
async function splitRight(page: Page, sid: string, paneIndex = 0) {
  const box = (await panes(page).nth(paneIndex).boundingBox())!;
  await dragTo(page, tab(page, sid), box.x + box.width - 20, box.y + box.height / 2);
}

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { cookie: `ah_session=${COOKIE}`, origin: BASE } });
  for (const id of IDS) titles[id] = ((await (await api.get(`/api/sessions/${id}`)).json()) as { title: string }).title;
  // one snapshot per run: a worker restarted after a failure must not take the test state for the user's own
  if (existsSync(SNAP) && Date.now() - statSync(SNAP).mtimeMs < 15 * 60_000) saved = JSON.parse(readFileSync(SNAP, 'utf8'));
  else {
    saved = { desktop: await templateNow('desktop'), phone: await templateNow('phone') };
    writeFileSync(SNAP, JSON.stringify(saved));
  }
});

test.afterEach(async ({ page }) => settle(page));

/** Puts a saved template back; a template of M2 that the M2.1 schema refuses (400) becomes «no template». */
async function restoreTemplate(t: Template, device: 'desktop' | 'phone'): Promise<Template> {
  const r = await api.put('/api/layout', { data: { device, layout: t.layout, savedLayout: t.savedLayout, openedAt: t.openedAt } });
  if (r.status() === 400) {
    const empty = { layout: null, savedLayout: null, openedAt: null };
    await putTemplate(empty, device);
    return empty;
  }
  expect(r.status(), await r.text()).toBe(200);
  return t;
}

test.afterAll(async () => {
  if (saved) {
    for (const device of ['desktop', 'phone'] as const) {
      const expected = await restoreTemplate(saved[device], device);
      expect(await templateNow(device), `${device} template restored`).toEqual(expected);
    }
  }
  await api.dispose();
});

test('Деление справа: hint, new pane on the right is active, the template follows the window', async ({ page }) => {
  const [a, b] = IDS;
  await setTemplate(single([a!, b!], a));
  await start(page);
  const box = (await panes(page).first().boundingBox())!;
  await tab(page, b!).hover();
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2, { steps: 10 });
  await expect(page.getByRole('status').filter({ hasText: 'Разделить: справа' })).toBeVisible();
  await page.mouse.move(box.x + box.width - 22, box.y + box.height / 2);
  await page.mouse.up();
  await expect(panes(page)).toHaveCount(2);
  await expect(panes(page).nth(1)).toHaveClass(/focused/);
  await expect(panes(page).nth(1).getByRole('tab')).toHaveText([re(b!)]);
  await expect.poll(async () => ((await templateNow()).layout as { layout?: { type: string; dir?: string } }).layout).toMatchObject({ type: 'split', dir: 'row' });
});

test('Место вставки: before the second tab, after the last tab', async ({ page }) => {
  const [a, b, c, d] = IDS;
  await setTemplate(single([a!, b!, c!, d!], a));
  await start(page);
  await splitRight(page, d!);
  await expect(panes(page)).toHaveCount(2);
  const right = panes(page).nth(1);
  const dBox = (await right.getByRole('tab').filter({ hasText: titles[d!]! }).boundingBox())!;
  await dragTo(page, tab(page, a!), dBox.x + 4, dBox.y + dBox.height / 2);
  await expect(right.getByRole('tab').first()).toHaveText(re(a!));
  await expect(right.getByRole('tab', { selected: true })).toHaveText(re(a!));
  const lb = (await right.getByRole('tab').last().boundingBox())!;
  await dragTo(page, tab(page, b!), lb.x + lb.width - 4, lb.y + lb.height / 2);
  await expect(right.getByRole('tab').last()).toHaveText(re(b!));
  await expect(right.getByRole('tab', { selected: true })).toHaveText(re(b!));
});

test('Пятая панель and Закрытие панели: the fifth split is refused; closing a pane appends its tabs to the neighbour', async ({ page }) => {
  const ids = IDS.slice(0, 5);
  await setTemplate(single(ids, ids[0]));
  await start(page);
  for (const sid of ids.slice(1, 4)) await tab(page, sid).dragTo(panes(page).first(), { targetPosition: { x: 5, y: 450 } });
  await expect(panes(page)).toHaveCount(4);
  await tab(page, ids[4]!).dragTo(panes(page).first(), { targetPosition: { x: 5, y: 450 } });
  await expect(page.getByText('Не больше четырёх панелей').first()).toBeVisible();
  await expect(panes(page)).toHaveCount(4);
  const before = await page.getByRole('tab').count();
  await panes(page).nth(1).getByRole('button', { name: 'Закрыть панель' }).click();
  await expect(panes(page)).toHaveCount(3);
  await expect(page.getByRole('tab')).toHaveCount(before);
});

test('Вытеснение давно не открывавшейся: the ninth tab evicts the oldest tab of this window not shown, with a toast', async ({ page }) => {
  const eight = IDS.slice(1, 9);
  const ninth = IDS[0]!; // the freshest session — visible in the tree without «ещё N»
  // eight[0] was opened longest ago; the last tab is active
  await setTemplate(single(eight, eight.at(-1)), null, ages(eight));
  await start(page);
  await expect(page.getByRole('tab')).toHaveCount(8);
  // the toast names the evicted tab by its session card; before the cards arrive it says «сессия» (QA M3b, low)
  await expect(page.getByRole('tab').filter({ hasText: 'Загрузка…' })).toHaveCount(0);
  await openFromTree(page, ninth);
  await expect(page.getByRole('tab')).toHaveCount(8);
  await expect(page.getByText('Вкладка убрана из полосы')).toBeVisible();
  await expect(
    page
      .getByText(new RegExp(`${esc(titles[eight[0]!]!)}, она осталась в списке слева`))
      .filter({ visible: true })
      .first(),
  ).toBeVisible();
  await expect(tab(page, ninth)).toHaveCount(1);
  await expect(tab(page, eight[0]!)).toHaveCount(0);
});

test('tabs_full: every tab of the window is active in a pane of the layout or of «Одно окно» → the ninth does not open', async ({ page }) => {
  const eight = IDS.slice(1, 9);
  const ninth = IDS[0]!;
  const tree = {
    type: 'split',
    dir: 'row',
    ratio: 0.5,
    a: { type: 'split', dir: 'col', ratio: 0.5, a: { type: 'leaf', pane: 'p1' }, b: { type: 'leaf', pane: 'p2' } },
    b: { type: 'split', dir: 'col', ratio: 0.5, a: { type: 'leaf', pane: 'p3' }, b: { type: 'leaf', pane: 'p4' } },
  };
  const fourWith = (k: 0 | 1) => ({
    layout: tree,
    panes: {
      p1: pane('p1', eight.slice(0, 2), eight[k]!),
      p2: pane('p2', eight.slice(2, 4), eight[2 + k]!),
      p3: pane('p3', eight.slice(4, 6), eight[4 + k]!),
      p4: pane('p4', eight.slice(6, 8), eight[6 + k]!),
    },
    focus: 'p1',
  });
  // not reachable by hand (the remembered layout exists only with one pane), but a window may start so from a template
  await setTemplate({ ...fourWith(0), seq: 4 }, fourWith(1), ages(eight));
  await start(page);
  await expect(page.getByRole('tab')).toHaveCount(8);
  // titles of tabs arrive with the session cards — compare after they are loaded
  await expect(page.getByRole('tab').filter({ hasText: 'Загрузка…' })).toHaveCount(0);
  const before = await view(page);
  await openFromTree(page, ninth);
  await expect(page.getByText('Все 8 вкладок открыты в панелях — закройте одну')).toBeVisible();
  expect(await view(page)).toEqual(before);
  await expect(tab(page, ninth)).toHaveCount(0);
});

test('Отключение монитора и возврат: Ctrl+\\ merges, survives a reload of this window, a new tab goes to the formerly active pane, Ctrl+\\ restores', async ({ page }) => {
  const [a, b, c, d] = IDS.slice(1, 5);
  const fresh = IDS[0]!;
  await setTemplate(single([a!, b!, c!, d!], a));
  await start(page);
  await splitRight(page, c!);
  const box = (await panes(page).nth(1).boundingBox())!;
  await dragTo(page, tab(page, d!), box.x + box.width / 2, box.y + box.height - 20);
  await expect(panes(page)).toHaveCount(3);
  const cPane = panes(page).filter({ has: page.getByRole('tab', { name: re(c!) }) });
  await cPane
    .locator('.chat')
    .first()
    .click({ position: { x: 30, y: 200 } });
  await expect(cPane).toHaveClass(/focused/);
  const split = await view(page);
  await page.keyboard.press('Control+Backslash');
  await expect(panes(page)).toHaveCount(1);
  await expect(page.getByText('Разделение запомнено')).toBeVisible();
  await expect(page.getByRole('tab', { selected: true })).toHaveText(re(c!));
  // the remembered layout belongs to the window: a reload keeps it (sessionStorage), no server round trip needed
  await page.reload();
  await expect(page.getByRole('button', { name: 'Вернуть разделение' })).toBeVisible();
  await openFromTree(page, fresh);
  await expect(page.getByRole('tab', { selected: true })).toHaveText(re(fresh));
  await page.keyboard.press('Control+Backslash');
  await expect(panes(page)).toHaveCount(3);
  const cPane2 = panes(page).filter({ has: page.getByRole('tab', { name: re(c!) }) });
  await expect(cPane2.getByRole('tab', { name: re(fresh) })).toHaveCount(1);
  expect((await view(page)).map(p => p.tabs.length)).toEqual(split.map(p => p.tabs.length + (p.tabs.includes(titles[c!]!) ? 1 : 0)));
});

test('Новое разделение сбрасывает запомненное', async ({ page }) => {
  const [a, b, c] = IDS;
  await setTemplate(single([a!, b!, c!], a));
  await start(page);
  await splitRight(page, c!);
  await expect(panes(page)).toHaveCount(2);
  await page.keyboard.press('Control+Backslash');
  await expect(page.getByRole('button', { name: 'Вернуть разделение' })).toBeVisible();
  await splitRight(page, b!);
  await expect(panes(page)).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Вернуть разделение' })).toHaveCount(0);
  await expect.poll(async () => (await templateNow()).savedLayout).toBeNull();
});

test('Повторное открытие: a session shown in the second pane is activated there, no new tab', async ({ page }) => {
  const [a, b, c] = IDS;
  await setTemplate(single([a!, b!, c!], a));
  await start(page);
  await splitRight(page, c!);
  await expect(panes(page)).toHaveCount(2);
  await panes(page)
    .first()
    .locator('.chat')
    .first()
    .click({ position: { x: 30, y: 200 } });
  await expect(panes(page).first()).toHaveClass(/focused/);
  await openFromTree(page, c!);
  await expect(panes(page).nth(1)).toHaveClass(/focused/);
  await expect(panes(page).nth(1).getByRole('tab', { selected: true })).toHaveText(re(c!));
  await expect(page.getByRole('tab')).toHaveCount(3);
});

test('Закрытие вкладки колёсиком: an inactive tab closes, the active one stays, no autoscroll, the session keeps its status', async ({ page }) => {
  const [a, b, c] = IDS;
  await setTemplate(single([a!, b!, c!], a));
  const statusBefore = ((await (await api.get(`/api/sessions/${c}`)).json()) as { status: string }).status;
  await start(page);
  const prevented = page.evaluate(
    () =>
      new Promise<boolean>(res => {
        window.addEventListener('mousedown', e => e.button === 1 && setTimeout(() => res(e.defaultPrevented)), { once: true, capture: false });
      }),
  );
  await tab(page, c!).click({ button: 'middle' });
  expect(await prevented).toBe(true); // no autoscroll
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.getByRole('tab', { selected: true })).toHaveText(re(a!));
  await expect.poll(async () => JSON.stringify((await templateNow()).layout)).not.toContain(c!);
  expect(((await (await api.get(`/api/sessions/${c}`)).json()) as { status: string }).status).toBe(statusBefore);
});

test('Ctrl+3 switches to the third tab; Ctrl+9 is left to the browser', async ({ page }) => {
  const ids = IDS.slice(0, 4);
  await setTemplate(single(ids, ids[0]));
  await start(page);
  await page.getByRole('tab').first().click();
  await page.keyboard.press('Control+3');
  await expect(page.getByRole('tab', { selected: true })).toHaveText(re(ids[2]!));
  const prevented = await page.evaluate(() => {
    const e = new KeyboardEvent('keydown', { key: '9', ctrlKey: true, cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });
  expect(prevented).toBe(false);
});

test.describe('Независимые окна', () => {
  test('switching, splitting, «Одно окно» and closing a tab in window A do not change window B', async ({ browser }) => {
    const ids = IDS.slice(0, 4);
    await setTemplate(single(ids, ids[0]));
    const a = await newWindow(browser);
    const b = await newWindow(browser);
    try {
      await expect(tab(b, ids[0]!)).toHaveAttribute('aria-selected', 'true');
      await expect(b.getByRole('tab').filter({ hasText: 'Загрузка…' })).toHaveCount(0);
      const before = await view(b);
      await tab(a, ids[1]!).click();
      await a.keyboard.press('Control+3');
      await splitRight(a, ids[3]!);
      await expect(panes(a)).toHaveCount(2);
      await a.keyboard.press('Control+Backslash');
      await expect(panes(a)).toHaveCount(1);
      await a.keyboard.press('Control+Backslash');
      await expect(panes(a)).toHaveCount(2);
      await tab(a, ids[1]!).click({ button: 'middle' });
      await expect(tab(a, ids[1]!)).toHaveCount(0);
      await b.waitForTimeout(1500);
      expect(await view(b)).toEqual(before);
      await expect(tab(b, ids[1]!)).toHaveCount(1);
    } finally {
      await closeWindow(a);
      await closeWindow(b);
    }
  });

  test('a reload keeps the window own layout; a new window gets the layout of the window changed last', async ({ browser }) => {
    const ids = IDS.slice(0, 3);
    await setTemplate(single(ids, ids[0]));
    const a = await newWindow(browser);
    const b = await newWindow(browser);
    let c: Page | null = null;
    try {
      await splitRight(a, ids[2]!);
      await expect(panes(a)).toHaveCount(2);
      await expect.poll(async () => ((await templateNow()).layout as { layout?: { type: string } }).layout?.type).toBe('split');
      // B changes last: another active tab and one tab closed
      await tab(b, ids[1]!).click();
      await tab(b, ids[2]!).click({ button: 'middle' });
      await expect.poll(async () => JSON.stringify((await templateNow()).layout)).not.toContain(ids[2]!);
      await a.reload();
      await expect(panes(a)).toHaveCount(2);
      c = await newWindow(browser);
      await expect(panes(c)).toHaveCount(1);
      await expect(c.getByRole('tab').filter({ hasText: 'Загрузка…' })).toHaveCount(0);
      await expect(b.getByRole('tab').filter({ hasText: 'Загрузка…' })).toHaveCount(0);
      expect(await view(c)).toEqual(await view(b));
    } finally {
      await closeWindow(a);
      await closeWindow(b);
      await closeWindow(c);
    }
  });

  test('Вытеснение не задевает другое окно: the ninth tab evicts only in its own window', async ({ browser }) => {
    const eight = IDS.slice(1, 9);
    const ninth = IDS[0]!;
    await setTemplate(single(eight, eight.at(-1)), null, ages(eight));
    const a = await newWindow(browser);
    const b = await newWindow(browser);
    try {
      for (const sid of eight.slice(0, 5)) await tab(b, sid).click({ button: 'middle' });
      await expect(b.getByRole('tab')).toHaveCount(3);
      await expect(b.getByRole('tab').filter({ hasText: 'Загрузка…' })).toHaveCount(0);
      const bBefore = await view(b);
      await openFromTree(a, ninth);
      await expect(a.getByRole('tab')).toHaveCount(8);
      await expect(a.getByText('Вкладка убрана из полосы')).toBeVisible();
      await b.waitForTimeout(1000);
      expect(await view(b)).toEqual(bBefore);
      await expect(b.getByText('Вкладка убрана из полосы')).toHaveCount(0);
    } finally {
      await closeWindow(a);
      await closeWindow(b);
    }
  });
});
