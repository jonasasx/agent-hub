// QA 8.1 (change subscription-limits): a long subscription name never pushes the header of the «Подписки» window past
// the column; the long right side and «обновите агента на …» live in the card.
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
 * Every subscription header (`.tw-sh`) of the «Подписки» window fits inside the window: the header never scrolls, the
 * name is cut by the designed ellipsis inside its own box, and the box ends inside the header.
 */
export async function limitRowsFit(page: Page, expectRows: number) {
  const win = page.locator('.tw-subs');
  const rows = win.locator('.tw-sh');
  await expect(rows).toHaveCount(expectRows);
  const col = (await win.boundingBox())!;
  for (const r of await rows.all()) {
    const what = (await r.locator('.tw-sn').textContent()) ?? '';
    const [sw, cw] = await r.evaluate(e => [e.scrollWidth, e.clientWidth]);
    expect(sw, `${what}: header ${sw} > ${cw}`).toBeLessThanOrEqual(cw + 1);
    const box = (await r.boundingBox())!;
    const name = r.locator('.tw-sn');
    const f = await name.evaluate(e => {
      const cs = getComputedStyle(e);
      return { sw: e.scrollWidth, cw: e.clientWidth, cut: cs.overflowX === 'hidden' && cs.textOverflow === 'ellipsis' && cs.whiteSpace === 'nowrap' };
    });
    expect(f.sw <= f.cw + 1 || f.cut, `${what}: name ${f.sw} > ${f.cw} without an ellipsis`).toBe(true);
    const b = (await name.boundingBox())!;
    expect(b.x + b.width, `${what}: name past the header`).toBeLessThanOrEqual(box.x + box.width + 0.5);
    expect(box.x + box.width, `${what}: header past the window`).toBeLessThanOrEqual(col.x + col.width + 0.5);
    expect(box.height, `${what}: wrapped`).toBeLessThan(50);
  }
}
