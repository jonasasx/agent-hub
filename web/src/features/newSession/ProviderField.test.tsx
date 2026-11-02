// Change agent-providers (task 4.1, 4.4): «Агент» of the new-session form, the Codex diff in the feed and the card.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useStore } from '../../store';
import { mockFetch, resetStore, runner, session } from '../../test/factories';
import { NewSessionModal } from './NewSessionModal';
import { patchDiff, toolTarget } from '../chat/transcript';
import { PermissionCard } from '../chat/ChatItems';

const CODEX = { id: 'codex' as const, version: '0.166.0', login: 'ok' as const, account: { email: 'ivan@example.com', plan: 'pro' }, models: [{ value: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol' }] };

describe('NewSessionModal: agent', () => {
  beforeEach(resetStore);
  afterEach(() => vi.unstubAllGlobals());

  it('a machine without other providers: shows «Агент», Codex is unavailable, body defaults to Claude', async () => {
    const calls = mockFetch({ 'POST /api/sessions': () => ({ status: 201, body: session({ runnerId: 'x1' }) }) });
    useStore.setState({ runners: [runner({ id: 'x1', name: 'X1' })], models: [{ value: 'opus', displayName: 'Opus 5.5' }] });
    render(<NewSessionModal onClose={vi.fn()} />);
    expect(screen.getByText('Агент')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Codex/ })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Первое сообщение'), 'привет');
    await userEvent.click(screen.getByRole('button', { name: /Запустить/ }));
    expect(calls.find(c => c.url.includes('/api/sessions'))?.body).not.toHaveProperty('provider');
  });

  it('Codex: its models, the account; provider in the body', async () => {
    const calls = mockFetch({ 'POST /api/sessions': () => ({ status: 201, body: session({ runnerId: 'hp', provider: 'codex' }) }) });
    useStore.setState({ runners: [runner({ id: 'hp', name: 'HP', providers: [CODEX] })], models: [{ value: 'opus', displayName: 'Opus 5.5' }] });
    render(<NewSessionModal onClose={vi.fn()} />);
    const codex = screen.getByRole('radio', { name: /Codex/ });
    expect(codex).toHaveTextContent('ivan@example.com · pro');
    await userEvent.click(codex);
    expect(screen.getByLabelText('Модель')).toHaveValue('gpt-6.1-sol');
    await userEvent.type(screen.getByLabelText('Первое сообщение'), 'привет');
    await userEvent.click(screen.getByRole('button', { name: /Запустить/ }));
    const body = calls.find(c => c.url.includes('/api/sessions'))?.body as Record<string, unknown>;
    expect(body).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol', runnerId: 'hp' });
  });

  it('Codex without a machine sign-in: still selectable — it runs under a subscription of the registry', () => {
    useStore.setState({ runners: [runner({ id: 'hp', name: 'HP', providers: [{ id: 'codex', version: '0.166.0', login: 'missing' }] })], models: [{ value: 'opus', displayName: 'Opus 5.5' }] });
    render(<NewSessionModal onClose={vi.fn()} />);
    expect(screen.getByRole('radio', { name: /Codex/ })).toBeEnabled();
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
