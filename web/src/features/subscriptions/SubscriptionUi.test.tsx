// Component tests of the subscription field (task 6.3), the tab head switch (6.4) and the chat notes (6.5).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HubEvent, SessionView } from '../../api/types';
import { useStore } from '../../store';
import { mockFetch, resetStore, runner, session } from '../../test/factories';
import { NewSessionModal } from '../newSession/NewSessionModal';
import { ForkModal } from '../fork/ForkModal';
import { Chat } from '../chat/Chat';
import { SwitchConfirm } from './SwitchConfirm';
import { Settings } from '../settings/Settings';
import { SUB_A, SUB_B, SUB_C, subView, subsResponse } from './fixtures';
import { connectorsHint } from './model';

const R14 = [
  runner({ protocolVersion: '1.4' }),
  runner({ id: 'hp', name: 'HP', protocolVersion: '1.3' }),
  runner({ id: 'vm', name: 'ВМ .3', protocolVersion: '1.4', defaultDir: '/home/ubuntu/vault' }),
];
const MODELS = [{ value: 'opus', displayName: 'Opus 5.5' }];

function base(subs = subsResponse()) {
  useStore.setState({ runners: R14, models: MODELS, subs });
}

describe('«Подписка» in «Новая сессия»', () => {
  beforeEach(() => {
    resetStore();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 0, 15, 10, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('Пустой реестр: no field, the body has no subscriptionId', async () => {
    base(subsResponse({ subscriptions: [], defaultId: null }));
    const calls = mockFetch({ 'POST /api/sessions': () => ({ status: 201, body: session() }) });
    render(<NewSessionModal onClose={vi.fn()} />);
    expect(screen.queryByLabelText('Подписка')).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Первое сообщение'), 'привет');
    await userEvent.click(screen.getByRole('button', { name: 'Запустить' }));
    await vi.waitFor(() => expect(calls.find(c => c.method === 'POST')).toBeDefined());
    expect(calls.find(c => c.method === 'POST')!.body).not.toHaveProperty('subscriptionId');
  });

  it('Предвыбор в форме: the last choice B is selected, a limit is marked; the start goes with the chosen id', async () => {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    base(subsResponse({ subscriptions: [subView({ limitResetsAt: until }), subView({ id: SUB_B, name: 'Pro рабочая', position: 1 })], lastChoiceId: SUB_B, defaultId: SUB_B, connectorsHint: true }));
    const calls = mockFetch({ 'POST /api/sessions': () => ({ status: 201, body: session() }) });
    render(<NewSessionModal onClose={vi.fn()} />);
    const field = screen.getByLabelText('Подписка');
    expect(field).toHaveValue(SUB_B);
    expect(
      within(field)
        .getAllByRole('option')
        .map(o => o.textContent),
    ).toEqual([expect.stringMatching(/^Max личная \(лимит до \d\d:\d\d\)$/), 'Pro рабочая']);
    expect(screen.getByText(connectorsHint())).toBeInTheDocument();
    // another window changed the last choice: the untouched form follows it
    act(() => useStore.setState({ subs: subsResponse({ lastChoiceId: SUB_A, defaultId: SUB_A }) }));
    expect(field).toHaveValue(SUB_A);
    await userEvent.selectOptions(field, SUB_B);
    await userEvent.type(screen.getByLabelText('Первое сообщение'), 'привет');
    await userEvent.click(screen.getByRole('button', { name: 'Запустить' }));
    await vi.waitFor(() => expect(calls.find(c => c.method === 'POST')?.body).toMatchObject({ subscriptionId: SUB_B, runnerId: 'x1' }));
  });

  it('Устаревший агент: a hint instead of the field, no subscriptionId', async () => {
    base();
    useStore.setState({ runners: [runner({ protocolVersion: '1.3' })] });
    const calls = mockFetch({ 'POST /api/sessions': () => ({ status: 201, body: session() }) });
    render(<NewSessionModal onClose={vi.fn()} />);
    expect(screen.queryByRole('combobox', { name: 'Подписка' })).not.toBeInTheDocument();
    expect(screen.getByText('Агент на X1 устарел — сессия пойдёт под входом машины — обновите агента')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Первое сообщение'), 'привет');
    await userEvent.click(screen.getByRole('button', { name: 'Запустить' }));
    await vi.waitFor(() => expect(calls.find(c => c.method === 'POST')).toBeDefined());
    expect(calls.find(c => c.method === 'POST')!.body).not.toHaveProperty('subscriptionId');
  });

  it('Выбранная подписка выведена: 422 subscription_unavailable — the list is reloaded and the text is under the field', async () => {
    base();
    const calls = mockFetch({
      'POST /api/sessions': () => ({ status: 422, body: { error: 'subscription_unavailable' } }),
      'GET /api/subscriptions': () => ({
        status: 200,
        body: subsResponse({ subscriptions: [subView({ retired: true }), subView({ id: SUB_B, name: 'Pro рабочая', position: 1 })], defaultId: SUB_B }),
      }),
    });
    const onClose = vi.fn();
    render(<NewSessionModal onClose={onClose} />);
    await userEvent.type(screen.getByLabelText('Первое сообщение'), 'привет');
    await userEvent.click(screen.getByRole('button', { name: 'Запустить' }));
    // M2: the text names the subscription that left and the one the field shows now, not a bare error next to it
    expect(await screen.findByText('Подписка «Max личная» недоступна — выбрана «Pro рабочая», проверьте и запустите снова')).toBeInTheDocument();
    await vi.waitFor(() => expect(screen.getByLabelText('Подписка')).toHaveValue(SUB_B));
    // a new pick clears it
    await userEvent.selectOptions(screen.getByLabelText('Подписка'), SUB_B);
    expect(screen.queryByText(/недоступна/)).not.toBeInTheDocument();
    expect(calls.some(c => c.url === '/api/subscriptions')).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Явный выбор выведен в другом окне: no silent replacement — a disabled «(выведена)» option, the text, «Запустить» blocked until a new pick', async () => {
    base();
    const calls = mockFetch({ 'POST /api/sessions': () => ({ status: 201, body: session() }) });
    render(<NewSessionModal onClose={vi.fn()} />);
    const field = screen.getByLabelText('Подписка') as HTMLSelectElement;
    await userEvent.selectOptions(field, SUB_B);
    await userEvent.type(screen.getByLabelText('Первое сообщение'), 'привет');
    // subscriptions.changed from another window: «Pro рабочая» retired
    act(() => useStore.setState({ subs: subsResponse({ subscriptions: [subView(), subView({ id: SUB_B, name: 'Pro рабочая', position: 1, retired: true })] }) }));
    expect(field).toHaveValue(SUB_B);
    expect(field.selectedOptions[0]).toBeDisabled();
    expect(field.selectedOptions[0]).toHaveTextContent('Pro рабочая (выведена)');
    expect(screen.getByText('Подписка «Pro рабочая» выведена — выберите другую')).toBeInTheDocument();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Запустить' })).toBeDisabled();
    // Ctrl+Enter does not get around it
    await userEvent.type(screen.getByLabelText('Первое сообщение'), '{Control>}{Enter}{/Control}');
    expect(calls.some(c => c.method === 'POST')).toBe(false);
    await userEvent.selectOptions(field, SUB_A);
    expect(screen.queryByText(/выведена — выберите другую/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Запустить' }));
    await vi.waitFor(() => expect(calls.find(c => c.method === 'POST')?.body).toMatchObject({ subscriptionId: SUB_A }));
  });

  it('Автопредвыбор (поле не трогали) по-прежнему тихо следует за умолчанием хаба', () => {
    base();
    render(<NewSessionModal onClose={vi.fn()} />);
    expect(screen.getByLabelText('Подписка')).toHaveValue(SUB_A);
    act(() => useStore.setState({ subs: subsResponse({ subscriptions: [subView({ retired: true }), subView({ id: SUB_B, name: 'Pro рабочая', position: 1 })], defaultId: SUB_B }) }));
    expect(screen.getByLabelText('Подписка')).toHaveValue(SUB_B);
    expect(screen.queryByText(/выведена/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Запустить' })).toBeEnabled();
  });

  it('Handoff: an explicit choice retired meanwhile blocks «Запустить handoff»', async () => {
    base();
    const src = session({ title: 'Исходная' });
    useStore.getState().upsertSessions([src]);
    mockFetch({ 'POST /api/sessions/': () => ({ status: 202, body: { id: '00000000-0000-4000-9000-000000000001', status: 'pending' } }) });
    render(<ForkModal sessionId={src.id} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('radio', { name: /Handoff/ }));
    await userEvent.selectOptions(screen.getByLabelText('Подписка'), SUB_B);
    act(() => useStore.setState({ subs: subsResponse({ subscriptions: [subView(), subView({ id: SUB_B, name: 'Pro рабочая', position: 1, retired: true })] }) }));
    expect(screen.getByText('Подписка «Pro рабочая» выведена — выберите другую')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Запустить handoff' })).toBeDisabled();
  });

  it('C3: the preselected last choice stays, a known limit or a rejected token is a warning under the field', async () => {
    const until = new Date(Date.now() + 2 * 3_600_000);
    base(
      subsResponse({
        subscriptions: [
          subView({ limitResetsAt: until.toISOString() }),
          subView({ id: SUB_B, name: 'Pro рабочая', position: 1, tokenRejected: true }),
          subView({ id: SUB_C, name: 'Третья', position: 2 }),
        ],
        lastChoiceId: SUB_A,
        defaultId: SUB_A,
      }),
    );
    render(<NewSessionModal onClose={vi.fn()} />);
    const field = screen.getByLabelText('Подписка');
    expect(field).toHaveValue(SUB_A);
    const warn = screen.getByText(/^Лимит до \d\d:\d\d — первый ход упрётся в лимит$/);
    expect(warn).toHaveClass('sub-warn', 'warn');
    expect(field.getAttribute('aria-describedby')).toContain(warn.id);
    await userEvent.selectOptions(field, SUB_B);
    expect(screen.getByText('Токен отклонён — замените токен')).toHaveClass('sub-warn', 'bad');
    await userEvent.selectOptions(field, SUB_C);
    expect(document.querySelector('.sub-warn')).toBeNull();
  });

  it('Handoff под другой подпиской: the handoff form has the field, the copy does not', async () => {
    base();
    const src = session({ title: 'Исходная' });
    useStore.getState().upsertSessions([src]);
    const calls = mockFetch({
      'POST /api/sessions/': (_i, url) =>
        url?.endsWith('/handoff-drafts') ? { status: 202, body: { id: '00000000-0000-4000-9000-000000000001', status: 'pending' } } : { status: 201, body: session() },
    });
    render(<ForkModal sessionId={src.id} onClose={vi.fn()} />);
    expect(screen.queryByLabelText('Подписка')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: /Handoff/ }));
    await userEvent.selectOptions(screen.getByLabelText('Подписка'), SUB_B);
    await userEvent.type(screen.getByLabelText('Промпт для новой сессии'), 'продолжи');
    await userEvent.click(screen.getByRole('button', { name: 'Запустить handoff' }));
    await vi.waitFor(() => expect(calls.find(c => c.url.endsWith('/fork'))?.body).toMatchObject({ mode: 'handoff', subscriptionId: SUB_B }));
  });
});

function showChat(s: SessionView, events: HubEvent[] = []) {
  useStore.getState().upsertSessions([s]);
  useStore.setState({ logs: { [s.id]: { events, before: null, loaded: true, loading: false, error: null } } });
  return render(
    <>
      <Chat session={s} paneId="p1" />
      <SwitchConfirm />
    </>,
  );
}

const headSelect = () => document.querySelector<HTMLSelectElement>('.chat-head .ctl-inline select[aria-label^="Подписка"]');

describe('«Подписка» in the tab head', () => {
  beforeEach(() => {
    resetStore();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 0, 15, 10, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('Пустой реестр: no switch in the head', () => {
    base(subsResponse({ subscriptions: [], defaultId: null }));
    showChat(session({ subscriptionMode: 'none', subscription: null }));
    expect(headSelect()).toBeNull();
  });

  it('Переключение в ждущей сессии: the request goes without interrupt', async () => {
    base();
    const s = session({ status: 'waiting', processAlive: true, subscription: { id: SUB_A, name: 'Max личная' }, subscriptionMode: 'subscription' });
    const calls = mockFetch({ 'POST /api/sessions/': () => ({ status: 202, body: { session: { ...s, subscription: { id: SUB_B, name: 'Pro рабочая' } } } }) });
    showChat(s);
    expect(headSelect()).toHaveValue(SUB_A);
    expect(headSelect()).toHaveAccessibleName('Подписка');
    await userEvent.selectOptions(headSelect()!, SUB_B);
    await vi.waitFor(() => expect(calls.find(c => c.url.endsWith('/subscription'))?.body).toEqual({ subscriptionId: SUB_B }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('Переключение посреди хода: 409 → «Идёт ход: прервать и переключить?»; «Отмена» changes nothing, confirming repeats with interrupt', async () => {
    base();
    const s = session({ status: 'working', processAlive: true, subscription: { id: SUB_A, name: 'Max личная' }, subscriptionMode: 'subscription' });
    let n = 0;
    const calls = mockFetch({ 'POST /api/sessions/': () => (++n === 1 || n === 2 ? { status: 409, body: { error: 'turn_in_progress' } } : { status: 202, body: { session: s } }) });
    showChat(s);
    await userEvent.selectOptions(headSelect()!, SUB_B);
    const dlg = await screen.findByRole('alertdialog', { name: 'Идёт ход: прервать и переключить?' });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Отмена' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(headSelect()).toHaveValue(SUB_A);
    await userEvent.selectOptions(headSelect()!, SUB_B);
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Прервать и переключить' }));
    await vi.waitFor(() =>
      expect(calls.filter(c => c.url.endsWith('/subscription')).map(c => c.body)).toEqual([{ subscriptionId: SUB_B }, { subscriptionId: SUB_B }, { subscriptionId: SUB_B, interrupt: true }]),
    );
    await vi.waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('Работает в фоне: a waiting session with working subagents gets «Работает в фоне: остановить и переключить?», confirming repeats with interrupt', async () => {
    base();
    const s = session({ status: 'waiting', processAlive: true, subscription: { id: SUB_A, name: 'Max личная' }, subscriptionMode: 'subscription', subagents: { total: 2, running: 1, working: 2 } });
    let n = 0;
    const calls = mockFetch({ 'POST /api/sessions/': () => (++n === 1 ? { status: 409, body: { error: 'turn_in_progress' } } : { status: 202, body: { session: s } }) });
    showChat(s);
    await userEvent.selectOptions(headSelect()!, SUB_B);
    const dlg = await screen.findByRole('alertdialog', { name: 'Работает в фоне: остановить и переключить?' });
    expect(dlg).toHaveTextContent('Фоновые задачи сессии будут остановлены');
    expect(within(dlg).queryByRole('button', { name: 'Прервать и переключить' })).not.toBeInTheDocument();
    const go = within(dlg).getByRole('button', { name: 'Остановить и переключить' });
    expect(go).toHaveClass('btn', 'danger');
    expect(within(dlg).getByRole('button', { name: 'Отмена' })).toHaveFocus();
    await userEvent.click(go);
    await vi.waitFor(() => expect(calls.filter(c => c.url.endsWith('/subscription')).map(c => c.body)).toEqual([{ subscriptionId: SUB_B }, { subscriptionId: SUB_B, interrupt: true }]));
  });

  it('Спящая сессия: «продолжит под» the last choice; a read-only session and an offline machine cannot switch; agent 1.3 — «вход машины»', () => {
    base(subsResponse({ lastChoiceId: SUB_B, defaultId: SUB_B }));
    const v = showChat(session({ status: 'sleeping', processAlive: false, subscription: { id: SUB_A, name: 'Max личная' }, subscriptionMode: 'subscription' }));
    expect(headSelect()).toHaveValue(SUB_B);
    expect(headSelect()).toHaveAccessibleName('Подписка: продолжит под');
    expect(document.querySelector('.chat-head .sub-next')).toHaveTextContent('продолжит под');
    expect(headSelect()).toBeEnabled();
    v.unmount();
    const v2 = showChat(session({ readOnlyReason: 'cron', isCron: true, processAlive: false, status: 'closed' }));
    expect(headSelect()).toBeDisabled();
    v2.unmount();
    const v3 = showChat(session({ runnerId: 'hp', processAlive: false, status: 'sleeping' }));
    expect(headSelect()).toBeNull();
    expect(document.querySelector('.chat-head .sub-login')).toHaveTextContent('вход машины');
    v3.unmount();
    useStore.setState({ runners: R14.map(r => (r.id === 'x1' ? { ...r, online: false } : r)) });
    showChat(session({ processAlive: false, status: 'sleeping' }));
    expect(headSelect()).toBeDisabled();
  });

  it('C1/H5/M5: «⋯» closes on a pick (the dialog is not under it), the disabled select names why, options are short', async () => {
    const until = new Date(Date.now() + 2 * 3_600_000).toISOString();
    base(subsResponse({ subscriptions: [subView(), subView({ id: SUB_B, name: 'Pro рабочая', position: 1, limitResetsAt: until })] }));
    const s = session({ status: 'working', processAlive: true, subscription: { id: SUB_A, name: 'Max личная' }, subscriptionMode: 'subscription' });
    mockFetch({ 'POST /api/sessions/': () => ({ status: 409, body: { error: 'turn_in_progress' } }) });
    showChat(s);
    await userEvent.click(screen.getAllByRole('button', { name: 'Меню сессии' })[0]!);
    const menu = screen.getByRole('menu', { name: 'Меню сессии' });
    const sel = within(menu).getByLabelText('Подписка') as HTMLSelectElement;
    expect([...sel.options].map(o => o.textContent)).toEqual(['Max личная', expect.stringMatching(/^Pro рабочая · до \d\d:\d\d$/)]);
    await userEvent.selectOptions(sel, SUB_B);
    expect(screen.queryByRole('menu', { name: 'Меню сессии' })).not.toBeInTheDocument();
    expect(await screen.findByRole('alertdialog', { name: 'Идёт ход: прервать и переключить?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Прервать и переключить' })).toHaveClass('btn', 'danger');
    expect(screen.getByRole('button', { name: 'Отмена' })).toHaveFocus();
  });

  it('H5: in «⋯» a disabled select says why', async () => {
    base();
    useStore.setState({ runners: R14.map(r => (r.id === 'x1' ? { ...r, online: false } : r)) });
    showChat(session({ processAlive: false, status: 'sleeping' }));
    await userEvent.click(screen.getAllByRole('button', { name: 'Меню сессии' })[0]!);
    const menu = screen.getByRole('menu', { name: 'Меню сессии' });
    expect(within(menu).getByLabelText(/^Подписка/)).toBeDisabled();
    expect(menu.querySelector('.sub-why')).toHaveTextContent(/не в сети|только для чтения/);
  });

  it('a live session under the machine login shows «вход машины» as its current value', () => {
    base();
    showChat(session({ processAlive: true, subscription: null, subscriptionMode: 'machine_login' }));
    expect(headSelect()).toHaveValue('');
    expect(headSelect()!.selectedOptions[0]).toHaveTextContent('вход машины');
  });

  it('a live process under a subscription retired since: the select shows its name as a disabled option, the active ones stay pickable', () => {
    base(subsResponse({ subscriptions: [subView(), subView({ id: SUB_B, name: 'Pro рабочая', position: 1 }), subView({ id: SUB_C, name: 'Старая', position: 2, retired: true })] }));
    showChat(session({ status: 'waiting', processAlive: true, subscription: { id: SUB_C, name: 'Старая' }, subscriptionMode: 'subscription' }));
    expect(headSelect()).toHaveValue(SUB_C);
    const cur = headSelect()!.selectedOptions[0]!;
    expect(cur).toHaveTextContent('Старая');
    expect(cur).toBeDisabled();
    expect([...headSelect()!.options].filter(o => !o.disabled).map(o => o.value)).toEqual([SUB_A, SUB_B]);
  });

  it('a tab opened before the first subscription was added (mode none) gets the switch once the registry has one', () => {
    base();
    showChat(session({ status: 'waiting', processAlive: true, subscription: null, subscriptionMode: 'none' }));
    expect(headSelect()).toHaveValue('');
    expect(headSelect()!.selectedOptions[0]).toHaveTextContent('вход машины');
  });
});

const note = (id: string, text: string, subscription: Extract<HubEvent, { kind: 'note' }>['subscription']): HubEvent => ({ kind: 'note', id, ts: '2026-10-27T05:00:00Z', text, subscription });

describe('subscription notes in the chat', () => {
  beforeEach(() => {
    resetStore();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 0, 15, 10, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('лимит, токен отклонён и автопереключение; «Продолжить под другой подпиской» switches with repeatLast', async () => {
    base(subsResponse({ subscriptions: [subView(), subView({ id: SUB_B, name: 'Pro рабочая', position: 1 }), subView({ id: SUB_C, name: 'Третья', position: 2, retired: true })] }));
    const resetsAt = new Date(2026, 9, 27, 3, 40).toISOString();
    const s = session({ status: 'waiting', processAlive: true, subscription: { id: SUB_A, name: 'Max личная' }, subscriptionMode: 'subscription' });
    const calls = mockFetch({ 'POST /api/sessions/': () => ({ status: 202, body: { session: s } }) });
    showChat(s, [
      note('n:1', 'hub text limit', { kind: 'limit', subscriptionId: SUB_A, resetsAt, alternatives: [SUB_B, SUB_C] }),
      note('n:2', 'hub text auth', { kind: 'auth', subscriptionId: SUB_B, alternatives: [] }),
      note('n:3', 'Автопереключение: Max личная → Pro рабочая', { kind: 'switch', subscriptionId: SUB_B }),
    ]);
    const limit = screen.getByText(/^Лимит подписки Max личная исчерпан, сброс в /).closest('.sysnote')!;
    expect(limit).toHaveTextContent(/сброс в (27\.10 )?03:40/);
    const auth = screen.getByText('Подписка Pro рабочая: токен отклонён — выпустите новый claude setup-token и замените токен в настройках').closest('.sysnote')!;
    // H2: no alternatives — no switch, but the token can be replaced from the note
    expect(
      within(auth as HTMLElement)
        .getAllByRole('button')
        .map(b => b.textContent),
    ).toEqual(['Заменить токен']);
    const sw = screen.getByText('Автопереключение: Max личная → Pro рабочая').closest('.sysnote')!;
    expect(within(sw as HTMLElement).queryByRole('button')).not.toBeInTheDocument();
    await userEvent.click(within(limit as HTMLElement).getByRole('button', { name: 'Продолжить под другой подпиской' }));
    const menu = screen.getByRole('menu', { name: 'Продолжить под подпиской' });
    // the retired alternative is not offered
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map(b => b.textContent),
    ).toEqual(['Pro рабочая']);
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Pro рабочая' }));
    await vi.waitFor(() => expect(calls.find(c => c.url.endsWith('/subscription'))?.body).toEqual({ subscriptionId: SUB_B, repeatLast: true }));
    // P12 / 10.3: «Заменить токен» opens «Настройки → Подписки» with the token form of this subscription, focus in it
    await userEvent.click(within(auth as HTMLElement).getByRole('button', { name: 'Заменить токен' }));
    expect(useStore.getState().settings).toBe('subscriptions');
    expect(window.location.pathname).toBe('/settings/subscriptions');
    expect(useStore.getState().modal).toBeNull();
    render(<Settings />);
    const field = screen.getByLabelText(/Новый токен «Pro рабочая»/);
    expect(document.activeElement).toBe(field);
    expect(screen.queryByLabelText(/Новый токен «Max личная»/)).not.toBeInTheDocument();
    window.history.replaceState(null, '', '/');
  });

  it('H2: no «Заменить токен» in a read-only chat or while the hub keeps no tokens', () => {
    base(subsResponse({ enabled: false }));
    showChat(session({}), [note('n:1', 'x', { kind: 'auth', subscriptionId: SUB_A, alternatives: [] })]);
    expect(screen.queryByRole('button', { name: 'Заменить токен' })).not.toBeInTheDocument();
  });

  it('Других подписок нет: the limit note has no button; an unknown subscription falls back to the hub text', () => {
    base(subsResponse({ subscriptions: [subView()] }));
    showChat(session({}), [
      note('n:1', 'x', { kind: 'limit', subscriptionId: SUB_A, alternatives: [] }),
      note('n:2', 'Лимит подписки Старая исчерпан', { kind: 'limit', subscriptionId: '00000000-0000-4000-a000-0000000000ee' }),
    ]);
    expect(screen.getByText('Лимит подписки Max личная исчерпан')).toBeInTheDocument();
    expect(screen.getByText('Лимит подписки Старая исчерпан')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Продолжить под другой подпиской' })).not.toBeInTheDocument();
  });
});
