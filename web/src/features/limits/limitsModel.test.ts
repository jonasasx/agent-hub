// Task 6.3: the pure model of the limits UI (levels, the row window, «нет данных», «ниже порога», stale, reset).
import { describe, expect, it } from 'vitest';
import { clock } from '../subscriptions/model';
import { subView } from '../subscriptions/fixtures';
import { runner } from '../../test/factories';
import { NOW, isoAt, limView, win } from './fixtures';
import { beforeQuiet, effectivePct, heldOverQuiet, noFiveHour, outdatedMachines, refreshLeft, relIn, rowModel, topWindow, windowLevel } from './limitsModel';
import { reasonText, windowText } from './limitTexts';

const hm = (iso: string) => clock(iso, new Date(NOW));

describe('levels (Requirement: Пороги и индикация не только цветом)', () => {
  it('79/80/95/100 → норма, близко, почти, исчерпано', () => {
    expect([79, 80, 95, 100].map(u => windowLevel({ utilization: u, status: 'allowed' }))).toEqual(['ok', 'warn', 'crit', 'full']);
    expect(windowLevel({ utilization: 94.9, status: 'allowed' })).toBe('warn');
  });
  it('statuses: allowed_warning without a percent counts as 80, rejected as 100; nothing known — no level', () => {
    expect(effectivePct({ utilization: null, status: 'allowed_warning' })).toBe(80);
    expect(windowLevel({ utilization: null, status: 'allowed_warning' })).toBe('warn');
    expect(windowLevel({ utilization: 30, status: 'allowed_warning' })).toBe('warn');
    expect(windowLevel({ utilization: null, status: 'rejected' })).toBe('full');
    expect(windowLevel({ utilization: 40, status: 'rejected' })).toBe('full');
    expect(windowLevel({ utilization: null, status: null })).toBeNull();
    expect(windowLevel({ utilization: null, status: 'unknown' })).toBeNull();
  });
});

describe('the row window (Requirement: Строка подписки)', () => {
  it('Выбор окна для строки: equal percents — the earlier reset wins', () => {
    const lim = limView({
      windows: [win({ utilization: 40 }), win({ type: 'seven_day', utilization: 82, resetsAt: isoAt(3000) }), win({ type: 'seven_day_opus', utilization: 82, resetsAt: isoAt(600) })],
    });
    expect(topWindow(lim, NOW)?.type).toBe('seven_day_opus');
    const r = rowModel(subView(), lim, NOW);
    expect(r).toMatchObject({ kind: 'win', badge: 'warn', word: 'близко', boldPct: '82%', chip: '82% · 7 дн Opus' });
    expect(r.text).toBe(`7 дн Opus · 82% · ${hm(isoAt(600))}`);
    expect(r.aria).toBe(`7 дней · Opus, 82%, близко к лимиту, сброс ${hm(isoAt(600))}`);
  });
  it('a reset window and a window with nothing known are not candidates', () => {
    const lim = limView({ windows: [win({ utilization: 99, resetsAt: isoAt(-15) }), win({ type: 'seven_day', utilization: 20 }), win({ type: 'x', utilization: null, status: null })] });
    expect(topWindow(lim, NOW)?.type).toBe('seven_day');
  });
  it('only reset windows: «окно сброшено в HH:MM», no percent, neutral', () => {
    const r = rowModel(subView(), limView({ windows: [win({ utilization: 99, resetsAt: isoAt(-15) })] }), NOW);
    expect(r).toMatchObject({ kind: 'reset', badge: 'neutral', pct: null, text: `окно сброшено в ${hm(isoAt(-15))}` });
  });
  it('Подписка исчерпана: limit_resets_at in the future → «исчерпана до», chip «100% · 7 дн», whatever the snapshot', () => {
    const r = rowModel(subView({ limitResetsAt: isoAt(120), limitKind: 'seven_day' }), limView(), NOW);
    expect(r).toMatchObject({ kind: 'full', badge: 'full', pct: 100, text: `исчерпана до ${hm(isoAt(120))}`, chip: '100% · 7 дн' });
    // the kind from the rejected window when the subscription has none; a past limit is ignored
    expect(rowModel(subView({ limitResetsAt: isoAt(120) }), limView({ windows: [win({ type: 'five_hour', status: 'rejected', utilization: 100 })] }), NOW).chip).toBe('100% · 5 ч');
    expect(rowModel(subView({ limitResetsAt: isoAt(120) }), undefined, NOW).chip).toBe('100%');
    expect(rowModel(subView({ limitResetsAt: isoAt(-1) }), limView(), NOW).kind).toBe('win');
  });
  it('an unknown window: the raw name in the row and the card', () => {
    const r = rowModel(subView(), limView({ windows: [win({ type: 'seven_day_future', utilization: 85 })] }), NOW);
    expect(r.text.startsWith('seven_day_future · 85%')).toBe(true);
    expect(windowText('seven_day_future')).toEqual({ short: 'seven_day_future', name: 'seven_day_future', desc: null });
    expect(windowText('toString').desc).toBeNull();
  });
  it('the Fable weekly window is known: «7 дн Fable» in the row, «7 дней · Fable» in the card', () => {
    const r = rowModel(subView(), limView({ windows: [win({ type: 'seven_day_overage_included', utilization: 85 })] }), NOW);
    expect(r.text.startsWith('7 дн Fable · 85%')).toBe(true);
    expect(windowText('seven_day_overage_included').name).toBe('7 дней · Fable');
    expect(windowText('seven_day_overage_included').desc).toMatch(/только в ответ на запросы к Fable/);
  });
  it('no 5-hour window: only with a weekly window and without five_hour (limits-stale-windows D4)', () => {
    expect(noFiveHour(limView({ windows: [win({ type: 'seven_day' })] }))).toBe(true);
    expect(noFiveHour(limView({ windows: [win({ type: 'seven_day' }), win({ type: 'seven_day_overage_included' })] }))).toBe(true);
    expect(noFiveHour(limView())).toBe(false);
    expect(noFiveHour(limView({ windows: [] }))).toBe(false);
    expect(noFiveHour(limView({ windows: [win({ type: 'seven_day_opus' })] }))).toBe(false);
  });
});

describe('«нет данных», «ниже порога», stale (Requirements: Состояния «нет данных»; Устаревшие данные)', () => {
  it('reasons in words; token_rejected outranks the rest and the limit', () => {
    for (const [reason, text] of [
      ['not_polled', 'ещё не проверялась'],
      ['no_runner', 'нет машины в сети'],
      ['probe_failed', 'пробный ход не удался'],
      ['expired', 'данные старше суток'],
      ['token_rejected', 'токен отклонён'],
    ] as const) {
      expect(rowModel(subView(), limView({ state: 'unavailable', reason, windows: [] }), NOW)).toMatchObject({ kind: 'nodata', badge: 'nodata', pct: null, text: `нет данных: ${text}` });
    }
    expect(rowModel(subView({ tokenRejected: true, limitResetsAt: isoAt(60) }), limView(), NOW).text).toBe('нет данных: токен отклонён');
    expect(rowModel(subView(), undefined, NOW).text).toBe('нет данных: ещё не проверялась');
  });
  it('agent_outdated names the online machines older than 1.6 in the accessible name, the row text is short', () => {
    const names = outdatedMachines([
      runner({ protocolVersion: '1.6' }),
      runner({ id: 'hp', name: 'HP', protocolVersion: '1.5' }),
      runner({ id: 'vm', name: 'ВМ', protocolVersion: '1.4', online: false }),
    ]);
    expect(names).toEqual(['HP']);
    const r = rowModel(subView(), limView({ state: 'unavailable', reason: 'agent_outdated', windows: [] }), NOW, names);
    // the row stays short; the machines are in the accessible name (QA 8.1)
    expect(r.text).toBe('нет данных: обновите агента');
    expect(r.aria).toBe('нет данных: обновите агента на HP');
    expect(reasonText('agent_outdated')).toBe('обновите агента');
  });
  it('quietAt without windows → «ниже порога · проверено HH:MM» without a percent and colour', () => {
    const r = rowModel(subView(), limView({ windows: [], lastOkAt: null, quietAt: isoAt(-12) }), NOW);
    expect(r).toMatchObject({ kind: 'quiet', badge: 'quiet', pct: null, chip: 'ниже порога', text: `ниже порога · проверено ${hm(isoAt(-12))}` });
  });
  it('a quiet check newer than windows below the threshold — the row says «ниже порога · проверено»', () => {
    const r = rowModel(subView(), limView({ quietAt: isoAt(-1) }), NOW);
    expect(r).toMatchObject({ kind: 'quiet', badge: 'quiet', pct: null, text: `ниже порога · проверено ${hm(isoAt(-1))}` });
    const low = limView({ windows: [win({ utilization: 26, observedAt: isoAt(-20) })], lastOkAt: isoAt(-20), quietAt: isoAt(-5) });
    expect(rowModel(subView(), low, NOW)).toMatchObject({ kind: 'quiet', badge: 'quiet' });
    expect(heldOverQuiet(low.windows[0]!, low, NOW)).toBe(false);
  });
  it('fix 2026-10-29: a quiet check does not hide a window at 97% — the row keeps «почти» with the time of the data', () => {
    const lim = limView({
      windows: [win({ utilization: 26, observedAt: isoAt(-4) }), win({ type: 'seven_day', utilization: 97, resetsAt: isoAt(6000), observedAt: isoAt(-4) })],
      lastOkAt: isoAt(-4),
      quietAt: isoAt(0),
    });
    expect(beforeQuiet(lim.windows[1]!, lim)).toBe(true);
    expect(heldOverQuiet(lim.windows[1]!, lim, NOW)).toBe(true);
    expect(heldOverQuiet(lim.windows[0]!, lim, NOW)).toBe(false);
    const r = rowModel(subView(), lim, NOW);
    expect(r).toMatchObject({ kind: 'win', badge: 'crit', word: 'почти', boldPct: '97%', chip: '97% · 7 дн' });
    expect(r.text).toBe(`7 дн · 97% · данные от ${hm(isoAt(-4))}`);
    expect(r.aria).toBe(`7 дней, 97%, почти исчерпано, сброс ${hm(isoAt(6000))}, данные от ${hm(isoAt(-4))}`);
    // allowed_warning without a percent is held too (counts as 80)
    const warn = limView({ windows: [win({ utilization: null, status: 'allowed_warning', observedAt: isoAt(-20) })], quietAt: isoAt(-5) });
    expect(rowModel(subView(), warn, NOW)).toMatchObject({ kind: 'win', badge: 'warn' });
  });
  it('fix 2026-10-29: a rejection or a reset window older than the quiet check sets no level', () => {
    const rej = limView({ windows: [win({ type: 'seven_day', utilization: 100, status: 'rejected', resetsAt: isoAt(6000), observedAt: isoAt(-4) })], quietAt: isoAt(0) });
    expect(heldOverQuiet(rej.windows[0]!, rej, NOW)).toBe(false);
    expect(rowModel(subView(), rej, NOW)).toMatchObject({ kind: 'quiet', badge: 'quiet' });
    const reset = limView({ windows: [win({ utilization: 92, resetsAt: isoAt(-10), observedAt: isoAt(-30) })], quietAt: isoAt(0) });
    expect(heldOverQuiet(reset.windows[0]!, reset, NOW)).toBe(false);
    expect(rowModel(subView(), reset, NOW)).toMatchObject({ kind: 'quiet', badge: 'quiet', text: `ниже порога · проверено ${hm(isoAt(0))}` });
    // a window observed after the check counts as usual
    const newer = limView({
      windows: [win({ utilization: 92, status: 'allowed_warning', observedAt: isoAt(-1) }), win({ type: 'seven_day', utilization: 40, observedAt: isoAt(-20) })],
      quietAt: isoAt(-5),
    });
    expect(rowModel(subView(), newer, NOW)).toMatchObject({ kind: 'win', badge: 'warn', boldPct: '92%' });
    expect(beforeQuiet(newer.windows[0]!, newer)).toBe(false);
  });
  it('stale: «данные от HH:MM», neutral, out of warnings', () => {
    const lim = limView({ state: 'stale', lastOkAt: isoAt(-70), staleAt: isoAt(-10), windows: [win({ utilization: 97 })] });
    expect(topWindow(lim, NOW)).toBeNull();
    expect(rowModel(subView(), lim, NOW)).toMatchObject({ kind: 'stale', badge: 'neutral', pct: 97, text: `данные от ${hm(isoAt(-70))}` });
  });
});

describe('summary, time, refresh', () => {
  it('relative time', () => {
    expect(relIn(isoAt(130), NOW)).toBe('через 2 ч 10 мин');
    expect(relIn(isoAt(128), NOW)).toBe('через 2 ч 8 мин');
    expect(relIn(isoAt(120), NOW)).toBe('через 2 ч');
    expect(relIn(isoAt(5), NOW)).toBe('через 5 мин');
    expect(relIn(isoAt((3 * 24 + 4) * 60), NOW)).toBe('через 3 дн 4 ч');
  });
  it('refreshLeft: seconds until refreshableAt', () => {
    expect(refreshLeft(limView({ refreshableAt: new Date(NOW + 29_200).toISOString() }), NOW)).toBe(30);
    expect(refreshLeft(limView({ refreshableAt: isoAt(-1) }), NOW)).toBe(0);
    expect(refreshLeft(undefined, NOW)).toBe(0);
  });
});
