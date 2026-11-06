// Component tests of «Подписки Claude» (task 6.2). Requirements: Реестр подписок; Хранение токена подписки;
// Учёт ходов и расход по подпискам.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SubscriptionsResponse } from '../../api/types';
import { useStore } from '../../store';
import { mockFetch, resetStore } from '../../test/factories';
import { SUB_A, SUB_B, subView, subsResponse } from './fixtures';
import { disabledText, SubscriptionsPage, UsagePage, nameError, rangeText } from './SubscriptionsPage';

const TOKEN = 'sk-ant-oat01-SECRETSECRETSECRET-9z8y';

function show(initial: SubscriptionsResponse, routes: Parameters<typeof mockFetch>[0] = {}, tokenFor?: string) {
  let current = initial;
  const calls = mockFetch({ 'GET /api/subscriptions': () => ({ status: 200, body: current }), ...routes });
  useStore.setState({ subs: initial });
  useStore.setState({ settingsTokenFor: tokenFor ?? null });
  const view = render(<SubscriptionsPage />);
  return { calls, view, setHub: (r: SubscriptionsResponse) => (current = r) };
}

/** The Claude registry block (the page has one block per provider). */
const claudeBlock = () => within(screen.getByRole('group', { name: 'Claude' }));

describe('SubscriptionsPage / UsagePage («Настройки»)', () => {
  beforeEach(() => {
    resetStore();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 0, 15, 10, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('lists active subscriptions in order with the mask, the limit and the rejected token; retired ones with «Вернуть»', async () => {
    const until = new Date(Date.now() + 3 * 3_600_000).toISOString();
    show(
      subsResponse({
        subscriptions: [
          subView({ limitResetsAt: until }),
          subView({ id: SUB_B, name: 'Pro рабочая', position: 1, tokenRejected: true }),
          subView({ id: '00000000-0000-4000-a000-0000000000ff', name: 'Старая', retired: true, position: 2 }),
        ],
      }),
    );
    const active = within(claudeBlock().getByRole('region', { name: /Активные/ })).getAllByRole('listitem');
    expect(active.map(li => li.querySelector('.subs-name')!.textContent)).toEqual(['Max личная', 'Pro рабочая']);
    expect(active[0]).toHaveTextContent('…a1b2');
    expect(active[0]).toHaveTextContent(/лимит до \d\d:\d\d/);
    expect(active[0]).toHaveTextContent('по умолчанию');
    expect(active[1]).toHaveTextContent('токен отклонён');
    const retired = claudeBlock().getByRole('region', { name: /Выведенные/ });
    expect(within(retired).getByText('Старая')).toBeInTheDocument();
    expect(within(retired).getByRole('button', { name: 'Вернуть' })).toBeInTheDocument();
  });

  it('Добавление подписки: the token goes only in the POST body, the input is a password without autocomplete and is empty after the submit; nothing of it stays in the DOM or the store', async () => {
    const { calls, setHub } = show(subsResponse(), {
      'POST /api/subscriptions': () => {
        setHub(subsResponse({ subscriptions: [...subsResponse().subscriptions, subView({ id: '00000000-0000-4000-a000-0000000000cc', name: 'Третья', position: 2, tokenHint: '9z8y' })] }));
        return { status: 201, body: subView({ name: 'Третья', tokenHint: '9z8y' }) };
      },
    });
    const token = screen.getByLabelText('Токен') as HTMLInputElement;
    expect(token).toHaveAttribute('type', 'password');
    expect(token).toHaveAttribute('autocomplete', 'off');
    await userEvent.type(screen.getByLabelText('Имя'), 'Третья');
    await userEvent.type(token, TOKEN);
    await userEvent.click(screen.getByRole('button', { name: 'Добавить' }));
    await screen.findByText('Подписка «Третья» добавлена');
    expect(calls.find(c => c.method === 'POST')!.body).toEqual({ name: 'Третья', token: TOKEN, autoSwitch: false });
    expect(token.value).toBe('');
    expect(document.body.innerHTML).not.toContain('SECRET');
    expect(JSON.stringify(useStore.getState())).not.toContain('SECRET');
    expect(await screen.findByText('…9z8y')).toBeInTheDocument();
  });

  it('H1: a taken name (any case) is refused before the token is touched — the pasted token stays; a bad token stays too', async () => {
    const { calls } = show(subsResponse(), { 'POST /api/subscriptions': () => ({ status: 409, body: { error: 'name_taken' } }) });
    const token = screen.getByLabelText('Токен') as HTMLInputElement;
    await userEvent.type(screen.getByLabelText('Имя'), 'MAX личная');
    await userEvent.type(token, TOKEN);
    await userEvent.click(screen.getByRole('button', { name: 'Добавить' }));
    expect(screen.getByText('Подписка с таким именем уже есть')).toBeInTheDocument();
    expect(screen.getByLabelText('Имя')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Имя')).toHaveFocus();
    expect(token.value).toBe(TOKEN);
    expect(calls.some(c => c.method === 'POST')).toBe(false);
    await userEvent.clear(screen.getByLabelText('Имя'));
    await userEvent.type(screen.getByLabelText('Имя'), 'Третья');
    await userEvent.clear(token);
    await userEvent.type(token, 'short token');
    await userEvent.click(screen.getByRole('button', { name: 'Добавить' }));
    expect(screen.getByText(/Токен не похож на claude setup-token/)).toBeInTheDocument();
    expect(token.value).toBe('short token');
    expect(calls.some(c => c.method === 'POST')).toBe(false);
    // a real submit clears the token even when the hub refuses (a race with another window)
    await userEvent.clear(token);
    await userEvent.type(token, TOKEN);
    await userEvent.click(screen.getByRole('button', { name: 'Добавить' }));
    expect(await screen.findByText('Подписка с таким именем уже есть')).toBeInTheDocument();
    expect(token.value).toBe('');
  });

  it('N1: Esc in the row menu closes the menu only — the focus is back on «⋯», nothing else reacts', async () => {
    const onKey = vi.fn();
    document.addEventListener('keydown', onKey);
    show(subsResponse());
    const more = screen.getByRole('button', { name: 'Max личная: действия' });
    await userEvent.click(more);
    expect(screen.getByRole('menu', { name: 'Действия: Max личная' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(more).toHaveFocus();
    expect(onKey).not.toHaveBeenCalled();
    document.removeEventListener('keydown', onKey);
  });

  it('P12: a page, not a dialog — the heading «Подписки», no role dialog, no tabs; settingsTokenFor is taken once', () => {
    show(subsResponse(), {}, SUB_A);
    expect(screen.getByRole('heading', { level: 2, name: 'Подписки' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(useStore.getState().settingsTokenFor).toBeNull();
    expect(screen.getByLabelText(/Новый токен «Max личная»/)).toHaveFocus();
  });

  it('P12: a retired or unknown tokenFor opens no form', () => {
    show(subsResponse({ subscriptions: [subView(), subView({ id: SUB_B, name: 'Pro рабочая', position: 1, retired: true })] }), {}, SUB_B);
    expect(screen.queryByLabelText(/Новый токен/)).not.toBeInTheDocument();
  });

  it('review 10.x: a network error or 5xx of GET /api/subscriptions — the text and «Повторить» instead of an endless spinner; 404 stays «missing»', async () => {
    let n = 0;
    mockFetch({ 'GET /api/subscriptions': () => (++n === 1 ? { status: 503, body: { error: 'unavailable' } } : { status: 200, body: subsResponse() }) });
    render(<SubscriptionsPage />);
    expect(await screen.findByText('Не удалось загрузить подписки — проверьте VPN')).toBeInTheDocument();
    expect(useStore.getState().subsMissing).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByText('Max личная')).toBeInTheDocument();
    expect(screen.queryByText(/Не удалось загрузить подписки/)).not.toBeInTheDocument();
    expect(useStore.getState().subsError).toBe(false);
  });

  it('review 10.x: «Расход» says the same when the list did not load', async () => {
    mockFetch({ 'GET /api/subscriptions': () => ({ status: 500, body: {} }), 'GET /api/subscriptions/usage': () => ({ status: 200, body: { from: 'x', to: 'y', rows: [] } }) });
    render(<UsagePage />);
    expect(await screen.findByText('Не удалось загрузить подписки — проверьте VPN')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
  });

  it('404 marks the API missing, no error text', async () => {
    mockFetch({});
    render(<SubscriptionsPage />);
    await vi.waitFor(() => expect(useStore.getState().subsMissing).toBe(true));
    expect(useStore.getState().subsError).toBe(false);
  });

  it('nameError: empty, too long, taken in any case', () => {
    expect(nameError('  ', [])).toBe('Имя — от 1 до 60 символов');
    expect(nameError('x'.repeat(61), [])).toBe('Имя — от 1 до 60 символов');
    expect(nameError(' pro РАБОЧАЯ ', ['Pro рабочая'])).toBe('Подписка с таким именем уже есть');
    expect(nameError('Новая', ['Pro рабочая'])).toBeUndefined();
  });

  it('H2: tokenFor opens the token form of that subscription; a rejected token has «Заменить токен» in its row', async () => {
    show(subsResponse({ subscriptions: [subView(), subView({ id: SUB_B, name: 'Pro рабочая', position: 1, tokenRejected: true })] }), {}, SUB_B);
    const input = screen.getByLabelText(/Новый токен «Pro рабочая»/);
    expect(input).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    const row = within(claudeBlock().getByRole('region', { name: /Активные/ })).getAllByRole('listitem')[1]!;
    await userEvent.click(within(row).getByRole('button', { name: 'Заменить токен' }));
    expect(screen.getByLabelText(/Новый токен «Pro рабочая»/)).toBeInTheDocument();
    // the first row has no rejected token: no inline button
    expect(within(within(claudeBlock().getByRole('region', { name: /Активные/ })).getAllByRole('listitem')[0]!).queryByRole('button', { name: 'Заменить токен' })).not.toBeInTheDocument();
  });

  it('M4/M5/L3: one column header for auto-switch, a checkbox named per row, the full name in the tooltip; an empty registry has no order caption and focuses «Имя»', () => {
    const v = show(subsResponse());
    expect(document.querySelector('.subs-cols')).toHaveTextContent('Автопереключение');
    expect(screen.getByRole('checkbox', { name: 'Max личная: автопереключение' })).toBeInTheDocument();
    expect(document.querySelector('.subs-name')).toHaveAttribute('title', 'Max личная');
    expect(claudeBlock().getByRole('heading', { name: /Активные/ })).toHaveTextContent('порядок');
    v.view.unmount();
    show(subsResponse({ subscriptions: [], defaultId: null }));
    expect(claudeBlock().getByRole('heading', { name: /Активные/ })).not.toHaveTextContent('порядок');
    expect(document.querySelector('.subs-cols')).toBeNull();
    expect(screen.getByLabelText('Имя')).toHaveFocus();
    expect(screen.getByLabelText('Имя')).toHaveAttribute('placeholder', 'например, Team рабочая');
  });

  it('M7: periods move with arrows, Home and End; only the chosen one is in the Tab order', async () => {
    mockFetch({ 'GET /api/subscriptions': () => ({ status: 200, body: subsResponse() }), 'GET /api/subscriptions/usage': () => ({ status: 200, body: { from: 'x', to: 'y', rows: [] } }) });
    useStore.setState({ subs: subsResponse() });
    render(<UsagePage />);
    expect(screen.getByRole('heading', { level: 2, name: 'Расход' })).toBeInTheDocument();
    const week = screen.getByRole('radio', { name: '7 дней' });
    expect(week).toHaveAttribute('tabindex', '0');
    expect(week.closest('.seg')).not.toBeNull();
    week.focus();
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('radio', { name: 'Даты' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Даты' })).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(screen.getByRole('radio', { name: 'Сегодня' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByRole('radio', { name: 'Даты' })).toHaveAttribute('aria-checked', 'true');
  });

  it('rangeText: the shown interval, `to` exclusive', () => {
    expect(rangeText(new Date(2026, 9, 21).toISOString(), new Date(2026, 9, 28).toISOString())).toBe('21.10.2026 — 27.10.2026');
    expect(rangeText(new Date(2026, 9, 27).toISOString(), new Date(2026, 9, 27, 12).toISOString())).toBe('27.10.2026');
    expect(rangeText('x', 'y')).toBeNull();
  });

  it('Замена токена, порядок, автопереключение, вывод', async () => {
    const { calls } = show(subsResponse(), {
      'PUT /api/subscriptions/order': () => ({ status: 200, body: subsResponse({ subscriptions: [subView({ position: 1 }), subView({ id: SUB_B, name: 'Pro рабочая', position: 0 })] }) }),
      'PUT /api/subscriptions/': () => ({ status: 200, body: subView({ tokenHint: '9z8y' }) }),
      'PATCH /api/subscriptions/': () => ({ status: 200, body: subView() }),
    });
    await userEvent.click(screen.getByRole('button', { name: 'Max личная: действия' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Заменить токен' }));
    const input = screen.getByLabelText(/Новый токен «Max личная»/) as HTMLInputElement;
    expect(input).toHaveAttribute('type', 'password');
    await userEvent.type(input, TOKEN);
    await userEvent.click(screen.getByRole('button', { name: 'Заменить' }));
    await vi.waitFor(() => expect(calls.some(c => c.method === 'PUT' && c.url === `/api/subscriptions/${SUB_A}/token`)).toBe(true));
    expect(calls.find(c => c.url.endsWith('/token'))!.body).toEqual({ token: TOKEN });
    expect(document.body.innerHTML).not.toContain('SECRET');

    await userEvent.click(screen.getByRole('button', { name: 'Pro рабочая: выше' }));
    await vi.waitFor(() => expect(calls.find(c => c.url === '/api/subscriptions/order')?.body).toEqual({ ids: [SUB_B, SUB_A] }));
    await vi.waitFor(() => expect(within(claudeBlock().getByRole('region', { name: /Активные/ })).getAllByRole('listitem')[0]).toHaveTextContent('Pro рабочая'));
    expect(screen.getByRole('button', { name: 'Pro рабочая: выше' })).toBeDisabled();

    await userEvent.click(within(screen.getAllByRole('listitem')[1]!).getByRole('checkbox', { name: /автопереключение/ }));
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PATCH')?.body).toEqual({ autoSwitch: true }));

    await userEvent.click(screen.getByRole('button', { name: 'Max личная: действия' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Вывести' }));
    await vi.waitFor(() => expect(calls.filter(c => c.method === 'PATCH').at(-1)?.body).toEqual({ retired: true }));
  });

  it('Ключ шифрования не задан: the banner, adding is unavailable', () => {
    show(subsResponse({ enabled: false }));
    expect(screen.getByRole('alert')).toHaveTextContent(disabledText());
    expect(screen.getByRole('button', { name: 'Добавить' })).toBeDisabled();
  });

  it('Расход: 7 days by default, rows by subscription and «Вход машины», the caption «основной цикл»; «Сегодня» asks again', async () => {
    const v = show(subsResponse({ subscriptions: [...subsResponse().subscriptions, subView({ id: '00000000-0000-4000-a000-0000000000ff', name: 'Старая', retired: true, position: 2 })] }), {
      'GET /api/subscriptions/usage': () => ({
        status: 200,
        body: {
          from: 'x',
          to: 'y',
          rows: [
            { subscriptionId: SUB_A, name: 'Max личная', turns: 40, inputTokens: 12000, outputTokens: 3400, cacheReadTokens: 900000, cacheCreationTokens: 5000, limitHits: 1 },
            { subscriptionId: '00000000-0000-4000-a000-0000000000ff', name: 'Старая', turns: 2, inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, limitHits: 0 },
            { subscriptionId: null, name: 'Вход машины', turns: 3, inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0, limitHits: 0 },
          ],
        },
      }),
    });
    v.view.unmount();
    render(<UsagePage />);
    expect(screen.getByRole('radio', { name: '7 дней' })).toHaveAttribute('aria-checked', 'true');
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('rowheader', { name: 'Max личная' })).toBeInTheDocument();
    expect(within(table).getByRole('rowheader', { name: 'Вход машины' })).toBeInTheDocument();
    expect(table).toHaveTextContent(/900\s000/);
    expect(table.querySelector('caption')).toHaveTextContent('основной цикл, без субагентов');
    // M9: the total, the retired mark, the machine row muted, limits in --warn
    const foot = within(table).getByRole('rowheader', { name: 'Итого' }).closest('tr')!;
    expect(foot).toHaveTextContent('45');
    expect(within(table).getByRole('rowheader', { name: /Старая/ })).toHaveTextContent('выведена');
    expect(within(table).getByRole('rowheader', { name: 'Вход машины' }).closest('tr')).toHaveClass('machine');
    expect(table.querySelector('td.warn')).toHaveTextContent('1');
    const calls = v.calls;
    const first = calls.find(c => c.url.startsWith('/api/subscriptions/usage'))!;
    const q = new URL(first.url, 'http://h').searchParams;
    expect(Math.round((Date.parse(q.get('to')!) - Date.parse(q.get('from')!)) / 86_400_000)).toBe(7);
    await userEvent.click(screen.getByRole('radio', { name: 'Сегодня' }));
    await vi.waitFor(() => expect(calls.filter(c => c.url.startsWith('/api/subscriptions/usage'))).toHaveLength(2));
    await userEvent.click(screen.getByRole('radio', { name: 'Даты' }));
    await userEvent.clear(screen.getByLabelText('С'));
    await userEvent.type(screen.getByLabelText('С'), '2024-01-01');
    const err = await screen.findByText('Период — не больше 366 дней');
    // M8: the last table stays (dimmed, busy), «По» is marked and described by the error
    expect(screen.getByRole('table')).toHaveClass('stale');
    expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByLabelText('По')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('По')).toHaveAttribute('aria-describedby', err.id);
  });
});
