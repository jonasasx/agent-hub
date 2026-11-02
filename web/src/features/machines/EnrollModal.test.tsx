// Component tests of «Подключить машину» (change `multi-user`, spec runner-enrollment «Окно подключения машины»).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { EnrollCodeResponse, EnrollStage, RunnerView } from '../../api/types';
import { useStore } from '../../store';
import { handleServerMessage } from '../workspace/actions';
import { mockFetch, resetStore, runner } from '../../test/factories';
import { EnrollModal, EnrollProgress, NO_CONTACT_HINT_MS } from './EnrollModal';
import { detectOs, osFamily, plural } from './machines';

const pending = (over: Partial<RunnerView> = {}) =>
  runner({ id: 'r-abc', name: 'Моя машина', os: null, online: false, lastSeenAt: null, agentVersion: null, vaultRoot: null, homeDir: null, state: 'pending', claudeLogin: null, ...over });

const code = (n = 1, over: Partial<EnrollCodeResponse> = {}): EnrollCodeResponse => ({
  runner: pending(),
  code: `CODE${n}`.padEnd(26, 'A'),
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  commands: {
    unix: `curl -fsSL https://hub.example.com/install.sh | bash -s -- CODE${n}`,
    windows: `irm https://hub.example.com/install.ps1 | iex; Install-AgentHub CODE${n}`,
  },
  ...over,
});

function stage(s: EnrollStage, over: Partial<RunnerView> = {}) {
  act(() =>
    handleServerMessage({
      type: 'runner.enroll',
      runnerId: 'r-abc',
      stage: s,
      runner: pending({ state: s === 'waiting' || s === 'code_used' ? 'pending' : 'active', online: s !== 'waiting' && s !== 'code_used', ...over }),
    }),
  );
}

describe('detectOs', () => {
  it('takes userAgentData first, then the user agent', () => {
    expect(detectOs({ userAgentData: { platform: 'macOS' } })).toBe('macos');
    expect(detectOs({ userAgentData: { platform: 'Windows' } })).toBe('windows');
    expect(detectOs({ userAgentData: { platform: 'Linux' } })).toBe('linux');
    expect(detectOs({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605' })).toBe('macos');
    expect(detectOs({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130' })).toBe('windows');
    expect(detectOs({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/131' })).toBe('linux');
    // a phone connects a server, not itself
    expect(detectOs({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari' })).toBe('linux');
  });
  it('osFamily and plural', () => {
    expect(osFamily('Windows 11 Pro')).toBe('windows');
    expect(osFamily('macOS 15.1')).toBe('macos');
    expect(osFamily('Ubuntu 24.04')).toBe('linux');
    expect([1, 2, 5, 11, 21, 22].map(n => plural(n, ['машина', 'машины', 'машин']))).toEqual(['машина', 'машины', 'машин', 'машин', 'машина', 'машины']);
  });
});

describe('EnrollProgress', () => {
  it.each<[EnrollStage, string[]]>([
    ['waiting', ['active', 'todo', 'todo']],
    ['code_used', ['active', 'todo', 'todo']],
    ['connected', ['done', 'active', 'todo']],
    ['claude_checked', ['done', 'done', 'active']],
    ['ready', ['done', 'done', 'done']],
  ])('stage %s marks the steps in order', (s, states) => {
    const { container } = render(<EnrollProgress stage={s} runner={pending({ claudeLogin: 'ok' })} />);
    expect([...container.querySelectorAll('.enroll-step')].map(el => el.className.replace('enroll-step ', ''))).toEqual(states);
  });
});

describe('EnrollModal', () => {
  beforeEach(() => {
    resetStore();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('name and OS → the command of the OS with «Скопировать», then live stages to «Начать первую сессию»', async () => {
    const calls = mockFetch({ 'POST /api/runners': () => ({ status: 201, body: code() }) });
    const user = userEvent.setup();
    // user-event puts its own clipboard on navigator: spy on it
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    render(<EnrollModal onClose={() => undefined} />);
    const name = screen.getByLabelText('Имя машины');
    expect(name).toHaveValue('Моя машина');
    await user.clear(name);
    await user.type(name, 'Ноутбук');
    await user.click(screen.getByRole('radio', { name: 'macOS' }));
    await user.click(screen.getByRole('button', { name: 'Получить команду' }));
    expect(calls.find(c => c.method === 'POST')?.body).toEqual({ name: 'Ноутбук', os: 'macos' });
    expect(await screen.findByText(/install\.sh \| bash -s -- CODE1/)).toBeInTheDocument();
    // Windows shows the PowerShell command of the same code
    await user.click(screen.getByRole('radio', { name: 'Windows' }));
    expect(screen.getByText(/Install-AgentHub CODE1/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Скопировать' }));
    expect(writeText).toHaveBeenCalledWith(code().commands.windows);
    expect(await screen.findByText('Скопировано')).toBeInTheDocument();
    expect(screen.getByText('Ждём машину — запустите команду')).toBeInTheDocument();

    stage('code_used');
    expect(screen.getByText('Код принят, ставим агента…')).toBeInTheDocument();
    stage('connected');
    expect(screen.getByText('Машина подключилась')).toBeInTheDocument();
    stage('claude_checked', { claudeLogin: 'ok' });
    expect(screen.getByText('Claude: вход есть')).toBeInTheDocument();
    stage('ready', { claudeLogin: 'ok', homeDir: '/home/bob' });
    expect(screen.queryByText(/Install-AgentHub/)).not.toBeInTheDocument();
    // the machine is in the panel now (scenario «Окно закрыто до конца установки» relies on it)
    expect(useStore.getState().runners.map(r => r.id)).toEqual(['r-abc']);
    await user.click(screen.getByRole('button', { name: 'Начать первую сессию' }));
    expect(useStore.getState().modal).toEqual({ type: 'new', runnerId: 'r-abc', cwd: '/home/bob', first: true });
  });

  it('a taken name keeps the form with the text under the field', async () => {
    mockFetch({ 'POST /api/runners': () => ({ status: 409, body: { error: 'name_taken' } }) });
    const user = userEvent.setup();
    render(<EnrollModal onClose={() => undefined} />);
    await user.click(screen.getByRole('button', { name: 'Получить команду' }));
    expect(await screen.findByText('Машина с таким именем уже есть — выберите другое')).toBeInTheDocument();
    expect(screen.getByLabelText('Имя машины')).toHaveAttribute('aria-invalid', 'true');
  });

  it('the hub not answering is an error of the form', async () => {
    mockFetch({ 'POST /api/runners': () => ({ status: 502, body: {} }) });
    const user = userEvent.setup();
    render(<EnrollModal onClose={() => undefined} />);
    await user.click(screen.getByRole('button', { name: 'Получить команду' }));
    expect(await screen.findByText('Хаб не ответил. Проверьте связь и попробуйте ещё раз.')).toBeInTheDocument();
  });

  it('scenario «Истёкший код»: the window offers «Новый код», which shows the new command', async () => {
    let n = 0;
    const calls = mockFetch({
      'POST /api/runners/r-abc/enroll-code': () => ({ status: 200, body: code(++n + 1) }),
      'POST /api/runners': () => ({ status: 201, body: code(1, { expiresAt: new Date(Date.now() + 1500).toISOString() }) }),
    });
    const user = userEvent.setup();
    render(<EnrollModal onClose={() => undefined} />);
    await user.click(screen.getByRole('button', { name: 'Получить команду' }));
    await screen.findByText(/CODE1/);
    expect(await screen.findByText('Код истёк — получите новый и запустите команду снова.', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByText(/CODE1/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Новый код' }));
    expect(await screen.findByText(/CODE2/)).toBeInTheDocument();
    expect(calls.filter(c => c.url === '/api/runners/r-abc/enroll-code')).toHaveLength(1);
  });

  it('scenario «Машина не достаёт хаб»: after a minute of waiting — the hint about :443', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetch({ 'POST /api/runners': () => ({ status: 201, body: code() }) });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<EnrollModal onClose={() => undefined} />);
    await user.click(screen.getByRole('button', { name: 'Получить команду' }));
    await screen.findByText(/CODE1/);
    expect(screen.queryByText(/выход в интернет/)).not.toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(NO_CONTACT_HINT_MS + 1000);
    });
    expect(screen.getByText(/Проверьте, что у неё есть выход в интернет на .*:443/)).toBeInTheDocument();
    // the machine reached the hub: the hint goes
    stage('code_used');
    expect(screen.queryByText(/выход в интернет/)).not.toBeInTheDocument();
  });

  it('scenario «Mac без полного доступа к диску» and no Claude login: ready with both warnings', async () => {
    mockFetch({ 'POST /api/runners': () => ({ status: 201, body: code() }) });
    const user = userEvent.setup();
    render(<EnrollModal onClose={() => undefined} />);
    await user.click(screen.getByRole('button', { name: 'Получить команду' }));
    await screen.findByText(/CODE1/);
    stage('ready', { os: 'macOS 15.1', protectedDirsOk: false, claudeLogin: 'missing' });
    expect(screen.getByText('Claude: нет входа')).toBeInTheDocument();
    expect(screen.getByText('Нет доступа к защищённым папкам macOS.')).toBeInTheDocument();
    expect(screen.getByText(/Полный доступ к диску/)).toBeInTheDocument();
    expect(screen.getByText('~/.agent-hub/bin/agent-hub login')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Начать первую сессию' })).toBeInTheDocument();
  });

  it('«Переподключить»: a new code at once, the OS from the machine, no name step', async () => {
    const calls = mockFetch({
      'GET /api/runners/hp': () => ({ status: 200, body: { ...runner({ id: 'hp', name: 'HP' }), hostname: 'hp', createdAt: '', enroll: null, uninstallCommand: { unix: '', windows: '' } } }),
      'POST /api/runners/hp/enroll-code': () => ({ status: 200, body: code(7, { runner: runner({ id: 'hp', name: 'HP' }) }) }),
    });
    render(<EnrollModal runnerId="hp" onClose={() => undefined} />);
    expect(screen.queryByLabelText('Имя машины')).not.toBeInTheDocument();
    expect(await screen.findByText(/Install-AgentHub CODE7/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Переподключить HP' })).toBeInTheDocument();
    await waitFor(() => expect(calls.some(c => c.url === '/api/runners/hp/enroll-code' && c.method === 'POST')).toBe(true));
  });
});
