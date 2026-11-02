// Shared checks of the subscriptions UI review fixes (change claude-subscriptions, task 6.6), for the desktop and the
// phone specs: menus inside the viewport and above the composer, a dialog button that is really on top, the contrast
// of the tinted pills measured by the browser itself.
import { expect, type Locator, type Page } from '@playwright/test';

/** C2: every item of `menu` is inside the viewport and above the top edge of the visible composer. */
export async function menuAboveComposer(page: Page, menu: Locator) {
  const composer = page.locator('.composer:visible').first();
  const top = (await composer.boundingBox())!.y;
  const vh = page.viewportSize()!.height;
  const vw = page.viewportSize()!.width;
  const items = await menu.getByRole('menuitem').all();
  expect(items.length).toBeGreaterThan(0);
  for (const it of items) {
    const b = (await it.boundingBox())!;
    expect(b.y, 'menu item below the top of the viewport').toBeGreaterThanOrEqual(0);
    expect(b.y + b.height, 'menu item above the composer').toBeLessThanOrEqual(top + 0.5);
    expect(b.y + b.height).toBeLessThanOrEqual(vh);
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(vw + 0.5);
  }
}

/** C1: the element at the centre of `btn` is `btn` itself (nothing — a menu, a scrim — lies over it). */
export async function onTop(page: Page, btn: Locator) {
  const b = (await btn.boundingBox())!;
  const hit = await btn.evaluate(
    (el, p) => {
      const at = document.elementFromPoint(p.x, p.y);
      return !!at && (at === el || el.contains(at));
    },
    { x: b.x + b.width / 2, y: b.y + b.height / 2 },
  );
  expect(hit, 'the button is the element at its own centre').toBe(true);
}

/**
 * M11: contrast of the text of `pill` on its own background composited over the background behind it, measured by
 * drawing the computed colours on a canvas (any CSS colour syntax, color-mix included).
 */
export async function pillContrast(pill: Locator): Promise<number> {
  return pill.evaluate(el => {
    const behind = (n: Element | null): string => {
      for (let p = n; p; p = p.parentElement) {
        const c = getComputedStyle(p).backgroundColor;
        if (c && c !== 'transparent' && !/rgba\(0, 0, 0, 0\)/.test(c)) return c;
      }
      return getComputedStyle(document.body).backgroundColor;
    };
    const cv = document.createElement('canvas');
    cv.width = cv.height = 1;
    const ctx = cv.getContext('2d', { willReadFrequently: true })!;
    const paint = (...layers: string[]) => {
      ctx.clearRect(0, 0, 1, 1);
      for (const l of layers) {
        ctx.fillStyle = l;
        ctx.fillRect(0, 0, 1, 1);
      }
      return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
    };
    const base = behind(el.parentElement);
    const bg = paint(base, getComputedStyle(el).backgroundColor);
    const fg = paint(base, getComputedStyle(el).backgroundColor, getComputedStyle(el).color);
    const lum = (c: number[]) => {
      const [r, g, b] = c.map(v => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const [x, y] = [lum(fg), lum(bg)].sort((p, q) => q - p);
    return (x! + 0.05) / (y! + 0.05);
  });
}

/**
 * claude-subscriptions P12: «Настройки → <section>» through the profile menu «⋯» (the only entry, no «⚙»); returns the
 * settings screen.
 */
export async function openSettingsSection(page: Page, section: 'Подписки' | 'Расход') {
  await page.getByRole('button', { name: 'Профиль' }).click();
  await page.getByRole('menu', { name: 'Профиль' }).getByRole('menuitem', { name: section }).click();
  const set = page.getByRole('region', { name: 'Настройки' });
  await expect(set.getByRole('heading', { level: 2, name: section })).toBeVisible();
  await expect(page).toHaveURL(section === 'Подписки' ? /\/settings\/subscriptions$/ : /\/settings\/usage$/);
  return set;
}

/** A section of the settings navigation. */
export async function settingsNav(page: Page, section: string) {
  await page.getByRole('navigation', { name: 'Разделы настроек' }).getByRole('button', { name: section }).click();
}
