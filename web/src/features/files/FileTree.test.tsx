// Component tests of the file tree. Requirements (file-explorer): Ленивое дерево; Машина не в сети и ошибки.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useStore } from '../../store';
import { resetStore, runner } from '../../test/factories';
import { allTabs } from '../layout/layout';
import { FileTree } from './FileTree';
import { resetFiles, useFiles } from './filesStore';
import { resolveSource, type Source } from './source';
import { dir, stubFs } from './testkit';

const mkSrc = (over: Partial<Parameters<typeof runner>[0]> = {}): Source => {
  const r = runner({ id: 'vm', homeDir: '/home/u', protocolVersion: '1.14', ...over });
  useStore.setState({ runners: [r] });
  return resolveSource({ choice: { kind: 'machine', runnerId: 'vm' }, sessionId: null, sessions: {}, runners: [r], rootUp: {}, outdated: {} })!;
};

describe('FileTree', () => {
  beforeEach(() => {
    resetStore();
    resetFiles();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is a tree with levels; folders first; a click expands a folder (lazy) and a click on a file opens a preview tab', async () => {
    stubFs({ list: { '/home/u': dir('/home/u', ['b.md', 'docs', 'a.txt']), '/home/u/docs': dir('/home/u/docs', ['inner.md']) }, files: {} });
    render(<FileTree src={mkSrc()} />);
    const tree = await screen.findByRole('tree', { name: 'Файлы' });
    const items = screen.getAllByRole('treeitem');
    expect(items.map(i => i.querySelector('.nm')?.textContent)).toEqual(['docs', 'a.txt', 'b.md']);
    expect(items[0]).toHaveAttribute('aria-expanded', 'false');
    expect(items[0]).toHaveAttribute('aria-level', '1');
    expect(tree).toHaveAttribute('tabindex', '0');
    await userEvent.click(items[0]!);
    const inner = await screen.findByRole('treeitem', { name: /inner\.md/ });
    expect(inner).toHaveAttribute('aria-level', '2');
    await userEvent.click(inner);
    expect(allTabs(useStore.getState().ws)).toContain('file:vm:/home/u/docs/inner.md');
    expect(useFiles.getState().pinned).toEqual([]);
  });

  it('a double click pins the tab', async () => {
    stubFs({ list: { '/home/u': dir('/home/u', ['a.txt']) }, files: {} });
    render(<FileTree src={mkSrc()} />);
    await userEvent.dblClick(await screen.findByRole('treeitem', { name: /a\.txt/ }));
    expect(useFiles.getState().pinned).toContain('file:vm:/home/u/a.txt');
  });

  it('keyboard: arrows move, right expands, left collapses, Enter opens a file', async () => {
    stubFs({ list: { '/home/u': dir('/home/u', ['docs', 'a.txt']), '/home/u/docs': dir('/home/u/docs', ['inner.md']) }, files: {} });
    const src = mkSrc();
    render(<FileTree src={src} />);
    const tree = await screen.findByRole('tree');
    tree.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('treeitem', { name: /docs/ })).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{ArrowRight}');
    await screen.findByRole('treeitem', { name: /inner\.md/ });
    expect(screen.getByRole('treeitem', { name: /docs/ })).toHaveAttribute('aria-expanded', 'true');
    await userEvent.keyboard('{ArrowRight}{ArrowDown}');
    expect(screen.getByRole('treeitem', { name: /a\.txt/ })).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{Enter}');
    expect(allTabs(useStore.getState().ws)).toContain('file:vm:/home/u/a.txt');
    await userEvent.keyboard('{ArrowUp}{ArrowUp}{ArrowLeft}');
    expect(screen.getByRole('treeitem', { name: /docs/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows «Показаны первые N из M» for a truncated folder', async () => {
    stubFs({ list: { '/home/u': dir('/home/u', ['a.txt', 'b.txt'], { truncated: true, total: 1500 }) }, files: {} });
    render(<FileTree src={mkSrc()} />);
    expect(await screen.findByText('Показаны первые 2 из 1500')).toBeInTheDocument();
  });

  it('a blocked row is dimmed, disabled and does not open', async () => {
    stubFs({ list: { '/home/u': dir('/home/u', [{ name: '.ssh', kind: 'dir', blocked: true }]) }, files: {} });
    render(<FileTree src={mkSrc()} />);
    const row = await screen.findByRole('treeitem', { name: /\.ssh/ });
    expect(row).toHaveAttribute('aria-disabled', 'true');
    expect(row).not.toHaveAttribute('aria-expanded');
    expect(row).toHaveTextContent('Нет доступа');
    await userEvent.click(row);
    expect(useFiles.getState().expanded).toEqual({});
  });

  it('an offline machine and an old agent have their own states, no request is made', () => {
    const calls = stubFs({ list: {}, files: {} });
    const { unmount } = render(<FileTree src={mkSrc({ online: false })} />);
    expect(screen.getByText('Машина не в сети')).toBeInTheDocument();
    unmount();
    render(<FileTree src={mkSrc({ protocolVersion: '1.9' })} />);
    expect(screen.getByText('Обновите агента')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('an error of the root has «Повторить» that loads again', async () => {
    stubFs({ list: { '/home/u': { error: 'agent_timeout', status: 504 } }, files: {} });
    render(<FileTree src={mkSrc()} />);
    expect(await screen.findByText('Машина не отвечает')).toBeInTheDocument();
    stubFs({ list: { '/home/u': dir('/home/u', ['ok.txt']) }, files: {} });
    await userEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await waitFor(() => expect(screen.getByRole('treeitem', { name: /ok\.txt/ })).toBeInTheDocument());
  });

  it('an empty folder says so', async () => {
    stubFs({ list: { '/home/u': dir('/home/u', []) }, files: {} });
    render(<FileTree src={mkSrc()} />);
    expect(await screen.findByText('Папка пуста')).toBeInTheDocument();
  });

  it('a folder without rights is marked with a lock and «Нет доступа», no error row, the rest of the tree works', async () => {
    stubFs({
      list: { '/home/u': dir('/home/u', ['closed', 'open']), '/home/u/closed': { error: 'permission_denied', status: 403 }, '/home/u/open': dir('/home/u/open', ['x.md']) },
      files: {},
    });
    render(<FileTree src={mkSrc()} />);
    await userEvent.click(await screen.findByRole('treeitem', { name: /closed/ }));
    const closed = await screen.findByRole('treeitem', { name: /closed — Нет доступа/ });
    expect(closed).toHaveAttribute('title', 'Нет доступа');
    expect(closed).toHaveAttribute('aria-disabled', 'true');
    expect(closed).not.toHaveAttribute('aria-expanded');
    expect(closed.querySelector('.chev')?.childElementCount).toBe(0);
    expect(closed.querySelector('.fx-ic svg')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Повторить' })).toBeNull();
    expect(screen.queryByText('Нет доступа', { selector: '.nm' })).toBeNull();
    await userEvent.click(screen.getByRole('treeitem', { name: /^open/ }));
    expect(await screen.findByRole('treeitem', { name: /x\.md/ })).toBeInTheDocument();
  });

  it('other errors of a folder (network) keep the error row with «Повторить»', async () => {
    stubFs({ list: { '/home/u': dir('/home/u', ['broken']), '/home/u/broken': { error: 'io_error', status: 500 } }, files: {} });
    render(<FileTree src={mkSrc()} />);
    await userEvent.click(await screen.findByRole('treeitem', { name: /broken/ }));
    expect(await screen.findByRole('button', { name: 'Повторить' })).toBeInTheDocument();
  });
});
