// Component tests of the chat (task 2.11) rendered from real `.jsonl` lines (fixtures/real-session.jsonl).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HubEvent, SessionView } from '../../api/types';
import { useStore } from '../../store';
import { RUNNERS, mockFetch, resetStore, session } from '../../test/factories';
import { handleServerMessage } from '../workspace/actions';
import { Chat } from './Chat';
import { fixtureEvents } from './fixtures';
import { ApiError } from '../../api/client';
import type { Recording } from '../voice/recorder';
import { resetVoice, useVoice, voiceDeps } from '../voice/voice';
import { resetTalk, talkDeps, useTalk, type TalkCallbacks } from '../voice/talk';
import { chooseLocale, initLocale } from '../../i18n';

function show(s: SessionView, events: HubEvent[] = fixtureEvents()) {
  useStore.setState({
    runners: RUNNERS,
    models: [
      { value: 'opus', displayName: 'Opus 5.5' },
      { value: 'sonnet', displayName: 'Sonnet 5.5' },
    ],
  });
  useStore.getState().upsertSessions([s]);
  useStore.setState({ logs: { [s.id]: { events, before: null, loaded: true, loading: false, error: null } } });
  const view = render(<Chat session={s} paneId="p1" />);
  return {
    ...view,
    rerenderWith: (next: SessionView) => {
      useStore.getState().upsertSessions([next]);
      view.rerender(<Chat session={next} paneId="p1" />);
    },
  };
}

const permEvent = (resolved = false): HubEvent => ({
  kind: 'permission',
  id: 'p:r1',
  ts: '2026-10-25T05:00:00Z',
  request: {
    requestId: 'r1',
    sessionId: 'x',
    toolName: 'Bash',
    toolUseId: 't1',
    input: { command: 'npm run crawl -- --dry-run' },
    createdAt: '2026-10-25T05:00:00Z',
    resolvedAt: resolved ? '2026-10-25T05:01:00Z' : null,
    decision: resolved ? 'allow' : null,
    message: null,
    kind: 'tool',
  },
});

describe('Chat on real transcript lines', () => {
  beforeEach(resetStore);
  afterEach(() => vi.unstubAllGlobals());

  it('renders the user message, collapsed tool calls with targets, Markdown answer, notes; hides thinking and meta lines', () => {
    show(session({ title: 'Demo' }));
    expect(screen.getByText(/Сделай прототип страницы приложений/)).toBeInTheDocument();
    const tools = document.querySelectorAll('details.tool');
    expect([...tools].map(t => t.querySelector('.tname')!.textContent)).toEqual(['Bash', 'Edit', 'Write']);
    expect(tools[0]!.querySelector('.ttarget')).toHaveTextContent('List guides and notes');
    expect(tools[0]).not.toHaveAttribute('open');
    // Markdown: bold and list items become elements
    expect(screen.getByText('Что можно пройти руками:').tagName).toBe('STRONG');
    expect(document.querySelectorAll('.bubble.md li').length).toBeGreaterThan(5);
    expect(screen.getByText('Ход прерван')).toHaveClass('sysnote');
    expect(screen.getByText('Контекст сжат')).toHaveClass('sysnote');
    expect(screen.queryByText(/\[Image: original/)).not.toBeInTheDocument();
  });

  it('a language switch re-renders the hub notes of an open chat', async () => {
    const note = { kind: 'note', id: 'n:1', ts: '2026-11-06T10:00:00Z', text: 'Поднята через resume', i18n: { key: 'hub.sessions.noteResumed' } } as HubEvent;
    show(session(), [note]);
    expect(screen.getByText('Поднята через resume')).toHaveClass('sysnote');
    try {
      await act(() => chooseLocale('en'));
      expect(screen.getByText('Resumed')).toHaveClass('sysnote');
    } finally {
      await act(() => initLocale('ru'));
    }
  });

  it('Дифф правки: the Edit row holds added/removed lines; Bash shows the command and its output', () => {
    show(session());
    const [bash, edit] = [...document.querySelectorAll('details.tool')];
    expect(edit!.querySelectorAll('.del')).toHaveLength(1);
    expect(edit!.querySelector('.hunk')).toHaveTextContent('@@ -710,7 +710,6 @@');
    expect(bash!.textContent).toContain('$ cd /c/Users/alice/projects/demo');
    expect(bash!.textContent).toContain('guide-setup.md');
  });

  it('a session imported from Drive says «из Drive» in the header; a live one does not', () => {
    const { unmount } = show(session({ isDriveImport: true, source: 'terminal', originSource: 'terminal' }), []);
    expect(document.querySelector('.chat-head .drive-tag')).toHaveTextContent('из Drive');
    unmount();
    show(session({ source: 'terminal', originSource: 'terminal' }), []);
    expect(document.querySelector('.chat-head .drive-tag')).toBeNull();
  });

  it('raw HTML in assistant text is not rendered', () => {
    const line = { type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'a <img src=x onerror=alert(1)> b' }] } };
    show(session(), [{ kind: 'line', id: 'l', ts: '', line }]);
    expect(document.querySelector('.bubble img')).toBeNull();
  });
});

describe('Chat: permission card', () => {
  beforeEach(resetStore);
  afterEach(() => vi.unstubAllGlobals());

  it('three buttons; «Разрешать в этой сессии» posts allow_session; the card turns into a note', async () => {
    const s = session({ status: 'permission', permissionMode: 'default' });
    const resolved = { ...permEvent(true), request: { ...(permEvent(true) as Extract<HubEvent, { kind: 'permission' }>).request, decision: 'allow_session' as const } };
    const calls = mockFetch({ 'POST /api/sessions/': () => ({ status: 200, body: { request: resolved.request } }) });
    show(s, [permEvent()]);
    const card = screen.getByRole('group', { name: 'Запрос разрешения: Bash' });
    expect(
      within(card)
        .getAllByRole('button')
        .map(b => b.textContent),
    ).toEqual(['Разрешить', 'Разрешать в этой сессии', 'Запретить']);
    expect(card).toHaveTextContent('$ npm run crawl -- --dry-run');
    await userEvent.click(within(card).getByRole('button', { name: 'Разрешать в этой сессии' }));
    expect(calls[0]).toMatchObject({ url: `/api/sessions/${s.id}/permissions/r1`, method: 'POST', body: { decision: 'allow_session' } });
    expect(await screen.findByText('Bash: разрешено в этой сессии')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /Запрос разрешения/ })).not.toBeInTheDocument();
  });

  it('Решение на другом устройстве: permission.resolved closes the card', () => {
    const s = session({ status: 'permission' });
    show(s, [permEvent()]);
    act(() => handleServerMessage({ type: 'permission.resolved', sessionId: s.id, requestId: 'r1', decision: 'deny' }));
    expect(screen.getByText('Bash: запрещено')).toBeInTheDocument();
  });

  it('permission.request adds a card live', () => {
    const s = session({ status: 'working' });
    show(s, []);
    const req = (permEvent() as Extract<HubEvent, { kind: 'permission' }>).request;
    act(() => handleServerMessage({ type: 'permission.request', sessionId: s.id, request: req }));
    expect(screen.getByRole('group', { name: 'Запрос разрешения: Bash' })).toBeInTheDocument();
  });
});

describe('Chat: UI review 2.15', () => {
  beforeEach(resetStore);
  afterEach(() => vi.unstubAllGlobals());

  it('H4: the idle menu marks the timeout the hub applies, closes on Esc and on a click outside, focuses the checked item', async () => {
    const s = session({ status: 'permission', idleTimeoutMin: null, effectiveIdleTimeoutMin: 120 });
    show(s, []);
    await userEvent.click(screen.getByRole('button', { name: 'усыплять через 2 ч' }));
    const checked = screen.getByRole('menuitemradio', { checked: true });
    expect(checked).toHaveTextContent('через 2 ч');
    expect(checked).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'усыплять через 2 ч' }));
    await userEvent.click(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('H4: a sleeping or closed session shows «усыплять через N» without a countdown', () => {
    show(session({ status: 'closed', source: 'terminal', effectiveIdleTimeoutMin: 30, sleepsAt: null }), []);
    expect(screen.getByRole('button', { name: 'усыплять через 30 мин' })).toBeInTheDocument();
  });

  it('M2: «Отправить» is disabled while the draft is empty; with the sleep banner it is not primary until there is text', async () => {
    const s = session({ status: 'sleeping', processAlive: false, sleptAt: new Date().toISOString() });
    show(s, []);
    const send = screen.getByRole('button', { name: 'Отправить' });
    expect(send).toBeDisabled();
    expect(send).not.toHaveClass('primary');
    expect(screen.getByRole('button', { name: 'Продолжить' })).toHaveClass('primary');
    await userEvent.type(screen.getByRole('textbox', { name: 'Сообщение' }), 'ещё');
    expect(send).toBeEnabled();
    expect(send).toHaveClass('primary');
  });

  it('H1: mode and model are also reachable through «⋯» (shown instead of the selects in a narrow pane)', async () => {
    const s = session();
    const calls = mockFetch({ 'PATCH /api/sessions/': init => ({ status: 200, body: { ...s, ...JSON.parse(String(init!.body)) } }) });
    show(s, []);
    await userEvent.click(screen.getByRole('button', { name: 'Режим прав и модель' }));
    const menu = screen.getByRole('menu', { name: 'Режим прав и модель' });
    await userEvent.selectOptions(within(menu).getByRole('combobox', { name: 'Режим прав' }), 'plan');
    expect(calls[0]!.body).toEqual({ permissionMode: 'plan' });
  });

  it('M4b: «⑂ Форк» in the head opens the fork form of this session', async () => {
    const s = session();
    show(s, []);
    await userEvent.click(screen.getByRole('button', { name: '⑂ Форк' }));
    expect(useStore.getState().modal).toEqual({ type: 'fork', sessionId: s.id });
  });
});

describe('Chat: banners, header and composer', () => {
  beforeEach(resetStore);
  afterEach(() => vi.unstubAllGlobals());

  it('session header shows the catalog project and opens its sidebar group', async () => {
    const id = 'ef6c84c5-9850-4aa6-84d1-43010a68266f';
    const s = session({ project: { id, title: 'Agent Hub', colorKey: 'none', path: '' }, catalogProject: { id, name: 'Agent Hub' } });
    show(s, []);
    await userEvent.click(screen.getByRole('button', { name: 'Agent Hub' }));
    expect(useStore.getState().openProjects[id]).toBe(true);
  });

  it('Ответ появляется потоком: «Claude работает…», partial text, «Прервать»; the final line replaces the partial', () => {
    const s = session({ status: 'working' });
    show(s, []);
    expect(document.querySelector('.thinking')).toHaveTextContent('Запускаем на X1');
    expect(screen.getByRole('button', { name: 'Прервать' })).toBeInTheDocument();
    act(() => handleServerMessage({ type: 'session.partial', sessionId: s.id, messageId: 'm1', blockIndex: 0, textDelta: 'Привет, ' }));
    act(() => handleServerMessage({ type: 'session.partial', sessionId: s.id, messageId: 'm1', blockIndex: 0, textDelta: 'мир' }));
    expect(screen.getByText('Привет, мир')).toBeInTheDocument();
    act(() =>
      handleServerMessage({
        type: 'session.events',
        sessionId: s.id,
        events: [{ kind: 'line', id: 'l:1', ts: '', line: { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Привет, мир!' }] } } }],
      }),
    );
    expect(screen.queryByText('Привет, мир')).not.toBeInTheDocument();
    expect(screen.getByText('Привет, мир!')).toBeInTheDocument();
  });

  it('«Прервать» is available while the turn waits for a permission', () => {
    show(session({ status: 'permission' }), [permEvent()]);
    expect(screen.getByRole('button', { name: 'Прервать' })).toBeInTheDocument();
  });

  it('subagents working while the session waits: «Работают субагенты: N» with the animation, no «Прервать»', () => {
    show(session({ status: 'waiting', subagents: { total: 3, running: 3, working: 2 } as never }));
    expect(document.querySelector('.thinking')).toHaveTextContent('Работает в фоне: 2');
    expect(document.querySelector('.thinking .g-work')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Прервать' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Сообщение' })).toBeEnabled();
  });

  it('no indicator with idle teammates only; a permission with working subagents keeps «Прервать»', () => {
    const { unmount } = show(session({ status: 'waiting', subagents: { total: 1, running: 1, working: 0 } as never }));
    expect(document.querySelector('.thinking')).toBeNull();
    unmount();
    show(session({ status: 'permission', subagents: { total: 1, running: 1, working: 1 } as never }), [permEvent()]);
    expect(screen.getByRole('button', { name: 'Прервать' })).toBeInTheDocument();
  });

  it('Enter sends, Shift+Enter makes a newline', async () => {
    const s = session();
    const calls = mockFetch({ 'POST /api/sessions/': () => ({ status: 202, body: { session: { ...s, status: 'working' } } }) });
    show(s, []);
    const box = screen.getByRole('textbox', { name: 'Сообщение' });
    await userEvent.type(box, 'строка 1{Shift>}{Enter}{/Shift}строка 2');
    expect(box).toHaveValue('строка 1\nстрока 2');
    await userEvent.type(box, '{Enter}');
    // The send is async: under a loaded full run the request may land a tick later.
    await vi.waitFor(() => expect(calls[0]).toBeDefined());
    expect(calls[0]).toMatchObject({ url: `/api/sessions/${s.id}/messages`, method: 'POST', body: { text: 'строка 1\nстрока 2' } });
    expect((calls[0]!.body as { clientUuid: string }).clientUuid).toMatch(/^[0-9a-f-]{36}$/);
    await vi.waitFor(() => expect(box).toHaveValue(''));
  });

  it('Засыпание: «уснёт через N мин» while waiting; the menu sets the timeout', async () => {
    const s = session({ status: 'waiting', sleepsAt: new Date(Date.now() + 14.5 * 60_000).toISOString() });
    const calls = mockFetch({ 'PATCH /api/sessions/': () => ({ status: 200, body: { ...s, idleTimeoutMin: 15 } }) });
    show(s, []);
    await userEvent.click(screen.getByRole('button', { name: 'уснёт через 15 мин' }));
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'через 15 мин' }));
    expect(calls[0]).toMatchObject({ method: 'PATCH', body: { idleTimeoutMin: 15 } });
  });

  it('Отсчёт до сна: 14 мин 54 с → «15»; at 13 мин 59 с «14» within 1 s; visibilitychange recounts', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    try {
      const t0 = Date.parse('2026-10-25T12:00:00Z');
      vi.setSystemTime(t0);
      const s = session({ status: 'waiting', sleepsAt: new Date(t0 + (14 * 60 + 54) * 1000).toISOString() });
      show(s, []);
      expect(screen.getByRole('button', { name: 'уснёт через 15 мин' })).toBeInTheDocument();
      // 55 s later 13:59 remain → «14» not later than 1 s after the boundary
      act(() => vi.advanceTimersByTime(54_000));
      expect(screen.getByRole('button', { name: 'уснёт через 15 мин' })).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1_000));
      expect(screen.getByRole('button', { name: 'уснёт через 14 мин' })).toBeInTheDocument();
      // a hidden page whose timers did not run: the time jumps, visibilitychange recounts
      vi.setSystemTime(t0 + (14 * 60 + 54 - (8 * 60 + 30)) * 1000); // 8 мин 30 с remain
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      expect(screen.getByRole('button', { name: 'уснёт через 9 мин' })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Спит: banner «Спит с HH:MM», «Продолжить» calls wake', async () => {
    const s = session({ status: 'sleeping', processAlive: false, sleptAt: new Date().toISOString() });
    const calls = mockFetch({ 'POST /api/sessions/': () => ({ status: 202, body: { session: { ...s, status: 'waiting' } } }) });
    show(s, []);
    expect(screen.getByRole('status')).toHaveTextContent(/Спит с \d\d:\d\d\. Процесс завершён, история на диске/);
    expect(screen.getByRole('textbox', { name: 'Сообщение' })).toHaveAttribute('placeholder', 'Сообщение поднимет сессию через resume…');
    await userEvent.click(screen.getByRole('button', { name: 'Продолжить' }));
    expect(calls[0]!.url).toBe(`/api/sessions/${s.id}/wake`);
  });

  it('Офлайн: banner with the machine and time, input «Недоступно», mode/model disabled', () => {
    const s = session({ runnerId: 'hp' });
    show(s, []);
    expect(screen.getByRole('status')).toHaveTextContent(/HP не в сети с .*История — из копии в хабе/);
    // M4b: the offline banner offers a handoff (spec sessions «Офлайн-машина»)
    expect(screen.getByRole('button', { name: 'Handoff на другую машину' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Сообщение' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Сообщение' })).toHaveAttribute('placeholder', 'Недоступно');
    expect(screen.getByRole('combobox', { name: 'Режим прав' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Модель' })).toBeDisabled();
  });

  it('Офлайн: a closed or sleeping session of an offline machine — the same banner, «Недоступно», no «Продолжить» (QA M3c)', () => {
    for (const status of ['closed', 'sleeping'] as const) {
      const s = session({ runnerId: 'hp', status, source: 'drive_import', isHubManaged: false });
      const v = show(s, []);
      expect(screen.getByRole('status')).toHaveTextContent(/HP не в сети с/);
      expect(screen.queryByText(/поднимется через resume/)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Продолжить' })).not.toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: 'Сообщение' })).toBeDisabled();
      v.unmount();
    }
  });

  it('Cron-сессии только для чтения', () => {
    show(session({ status: 'closed', isCron: true, readOnlyReason: 'cron', source: 'cron' }), []);
    expect(screen.getByRole('status')).toHaveTextContent('Cron-сессия, только чтение.');
    expect(screen.getByRole('textbox', { name: 'Сообщение' })).toBeDisabled();
  });

  it('closed session from the terminal: resume hint on the right machine', () => {
    show(session({ status: 'closed', source: 'terminal', runnerId: 'vm' }), []);
    expect(screen.getByRole('status')).toHaveTextContent('Завершённая сессия · источник: терминал. Отправь сообщение — поднимется через resume на ВМ .3.');
    expect(screen.getByRole('textbox', { name: 'Сообщение' })).toBeEnabled();
  });

  it('no indicator with idle teammates only; a permission with working subagents keeps «Прервать»', () => {
    const { unmount } = show(session({ status: 'waiting', subagents: { total: 1, running: 1, working: 0 } as never }));
    expect(document.querySelector('.thinking')).toBeNull();
    unmount();
    show(session({ status: 'permission', subagents: { total: 1, running: 1, working: 1 } as never }), [permEvent()]);
    expect(screen.getByRole('button', { name: 'Прервать' })).toBeInTheDocument();
  });

  it('Сессия ещё жива в терминале: 409 concurrent_external shows the warning, «Продолжить всё равно» resends with force', async () => {
    const s = session({ status: 'closed', source: 'terminal' });
    let n = 0;
    const calls = mockFetch({
      'POST /api/sessions/': () => (++n === 1 ? { status: 409, body: { error: 'concurrent_external', message: 'x' } } : { status: 202, body: { session: s } }),
    });
    show(s, []);
    await userEvent.type(screen.getByRole('textbox', { name: 'Сообщение' }), 'дальше{Enter}');
    const warn = await screen.findByRole('alertdialog');
    expect(warn).toHaveTextContent('Сессия, возможно, открыта в терминале на X1.');
    await userEvent.click(within(warn).getByRole('button', { name: 'Продолжить всё равно' }));
    expect(calls[1]!.body).toMatchObject({ text: 'дальше', force: true, clientUuid: (calls[0]!.body as { clientUuid: string }).clientUuid });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('header: title, machine and cwd, status, model by display name, bypassPermissions highlighted', () => {
    show(session({ title: 'Заголовок' }), []);
    expect(document.querySelector('.chat-title .sub')).toHaveTextContent('X1 · C:\\Users\\alice\\vault');
    // the folder is an entry into the «Файлы» window (change tool-windows-file-explorer, task 6.7)
    expect(screen.getByRole('button', { name: 'C:\\Users\\alice\\vault' })).toHaveAttribute('title', 'Показать папку сессии в «Файлах»');
    expect(screen.getByRole('combobox', { name: 'Модель' })).toHaveValue('opus');
    expect(document.querySelector('.composer .mono')).toHaveTextContent('Opus 5.5');
    expect(document.querySelector('.pill.bypass')).toHaveTextContent('bypass');
  });

  // Requirement (runner-enrollment): Запуск под root
  it('a session of a root machine: bypassPermissions is disabled in the mode switch', () => {
    const s = session({ runnerId: 'vm', permissionMode: 'acceptEdits' });
    show(s, []);
    act(() => useStore.setState({ runners: RUNNERS.map(r => (r.id === 'vm' ? { ...r, runsAsRoot: true } : r)) }));
    const mode = screen.getByRole('combobox', { name: 'Режим прав' });
    expect(within(mode).getByRole('option', { name: 'bypassPermissions — недоступен под root' })).toBeDisabled();
    expect(within(mode).getByRole('option', { name: 'plan' })).toBeEnabled();
  });

  it('mode change sends PATCH; the model change toast says «со следующего хода»', async () => {
    const s = session();
    const calls = mockFetch({ 'PATCH /api/sessions/': init => ({ status: 200, body: { ...s, ...JSON.parse(String(init!.body)) } }) });
    show(s, []);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Режим прав' }), 'plan');
    expect(calls[0]!.body).toEqual({ permissionMode: 'plan' });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Модель' }), 'sonnet');
    expect(calls[1]!.body).toEqual({ model: 'sonnet' });
    expect(useStore.getState().toasts.at(-1)).toMatchObject({ title: 'Модель изменена', text: 'Sonnet 5.5 — со следующего хода' });
  });
});

// Requirements (voice-input): Включение диктовки; Кнопка микрофона в композере; Запись голоса; Отмена записи;
// Ошибки распознавания; Одна запись на окно; Запись при смене контекста (task 3.6).
describe('Chat: dictation in the composer', () => {
  const realDeps = { ...voiceDeps };
  type Answer = { resolve: (text: string) => void; reject: (e: unknown) => void };
  let answers: Answer[] = [];
  let rec: { cancel: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };

  const signIn = (voiceInput: boolean) =>
    useStore.setState({
      auth: {
        kind: 'signed_in',
        me: {
          user: { id: 'u1', email: 'alice@example.com', role: 'admin', name: null, provider: 'google' },
          vapidPublicKey: null,
          voiceInput,
          voiceTalk: false,
          locale: null,
          accountUrl: null,
          singleProvider: null,
        },
      },
    });
  const flush = () =>
    act(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });

  beforeEach(() => {
    resetStore();
    resetVoice();
    answers = [];
    rec = {
      cancel: vi.fn(),
      stop: vi.fn(async () => new Blob(['voice'], { type: 'audio/webm;codecs=opus' })),
    };
    voiceDeps.startRecording = vi.fn(async () => ({ mime: 'audio/webm;codecs=opus', level: () => 0.4, ...rec }) as unknown as Recording);
    voiceDeps.transcribe = vi.fn(() => new Promise<{ text: string }>((res, rej) => answers.push({ resolve: text => res({ text }), reject: rej })));
  });
  afterEach(() => {
    resetVoice();
    Object.assign(voiceDeps, realDeps);
    vi.unstubAllGlobals();
  });

  it('Ключ не задан: no «Диктовка» button; Ключ задан: the button next to «Прикрепить»', () => {
    signIn(false);
    const { unmount } = show(session(), []);
    expect(screen.queryByRole('button', { name: 'Диктовка' })).toBeNull();
    unmount();
    signIn(true);
    show(session(), []);
    const mic = screen.getByRole('button', { name: 'Диктовка' });
    expect(mic).toBeEnabled();
    expect(within(mic.parentElement!).getByRole('button', { name: 'Прикрепить изображение' })).toBeInTheDocument();
  });

  it('Сессия только для чтения: the button is disabled', () => {
    signIn(true);
    show(session({ status: 'closed', isCron: true, readOnlyReason: 'cron', source: 'cron' }), []);
    expect(screen.getByRole('button', { name: 'Диктовка' })).toBeDisabled();
  });

  it('Черновик на время записи: the bar replaces the field; «Отмена» brings back «Проверь», nothing is sent', async () => {
    signIn(true);
    const s = session();
    useStore.setState({ drafts: { [s.id]: 'Проверь' } });
    show(s, []);
    await userEvent.click(screen.getByRole('button', { name: 'Диктовка' }));
    await flush();
    expect(screen.queryByRole('textbox', { name: 'Сообщение' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Отправить' })).toBeNull();
    const bar = screen.getByRole('group', { name: 'Диктовка' });
    expect(within(bar).getByText('0:00')).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'Готово' })).toHaveFocus();
    await userEvent.click(within(bar).getByRole('button', { name: 'Отмена' }));
    expect(rec.cancel).toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Сообщение' })).toHaveValue('Проверь');
    expect(voiceDeps.transcribe).not.toHaveBeenCalled();
  });

  it('Esc во время записи: cancelled, the draft as it was', async () => {
    signIn(true);
    const s = session();
    useStore.setState({ drafts: { [s.id]: 'было' } });
    show(s, []);
    await userEvent.click(screen.getByRole('button', { name: 'Диктовка' }));
    await flush();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('textbox', { name: 'Сообщение' })).toHaveValue('было');
    expect(rec.cancel).toHaveBeenCalled();
    expect(voiceDeps.transcribe).not.toHaveBeenCalled();
  });

  it('«Готово» → «Распознаю…» → the text at the end of the draft, the field focused with the cursor at the end, not sent', async () => {
    signIn(true);
    const calls = mockFetch({});
    const s = session();
    useStore.setState({ drafts: { [s.id]: 'Сделай так:' } });
    show(s, []);
    await userEvent.click(screen.getByRole('button', { name: 'Диктовка' }));
    await flush();
    await userEvent.click(screen.getByRole('button', { name: 'Готово' }));
    await flush();
    expect(within(screen.getByRole('group', { name: 'Диктовка' })).getByRole('status')).toHaveTextContent('Распознаю…');
    await act(async () => answers[0]!.resolve('проверь логи'));
    await flush();
    const ta = screen.getByRole('textbox', { name: 'Сообщение' }) as HTMLTextAreaElement;
    expect(ta).toHaveValue('Сделай так: проверь логи');
    await act(async () => new Promise(r => setTimeout(r, 40)));
    expect(ta).toHaveFocus();
    expect(ta.selectionStart).toBe(ta.value.length);
    expect(calls.filter(c => c.url.includes('/messages'))).toHaveLength(0);
  });

  it('Прервать сессию во время диктовки: «Прервать» stays next to the bar in every phase and interrupts without touching the dictation', async () => {
    signIn(true);
    const s = session({ status: 'working' });
    const calls = mockFetch({ [`POST /api/sessions/${s.id}/interrupt`]: () => ({ status: 202, body: { session: { ...s, status: 'working' } } }) });
    const view = show(s, []);
    await userEvent.click(screen.getByRole('button', { name: 'Диктовка' }));
    await flush();
    const bar = screen.getByRole('group', { name: 'Диктовка' });
    const stop = () => screen.getByRole('button', { name: 'Прервать' });
    // recording: the button is outside the bar, next to it
    expect(bar.contains(stop())).toBe(false);
    expect(stop().parentElement).toBe(bar.parentElement);
    await userEvent.click(stop());
    await flush();
    expect(calls.filter(c => c.method === 'POST' && c.url.endsWith(`/api/sessions/${s.id}/interrupt`))).toHaveLength(1);
    expect(rec.cancel).not.toHaveBeenCalled();
    expect(rec.stop).not.toHaveBeenCalled();
    expect(within(screen.getByRole('group', { name: 'Диктовка' })).getByRole('button', { name: 'Готово' })).toBeInTheDocument();
    // «Распознаю…»
    await userEvent.click(screen.getByRole('button', { name: 'Готово' }));
    await flush();
    expect(within(screen.getByRole('group', { name: 'Диктовка' })).getByRole('status')).toHaveTextContent('Распознаю…');
    await userEvent.click(stop());
    await flush();
    expect(within(screen.getByRole('group', { name: 'Диктовка' })).getByRole('status')).toHaveTextContent('Распознаю…');
    // an error with «Повторить»
    await act(async () => answers[0]!.reject(new ApiError(402, 'voice_quota_exceeded', 'Закончилась квота ElevenLabs', { resetAt: '2026-11-18T12:00:00Z' })));
    await flush();
    await userEvent.click(stop());
    await flush();
    expect(within(screen.getByRole('group', { name: 'Диктовка' })).getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
    expect(calls.filter(c => c.url.endsWith('/interrupt'))).toHaveLength(3);
    expect(voiceDeps.transcribe).toHaveBeenCalledTimes(1);
    // the turn ended: no «Прервать» next to the bar either
    act(() => view.rerenderWith({ ...s, status: 'waiting' }));
    expect(screen.queryByRole('button', { name: 'Прервать' })).toBeNull();
    expect(screen.getByRole('group', { name: 'Диктовка' })).toBeInTheDocument();
  });

  it('a session that cannot be interrupted: no «Прервать» next to the bar', async () => {
    signIn(true);
    show(session(), []);
    await userEvent.click(screen.getByRole('button', { name: 'Диктовка' }));
    await flush();
    expect(screen.getByRole('group', { name: 'Диктовка' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Прервать' })).toBeNull();
  });

  it('Квота исчерпана: the bar shows the reset date with «Повторить» and «Отмена»; «Повторить» sends the same recording', async () => {
    signIn(true);
    show(session(), []);
    await userEvent.click(screen.getByRole('button', { name: 'Диктовка' }));
    await flush();
    await userEvent.click(screen.getByRole('button', { name: 'Готово' }));
    await flush();
    await act(async () => answers[0]!.reject(new ApiError(402, 'voice_quota_exceeded', 'Закончилась квота ElevenLabs', { resetAt: '2026-11-18T12:00:00Z' })));
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('Закончилась квота ElevenLabs, обновится 18.11');
    expect(screen.getByRole('button', { name: 'Отмена' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await flush();
    expect(voiceDeps.transcribe).toHaveBeenCalledTimes(2);
    expect(voiceDeps.startRecording).toHaveBeenCalledTimes(1);
  });

  it('Тишина: an empty result — the composer back with «Речь не распознана»', async () => {
    signIn(true);
    show(session(), []);
    await userEvent.click(screen.getByRole('button', { name: 'Диктовка' }));
    await flush();
    await userEvent.click(screen.getByRole('button', { name: 'Готово' }));
    await flush();
    await act(async () => answers[0]!.resolve(''));
    await flush();
    expect(screen.getByRole('textbox', { name: 'Сообщение' })).toHaveValue('');
    expect(screen.getByRole('alert')).toHaveTextContent('Речь не распознана');
  });

  it('Доступ запрещён: the composer stays, the hint under it', async () => {
    signIn(true);
    voiceDeps.startRecording = vi.fn(async () => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    const s = session();
    useStore.setState({ drafts: { [s.id]: 'текст' } });
    show(s, []);
    await userEvent.click(screen.getByRole('button', { name: 'Диктовка' }));
    await flush();
    expect(screen.getByRole('textbox', { name: 'Сообщение' })).toHaveValue('текст');
    expect(screen.getByRole('alert')).toHaveTextContent(/^Нет доступа к микрофону.*настройках сайта/);
  });

  it('Вторая панель: while the left pane records, «Диктовка» on the right is disabled with «Идёт запись в другой панели»', async () => {
    signIn(true);
    useStore.setState({ runners: RUNNERS });
    const a = session();
    const b = session();
    useStore.getState().upsertSessions([a, b]);
    render(
      <>
        <Chat session={a} paneId="left" />
        <Chat session={b} paneId="right" />
      </>,
    );
    const [left, right] = screen.getAllByRole('button', { name: 'Диктовка' });
    await userEvent.click(left!);
    await flush();
    expect(right).toBeDisabled();
    expect(right).toHaveAttribute('title', 'Идёт запись в другой панели');
  });

  it('Переключение вкладки: the recording of A finishes into the draft of A; B is untouched; back in A the text is in the field', async () => {
    signIn(true);
    const a = session();
    const b = session();
    useStore.setState({ drafts: { [b.id]: 'черновик B' }, runners: RUNNERS });
    useStore.getState().upsertSessions([a, b]);
    const view = render(<Chat key={a.id} session={a} paneId="p1" />);
    await userEvent.click(screen.getByRole('button', { name: 'Диктовка' }));
    await flush();
    view.rerender(<Chat key={b.id} session={b} paneId="p1" />);
    await flush();
    expect(rec.stop).toHaveBeenCalledTimes(1);
    expect(useVoice.getState().active?.phase).toBe('transcribing');
    // B shows its own composer, not the bar of A
    expect(screen.getByRole('textbox', { name: 'Сообщение' })).toHaveValue('черновик B');
    await act(async () => answers[0]!.resolve('надиктовано в A'));
    await flush();
    expect(useStore.getState().drafts[a.id]).toBe('надиктовано в A');
    expect(useStore.getState().drafts[b.id]).toBe('черновик B');
    view.rerender(<Chat key={a.id} session={a} paneId="p1" />);
    expect(screen.getByRole('textbox', { name: 'Сообщение' })).toHaveValue('надиктовано в A');
  });

  it('an error of a recording finished by a tab switch shows in the composer of its session on return', async () => {
    signIn(true);
    const a = session();
    const b = session();
    useStore.setState({ runners: RUNNERS });
    useStore.getState().upsertSessions([a, b]);
    const view = render(<Chat key={a.id} session={a} paneId="p1" />);
    await userEvent.click(screen.getByRole('button', { name: 'Диктовка' }));
    await flush();
    view.rerender(<Chat key={b.id} session={b} paneId="p1" />);
    await flush();
    await act(async () => answers[0]!.reject(new ApiError(502, 'voice_upstream_error')));
    await flush();
    // in B the button waits for the other dictation
    expect(screen.getByRole('button', { name: 'Диктовка' })).toBeDisabled();
    view.rerender(<Chat key={a.id} session={a} paneId="p1" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Не удалось распознать');
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
  });
  it('Esc only cancels a recording: in the error phase and during «Распознаю…» the bar and the kept recording stay', async () => {
    signIn(true);
    show(session(), []);
    await userEvent.click(screen.getByRole('button', { name: 'Диктовка' }));
    await flush();
    await userEvent.click(screen.getByRole('button', { name: 'Готово' }));
    await flush();
    await userEvent.keyboard('{Escape}');
    expect(useVoice.getState().active?.phase).toBe('transcribing');
    expect(answers[0]).toBeDefined();
    await act(async () => answers[0]!.reject(new ApiError(502, 'voice_upstream_error')));
    await flush();
    await userEvent.keyboard('{Escape}');
    expect(useVoice.getState().active?.phase).toBe('error');
    await userEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await flush();
    expect(voiceDeps.transcribe).toHaveBeenCalledTimes(2);
  });

  it('one session in two panes: a dictation left without its composer shows in one of them only, Esc is not heard twice', async () => {
    signIn(true);
    useStore.setState({ runners: RUNNERS });
    const a = session();
    const b = session();
    useStore.getState().upsertSessions([a, b]);
    const two = (left: SessionView) => (
      <>
        <Chat key={`l-${left.id}`} session={left} paneId="left" />
        <Chat key="r" session={a} paneId="right" />
      </>
    );
    const view = render(two(a));
    await userEvent.click(screen.getAllByRole('button', { name: 'Диктовка' })[0]!);
    await flush();
    expect(screen.getAllByRole('group', { name: 'Диктовка' })).toHaveLength(1);
    // the left pane switches to B: the recording of A finishes, «Распознаю…» goes to the right pane (A) only
    view.rerender(two(b));
    await flush();
    expect(useVoice.getState().active?.paneId).toBe('right');
    expect(screen.getAllByRole('group', { name: 'Диктовка' })).toHaveLength(1);
    await act(async () => answers[0]!.reject(new ApiError(502, 'voice_upstream_error')));
    await flush();
    expect(screen.getAllByRole('button', { name: 'Повторить' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Повторить' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(useVoice.getState().active?.phase).toBe('error');
  });

  it('two composers of one session on mount: the first one takes the orphan dictation, the bar renders once', async () => {
    signIn(true);
    useStore.setState({ runners: RUNNERS });
    const a = session();
    const b = session();
    useStore.getState().upsertSessions([a, b]);
    const view = render(<Chat key={a.id} session={a} paneId="p1" />);
    await userEvent.click(screen.getByRole('button', { name: 'Диктовка' }));
    await flush();
    view.rerender(<Chat key={b.id} session={b} paneId="p1" />);
    await flush();
    expect(useVoice.getState().active?.paneId).toBeNull();
    view.rerender(
      <>
        <Chat key="x" session={a} paneId="left" />
        <Chat key="y" session={a} paneId="right" />
      </>,
    );
    await flush();
    expect(useVoice.getState().active?.paneId).toBe('left');
    expect(screen.getAllByRole('group', { name: 'Диктовка' })).toHaveLength(1);
  });

  it('Запись прервалась: a recorder error — no «Повторить», the composer back with the hint, the draft as it was', async () => {
    signIn(true);
    rec.stop.mockImplementationOnce(async () => {
      throw new DOMException('gone', 'UnknownError');
    });
    const s = session();
    useStore.setState({ drafts: { [s.id]: 'было' } });
    show(s, []);
    await userEvent.click(screen.getByRole('button', { name: 'Диктовка' }));
    await flush();
    await userEvent.click(screen.getByRole('button', { name: 'Готово' }));
    await flush();
    expect(screen.queryByRole('button', { name: 'Повторить' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Сообщение' })).toHaveValue('было');
    expect(screen.getByRole('alert')).toHaveTextContent('Запись прервалась');
    expect(voiceDeps.transcribe).not.toHaveBeenCalled();
  });

  it('Спящая сессия: the dictated text lands in the draft, the session is not woken, nothing is sent', async () => {
    signIn(true);
    const calls = mockFetch({});
    const s = session({ status: 'sleeping', processAlive: false, sleptAt: new Date().toISOString() });
    show(s, []);
    await userEvent.click(screen.getByRole('button', { name: 'Диктовка' }));
    await flush();
    await userEvent.click(screen.getByRole('button', { name: 'Готово' }));
    await flush();
    await act(async () => answers[0]!.resolve('проснись потом'));
    await flush();
    expect(screen.getByRole('textbox', { name: 'Сообщение' })).toHaveValue('проснись потом');
    expect(screen.getByRole('status')).toHaveTextContent(/Спит с/);
    expect(calls.filter(c => c.url.includes('/wake') || c.url.includes('/messages'))).toHaveLength(0);
    expect(useStore.getState().sessions[s.id]?.status ?? 'sleeping').toBe('sleeping');
  });

  it('the pane closes while recording: the recording finishes as «Готово», the text lands in the draft of its session', async () => {
    signIn(true);
    const s = session();
    useStore.setState({ drafts: { [s.id]: 'было' } });
    const { unmount } = show(s, []);
    await userEvent.click(screen.getByRole('button', { name: 'Диктовка' }));
    await flush();
    unmount();
    await flush();
    expect(rec.stop).toHaveBeenCalledTimes(1);
    expect(rec.cancel).not.toHaveBeenCalled();
    expect(useVoice.getState().active).toMatchObject({ phase: 'transcribing', paneId: null });
    await act(async () => answers[0]!.resolve('из закрытой панели'));
    await flush();
    expect(useStore.getState().drafts[s.id]).toBe('было из закрытой панели');
    expect(useVoice.getState().active).toBeNull();
  });
  it('Esc and «Отмена» return the focus to the composer of the pane of the bar, not the first one of the session', async () => {
    signIn(true);
    useStore.setState({ runners: RUNNERS });
    const a = session();
    useStore.getState().upsertSessions([a]);
    render(
      <>
        <Chat session={a} paneId="left" />
        <Chat session={a} paneId="right" />
      </>,
    );
    const right = () => document.querySelector<HTMLTextAreaElement>(`textarea[data-session="${a.id}"][data-composer="right"]`);
    await userEvent.click(screen.getAllByRole('button', { name: 'Диктовка' })[1]!);
    await flush();
    await userEvent.keyboard('{Escape}');
    await act(async () => new Promise(r => setTimeout(r, 40)));
    expect(right()).toHaveFocus();
    await userEvent.click(screen.getAllByRole('button', { name: 'Диктовка' })[1]!);
    await flush();
    await userEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    await act(async () => new Promise(r => setTimeout(r, 40)));
    expect(right()).toHaveFocus();
  });

  it('a claimed bar does not take the focus from a field Иван types in; a phase change in that bar does', async () => {
    signIn(true);
    useStore.setState({ runners: RUNNERS });
    const a = session();
    const b = session();
    const c = session();
    useStore.getState().upsertSessions([a, b, c]);
    const two = (left: SessionView, right: SessionView) => (
      <>
        <Chat key={`l-${left.id}`} session={left} paneId="left" />
        <Chat key={`r-${right.id}`} session={right} paneId="right" />
      </>
    );
    const view = render(two(a, c));
    await userEvent.click(screen.getAllByRole('button', { name: 'Диктовка' })[0]!);
    await flush();
    // the left pane switches to B: the recording of A goes on without a composer; Иван types in B
    view.rerender(two(b, c));
    await flush();
    const fieldB = document.querySelector<HTMLTextAreaElement>(`textarea[data-session="${b.id}"]`)!;
    fieldB.focus();
    // the right pane opens A: it claims the dictation, the focus stays in B
    view.rerender(two(b, a));
    await flush();
    expect(useVoice.getState().active?.paneId).toBe('right');
    expect(screen.getByRole('group', { name: 'Диктовка' })).toBeInTheDocument();
    expect(fieldB).toHaveFocus();
    await act(async () => answers[0]!.reject(new ApiError(502, 'voice_upstream_error')));
    await flush();
    expect(screen.getByRole('button', { name: 'Повторить' })).toHaveFocus();
  });
});

// Requirements (voice-conversation): Кнопка разговора; Полоса разговора; Начало разговора.
describe('Chat: voice conversation in the composer', () => {
  const realDeps = { ...talkDeps };
  let cb: TalkCallbacks | undefined;
  const end = vi.fn(async () => undefined);

  const signIn = (voiceTalk: boolean) =>
    useStore.setState({
      auth: {
        kind: 'signed_in',
        me: {
          user: { id: 'u1', email: 'alice@example.com', role: 'admin', name: null, provider: 'google' },
          vapidPublicKey: null,
          voiceInput: true,
          voiceTalk,
          locale: null,
          accountUrl: null,
          singleProvider: null,
        },
      },
    });

  beforeEach(() => {
    resetStore();
    resetVoice();
    resetTalk();
    cb = undefined;
    end.mockClear();
    talkDeps.checkMic = vi.fn(async () => undefined);
    talkDeps.fetchTalk = vi.fn(async () => ({ signedUrl: 'wss://el/x', token: 'tok' }));
    talkDeps.connect = vi.fn(async (_u: string, _t: string, c: TalkCallbacks) => {
      cb = c;
      return { endSession: end, sendUserMessage: vi.fn((_text: string) => undefined) };
    });
  });
  afterEach(() => {
    resetTalk();
    Object.assign(talkDeps, realDeps);
  });

  it('no «Разговор» without the agent; with it the bar replaces the field, «Диктовка» is gone, «Завершить» brings the field back', async () => {
    signIn(false);
    const { unmount } = show(session(), []);
    expect(screen.queryByRole('button', { name: 'Разговор' })).toBeNull();
    unmount();
    signIn(true);
    show(session(), []);
    await userEvent.click(screen.getByRole('button', { name: 'Разговор' }));
    const bar = await screen.findByRole('group', { name: 'Разговор' });
    expect(within(bar).getByText('Подключаюсь…')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Сообщение' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Диктовка' })).toBeNull();
    act(() => cb!.onConnect());
    expect(within(bar).getByText('Слушаю')).toBeInTheDocument();
    act(() => cb!.onMessage({ message: 'какая погода', role: 'user' }));
    expect(within(bar).getByText('Думаю…')).toBeInTheDocument();
    expect(within(bar).getByText('какая погода')).toBeInTheDocument();
    await userEvent.click(within(bar).getByRole('button', { name: 'Завершить' }));
    expect(end).toHaveBeenCalledTimes(1);
    expect(useTalk.getState().active).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Сообщение' })).toBeInTheDocument();
  });

  it('the composer going away ends the conversation', async () => {
    signIn(true);
    const { unmount } = show(session(), []);
    await userEvent.click(screen.getByRole('button', { name: 'Разговор' }));
    await screen.findByRole('group', { name: 'Разговор' });
    unmount();
    expect(useTalk.getState().active).toBeNull();
    expect(end).toHaveBeenCalledTimes(1);
  });
});
