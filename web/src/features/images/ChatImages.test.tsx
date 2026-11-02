// Component tests: images in the chat, the lightbox, attachments in the composer (tasks 3.8, 3.15, 3.18, 3.19 web).
// Requirements (chat-images): Изображения от агента в чате; Полный размер изображения; Изображения в ответе
// ассистента; Прикрепление изображений к сообщению; Доставка изображений в сессию (errors in the UI).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HubEvent, SessionView } from '../../api/types';
import { useStore } from '../../store';
import { RUNNERS, mockFetch, resetStore, session } from '../../test/factories';
import { Chat } from '../chat/Chat';
import { NewSessionModal } from '../newSession/NewSessionModal';
import { addFiles, useAttachments } from './attachments';
import { Lightbox, useLightbox } from './ImagePreview';
import type { Codec } from './normalize';

const SHA = (n: number) => String(n).repeat(64).slice(0, 64);
const img = (n: number, w = 1280, h = 720) => ({ type: 'image', source: { $blob: SHA(n), size: 188_416, mime: 'image/png', width: w, height: h } });
const line = (id: string, l: Record<string, unknown>): HubEvent => ({ kind: 'line', id, ts: '', line: l });
const screenshotEvents = (): HubEvent[] => [
  line('l1', { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'mcp__playwright__browser_take_screenshot', input: { filename: 'shot.png' } }] } }),
  line('l2', { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'Took the screenshot' }, img(1)] }] } }),
  line('l3', { type: 'user', uuid: 'u-3', message: { content: [img(2, 800, 600), img(3, 640, 480), img(4, 320, 200), { type: 'text', text: 'что на картинках?' }] } }),
];

function show(s: SessionView, events: HubEvent[]) {
  useStore.setState({ runners: RUNNERS, models: [{ value: 'opus', displayName: 'Opus 5.5' }] });
  useStore.getState().upsertSessions([s]);
  useStore.setState({ logs: { [s.id]: { events, before: null, loaded: true, loading: false, error: null } } });
  return render(
    <>
      <Chat session={s} paneId="p1" />
      <Lightbox />
    </>,
  );
}

describe('images from the agent (3.8)', () => {
  beforeEach(resetStore);
  afterEach(() => vi.unstubAllGlobals());

  it('Скриншот Playwright: the preview is under the collapsed call, lazy, place reserved, with the caption', () => {
    show(session(), screenshotEvents());
    const tool = document.querySelector('.tool-wrap')!;
    expect(tool.querySelector('details')).not.toHaveAttribute('open');
    const pic = within(tool as HTMLElement).getByRole('group', { name: 'Изображение' });
    const im = pic.querySelector('img')!;
    expect(im).toHaveAttribute('src', `/api/blobs/${SHA(1)}`);
    expect(im).toHaveAttribute('loading', 'lazy');
    expect(im).toHaveAttribute('width', '1280');
    expect(im).toHaveAttribute('height', '720');
    expect(im.style.aspectRatio).toBe('1280 / 720');
    expect(pic).toHaveTextContent('PNG · 1280×720 · 184 КБ');
    // the image is not inside the collapsed call
    expect(tool.querySelector('details')!.contains(im)).toBe(false);
  });

  it('images of a user message: all three under its text', () => {
    show(session(), screenshotEvents());
    const msg = screen.getByText('что на картинках?').closest('.msg')!;
    expect(msg.querySelectorAll('img')).toHaveLength(3);
  });

  it('Объект не найден: «Изображение недоступно» and «Повторить» reloads it', async () => {
    show(session(), screenshotEvents());
    const im = document.querySelector('.tool-wrap img')!;
    fireEvent.error(im);
    const box = screen.getByText('Изображение недоступно').closest('.img-prev')!;
    await userEvent.click(within(box as HTMLElement).getByRole('button', { name: 'Повторить' }));
    expect(document.querySelector('.tool-wrap img')).toHaveAttribute('src', `/api/blobs/${SHA(1)}?retry=1`);
  });

  it('a text result moved to S3: «Показать полностью» loads the whole text', async () => {
    mockFetch({ [`/api/blobs/${SHA(7)}`]: () => ({ status: 200, body: 'весь текст' }) });
    show(session(), [
      line('a', { type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 't9', name: 'Bash', input: { command: 'cat big' } }] } }),
      line('b', { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't9', content: { $blob: SHA(7), size: 40_000, mime: 'text/plain', preview: 'начало…' } }] } }),
    ]);
    fireEvent.click(document.querySelector('summary')!);
    expect(screen.getByText('начало…')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Показать полностью · 39 КБ/ }));
    expect(await screen.findByText('"весь текст"')).toBeInTheDocument();
  });
});

describe('lightbox (3.15)', () => {
  beforeEach(resetStore);
  afterEach(() => vi.unstubAllGlobals());

  it('Несколько картинок в сообщении: → and ← step through the message images, Esc closes', async () => {
    show(session(), screenshotEvents());
    const msg = screen.getByText('что на картинках?').closest('.msg')!;
    await userEvent.click(within(msg as HTMLElement).getByRole('button', { name: 'Открыть изображение 1 из 3' }));
    const box = screen.getByRole('dialog', { name: 'Изображение 1 из 3' });
    expect(box.querySelector('.lb-stage img')).toHaveAttribute('src', `/api/blobs/${SHA(2)}`);
    expect(within(box).getByRole('link', { name: 'Открыть оригинал' })).toHaveAttribute('target', '_blank');
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('dialog', { name: 'Изображение 2 из 3' })).toBeInTheDocument();
    await userEvent.keyboard('{ArrowRight}{ArrowRight}');
    expect(screen.getByRole('dialog', { name: 'Изображение 3 из 3' })).toBeInTheDocument();
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByRole('dialog', { name: 'Изображение 2 из 3' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a swipe steps; «Закрыть» and a click outside close; «назад» (popstate) closes', async () => {
    show(session(), screenshotEvents());
    const msg = screen.getByText('что на картинках?').closest('.msg')!;
    await userEvent.click(within(msg as HTMLElement).getByRole('button', { name: 'Открыть изображение 1 из 3' }));
    const box = screen.getByRole('dialog');
    fireEvent.pointerDown(box, { clientX: 300 });
    fireEvent.pointerUp(box, { clientX: 100 });
    expect(screen.getByRole('dialog', { name: 'Изображение 2 из 3' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    act(() => useLightbox.setState({ open: true, index: 0 }));
    fireEvent.click(document.querySelector('.lb-stage')!);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    act(() => useLightbox.setState({ open: true, index: 0 }));
    act(() => window.dispatchEvent(new PopStateEvent('popstate')));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('Markdown images (3.19 web)', () => {
  beforeEach(resetStore);
  afterEach(() => vi.unstubAllGlobals());
  const answer = (text: string) => [line('x', { type: 'assistant', message: { id: 'mx', content: [{ type: 'text', text }] } })];

  it('Внешняя ссылка: a link with alt and address, no <img>', () => {
    show(session(), answer('Вот: ![logo](https://example.com/logo.png)'));
    const a = screen.getByRole('link', { name: 'logo (https://example.com/logo.png)' });
    expect(a).toHaveAttribute('target', '_blank');
    expect(document.querySelector('img[src*="example.com"]')).toBeNull();
  });

  it('Локальный путь: «Показать изображение» → POST /api/sessions/:id/images → preview', async () => {
    const s = session();
    const event = {
      kind: 'note',
      id: 'n:7',
      ts: '',
      text: 'Изображение: C:\\Users\\alice\\vault\\.tmp\\chart.png',
      image: { path: 'C:\\Users\\alice\\vault\\.tmp\\chart.png', blob: { $blob: SHA(5), mime: 'image/png', size: 2048, width: 300, height: 200 } },
    };
    const calls = mockFetch({ 'POST /api/sessions/': () => ({ status: 200, body: { event } }) });
    show(s, answer('График: ![график](C:\\Users\\alice\\vault\\.tmp\\chart.png)'));
    await userEvent.click(screen.getByRole('button', { name: 'Показать изображение' }));
    expect(calls[0]).toMatchObject({ url: `/api/sessions/${s.id}/images`, body: { path: 'C:\\Users\\alice\\vault\\.tmp\\chart.png' } });
    expect(await screen.findByText('PNG · 300×200 · 2 КБ')).toBeInTheDocument();
  });

  it('Файла нет или машина офлайн: the reason instead of the preview', async () => {
    mockFetch({ 'POST /api/sessions/': () => ({ status: 404, body: { error: 'file_not_found', message: 'Файл не найден на X1' } }) });
    show(session(), answer('![x](/home/ubuntu/x.png)'));
    await userEvent.click(screen.getByRole('button', { name: 'Показать изображение' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Файл не найден на X1');
  });

  it('a path shown earlier (hub note kind=image) is shown without a request', () => {
    const calls = mockFetch({});
    show(session(), [
      ...answer('![x](/home/ubuntu/x.png)'),
      { kind: 'note', id: 'n:1', ts: '', text: 'Изображение: /home/ubuntu/x.png', image: { path: '/home/ubuntu/x.png', blob: { $blob: SHA(6), mime: 'image/png', size: 100, width: 10, height: 10 } } },
    ]);
    expect(document.querySelector(`img[src="/api/blobs/${SHA(6)}"]`)).not.toBeNull();
    expect(screen.queryByText('Изображение: /home/ubuntu/x.png')).not.toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
});

describe('attachments in the composer (3.18)', () => {
  beforeEach(resetStore);
  afterEach(() => vi.unstubAllGlobals());

  const codec: Codec = { decode: async () => ({ width: 100, height: 80, draw: async () => new Blob([new Uint8Array(10)]) }) };
  const pngFile = (name = 'shot.png') => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])], name, { type: 'image/png' });

  /** XMLHttpRequest of POST /api/uploads answered at once with a sha256 per file. */
  function fakeUploads(status = 201) {
    let n = 0;
    class FakeXhr {
      upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
      status = 0;
      responseText = '';
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      open() {}
      setRequestHeader() {}
      send() {
        setTimeout(() => {
          this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 });
          this.status = status;
          this.responseText = JSON.stringify(status === 201 ? { sha256: SHA(++n), mime: 'image/png', size: 11, width: 100, height: 80 } : { error: 'not_image' });
          this.onload?.();
        }, 0);
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
  }

  it('Вставка скриншота: Ctrl+V adds a thumbnail; Enter sends {text, clientUuid, attachments}', async () => {
    fakeUploads();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined }));
    const s = session();
    const calls = mockFetch({ 'POST /api/sessions/': () => ({ status: 202, body: { session: s } }) });
    show(s, []);
    const box = screen.getByRole('textbox', { name: 'Сообщение' });
    // the browser codec is not available in jsdom: the attachment goes through the test codec
    act(() => addFiles(s.id, [pngFile()], codec));
    await waitFor(() => expect(useAttachments.getState().byKey[s.id]?.[0]?.status).toBe('ready'));
    expect(screen.getByRole('list', { name: 'Прикреплённые изображения' }).querySelectorAll('li')).toHaveLength(1);
    // without text the message goes with the image only
    expect(screen.getByRole('button', { name: 'Отправить' })).toBeEnabled();
    await userEvent.type(box, '{Enter}');
    expect(calls[0]).toMatchObject({ url: `/api/sessions/${s.id}/messages`, body: { text: '', attachments: [{ sha256: SHA(1) }] } });
    // the thumbnails move into an optimistic message until the user line comes back
    expect(screen.queryByRole('list', { name: 'Прикреплённые изображения' })).not.toBeInTheDocument();
    expect(document.querySelector('.msg.user.pending img')).toHaveAttribute('src', 'blob:x');
  });

  it('a paste with image files in the clipboard goes to the attachments', () => {
    const s = session();
    show(s, []);
    const box = screen.getByRole('textbox', { name: 'Сообщение' });
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:y', revokeObjectURL: () => undefined }));
    fireEvent.paste(box, { clipboardData: { files: [pngFile()], types: ['Files'] } });
    expect(useAttachments.getState().byKey[s.id]).toHaveLength(1);
  });

  it('Одиннадцатая картинка: not added, hint «Не больше 10 изображений в сообщении»', () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:z', revokeObjectURL: () => undefined }));
    const s = session();
    show(s, []);
    act(() =>
      addFiles(
        s.id,
        Array.from({ length: 10 }, (_, i) => pngFile(`${i}.png`)),
        codec,
      ),
    );
    act(() => addFiles(s.id, [pngFile('11.png')], codec));
    expect(useAttachments.getState().byKey[s.id]).toHaveLength(10);
    expect(screen.getByRole('alert')).toHaveTextContent('Не больше 10 изображений в сообщении');
  });

  it('Не картинка: the thumbnail says why, the file is not uploaded; «Убрать» removes it', async () => {
    fakeUploads();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:p', revokeObjectURL: () => undefined }));
    const s = session();
    show(s, []);
    act(() => addFiles(s.id, [new File(['%PDF-1.7 hello'], 'doc.png', { type: 'image/png' })], codec));
    const why = await screen.findByText('Формат не поддерживается: PNG, JPEG, GIF, WebP');
    // the refused tile has no picture (no alt of a broken image shows through): the name first, the reason under it
    const tile = why.closest('li')!;
    expect(tile.querySelector('img')).toBeNull();
    expect(tile.querySelector('.attach-error-name')).toHaveTextContent('doc.png');
    expect(screen.getByRole('button', { name: 'Отправить' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Убрать doc.png' }));
    expect(useAttachments.getState().byKey[s.id]).toEqual([]);
  });

  it('Агент старой версии: 409 agent_outdated — «Обновите агент на X1», text and images stay', async () => {
    fakeUploads();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:q', revokeObjectURL: () => undefined }));
    const s = session();
    mockFetch({ 'POST /api/sessions/': () => ({ status: 409, body: { error: 'agent_outdated' } }) });
    show(s, []);
    act(() => addFiles(s.id, [pngFile()], codec));
    await waitFor(() => expect(useAttachments.getState().byKey[s.id]?.[0]?.status).toBe('ready'));
    await userEvent.type(screen.getByRole('textbox', { name: 'Сообщение' }), 'какой код?{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('Обновите агент на X1: он не принимает изображения');
    expect(screen.getByRole('textbox', { name: 'Сообщение' })).toHaveValue('какой код?');
    expect(useAttachments.getState().byKey[s.id]).toHaveLength(1);
  });

  it('502 attachment_delivery_failed: the text and the thumbnails stay; «Повторить» repeats with the same clientUuid', async () => {
    fakeUploads();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:r', revokeObjectURL: () => undefined }));
    const s = session();
    let n = 0;
    const calls = mockFetch({ 'POST /api/sessions/': () => (++n === 1 ? { status: 502, body: { error: 'attachment_delivery_failed' } } : { status: 202, body: { session: s } }) });
    show(s, []);
    act(() => addFiles(s.id, [pngFile()], codec));
    await waitFor(() => expect(useAttachments.getState().byKey[s.id]?.[0]?.status).toBe('ready'));
    await userEvent.type(screen.getByRole('textbox', { name: 'Сообщение' }), 'смотри{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('Изображения не дошли до X1 — сообщение не отправлено');
    expect(screen.getByRole('textbox', { name: 'Сообщение' })).toHaveValue('смотри');
    expect(screen.getByRole('list', { name: 'Прикреплённые изображения' }).querySelectorAll('li')).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect((calls[1]!.body as { clientUuid: string }).clientUuid).toBe((calls[0]!.body as { clientUuid: string }).clientUuid);
    expect(calls[1]!.body).toMatchObject({ text: 'смотри', attachments: [{ sha256: SHA(1) }] });
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Сообщение' })).toHaveValue(''));
    expect(screen.queryByRole('button', { name: 'Повторить' })).toBeNull();
  });

  it('502 attachment_delivery_failed at start: the form keeps the text and the thumbnail; «Повторить» starts the session', async () => {
    fakeUploads();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:n', revokeObjectURL: () => undefined }));
    useStore.setState({ runners: RUNNERS, models: [{ value: 'haiku', displayName: 'Haiku 5.5' }] });
    const created = session({ title: 'код', status: 'working' });
    let n = 0;
    const calls = mockFetch({
      'POST /api/sessions': () => (++n === 1 ? { status: 502, body: { error: 'attachment_delivery_failed' } } : { status: 201, body: created }),
      '/api/sessions/': () => ({ status: 200, body: { events: [], before: null } }),
      '/api/sidebar': () => ({ status: 200, body: { now: [], projects: [], runners: RUNNERS } }),
    });
    const onClose = vi.fn();
    render(<NewSessionModal onClose={onClose} />);
    act(() => addFiles('new', [pngFile()], codec));
    await waitFor(() => expect(useAttachments.getState().byKey.new?.[0]?.status).toBe('ready'));
    await userEvent.type(screen.getByLabelText('Первое сообщение'), 'какой код?');
    await userEvent.click(screen.getByRole('button', { name: 'Запустить' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Изображения не дошли до X1 — сессия не запущена');
    expect(screen.getByLabelText('Первое сообщение')).toHaveValue('какой код?');
    expect(useAttachments.getState().byKey.new).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    const posts = calls.filter(c => c.url === '/api/sessions' && c.method === 'POST');
    expect(posts[1]!.body).toMatchObject({ prompt: 'какой код?', attachments: [{ sha256: SHA(1) }] });
  });

  it('502 attachment_delivery_failed: «Отправить» again also repeats with the same clientUuid', async () => {
    fakeUploads();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:r', revokeObjectURL: () => undefined }));
    const s = session();
    let n = 0;
    const calls = mockFetch({ 'POST /api/sessions/': () => (++n === 1 ? { status: 502, body: { error: 'attachment_delivery_failed' } } : { status: 202, body: { session: s } }) });
    show(s, []);
    act(() => addFiles(s.id, [pngFile()], codec));
    await waitFor(() => expect(useAttachments.getState().byKey[s.id]?.[0]?.status).toBe('ready'));
    await userEvent.type(screen.getByRole('textbox', { name: 'Сообщение' }), 'смотри{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('Изображения не дошли до X1');
    await userEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    expect((calls[1]!.body as { clientUuid: string }).clientUuid).toBe((calls[0]!.body as { clientUuid: string }).clientUuid);
    expect(calls[1]!.body).toMatchObject({ text: 'смотри', attachments: [{ sha256: SHA(1) }] });
  });

  it('Перетаскивание нескольких файлов: the panel is highlighted and three thumbnails appear', () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:d', revokeObjectURL: () => undefined }));
    const s = session();
    show(s, []);
    const panel = document.querySelector('section.chat')!;
    const dt = { types: ['Files'], files: [pngFile('1.png'), pngFile('2.png'), pngFile('3.png')], dropEffect: 'none' };
    fireEvent.dragOver(panel, { dataTransfer: dt });
    expect(panel).toHaveClass('file-drop');
    expect(screen.getByText('Отпустите, чтобы прикрепить изображения')).toBeInTheDocument();
    fireEvent.drop(panel, { dataTransfer: dt });
    expect(panel).not.toHaveClass('file-drop');
    expect(useAttachments.getState().byKey[s.id]).toHaveLength(3);
  });
});
