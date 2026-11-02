// change client-versions: the banner (D5, spec «Плашка новой версии») and the versions in the profile menu
// (spec «Версии в меню профиля»).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BuildInfo } from './buildInfo';
import { checkNow, resetUpdateForTests, useUpdate } from './check';
import { nav, resetSwForTests } from './sw';
import { useStore } from '../../store';
import { resetStore, RUNNERS } from '../../test/factories';
import { Toasts } from '../toasts/Toasts';
import { Sidebar } from '../sidebar/Sidebar';

const A: BuildInfo = { version: '0.1.0', commit: 'aaaaaaa', builtAt: new Date(2026, 9, 28, 7, 17).toISOString() };
const B: BuildInfo = { version: '0.1.0', commit: 'bbbbbbb', builtAt: new Date(2026, 9, 28, 8, 37).toISOString() };
const ELECTRON_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) AgentHub/0.1.3 Chrome/156.0.8078.48 Electron/45.0.0 Safari/537.36';

let hub: BuildInfo | null;
let reload: ReturnType<typeof vi.fn>;
const realReload = nav.reload;

beforeEach(() => {
  resetStore();
  resetSwForTests();
  resetUpdateForTests(A);
  hub = A;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => (hub ? new Response(JSON.stringify(hub), { status: 200 }) : new Response('{}', { status: 503 }))),
  );
  reload = vi.fn();
  nav.reload = reload as unknown as () => void;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  nav.reload = realReload;
});

async function deploy(b: BuildInfo | null) {
  hub = b;
  await checkNow();
}

describe('UpdateBanner', () => {
  it('no banner while the builds match; a new build shows it first in the toast stack', async () => {
    useStore.getState().pushToast({ title: 'HP снова в сети', text: 'x' });
    render(<Toasts />);
    await deploy(A);
    expect(screen.queryByText('Доступна новая версия')).not.toBeInTheDocument();
    await deploy(B);
    const banner = await screen.findByRole('status', { name: 'Доступна новая версия' });
    expect(document.querySelector('.toasts')!.firstElementChild).toBe(banner);
    expect(within(banner).getByRole('button', { name: 'Позже' })).toBeInTheDocument();
    expect(within(banner).queryByText('Черновик пропадёт')).not.toBeInTheDocument();
  });

  it('«Обновить» without input reloads', async () => {
    render(<Toasts />);
    await deploy(B);
    await userEvent.click(await screen.findByRole('button', { name: 'Обновить' }));
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it('«Позже» hides it until the next build', async () => {
    render(<Toasts />);
    await deploy(B);
    await userEvent.click(await screen.findByRole('button', { name: 'Позже' }));
    expect(screen.queryByText('Доступна новая версия')).not.toBeInTheDocument();
    await deploy(B);
    expect(screen.queryByText('Доступна новая версия')).not.toBeInTheDocument();
    await deploy({ ...B, commit: 'ccccccc' });
    expect(await screen.findByText('Доступна новая версия')).toBeInTheDocument();
  });

  it('with a draft: «Черновик пропадёт», «Обновить» asks; refusing keeps the page, accepting reloads', async () => {
    render(<Toasts />);
    await deploy(B);
    useStore.setState({ drafts: { s1: 'недописанный текст' } });
    expect(await screen.findByText('Черновик пропадёт')).toBeInTheDocument();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    await userEvent.click(screen.getByRole('button', { name: 'Обновить' }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    expect(useStore.getState().drafts.s1).toBe('недописанный текст');
    await userEvent.click(screen.getByRole('button', { name: 'Обновить' }));
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it('a failed check shows no banner', async () => {
    render(<Toasts />);
    await deploy(null);
    expect(screen.queryByText('Доступна новая версия')).not.toBeInTheDocument();
  });
});

describe('profile menu versions', () => {
  const openMenu = async () => {
    useStore.setState({
      runners: RUNNERS,
      auth: { kind: 'signed_in', me: { user: { id: 'u1', email: 'alice@example.com', role: 'user', name: null, provider: 'google' }, vapidPublicKey: null } } as never,
    });
    render(<Sidebar onLogout={() => undefined} />);
    await userEvent.click(screen.getByRole('button', { name: 'Профиль' }));
    return screen.getByRole('menu', { name: 'Профиль' });
  };
  const rows = (menu: HTMLElement) => [...within(menu).getByLabelText('Версии').querySelectorAll('dt')].map(dt => `${dt.textContent} ${dt.nextElementSibling!.textContent}`);

  it('«Браузер»: Клиент and Хаб with commit and time, no «Приложение», no update item', async () => {
    await deploy(A);
    const menu = await openMenu();
    expect(rows(menu)).toEqual(['Клиент 0.1.0 · aaaaaaa · 28.10 07:17', 'Хаб 0.1.0 · aaaaaaa · 28.10 07:17']);
    expect(within(menu).queryByRole('menuitem', { name: 'Обновить до новой версии' })).not.toBeInTheDocument();
  });

  it('«Десктоп-приложение»: «Приложение 0.1.3» from the user-agent', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ELECTRON_UA);
    await deploy(A);
    const menu = await openMenu();
    expect(rows(menu)).toContain('Приложение 0.1.3');
  });

  it('«Клиент отстаёт»: Хаб shows its build and «Обновить до новой версии» is first under the e-mail, even after «Позже»', async () => {
    await deploy(B);
    useUpdate.setState({ dismissed: true });
    const menu = await openMenu();
    expect(rows(menu)[1]).toBe('Хаб 0.1.0 · bbbbbbb · 28.10 08:37');
    const items = within(menu).getAllByRole('menuitem');
    expect(items[0]).toHaveTextContent('Обновить до новой версии');
    await userEvent.click(items[0]!);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it('«Хаб не ответил»: «—», the menu works', async () => {
    await deploy(null);
    const menu = await openMenu();
    expect(rows(menu)[1]).toBe('Хаб —');
    expect(within(menu).getByRole('menuitem', { name: 'Машины' })).toBeInTheDocument();
  });
});
