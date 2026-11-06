// Component tests of the file viewer. Requirements (file-explorer): Просмотрщик; Крошки и действия над файлом; Машина не в сети и ошибки.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useStore } from '../../store';
import { resetStore, runner } from '../../test/factories';
import { FileViewer } from './FileViewer';
import { resetFiles } from './filesStore';
import { dir, stubFs } from './testkit';

// pdfjs needs a canvas and a worker: the lazy chunk is replaced in jsdom
vi.mock('./PdfView', () => ({ default: ({ data }: { data: ArrayBuffer }) => <div data-testid="pdf-stub">{data.byteLength}</div> }));

const tab = (path: string) => `file:vm:${path}`;
const setRunner = (over: Partial<Parameters<typeof runner>[0]> = {}) => useStore.setState({ runners: [runner({ id: 'vm', name: 'ВМ', homeDir: '/home/u', protocolVersion: '1.14', ...over })] });

describe('FileViewer', () => {
  beforeEach(() => {
    resetStore();
    resetFiles();
    setRunner();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('text: line numbers by lines, the meta says the size and the kind, «только чтение»', async () => {
    stubFs({ list: {}, files: { '/home/u/a.txt': { kind: 'text', body: 'one\n\nthree\n' } } });
    render(<FileViewer tabId={tab('/home/u/a.txt')} />);
    const view = await screen.findByTestId('text-view');
    expect(view.querySelectorAll('span')).toHaveLength(3);
    expect(screen.getByText(/текст/)).toBeInTheDocument();
    expect(screen.getByText('только чтение')).toBeInTheDocument();
  });

  it('markdown: rendered by default, «Исходник» shows the source', async () => {
    stubFs({ list: {}, files: { '/home/u/a.md': { kind: 'markdown', body: '# Title\n\ntext' } } });
    render(<FileViewer tabId={tab('/home/u/a.md')} />);
    expect(await screen.findByRole('heading', { name: 'Title' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Исходник' }));
    expect(screen.queryByRole('heading', { name: 'Title' })).not.toBeInTheDocument();
    expect(screen.getByText('# Title')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Исходник' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('a picture is shown by <img> with the zoom switch; the size comes from the listing', async () => {
    stubFs({ list: { '/home/u': dir('/home/u', [{ name: 'p.png', kind: 'file', size: 2048 } as never]) }, files: {} });
    render(<FileViewer tabId={tab('/home/u/p.png')} />);
    const img = await screen.findByRole('img', { name: 'p.png' });
    expect(img.getAttribute('src')).toContain('/fs/file?path=');
    expect(await screen.findByText(/2 КБ/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '100%' })).toBeInTheDocument();
  });

  it('a picture the <img> cannot show: one probe, then «Не удалось показать изображение» with «Повторить», no loop', async () => {
    const calls = stubFs({ list: {}, files: { '/home/u/bad.png': { kind: 'image', body: new Uint8Array(4), mime: 'image/png' } } });
    render(<FileViewer tabId={tab('/home/u/bad.png')} />);
    fireEvent.error(await screen.findByRole('img', { name: 'bad.png' }));
    const img = await screen.findByRole('img', { name: 'bad.png' });
    fireEvent.error(img);
    expect(await screen.findByText('Не удалось показать изображение')).toBeInTheDocument();
    const fileCalls = () => calls.filter(u => u.includes('/fs/file')).length;
    const before = fileCalls();
    await new Promise(r => setTimeout(r, 30));
    expect(fileCalls()).toBe(before);
    expect(before).toBeLessThanOrEqual(1);
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
  });

  it('a PDF goes to the lazy viewer', async () => {
    stubFs({ list: {}, files: { '/home/u/a.pdf': { kind: 'pdf', body: new Uint8Array(10), mime: 'application/pdf' } } });
    render(<FileViewer tabId={tab('/home/u/a.pdf')} />);
    expect(await screen.findByTestId('pdf-stub')).toHaveTextContent('10');
    expect(screen.getByRole('button', { name: 'Крупнее' })).toBeInTheDocument();
  });

  it('the binary class: «Нельзя показать» with the size and no download', async () => {
    stubFs({ list: {}, files: { '/home/u/a.zip': { status: 415, json: { error: 'unsupported', kind: 'binary', size: 1048576, mime: 'application/zip' } } } });
    render(<FileViewer tabId={tab('/home/u/a.zip')} />);
    expect(await screen.findByText(/Нельзя показать/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /скачать/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('a file over the limit: «Файл слишком большой» with the size from the listing', async () => {
    stubFs({
      list: { '/home/u': dir('/home/u', [{ name: 'big.log', kind: 'file', size: 5 * 1024 * 1024 } as never]) },
      files: { '/home/u/big.log': { status: 413, json: { error: 'too_large' } } },
    });
    render(<FileViewer tabId={tab('/home/u/big.log')} />);
    expect(await screen.findByText(/Файл слишком большой/)).toBeInTheDocument();
    expect(screen.getByText(/5 МБ/)).toBeInTheDocument();
  });

  it('an offline machine: its own state, no request', () => {
    setRunner({ online: false });
    const calls = stubFs({ list: {}, files: {} });
    render(<FileViewer tabId={tab('/home/u/a.txt')} />);
    expect(screen.getByText('Машина не в сети')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('an error has «Повторить»; a missing file is «Файл не найден»', async () => {
    stubFs({ list: {}, files: {} });
    render(<FileViewer tabId={tab('/home/u/gone.txt')} />);
    expect(await screen.findByText('Файл не найден')).toBeInTheDocument();
    stubFs({ list: {}, files: { '/home/u/gone.txt': { kind: 'text', body: 'back' } } });
    await userEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByTestId('text-view')).toHaveTextContent('back');
  });

  it('a timeout of the machine says so', async () => {
    stubFs({ list: {}, files: { '/home/u/t.txt': { status: 504, json: { error: 'agent_timeout' } } } });
    render(<FileViewer tabId={tab('/home/u/t.txt')} />);
    expect(await screen.findByText('Машина не отвечает')).toBeInTheDocument();
  });

  it('the action «В сообщение» is off without a session', async () => {
    stubFs({ list: {}, files: { '/home/u/a.txt': { kind: 'text', body: 'x' } } });
    render(<FileViewer tabId={tab('/home/u/a.txt')} />);
    await screen.findByTestId('text-view');
    expect(screen.getByRole('button', { name: 'В сообщение' })).toBeDisabled();
  });

  it('a broken tab id is «Файл не найден»', () => {
    render(<FileViewer tabId="file:x" />);
    expect(screen.getByText('Файл не найден')).toBeInTheDocument();
  });
});
