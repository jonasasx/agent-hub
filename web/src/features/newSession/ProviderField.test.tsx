// Change agent-providers (task 4.1, 4.4): «Агент» of the new-session form, the Codex diff in the feed and the card.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useStore } from '../../store';
import { mockFetch, resetStore, runner, session } from '../../test/factories';
import { openDraft } from '../workspace/actions';
import { DraftView } from './DraftView';
import { patchDiff, toolTarget } from '../chat/transcript';
import { PermissionCard } from '../chat/ChatItems';

/** A draft tab of the focused pane, rendered alone. */
function showDraft() {
  act(() => openDraft());
  const ws = useStore.getState().ws;
  render(<DraftView draftId={ws.panes[ws.focus]!.active!} paneId={ws.focus} />);
}

const CODEX = { id: 'codex' as const, version: '0.166.0', login: 'ok' as const, account: { email: 'ivan@example.com', plan: 'pro' }, models: [{ value: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol' }] };

describe('Draft: agent', () => {
  beforeEach(resetStore);
  afterEach(() => vi.unstubAllGlobals());

  it('a machine without other providers: shows «Агент», Codex is unavailable, body defaults to Claude', async () => {
    const calls = mockFetch({ 'POST /api/sessions': () => ({ status: 201, body: session({ runnerId: 'x1' }) }) });
    useStore.setState({ runners: [runner({ id: 'x1', name: 'X1' })], models: [{ value: 'opus', displayName: 'Opus 5.5' }] });
    showDraft();
    await userEvent.click(screen.getByRole('button', { name: 'Агент: Claude' }));
    expect(screen.getByRole('menuitemradio', { name: /Codex/ })).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    await userEvent.type(screen.getByLabelText('Первое сообщение'), 'привет{Enter}');
    expect(calls.find(c => c.url.includes('/api/sessions'))?.body).not.toHaveProperty('provider');
  });

  it('Codex: its models, the account; provider in the body', async () => {
    const calls = mockFetch({ 'POST /api/sessions': () => ({ status: 201, body: session({ runnerId: 'hp', provider: 'codex' }) }) });
    useStore.setState({ runners: [runner({ id: 'hp', name: 'HP', providers: [CODEX] })], models: [{ value: 'opus', displayName: 'Opus 5.5' }] });
    showDraft();
    await userEvent.click(screen.getByRole('button', { name: 'Агент: Claude' }));
    const codex = screen.getByRole('menuitemradio', { name: /Codex/ });
    expect(codex).toHaveTextContent('ivan@example.com · pro');
    await userEvent.click(codex);
    expect(screen.getByRole('button', { name: 'Модель: GPT-6.1-Sol' })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Первое сообщение'), 'привет{Enter}');
    const body = calls.find(c => c.url.includes('/api/sessions'))?.body as Record<string, unknown>;
    expect(body).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol', runnerId: 'hp' });
  });

  it('Codex without a machine sign-in: still selectable — it runs under a subscription of the registry', async () => {
    mockFetch({});
    useStore.setState({ runners: [runner({ id: 'hp', name: 'HP', providers: [{ id: 'codex', version: '0.166.0', login: 'missing' }] })], models: [{ value: 'opus', displayName: 'Opus 5.5' }] });
    showDraft();
    await userEvent.click(screen.getByRole('button', { name: 'Агент: Claude' }));
    expect(screen.getByRole('menuitemradio', { name: /Codex/ })).toBeEnabled();
  });

  // Change qwen-provider (web, design D2/D6): no sign-in, no subscription field, the models of the endpoint
  it('Qwen: offered while the endpoint answers, no subscription chip, provider and model in the body', async () => {
    const calls = mockFetch({ 'POST /api/sessions': () => ({ status: 201, body: session({ runnerId: 'gpu', provider: 'qwen' }) }) });
    const QWEN = { id: 'qwen' as const, version: '0.27.4', login: 'ok' as const, models: [{ value: 'qwen3.8-flash-next', displayName: 'qwen3.8-flash-next' }] };
    useStore.setState({ runners: [runner({ id: 'gpu', name: 'GPU', providers: [QWEN] })], models: [{ value: 'opus', displayName: 'Opus 5.5' }] });
    showDraft();
    await userEvent.click(screen.getByRole('button', { name: 'Агент: Claude' }));
    const qwen = screen.getByRole('menuitemradio', { name: /Qwen/ });
    expect(qwen).toBeEnabled();
    expect(qwen).toHaveTextContent('свой эндпоинт модели');
    await userEvent.click(qwen);
    expect(screen.getByRole('button', { name: 'Модель: qwen3.8-flash-next' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Подписка/ })).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Первое сообщение'), 'привет{Enter}');
    const body = calls.find(c => c.url.includes('/api/sessions'))?.body as Record<string, unknown>;
    expect(body).toMatchObject({ provider: 'qwen', model: 'qwen3.8-flash-next', runnerId: 'gpu' });
    expect(body).not.toHaveProperty('subscriptionId');
  });

  it('Qwen with a rejected key or an endpoint that does not answer: disabled with the reason', async () => {
    mockFetch({});
    useStore.setState({ runners: [runner({ id: 'gpu', name: 'GPU', providers: [{ id: 'qwen', version: '0.27.4', login: 'rejected' }] })], models: [{ value: 'opus', displayName: 'Opus 5.5' }] });
    showDraft();
    await userEvent.click(screen.getByRole('button', { name: 'Агент: Claude' }));
    const qwen = screen.getByRole('menuitemradio', { name: /Qwen/ });
    expect(qwen).toBeDisabled();
    expect(qwen).toHaveTextContent('эндпоинт модели не отвечает');
  });
});

describe('ApplyPatch', () => {
  const input = {
    changes: [
      { path: 'src/a.ts', kind: 'update', diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n' },
      { path: 'b.md', kind: 'add', diff: 'line1\nline2\n' },
    ],
  };
  it('diff: a header per file, hunks, an added file as additions; target names the files', () => {
    expect(patchDiff(input)).toEqual([
      { kind: 'hunk', text: 'изменён: src/a.ts' },
      { kind: 'hunk', text: '@@ -1,2 +1,2 @@' },
      { kind: 'ctx', text: 'ctx' },
      { kind: 'del', text: 'old' },
      { kind: 'add', text: 'new' },
      { kind: 'hunk', text: 'новый файл: b.md' },
      { kind: 'add', text: 'line1' },
      { kind: 'add', text: 'line2' },
    ]);
    expect(toolTarget('ApplyPatch', input)).toBe('src/a.ts и ещё 1');
  });
  it('the permission card of Codex shows the diff', () => {
    render(<PermissionCard agent="Codex" request={{ requestId: 'r', toolName: 'ApplyPatch', input, createdAt: new Date().toISOString() } as never} disabled={false} onDecide={vi.fn()} />);
    expect(screen.getByText(/Codex просит разрешение: ApplyPatch/)).toBeInTheDocument();
    expect(screen.getByText(/изменён: src\/a.ts/)).toBeInTheDocument();
  });
});
