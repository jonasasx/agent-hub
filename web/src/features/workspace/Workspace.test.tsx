// Component tests of the work area (tasks 2.10/2.13): tabs (middle click, ×, numbers, glyphs), no tab limit,
// hotkeys, «Одно окно»/«Вернуть разделение», pane close, phone bar.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SessionView } from '../../api/types';
import { useStore } from '../../store';
import { RUNNERS, mockFetch, resetStore, session } from '../../test/factories';
import { emptyWorkspace, leaves, split } from '../layout/layout';
import { handleHotkey } from './hotkeys';
import { openSession } from './actions';
import { Workspace } from './Workspace';

function setup(list: SessionView[], open: SessionView[] = list) {
  useStore.setState({ runners: RUNNERS });
  useStore.getState().upsertSessions(list);
  const ids = open.map(s => s.id);
  useStore.setState({ ws: emptyWorkspace(ids), logs: Object.fromEntries(list.map(s => [s.id, { events: [], before: null, loaded: true, loading: false, error: null }])) });
  mockFetch({
    '/api/sessions/': () => ({ status: 200, body: { events: [], before: null } }),
  });
  return render(<Workspace />);
}

const key = (k: string, extra: Partial<KeyboardEvent> = {}) => {
  const e = {
    key: k,
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
    ...extra,
  };
  const handled = handleHotkey(e);
  return { handled, prevented: e.prevented };
};

describe('Tabs', () => {
  beforeEach(resetStore);
  afterEach(() => vi.unstubAllGlobals());

  it('Закрытие вкладки колёсиком: middle button closes an inactive tab, prevents autoscroll, keeps the active tab', () => {
    const [a, b, c] = [session({ title: 'A' }), session({ title: 'B' }), session({ title: 'C' })];
    setup([a!, b!, c!]);
    const tabB = screen.getByRole('tab', { name: /^B/ });
    const down = fireEvent.mouseDown(tabB, { button: 1 });
    expect(down).toBe(false); // preventDefault → no autoscroll
    fireEvent(tabB, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    expect(screen.queryByRole('tab', { name: /^B/ })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { selected: true })).toHaveTextContent('A');
    // the session itself is untouched
    expect(useStore.getState().sessions[b!.id]!.status).toBe('waiting');
  });

  it('the × button removes the tab locally (no request to the hub)', async () => {
    const [a, b] = [session({ title: 'A' }), session({ title: 'B' })];
    setup([a!, b!]);
    await userEvent.click(screen.getByRole('button', { name: 'Убрать из вкладок: B' }));
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect((fetch as unknown as { mock: { calls: [string, RequestInit?][] } }).mock.calls.some(([, i]) => i?.method === 'DELETE')).toBe(false);
  });

  it('session header tooltip names the explicit catalog project', () => {
    const s = session({
      title: 'Catalog task',
      project: { id: 'ef6c84c5-9850-4aa6-84d1-43010a68266f', title: 'Agent Hub', colorKey: 'none', path: '' },
      catalogProject: { id: 'ef6c84c5-9850-4aa6-84d1-43010a68266f', name: 'Agent Hub' },
    });
    setup([s]);
    expect(screen.getByRole('tab', { name: 'Catalog task' })).toHaveAttribute('title', expect.stringContaining('Agent Hub'));
  });

  it('a tab shows the glyph only when action is needed or a turn runs; numbers in the focused pane', () => {
    const list = [
      session({ title: 'Ждёт', status: 'waiting' }),
      session({ title: 'Работает', status: 'working' }),
      session({ title: 'Разрешение', status: 'permission' }),
      session({ title: 'Новое', status: 'waiting', unread: true }),
    ];
    setup(list);
    const tabs = screen.getAllByRole('tab');
    expect(tabs[0]!.querySelector('[class^="g-"]')).toBeNull();
    expect(tabs[1]!.querySelector('.g-work')).not.toBeNull();
    expect(tabs[2]!.querySelector('.g-perm')).not.toBeNull();
    expect(tabs[3]!.querySelector('.g-unread')).not.toBeNull();
    expect(tabs.map(t => t.querySelector('.t-key')?.textContent)).toEqual(['1', '2', '3', '4']);
  });

  it('hub-subagents: only the tab of a session another hub session started is marked «hub-child» and names the parent', () => {
    const list = [session({ title: 'Обычная' }), session({ title: 'Ребёнок', spawnedBy: { id: '0b3c1b3e-6b0a-4a52-9a4e-1d0a8d6f2f11', title: 'Главная' } })];
    setup(list);
    const [plain, kid] = screen.getAllByRole('tab');
    expect(plain!).not.toHaveClass('hub-child');
    expect(kid!).toHaveClass('hub-child');
    expect(kid!.getAttribute('title')).toContain('субагент сессии «Главная»');
  });

  it('Девятая вкладка (spec tab-strip): the ninth session opens, the eight tabs stay, no toast', () => {
    const list = Array.from({ length: 9 }, (_, i) => session({ title: `S${i + 1}` }));
    setup(list, list.slice(0, 8));
    act(() => openSession(list[8]!.id));
    expect(screen.getAllByRole('tab')).toHaveLength(9);
    expect(screen.getByRole('tab', { name: /^S9/ })).toHaveAttribute('aria-selected', 'true');
    expect(useStore.getState().toasts).toEqual([]);
  });

  it('Все вкладки активны в панелях: one more session opens in the focused pane, no «Все 8 вкладок» toast', () => {
    const list = Array.from({ length: 9 }, (_, i) => session({ title: `S${i + 1}` }));
    setup(list, list.slice(0, 4));
    let ws = useStore.getState().ws;
    ws = split(ws, list[1]!.id, 'p1', 'right').ws;
    ws = split(ws, list[2]!.id, 'p1', 'bottom').ws;
    ws = split(ws, list[3]!.id, leaves(ws.layout)[2]!, 'bottom').ws;
    act(() => useStore.setState({ ws }));
    const focus = useStore.getState().ws.focus;
    act(() => openSession(list[8]!.id));
    expect(useStore.getState().ws.panes[focus]!.active).toBe(list[8]!.id);
    expect(screen.getAllByRole('tab')).toHaveLength(5);
    expect(useStore.getState().toasts).toEqual([]);
  });
});

describe('Hotkeys', () => {
  beforeEach(resetStore);
  afterEach(() => vi.unstubAllGlobals());

  it('Ctrl+3 activates the third tab; Ctrl+9 and an empty number are left to the browser', () => {
    const list = [session({ title: 'A' }), session({ title: 'B' }), session({ title: 'C' }), session({ title: 'D' })];
    setup(list);
    act(() => void key('3'));
    expect(screen.getByRole('tab', { selected: true })).toHaveTextContent('C');
    expect(key('9')).toEqual({ handled: false, prevented: false });
    expect(key('5')).toEqual({ handled: false, prevented: false });
    expect(key('3', { ctrlKey: false, metaKey: true }).prevented).toBe(true); // Cmd on macOS
  });

  it('with a dialog open Ctrl+1…8 and Ctrl+\\ do nothing (the dialog owns the keyboard); Esc closes it', () => {
    const list = [session({ title: 'A' }), session({ title: 'B' }), session({ title: 'C' })];
    setup(list);
    useStore.setState({ modal: { type: 'search' } });
    const ws = useStore.getState().ws;
    expect(key('3')).toEqual({ handled: false, prevented: false });
    expect(key('\\')).toEqual({ handled: false, prevented: false });
    expect(useStore.getState().ws).toBe(ws);
    expect(key('Escape', { ctrlKey: false }).handled).toBe(true);
    expect(useStore.getState().modal).toBeNull();
    act(() => void key('3'));
    expect(screen.getByRole('tab', { selected: true })).toHaveTextContent('C');
  });

  it('Ctrl+K over «Новая сессия» keeps the form (the search would lose what was typed)', () => {
    setup([session({ title: 'A' })]);
    useStore.setState({ modal: { type: 'new' } });
    expect(key('k').prevented).toBe(true);
    expect(useStore.getState().modal).toEqual({ type: 'new' });
    useStore.setState({ modal: null });
    key('k');
    expect(useStore.getState().modal).toEqual({ type: 'search' });
  });

  it('Ctrl+\\ merges panes with a toast and the restore icon; again restores; nothing on the phone', () => {
    const list = [session({ title: 'A' }), session({ title: 'B' })];
    setup(list);
    act(() => useStore.setState({ ws: split(useStore.getState().ws, list[1]!.id, 'p1', 'right').ws }));
    expect(screen.getByRole('button', { name: 'Собрать вкладки в одно окно' })).toBeInTheDocument();
    act(() => void key('\\'));
    expect(leaves(useStore.getState().ws.layout)).toHaveLength(1);
    expect(useStore.getState().toasts.at(-1)).toMatchObject({ title: 'Одно окно' });
    expect(screen.getByRole('button', { name: 'Вернуть разделение' })).toBeInTheDocument();
    act(() => void key('', { code: 'Backslash' } as Partial<KeyboardEvent>));
    expect(leaves(useStore.getState().ws.layout)).toHaveLength(2);
    act(() => useStore.setState({ device: 'phone' }));
    expect(key('\\').handled).toBe(false);
  });

  it('Ctrl+K opens the search, Esc closes it (Russian layout via code)', () => {
    setup([]);
    expect(key('л', { code: 'KeyK' } as Partial<KeyboardEvent>).prevented).toBe(true);
    expect(useStore.getState().modal).toEqual({ type: 'search' });
    expect(key('Escape', { ctrlKey: false }).handled).toBe(true);
    expect(useStore.getState().modal).toBeNull();
  });
});

describe('Panes', () => {
  beforeEach(resetStore);
  afterEach(() => vi.unstubAllGlobals());

  it('Закрытие панели: × of the right pane moves its tabs to the left one', async () => {
    const list = [session({ title: 'A' }), session({ title: 'B' }), session({ title: 'C' })];
    setup(list);
    act(() => useStore.setState({ ws: split(useStore.getState().ws, list[2]!.id, 'p1', 'right').ws }));
    expect(document.querySelectorAll('section.leaf')).toHaveLength(2);
    const right = document.querySelectorAll('section.leaf')[1] as HTMLElement;
    await userEvent.click(within(right).getByRole('button', { name: 'Закрыть панель' }));
    expect(document.querySelectorAll('section.leaf')).toHaveLength(1);
    expect(screen.getAllByRole('tab').map(t => t.textContent?.replace(/\d|×/g, ''))).toEqual(['A', 'B', 'C']);
  });

  it('the focused pane is marked; a click in another pane focuses it', () => {
    const list = [session({ title: 'A' }), session({ title: 'B' })];
    setup(list);
    act(() => useStore.setState({ ws: split(useStore.getState().ws, list[1]!.id, 'p1', 'right').ws }));
    const [left, right] = [...document.querySelectorAll('section.leaf')] as HTMLElement[];
    expect(right).toHaveClass('focused');
    fireEvent.pointerDown(left!);
    expect(left).toHaveClass('focused');
  });

  it('phone: one pane without tab strip, «←» returns to the list', async () => {
    const list = [session({ title: 'A' }), session({ title: 'B' })];
    setup(list);
    act(() => useStore.setState({ device: 'phone', inChat: true }));
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'К списку' }));
    expect(useStore.getState().inChat).toBe(false);
  });
});
