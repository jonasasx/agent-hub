// QA 8.1 (change subscription-limits, Requirement «Строка подписки»): a row is one line — a long subscription name, a
// long right side or «обновите агента на …» with several machines never push past the row or the left panel.
import { expect, type Page } from '@playwright/test';
import { MockHub } from '../mock/hub.js';
import { mockWindow } from '../mock/limits.js';

/** 30-character names: the longest the row has to hold. */
export const LONG_NAMES = ['Max личная · основная подписка', 'Pro рабочая · резерв на вечера', 'Team рабочая · общая для групп'] as const;
/** A window type the UI has no text for (the service added a new limit). */
export const LONG_WINDOW = 'seven_day_claude_code_extended_usage';
export const OUTDATED_MACHINES = ['X1-Carbon-Gen13', 'HP-Elitebook', 'vault'];

/**
 * Three subscriptions with 30-character names: the first — «нет данных» agent_outdated with three online machines on
 * an old agent, the second — «почти · 7 дн · 96% · <date>», the third — «близко · <unknown long window key> · 88% · <date>».
 */
export function longLimitsHub() {
  const hub = new MockHub({ tabs: [1], subscriptions: true, limits: true });
  const reg = hub.subReg!;
  const lim = hub.limReg!;
  const [a, b] = reg.list;
  a!.name = LONG_NAMES[0];
  b!.name = LONG_NAMES[1];
  const c = reg.add(LONG_NAMES[2]);
  lim.set(a!.id, { state: 'unavailable', reason: 'agent_outdated', windows: [], lastOkAt: null });
  lim.set(b!.id, { state: 'ok', reason: null, windows: [mockWindow('seven_day', 96, 5 * 1440 + 17, 'allowed_warning')], lastOkAt: new Date().toISOString() });
  // an unknown window: the row shows its raw key, so the right side is long even without machine names
  lim.set(c.id, { state: 'ok', reason: null, windows: [mockWindow(LONG_WINDOW, 88, 3 * 1440, 'allowed_warning')], lastOkAt: new Date().toISOString() });
  hub.runnerPatch = {
    x1: { name: OUTDATED_MACHINES[0], protocolVersion: '1.5' },
    hp: { name: OUTDATED_MACHINES[1], protocolVersion: '1.5', online: true },
    vm: { name: OUTDATED_MACHINES[2], protocolVersion: '1.5' },
  };
  return hub;
}

/**
 * Every `.lim-row` of the block fits (scrollWidth ≤ clientWidth + 1) inside the panel; its name and right side fit or
 * are cut by an ellipsis inside their own box, and end inside the row.
 */
export async function limitRowsFit(page: Page, expectRows: number) {
  const rows = page.getByRole('region', { name: 'Лимиты подписок' }).locator('.lim-row');
  await expect(rows).toHaveCount(expectRows);
  const side = (await page.locator('aside.side').boundingBox())!;
  for (const r of await rows.all()) {
    const what = await r.getAttribute('aria-label');
    // the row itself never scrolls
    const [sw, cw] = await r.evaluate(e => [e.scrollWidth, e.clientWidth]);
    expect(sw, `${what}: row ${sw} > ${cw}`).toBeLessThanOrEqual(cw + 1);
    const box = (await r.boundingBox())!;
    for (const el of [r.locator('.ln'), r.locator('.ll')]) {
      // the name or the right side either fits, or is cut by the designed ellipsis (its scrollWidth is then larger by
      // definition) — never spilling out of its own box
      const f = await el.evaluate(e => {
        const cs = getComputedStyle(e);
        return { cls: e.className, sw: e.scrollWidth, cw: e.clientWidth, cut: cs.overflowX === 'hidden' && cs.textOverflow === 'ellipsis' && cs.whiteSpace === 'nowrap' };
      });
      expect(f.sw <= f.cw + 1 || f.cut, `${what}: .${f.cls} ${f.sw} > ${f.cw} without an ellipsis`).toBe(true);
      // and its box ends inside the button
      const b = (await el.boundingBox())!;
      expect(b.x + b.width, `${what}: .${f.cls} past the row`).toBeLessThanOrEqual(box.x + box.width + 0.5);
    }
    // the button inside the panel
    expect(box.x + box.width, `${what}: row past the panel`).toBeLessThanOrEqual(side.x + side.width + 0.5);
    // one line
    expect(box.height, `${what}: wrapped`).toBeLessThan(50);
  }
}
