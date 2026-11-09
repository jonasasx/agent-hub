// Component tests of the scrolling tab strip and the list of all tabs (spec tab-strip: Прокрутка полосы вкладок;
// Список всех вкладок панели). jsdom has no layout: the strip is 500 px wide, every tab 172 px (170 + gap), and the
// boxes follow `scrollLeft`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SessionView } from '../../api/types';
import { useStore } from '../../store';
import { RUNNERS, mockFetch, resetStore, session } from '../../test/factories';
import { emptyWorkspace } from '../layout/layout';
import { openSession } from './actions';
import { Workspace } from './Workspace';

const STRIP = 500;
const STEP = 172;
const scroll = new WeakMap<Element, number>();

function box(left: number, width: number): DOMRect {
  return { left, right: left + width, width, top: 0, bottom: 36, height: 36, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
}

function strip(): HTMLElement {
  return document.querySelector('.tabs')!;
}

/** Scrolls the strip as the browser would: sets the position and fires `scroll`. */
function scrollTo(x: number) {
  act(() => {
    strip().scrollLeft = x;
    fireEvent.scroll(strip());
  });
}

function setup(list: SessionView[]) {
  useStore.setState({ runners: RUNNERS });
  useStore.getState().upsertSessions(list);
  useStore.setState({
    ws: emptyWorkspace(list.map(s => s.id)),
    logs: Object.fromEntries(list.map(s => [s.id, { events: [], before: null, loaded: true, loading: false, error: null }])),
  });
  mockFetch({ '/api/sessions/': () => ({ status: 200, body: { events: [], before: null } }) });
  return render(<Workspace />);
}

const sessions = (n: number) => Array.from({ length: n }, (_, i) => session({ title: `S${i + 1}` }));

describe('Прокрутка полосы вкладок', () => {
  beforeEach(() => {
    resetStore();
    const tabs = () => [...strip().querySelectorAll('[data-sid]')];
    const max = () => Math.max(0, tabs().length * STEP - STRIP);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('tabs') ? STRIP : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('tabs') ? Math.max(STRIP, tabs().length * STEP) : 0;
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollLeft', {
      configurable: true,
      get(this: HTMLElement) {
        return scroll.get(this) ?? 0;
      },
      set(this: HTMLElement, v: number) {
        scroll.set(this, Math.min(Math.max(0, v), max()));
      },
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('tabs')) return box(0, STRIP);
      const sid = this.dataset.sid;
      const i = sid ? tabs().findIndex(t => (t as HTMLElement).dataset.sid === sid) : -1;
      return i < 0 ? box(0, 0) : box(i * STEP - strip().scrollLeft, 170);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (HTMLElement.prototype as { scrollLeft?: number }).scrollLeft;
  });

  it('Всё помещается: three tabs — no «▾ N», no fades', () => {
    setup(sessions(2));
    expect(document.querySelector('.tab-more')).toBeNull();
    expect(document.querySelector('.tab-fade')).toBeNull();
  });

  it('Затухания по краям: at the start only the right fade, in the middle both', () => {
    setup(sessions(14));
    expect(document.querySelector('.tab-fade.r')).not.toBeNull();
    expect(document.querySelector('.tab-fade.l')).toBeNull();
    scrollTo(600);
    expect(document.querySelector('.tab-fade.l')).not.toBeNull();
    expect(document.querySelector('.tab-fade.r')).not.toBeNull();
  });

  it('Колесо листает вбок: a vertical wheel scrolls the strip and does not reach the page', () => {
    setup(sessions(14));
    const e = new WheelEvent('wheel', { deltaY: 120, cancelable: true, bubbles: true });
    act(() => void strip().dispatchEvent(e));
    expect(strip().scrollLeft).toBe(120);
    expect(e.defaultPrevented).toBe(true);
    // a horizontal swipe of the touchpad is left to the browser
    const swipe = new WheelEvent('wheel', { deltaX: 80, deltaY: 5, cancelable: true, bubbles: true });
    act(() => void strip().dispatchEvent(swipe));
    expect(swipe.defaultPrevented).toBe(false);
  });

  it('the wheel does not touch a strip that fits', () => {
    setup(sessions(2));
    const e = new WheelEvent('wheel', { deltaY: 120, cancelable: true, bubbles: true });
    act(() => void strip().dispatchEvent(e));
    expect(e.defaultPrevented).toBe(false);
  });

  it('Активная вкладка в видимой части: a tab behind the right edge that becomes active is scrolled into view whole', () => {
    const list = sessions(14);
    setup(list);
    act(() => openSession(list[8]!.id));
    // the ninth tab: 8 × 172 … +170, the strip is 500 wide, 24 px kept for the fade
    expect(strip().scrollLeft).toBe(8 * STEP + 170 - STRIP + 24);
    // the last one: the strip stops at its end
    act(() => openSession(list[13]!.id));
    expect(strip().scrollLeft).toBe(14 * STEP - STRIP);
    act(() => openSession(list[0]!.id));
    expect(strip().scrollLeft).toBe(0);
  });
});

describe('Список всех вкладок панели', () => {
  beforeEach(() => {
    resetStore();
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('tabs') ? STRIP : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('tabs') ? Math.max(STRIP, this.querySelectorAll('[data-sid]').length * STEP) : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('tabs')) return box(0, STRIP);
      const sid = this.dataset.sid;
      const tabs = [...document.querySelectorAll<HTMLElement>('.tabs [data-sid]')];
      const i = sid ? tabs.findIndex(t => t.dataset.sid === sid) : -1;
      return i < 0 ? box(0, 0) : box(i * STEP, 170);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('«▾ 14» lists hidden tabs first with ›, the tabs on screen after them, the current one marked «открыта»', async () => {
    setup(sessions(14));
    await userEvent.click(screen.getByRole('button', { name: 'Все вкладки (14)' }));
    const hidden = screen.getByRole('group', { name: 'За краем' });
    const shown = screen.getByRole('group', { name: 'На экране' });
    expect(
      within(shown)
        .getAllByRole('menuitem')
        .map(b => b.textContent),
    ).toEqual(['S1открыта', 'S2']);
    expect(within(hidden).getAllByRole('menuitem')).toHaveLength(12);
    expect(within(hidden).getAllByRole('menuitem')[0]).toHaveTextContent('S3›');
    expect(within(shown).getAllByRole('menuitem')[0]).toHaveClass('current');
    expect(within(shown).getAllByRole('menuitem')[1]).toHaveClass('on-screen');
    expect(screen.getByRole('searchbox')).toHaveFocus();
  });

  it('Поиск: only the matching tabs, empty groups are gone; nothing matching — «Ничего не найдено»', async () => {
    setup(sessions(14));
    await userEvent.click(screen.getByRole('button', { name: 'Все вкладки (14)' }));
    await userEvent.type(screen.getByRole('searchbox'), 's1');
    expect(screen.getAllByRole('menuitem').map(b => b.textContent!.replace(/[›‹]|открыта/g, ''))).toEqual(['S10', 'S11', 'S12', 'S13', 'S14', 'S1']);
    expect(screen.queryByText('Ничего не найдено')).toBeNull();
    await userEvent.clear(screen.getByRole('searchbox'));
    await userEvent.type(screen.getByRole('searchbox'), 'S3');
    expect(screen.queryByRole('group', { name: 'На экране' })).toBeNull();
    await userEvent.type(screen.getByRole('searchbox'), 'zz');
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
    expect(screen.getByText('Ничего не найдено')).toBeInTheDocument();
  });

  it('Выбор скрытой вкладки: the tab becomes active and the list closes; Enter in the search picks the first match', async () => {
    const list = sessions(14);
    setup(list);
    await userEvent.click(screen.getByRole('button', { name: 'Все вкладки (14)' }));
    await userEvent.click(screen.getByRole('menuitem', { name: /S12/ }));
    expect(useStore.getState().ws.panes.p1!.active).toBe(list[11]!.id);
    expect(screen.queryByRole('menu')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Все вкладки (14)' }));
    await userEvent.type(screen.getByRole('searchbox'), 'S7{Enter}');
    expect(useStore.getState().ws.panes.p1!.active).toBe(list[6]!.id);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Esc closes the list, the tabs stay as they were', async () => {
    setup(sessions(14));
    await userEvent.click(screen.getByRole('button', { name: 'Все вкладки (14)' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getAllByRole('tab')).toHaveLength(14);
  });
});
