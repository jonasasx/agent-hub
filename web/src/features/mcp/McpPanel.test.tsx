// Tasks 5.2 and 5.4: the MCP store/actions and the components (head button, panel, sign-in, tree mark, «Машины»).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MCP_TEXTS, type McpSessionView, type SessionView } from '../../api/types';
import { useStore } from '../../store';
import { mockFetch, resetStore, runner, session } from '../../test/factories';
import { handleServerMessage } from '../workspace/actions';
import { Chat } from '../chat/Chat';
import { App } from '../../App';
import { McpButton, McpPanelHost, McpTreeMark } from './McpViews';
import { loadMcp, reloadMcp } from './actions';
import { ALL_STATUSES, authFlow, mcpServer, mcpView } from './fixtures';

const RUNNERS = [runner({ protocolVersion: '1.7', agentVersion: '0.2.4' })];

function head(s: SessionView) {
  return render(
    <>
      <McpButton s={s} />
      <McpPanelHost s={s} />
      <button type="button">снаружи</button>
    </>,
  );
}

const panel = () => screen.getByRole('dialog', { name: 'MCP-серверы' });
const row = (name: string) => within(panel()).getByRole('listitem', { name: new RegExp(`^${name}: `) });
const mcpRoute = (view: McpSessionView | (() => McpSessionView)) => () => ({ status: 200, body: typeof view === 'function' ? view() : view });

describe('the MCP panel', () => {
  beforeEach(() => {
    resetStore();
    useStore.setState({ runners: RUNNERS });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('Два проблемных сервера: the head shows «MCP 2» in the --bad colour; the button opens the panel', async () => {
    const s = session({ mcpProblems: 2 });
    mockFetch({ [`GET /api/sessions/${s.id}/mcp`]: mcpRoute(mcpView()) });
    head(s);
    const btn = await screen.findByRole('button', { name: 'MCP: проблемных серверов 2' });
    await waitFor(() => expect(btn).toHaveClass('bad'));
    expect(btn).toHaveTextContent('MCP2');
    expect(btn).toHaveAttribute('aria-haspopup', 'dialog');
    await userEvent.click(btn);
    expect(panel()).toBeInTheDocument();
    expect(btn).toHaveAttribute('aria-expanded', 'true');
  });

  it('only needs-auth → --warn; no problems → a neutral «MCP»; 404 of the hub → no button', async () => {
    const a = session({ mcpProblems: 1 });
    const b = session({ mcpProblems: 0 });
    const c = session({ mcpProblems: 0 });
    mockFetch({
      [`GET /api/sessions/${a.id}/mcp`]: mcpRoute(mcpView({ servers: [mcpServer({ name: 'notion', status: 'needs-auth', transport: 'http', canAuth: true })] })),
      [`GET /api/sessions/${b.id}/mcp`]: mcpRoute(mcpView({ servers: [mcpServer()] })),
    });
    render(
      <>
        <McpButton s={a} />
        <McpButton s={b} />
        <McpButton s={c} />
      </>,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'MCP: проблемных серверов 1' })).toHaveClass('warn'));
    const neutral = await screen.findByRole('button', { name: 'MCP-серверы' });
    expect(neutral).not.toHaveClass('warn');
    expect(neutral).not.toHaveClass('bad');
    await waitFor(() => expect(useStore.getState().mcp[c.id]).toBeNull());
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  it('Статус MCP сессии: a row per server with status, kind, address, server info and the error', async () => {
    // QA fix 3: the session runs in a subfolder; the disable is kept under the git root the agent reports
    const s = session({ mcpProblems: 2, cwd: 'C:/Users/alice/vault/.tmp/mcp-qa' });
    mockFetch({ [`GET /api/sessions/${s.id}/mcp`]: mcpRoute(mcpView({ projectRoot: 'C:/Users/alice/vault' })) });
    head(s);
    await userEvent.click(await screen.findByRole('button', { name: /^MCP/ }));
    await screen.findByRole('listitem', { name: /^vaultwarden: / });
    const labels = within(panel())
      .getAllByRole('listitem')
      .map(li => li.getAttribute('aria-label'));
    expect(labels).toEqual(['scanner-fleet: ошибка', 'notion: нужен вход', 'vaultwarden: подключён', 'krisp: подключается', 'playwright: выключен', 'future: статус не сообщается']);
    expect(row('vaultwarden')).toHaveTextContent('vaultwarden-mcp 1.4.0 · 12 инструментов');
    expect(row('vaultwarden')).toHaveTextContent('stdio · пользовательский');
    expect(within(row('vaultwarden')).getByTitle(/--token •••/)).toHaveClass('mono');
    expect(row('scanner-fleet')).toHaveTextContent('ECONNREFUSED');
    expect(row('notion')).toHaveTextContent('https://mcp.notion.com/mcp');
    expect(row('playwright')).toHaveTextContent('выключен для проекта C:/Users/alice/vault на X1');
    expect(within(panel()).getByText(/^Статус на \d\d:\d\d$/)).toBeInTheDocument();
  });

  it('QA fix 3: on a desktop with two panes the popover hangs under the button of its own pane', async () => {
    const a = session({ mcpProblems: 0 });
    const b = session({ mcpProblems: 0 });
    mockFetch({ [`GET /api/sessions/${a.id}/mcp`]: mcpRoute(mcpView()), [`GET /api/sessions/${b.id}/mcp`]: mcpRoute(mcpView()) });
    render(
      <>
        <section data-testid="pa">
          <McpButton s={a} />
          <McpPanelHost s={a} />
        </section>
        <section data-testid="pb">
          <span className="ctl-more">
            <button type="button" className="icon-btn">
              ⋯
            </button>
          </span>
          <McpPanelHost s={b} />
        </section>
      </>,
    );
    const rect = (left: number, right: number, bottom: number) => ({ left, right, bottom, top: bottom - 30, width: right - left, height: 30, x: left, y: bottom - 30, toJSON: () => ({}) }) as DOMRect;
    const btnA = await screen.findByRole('button', { name: /^MCP/ });
    vi.spyOn(btnA, 'getBoundingClientRect').mockReturnValue(rect(380, 440, 40));
    const more = within(screen.getByTestId('pb')).getByRole('button', { name: '⋯' });
    vi.spyOn(more, 'getBoundingClientRect').mockReturnValue(rect(960, 990, 50));
    act(() => useStore.setState({ mcpPanel: b.id }));
    const scrimB = (await screen.findByRole('dialog', { name: 'MCP-серверы' })).parentElement!;
    expect(scrimB.style.paddingTop).toBe('56px');
    expect(scrimB.style.paddingRight).toBe(`${window.innerWidth - 990}px`);
    act(() => useStore.setState({ mcpPanel: a.id }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'MCP-серверы' }).parentElement!.style.paddingRight).toBe(`${window.innerWidth - 440}px`));
  });

  it('buttons by status: «Переподключить» not for disabled, needs-auth, pending (UI review M2/M3); «Войти» only for http in needs-auth', async () => {
    const s = session({ mcpProblems: 2 });
    mockFetch({ [`GET /api/sessions/${s.id}/mcp`]: mcpRoute(mcpView({ servers: [...ALL_STATUSES, mcpServer({ name: 'local-auth', status: 'needs-auth', transport: 'stdio' })] })) });
    head(s);
    await userEvent.click(await screen.findByRole('button', { name: /^MCP/ }));
    await screen.findByRole('listitem', { name: /^notion: / });
    const names = (n: string) =>
      within(row(n))
        .queryAllByRole('button')
        .map(b => b.textContent);
    expect(names('scanner-fleet')).toEqual(['Переподключить', 'Выключить']);
    expect(names('notion')).toEqual(['Войти', 'Выключить']);
    expect(names('krisp')).toEqual(['Выключить']);
    expect(names('playwright')).toEqual(['Включить']);
    expect(names('local-auth')).toEqual(['Выключить']);
    // a connected row is quiet: both buttons ghost; a failed one keeps «Переподключить» visible
    expect(within(row('vaultwarden')).getByRole('button', { name: 'Переподключить' })).toHaveClass('ghost');
    expect(within(row('scanner-fleet')).getByRole('button', { name: 'Переподключить' })).not.toHaveClass('ghost');
  });

  it('Esc closes the panel and gives the focus back to the button; a click outside closes it too', async () => {
    const s = session({ mcpProblems: 2 });
    mockFetch({ [`GET /api/sessions/${s.id}/mcp`]: mcpRoute(mcpView()) });
    head(s);
    const btn = await screen.findByRole('button', { name: /^MCP/ });
    btn.focus();
    await userEvent.click(btn);
    expect(panel()).toBeInTheDocument();
    expect(within(panel()).getByRole('button', { name: 'Закрыть' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(btn).toHaveFocus();
    await userEvent.click(btn);
    await userEvent.pointer({ keys: '[MouseLeft]', target: document.querySelector('.scrim')! });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Переподключение упавшего сервера: 202 with pendingAction → «подключается», then session.mcp → «подключён»; the mark goes', async () => {
    const s = session({ mcpProblems: 1 });
    const failed = mcpServer({ name: 'scanner-fleet', status: 'failed', error: 'ECONNREFUSED', serverInfo: undefined });
    const calls = mockFetch({
      [`GET /api/sessions/${s.id}/mcp`]: mcpRoute(mcpView({ servers: [failed] })),
      [`POST /api/sessions/${s.id}/mcp/actions`]: () => ({ status: 202, body: mcpView({ servers: [{ ...failed, pendingAction: 'reconnect' }] }) }),
    });
    head(s);
    await userEvent.click(await screen.findByRole('button', { name: /^MCP/ }));
    await userEvent.click(await within(panel()).findByRole('button', { name: 'Переподключить' }));
    expect(calls.find(c => c.method === 'POST')).toMatchObject({ url: `/api/sessions/${s.id}/mcp/actions`, body: { server: 'scanner-fleet', action: 'reconnect' } });
    expect(await within(panel()).findByRole('listitem', { name: 'scanner-fleet: подключается' })).toHaveTextContent('Переподключение…');
    // a repeat is not possible while the action goes on (UI review M2: no button at all)
    expect(within(row('scanner-fleet')).queryByRole('button', { name: 'Переподключить' })).toBeNull();
    expect(within(row('scanner-fleet')).getByRole('button', { name: 'Выключить' })).toBeDisabled();
    act(() => handleServerMessage({ type: 'session.mcp', sessionId: s.id, mcp: mcpView({ servers: [mcpServer({ name: 'scanner-fleet' })] }) }));
    expect(row('scanner-fleet')).toHaveAttribute('aria-label', 'scanner-fleet: подключён');
    expect(screen.getByRole('button', { name: 'MCP-серверы' })).not.toHaveClass('bad');
  });

  it('Переподключение не удалось: lastError of the server shows in its row and the button is back', async () => {
    const s = session({ mcpProblems: 1 });
    mockFetch({ [`GET /api/sessions/${s.id}/mcp`]: mcpRoute(mcpView({ servers: [mcpServer({ name: 'scanner-fleet', status: 'failed', error: 'old' })] })) });
    head(s);
    await userEvent.click(await screen.findByRole('button', { name: /^MCP/ }));
    await screen.findByRole('listitem', { name: /^scanner-fleet/ });
    act(() =>
      handleServerMessage({
        type: 'session.mcp',
        sessionId: s.id,
        mcp: mcpView({ servers: [mcpServer({ name: 'scanner-fleet', status: 'failed', error: 'connect ECONNREFUSED 127.0.0.1:8770', lastError: 'Переподключение не удалось: ECONNREFUSED' })] }),
      }),
    );
    expect(row('scanner-fleet')).toHaveTextContent('connect ECONNREFUSED 127.0.0.1:8770');
    expect(within(row('scanner-fleet')).getByRole('alert')).toHaveTextContent('Переподключение не удалось: ECONNREFUSED');
    expect(within(row('scanner-fleet')).getByRole('button', { name: 'Переподключить' })).toBeEnabled();
  });

  it('UI review H2: while an action is on the way the previous error is muted, not an alert', async () => {
    const s = session({ mcpProblems: 1 });
    const srv = mcpServer({ name: 'scanner-fleet', status: 'failed', error: 'old', lastError: 'Переподключение не удалось: ECONNREFUSED', pendingAction: 'reconnect' });
    mockFetch({ [`GET /api/sessions/${s.id}/mcp`]: mcpRoute(mcpView({ servers: [srv] })) });
    head(s);
    await userEvent.click(await screen.findByRole('button', { name: /^MCP/ }));
    await screen.findByRole('listitem', { name: /^scanner-fleet/ });
    expect(within(row('scanner-fleet')).queryByRole('alert')).toBeNull();
    expect(row('scanner-fleet')).toHaveTextContent('Прошлая ошибка: Переподключение не удалось: ECONNREFUSED');
  });

  it('Выключение: POST action disable; 409 agent_outdated shows the text with the offer to update the agent', async () => {
    const s = session({ mcpProblems: 0 });
    const calls = mockFetch({
      [`GET /api/sessions/${s.id}/mcp`]: mcpRoute(mcpView({ servers: [mcpServer({ name: 'playwright' })] })),
      [`POST /api/sessions/${s.id}/mcp/actions`]: () => ({ status: 409, body: { error: 'agent_outdated', message: MCP_TEXTS.agentOutdated } }),
    });
    head(s);
    await userEvent.click(await screen.findByRole('button', { name: 'MCP-серверы' }));
    await userEvent.click(await within(panel()).findByRole('button', { name: 'Выключить' }));
    expect(calls.find(c => c.method === 'POST')?.body).toEqual({ server: 'playwright', action: 'disable' });
    expect(await within(row('playwright')).findByRole('alert')).toHaveTextContent(`${MCP_TEXTS.agentOutdated}. Агент обновится сам`);
  });

  it('Агент старой версии: the text, «Открыть «Машины»», no actions', async () => {
    const s = session({ mcpProblems: 0 });
    mockFetch({ [`GET /api/sessions/${s.id}/mcp`]: mcpRoute(mcpView({ available: false, reason: 'agent_outdated', servers: [mcpServer()] })) });
    head(s);
    await userEvent.click(await screen.findByRole('button', { name: 'MCP-серверы' }));
    expect(await within(panel()).findByText(MCP_TEXTS.agentOutdated)).toBeInTheDocument();
    // UI review H3: the machine and the versions in the banner
    expect(within(panel()).getByText('Агент на X1 сейчас 0.2.4 (протокол 1.7), для управления MCP нужен протокол 1.7 или новее.')).toBeInTheDocument();
    expect(within(row('vaultwarden')).queryAllByRole('button')).toHaveLength(0);
    expect(within(panel()).queryByRole('button', { name: 'Обновить' })).toBeNull();
    await userEvent.click(within(panel()).getByRole('button', { name: 'Открыть «Машины»' }));
    expect(useStore.getState().settings).toBe('machines');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a session outside the hub: the text and no actions', async () => {
    const s = session({ isHubManaged: false, mcpProblems: 0 });
    mockFetch({ [`GET /api/sessions/${s.id}/mcp`]: mcpRoute(mcpView({ available: false, reason: 'not_hub_managed', servers: [], observedAt: null })) });
    head(s);
    await userEvent.click(await screen.findByRole('button', { name: 'MCP-серверы' }));
    expect(await within(panel()).findByText(MCP_TEXTS.notHubManaged)).toBeInTheDocument();
  });

  it('MCP спящей сессии: «Статус на HH:MM», the note «Сессия спит. Любое действие разбудит её.», no «Обновить»; waking → «Сессия просыпается…»', async () => {
    const s = session({ status: 'sleeping', processAlive: false, mcpProblems: 2 });
    mockFetch({ [`GET /api/sessions/${s.id}/mcp`]: mcpRoute(mcpView({ live: false })) });
    head(s);
    await userEvent.click(await screen.findByRole('button', { name: /^MCP/ }));
    expect(await within(panel()).findByText('Сессия спит. Любое действие разбудит её.')).toBeInTheDocument();
    expect(within(panel()).getByText(/^Статус на \d\d:\d\d$/)).toBeInTheDocument();
    expect(within(panel()).queryByRole('button', { name: 'Обновить' })).toBeNull();
    expect(within(row('scanner-fleet')).getByRole('button', { name: 'Переподключить' })).toBeEnabled();
    act(() =>
      handleServerMessage({
        type: 'session.mcp',
        sessionId: s.id,
        mcp: mcpView({ live: false, waking: true, servers: ALL_STATUSES.map(x => (x.name === 'scanner-fleet' ? { ...x, pendingAction: 'wake' as const } : x)) }),
      }),
    );
    expect(within(panel()).getAllByText(/Сессия просыпается…/).length).toBeGreaterThan(0);
    expect(within(row('vaultwarden')).getByRole('button', { name: 'Переподключить' })).toBeDisabled();
  });

  it('Машина не в сети: the hub refuses the action with its text', async () => {
    const s = session({ status: 'sleeping', processAlive: false, mcpProblems: 1 });
    mockFetch({
      [`GET /api/sessions/${s.id}/mcp`]: mcpRoute(mcpView({ live: false, servers: [mcpServer({ name: 'notion', status: 'needs-auth', transport: 'http', canAuth: true })] })),
      [`POST /api/sessions/${s.id}/mcp/auth`]: () => ({ status: 409, body: { error: 'runner_offline', message: 'X1 не в сети' } }),
    });
    head(s);
    await userEvent.click(await screen.findByRole('button', { name: /^MCP/ }));
    await userEvent.click(await within(panel()).findByRole('button', { name: 'Войти' }));
    expect(await within(row('notion')).findByRole('alert')).toHaveTextContent('X1 не в сети');
  });
});

describe('sign-in to a remote MCP', () => {
  beforeEach(() => {
    resetStore();
    useStore.setState({ runners: RUNNERS });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  const notion = mcpServer({ name: 'notion', status: 'needs-auth', transport: 'http', target: 'https://mcp.notion.com/mcp', canAuth: true, serverInfo: undefined, toolCount: 0 });

  async function openWith(flowAfter: ReturnType<typeof authFlow>) {
    const s = session({ mcpProblems: 1 });
    const calls = mockFetch({
      [`GET /api/sessions/${s.id}/mcp`]: mcpRoute(mcpView({ servers: [notion] })),
      [`POST /api/sessions/${s.id}/mcp/auth/callback`]: init => {
        const body = JSON.parse(String(init?.body)) as { callbackUrl: string };
        return body.callbackUrl.includes('state=s1')
          ? { status: 202, body: mcpView({ servers: [{ ...notion, pendingAction: 'auth' }], authFlows: [flowAfter] }) }
          : { status: 400, body: { error: 'bad_callback_url', message: MCP_TEXTS.stateMismatch } };
      },
      [`POST /api/sessions/${s.id}/mcp/auth`]: () => ({ status: 202, body: mcpView({ servers: [{ ...notion, pendingAction: 'auth' }] }) }),
    });
    head(s);
    await userEvent.click(await screen.findByRole('button', { name: /^MCP/ }));
    await userEvent.click(await within(panel()).findByRole('button', { name: 'Войти' }));
    expect(calls.find(c => c.url.endsWith('/mcp/auth'))?.body).toEqual({ server: 'notion' });
    expect(await within(row('notion')).findByText('Готовим вход…')).toBeInTheDocument();
    act(() => handleServerMessage({ type: 'mcp.auth', sessionId: s.id, server: 'notion', flow: flowAfter }));
    act(() => handleServerMessage({ type: 'session.mcp', sessionId: s.id, mcp: mcpView({ servers: [notion], authFlows: [flowAfter] }) }));
    return { s, calls };
  }

  it('Вход с телефона (hub): «Открыть страницу входа» is a link to the provider in a new tab, not window.open', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    await openWith(authFlow());
    const link = within(row('notion')).getByRole('link', { name: 'Открыть страницу входа' });
    expect(link).toHaveAttribute('href', authFlow().authUrl);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener');
    expect(row('notion')).toHaveTextContent('После входа провайдер вернёт вас в хаб');
    expect(row('notion')).toHaveTextContent(/Ссылка действует ещё (9:5\d|10:00)/);
    expect(within(row('notion')).queryByRole('textbox')).toBeNull();
    await userEvent.click(link);
    expect(open).not.toHaveBeenCalled();
  });

  it('the attempt ended ok → the block goes; failed → the reason in the row; process_exited → the spec text', async () => {
    const { s } = await openWith(authFlow());
    act(() => handleServerMessage({ type: 'mcp.auth', sessionId: s.id, server: 'notion', flow: null, result: 'failed', error: 'Вход не выполнен: access_denied' }));
    expect(within(row('notion')).queryByRole('link')).toBeNull();
    expect(within(row('notion')).getByRole('alert')).toHaveTextContent('Вход не выполнен: access_denied');
    expect(within(row('notion')).getByRole('button', { name: 'Войти' })).toBeEnabled();
    act(() => handleServerMessage({ type: 'mcp.auth', sessionId: s.id, server: 'notion', flow: null, result: 'process_exited' }));
    expect(within(row('notion')).getByRole('alert')).toHaveTextContent(MCP_TEXTS.processExited);
    act(() => handleServerMessage({ type: 'mcp.auth', sessionId: s.id, server: 'notion', flow: null, result: 'ok' }));
    expect(within(row('notion')).queryByRole('alert')).toBeNull();
  });

  it('Запасной путь со вставкой адреса: the field, a non-address refused in the browser, a wrong state refused by the hub, the right one sent', async () => {
    const flow = authFlow({ redirect: 'localhost', callbackPort: 53412 });
    const { s, calls } = await openWith(flow);
    expect(row('notion')).toHaveTextContent('http://localhost:53412/callback?…');
    const field = within(row('notion')).getByLabelText('Адрес страницы после входа');
    await userEvent.type(field, 'просто текст');
    await userEvent.click(within(row('notion')).getByRole('button', { name: 'Готово' }));
    expect(within(row('notion')).getByRole('alert')).toHaveTextContent('Это не адрес страницы');
    expect(calls.some(c => c.url.endsWith('/auth/callback'))).toBe(false);
    await userEvent.clear(field);
    await userEvent.type(field, 'http://localhost:53412/callback?code=c&state=other');
    await userEvent.click(within(row('notion')).getByRole('button', { name: 'Готово' }));
    expect(await within(row('notion')).findByText(MCP_TEXTS.stateMismatch)).toBeInTheDocument();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    // the attempt waits on: the link is still there
    expect(within(row('notion')).getByRole('link', { name: 'Открыть страницу входа' })).toBeInTheDocument();
    await userEvent.clear(field);
    await userEvent.type(field, 'http://localhost:53412/callback?code=c&state=s1');
    await userEvent.click(within(row('notion')).getByRole('button', { name: 'Готово' }));
    await waitFor(() => expect(calls.filter(c => c.url.endsWith('/auth/callback')).at(-1)?.body).toEqual({ server: 'notion', callbackUrl: 'http://localhost:53412/callback?code=c&state=s1' }));
    await waitFor(() => expect(within(row('notion')).queryByRole('alert')).toBeNull());
    // the hub's mismatch of a later paste comes over WS with the attempt still open
    act(() => handleServerMessage({ type: 'mcp.auth', sessionId: s.id, server: 'notion', flow, error: MCP_TEXTS.stateMismatch }));
    expect(within(row('notion')).getByRole('alert')).toHaveTextContent(MCP_TEXTS.stateMismatch);
  });

  it('UI review H1/M4: numbered steps; after the link «Готово» is the main button; an accepted address hides the form', async () => {
    const flow = authFlow({ redirect: 'localhost', callbackPort: 53412 });
    await openWith(flow);
    const steps = within(row('notion')).getAllByRole('listitem');
    expect(steps.map(li => li.textContent?.slice(0, 20))).toEqual(['Откройте страницу вх', 'Браузер покажет ошиб', 'Вставьте адрес сюдаВ']);
    // no reconnect while the attempt is open
    expect(within(row('notion')).queryByRole('button', { name: 'Переподключить' })).toBeNull();
    const link = within(row('notion')).getByRole('link', { name: 'Открыть страницу входа' });
    const done = within(row('notion')).getByRole('button', { name: 'Готово' });
    expect(link).toHaveClass('primary');
    expect(done).not.toHaveClass('primary');
    link.addEventListener('click', e => e.preventDefault());
    await userEvent.click(link);
    expect(link).not.toHaveClass('primary');
    expect(done).toHaveClass('primary');
    await userEvent.type(within(row('notion')).getByLabelText('Адрес страницы после входа'), 'http://localhost:53412/callback?code=c&state=s1');
    await userEvent.click(done);
    expect(await within(row('notion')).findByText('Адрес принят — подключаем…')).toBeInTheDocument();
    expect(within(row('notion')).queryByRole('textbox')).toBeNull();
  });

  it('UI review H1: «Вставить» reads the clipboard and sends a valid address; no access → the focus in the field', async () => {
    const flow = authFlow({ redirect: 'localhost', callbackPort: 53412 });
    const readText = vi.fn().mockResolvedValueOnce('http://localhost:53412/callback?code=c&state=s1').mockRejectedValueOnce(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { readText }, configurable: true });
    const { calls } = await openWith(flow);
    await userEvent.click(within(row('notion')).getByRole('button', { name: 'Вставить' }));
    await waitFor(() => expect(calls.filter(c => c.url.endsWith('/auth/callback')).at(-1)?.body).toEqual({ server: 'notion', callbackUrl: 'http://localhost:53412/callback?code=c&state=s1' }));
    expect(await within(row('notion')).findByText('Адрес принят — подключаем…')).toBeInTheDocument();
  });

  it('UI review H1: «Вставить» without access to the clipboard focuses the field and sends nothing', async () => {
    const flow = authFlow({ redirect: 'localhost', callbackPort: 53412 });
    Object.defineProperty(navigator, 'clipboard', { value: { readText: vi.fn().mockRejectedValue(new Error('denied')) }, configurable: true });
    const { calls } = await openWith(flow);
    await userEvent.click(within(row('notion')).getByRole('button', { name: 'Вставить' }));
    await waitFor(() => expect(within(row('notion')).getByLabelText('Адрес страницы после входа')).toHaveFocus());
    expect(calls.some(c => c.url.endsWith('/auth/callback'))).toBe(false);
    expect(within(row('notion')).queryByRole('alert')).toBeNull();
  });

  it('an expired attempt: no link, the text to press «Войти» again', async () => {
    await openWith(authFlow({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
    expect(within(row('notion')).queryByRole('link')).toBeNull();
    expect(row('notion')).toHaveTextContent('Время попытки входа вышло');
  });

  it('mcp.auth for a session whose view is not loaded fetches it', async () => {
    const s = session({ mcpProblems: 0 });
    const calls = mockFetch({ [`GET /api/sessions/${s.id}/mcp`]: mcpRoute(mcpView({ servers: [notion], authFlows: [authFlow()] })) });
    act(() => handleServerMessage({ type: 'mcp.auth', sessionId: s.id, server: 'notion', flow: authFlow() }));
    await waitFor(() => expect(useStore.getState().mcp[s.id]?.authFlows).toHaveLength(1));
    expect(calls).toHaveLength(1);
  });
});

describe('store and reconnect', () => {
  beforeEach(resetStore);
  afterEach(() => vi.unstubAllGlobals());

  it('loads a session once and reloads it after reconnect', async () => {
    const s = session({ mcpProblems: 0 });
    const calls = mockFetch({ [`GET /api/sessions/${s.id}/mcp`]: mcpRoute(mcpView()) });
    await loadMcp(s.id);
    await loadMcp(s.id);
    expect(calls).toHaveLength(1);
    reloadMcp();
    await waitFor(() => expect(calls.map(call => call.url)).toEqual([`/api/sessions/${s.id}/mcp`, `/api/sessions/${s.id}/mcp`]));
  });
});

describe('the tree mark, the phone and the chat head', () => {
  beforeEach(() => {
    resetStore();
    useStore.setState({ runners: RUNNERS });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('the tree row mark: «Проблемы MCP: N» with the colour of the loaded view; gone with no problems', () => {
    const s = session({ mcpProblems: 2 });
    const { rerender } = render(<McpTreeMark s={s} />);
    expect(screen.getByRole('img', { name: 'Проблемы MCP: 2' })).toHaveClass('warn');
    act(() => useStore.setState({ mcp: { [s.id]: mcpView() } }));
    expect(screen.getByRole('img', { name: 'Проблемы MCP: 2' })).toHaveClass('bad');
    act(() => useStore.setState({ mcp: { [s.id]: mcpView({ servers: [mcpServer()] }) } }));
    rerender(<McpTreeMark s={{ ...s, mcpProblems: 0 }} />);
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('phone: the compact button only with problems, the panel is a sheet; «⋯» has «MCP-серверы»', async () => {
    useStore.setState({ device: 'phone' });
    const a = session({ mcpProblems: 1 });
    const b = session({ mcpProblems: 0 });
    mockFetch({
      [`GET /api/sessions/${a.id}/mcp`]: mcpRoute(mcpView({ servers: [mcpServer({ name: 'notion', status: 'needs-auth', transport: 'http', canAuth: true })] })),
      [`GET /api/sessions/${b.id}/mcp`]: mcpRoute(mcpView({ servers: [mcpServer()] })),
    });
    render(
      <>
        <McpButton s={a} compact />
        <McpButton s={b} compact />
        <McpPanelHost s={a} />
      </>,
    );
    await waitFor(() => expect(useStore.getState().mcp[b.id]).toBeTruthy());
    const btn = await screen.findByRole('button', { name: 'MCP: проблемных серверов 1' });
    expect(screen.getAllByRole('button')).toHaveLength(1);
    await userEvent.click(btn);
    expect(panel()).toHaveClass('sheet');
    expect(document.querySelector('.scrim')).toHaveClass('sheet-scrim');
  });

  it('the chat head has «MCP 2»; on the phone «⋯» opens the panel from «MCP-серверы»', async () => {
    const s = session({ mcpProblems: 2 });
    mockFetch({ [`GET /api/sessions/${s.id}/mcp`]: mcpRoute(mcpView()), [`/api/sessions/${s.id}/events`]: () => ({ status: 200, body: { events: [], before: null } }) });
    useStore.setState({ sessions: { [s.id]: s } });
    render(<Chat session={s} paneId="p1" />);
    const head = document.querySelector('.head-controls') as HTMLElement;
    expect(await within(head).findByRole('button', { name: 'MCP: проблемных серверов 2' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Режим прав и модель' }));
    await userEvent.click(screen.getByRole('menuitem', { name: /MCP-серверы · проблем 2/ }));
    expect(panel()).toBeInTheDocument();
  });
});

describe('/s/<id>?mcp=1', () => {
  class FakeSocket {
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    readyState = 1;
    constructor() {
      setTimeout(() => this.onopen?.(), 0);
    }
    close() {}
    send() {}
  }
  beforeEach(() => {
    resetStore();
    vi.stubGlobal('WebSocket', FakeSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
  });

  it('the address after «Вход выполнен» opens the session with its MCP panel', async () => {
    const s = session({ mcpProblems: 0 });
    mockFetch({
      '/api/me': () => ({ status: 200, body: { user: { id: 'u1', email: 'jonasasx@gmail.com' }, vapidPublicKey: null } }),
      '/api/sidebar': () => ({ status: 200, body: { now: [], projects: [], runners: RUNNERS } }),
      [`GET /api/sessions/${s.id}/mcp`]: mcpRoute(mcpView({ servers: [mcpServer({ name: 'notion', transport: 'http' })] })),
      [`/api/sessions/${s.id}/events`]: () => ({ status: 200, body: { events: [], before: null } }),
      [`GET /api/sessions/${s.id}`]: () => ({ status: 200, body: s }),
    });
    window.history.replaceState(null, '', `/s/${s.id}?mcp=1`);
    render(<App />);
    expect(await screen.findByRole('dialog', { name: 'MCP-серверы' }, { timeout: 3000 })).toBeInTheDocument();
    expect(await screen.findByRole('listitem', { name: 'notion: подключён' })).toBeInTheDocument();
    expect(window.location.search).toBe('');
  });
});

// mcp-auth-controls tasks 4.3, 4.4 (design A6): «Войти заново», «Выйти» with the confirmation, «Войти» of a 401
describe('sign-in controls of OAuth servers (mcp-auth-controls)', () => {
  beforeEach(() => {
    resetStore();
    useStore.setState({ runners: [runner({ name: 'HP', protocolVersion: '1.8', agentVersion: '0.2.6' })] });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  const fleet = mcpServer({
    name: 'scanner-fleet',
    status: 'connected',
    transport: 'http',
    target: 'https://scanners.example/mcp',
    canAuth: true,
    oauth: true,
    serverInfo: { name: 'fleet', version: '2.3.0' },
    toolCount: 41,
  });
  const krisp = mcpServer({
    name: 'krisp',
    status: 'failed',
    transport: 'http',
    target: 'https://mcp.krisp.ai/mcp',
    canAuth: true,
    oauth: false,
    authError: true,
    error: 'HTTP 401: Unauthorized',
    serverInfo: undefined,
    toolCount: 0,
  });
  const refused = mcpServer({
    name: 'grafana',
    status: 'failed',
    transport: 'http',
    target: 'https://grafana.example/mcp',
    canAuth: true,
    oauth: false,
    authError: false,
    error: 'connect ECONNREFUSED',
    serverInfo: undefined,
    toolCount: 0,
  });
  const staticHdr = mcpServer({ name: 'static', status: 'connected', transport: 'http', target: 'https://static.example/mcp', canAuth: true, oauth: false });

  it('a connected OAuth server: «Переподключить», «Войти заново» and «⋯» with «Выключить», «Выйти»; a static-header one as before; 401 → «Войти» only, the rest in «⋯»', async () => {
    const s = session({ mcpProblems: 2 });
    mockFetch({ [`GET /api/sessions/${s.id}/mcp`]: mcpRoute(mcpView({ servers: [fleet, krisp, refused, staticHdr] })) });
    head(s);
    await userEvent.click(await screen.findByRole('button', { name: /^MCP/ }));
    const names = (n: string) =>
      within(row(n))
        .getAllByRole('button')
        .map(b => b.getAttribute('aria-label') ?? b.textContent);
    await waitFor(() => expect(names('scanner-fleet')).toEqual(['Переподключить', 'Войти заново', 'Действия с scanner-fleet']));
    await userEvent.click(within(row('scanner-fleet')).getByRole('button', { name: 'Действия с scanner-fleet' }));
    expect(
      within(row('scanner-fleet'))
        .getAllByRole('menuitem')
        .map(b => b.textContent),
    ).toEqual(['Выключить', 'Выйти']);
    // ↑/↓, Home/End between the items (the first has the focus on opening)
    const items = within(row('scanner-fleet')).getAllByRole('menuitem');
    expect(items[0]).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(items[1]).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(items[0]).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    expect(items[1]).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(items[0]).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(items[1]).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(within(row('scanner-fleet')).queryByRole('menu')).toBeNull();
    expect(within(row('scanner-fleet')).getByRole('button', { name: 'Действия с scanner-fleet' })).toHaveFocus();
    expect(panel()).toBeInTheDocument();
    // the focus leaving the menu closes it
    await userEvent.click(within(row('scanner-fleet')).getByRole('button', { name: 'Действия с scanner-fleet' }));
    await userEvent.tab();
    await userEvent.tab();
    expect(within(row('scanner-fleet')).queryByRole('menu')).toBeNull();
    expect(names('krisp')).toEqual(['Войти', 'Действия с krisp']);
    await userEvent.click(within(row('krisp')).getByRole('button', { name: 'Действия с krisp' }));
    expect(
      within(row('krisp'))
        .getAllByRole('menuitem')
        .map(b => b.textContent),
    ).toEqual(['Переподключить', 'Выключить']);
    expect(names('grafana')).toEqual(['Переподключить', 'Выключить']);
    expect(names('static')).toEqual(['Переподключить', 'Выключить']);
  });

  it('«Выйти» → the confirmation with the machine, focus on «Отмена»; «Отмена» and Esc send nothing and keep the panel; «Выйти» sends POST …/mcp/logout and «Выход…» shows until WS', async () => {
    const s = session({ mcpProblems: 0 });
    const calls = mockFetch({
      [`GET /api/sessions/${s.id}/mcp`]: mcpRoute(mcpView({ servers: [fleet] })),
      [`POST /api/sessions/${s.id}/mcp/logout`]: () => ({ status: 202, body: mcpView({ servers: [{ ...fleet, pendingAction: 'logout' }] }) }),
    });
    head(s);
    await userEvent.click(await screen.findByRole('button', { name: /^MCP/ }));
    const logout = async () => {
      await userEvent.click(await within(row('scanner-fleet')).findByRole('button', { name: 'Действия с scanner-fleet' }));
      await userEvent.click(within(row('scanner-fleet')).getByRole('menuitem', { name: 'Выйти' }));
    };
    await logout();
    const confirm = within(row('scanner-fleet')).getByRole('alertdialog');
    expect(confirm).toHaveTextContent('Выйти из scanner-fleet на HP? Вход сбросится во всех сессиях HP и в новых сессиях; токен будет отозван у провайдера.');
    expect(within(confirm).getByText('всех').tagName).toBe('B');
    expect(within(confirm).getByRole('button', { name: 'Отмена' })).toHaveFocus();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Отмена' }));
    expect(within(row('scanner-fleet')).queryByRole('alertdialog')).toBeNull();
    await logout();
    await userEvent.keyboard('{Escape}');
    expect(within(row('scanner-fleet')).queryByRole('alertdialog')).toBeNull();
    expect(panel()).toBeInTheDocument();
    expect(calls.filter(c => c.method === 'POST')).toEqual([]);

    await logout();
    await userEvent.click(within(within(row('scanner-fleet')).getByRole('alertdialog')).getByRole('button', { name: 'Выйти и отозвать токен' }));
    await waitFor(() => expect(calls.find(c => c.method === 'POST')).toMatchObject({ url: `/api/sessions/${s.id}/mcp/logout`, body: { server: 'scanner-fleet' } }));
    expect(await within(row('scanner-fleet')).findByText('Выход…')).toBeInTheDocument();
    expect(within(row('scanner-fleet')).queryAllByRole('button')).toEqual([]);
    act(() => handleServerMessage({ type: 'session.mcp', sessionId: s.id, mcp: mcpView({ servers: [{ ...fleet, status: 'needs-auth', serverInfo: undefined, toolCount: 0 }] }) }));
    expect(row('scanner-fleet')).toHaveAttribute('aria-label', 'scanner-fleet: нужен вход');
    expect(within(row('scanner-fleet')).getByRole('button', { name: 'Войти' })).toBeInTheDocument();
  });

  it('agent 1.7: no «Войти заново» or «Выйти», «Войти» of a 401 still there', async () => {
    const s = session({ mcpProblems: 1 });
    mockFetch({ [`GET /api/sessions/${s.id}/mcp`]: mcpRoute(mcpView({ authControls: false, servers: [fleet, krisp] })) });
    head(s);
    await userEvent.click(await screen.findByRole('button', { name: /^MCP/ }));
    await waitFor(() =>
      expect(
        within(row('scanner-fleet'))
          .getAllByRole('button')
          .map(b => b.textContent),
      ).toEqual(['Переподключить', 'Выключить']),
    );
    expect(within(row('krisp')).getByRole('button', { name: 'Войти' })).toBeInTheDocument();
    expect(within(row('krisp')).queryByRole('button', { name: /Выйти|Войти заново/ })).toBeNull();
  });

  it('«Войти заново» starts the sign-in; the attempt says the old sign-in is dropped', async () => {
    const s = session({ mcpProblems: 0 });
    const calls = mockFetch({
      [`GET /api/sessions/${s.id}/mcp`]: mcpRoute(mcpView({ servers: [fleet] })),
      [`POST /api/sessions/${s.id}/mcp/auth`]: () => ({ status: 202, body: mcpView({ servers: [{ ...fleet, pendingAction: 'auth' }] }) }),
    });
    head(s);
    await userEvent.click(await screen.findByRole('button', { name: /^MCP/ }));
    await userEvent.click(await within(panel()).findByRole('button', { name: 'Войти заново' }));
    expect(calls.find(c => c.method === 'POST')).toMatchObject({ url: `/api/sessions/${s.id}/mcp/auth`, body: { server: 'scanner-fleet' } });
    act(() => handleServerMessage({ type: 'mcp.auth', sessionId: s.id, server: 'scanner-fleet', flow: authFlow({ server: 'scanner-fleet', redirect: 'localhost', callbackPort: 53412 }) }));
    expect(await within(row('scanner-fleet')).findByText(MCP_TEXTS.resigninHint)).toBeInTheDocument();
  });
});
