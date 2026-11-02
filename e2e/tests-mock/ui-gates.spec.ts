// UI review 2.15: automatic gates over the layouts the reviewer checked by eye, against the in-memory hub.
// Layouts: 1, 2 and 3 panes and a 20% pane on 1440×900; the phone (390×844); dark and light themes.
// Gates: (1) no child of .messages is squeezed (offsetHeight ≥ scrollHeight); (2) on 390 px dialogs end inside the
// screen; (3) no horizontal page scroll; (4) text contrast ≥ 4.5:1 (axe-core color-contrast); (5) one control height
// in .chat-head and in dialogs; (6) on the phone interactive elements are ≥ 40 px; (7) Tab does not leave an open
// dialog; (8) the active tab shows ≥ 6 characters of its title; (9) area colours of the projects (M4a) in both themes.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { MockHub } from '../mock/hub.js';
import { makePng } from '../mock/images.js';

const id = MockHub.id;
type Json = Record<string, unknown>;
const pane = (pid: string, tabs: number[], active = tabs[0]!) => ({ id: pid, tabs: tabs.map(id), active: id(active) });
const leaf = (pid: string) => ({ type: 'leaf', pane: pid });

/** Desktop layouts: session 1 has a real transcript (collapsed tool rows), 6 is asleep, 5 is on an offline machine. */
const LAYOUTS: Record<string, Json> = {
  one: { layout: leaf('p1'), panes: { p1: pane('p1', [1, 3, 4, 6]) }, focus: 'p1', seq: 1 },
  two: { layout: { type: 'split', dir: 'row', ratio: 0.5, a: leaf('p1'), b: leaf('p2') }, panes: { p1: pane('p1', [1, 4]), p2: pane('p2', [6, 3]) }, focus: 'p1', seq: 2 },
  three: {
    layout: { type: 'split', dir: 'row', ratio: 0.5, a: leaf('p1'), b: { type: 'split', dir: 'col', ratio: 0.5, a: leaf('p2'), b: leaf('p3') } },
    panes: { p1: pane('p1', [1, 4]), p2: pane('p2', [3]), p3: pane('p3', [5, 6]) },
    focus: 'p2',
    seq: 3,
  },
  narrow: { layout: { type: 'split', dir: 'row', ratio: 0.2, a: leaf('p1'), b: leaf('p2') }, panes: { p1: pane('p1', [1, 6], 1), p2: pane('p2', [3, 4]) }, focus: 'p1', seq: 2 },
};

async function open(page: Page, theme: 'dark' | 'light', layout?: Json) {
  await page.addInitScript(t => localStorage.setItem('ah-theme', t), theme);
  const hub = new MockHub({ tabs: [1, 3, 4, 6], projects: true });
  if (layout) hub.layouts.desktop = { layout, savedLayout: null, openedAt: null, updatedAt: null, clientTs: null };
  await hub.install(page);
  await page.goto('/');
  await expect(page.getByRole('list', { name: 'Машины' })).toBeVisible();
  // fonts and the first render settle; animations would only add noise to the contrast check
  await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
  await page.waitForTimeout(300);
  return hub;
}

async function gateMessages(page: Page) {
  const squeezed = await page
    .locator('.messages')
    .evaluateAll(boxes =>
      boxes.flatMap(box => [...box.children].filter(c => (c as HTMLElement).offsetHeight + 1 < c.scrollHeight).map(c => `${c.className}: ${(c as HTMLElement).offsetHeight} < ${c.scrollHeight}`)),
    );
  expect(squeezed, 'children of .messages squeezed').toEqual([]);
}

async function gateNoHScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 'horizontal page scroll').toBeLessThanOrEqual(0);
}

async function gateContrast(page: Page, label: string) {
  const r = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
  const bad = r.violations.flatMap(v => v.nodes.map(n => `${n.target.join(' ')} — ${n.any[0]?.message ?? ''}`));
  expect(bad, `contrast (${label})`).toEqual([]);
}

/**
 * (9) Area colours (4.8, D9 p. 8), all ten keys, in the current theme: the square of a project ≥ 3:1 against the left
 * panel and the chat (a UI mark), the project name on its tinted pill (`.pill.gp`: 62% colour + 38% text over 16%
 * colour + 84% surface) ≥ 4.5:1.
 */
async function gateProjectColors(page: Page, theme: string) {
  const bad = await page.evaluate(() => {
    const KEYS = ['scanner', 'platform', 'customers', 'support', 'infra', 'tools', 'org', 'ext', 'personal', 'none'];
    const rgb = (css: string): number[] => {
      const probe = document.createElement('i');
      probe.style.color = css;
      document.body.append(probe);
      const m = getComputedStyle(probe)
        .color.match(/[\d.]+/g)!
        .map(Number);
      probe.remove();
      return m.slice(0, 3);
    };
    const mix = (a: number[], b: number[], t: number) => a.map((x, i) => x * t + b[i]! * (1 - t));
    const lum = (c: number[]) => {
      const [r, g, b] = c.map(v => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const ratio = (a: number[], b: number[]) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x! + 0.05) / (y! + 0.05);
    };
    const side = rgb(getComputedStyle(document.querySelector('.side')!).backgroundColor);
    const surface = rgb('var(--surface)');
    const fg = rgb('var(--fg)');
    const out: string[] = [];
    for (const k of KEYS) {
      const c = rgb(`var(--g-${k})`);
      for (const [name, bg] of [
        ['side', side],
        ['surface', surface],
      ] as const)
        if (ratio(c, bg) < 3) out.push(`--g-${k} on ${name}: ${ratio(c, bg).toFixed(2)}`);
      const text = mix(c, fg, 0.62);
      const pill = mix(c, surface, 0.16);
      if (ratio(text, pill) < 4.5) out.push(`pill ${k}: ${ratio(text, pill).toFixed(2)}`);
    }
    return out;
  });
  expect(bad, `area colours (${theme})`).toEqual([]);
}

async function gateControlHeights(page: Page, scope: string) {
  const groups = await page
    .locator(scope)
    .evaluateAll(roots =>
      roots.map(root =>
        [...root.querySelectorAll<HTMLElement>('button.btn, select, input:not([type="checkbox"]):not([type="radio"])')]
          .filter(el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden')
          .map(el => `${Math.round(el.getBoundingClientRect().height)}:${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 12)}`),
      ),
    );
  for (const g of groups) {
    const heights = new Set(g.map(x => x.split(':')[0]));
    expect(heights.size, `one control height in ${scope}: ${g.join(', ')}`).toBeLessThanOrEqual(1);
  }
}

async function gateActiveTabTitle(page: Page) {
  const short = await page.locator('.tab.active').evaluateAll(tabs =>
    tabs.flatMap(tab => {
      const title = tab.querySelector<HTMLElement>('.t-title');
      const text = title?.firstChild;
      if (!title || !text || (text.textContent ?? '').length < 6) return [];
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 6);
      const need = range.getBoundingClientRect().width;
      const t = title.getBoundingClientRect();
      const close = tab.querySelector<HTMLElement>('.t-close');
      const c = close && getComputedStyle(close).opacity !== '0' ? close.getBoundingClientRect() : null;
      const right = c && c.left < t.right ? Math.min(t.right, c.left - 6) : t.right;
      // the ellipsis takes about one character
      return right - t.left - 8 >= need ? [] : [`${title.textContent}: ${Math.round(right - t.left)} px < ${Math.round(need)} px`];
    }),
  );
  expect(short, 'active tab shows ≥ 6 characters').toEqual([]);
}

async function gateDialogFocus(page: Page, dialog: string) {
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press(key);
      const inside = await page.evaluate(sel => !!document.querySelector(sel)?.contains(document.activeElement), dialog);
      expect(inside, `${key} #${i + 1} stays in ${dialog}`).toBe(true);
    }
  }
}

async function gateDialogInside(page: Page, dialog: string) {
  const right = await page.locator(dialog).evaluate(el => el.getBoundingClientRect().right - window.innerWidth);
  expect(right, `${dialog} ends inside the screen`).toBeLessThanOrEqual(0);
}

async function gateTargets(page: Page, label: string) {
  const small = await page.evaluate(() => {
    const sel = 'button, a[href], select, input, textarea, summary, [role="tab"], [tabindex="0"]';
    return [...document.querySelectorAll<HTMLElement>(sel)]
      .filter(el => {
        if ((el as HTMLButtonElement).disabled || el.closest('[inert], .bubble')) return false;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || r.bottom < 0 || r.top > window.innerHeight) return false;
        const cs = getComputedStyle(el);
        return cs.visibility !== 'hidden' && cs.display !== 'none';
      })
      .map(el => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.height < 39.5 || r.width < 39.5)
      .map(
        ({ el, r }) => `${el.tagName.toLowerCase()}.${el.className} «${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 24)}» ${Math.round(r.width)}×${Math.round(r.height)}`,
      );
  });
  expect(small, `touch targets ≥ 40 px (${label})`).toEqual([]);
}

for (const theme of ['dark', 'light'] as const) {
  test.describe(`desktop, ${theme}`, () => {
    test.skip(({ isMobile }) => isMobile, 'desktop gates');
    for (const [name, layout] of Object.entries(LAYOUTS)) {
      test(`${name}: messages, scroll, contrast, control height, active tab`, async ({ page }) => {
        await open(page, theme, layout);
        await expect(page.locator('section.leaf')).toHaveCount(Object.keys(layout.panes as Json).length);
        await expect(page.locator('details.tool').first()).toBeVisible();
        if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/gates-${name}-${theme}.png` });
        await gateMessages(page);
        await gateNoHScroll(page);
        await gateControlHeights(page, '.chat-head');
        await gateActiveTabTitle(page);
        await gateContrast(page, `${name} ${theme}`);
        if (name === 'one') await gateProjectColors(page, theme);
      });
    }

    test('dialogs: «Новая сессия» and Ctrl+K — focus stays inside, contrast, control height', async ({ page }) => {
      await open(page, theme);
      await page.getByRole('button', { name: 'Новая сессия' }).click();
      await expect(page.getByRole('dialog', { name: 'Новая сессия' })).toBeVisible();
      await gateControlHeights(page, '.modal');
      await gateContrast(page, `new session ${theme}`);
      await gateDialogFocus(page, '.modal');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.keyboard.press('Control+k');
      await expect(page.getByRole('dialog', { name: 'Быстрый переход' })).toBeVisible();
      await gateContrast(page, `quick search ${theme}`);
      await gateDialogFocus(page, '.qs');
      // a hit by the text of a reply: the fragment and its highlight (3.9)
      await page.getByRole('combobox', { name: 'Сессия или проект' }).fill('ретрай');
      await expect(page.locator('.qs-snippet mark')).toHaveText('ретрай');
      await gateContrast(page, `quick search fragment ${theme}`);
    });
  });

  test.describe(`phone, ${theme}`, () => {
    test.skip(({ isMobile }) => !isMobile, 'phone gates');
    test('list, chat, dialogs: targets, scroll, contrast, dialogs inside the screen', async ({ page }) => {
      await open(page, theme);
      await gateNoHScroll(page);
      await gateTargets(page, 'list');
      await gateContrast(page, `phone list ${theme}`);
      // the tree by projects (M4a): every area colour is on screen for the contrast gate, then 05-agent-hub opens
      const hubProject = page.locator('.prow', { hasText: '05-agent-hub' });
      if ((await hubProject.getAttribute('aria-expanded')) !== 'true') await hubProject.click();
      await page.locator('.side-scroll .srow', { hasText: 'GUI-прототип' }).first().click();
      await expect(page.locator('details.tool').first()).toBeVisible();
      if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/gates-phone-chat-${theme}.png` });
      await gateMessages(page);
      await gateNoHScroll(page);
      await gateTargets(page, 'chat');
      await gateContrast(page, `phone chat ${theme}`);
      await page.getByRole('button', { name: 'К списку' }).click();
      await page.getByRole('button', { name: 'Новая сессия' }).click();
      await expect(page.getByRole('dialog', { name: 'Новая сессия' })).toBeVisible();
      if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/gates-phone-new-${theme}.png` });
      await gateDialogInside(page, '.modal');
      await gateNoHScroll(page);
      await gateTargets(page, 'new session');
      await gateControlHeights(page, '.modal');
      await gateDialogFocus(page, '.modal');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: /Найти сессию/ }).click();
      await expect(page.getByRole('dialog', { name: 'Быстрый переход' })).toBeVisible();
      await gateDialogInside(page, '.qs');
      await gateNoHScroll(page);
      await gateDialogFocus(page, '.qs');
      await page.getByRole('combobox', { name: 'Сессия или проект' }).fill('ретрай');
      await expect(page.locator('.qs-snippet mark')).toHaveText('ретрай');
      await gateDialogInside(page, '.qs');
      await gateNoHScroll(page);
      await gateTargets(page, 'quick search');
      await gateContrast(page, `phone quick search ${theme}`);
    });
  });
}

// Image previews are never cut (bug from Ivan, M4a: the preview under «Read …png» cut at the bottom with the feed at
// the end). On 1440×900 and 390×844: every preview, brought into view, is visible over its whole box — no ancestor
// clips it and the corners hit the picture; a late image with the feed at the bottom leaves the feed at the bottom.
test.describe('gate 10: image previews', () => {
  const openShots = async (page: Page, blobDelayMs = 0) => {
    const hub = new MockHub({ tabs: [9], blobDelayMs });
    await hub.install(page);
    await page.goto(`/s/${MockHub.id(9)}`);
    await expect(page.locator('.tool-imgs .img-open').first()).toBeVisible();
    // web fonts (display=swap) change line heights when they arrive and move everything below: settle them first
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    return hub;
  };
  const atBottom = (page: Page) => page.locator('.messages').evaluate(m => m.scrollHeight - m.scrollTop - m.clientHeight < 2);
  const uncut = (page: Page, img: import('@playwright/test').Locator) =>
    img.evaluate(el => {
      const r = el.getBoundingClientRect();
      const bad: string[] = [];
      if (r.width < 8 || r.height < 8) bad.push(`tiny ${r.width}×${r.height}`);
      for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.overflow === 'visible' && cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
        const b = a.getBoundingClientRect();
        if (r.top < b.top - 1 || r.bottom > b.bottom + 1 || r.left < b.left - 1 || r.right > b.right + 1)
          bad.push(
            `${a.tagName}.${a.className} clips [${el.closest('.msg, .tool-wrap')?.className} ${(el as HTMLImageElement).src.slice(-12)} nh=${(el as HTMLImageElement).naturalHeight} st=${document.querySelector('.messages')!.scrollTop}/${document.querySelector('.messages')!.scrollHeight}] ${Math.round(r.top)}-${Math.round(r.bottom)} in ${Math.round(b.top)}-${Math.round(b.bottom)}`,
          );
      }
      for (const [x, y] of [
        [r.left + 3, r.top + 3],
        [r.right - 3, r.top + 3],
        [r.left + 3, r.bottom - 3],
        [r.right - 3, r.bottom - 3],
      ]) {
        const hit = document.elementFromPoint(x!, y!);
        if (!hit || !(hit === el || el.parentElement!.contains(hit))) bad.push(`corner ${Math.round(x!)},${Math.round(y!)} → ${hit?.tagName}.${hit?.className}`);
      }
      return bad;
    });

  test('every preview is visible whole after scrolling to the bottom', async ({ page }) => {
    await openShots(page);
    await page.locator('.messages').evaluate(m => (m.scrollTop = m.scrollHeight));
    const imgs = page.locator('.messages .img-prev img');
    await expect(imgs).not.toHaveCount(0);
    for (const img of await imgs.all()) {
      await img.evaluate(el => el.scrollIntoView({ block: 'nearest' }));
      await expect.poll(() => img.evaluate(el => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0)).toBe(true);
      // the box must not change on load: what was brought into view stays in view
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      expect(await uncut(page, img)).toEqual([]);
    }
  });

  test('a late image with the feed at the bottom: after it loads the feed is at the bottom and the picture is whole', async ({ page }) => {
    const hub = await openShots(page, 1500);
    const m = page.locator('.messages');
    await m.evaluate(el => (el.scrollTop = el.scrollHeight));
    await expect.poll(() => atBottom(page)).toBe(true);
    const s = hub.session(9);
    const src = hub.addImage(makePng(560, 560, [235, 235, 230]));
    hub.push({
      type: 'session.events',
      sessionId: s.id,
      events: [
        {
          kind: 'line',
          id: 'l:9:0:90',
          ts: new Date().toISOString(),
          line: {
            type: 'assistant',
            uuid: 'a9-90',
            message: { id: 'm9-90', role: 'assistant', content: [{ type: 'tool_use', id: 'tu90', name: 'Read', input: { file_path: 'C:\vault\react-solid-light.png' } }] },
          },
        },
        {
          kind: 'line',
          id: 'l:9:0:91',
          ts: new Date().toISOString(),
          line: { type: 'user', uuid: 'u9-91', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu90', content: [{ type: 'image', source: src }] }] } },
        },
      ],
    });
    const img = page.locator('.tool-wrap', { hasText: 'react-solid-light.png' }).locator('img');
    await expect(img).toBeAttached();
    // the place is reserved before the bytes arrive
    const before = (await img.boundingBox())!;
    await expect.poll(() => img.evaluate(el => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0), { timeout: 10_000 }).toBe(true);
    await expect(page.locator('.tool-wrap', { hasText: 'react-solid-light.png' }).locator('.img-open.loaded')).toBeVisible();
    const after = (await img.boundingBox())!;
    expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1);
    expect(Math.round(after.height)).toBe(Math.round(after.width));
    await expect.poll(() => atBottom(page)).toBe(true);
    expect(await uncut(page, img)).toEqual([]);
  });
});

// Gate 11: the feed keeps to the bottom while typing and sending (bug from Ivan, M4b: the last message under the
// composer). On 1440×900 and 390×844: a multi-line draft grows the field, the feed stays at the bottom; a sent message
// («доставляется…» and then its line) is whole above the composer.
test('gate 11: typing and sending keep the feed at the bottom', async ({ page }) => {
  const hub = new MockHub({ tabs: [1] });
  hub.lineDelayMs = 600;
  await hub.install(page);
  await page.goto(`/s/${MockHub.id(1)}`);
  const feed = page.locator('.messages').last();
  await expect(feed).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const atBottom = () => feed.evaluate(m => m.scrollHeight - m.scrollTop - m.clientHeight <= 2);
  const lastWhole = () =>
    feed.evaluate(m => {
      const items = m.querySelectorAll('.msg, .tool-wrap, details.tool, .sysnote, .thinking');
      return items[items.length - 1]!.getBoundingClientRect().bottom <= m.getBoundingClientRect().bottom + 1;
    });
  await expect.poll(atBottom).toBe(true);
  const box = page.getByRole('textbox', { name: 'Сообщение' });
  await box.click();
  for (let i = 0; i < 6; i++) {
    await page.keyboard.type(`строка ${i + 1}`);
    await page.keyboard.press('Shift+Enter');
  }
  await expect.poll(atBottom).toBe(true);
  expect(await lastWhole()).toBe(true);
  await page.keyboard.press('Enter');
  await expect(feed.locator('.msg.user.pending')).toBeVisible();
  await expect.poll(atBottom).toBe(true);
  expect(await lastWhole()).toBe(true);
  await expect(feed.getByText(/Принято: «строка 1/)).toBeVisible();
  await expect.poll(atBottom).toBe(true);
  expect(await lastWhole()).toBe(true);
});

// Gate 12 (change `subagents`): the list of subagents and a subagent's chat in both themes — contrast, no horizontal
// scroll; on the phone the sheet's rows and every control ≥ 40 px.
for (const theme of ['dark', 'light'] as const) {
  test(`gate 12: subagents list and chat (${theme})`, async ({ page, isMobile }) => {
    await page.addInitScript(t => localStorage.setItem('ah-theme', t), theme);
    const hub = new MockHub({ tabs: [1], subagents: true });
    await hub.install(page);
    await page.goto(`/s/${MockHub.id(1)}`);
    await expect(page.getByRole('button', { name: /Субагенты 4/ }).first()).toBeVisible();
    await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
    await page
      .getByRole('button', { name: /Субагенты 4/ })
      .first()
      .click();
    const list = page.getByRole('dialog', { name: 'Субагенты сессии' });
    await expect(list.locator('.sub-row')).toHaveCount(4);
    await gateContrast(page, `subagents list ${theme}`);
    await gateNoHScroll(page);
    if (isMobile) await gateTargets(page, 'subagents sheet');
    await list.locator('.sub-row', { hasText: 'Phase 3 Dev M1' }).click();
    await expect(page.getByText('Каркас собран, хаб поднят.')).toBeVisible();
    await gateContrast(page, `subagent chat ${theme}`);
    await gateNoHScroll(page);
  });
}

// Gate 13 (QA subagents 1): the phone chat of a session with a second project and 24 subagents — the info line and the
// «Субагенты» button stay inside 390 px, before and after the sheet opens; the button shows «24 · N».
for (const theme of ['dark', 'light'] as const) {
  test(`gate 13: phone info line with many subagents (${theme})`, async ({ page, isMobile }) => {
    test.skip(!isMobile, 'phone gate');
    await page.addInitScript(t => localStorage.setItem('ah-theme', t), theme);
    const hub = new MockHub({ tabs: [1], subagents: true, projects: true });
    const base = [...hub.subRows.values()][1]!;
    for (let i = 0; i < 20; i++) {
      hub.upsertSubagent({
        ...base,
        id: `00000000-0000-4000-b000-${String(i).padStart(12, '0')}`,
        agentId: `aextra${i}`,
        toolUseId: `tu-x${i}`,
        description: `Доп. субагент ${i}`,
        status: i < 6 ? 'running' : 'completed',
      });
    }
    await hub.install(page);
    await page.goto(`/s/${MockHub.id(1)}`);
    const btn = page.locator('.phone-info').getByRole('button', { name: /Субагенты 24/ });
    await expect(btn).toBeVisible();
    await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
    const right = await btn.evaluate(e => e.getBoundingClientRect().right);
    expect(right, 'the button inside the screen').toBeLessThanOrEqual(390);
    await gateNoHScroll(page);
    if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/gate13-phone-chat-${theme}.png` });
    // what is seen (the words are for screen readers only)
    const seen = () =>
      btn.evaluate(e => {
        const c = e.cloneNode(true) as HTMLElement;
        c.querySelectorAll('.sr-only').forEach(x => x.remove());
        return c.textContent?.trim();
      });
    await expect.poll(seen).toBe('24 · 7');
    await btn.click();
    await expect(page.getByRole('dialog', { name: 'Субагенты сессии' }).locator('.sub-row')).toHaveCount(24);
    await gateNoHScroll(page);
    const left = await page.getByRole('dialog', { name: 'Субагенты сессии' }).evaluate(e => e.getBoundingClientRect().left);
    expect(left, 'the sheet is not shifted').toBeGreaterThanOrEqual(0);
    if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/gate13-phone-sheet-${theme}.png` });
  });
}
