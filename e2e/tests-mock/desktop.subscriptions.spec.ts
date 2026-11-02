// change claude-subscriptions, tasks 6.2–6.5, against the in-memory hub on 1440×900.
// Requirements: Реестр подписок; Хранение токена подписки; Последний выбор подписки; Выбор подписки при запуске и
// handoff; Подписка в шапке вкладки и переключение; Исчерпан лимит подписки; Учёт ходов и расход по подпискам.
import { expect, test, type Page } from '@playwright/test';
import { MockHub } from '../mock/hub.js';
import { openSettingsSection, settingsNav } from './subs-checks.js';

const TOKEN = 'sk-ant-oat01-E2ESECRETTOKEN-zz99';

async function start(page: Page, hub = new MockHub({ tabs: [1], subscriptions: true })) {
  await hub.install(page);
  await page.goto('/');
  await expect(page.getByRole('list', { name: 'Машины' })).toBeVisible();
  return hub;
}

async function openRegistry(page: Page) {
  // P12: «Настройки → Подписки» from the profile menu
  return openSettingsSection(page, 'Подписки');
}

test('реестр: добавление (токен не в DOM и не в ответах), второе окно обновляется, name_taken, замена токена, порядок, вывод и возврат', async ({ page, context }) => {
  const hub = await start(page);
  const page2 = await context.newPage();
  await hub.install(page2);
  await page2.goto('/');
  const other = await openRegistry(page2);
  await expect(other.locator('.subs-name')).toHaveText(['Max личная', 'Pro рабочая']);

  // every hub answer and WS frame the windows get, to look for the token
  const seen: string[] = [];
  page.on(
    'response',
    r =>
      void r.text().then(
        t => seen.push(t),
        () => undefined,
      ),
  );
  page.on('websocket', ws => ws.on('framereceived', f => seen.push(String(f.payload))));

  await page.bringToFront(); // a background tab gets no animation frames: clicks would wait for stability forever
  const dlg = await openRegistry(page);
  await dlg.getByLabel('Имя').fill('Третья');
  const token = dlg.getByLabel('Токен', { exact: true });
  await expect(token).toHaveAttribute('type', 'password');
  await expect(token).toHaveAttribute('autocomplete', 'off');
  await token.fill(TOKEN);
  await dlg.getByRole('button', { name: 'Добавить' }).click();
  await expect(dlg.getByText('Подписка «Третья» добавлена')).toBeVisible();
  await expect(token).toHaveValue('');
  await expect(dlg.locator('.subs-row', { hasText: 'Третья' })).toContainText('…zz99');
  expect(await page.content()).not.toContain('E2ESECRET');
  expect(hub.requests.find(r => r.method === 'POST' && r.path === '/api/subscriptions')?.body).toEqual({ name: 'Третья', token: TOKEN, autoSwitch: false });
  // the other window got subscriptions.changed and reloaded the list
  await expect(other.locator('.subs-name')).toHaveText(['Max личная', 'Pro рабочая', 'Третья']);

  await dlg.getByLabel('Имя').fill('max личная');
  await token.fill(TOKEN);
  await dlg.getByRole('button', { name: 'Добавить' }).click();
  await expect(dlg.getByText('Подписка с таким именем уже есть')).toBeVisible();
  await expect(dlg.locator('.subs-name')).toHaveCount(3);
  // UI review H1: the name is checked in the browser first — no request, the pasted token stays for the fix
  await expect(token).toHaveValue(TOKEN);
  expect(hub.requests.filter(r => r.method === 'POST' && r.path === '/api/subscriptions')).toHaveLength(1);
  await token.fill('');

  await dlg.getByRole('button', { name: 'Max личная: действия' }).click();
  await page.getByRole('menuitem', { name: 'Заменить токен' }).click();
  await dlg.getByLabel(/Новый токен «Max личная»/).fill('sk-ant-oat01-REPLACEDSECRET-7777');
  await dlg.getByRole('button', { name: 'Заменить', exact: true }).click();
  await expect(dlg.locator('.subs-row', { hasText: 'Max личная' })).toContainText('…7777');
  expect(await page.content()).not.toContain('REPLACEDSECRET');

  await dlg.getByRole('button', { name: 'Третья: выше' }).click();
  await expect(dlg.locator('.subs-name')).toHaveText(['Max личная', 'Третья', 'Pro рабочая']);
  await expect(other.locator('.subs-name')).toHaveText(['Max личная', 'Третья', 'Pro рабочая']);

  await dlg.getByRole('button', { name: 'Pro рабочая: действия' }).click();
  await page.getByRole('menuitem', { name: 'Вывести' }).click();
  const retired = dlg.getByRole('region', { name: /Выведенные/ });
  await expect(retired).toContainText('Pro рабочая');
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/subs-registry.png` });
  await retired.getByRole('button', { name: 'Вернуть' }).click();
  await expect(retired).toHaveCount(0);
  await expect(dlg.locator('.subs-name')).toHaveText(['Max личная', 'Третья', 'Pro рабочая']);

  await settingsNav(page, 'Расход');
  await expect(page).toHaveURL(/\/settings\/usage$/);
  await expect(dlg.getByRole('rowheader', { name: 'Вход машины' })).toBeVisible();
  await expect(dlg.locator('caption')).toContainText('основной цикл, без субагентов');
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/subs-usage.png` });

  expect(seen.join('\n')).not.toContain('E2ESECRET');
  expect(seen.join('\n')).not.toContain('REPLACEDSECRET');
});

test('форма «Новая сессия»: предвыбор, запуск уходит с subscriptionId, шапка показывает подписку, следующая форма предлагает последний выбор; HP — подсказка', async ({ page }) => {
  const hub = await start(page);
  const pro = hub.subReg!.list[1]!;
  await page.getByRole('button', { name: 'Новая сессия' }).click();
  const dlg = page.getByRole('dialog', { name: 'Новая сессия' });
  const field = dlg.getByLabel('Подписка');
  await expect(field).toHaveValue(hub.subReg!.list[0]!.id);
  await expect(dlg.getByText(/Коннекторы claude\.ai/)).toBeVisible();
  await field.selectOption({ label: 'Pro рабочая' });
  await dlg.getByLabel('Первое сообщение').fill('проверь подписку');
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/subs-new-session.png` });
  await dlg.getByRole('button', { name: 'Запустить' }).click();
  await expect(dlg).toHaveCount(0);
  expect(hub.requests.find(r => r.method === 'POST' && r.path === '/api/sessions')?.body).toMatchObject({ subscriptionId: pro.id });
  await expect(page.locator('section.leaf.focused .chat-head select[aria-label="Подписка"]')).toHaveValue(pro.id);

  await page.getByRole('button', { name: 'Новая сессия' }).click();
  await expect(dlg.getByLabel('Подписка')).toHaveValue(pro.id);
  await dlg.getByRole('radio', { name: /ВМ \.3/ }).click();
  await expect(dlg.getByLabel('Подписка')).toBeVisible();
});

test('шапка: в ждущей сессии — переключение без interrupt и заметка; посреди хода — диалог, «Прервать и переключить» с interrupt', async ({ page }) => {
  const hub = await start(page, new MockHub({ tabs: [1, 2], subscriptions: true }));
  const max = hub.subReg!.list[0]!;
  const pro = hub.subReg!.list[1]!;
  await page.locator('.tab', { hasText: hub.session(1).title }).click();
  const head = page.locator('section.leaf.focused .chat-head');
  const select = head.locator('select[aria-label="Подписка"]');
  await expect(select).toHaveValue(max.id);
  await select.selectOption(pro.id);
  await expect(page.locator('section.leaf.focused .sysnote', { hasText: 'Подписка: Max личная → Pro рабочая' })).toBeVisible();
  await expect(select).toHaveValue(pro.id);
  expect(hub.subReg!.switches[0]).toEqual({ subscriptionId: pro.id });
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/subs-head.png` });

  await page.locator('.tab', { hasText: hub.session(2).title }).click();
  await expect(head.locator('.pill')).toContainText(/работает|Работает|ход/i);
  await head.locator('select[aria-label="Подписка"]').selectOption(pro.id);
  const dlg = page.getByRole('alertdialog', { name: 'Идёт ход: прервать и переключить?' });
  await expect(dlg).toBeVisible();
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/subs-confirm.png` });
  await dlg.getByRole('button', { name: 'Прервать и переключить' }).click();
  await expect(dlg).toHaveCount(0);
  expect(hub.subReg!.switches.slice(1)).toEqual([{ subscriptionId: pro.id }, { subscriptionId: pro.id, interrupt: true }]);
  await expect(head.locator('select[aria-label="Подписка"]')).toHaveValue(pro.id);
});

test('лимит: заметка со временем сброса и кнопкой, выбор другой подписки шлёт repeatLast и повторяет сообщение', async ({ page }) => {
  const hub = await start(page);
  const pro = hub.subReg!.list[1]!;
  hub.limitNote(1);
  const note = page.locator('section.leaf.focused .sysnote.sub-note.limit');
  await expect(note).toContainText(/Лимит подписки Max личная исчерпан, сброс в \d\d:\d\d/);
  await note.getByRole('button', { name: 'Продолжить под другой подпиской' }).click();
  const menu = page.getByRole('menu', { name: 'Продолжить под подпиской' });
  await expect(menu.getByRole('menuitem')).toHaveText(['Pro рабочая']);
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/subs-limit.png` });
  const answers = page.locator('section.leaf.focused .msg.assistant:not(.partial)');
  const before = await answers.count();
  await menu.getByRole('menuitem', { name: 'Pro рабочая' }).click();
  await expect.poll(() => hub.subReg!.switches).toEqual([{ subscriptionId: pro.id, repeatLast: true }]);
  await expect(page.locator('section.leaf.focused .sysnote', { hasText: 'Подписка: Max личная → Pro рабочая' })).toBeVisible();
  // the last user message is sent again under the new subscription: one more answer
  await expect(answers).toHaveCount(before + 1);
  // the form now marks the limit of «Max личная»
  await page.getByRole('button', { name: 'Новая сессия' }).click();
  await expect(page.getByRole('dialog', { name: 'Новая сессия' }).getByLabel('Подписка').locator('option').first()).toHaveText(/Max личная \(лимит до \d\d:\d\d\)/);
});

test('лимит в уснувшей сессии: «Продолжить под другой подпиской» будит её под новой подпиской и повторяет сообщение', async ({ page }) => {
  const hub = await start(page);
  const pro = hub.subReg!.list[1]!;
  // after a limit the agent ends the process: the session sleeps when the user comes to the note
  hub.upsert({ ...hub.session(1), status: 'sleeping', processAlive: false, sleptAt: new Date().toISOString() });
  hub.limitNote(1);
  const head = page.locator('section.leaf.focused .chat-head');
  await expect(head.locator('select[aria-label="Подписка: продолжит под"]')).toBeVisible();
  const note = page.locator('section.leaf.focused .sysnote.sub-note.limit');
  await note.getByRole('button', { name: 'Продолжить под другой подпиской' }).click();
  const answers = page.locator('section.leaf.focused .msg.assistant:not(.partial)');
  const before = await answers.count();
  await page.getByRole('menu', { name: 'Продолжить под подпиской' }).getByRole('menuitem', { name: 'Pro рабочая' }).click();
  await expect.poll(() => hub.subReg!.switches).toEqual([{ subscriptionId: pro.id, repeatLast: true }]);
  await expect(page.locator('section.leaf.focused .sysnote', { hasText: 'Подписка: Max личная → Pro рабочая' })).toBeVisible();
  await expect(answers).toHaveCount(before + 1);
  // woken under the new subscription: the head shows the process subscription, not «продолжит под»
  await expect(head.locator('select[aria-label="Подписка"]')).toHaveValue(pro.id);
  expect(hub.session(1)).toMatchObject({ processAlive: true, subscription: { id: pro.id } });
});

test('пустой реестр (хаб без API): ни поля в форме, ни переключателя в шапке', async ({ page }) => {
  await start(page, new MockHub({ tabs: [1] }));
  await expect(page.locator('section.leaf.focused .chat-head')).toBeVisible();
  await expect(page.locator('.chat-head select[aria-label^="Подписка"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Новая сессия' }).click();
  await expect(page.getByRole('dialog', { name: 'Новая сессия' }).getByLabel('Подписка')).toHaveCount(0);
});
