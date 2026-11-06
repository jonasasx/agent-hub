// Tasks 2.11/2.12 flows against the in-memory hub. Requirements: spec sessions (Запуск сессии из UI, Обмен
// сообщениями, Карточка разрешения, Прерывание хода, Смена режима прав, Продолжение, Продолжение сессий вне хаба,
// Офлайн-машина) and workspace-ui (Мои вкладки).
import { expect, test, type Page } from '@playwright/test';
import { MockHub } from '../mock/hub.js';

const id = MockHub.id;

async function start(page: Page, tabs: number[]) {
  const hub = new MockHub({ tabs });
  await hub.install(page);
  await page.goto('/');
  await expect(page.getByRole('complementary', { name: 'Сессии и проекты' })).toBeVisible();
  return hub;
}
const chat = (page: Page) => page.locator('section.leaf.focused section.chat');

test('Запуск сессии: cwd error keeps the form, then the session opens as a tab and streams the answer', async ({ page }) => {
  const hub = await start(page, [1]);
  await page.getByRole('button', { name: 'Новая сессия' }).click();
  const dialog = page.getByRole('dialog', { name: 'Новая сессия' });
  await expect(dialog.getByRole('radio', { name: /HP/ })).toBeDisabled();
  await expect(dialog.getByLabel('Каталог')).toHaveValue('C:\\Users\\alice\\vault');
  await expect(dialog.getByLabel('Режим прав')).toHaveValue('bypassPermissions');
  await dialog.getByRole('radio', { name: /ВМ \.3/ }).click();
  await expect(dialog.getByLabel('Каталог')).toHaveValue('/home/ubuntu/vault');
  await dialog.getByRole('radio', { name: /X1/ }).click();
  await dialog.getByLabel('Каталог').fill('C:\\nope');
  await dialog.getByLabel('Первое сообщение').fill('Скажи, на какой машине ты работаешь: выполни hostname');
  await dialog.getByRole('button', { name: 'Запустить' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Каталог не найден на X1');
  await dialog.getByLabel('Каталог').fill('C:\\Users\\alice\\vault');
  await dialog.getByRole('button', { name: 'Запустить' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('tab', { selected: true })).toHaveText(/Скажи, на какой машине/);
  await expect(chat(page).getByText('Принято: «Скажи, на какой машине ты работаешь: выполни hostname». Готово.')).toBeVisible();
  const post = hub.requests.find(r => r.method === 'POST' && r.path === '/api/sessions');
  expect(post?.body).toMatchObject({ runnerId: 'x1', permissionMode: 'bypassPermissions', model: 'opus' });
});

test('Ответ появляется потоком: Enter sends, «Claude работает…», the answer arrives without reload; Shift+Enter is a newline', async ({ page }) => {
  const hub = await start(page, [4]);
  const box = chat(page).getByLabel('Сообщение');
  await box.fill('первая строка');
  await box.press('Shift+Enter');
  await box.pressSequentially('вторая');
  await expect(box).toHaveValue('первая строка\nвторая');
  await box.press('Enter');
  await expect(chat(page).locator('.thinking')).toBeVisible();
  await expect(chat(page).getByText(/Принято: «первая строка/)).toBeVisible();
  await expect(chat(page).locator('.thinking')).toBeHidden();
  await expect(box).toHaveValue('');
  const sent = hub.requests.find(r => r.path.endsWith('/messages'));
  expect((sent?.body as { clientUuid: string }).clientUuid).toMatch(/^[0-9a-f-]{36}$/);
});

test('Карточка разрешения: «Разрешить» replaces the card with «Bash: разрешено»', async ({ page }) => {
  const hub = await start(page, [3]);
  const card = chat(page).getByRole('group', { name: 'Запрос разрешения: Bash' });
  await expect(card).toContainText('npm run crawl');
  await card.getByRole('button', { name: 'Разрешить', exact: true }).click();
  await expect(chat(page).getByText('Bash: разрешено')).toBeVisible();
  await expect(card).toBeHidden();
  expect(hub.requests.find(r => r.path.includes('/permissions/'))?.body).toEqual({ decision: 'allow' });
});

test('Решение на другом устройстве: permission.resolved from the hub closes the card', async ({ page }) => {
  const hub = await start(page, [3]);
  await expect(chat(page).getByRole('group', { name: /Запрос разрешения/ })).toBeVisible();
  hub.push({ type: 'permission.resolved', sessionId: id(3), requestId: 'r-3', decision: 'deny' });
  await expect(chat(page).getByText('Bash: запрещено')).toBeVisible();
});

test('Прерывание: «Прервать» during a turn adds «Ход прерван»', async ({ page }) => {
  await start(page, [2]);
  await chat(page).getByRole('button', { name: 'Прервать' }).click();
  await expect(chat(page).getByText('Ход прерван')).toBeVisible();
  await expect(chat(page).getByRole('button', { name: 'Прервать' })).toBeHidden();
});

test('Переключение на plan: the hub toast «Режим прав изменён — со следующего хода», mode shown in the head', async ({ page }) => {
  await start(page, [1]);
  await chat(page).getByLabel('Режим прав', { exact: true }).selectOption('plan');
  await expect(page.getByText('Режим прав изменён — со следующего хода')).toBeVisible();
  await expect(chat(page).getByLabel('Режим прав', { exact: true })).toHaveValue('plan');
  // a wide pane does not repeat the mode under the composer (UI review H1); bypassPermissions would still be shown
  await expect(chat(page).locator('.composer .pill')).toBeHidden();
});

test('Сессия ещё жива в терминале: warning first, «Продолжить всё равно» resends with force', async ({ page }) => {
  const hub = await start(page, [8]);
  await chat(page).getByLabel('Сообщение').fill('продолжим');
  await chat(page).getByLabel('Сообщение').press('Enter');
  const warn = chat(page).getByRole('alertdialog');
  await expect(warn).toContainText('Сессия, возможно, открыта в терминале на X1');
  await warn.getByRole('button', { name: 'Продолжить всё равно' }).click();
  await expect(warn).toBeHidden();
  const sends = hub.requests.filter(r => r.path.endsWith('/messages'));
  expect(sends).toHaveLength(2);
  expect(sends[1]!.body).toMatchObject({ force: true, clientUuid: (sends[0]!.body as { clientUuid: string }).clientUuid });
});

test('Чтение при офлайн-машине: banner, input «Недоступно», mode and model disabled', async ({ page }) => {
  await start(page, [5]);
  await expect(chat(page).getByText(/HP не в сети с/)).toBeVisible();
  // M4b: the offline banner offers a handoff (spec sessions «Офлайн-машина»)
  await expect(chat(page).getByRole('button', { name: 'Handoff на другую машину' })).toBeVisible();
  await expect(chat(page).getByLabel('Сообщение')).toBeDisabled();
  await expect(chat(page).getByLabel('Сообщение')).toHaveAttribute('placeholder', 'Недоступно');
  await expect(chat(page).getByLabel('Режим прав', { exact: true })).toBeDisabled();
  await expect(chat(page).getByText('Ответ по теме «Постмортем: тайминги очереди DZI».')).toBeVisible();
});

test('Спящая сессия: banner «Спит с …», «Продолжить» wakes it with «Поднята через resume»', async ({ page }) => {
  await start(page, [6]);
  await expect(chat(page).getByText(/Спит с/)).toBeVisible();
  await chat(page).getByRole('button', { name: 'Продолжить' }).click();
  await expect(chat(page).getByText('Поднята через resume')).toBeVisible();
  await expect(chat(page).getByText(/Спит с/)).toBeHidden();
});

test('Каталог удалён: read-only banner and no input', async ({ page }) => {
  await start(page, [7]);
  await expect(chat(page).getByText('Каталог проекта на машине удалён — только чтение.')).toBeVisible();
  await expect(chat(page).getByLabel('Сообщение')).toBeDisabled();
});

test('Дифф правки on a real transcript: Edit row expands to a diff', async ({ page }) => {
  await start(page, [1]);
  const edit = chat(page).locator('details.tool', { hasText: 'Edit' });
  await edit.locator('summary').scrollIntoViewIfNeeded();
  await edit.locator('summary').click({ force: true });
  await expect(edit.locator('.del')).toHaveCount(1);
  await expect(edit.locator('.hunk')).toHaveText('@@ -710,7 +710,6 @@');
});

test('Сессия просит разрешение: the row is first in «Сейчас» with «!»', async ({ page }) => {
  await start(page, [1]);
  const now = page.locator('.side-scroll > .srow');
  await expect(now.first()).toContainText('ждёт разрешения');
  await expect(now.first().locator('.g-perm')).toHaveText('!');
  await expect(page.getByRole('heading', { name: /Сейчас/ })).toContainText('3');
});

test('Review B3: an answer that arrived while the tab was in the background is shown when coming back', async ({ page }) => {
  const hub = await start(page, [2, 4]);
  await page.getByRole('tab', { name: /Роллаут/ }).click();
  await expect(chat(page).locator('.thinking')).toBeVisible();
  await page.getByRole('tab', { name: /подписка/ }).click();
  await expect.poll(() => hub.received.filter(m => m.type === 'subscribe').at(-1)).toEqual({ type: 'subscribe', sessionIds: [id(4)], subagentIds: [] });
  hub.appendAnswer(2, 'Партия 2 раскатана, чеки зелёные.');
  await page.getByRole('tab', { name: /Роллаут/ }).click();
  await expect(chat(page).getByText('Партия 2 раскатана, чеки зелёные.')).toBeVisible();
});
