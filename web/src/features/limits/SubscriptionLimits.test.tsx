// Tasks 6.2 and 6.4: the limits store/actions and the components (block, row, summary, card, chip).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SessionView, SubscriptionLimitsView, SubscriptionView } from '../../api/types';
import { useStore } from '../../store';
import { mockFetch, resetStore, runner, session } from '../../test/factories';
import { Sidebar } from '../sidebar/Sidebar';
import { Chat } from '../chat/Chat';
import { handleServerMessage } from '../workspace/actions';
import { SUB_A, SUB_B, SUB_C, subView, subsResponse } from '../subscriptions/fixtures';
import { clock } from '../subscriptions/model';
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDialog } from '../ui/a11y';
import { LimitCard } from './LimitCard';
import { LimitChip } from './LimitChip';
import { limitsClock } from './parts';
import { SubscriptionLimits } from './SubscriptionLimits';
import { loadLimits } from './actions';
import { limResponse, limView, win } from './fixtures';

const at = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
const R16 = [runner({ protocolVersion: '1.6' })];

/**
 * Every test starts at local 12:00:00 and the clock runs on from there (only Date is faked, timers stay real): a value
 * built with `at()` in the setup and the same `at()` in an assertion fall into one minute, whatever the real time.
 */
const T0 = new Date(2026, 9, 28, 12, 0, 0).getTime();
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true, now: T0 });
});
afterEach(() => {
  vi.useRealTimers();
});

/** A view relative to the test clock (the components use Date.now). */
const live = (over: Partial<SubscriptionLimitsView> = {}) =>
  limView({
    windows: [win({ utilization: 82, resetsAt: at(130), observedAt: at(-3) }), win({ type: 'seven_day', utilization: 34, resetsAt: at(5000), observedAt: at(-3) })],
    lastOkAt: at(-3),
    ...over,
  });

function setup(
  subs: SubscriptionView[] = [subView(), subView({ id: SUB_B, name: 'Pro рабочая', position: 1 })],
  limits: SubscriptionLimitsView[] = [live(), live({ subscriptionId: SUB_B, windows: [win({ utilization: 11, resetsAt: at(200) })] })],
) {
  useStore.setState({ runners: R16, subs: subsResponse({ subscriptions: subs }), limits: limResponse(limits) });
}

function block() {
  return render(
    <>
      <SubscriptionLimits />
      <button type="button">снаружи</button>
      <LimitCard />
    </>,
  );
}

const rowOf = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}: `) });

describe('the block «Лимиты»', () => {
  beforeEach(resetStore);
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('Блок виден над подвалом: in the panel between the projects and the machines footer, outside the scroll', () => {
    setup();
    mockFetch({});
    const { container } = render(<Sidebar onLogout={vi.fn()} />);
    const section = screen.getByRole('region', { name: 'Лимиты подписок' });
    expect(section.nextElementSibling).toHaveClass('side-bottom');
    expect(section.closest('.side-scroll')).toBeNull();
    expect(container.querySelector('.side-scroll')!.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('rows: the accessible name has the window, the percent, the level and the reset; the bar inside the button is decorative (review A7)', () => {
    setup();
    block();
    const row = rowOf('Max личная');
    expect(row).toHaveAccessibleName(`Max личная: 5 часов, 82%, близко к лимиту, сброс ${clock(at(130))}. Подробнее`);
    expect(row).toHaveTextContent(`близко · 5 ч · 82% · ${clock(at(130))}`);
    expect(within(row).queryByRole('progressbar')).toBeNull();
    const bar = row.querySelector('.lbar')!;
    expect(bar).toHaveAttribute('aria-hidden', 'true');
    expect(bar).toHaveAttribute('data-value', '82');
    expect(bar).toHaveClass('warn');
    expect(rowOf('Pro рабочая')).toHaveTextContent('5 ч · 11%');
  });

  it('Нет подписок: empty registry, tokens not kept or no limits API — no block', () => {
    setup([], []);
    const { container, rerender } = block();
    expect(container.querySelector('.lim')).toBeNull();
    useStore.setState({ subs: subsResponse({ enabled: false }), limits: limResponse([live()]) });
    rerender(<SubscriptionLimits />);
    expect(container.querySelector('.lim')).toBeNull();
    useStore.setState({ subs: subsResponse(), limits: null });
    rerender(<SubscriptionLimits />);
    expect(container.querySelector('.lim')).toBeNull();
  });

  it('Много подписок: five on the desktop fold into the worst one, a click unfolds them, the header folds back', async () => {
    const five = ['A', 'B', 'C', 'D', 'E'].map((n, i) => subView({ id: `00000000-0000-4000-a000-00000000010${i}`, name: `Подписка ${n}`, position: i }));
    setup(
      five,
      five.map((s, i) => live({ subscriptionId: s.id, windows: [win({ utilization: [20, 97, 50, 85, 10][i]!, resetsAt: at(100) })] })),
    );
    block();
    const sum = screen.getByRole('button', { name: /^Лимиты, худшая подписка Подписка B: .*97%.*Развернуть 5$/ });
    expect(sum).toHaveTextContent('худшая: Подписка B 97%');
    expect(sum).toHaveTextContent('почти');
    await userEvent.click(sum);
    expect(screen.getAllByRole('button', { name: /Подробнее$/ })).toHaveLength(5);
    await userEvent.click(screen.getByRole('button', { name: 'свернуть' }));
    expect(screen.queryAllByRole('button', { name: /Подробнее$/ })).toHaveLength(0);
  });

  it('the threshold: three subscriptions — rows on the desktop, the summary on the phone', () => {
    const three = [subView(), subView({ id: SUB_B, name: 'Pro рабочая', position: 1 }), subView({ id: SUB_C, name: 'Третья', position: 2 })];
    setup(three, [live(), live({ subscriptionId: SUB_B }), live({ subscriptionId: SUB_C })]);
    const { rerender } = block();
    expect(screen.getAllByRole('button', { name: /Подробнее$/ })).toHaveLength(3);
    act(() => useStore.setState({ device: 'phone' }));
    rerender(<SubscriptionLimits />);
    expect(screen.getByRole('button', { name: /^Лимиты, худшая подписка/ })).toBeInTheDocument();
  });

  it('«нет данных» with reasons, «ниже порога · проверено», «исчерпана до»', () => {
    const subs = [
      subView(),
      subView({ id: SUB_B, name: 'Pro рабочая', position: 1, tokenRejected: true }),
      subView({ id: SUB_C, name: 'Третья', position: 2, limitResetsAt: at(90), limitKind: 'seven_day' }),
    ];
    setup(subs, [limView({ windows: [], lastOkAt: null, quietAt: at(-12) }), live({ subscriptionId: SUB_B }), live({ subscriptionId: SUB_C })]);
    useStore.setState({ limitsCollapsed: false });
    block();
    expect(rowOf('Max личная')).toHaveTextContent(`ниже порога · проверено ${clock(at(-12))}`);
    expect(within(rowOf('Max личная')).queryByRole('progressbar')).toBeNull();
    expect(rowOf('Pro рабочая')).toHaveTextContent('нет данных: токен отклонён');
    expect(rowOf('Третья')).toHaveTextContent(`исчерпана до ${clock(at(90))}`);
  });

  it('agent_outdated: the row shows the short form, the accessible name and the card name the machine (QA 8.1)', async () => {
    setup([subView()], [limView({ state: 'unavailable', reason: 'agent_outdated', windows: [] })]);
    useStore.setState({ runners: [runner({ name: 'HP', protocolVersion: '1.5' })] });
    mockFetch({});
    block();
    const row = rowOf('Max личная');
    expect(row.querySelector('.ll')).toHaveTextContent(/^нет данных: обновите агента$/);
    expect(row).toHaveAccessibleName(/нет данных: обновите агента на HP/);
    await userEvent.click(row);
    expect(within(screen.getByRole('dialog', { name: /Max личная/ })).getByText(/Нет данных: обновите агента на HP\./)).toBeInTheDocument();
  });
});

describe('the card', () => {
  beforeEach(resetStore);
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('opening shows windows with descriptions and makes no refresh request; Esc closes and returns the focus', async () => {
    setup(
      [subView()],
      [live({ windows: [...live().windows, win({ type: 'seven_day_future', utilization: 20, resetsAt: null })], overage: { status: 'rejected', inUse: false, enabled: true }, lastProbeAt: at(-20) })],
    );
    const calls = mockFetch({});
    block();
    const row = rowOf('Max личная');
    await userEvent.click(row);
    const card = screen.getByRole('dialog', { name: /Max личная/ });
    expect(card).toHaveFocus();
    expect(within(card).getByText('5 часов')).toBeInTheDocument();
    expect(within(card).getByText(/Скользящее окно: начинается с первого запроса/)).toBeInTheDocument();
    expect(within(card).getByText('7 дней')).toBeInTheDocument();
    expect(within(card).getByText('seven_day_future')).toBeInTheDocument();
    expect(within(card).getByText(/Окно без описания/)).toBeInTheDocument();
    expect(within(card).getByText('время сброса неизвестно')).toBeInTheDocument();
    expect(within(card).getByText(`сброс ${clock(at(130))} · через 2 ч 10 мин`)).toBeInTheDocument();
    expect(within(card).getByText(/Включён, но недоступен: кредитов нет/)).toBeInTheDocument();
    expect(within(card).getByText(`Обновлено в ${clock(at(-3))} · ход сессии`)).toBeInTheDocument();
    expect(within(card).getByText(`Пробный ход в ${clock(at(-20))}`)).toBeInTheDocument();
    expect(within(card).getByText(/иначе в чате появится кнопка «Продолжить под другой подпиской»/)).toBeInTheDocument();
    expect(within(card).getByText(/короткий служебный запрос к модели Haiku/)).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(row).toHaveFocus();
  });

  it('«Закрыть» returns the focus; a press outside closes', async () => {
    setup();
    mockFetch({});
    block();
    await userEvent.click(rowOf('Max личная'));
    await userEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(rowOf('Max личная')).toHaveFocus();
    await userEvent.click(rowOf('Pro рабочая'));
    expect(screen.getByRole('dialog', { name: /Pro рабочая/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'снаружи' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('«ниже порога» and «нет данных» in the card; «Обновить» is unavailable with a rejected token', async () => {
    setup(
      [subView(), subView({ id: SUB_B, name: 'Pro рабочая', position: 1 })],
      [limView({ windows: [], lastOkAt: null, quietAt: at(-12) }), limView({ subscriptionId: SUB_B, state: 'unavailable', reason: 'token_rejected', windows: [], lastOkAt: at(-300) })],
    );
    mockFetch({});
    block();
    await userEvent.click(rowOf('Max личная'));
    expect(
      screen.getByText(`проверено в ${clock(at(-12))}. Ход прошёл, лимит не исчерпан; новых процентов сервис не прислал, известные значения окон — ниже порога.`, { exact: false }),
    ).toBeInTheDocument();
    await userEvent.click(rowOf('Pro рабочая'));
    const card = screen.getByRole('dialog', { name: /Pro рабочая/ });
    expect(within(card).getByText(/Нет данных: токен отклонён/)).toBeInTheDocument();
    expect(within(card).getByText(/Замените токен в реестре подписок/)).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Обновить' })).toBeDisabled();
  });

  it('«Обновить»: 202 — the countdown «Обновить через 30 с» runs down each second', async () => {
    setup();
    const calls = mockFetch({ 'POST /api/subscriptions/': () => ({ status: 202, body: { limits: live({ refreshableAt: at(0.5) }) } }) });
    block();
    await userEvent.click(rowOf('Max личная'));
    vi.useFakeTimers({ shouldAdvanceTime: true, now: Date.now() }); // keep the test clock, fake the timers too
    await userEvent.click(screen.getByRole('button', { name: 'Обновить' }));
    expect(await screen.findByRole('button', { name: /^Обновить через (30|29) с$/ })).toBeDisabled();
    expect(calls.find(c => c.method === 'POST')?.url).toBe(`/api/subscriptions/${SUB_A}/limits/refresh`);
    expect(screen.getByText(/Пробный ход запрошен/)).toBeInTheDocument();
    const before = Number(/через (\d+) с/.exec(screen.getByRole('button', { name: /^Обновить через/ }).textContent!)![1]);
    await act(async () => vi.advanceTimersByTime(3000));
    const after = Number(/через (\d+) с/.exec(screen.getByRole('button', { name: /^Обновить через/ }).textContent!)![1]);
    expect(before - after).toBeGreaterThanOrEqual(2);
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(screen.getByRole('button', { name: 'Обновить' })).toBeEnabled();
  });

  it('«Обновить»: 429 refresh_too_soon — the text and the countdown from Retry-After, no second request', async () => {
    setup();
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1;
        return new Response(JSON.stringify({ error: 'refresh_too_soon' }), { status: 429, headers: { 'content-type': 'application/json', 'Retry-After': '12' } });
      }),
    );
    block();
    await userEvent.click(rowOf('Max личная'));
    await userEvent.click(screen.getByRole('button', { name: 'Обновить' }));
    expect(await screen.findByText('Слишком часто: повторить можно через 12 с.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Обновить через 1[12] с$/ })).toBeDisabled();
    expect(n).toBe(1);
  });

  it('a window below the threshold older than the quiet check — the row says «ниже порога», the card the last known value without a level', async () => {
    setup([subView()], [live({ windows: [win({ utilization: 26, status: 'allowed', resetsAt: at(130), observedAt: at(-40) })], lastOkAt: at(-40), quietAt: at(-5) })]);
    mockFetch({});
    block();
    const row = rowOf('Max личная');
    expect(row).toHaveTextContent(`ниже порога · проверено ${clock(at(-5))}`);
    await userEvent.click(row);
    const card = screen.getByRole('dialog', { name: /Max личная/ });
    expect(within(card).getByText(`Последнее известное значение 26% от ${clock(at(-40))}; проверка в ${clock(at(-5))} — ниже порога предупреждения.`)).toBeInTheDocument();
    expect(within(card).getByText(/Ниже порога предупреждения/)).toBeInTheDocument();
  });

  it('fix 2026-10-29: a quiet check does not hide 97% — «почти» in the row, the level and «ход прошёл» in the card, no «ниже порога»', async () => {
    const lim = live({
      windows: [
        win({ utilization: 26, status: 'allowed', resetsAt: at(150), observedAt: at(-4) }),
        win({ type: 'seven_day', utilization: 97, status: 'allowed', resetsAt: at(6000), observedAt: at(-4) }),
      ],
      lastOkAt: at(-4),
      quietAt: at(0),
    });
    setup([subView()], [lim]);
    mockFetch({});
    block();
    const row = rowOf('Max личная');
    expect(row).toHaveTextContent(`почти · 7 дн · 97% · данные от ${clock(at(-4))}`);
    expect(row).not.toHaveTextContent('ниже порога');
    await userEvent.click(row);
    const card = screen.getByRole('dialog', { name: /Max личная/ });
    expect(within(card).queryByText(/Ниже порога предупреждения/)).toBeNull();
    expect(within(card).getByText(`Ход в ${clock(at(0))} прошёл, лимит не исчерпан.`)).toBeInTheDocument();
    expect(within(card).getByText('почти исчерпано')).toBeInTheDocument();
    expect(within(card).getByText(`Значение от ${clock(at(-4))}; ход в ${clock(at(0))} прошёл без новых данных — лимит не исчерпан.`)).toBeInTheDocument();
    // the 5-hour window at 26% stays the last known value without a level
    expect(within(card).getByText(`Последнее известное значение 26% от ${clock(at(-4))}; проверка в ${clock(at(0))} — ниже порога предупреждения.`)).toBeInTheDocument();
  });

  it('review A8: Esc with a modal dialog over the card closes only the dialog; the next Esc closes the card', async () => {
    setup();
    mockFetch({});
    function Modal({ onClose }: { onClose: () => void }) {
      const ref = useRef<HTMLDivElement>(null);
      useDialog(ref, onClose);
      return createPortal(
        <div role="alertdialog" aria-modal="true" aria-label="Подтверждение" ref={ref}>
          <button type="button">Отмена</button>
        </div>,
        document.body,
      );
    }
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <div className="app">
          <SubscriptionLimits />
          <button type="button" onClick={() => setOpen(true)} data-lim-trigger="">
            диалог
          </button>
          <LimitCard />
          {open && <Modal onClose={() => setOpen(false)} />}
        </div>
      );
    }
    render(<Host />);
    await userEvent.click(rowOf('Max личная'));
    expect(screen.getByRole('dialog', { name: /Max личная/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'диалог' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('dialog', { name: /Max личная/ })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('review A8: the subscription went away (retired or deleted) while the card was open — the card closes', async () => {
    setup();
    mockFetch({});
    block();
    await userEvent.click(rowOf('Max личная'));
    expect(screen.getByRole('dialog', { name: /Max личная/ })).toBeInTheDocument();
    act(() => useStore.setState({ subs: subsResponse({ subscriptions: [subView({ retired: true }), subView({ id: SUB_B, name: 'Pro рабочая', position: 1 })] }) }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useStore.getState().limitCard).toBeNull();
  });

  it('review A7: the block, the chip and the card share one clock — one subscription set, one interval', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: Date.now() }); // keep the test clock, fake the timers too
    setup();
    mockFetch({});
    const spy = vi.spyOn(globalThis, 'setInterval');
    const s: SessionView = session({ status: 'waiting', processAlive: true, subscription: { id: SUB_A, name: 'x' }, subscriptionMode: 'subscription' });
    useStore.setState({ sessions: { [s.id]: s } });
    render(
      <>
        <SubscriptionLimits />
        <LimitChip s={s} />
        <LimitCard />
      </>,
    );
    expect(document.querySelector('.lchip')).toHaveTextContent('82% · 5 ч');
    await userEvent.click(rowOf('Max личная'));
    expect(limitsClock.subscribers).toBeGreaterThanOrEqual(3);
    expect(spy.mock.calls.filter(c => c[1] === 30_000)).toHaveLength(1);
    const before = limitsClock.get();
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(limitsClock.get()).toBeGreaterThan(before);
    spy.mockRestore();
  });

  it('409 runner_offline — the reason in words', async () => {
    setup();
    mockFetch({ 'POST /api/subscriptions/': () => ({ status: 409, body: { error: 'runner_offline' } }) });
    block();
    await userEvent.click(rowOf('Max личная'));
    await userEvent.click(screen.getByRole('button', { name: 'Обновить' }));
    expect(await screen.findByText('Нет машины в сети для пробного хода.')).toBeInTheDocument();
  });
});

describe('the chip in the tab head', () => {
  beforeEach(resetStore);
  afterEach(() => vi.unstubAllGlobals());

  function showChat(s: SessionView) {
    useStore.getState().upsertSessions([s]);
    useStore.setState({ logs: { [s.id]: { events: [], before: null, loaded: true, loading: false, error: null } }, models: [{ value: 'opus', displayName: 'Opus 5.5' }] });
    return render(
      <>
        <Chat session={s} paneId="p1" />
        <LimitCard />
      </>,
    );
  }
  const under = (id = SUB_A) => session({ status: 'waiting', processAlive: true, subscription: { id, name: 'x' }, subscriptionMode: 'subscription' });

  it('Метка в шапке: «82% · 5 ч» with a warning badge, a click opens the card of that subscription', async () => {
    setup();
    mockFetch({});
    showChat(under());
    const chip = document.querySelector<HTMLButtonElement>('.chat-head .lchip')!;
    expect(chip).toHaveTextContent('82% · 5 ч');
    expect(chip).toHaveClass('warn');
    await userEvent.click(chip);
    expect(screen.getByRole('dialog', { name: /Max личная/ })).toBeInTheDocument();
  });

  it('an exhausted subscription: «100% · 7 дн»', () => {
    setup([subView({ limitResetsAt: at(600), limitKind: 'seven_day' })], [live()]);
    mockFetch({});
    showChat(under());
    expect(document.querySelector('.chat-head .lchip')).toHaveTextContent('100% · 7 дн');
  });

  it('Вход машины: no chip', () => {
    setup();
    mockFetch({});
    showChat(session({ processAlive: true, subscription: null, subscriptionMode: 'machine_login' }));
    expect(document.querySelector('.lchip')).toBeNull();
  });

  it('phone: the chip is in the session info line', () => {
    setup();
    useStore.setState({ device: 'phone' });
    mockFetch({});
    showChat(under());
    expect(document.querySelector('.phone-info .lchip')).toHaveTextContent('82% · 5 ч');
  });
});

describe('store and reloads (task 6.2)', () => {
  beforeEach(resetStore);
  afterEach(() => vi.unstubAllGlobals());

  it('loadLimits: the answer into the store with the clock skew; 404 hides the block', async () => {
    const server = new Date(Date.now() + 60_000).toISOString();
    let status = 200;
    mockFetch({ 'GET /api/subscriptions/limits': () => (status === 200 ? { status, body: limResponse([live()], server) } : { status, body: { error: 'not_found' } }) });
    await loadLimits();
    expect(useStore.getState().limits?.limits).toHaveLength(1);
    expect(Math.abs(useStore.getState().limitsSkew - 60_000)).toBeLessThan(2000);
    status = 404;
    await loadLimits();
    expect(useStore.getState().limits).toBeNull();
  });

  it('subscription_limits.changed and subscriptions.changed reload the limits', async () => {
    const calls = mockFetch({ 'GET /api/subscriptions/limits': () => ({ status: 200, body: limResponse([live()]) }), 'GET /api/subscriptions': () => ({ status: 200, body: subsResponse() }) });
    handleServerMessage({ type: 'subscription_limits.changed' } as never);
    await vi.waitFor(() => expect(calls.filter(c => c.url === '/api/subscriptions/limits')).toHaveLength(1));
    handleServerMessage({ type: 'subscriptions.changed' });
    await vi.waitFor(() => expect(calls.filter(c => c.url === '/api/subscriptions/limits')).toHaveLength(2));
    await vi.waitFor(() => expect(useStore.getState().limits?.limits[0]?.subscriptionId).toBe(SUB_A));
  });
});
