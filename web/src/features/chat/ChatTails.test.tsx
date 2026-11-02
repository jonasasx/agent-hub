// Component tests of the M3b tails done in M3c: «Повторить» on «Сообщение не доставлено» and «Показать полностью» of a
// big output saved to tool-results. Contract (M3c): note `undelivered: {text, attachments, clientUuid}`, line
// `sideFiles: [{name, url}]`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HubEvent, SessionView } from '../../api/types';
import { useStore } from '../../store';
import { RUNNERS, mockFetch, resetStore, session } from '../../test/factories';
import { useAttachments } from '../images/attachments';
import { Chat } from './Chat';
import { buildChat } from './transcript';

const SHA = (n: number) => String(n).repeat(64).slice(0, 64);
const line = (id: string, l: Record<string, unknown>, extra: Record<string, unknown> = {}): HubEvent => ({ kind: 'line', id, ts: '', line: l, ...extra }) as HubEvent;

function show(s: SessionView, events: HubEvent[]) {
  useStore.setState({ runners: RUNNERS, models: [{ value: 'opus', displayName: 'Opus 5.5' }] });
  useStore.getState().upsertSessions([s]);
  useStore.setState({ logs: { [s.id]: { events, before: null, loaded: true, loading: false, error: null } } });
  return render(<Chat session={s} paneId="p1" />);
}

const undelivered = (): HubEvent =>
  ({
    kind: 'note',
    id: 'n:1',
    ts: '',
    text: 'Сообщение не доставлено — сессия завершилась, отправьте ещё раз: «сверь логи» + 2 изображения',
    undelivered: {
      text: 'сверь логи',
      attachments: [
        { sha256: SHA(1), mime: 'image/png', size: 1000, width: 800, height: 600 },
        { sha256: SHA(2), mime: 'image/jpeg', size: 2000 },
      ],
      clientUuid: 'c-1',
    },
  }) as HubEvent;

const PERSISTED = (name: string) =>
  `<persisted-output>\nOutput too large (30.3KB). Full output saved to: C:\\Users\\alice\\.claude\\projects\\p\\sid\\tool-results\\${name}\n\nPreview (first 2KB):\nfirst lines\n</persisted-output>`;
const bigOutput = (files: { name: string; url: string }[]) => [
  line('a', { type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 'toolu_9', name: 'Bash', input: { command: 'grep -rn x .' } }] } }),
  line('b', { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: PERSISTED('toolu_9.txt') }] } }, { sideFiles: files }),
];

describe('«Сообщение не доставлено» (UI review M3b)', () => {
  beforeEach(resetStore);
  afterEach(() => vi.unstubAllGlobals());

  it('«Повторить» puts the text and the images (by sha256, no upload) back into the composer', async () => {
    const s = session();
    const calls = mockFetch({});
    show(s, [undelivered()]);
    await userEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(screen.getByRole('textbox', { name: 'Сообщение' })).toHaveValue('сверь логи');
    const list = useAttachments.getState().byKey[s.id]!;
    expect(list.map(a => [a.status, a.sha256, a.url])).toEqual([
      ['ready', SHA(1), `/api/blobs/${SHA(1)}`],
      ['ready', SHA(2), `/api/blobs/${SHA(2)}`],
    ]);
    expect(screen.getByRole('button', { name: 'Отправить' })).toBeEnabled();
    // twice: nothing doubles
    await userEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(screen.getByRole('textbox', { name: 'Сообщение' })).toHaveValue('сверь логи');
    expect(useAttachments.getState().byKey[s.id]).toHaveLength(2);
    expect(calls.some(c => c.url.includes('/api/uploads'))).toBe(false);
  });

  it('a draft already typed is kept, the text goes under it; a plain note has no button', async () => {
    const s = session();
    mockFetch({});
    useStore.setState({ drafts: { [s.id]: 'и ещё' } });
    show(s, [{ kind: 'note', id: 'n:0', ts: '', text: 'X1 не в сети — сообщение ожидает доставки: «a»' } as HubEvent, undelivered()]);
    expect(screen.getAllByRole('button', { name: 'Повторить' })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(screen.getByRole('textbox', { name: 'Сообщение' })).toHaveValue('и ещё\nсверь логи');
  });
});

describe('big output saved to tool-results (UI review M3b)', () => {
  beforeEach(resetStore);
  afterEach(() => vi.unstubAllGlobals());

  it('the result links the side file whose name is in the path', () => {
    const items = buildChat(
      bigOutput([
        { name: 'other.txt', url: '/x' },
        { name: 'toolu_9.txt', url: '/api/sessions/s/tool-results/toolu_9.txt?sid=sid' },
      ]),
    );
    const t = items.find(i => i.kind === 'tool');
    expect(t?.kind === 'tool' && t.result?.side).toEqual({ name: 'toolu_9.txt', url: '/api/sessions/s/tool-results/toolu_9.txt?sid=sid', size: '30.3KB' });
    // no sideFiles (an older hub): no button
    const bare = buildChat(bigOutput([])).find(i => i.kind === 'tool');
    expect(bare?.kind === 'tool' && bare.result?.side).toBeUndefined();
  });

  it('«Показать полностью» opens the hub copy; 404 says it has not arrived yet', async () => {
    let arrived = false;
    const url = '/api/sessions/s/tool-results/toolu_9.txt?sid=sid';
    mockFetch({
      '/api/sessions/s/tool-results/': () =>
        arrived ? { status: 200, body: 'весь вывод grep' } : { status: 404, body: { error: 'not_found', message: 'Полный вывод ещё не дошёл до хаба — попробуйте позже' } },
    });
    show(session(), bigOutput([{ name: 'toolu_9.txt', url }]));
    fireEvent.click(document.querySelector('summary')!);
    await userEvent.click(screen.getByRole('button', { name: 'Показать полностью · 30.3KB' }));
    expect(await screen.findByText('Полный вывод ещё не дошёл до хаба — попробуйте позже')).toBeInTheDocument();
    arrived = true;
    await userEvent.click(screen.getByRole('button', { name: 'Показать полностью · 30.3KB' }));
    expect(await screen.findByText('"весь вывод grep"')).toBeInTheDocument();
  });
});

describe('«Показать полностью» shows the whole output (QA M3c)', () => {
  beforeEach(resetStore);
  afterEach(() => vi.unstubAllGlobals());

  it('340 KB: nothing is cut; it comes in parts, «Показать дальше» brings the rest', async () => {
    const full = Array.from({ length: 8500 }, (_, i) => `src/file${i}.ts:${i + 1}: match ${i}`)
      .join('\n')
      .padEnd(340_000, 'x');
    expect(full.length).toBe(340_000);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(full, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } })),
    );
    show(session(), bigOutput([{ name: 'toolu_9.txt', url: '/api/sessions/s/tool-results/toolu_9.txt?sid=sid' }]));
    fireEvent.click(document.querySelector('summary')!);
    await userEvent.click(screen.getByRole('button', { name: /Показать полностью/ }));
    const pre = await vi.waitFor(() => document.querySelector('pre.long-text')!);
    expect(pre.textContent!.length).toBe(128_000);
    expect(full.startsWith(pre.textContent!)).toBe(true);
    for (let i = 0; i < 5 && screen.queryByRole('button', { name: /Показать дальше/ }); i++) await userEvent.click(screen.getByRole('button', { name: /Показать дальше/ }));
    expect(screen.queryByRole('button', { name: /Показать дальше/ })).not.toBeInTheDocument();
    expect(document.querySelector('pre.long-text')!.textContent).toBe(full);
  });

  it('up to 200 KB at once', async () => {
    const full = 'y'.repeat(150_000);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(full, { status: 200 })),
    );
    show(session(), bigOutput([{ name: 'toolu_9.txt', url: '/api/sessions/s/tool-results/toolu_9.txt?sid=sid' }]));
    fireEvent.click(document.querySelector('summary')!);
    await userEvent.click(screen.getByRole('button', { name: /Показать полностью/ }));
    await vi.waitFor(() => expect(document.querySelector('pre.long-text')!.textContent).toBe(full));
    expect(screen.queryByRole('button', { name: /Показать дальше/ })).not.toBeInTheDocument();
  });
});
