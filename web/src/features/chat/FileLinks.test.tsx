// Component tests of links to files and folders (changes chat-file-links, chat-folder-links). Requirement (file-explorer): Ссылки на файлы; Ссылки на папки.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HubEvent, SessionView } from '../../api/types';
import { useStore } from '../../store';
import { RUNNERS, resetStore, session } from '../../test/factories';
import { allTabs, emptyWorkspace, split } from '../layout/layout';
import { resetFiles, useFiles } from '../files/filesStore';
import { MarkdownView } from '../files/fileViews';
import { resetLinkProbes } from '../files/fileActions';
import { Chat } from './Chat';

const answer = (text: string): HubEvent[] => [{ kind: 'line', id: 'a1', ts: '', line: { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text }] } } }];

function show(s: SessionView, text: string) {
  useStore.setState({ runners: RUNNERS, models: [{ value: 'opus', displayName: 'Opus 5.5' }] });
  useStore.getState().upsertSessions([s]);
  useStore.setState({ logs: { [s.id]: { events: answer(text), before: null, loaded: true, loading: false, error: null } } });
  return render(<Chat session={s} paneId="p1" />);
}

const tabs = () => allTabs(useStore.getState().ws);

const listing = (path: string) => new Response(JSON.stringify({ path, entries: [], truncated: false, total: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });
const notDirectory = () => new Response(JSON.stringify({ error: 'not_directory', message: 'Это не папка' }), { status: 400, headers: { 'content-type': 'application/json' } });

describe('links to folders in the feed', () => {
  beforeEach(() => {
    resetStore();
    resetFiles();
    resetLinkProbes();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('a trailing slash reveals the folder in the tree without asking the machine and opens no tab', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    show(session(), 'Лежит в [specs](openspec/specs/)');
    await userEvent.click(screen.getByRole('link', { name: 'specs' }));
    expect(useFiles.getState().reveal).toMatchObject({ runnerId: 'x1', path: 'C:\\Users\\alice\\vault\\openspec\\specs', dir: true });
    expect(tabs().some(t => t.startsWith('file:'))).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a path without an extension is a folder when the machine lists it; a double click asks once', async () => {
    const fetch = vi.fn(async () => listing('C:\\Users\\alice\\vault'));
    vi.stubGlobal('fetch', fetch);
    show(session(), '[vault](C:\\Users\\alice\\vault)');
    await userEvent.dblClick(screen.getByRole('link', { name: 'vault' }));
    await vi.waitFor(() => expect(useFiles.getState().reveal).toMatchObject({ path: 'C:\\Users\\alice\\vault', dir: true }));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toContain('/fs/list?path=');
    expect(tabs().some(t => t.startsWith('file:'))).toBe(false);
  });

  it('a path without an extension that is not a folder opens the file', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => notDirectory()),
    );
    show(session(), '[make](Makefile)');
    await userEvent.click(screen.getByRole('link', { name: 'make' }));
    await vi.waitFor(() => expect(tabs()).toContain('file:x1:C:\\Users\\alice\\vault\\Makefile'));
    expect(useFiles.getState().reveal).toBeNull();
  });
});

describe('links to files in the feed', () => {
  beforeEach(() => {
    resetStore();
    resetFiles();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('an absolute Windows path opens a preview tab of the session machine with the session root', async () => {
    const s = session();
    show(s, 'Готово: [AGENTS.md](C:\\Users\\alice\\vault\\.claude\\AGENTS.md)');
    const link = screen.getByRole('link', { name: 'AGENTS.md' });
    expect(link).toHaveAttribute('title', 'C:\\Users\\alice\\vault\\.claude\\AGENTS.md');
    expect(link).not.toHaveAttribute('target');
    await userEvent.click(link);
    const id = 'file:x1:C:\\Users\\alice\\vault\\.claude\\AGENTS.md';
    expect(tabs()).toContain(id);
    expect(useFiles.getState().pinned).toEqual([]);
    expect(useFiles.getState().tabSession[id]).toBe(s.id);
  });

  it('a relative path is resolved from the folder of the session; a line tail is dropped', async () => {
    show(session(), 'См. [spec](openspec/specs/file-explorer/spec.md:12)');
    await userEvent.click(screen.getByRole('link', { name: 'spec' }));
    expect(tabs()).toContain('file:x1:C:\\Users\\alice\\vault\\openspec\\specs\\file-explorer\\spec.md');
  });

  it('a file name with a line number in the folder of the session is a file, not a URL scheme', async () => {
    show(session(), 'См. [index](INDEX.md:3)');
    const link = screen.getByRole('link', { name: 'index' });
    expect(link).toHaveAttribute('href', 'INDEX.md:3');
    await userEvent.click(link);
    expect(tabs()).toContain('file:x1:C:\\Users\\alice\\vault\\INDEX.md');
  });

  it('a double click keeps the tab', async () => {
    show(session(), '[a](docs/a.md)');
    await userEvent.dblClick(screen.getByRole('link', { name: 'a' }));
    expect(useFiles.getState().pinned).toEqual(['file:x1:C:\\Users\\alice\\vault\\docs\\a.md']);
  });

  it('with two panes the file opens beside the chat, the chat stays on screen and a double click keeps the tab', async () => {
    const s = session();
    useStore.setState({ ws: split(emptyWorkspace([s.id, 'other']), 'other', 'p1', 'right').ws });
    show(s, '[a](docs/a.md)');
    const id = 'file:x1:C:\\Users\\alice\\vault\\docs\\a.md';
    await userEvent.dblClick(screen.getByRole('link', { name: 'a' }));
    const ws = useStore.getState().ws;
    expect(ws.panes.p1!.active).toBe(s.id);
    expect(ws.panes[ws.focus]!.active).toBe(id);
    expect(ws.focus).not.toBe('p1');
    expect(useFiles.getState().pinned).toEqual([id]);
  });

  it('a file outside the session folder is opened without the session (home root)', async () => {
    show(session(), '[cfg](C:\\Users\\alice\\.claude\\CLAUDE.md)');
    await userEvent.click(screen.getByRole('link', { name: 'cfg' }));
    expect(tabs()).toContain('file:x1:C:\\Users\\alice\\.claude\\CLAUDE.md');
  });

  it('a web link opens in a new browser tab, no file tab', async () => {
    show(session(), '[docs](https://example.com/a.md)');
    const link = screen.getByRole('link', { name: 'docs' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('href', 'https://example.com/a.md');
    expect(tabs().some(t => t.startsWith('file:'))).toBe(false);
  });
});

describe('links inside a Markdown file', () => {
  beforeEach(() => {
    resetStore();
    resetFiles();
  });

  it('a relative link opens the file next to the document', async () => {
    useStore.setState({ runners: RUNNERS });
    render(<MarkdownView text="[guide](guide.md)" mode="r" runnerId="vm" path="/home/ubuntu/repo/docs/README.md" root="/home/ubuntu" />);
    await userEvent.click(screen.getByRole('link', { name: 'guide' }));
    expect(tabs()).toContain('file:vm:/home/ubuntu/repo/docs/guide.md');
  });
});
