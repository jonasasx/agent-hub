// change client-versions (spec client-update, version-info) on the desktop against the in-memory hub: the mock
// «deploys» a build (/version.json and the shell module), the page finds it, reloads by the button or silently while
// hidden with nothing to lose, never with a draft, at most once per build.
import { expect, test, type Page } from '@playwright/test';
import { MockHub } from '../mock/hub.js';

const banner = (page: Page) => page.getByRole('status', { name: 'Доступна новая версия' });
const composer = (page: Page) => page.locator('section.leaf.focused').getByRole('textbox', { name: 'Сообщение' });

async function start(page: Page, setup?: (hub: MockHub) => void) {
  const hub = new MockHub({ tabs: [1, 4] });
  setup?.(hub);
  await hub.install(page);
  await page.goto('/');
  await expect(page.locator('section.leaf .chat-title')).toBeVisible();
  await expect.poll(() => hub.versionRequests).toBeGreaterThan(0);
  await markPage(page);
  return hub;
}

/** A mark of this document: gone after a reload. */
const markPage = (page: Page) => page.evaluate(() => ((window as unknown as { __mark: number }).__mark = 1));
const sameDocument = (page: Page) => page.evaluate(() => (window as unknown as { __mark?: number }).__mark === 1).catch(() => false);

/** focus/visible checks are debounced by 5 s after the start check (design D3). */
async function focusCheck(page: Page) {
  await page.waitForTimeout(5_200);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
}

async function setHidden(page: Page, hidden: boolean) {
  await page.evaluate(h => {
    Object.defineProperty(document, 'visibilityState', { value: h ? 'hidden' : 'visible', configurable: true });
    Object.defineProperty(document, 'hidden', { value: h, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

async function menuVersions(page: Page): Promise<string[]> {
  await page.getByRole('button', { name: 'Профиль' }).click();
  const rows = await page
    .getByRole('menu', { name: 'Профиль' })
    .getByLabel('Версии')
    .evaluate(dl => [...dl.querySelectorAll('dt')].map(dt => `${dt.textContent} ${dt.nextElementSibling!.textContent}`));
  await page.keyboard.press('Escape');
  return rows;
}

test('«Деплой при открытом окне»: focus → banner, «Обновить» → the new build, the same tabs', async ({ page }) => {
  const hub = await start(page);
  expect(await menuVersions(page)).toEqual([expect.stringMatching(/^Клиент 0\.1\.0 · 1111111 · /), expect.stringMatching(/^Хаб 0\.1\.0 · 1111111 · /)]);
  const tabs = await page.getByRole('tab').allTextContents();
  hub.deploy('2222222');
  await focusCheck(page);
  await expect(banner(page)).toBeVisible();
  await expect(banner(page)).not.toContainText('Черновик пропадёт');
  await page.getByRole('button', { name: 'Профиль' }).click();
  await expect(page.getByRole('menuitem', { name: 'Обновить до новой версии' })).toBeVisible();
  await page.keyboard.press('Escape');
  await Promise.all([page.waitForEvent('load'), banner(page).getByRole('button', { name: 'Обновить' }).click()]);
  await expect(page.locator('section.leaf .chat-title')).toBeVisible();
  expect(await sameDocument(page)).toBe(false);
  await expect(banner(page)).toHaveCount(0);
  expect((await menuVersions(page))[0]).toMatch(/^Клиент 0\.1\.0 · 2222222 · /);
  await expect.poll(() => page.getByRole('tab').allTextContents()).toEqual(tabs);
});

test('«Позже» hides the banner, the menu item stays; a failed check shows nothing', async ({ page }) => {
  const hub = await start(page);
  hub.versionDown = true;
  hub.deploy('2222222');
  await focusCheck(page);
  await expect.poll(() => hub.versionRequests).toBeGreaterThan(1);
  await expect(banner(page)).toHaveCount(0);
  hub.versionDown = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(banner(page)).toBeVisible();
  await banner(page).getByRole('button', { name: 'Позже' }).click();
  await expect(banner(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Профиль' }).click();
  await expect(page.getByRole('menuitem', { name: 'Обновить до новой версии' })).toBeVisible();
});

test('hidden without input: a new build found while hidden reloads silently; shown again — the new build', async ({ page }) => {
  const hub = await start(page);
  await setHidden(page, true);
  hub.deploy('2222222');
  // agent answers while the page reloads: the answer is whole after the resync
  await Promise.all([page.waitForEvent('load'), page.evaluate(() => window.dispatchEvent(new Event('online')))]);
  hub.appendAnswer(1, 'Ответ, пришедший во время перезагрузки');
  await expect(page.locator('section.leaf .chat-title')).toBeVisible();
  expect(await sameDocument(page)).toBe(false);
  expect((await menuVersions(page))[0]).toMatch(/· 2222222 · /);
  await page.getByRole('tab', { name: /GUI-прототип/ }).click();
  await expect(page.locator('section.leaf.focused')).toContainText('Ответ, пришедший во время перезагрузки');
  await expect(banner(page)).toHaveCount(0);
});

test('«Скрытие окна при известной новой сборке»: the banner is up, hiding reloads at once', async ({ page }) => {
  const hub = await start(page);
  hub.deploy('2222222');
  await focusCheck(page);
  await expect(banner(page)).toBeVisible();
  await Promise.all([page.waitForEvent('load'), setHidden(page, true)]);
  await expect(page.locator('section.leaf .chat-title')).toBeVisible();
  expect((await menuVersions(page))[0]).toMatch(/· 2222222 · /);
});

test('«Скрытое окно с черновиком»: no reload, the draft stays, the banner warns and asks before reloading', async ({ page }) => {
  const hub = await start(page);
  await composer(page).fill('Недописанный вопрос про HP');
  await setHidden(page, true);
  hub.deploy('2222222');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => hub.versionRequests).toBeGreaterThan(1);
  await page.waitForTimeout(800);
  expect(await sameDocument(page)).toBe(true);
  await setHidden(page, false);
  await expect(composer(page)).toHaveValue('Недописанный вопрос про HP');
  await expect(banner(page)).toContainText('Черновик пропадёт');
  page.once('dialog', d => void d.dismiss());
  await banner(page).getByRole('button', { name: 'Обновить' }).click();
  await page.waitForTimeout(500);
  expect(await sameDocument(page)).toBe(true);
  await expect(composer(page)).toHaveValue('Недописанный вопрос про HP');
});

test('no loop: the shell stays old after a silent reload — no second automatic reload, the banner stays', async ({ page }) => {
  const hub = await start(page);
  await setHidden(page, true);
  hub.deploy('2222222', { client: false });
  await Promise.all([page.waitForEvent('load'), page.evaluate(() => window.dispatchEvent(new Event('online')))]);
  await expect(page.locator('section.leaf .chat-title')).toBeVisible();
  await markPage(page);
  expect((await menuVersions(page))[0]).toMatch(/· 1111111 · /);
  await expect(banner(page)).toBeVisible();
  await setHidden(page, true);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(1_500);
  expect(await sameDocument(page)).toBe(true);
  await setHidden(page, false);
  await expect(banner(page)).toBeVisible();
});

test('machines window: an outdated agent of an online machine, «обновляется» while it updates', async ({ page }) => {
  await start(page, hub => {
    hub.runnerPatch = { vm: { agentVersion: '0.1.2', outdated: true }, x1: { agentVersion: '0.1.2', outdated: true, update: { version: '0.2.0', status: 'installing', error: null, at: '' } } };
  });
  const line = page.getByRole('list', { name: 'Машины' });
  await expect(line.getByRole('button', { name: /^ВМ \.3: агент устарел/ })).toContainText('ВМ .3 · агент устарел');
  await expect(line.getByRole('button', { name: /^X1: обновляется/ })).toContainText('X1 · обновляется');
  await expect(line.getByRole('button', { name: /^ВМ \.3/ })).toHaveAttribute('title', /агент 0\.1\.2/);
});
