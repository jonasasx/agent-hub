// Component tests of the MCP import panel (change `mcp-hub-only`, spec machine-mcp-onboarding «Шаг MCP в мастере подключения машины»).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { McpImportEntry } from '../../api/mcpRegistryTypes';
import { mcpImportPreview, mockFetch } from '../../test/factories';
import { McpImportPanel } from './McpImportPanel';

const entry = (n: number, over: Partial<McpImportEntry> = {}): McpImportEntry => ({
  id: `46c2b971-3111-48e9-aef5-f085b4b8df1${n}`,
  name: `srv${n}`,
  transport: 'stdio',
  command: 'node',
  source: 'user',
  decision: 'new',
  selected: true,
  selectable: true,
  warnings: [],
  secrets: [],
  ...over,
});

describe('McpImportPanel', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('preselects the found servers; one of five unchecked → four imported', async () => {
    const servers = [1, 2, 3, 4, 5].map(n => entry(n));
    const preview = mcpImportPreview({ servers });
    const calls = mockFetch({
      'POST /api/mcp/registry/import/preview': () => ({ status: 200, body: preview }),
      'POST /api/mcp/registry/import/commit': () => ({ status: 200, body: { imported: 4, servers: [] } }),
    });
    const onImported = vi.fn();
    render(<McpImportPanel machineId="r-abc" onClose={() => undefined} onImported={onImported} />);
    expect(screen.getByText('Читаю настройки MCP на машине…')).toBeInTheDocument();
    expect(await screen.findByRole('checkbox', { name: 'srv1' })).toBeChecked();
    expect(screen.getAllByRole('checkbox').every(box => (box as HTMLInputElement).checked)).toBe(true);
    await userEvent.click(screen.getByRole('checkbox', { name: 'srv3' }));
    await userEvent.click(screen.getByRole('button', { name: 'Импортировать 4 сервера' }));
    expect(await screen.findByText('Импортировано: 4.')).toBeInTheDocument();
    expect(calls.find(call => call.url.endsWith('/import/commit'))?.body).toEqual({
      importId: preview.importId,
      revision: preview.revision,
      serverIds: servers.filter(server => server.name !== 'srv3').map(server => server.id),
      userConfirmed: true,
    });
    expect(onImported).toHaveBeenCalledWith({ imported: 4, servers: [] });
  });

  it('a server the hub does not offer stays unchecked and disabled; a conflict and warnings are shown', async () => {
    mockFetch({
      'POST /api/mcp/registry/import/preview': () => ({
        status: 200,
        body: mcpImportPreview({
          servers: [entry(1), entry(2, { decision: 'conflict', selected: false, selectable: false, warnings: ['unbound-path'] })],
        }),
      }),
    });
    render(<McpImportPanel machineId="r-abc" onClose={() => undefined} />);
    const blocked = await screen.findByRole('checkbox', { name: 'srv2' });
    expect(blocked).not.toBeChecked();
    expect(blocked).toBeDisabled();
    expect(screen.getByText('Имя занято')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Импортировать 1 сервер' })).toBeEnabled();
  });

  it('«Пропустить» leaves without a commit', async () => {
    const calls = mockFetch({ 'POST /api/mcp/registry/import/preview': () => ({ status: 200, body: mcpImportPreview({ servers: [entry(1)] }) }) });
    const onClose = vi.fn();
    render(<McpImportPanel machineId="r-abc" onClose={onClose} />);
    await screen.findByRole('checkbox', { name: 'srv1' });
    await userEvent.click(screen.getByRole('button', { name: 'Пропустить' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(calls.some(call => call.url.endsWith('/import/commit'))).toBe(false);
  });

  it('«Пропустить» while the machine is still being scanned', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => undefined)),
    );
    const onClose = vi.fn();
    render(<McpImportPanel machineId="r-abc" onClose={onClose} skipLabel="Отмена" />);
    expect(screen.getByRole('status')).toHaveTextContent('Читаю настройки MCP на машине…');
    await userEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('an outdated agent → the reason and «Повторить» scans again', async () => {
    let attempts = 0;
    mockFetch({
      'POST /api/mcp/registry/import/preview': () => {
        attempts += 1;
        return attempts === 1 ? { status: 409, body: { error: 'agent_outdated' } } : { status: 200, body: mcpImportPreview({ servers: [entry(1)] }) };
      },
    });
    render(<McpImportPanel machineId="r-abc" onClose={() => undefined} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Агент на машине устарел. Обновите его, чтобы импортировать MCP.');
    await userEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByRole('checkbox', { name: 'srv1' })).toBeChecked();
    await waitFor(() => expect(attempts).toBe(2));
  });

  it('nothing found → the empty text, «Закрыть» and the extra actions; the claude.ai notice', async () => {
    mockFetch({ 'POST /api/mcp/registry/import/preview': () => ({ status: 200, body: mcpImportPreview({ notices: ['claude-ai-connectors'] }) }) });
    render(<McpImportPanel machineId="r-abc" onClose={() => undefined} doneActions={<button type="button">Начать первую сессию</button>} />);
    expect(await screen.findByText('В настройках Claude Code и Codex на этой машине MCP-серверов нет.')).toBeInTheDocument();
    expect(screen.getByText(/Коннекторы claude\.ai не импортируются/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Закрыть' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Начать первую сессию' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Импортировать/ })).toBeNull();
  });
});
