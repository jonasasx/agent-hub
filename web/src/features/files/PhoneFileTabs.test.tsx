// Component tests of the file group of the phone «Сессии» list. Requirement (file-explorer): Файлы на телефоне.
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useStore } from '../../store';
import { RUNNERS, resetStore } from '../../test/factories';
import { allTabs } from '../layout/layout';
import { openFileTab } from '../workspace/actions';
import { resetFiles, useFiles } from './filesStore';
import { PhoneFileTabs } from './PhoneFileTabs';

describe('PhoneFileTabs', () => {
  beforeEach(() => {
    resetStore();
    resetFiles();
    useStore.setState({ runners: RUNNERS });
  });

  it('renders nothing without file tabs', () => {
    const { container } = render(<PhoneFileTabs />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists the open files with the machine and the folder; a preview is italic, a pin is not', () => {
    openFileTab('x1', 'C:\\Users\\alice\\docs\\brief.md', { pin: true });
    openFileTab('x1', 'C:\\Users\\alice\\docs\\todo.txt');
    render(<PhoneFileTabs />);
    expect(screen.getByRole('region', { name: 'Файлы' })).toBeInTheDocument();
    const pinned = screen.getByText('brief.md').closest('button')!;
    const preview = screen.getByText('todo.txt').closest('button')!;
    expect(pinned).not.toHaveClass('preview');
    expect(preview).toHaveClass('preview');
    expect(screen.getAllByText('X1 · docs')).toHaveLength(2);
  });

  it('a tap activates the file, the cross closes it', async () => {
    openFileTab('x1', '/a/one.txt', { pin: true });
    openFileTab('x1', '/a/two.txt', { pin: true });
    render(<PhoneFileTabs />);
    await userEvent.click(screen.getByText('one.txt'));
    const ws = useStore.getState().ws;
    expect(ws.panes[ws.focus]!.active).toBe('file:x1:/a/one.txt');
    await userEvent.click(screen.getByRole('button', { name: 'Закрыть two.txt' }));
    expect(allTabs(useStore.getState().ws)).toEqual(['file:x1:/a/one.txt']);
    expect(useFiles.getState().pinned).toBeDefined();
  });
});
