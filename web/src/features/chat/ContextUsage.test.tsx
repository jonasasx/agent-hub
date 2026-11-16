// Requirements (session-context-usage): Индикатор заполнения в поле ввода; Разбивка контекстного окна; Сжатие контекста из хаба.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SessionContextView } from '@agent-hub/shared';
import type { SessionView } from '../../api/types';
import { useStore } from '../../store';
import { mockFetch, resetStore, session } from '../../test/factories';
import { ContextRing, contextTone, formatTokens } from './ContextUsage';

const CLAUDE_CTX: SessionContextView = {
  observedAt: '2026-11-14T15:30:00.000Z',
  model: 'claude-haiku-5-5',
  usedTokens: 66000,
  windowTokens: 200000,
  percent: 33,
  categories: [
    { id: 'system_tools', name: 'System tools', kind: 'used', tokens: 6000 },
    { id: 'messages', name: 'Messages', kind: 'used', tokens: 60000 },
    { id: 'mcp_tools_deferred', name: 'MCP tools (deferred)', kind: 'deferred', tokens: 268000 },
    { id: 'autocompact_buffer', name: 'Autocompact buffer', kind: 'buffer', tokens: 33000 },
    { id: 'free_space', name: 'Free space', kind: 'free', tokens: 101000 },
  ],
  mcpServers: [{ name: 'agent-hub', tools: 12, loadedTools: 2, tokens: 900 }],
  memoryFiles: [{ path: '/home/ubuntu/vault/AGENTS.md', type: 'Project', tokens: 9000 }],
  skills: [],
  agents: [],
};

function setup(s: SessionView, ctx: SessionContextView | null, busy = false) {
  useStore.getState().upsertSessions([s]);
  const calls = mockFetch({
    'GET /api/sessions/': () => ({ status: 200, body: { context: ctx } }),
    'POST /api/sessions/': () => ({ status: 200, body: { session: s } }),
  });
  render(<ContextRing s={s} busy={busy} />);
  return { calls };
}

describe('context ring', () => {
  beforeEach(() => resetStore());
  afterEach(() => vi.unstubAllGlobals());

  it('formats tokens and picks the tone by the thresholds 80/95', () => {
    expect([formatTokens(950), formatTokens(66300), formatTokens(1_234_567), formatTokens(1_000_000)]).toEqual(['950', '66k', '1.2M', '1M']);
    expect([contextTone(79), contextTone(80), contextTone(94), contextTone(95), contextTone(120)]).toEqual(['', 'warn', 'warn', 'danger', 'danger']);
  });

  it('no snapshot — no ring', () => {
    const { container } = render(<ContextRing s={session({ context: null })} busy={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('33%: a neutral ring with the tooltip «66k из 200k токенов»; 96% is red', () => {
    const { rerender } = render(<ContextRing s={session({ context: { usedTokens: 66000, windowTokens: 200000, percent: 33 } })} busy={false} />);
    const ring = screen.getByRole('button', { name: 'Контекст заполнен на 33%' });
    expect(ring).toHaveTextContent('33%');
    expect(ring).toHaveAttribute('title', '66k из 200k токенов');
    expect(ring.className).toBe('ctx-ring');
    rerender(<ContextRing s={session({ context: { usedTokens: 192000, windowTokens: 200000, percent: 96 } })} busy={false} />);
    expect(screen.getByRole('button', { name: 'Контекст заполнен на 96%' })).toHaveClass('danger');
  });

  it('Claude: the breakdown has categories, «Не в окне», folded lists and «Сжать контекст» sends /compact', async () => {
    const s = session({ provider: 'claude', context: { usedTokens: 66000, windowTokens: 200000, percent: 33 } });
    const { calls } = setup(s, CLAUDE_CTX);
    await userEvent.click(screen.getByRole('button', { name: 'Контекст заполнен на 33%' }));
    const panel = screen.getByRole('dialog', { name: 'Контекстное окно' });
    await waitFor(() => expect(panel).toHaveTextContent('Messages'));
    expect(calls[0]?.url).toBe(`/api/sessions/${s.id}/context`);
    expect(panel).toHaveTextContent('66k из 200k токенов · 33%');
    expect(panel).toHaveTextContent('claude-haiku-5-5');
    expect(panel).toHaveTextContent('Не в окне');
    expect(panel).toHaveTextContent('MCP tools (deferred)');
    expect(panel).toHaveTextContent('Состав');
    expect(panel.querySelector('.sw.buffer')).not.toBeNull();
    expect(screen.getByText('MCP-серверы').closest('details')).not.toHaveAttribute('open');
    expect(panel).toHaveTextContent('2 из 12 загружено');
    expect(panel).not.toHaveTextContent('Skills');
    await userEvent.click(screen.getByRole('button', { name: 'Сжать контекст' }));
    await waitFor(() => expect(calls.some(c => c.method === 'POST')).toBe(true));
    const post = calls.find(c => c.method === 'POST');
    expect(post?.url).toBe(`/api/sessions/${s.id}/messages`);
    expect(post?.body).toMatchObject({ text: '/compact' });
  });

  it('«Сжать контекст» is disabled while the session works and keeps the draft', async () => {
    const s = session({ provider: 'claude', context: { usedTokens: 66000, windowTokens: 200000, percent: 33 } });
    useStore.setState({ drafts: { [s.id]: 'черновик' } });
    setup(s, CLAUDE_CTX, true);
    await userEvent.click(screen.getByRole('button', { name: 'Контекст заполнен на 33%' }));
    expect(screen.getByRole('button', { name: 'Сжать контекст' })).toBeDisabled();
    expect(useStore.getState().drafts[s.id]).toBe('черновик');
  });

  it('Codex: the bar of used and free space only, no categories and no «Сжать контекст»', async () => {
    const s = session({ provider: 'codex', context: { usedTokens: 95000, windowTokens: 475000, percent: 20 } });
    setup(s, { observedAt: '2026-11-14T15:30:00.000Z', model: 'gpt-5.5', usedTokens: 95000, windowTokens: 475000, percent: 20 });
    await userEvent.click(screen.getByRole('button', { name: 'Контекст заполнен на 20%' }));
    const panel = screen.getByRole('dialog', { name: 'Контекстное окно' });
    await waitFor(() => expect(panel.querySelectorAll('.ctx-bar > span')).toHaveLength(2));
    expect(panel.querySelector('.ctx-rows')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Сжать контекст' })).toBeNull();
  });
});
