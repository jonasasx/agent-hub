// Task 5.3: the model of the MCP panel.
import { describe, expect, it } from 'vitest';
import { MCP_TEXTS } from '../../api/types';
import { ALL_STATUSES, mcpServer, mcpView } from './fixtures';
import {
  MCP_STATUS_LABEL,
  MCP_STATUS_TONE,
  disabledCaption,
  problemsFirst,
  flowLeft,
  infoLine,
  kindLine,
  markCount,
  pasteProblem,
  problemCount,
  problemTone,
  reasonText,
  rowActions,
  shownStatus,
  sleepingNote,
  snapshotLine,
  agentMcpVerdict,
  logoutConfirmText,
  pendingText,
  resigninHint,
  rowLayout,
} from './mcpModel';

describe('statuses', () => {
  it('every status has a label and a tone; failed → bad, needs-auth → warn, disabled without a mark', () => {
    expect(ALL_STATUSES.map(s => MCP_STATUS_LABEL[s.status])).toEqual(['подключён', 'ошибка', 'нужен вход', 'подключается', 'выключен', 'статус не сообщается']);
    expect(MCP_STATUS_TONE.failed).toBe('bad');
    expect(MCP_STATUS_TONE['needs-auth']).toBe('warn');
    expect(MCP_STATUS_TONE.disabled).toBe('off');
    expect(MCP_STATUS_TONE.unknown).toBe('muted');
  });

  it('Два проблемных сервера: one failed and one needs-auth count 2, disabled is not a problem', () => {
    expect(problemCount(ALL_STATUSES)).toBe(2);
    expect(problemCount([mcpServer({ status: 'disabled' }), mcpServer({ status: 'unknown' })])).toBe(0);
  });

  it('the mark colour: --bad with a failed server, --warn with only needs-auth, none without problems', () => {
    expect(problemTone(mcpView())).toBe('bad');
    expect(problemTone(mcpView({ servers: [mcpServer({ status: 'needs-auth' })] }))).toBe('warn');
    expect(problemTone(mcpView({ servers: [mcpServer()] }))).toBeNull();
    // not loaded: only the session's count is known
    expect(problemTone(undefined, 2)).toBe('warn');
    expect(problemTone(undefined, 0)).toBeNull();
    expect(markCount(undefined, 3)).toBe(3);
    expect(markCount(mcpView(), 7)).toBe(2);
  });

  it('a reconnect or an enable in flight shows «подключается» until the snapshot', () => {
    expect(shownStatus(mcpServer({ status: 'failed', pendingAction: 'reconnect' }))).toBe('pending');
    expect(shownStatus(mcpServer({ status: 'disabled', pendingAction: 'enable' }))).toBe('pending');
    expect(shownStatus(mcpServer({ status: 'connected', pendingAction: 'disable' }))).toBe('connected');
  });
});

describe('lines', () => {
  it('kind, server info and the disabled caption', () => {
    expect(kindLine(mcpServer())).toBe('stdio · пользовательский');
    expect(kindLine(mcpServer({ transport: 'http', scope: 'project' }))).toBe('http · проект (.mcp.json)');
    expect(kindLine(mcpServer({ scope: 'something-new' }))).toBe('stdio · something-new');
    expect(infoLine(mcpServer())).toBe('vaultwarden-mcp 1.4.0 · 12 инструментов');
    expect(infoLine(mcpServer({ toolCount: 1, serverInfo: undefined }))).toBe('1 инструмент');
    expect(infoLine(mcpServer({ status: 'failed' }))).toBeNull();
    expect(disabledCaption(mcpServer({ status: 'disabled' }), 'C:/Users/alice/vault', 'X1')).toBe('выключен для проекта C:/Users/alice/vault на X1');
    expect(disabledCaption(mcpServer({ status: 'disabled' }), undefined, 'HP')).toBe('выключен для проекта этой сессии');
    expect(disabledCaption(mcpServer({ status: 'disabled', persistence: 'process', scope: 'dynamic' }), 'C:/x', 'X1')).toBe('выключен только в этом процессе');
  });

  it('problemsFirst (QA fix 3): failed and needs-auth first, the order kept within groups', () => {
    const list = [mcpServer({ name: 'a' }), mcpServer({ name: 'b', status: 'needs-auth' }), mcpServer({ name: 'c', status: 'disabled' }), mcpServer({ name: 'd', status: 'failed' })];
    expect(problemsFirst(list).map(x => x.name)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('reasons: outdated agent, outside the hub, no snapshot, a sleeping session', () => {
    expect(reasonText(mcpView({ available: false, reason: 'agent_outdated' }))).toBe(MCP_TEXTS.agentOutdated);
    expect(reasonText(mcpView({ available: false, reason: 'not_hub_managed' }))).toBe(MCP_TEXTS.notHubManaged);
    expect(reasonText(mcpView({ reason: 'no_snapshot' }))).toMatch(/Обновить/);
    expect(reasonText(mcpView())).toBeNull();
    const clock = () => '14:05';
    expect(snapshotLine(mcpView(), clock)).toBe('Статус на 14:05');
    expect(snapshotLine(mcpView({ live: false }), clock)).toBe('Статус на 14:05');
    expect(snapshotLine(mcpView({ waking: true }), clock)).toBe('Сессия просыпается…');
    expect(sleepingNote(mcpView({ live: false }))).toBe('Сессия спит. Любое действие разбудит её.');
    expect(sleepingNote(mcpView({ live: false, available: false }))).toBe('Сессия спит.');
    expect(sleepingNote(mcpView())).toBeNull();
    expect(sleepingNote(mcpView({ live: false, waking: true }))).toBeNull();
    // an unknown transport is not named
    expect(kindLine(mcpServer({ transport: 'other', scope: 'managed' }))).toBe('управляемый');
  });
});

describe('actions of a row', () => {
  const v = mcpView();
  it('«Переподключить» for connected, failed and unknown; «Включить» for disabled, «Выключить» otherwise (UI review M2/M3)', () => {
    expect(rowActions(mcpServer({ status: 'disabled' }), v)).toMatchObject({ reconnect: false, toggle: 'enable' });
    for (const st of ['connected', 'failed', 'unknown'] as const) expect(rowActions(mcpServer({ status: st }), v)).toMatchObject({ reconnect: true, toggle: 'disable' });
    expect(rowActions(mcpServer({ status: 'pending' }), v).reconnect).toBe(false);
    expect(rowActions(mcpServer({ status: 'failed', pendingAction: 'reconnect' }), v).reconnect).toBe(false);
    expect(rowActions(mcpServer({ status: 'needs-auth', transport: 'http', canAuth: true }), v)).toMatchObject({ reconnect: false, auth: 'signin', toggle: 'disable' });
    // a sign-in attempt is open (H1)
    expect(rowActions(mcpServer({ status: 'failed' }), v, true).reconnect).toBe(false);
    expect(rowActions(mcpServer(), v).quiet).toBe(true);
    expect(rowActions(mcpServer({ status: 'failed' }), v).quiet).toBe(false);
  });

  it('«Войти» only for http/sse in needs-auth; stdio and claudeai-proxy never', () => {
    expect(rowActions(mcpServer({ status: 'needs-auth', transport: 'http', canAuth: true }), v).auth).toBe('signin');
    expect(rowActions(mcpServer({ status: 'needs-auth', transport: 'sse', canAuth: true }), v).auth).toBe('signin');
    expect(rowActions(mcpServer({ status: 'needs-auth', transport: 'stdio', canAuth: false }), v).auth).toBe(null);
    expect(rowActions(mcpServer({ status: 'needs-auth', transport: 'claudeai-proxy', canAuth: true }), v).auth).toBe(null);
    expect(rowActions(mcpServer({ status: 'connected', transport: 'http', canAuth: true }), v).auth).toBe(null);
  });

  it('locked while an action is in flight, the session wakes up, or the view has no actions', () => {
    expect(rowActions(mcpServer({ pendingAction: 'reconnect' }), v).locked).toBe(true);
    expect(rowActions(mcpServer(), mcpView({ waking: true })).locked).toBe(true);
    expect(rowActions(mcpServer(), mcpView({ available: false })).locked).toBe(true);
    expect(rowActions(mcpServer(), v).locked).toBe(false);
  });
});

describe('the agent verdict for MCP (UI review H3)', () => {
  const r = { name: 'X1', agentVersion: '0.2.0', protocolVersion: '1.6', outdated: false, update: null };
  it('names the machine and the versions; by the protocol or by the hub', () => {
    expect(agentMcpVerdict(r, false)).toMatchObject({ outdated: true, line: 'Агент на X1 сейчас 0.2.0 (протокол 1.6), для управления MCP нужен протокол 1.7 или новее.' });
    expect(agentMcpVerdict({ ...r, protocolVersion: '1.7' }, false).outdated).toBe(false);
    expect(agentMcpVerdict({ ...r, protocolVersion: '1.10' }, false).outdated).toBe(false);
    expect(agentMcpVerdict({ ...r, protocolVersion: '1.7' }, true).outdated).toBe(true);
  });
  it('what comes next: by itself after the turn, updating, or no build on the hub', () => {
    expect(agentMcpVerdict({ ...r, outdated: true }, true).next).toBe('Агент обновится сам после текущего хода.');
    expect(agentMcpVerdict({ ...r, update: { version: '0.2.4', status: 'downloading' } as never }, true).next).toBe('Агент обновляется до 0.2.4.');
    expect(agentMcpVerdict(r, true).next).toMatch(/На хабе нет сборки агента с протоколом 1\.7/);
  });
});

describe('sign-in timers', () => {
  it('the time left of an attempt', () => {
    const now = Date.parse('2026-10-28T12:00:00Z');
    expect(flowLeft({ expiresAt: '2026-10-28T12:09:59Z' }, now)).toBe('9:59');
    expect(flowLeft({ expiresAt: '2026-10-28T12:00:05Z' }, now)).toBe('0:05');
    expect(flowLeft({ expiresAt: '2026-10-28T11:59:00Z' }, now)).toBeNull();
  });

  it('a pasted text that is not an address is refused in the browser', () => {
    expect(pasteProblem('')).toMatch(/Вставьте/);
    expect(pasteProblem('code=abc')).toMatch(/не адрес/);
    expect(pasteProblem('ftp://localhost/callback')).toMatch(/не адрес/);
    expect(pasteProblem(' http://localhost:53412/callback?code=a&state=b ')).toBeNull();
  });
});

// mcp-auth-controls task 4.2: the matrix status × oauth × authError × authControls × pendingAction (design A6)
describe('«Войти», «Войти заново», «Выйти» (mcp-auth-controls A6)', () => {
  const http = (o: Parameters<typeof mcpServer>[0] = {}) => mcpServer({ transport: 'http', canAuth: true, target: 'https://scanners.example/mcp', ...o });
  const on = mcpView({ authControls: true });
  const off = mcpView({ authControls: false });
  type Case = [string, Parameters<typeof mcpServer>[0], typeof on, 'signin' | 'resignin' | null, boolean];
  const cases: Case[] = [
    ['connected OAuth, 1.8', { status: 'connected', oauth: true }, on, 'resignin', true],
    ['connected OAuth, 1.7', { status: 'connected', oauth: true }, off, null, false],
    ['connected, not OAuth (static header)', { status: 'connected', oauth: false }, on, null, false],
    ['failed with 401, OAuth', { status: 'failed', oauth: true, authError: true, error: 'HTTP 401' }, on, 'signin', true],
    ['failed with 401, agent 1.7: «Войти» still', { status: 'failed', oauth: false, authError: true, error: 'HTTP 401' }, off, 'signin', false],
    ['failed ECONNREFUSED, OAuth', { status: 'failed', oauth: true, authError: false, error: 'ECONNREFUSED' }, on, 'resignin', true],
    ['failed ECONNREFUSED, not OAuth', { status: 'failed', oauth: false, authError: false }, on, null, false],
    ['needs-auth', { status: 'needs-auth', oauth: true }, on, 'signin', true],
    ['disabled OAuth', { status: 'disabled', oauth: true }, on, null, false],
    ['pending OAuth', { status: 'pending', oauth: true }, on, null, false],
    ['connected OAuth with an action in flight', { status: 'connected', oauth: true, pendingAction: 'logout' }, on, 'resignin', false],
  ];
  it.each(cases)('%s', (_n, srv, view, auth, logout) => {
    const a = rowActions(http(srv), view);
    expect(a.auth).toBe(auth);
    expect(a.logout).toBe(logout);
  });

  it('stdio and claude.ai never get any of them', () => {
    for (const transport of ['stdio', 'claudeai-proxy'] as const) {
      const a = rowActions(mcpServer({ transport, canAuth: transport !== 'stdio', oauth: true, status: 'needs-auth' }), on);
      expect(a).toMatchObject({ auth: null, logout: false });
    }
  });

  it('a failed server with an auth error keeps «Переподключить» (in the menu)', () => {
    expect(rowActions(http({ status: 'failed', authError: true }), on)).toMatchObject({ auth: 'signin', reconnect: true });
  });

  it('UI review H1/M3: the row and its «⋯» menu', () => {
    const lay = (o: Parameters<typeof mcpServer>[0], view = on) => {
      const srv = http(o);
      return rowLayout(srv, rowActions(srv, view));
    };
    expect(lay({ status: 'connected', oauth: true })).toEqual({ visible: ['reconnect', 'resignin'], menu: ['toggle', 'logout'] });
    expect(lay({ status: 'failed', oauth: true, authError: true })).toEqual({ visible: ['signin'], menu: ['reconnect', 'toggle', 'logout'] });
    expect(lay({ status: 'failed', oauth: false, authError: true })).toEqual({ visible: ['signin'], menu: ['reconnect', 'toggle'] });
    expect(lay({ status: 'failed', oauth: true })).toEqual({ visible: ['reconnect', 'resignin'], menu: ['toggle', 'logout'] });
    // without the sign-in controls: the layout of mcp-management
    expect(lay({ status: 'connected', oauth: true }, off)).toEqual({ visible: ['reconnect', 'toggle'], menu: [] });
    expect(lay({ status: 'needs-auth' })).toEqual({ visible: ['signin', 'toggle'], menu: [] });
    expect(lay({ status: 'connected' })).toEqual({ visible: ['reconnect', 'toggle'], menu: [] });
  });

  it('texts: «Выход…», the confirmation, the hint of a dropped sign-in', () => {
    expect(pendingText(mcpServer({ pendingAction: 'logout' }))).toBe('Выход…');
    expect(logoutConfirmText('scanner-fleet', 'HP')).toBe('Выйти из scanner-fleet на HP? Вход сбросится во всех сессиях HP и в новых сессиях; токен будет отозван у провайдера.');
    expect(resigninHint(mcpServer({ status: 'connected' }))).toBe(MCP_TEXTS.resigninHint);
    expect(resigninHint(mcpServer({ status: 'failed' }))).toBe(MCP_TEXTS.resigninHint);
    expect(resigninHint(mcpServer({ status: 'needs-auth' }))).toBeNull();
  });
});
