// change claude-subscriptions, task 6.6: the UI review fixes on 1440×900 against the in-memory hub.
// C2 the note menu above the composer; C3 the limit warning under the form field; H2 «Заменить токен» from the note;
// H3 «⚙» opens the screen; H4 one height on both tabs, the row menu inside the body; H5 disabled selects look
// disabled; M3 checkbox accent; M11 pill contrast in both themes.
import { expect, test, type Page } from '@playwright/test';
import { MockHub } from '../mock/hub.js';
import { menuAboveComposer, openSettingsSection, pillContrast, settingsNav } from './subs-checks.js';

async function start(page: Page, theme: 'dark' | 'light' = 'dark', hub = new MockHub({ tabs: [1], subscriptions: true })) {
  await page.addInitScript(t => localStorage.setItem('ah-theme', t), theme);
  await hub.install(page);
  await page.goto('/');
  await expect(page.getByRole('list', { name: 'Машины' })).toBeVisible();
  return hub;
}

test('C2/C3: the menu of the limit note opens above the composer; the form warns about the limit of the preselected subscription', async ({ page }) => {
  const hub = await start(page);
  hub.limitNote(1);
  const note = page.locator('section.leaf.focused .sysnote.sub-note.limit');
  await expect(note).toBeVisible();
  await note.getByRole('button', { name: 'Продолжить под другой подпиской' }).click();
  const menu = page.getByRole('menu', { name: 'Продолжить под подпиской' });
  await expect(menu).toHaveClass(/\bup\b/);
  await menuAboveComposer(page, menu);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  // the default stays «Max личная» (the spec rule), the limit is said under the field
  await page.getByRole('button', { name: 'Новая сессия' }).click();
  const dlg = page.getByRole('dialog', { name: 'Новая сессия' });
  await expect(dlg.getByLabel('Подписка')).toHaveValue(hub.subReg!.list[0]!.id);
  await expect(dlg.locator('.sub-warn.warn')).toHaveText(/^Лимит до \d\d:\d\d — первый ход упрётся в лимит$/);
  await expect(dlg.locator('.sub-warn.warn')).toHaveCSS('color', await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--warn').trim()).then(hexToRgb));
});

test('явный выбор в «Новой сессии» выведен в другом окне: не подменяется, «Запустить» заблокирован до нового выбора', async ({ page, context }) => {
  const hub = await start(page);
  const pro = hub.subReg!.list[1]!;
  await page.getByRole('button', { name: 'Новая сессия' }).click();
  const dlg = page.getByRole('dialog', { name: 'Новая сессия' });
  await dlg.getByLabel('Подписка').selectOption(pro.id);
  await dlg.getByLabel('Первое сообщение').fill('под Pro');
  // the other window retires «Pro рабочая»: subscriptions.changed reaches this one
  const page2 = await context.newPage();
  await hub.install(page2);
  await page2.goto('/');
  const set2 = await openSettingsSection(page2, 'Подписки');
  await set2.getByRole('button', { name: 'Pro рабочая: действия' }).click();
  await page2.getByRole('menuitem', { name: 'Вывести' }).click();
  await expect.poll(() => pro.retired).toBe(true);
  await page.bringToFront();
  await expect(dlg.getByText('Подписка «Pro рабочая» выведена — выберите другую')).toBeVisible();
  await expect(dlg.getByLabel('Подписка')).toHaveValue(pro.id);
  await expect(dlg.getByLabel('Подписка').locator('option:checked')).toHaveText('Pro рабочая (выведена)');
  await expect(dlg.getByRole('button', { name: 'Запустить' })).toBeDisabled();
  await dlg.getByLabel('Первое сообщение').press('Control+Enter');
  expect(hub.requests.some(r => r.method === 'POST' && r.path === '/api/sessions')).toBe(false);
  await dlg.getByLabel('Подписка').selectOption(hub.subReg!.list[0]!.id);
  await dlg.getByRole('button', { name: 'Запустить' }).click();
  await expect(dlg).toHaveCount(0);
  expect(hub.requests.find(r => r.method === 'POST' && r.path === '/api/sessions')?.body).toMatchObject({ subscriptionId: hub.subReg!.list[0]!.id });
});

test('работа в фоне: у ждущей сессии с работающими субагентами — «Работает в фоне: остановить и переключить?», подтверждение шлёт interrupt', async ({ page }) => {
  const hub = new MockHub({ tabs: [1], subscriptions: true });
  hub.sessions.set(MockHub.id(1), { ...hub.session(1), status: 'waiting', processAlive: true, subagents: { total: 1, running: 1, working: 1 } });
  await start(page, 'dark', hub);
  const pro = hub.subReg!.list[1]!;
  await page.locator('section.leaf.focused .chat-head select[aria-label="Подписка"]').selectOption(pro.id);
  const dlg = page.getByRole('alertdialog', { name: 'Работает в фоне: остановить и переключить?' });
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText('Фоновые задачи сессии будут остановлены');
  const go = dlg.getByRole('button', { name: 'Остановить и переключить' });
  await expect(go).toHaveClass(/\bdanger\b/);
  await go.click();
  await expect(dlg).toHaveCount(0);
  expect(hub.subReg!.switches).toEqual([{ subscriptionId: pro.id }, { subscriptionId: pro.id, interrupt: true }]);
});

test('N1: Esc в меню «⋯» строки реестра закрывает только меню — раздел «Подписки» остаётся, фокус на «⋯»', async ({ page }) => {
  await start(page);
  const set = await openSettingsSection(page, 'Подписки');
  const more = set.getByRole('button', { name: 'Pro рабочая: действия' });
  await more.click();
  const menu = page.getByRole('menu', { name: 'Действия: Pro рабочая' });
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();
  await expect(set).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/subscriptions$/);
});

test('P12: «⚙» в подвале нет; адреса /settings/subscriptions и /settings/usage открывают разделы, «Назад» закрывает настройки', async ({ page }) => {
  await start(page);
  await expect(page.getByRole('button', { name: 'Подписки Claude' })).toHaveCount(0);
  await expect(page.locator('.side-bottom button')).toHaveCount(0);
  await page.goto('/settings/subscriptions');
  const set = page.getByRole('region', { name: 'Настройки' });
  await expect(set.getByRole('heading', { level: 2, name: 'Подписки' })).toBeVisible();
  await expect(set.locator('.subs-name')).toHaveCount(2);
  const nav = page.getByRole('navigation', { name: 'Разделы настроек' });
  await expect(nav.getByRole('button')).toHaveText(['Машины', 'Подписки', 'Расход', 'Пользователи', 'Безопасность']);
  await page.goto('/settings/usage');
  await expect(set.getByRole('heading', { level: 2, name: 'Расход' })).toBeVisible();
  await expect(set.getByRole('rowheader', { name: 'Вход машины' })).toBeVisible();
  await page.goto('/');
  await openSettingsSection(page, 'Расход');
  await page.goBack();
  await expect(set).toHaveCount(0);
  await expect(page.locator('section.leaf.focused .chat-head')).toBeVisible();
});

test('P12: хаб без API подписок — разделов нет, /settings/subscriptions даёт «Страница не найдена»', async ({ page }) => {
  await start(page, 'dark', new MockHub({ tabs: [1] }));
  await page.getByRole('button', { name: 'Профиль' }).click();
  await expect(page.getByRole('menu', { name: 'Профиль' }).getByRole('menuitem', { name: 'Машины' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Подписки' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Расход' })).toHaveCount(0);
  await page.goto('/settings/subscriptions');
  const set = page.getByRole('region', { name: 'Настройки' });
  await expect(set.getByRole('heading', { name: 'Страница не найдена' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Разделы настроек' })).not.toContainText('Подписки');
  await expect(page.getByRole('navigation', { name: 'Разделы настроек' })).not.toContainText('Расход');
});

test('H2/P12: «Заменить токен» в заметке открывает «Настройки → Подписки» с формой этой подписки и фокусом; «Назад» возвращает в чат', async ({ page }) => {
  const hub = await start(page);
  hub.authNote(1);
  const note = page.locator('section.leaf.focused .sysnote.sub-note.auth');
  await expect(note.locator('.sub-note-text')).toHaveCSS('color', await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bad').trim()).then(hexToRgb));
  await note.getByRole('button', { name: 'Заменить токен' }).click();
  const dlg = page.getByRole('region', { name: 'Настройки' });
  await expect(page).toHaveURL(/\/settings\/subscriptions$/);
  await expect(dlg.getByLabel(/Новый токен «Max личная»/)).toBeFocused();
  await expect(dlg.getByLabel(/Новый токен «Pro рабочая»/)).toHaveCount(0);
  await dlg.getByLabel(/Новый токен «Max личная»/).fill('sk-ant-oat01-REPLACED-FROM-NOTE-1234');
  await dlg.getByRole('button', { name: 'Заменить', exact: true }).click();
  await expect(dlg.locator('.subs-row', { hasText: 'Max личная' })).toContainText('…1234');
  await expect(dlg.locator('.subs-row', { hasText: 'Max личная' })).not.toContainText('токен отклонён');
  await page.goBack();
  await expect(dlg).toHaveCount(0);
  await expect(page.locator('section.leaf.focused .sysnote.sub-note.auth')).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

for (const theme of ['dark', 'light'] as const) {
  test(`M3/M11 (${theme}): the last row menu on screen, checkbox accent, pills ≥ 4.5:1; «Расход» with the total`, async ({ page }) => {
    const hub = new MockHub({ tabs: [1], subscriptions: true });
    hub.subReg!.list[0]!.limitResetsAt = new Date(Date.now() + 3_600_000).toISOString();
    hub.subReg!.list[1]!.tokenRejected = true;
    await start(page, theme, hub);
    const dlg = await openSettingsSection(page, 'Подписки');
    await expect(dlg.locator('.subs-name')).toHaveCount(2);
    for (const pill of await dlg.locator('.pill.subs-tag.warn, .pill.subs-tag.bad').all()) {
      const r = await pillContrast(pill);
      expect(r, `${await pill.textContent()} (${theme})`).toBeGreaterThanOrEqual(4.5);
    }
    const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
    for (const cb of await dlg.locator('input[type="checkbox"]').all()) await expect(cb).toHaveCSS('accent-color', hexToRgb(accent));
    // the menu of the last row stays inside the scrolling settings column
    await dlg.getByRole('button', { name: 'Pro рабочая: действия' }).click();
    const body = (await dlg.boundingBox())!;
    for (const it of await page.getByRole('menu', { name: 'Действия: Pro рабочая' }).getByRole('menuitem').all()) {
      const b = (await it.boundingBox())!;
      expect(b.y).toBeGreaterThanOrEqual(body.y - 0.5);
      expect(b.y + b.height).toBeLessThanOrEqual(body.y + body.height + 0.5);
    }
    await dlg.getByRole('button', { name: 'Pro рабочая: действия' }).click();
    await settingsNav(page, 'Расход');
    await expect(dlg.getByRole('rowheader', { name: 'Вход машины' })).toBeVisible();
    await expect(dlg.getByRole('rowheader', { name: 'Итого' })).toBeVisible();
    await expect(dlg.locator('caption .subs-range')).toHaveText(/\d\d\.\d\d\.\d{4}/);
  });
}

test('H5: a disabled select.mini and a disabled modal select are visually distinct from enabled ones', async ({ page }) => {
  await start(page);
  const head = page.locator('section.leaf.focused .chat-head select[aria-label="Подписка"]');
  await expect(head).toBeEnabled();
  const look = (sel: string) =>
    page.evaluate(s => {
      const el = document.querySelector<HTMLSelectElement>(s)!;
      const on = getComputedStyle(el);
      const a = { opacity: on.opacity, cursor: on.cursor };
      el.disabled = true;
      const off = getComputedStyle(el);
      const b = { opacity: off.opacity, cursor: off.cursor };
      el.disabled = false;
      return { a, b };
    }, sel);
  const mini = await look('section.leaf.focused .chat-head select.mini[aria-label="Подписка"]');
  expect(mini.a.opacity).toBe('1');
  expect(Number(mini.b.opacity)).toBeLessThanOrEqual(0.5);
  expect(mini.b.cursor).toBe('not-allowed');
  await page.getByRole('button', { name: 'Новая сессия' }).click();
  const form = await look('.modal select.input');
  expect(Number(form.b.opacity)).toBeLessThanOrEqual(0.5);
  expect(form.b.cursor).toBe('not-allowed');
});

function hexToRgb(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgb(${parseInt(m[1]!, 16)}, ${parseInt(m[2]!, 16)}, ${parseInt(m[3]!, 16)})`;
}
