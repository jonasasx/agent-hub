// Requirement (tool-windows-file-explorer): Слоты и окна — the header shows only the active window, the slot is switched on the rail.
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { Column } from './Column';
import { Rail } from './Rail';
import { defaultDock, hide } from './dock';
import { useDock } from './useDock';

describe('Column', () => {
  beforeEach(() => {
    localStorage.clear();
    useDock.setState({ dock: defaultDock(), phoneWin: null });
  });

  it('a slot with two windows: the header has the active title only, no tabs, the slot is labelled', () => {
    render(<Column side="left" />);
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    const slot = screen.getByRole('group', { name: /Сессии.*Файлы/ });
    expect(slot.querySelector('.tw-head .tw-title')).toHaveTextContent('Сессии');
    expect(within(slot).queryByText('Файлы')).not.toBeInTheDocument();
  });

  it('a single window has no group label of a slot', () => {
    render(<Column side="left" />);
    expect(screen.getByRole('region', { name: 'Машины' })).toBeInTheDocument();
  });

  it('a hidden window keeps its icon in the group of its slot, without the pressed state', () => {
    useDock.setState({ dock: hide(useDock.getState().dock, 'machines') });
    render(<Rail side="left" />);
    const groups = [...document.querySelectorAll('.tw-rg')].map(g => [...g.querySelectorAll('.tw-ri')].map(i => i.getAttribute('data-id')));
    expect(groups).toEqual([['sessions', 'files'], ['machines'], ['subs']]);
    expect(document.querySelector('.tw-ri[data-id="machines"]')).toHaveAttribute('aria-pressed', 'false');
  });
});
