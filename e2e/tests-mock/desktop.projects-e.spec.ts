import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { MockHub } from '../mock/hub.js';

for (const theme of ['light', 'dark'])
  for (const [width, height] of [
    [1280, 900],
    [360, 640],
    [390, 844],
  ] as const) {
    test(`project management ${theme} ${width}x${height}`, async ({ page }) => {
      test.setTimeout(90000);
      await page.setViewportSize({ width, height });
      await page.addInitScript(value => localStorage.setItem('ah-theme', value), theme);
      const hub = new MockHub({ tabs: [] });
      const refs = [
        { id: '00000000-0000-4000-8000-000000000901', title: 'Agent Hub', colorKey: 'scanner', path: '' },
        { id: '00000000-0000-4000-8000-000000000902', title: 'Research', colorKey: 'rose', path: '' },
      ];
      let n = 0;
      for (const s of hub.sessions.values()) s.project = refs[n++ % 2]!;
      const projects = refs.map(p => ({
        id: p.id,
        name: p.title,
        colorKey: p.colorKey,
        description: 'Project notes',
        remote: null,
        archived: false,
        lastEventAt: null,
        bindings: [{ runnerId: 'hp', path: 'C:\\Users\\Alice\\work' }],
      }));
      const automatic = { id: '00000000-0000-4000-8000-000000000903', title: 'Автогруппа', colorKey: 'tools', path: '/auto' };
      const automaticSession = [...hub.sessions.values()][0]!;
      automaticSession.project = automatic;
      let hidden = false;
      await hub.install(page);
      await page.route('**/api/projects/hidden', route => route.fulfill({ json: hidden ? [automatic] : [] }));
      await page.route(`**/api/projects/${automatic.id}/hidden`, async route => {
        hidden = route.request().method() === 'PUT';
        automaticSession.project = hidden ? { id: null, title: 'Без проекта', colorKey: 'none', path: '' } : automatic;
        await route.fulfill({ json: { ok: true } });
      });
      await page.route(`**/api/projects/${automatic.id}/color`, async route => {
        automatic.colorKey = route.request().postDataJSON().colorKey;
        await route.fulfill({ json: { ok: true } });
      });
      await page.route('**/api/catalog/projects**', async route => {
        const url = new URL(route.request().url());
        const method = route.request().method();
        const id = url.pathname.split('/')[4];
        const p = projects.find(x => x.id === id);
        if (method === 'PATCH' && p) {
          const body = route.request().postDataJSON();
          if (body.bindings?.some((binding: { path: string | null }) => binding.path === 'relative')) {
            await route.fulfill({ status: 400, json: { error: 'invalid_request' } });
            return;
          }
          Object.assign(p, route.request().postDataJSON());
          for (const s of hub.sessions.values()) if (s.project.id === p.id) s.project = { id: p.id, title: p.name, colorKey: p.colorKey, path: '' };
        }
        if (method === 'DELETE' && p && !url.pathname.includes('/bindings/')) {
          for (const s of hub.sessions.values()) if (s.project.id === p.id) s.project = { id: null, title: 'Без проекта', colorKey: 'none', path: '' };
          projects.splice(projects.indexOf(p), 1);
        }
        await route.fulfill({ json: method === 'GET' ? projects : { ok: true } });
      });
      await page.route('**/api/runners/*/directories*', route => route.fulfill({ json: { path: 'C:\\Users\\Alice\\work', parent: 'C:\\Users\\Alice', directories: [] } }));
      await page.goto('/');
      await expect(page.getByRole('button', { name: 'Действия проекта Agent Hub', exact: true })).toBeVisible();
      const shots = process.env.SHOTS_DIR ?? '../.tmp/e/ui';
      mkdirSync(shots, { recursive: true });
      const prefix = `${shots}/${width}-${theme}`;
      await page.screenshot({ path: `${prefix}-sidebar.png` });
      await page.getByRole('button', { name: 'Действия проекта Автогруппа', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Скрыть группу' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.getByRole('button', { name: 'Отменить', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Действия проекта Автогруппа', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Действия проекта Автогруппа', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Скрыть группу' }).click();
      await expect(page.getByRole('button', { name: 'Действия проекта Автогруппа', exact: true })).toHaveCount(0);
      await page.reload();
      await page.getByRole('button', { name: 'Профиль', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Показать скрытые' }).click();
      const hiddenDialog = page.getByRole('dialog', { name: 'Скрытые группы' });
      await hiddenDialog.getByRole('button', { name: 'Вернуть Автогруппа' }).click();
      await expect(hiddenDialog).toContainText('Скрытых групп нет');
      await hiddenDialog.getByRole('button', { name: 'Закрыть' }).click();
      await expect(page.getByRole('button', { name: 'Действия проекта Автогруппа', exact: true })).toBeVisible();
      const before = hub.sessions.size;
      await page.getByRole('button', { name: 'Действия проекта Agent Hub', exact: true }).click();
      await page.screenshot({ path: `${prefix}-menu.png` });
      await page.getByRole('radio', { name: 'Стальной' }).click();
      await expect(page.getByRole('menu')).toHaveCount(0);
      await expect.poll(() => projects[0]!.colorKey).toBe('slate');
      await page.getByRole('button', { name: 'Действия проекта Agent Hub', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Изменить проект' }).click();
      const edit = page.getByRole('dialog', { name: 'Изменить проект' });
      await expect(edit.getByRole('radio')).toHaveCount(12);
      for (const swatch of await edit.getByRole('radio').all()) {
        const rect = await swatch.boundingBox();
        expect(rect!.width).toBeGreaterThanOrEqual(40);
        expect(rect!.height).toBeGreaterThanOrEqual(40);
      }
      await edit.getByLabel('Название', { exact: true }).fill('');
      await edit.getByRole('button', { name: 'Сохранить', exact: true }).click();
      await expect(edit.getByLabel('Название', { exact: true })).toHaveAttribute('aria-invalid', 'true');
      await expect(edit.getByRole('alert')).toContainText('Введите название');
      await page.screenshot({ path: `${prefix}-error.png` });
      await edit.getByLabel('Название', { exact: true }).fill('Agent Hub');
      const machinePath = edit.locator('.project-binding input').first();
      await machinePath.fill('relative');
      await edit.getByRole('button', { name: 'Сохранить', exact: true }).click();
      await expect(machinePath).toHaveAttribute('aria-invalid', 'true');
      await expect(edit.getByRole('alert')).toContainText('Проверьте название и абсолютные пути');
      const errorBox = await edit.getByRole('alert').boundingBox();
      expect(errorBox!.y + errorBox!.height).toBeLessThanOrEqual(height - 16);
      await page.screenshot({ path: `${prefix}-binding-error.png` });
      await edit.getByRole('button', { name: 'Отмена' }).click();
      await page.getByRole('button', { name: 'Действия проекта Agent Hub', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Изменить проект' }).click();
      await expect(edit.getByLabel('Название', { exact: true })).toBeFocused();

      await expect(edit.getByLabel('Название', { exact: true })).toBeFocused();
      expect(await edit.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      const head = await edit.locator('.modal-head').boundingBox();
      const close = await edit.getByRole('button', { name: 'Закрыть' }).boundingBox();
      expect(close!.x).toBeGreaterThan(head!.x + head!.width / 2);
      expect(close!.y).toBeLessThan(head!.y + head!.height);
      await page.screenshot({ path: `${prefix}-edit.png` });
      await edit.getByRole('button', { name: 'Выбрать…' }).first().click();
      const picker = page.locator('.folder-picker');
      await expect(picker).toBeVisible();
      expect(
        await picker
          .locator('.folder-crumbs button')
          .first()
          .evaluate(el => getComputedStyle(el).flexShrink),
      ).toBe('0');
      await expect(picker.getByRole('button', { name: 'Закрыть' })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(picker).toHaveCount(0);
      await expect(edit).toBeVisible();
      await edit.getByRole('radio', { name: 'Песочный' }).click();
      await expect(edit.getByRole('radio', { name: 'Песочный' })).toHaveAttribute('aria-checked', 'true');
      await edit.getByLabel('Название', { exact: true }).fill('Hub renamed');
      await edit.getByRole('button', { name: 'Убрать привязку hp' }).click();
      await edit.getByRole('button', { name: 'Сохранить', exact: true }).click();
      await expect(edit).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Действия проекта Hub renamed', exact: true })).toBeVisible();
      await page.reload();
      await page.getByRole('button', { name: 'Действия проекта Hub renamed', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Удалить проект' }).click();
      const confirm = page.getByRole('dialog', { name: 'Удалить проект' });
      await expect(confirm).toContainText('транскрипты сохранятся');
      await expect(confirm.getByRole('button', { name: 'Отмена' })).toBeFocused();
      await page.screenshot({ path: `${prefix}-delete.png` });
      await confirm.getByRole('button', { name: 'Отмена' }).click();
      expect(hub.sessions.size).toBe(before);
      expect(projects).toHaveLength(2);
      await page.getByRole('button', { name: 'Действия проекта Hub renamed', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Удалить проект' }).click();
      await confirm.getByRole('button', { name: 'Удалить проект', exact: true }).click();
      await expect(confirm).toHaveCount(0);
      await expect(page.locator('#sidebar-projects-heading')).toBeFocused();
      expect(hub.sessions.size).toBe(before);
      expect(projects).toHaveLength(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }
