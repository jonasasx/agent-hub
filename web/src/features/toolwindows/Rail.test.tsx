// Requirement (tool-windows-file-explorer): Перетаскивание окон (порог 6 px), Раскладка по умолчанию, Сбросить раскладку.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import userEvent from '@testing-library/user-event';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyWorkspace } from '../layout/layout';
import { useStore } from '../../store';
import { Rail } from './Rail';
import { defaultDock, isOpen } from './dock';
import { useDrag } from './drag';
import { useDock } from './useDock';

function setup() {
  localStorage.clear();
  useDock.setState({ dock: defaultDock(), phoneWin: null });
  useDrag.setState({ id: null, target: null });
  return render(
    <div className="app">
      <Rail side="left" />
      <Rail side="right" />
    </div>,
  );
}

const icon = (name: RegExp) => screen.getAllByRole('button', { name }).find(b => b.classList.contains('tw-ri'))!;

describe('Rail', () => {
  beforeEach(() => {
    setup();
  });

  it('default layout: sessions and files in one group, machines and subscriptions apart, the right rail is empty', () => {
    const groups = [...document.querySelectorAll('nav[data-side="left"] .tw-rg')].map(g => [...g.querySelectorAll('.tw-ri')].map(i => i.getAttribute('data-id')));
    expect(groups).toEqual([['sessions', 'files'], ['machines'], ['subs']]);
    expect(document.querySelectorAll('nav[data-side="right"] .tw-ri')).toHaveLength(0);
    expect(icon(/^Сессии/)).toHaveAttribute('aria-pressed', 'true');
    expect(icon(/^Файлы/)).toHaveAttribute('aria-pressed', 'false');
  });

  it('a 3 px movement is a click: the window toggles', () => {
    const b = icon(/^Машины/);
    const was = isOpen(useDock.getState().dock, 'machines');
    fireEvent.pointerDown(b, { clientX: 20, clientY: 20, button: 0 });
    fireEvent.pointerMove(document, { clientX: 23, clientY: 20 });
    fireEvent.pointerUp(document, { clientX: 23, clientY: 20 });
    fireEvent.click(b);
    expect(isOpen(useDock.getState().dock, 'machines')).toBe(!was);
    expect(useDrag.getState().id).toBeNull();
  });

  it('an 8 px movement is a drag: the state is set and the click after it does not toggle', () => {
    const b = icon(/^Машины/);
    const was = isOpen(useDock.getState().dock, 'machines');
    fireEvent.pointerDown(b, { clientX: 20, clientY: 20, button: 0 });
    fireEvent.pointerMove(document, { clientX: 28, clientY: 20 });
    expect(useDrag.getState().id).toBe('machines');
    expect(document.querySelector('.app')).toHaveClass('dragging');
    fireEvent.pointerUp(document, { clientX: 28, clientY: 20 });
    fireEvent.click(b);
    expect(isOpen(useDock.getState().dock, 'machines')).toBe(was);
    expect(useDrag.getState().id).toBeNull();
  });

  it('Esc cancels a drag without moving the window', () => {
    const b = icon(/^Подписки/);
    const before = JSON.stringify(useDock.getState().dock);
    fireEvent.pointerDown(b, { clientX: 20, clientY: 20, button: 0 });
    fireEvent.pointerMove(document, { clientX: 40, clientY: 20 });
    expect(useDrag.getState().id).toBe('subs');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useDrag.getState().id).toBeNull();
    fireEvent.pointerUp(document, { clientX: 40, clientY: 20 });
    expect(JSON.stringify(useDock.getState().dock)).toBe(before);
  });

  it('reset returns the default layout', () => {
    useDock.getState().move('subs', { side: 'right', si: 0, asNew: true });
    expect(useDock.getState().dock).not.toEqual(defaultDock());
    useDock.getState().reset();
    expect(useDock.getState().dock).toEqual(defaultDock());
  });

  it('«Сбросить раскладку окон» in the profile menu restores the layout and keeps the open session tabs', async () => {
    useStore.setState({ ws: emptyWorkspace(['s-1', 's-2']) });
    const before = JSON.stringify(useStore.getState().ws);
    useDock.getState().toggle('sessions');
    render(<Rail side="left" onLogout={() => undefined} />);
    await userEvent.click(screen.getByRole('button', { name: 'Профиль' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Сбросить раскладку окон' }));
    expect(useDock.getState().dock).toEqual(defaultDock());
    expect(JSON.stringify(useStore.getState().ws)).toBe(before);
  });
});

describe('rail icon tips while dragging', () => {
  it('the tip of an icon is not drawn when the app is dragging a window', () => {
    const css = readFileSync(resolve(__dirname, '../../styles/app.css'), 'utf8');
    expect(css).toContain('.app:not(.dragging) .tw-ri[data-tip]:hover::after');
    expect(css).not.toMatch(/^\.tw-ri\[data-tip\]:hover::after/m);
  });
});
