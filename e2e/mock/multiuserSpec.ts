/**
 * Multi-user screens at one viewport and theme (tasks 6.1–6.5, mock hub): the welcome screen, «Подключить машину»
 * through all stages, «Машины», «Пользователи», «Безопасность» — no horizontal scroll anywhere; screenshots when
 * SHOTS_DIR is set (UI review 6.6 compares them with docs/prototype.html).
 */
import { expect, test, type Page } from '@playwright/test';
import { MockHub } from './hub.js';
import { installMultiUser, playEnroll } from './multiuser.js';

const dir = process.env.SHOTS_DIR;

async function noHScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  const wide = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.modal, .set-body, .set-body *:not(.sr-only), .card, .modal *:not(.sr-only)')]
      .filter(el => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'auto' && el.clientWidth > 0)
      .map(el => `${el.tagName.toLowerCase()}.${el.className}`),
  );
  expect(wide).toEqual([]);
}

async function shot(page: Page, name: string) {
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

export function multiUserSpecs(device: 'desktop' | 'phone') {
  for (const theme of ['dark', 'light'] as const) {
    test(`${device} ${theme}: welcome and «Подключить машину» to «готово»`, async ({ page }) => {
      await page.addInitScript(t => localStorage.setItem('ah-theme', t), theme);
      const hub = new MockHub({ tabs: [] });
      await hub.install(page);
      await installMultiUser(page, hub, { role: 'user', empty: true });
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Борис, добро пожаловать' })).toBeVisible();
      await noHScroll(page);
      await shot(page, `mu-${device}-${theme}-welcome`);
      await page.getByRole('button', { name: 'Подключить машину' }).click();
      await expect(page.getByLabel('Имя машины')).toHaveValue('Моя машина');
      await noHScroll(page);
      await shot(page, `mu-${device}-${theme}-enroll-1`);
      await page.getByRole('radio', { name: 'macOS' }).click();
      await page.getByRole('button', { name: 'Получить команду' }).click();
      await expect(page.getByText(/install\.sh \| bash -s --/)).toBeVisible();
      await noHScroll(page);
      await shot(page, `mu-${device}-${theme}-enroll-2`);
      playEnroll(hub, ['code_used', 'connected']);
      await expect(page.getByText('Машина подключилась')).toBeVisible();
      await shot(page, `mu-${device}-${theme}-enroll-3`);
      playEnroll(hub, ['claude_checked', 'ready']);
      await expect(page.getByRole('button', { name: 'Начать первую сессию' })).toBeVisible();
      await expect(page.getByText('Нет доступа к защищённым папкам macOS.')).toBeVisible();
      await noHScroll(page);
      await shot(page, `mu-${device}-${theme}-enroll-ready`);
      await page.getByRole('button', { name: 'Начать первую сессию' }).click();
      await expect(page.getByLabel('Каталог')).toHaveValue('/Users/bob');
      await noHScroll(page);
      await shot(page, `mu-${device}-${theme}-first-session`);
    });

    test(`${device} ${theme}: «Машины», «Пользователи», «Безопасность»`, async ({ page }) => {
      await page.addInitScript(t => localStorage.setItem('ah-theme', t), theme);
      const hub = new MockHub({ tabs: [1] });
      await hub.install(page);
      await installMultiUser(page, hub, { role: 'admin' });
      await page.goto('/settings/machines');
      await expect(page.getByRole('listitem', { name: 'HP' })).toBeVisible();
      await noHScroll(page);
      await shot(page, `mu-${device}-${theme}-machines`);
      await page.getByRole('listitem', { name: 'X1' }).getByRole('button', { name: 'Отключить' }).click();
      await noHScroll(page);
      await page.getByRole('button', { name: 'Пользователи' }).click();
      await expect(page.getByText('2 машины, 1 в сети')).toBeVisible();
      await page.getByLabel('Почта').fill('bob@example.com');
      await page.getByRole('button', { name: 'Пригласить' }).click();
      await expect(page.getByText(/invite\/k3j5/)).toBeVisible();
      await noHScroll(page);
      await shot(page, `mu-${device}-${theme}-users`);
      await page.getByRole('button', { name: 'Безопасность' }).click();
      await expect(page.getByText(/Подключена машина/)).toBeVisible();
      await noHScroll(page);
      await shot(page, `mu-${device}-${theme}-security`);
    });
  }
}
