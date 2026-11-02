import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { McpRegistry } from './McpRegistry';
import { mockFetch, runner } from '../../test/factories';
import { useStore } from '../../store';
import type { McpRegistryDraftState, McpRegistryDraftView, McpRegistryValidation } from '../../api/mcpRegistryTypes';

const blank = { revision: 0, servers: [], drafts: [] };
const reply =
  (body: unknown, status = 200) =>
  () => ({ status, body });
const initial = reply(blank);
const id = '46c2b971-3111-48e9-aef5-f085b4b8df12';
const draft = (state: McpRegistryDraftState = 'draft', validation?: Partial<McpRegistryValidation>): McpRegistryDraftView => ({
  draftId: id,
  revision: 1,
  state,
  server: {
    id,
    name: 'demo',
    enabled: true,
    transport: 'stdio',
    mode: 'machine-shared',
    command: 'node',
    machineScope: { allMachines: true, machineIds: [] },
    projectIds: [],
    revision: 1,
    secrets: [],
  },
  validation: validation ? { ...validation, ok: validation.ok ?? false, oauthRequired: validation.oauthRequired ?? false } : undefined,
});

function isConfirmedBody(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || !('userConfirmed' in body)) return false;
  return body.userConfirmed === true;
}
async function getToCheck() {
  await userEvent.click(screen.getByRole('button', { name: 'Добавить сервер' }));
  await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
  await userEvent.type(screen.getByLabelText('Имя'), 'demo');
  await userEvent.type(screen.getByLabelText('Команда'), 'node');
  await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
  await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
  await userEvent.selectOptions(screen.getByLabelText('Машина для проверки'), id);
  await userEvent.click(screen.getByRole('button', { name: 'Сохранить черновик и проверить' }));
  await screen.findByText('Проверка сервера на выбранной машине');
}

async function getToCheckWithMissingSecret(transport: 'stdio' | 'http') {
  await userEvent.click(screen.getByRole('button', { name: 'Добавить сервер' }));
  if (transport === 'http') {
    await userEvent.selectOptions(screen.getByLabelText('Транспорт'), 'http');
  }
  await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
  await userEvent.type(screen.getByLabelText('Имя'), 'missing-secret-demo');
  if (transport === 'stdio') {
    await userEvent.type(screen.getByLabelText('Команда'), 'node');
    await userEvent.type(screen.getByLabelText(/Переменные среды/), 'API_TOKEN=@secret');
  } else {
    await userEvent.type(screen.getByLabelText('URL'), 'https://example.test/mcp');
    await userEvent.type(screen.getByLabelText(/Заголовки/), 'Authorization=@secret');
  }
  await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
  await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
  await userEvent.selectOptions(screen.getByLabelText('Машина для проверки'), id);
  await userEvent.click(screen.getByRole('button', { name: 'Сохранить черновик и проверить' }));
  await screen.findByText('Проверка сервера на выбранной машине');
}

describe('MCP registry wizard', () => {
  beforeEach(() => {
    useStore.setState({ runners: [runner({ id, name: 'X1' })] });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  it('shows tools after a successful check and allows explicit connect', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const calls = mockFetch({
      'GET /api/mcp/registry': initial,
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([]),
      'POST /api/mcp/registry/drafts': reply(draft(), 201),
      [`POST /api/mcp/registry/drafts/${id}/validate`]: reply(draft('checked', { ok: true, tools: [{ name: 'search' }] })),
      [`POST /api/mcp/registry/drafts/${id}/connect`]: reply({}),
    });
    render(<McpRegistry onClose={() => undefined} />);
    await screen.findByText('Изменение 0');
    await getToCheck();
    await userEvent.click(screen.getByRole('button', { name: 'Проверить' }));
    expect(await screen.findByText(/Проверка успешна/)).toBeInTheDocument();
    expect(screen.getByText('search')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Подключить' }));
    await waitFor(() => expect(calls.some(c => c.url.includes('/connect'))).toBe(true));
  });
  it('shows a safe validation error and keeps ordinary connect disabled', async () => {
    mockFetch({
      'GET /api/mcp/registry': initial,
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([]),
      'POST /api/mcp/registry/drafts': reply(draft(), 201),
      [`POST /api/mcp/registry/drafts/${id}/validate`]: reply(draft('validation-failed', { ok: false, error: 'Connection refused' })),
    });
    render(<McpRegistry onClose={() => undefined} />);
    await screen.findByText('Изменение 0');
    await getToCheck();
    await userEvent.click(screen.getByRole('button', { name: 'Проверить' }));
    expect(await screen.findByText('Ошибка проверки: Connection refused')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Подключить' })).toBeDisabled();
  });

  it('masks secret-like stdio arguments in the validation target', async () => {
    mockFetch({
      'GET /api/mcp/registry': initial,
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([]),
      'POST /api/mcp/registry/drafts': reply(draft(), 201),
    });
    render(<McpRegistry onClose={() => undefined} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Добавить сервер' }));
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.type(screen.getByLabelText('Имя'), 'masked-args-demo');
    await userEvent.type(screen.getByLabelText('Команда'), 'node');
    const hexSecret = '0123456789abcdef0123456789abcdef';
    const base64Secret = 'AbCd1234AbCd1234AbCd1234AbCd1234AbCd1234';
    await userEvent.type(screen.getByLabelText(/Аргументы/), `--token=inline-secret\n--api-key\nseparate-secret\nBearer bearer-secret\n${hexSecret}\n${base64Secret}`);
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.selectOptions(screen.getByLabelText('Машина для проверки'), id);
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить черновик и проверить' }));

    const target = screen.getByRole('note').textContent ?? '';
    expect(target).toContain('--token=••••');
    expect(target).toContain('--api-key ••••');
    expect(target).toContain('Bearer ••••');
    expect(target).not.toContain('inline-secret');
    expect(target).not.toContain('separate-secret');
    expect(target).not.toContain('bearer-secret');
    expect(target).not.toContain(hexSecret);
    expect(target).not.toContain(base64Secret);
  });

  it.each([
    { transport: 'stdio' as const, fieldError: 'Переменная среды «API_TOKEN»' },
    { transport: 'http' as const, fieldError: 'Заголовок «Authorization»' },
  ])('blocks check and unchecked save for an empty $transport secret binding', async ({ transport, fieldError }) => {
    const calls = mockFetch({
      'GET /api/mcp/registry': initial,
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([]),
      'POST /api/mcp/registry/drafts': reply(draft(), 201),
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<McpRegistry onClose={() => undefined} />);
    await getToCheckWithMissingSecret(transport);

    expect(screen.getByRole('alert')).toHaveTextContent(fieldError);
    await userEvent.click(screen.getByRole('button', { name: 'Проверить' }));
    await userEvent.click(screen.getByRole('button', { name: /Сохранить без проверки/ }));
    expect(calls.some(call => call.url.endsWith('/validate'))).toBe(false);
    expect(calls.some(call => call.url.endsWith('/save-unchecked'))).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });
  it('requires a separate confirmation for saving unchecked', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const calls = mockFetch({
      'GET /api/mcp/registry': initial,
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([]),
      'POST /api/mcp/registry/drafts': reply(draft(), 201),
      [`POST /api/mcp/registry/drafts/${id}/save-unchecked`]: reply({}),
    });
    render(<McpRegistry onClose={() => undefined} />);
    await screen.findByText('Изменение 0');
    await getToCheck();
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить без проверки…' }));
    await waitFor(() => expect(calls.some(call => call.url.includes('/save-unchecked') && isConfirmedBody(call.body))).toBe(true));
  });
  it('offers secret entry for needs-secret', async () => {
    mockFetch({
      'GET /api/mcp/registry': initial,
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([]),
      'POST /api/mcp/registry/drafts': reply(draft('needs-secret'), 201),
    });
    render(<McpRegistry onClose={() => undefined} />);
    await screen.findByText('Изменение 0');
    await getToCheck();
    expect(await screen.findByText('Нужен секрет для запуска сервера.')).toBeInTheDocument();
    expect(screen.getByLabelText('Значение секрета')).toHaveAttribute('type', 'password');
  });
  it('clears secret input after draft save and never renders its value', async () => {
    const sentinel = 'super-secret-value';
    mockFetch({ 'GET /api/mcp/registry': initial, 'GET /api/mcp/registry/status': reply({}), 'GET /api/catalog/projects': reply([]), 'POST /api/mcp/registry/drafts': reply(draft(), 201) });
    render(<McpRegistry onClose={() => undefined} />);
    await screen.findByText('Изменение 0');
    await userEvent.click(screen.getByRole('button', { name: 'Добавить сервер' }));
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.type(screen.getByLabelText('Имя'), 'demo');
    await userEvent.type(screen.getByLabelText('Команда'), 'node');
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.type(screen.getByLabelText('Имя секрета (необязательно)'), 'token');
    await userEvent.type(screen.getByLabelText('Значение секрета'), sentinel);
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.selectOptions(screen.getByLabelText('Машина для проверки'), id);
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить черновик и проверить' }));
    await screen.findByText('Проверка сервера на выбранной машине');
    expect(document.body).not.toHaveTextContent(sentinel);
    expect(screen.queryByDisplayValue(sentinel)).not.toBeInTheDocument();
  });

  it('shows import source and secret metadata and commits only selected servers', async () => {
    const serverId = '46c2b971-3111-48e9-aef5-f085b4b8df12';
    const projectId = 'e51cf4c7-96bd-4d84-b01c-cf8e74aa4801';
    const project = { id: projectId, name: 'Demo', description: '', remote: null, archived: false, lastEventAt: null, bindings: [{ runnerId: id, path: 'C:/work/demo' }] };
    const preview = {
      importId: 'c8d7b95d-6fd7-44be-9d44-4bcf4f0c89ad',
      revision: 4,
      servers: [{ ...draft().server, id: serverId, source: 'project' as const, secrets: [{ secretId: '2095c3fc-a7ce-42d4-8ea8-ae791ce950fd', name: 'API_TOKEN', state: 'set' as const }] }],
      secretsCaptured: 1,
      warnings: [],
    };
    const calls = mockFetch({
      'GET /api/mcp/registry': initial,
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([project]),
      'POST /api/mcp/registry/import/preview': reply(preview),
      'POST /api/mcp/registry/import/commit': reply({ revision: 5 }),
    });
    render(<McpRegistry onClose={() => undefined} />);
    await screen.findByRole('dialog');
    await userEvent.selectOptions(screen.getAllByRole('combobox')[0]!, id);
    await userEvent.selectOptions(screen.getAllByRole('combobox')[1]!, projectId);
    await userEvent.click(document.querySelectorAll('.mcp-registry-actions button')[1]!);
    expect(await screen.findByText('.mcp.json · проект')).toBeInTheDocument();
    expect(screen.getByText('Секреты для шифрования: API_TOKEN')).toBeInTheDocument();
    expect(screen.queryByText('secret-value')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Импортировать выбранные серверы' }));
    await waitFor(() =>
      expect(calls.find(call => call.url.endsWith('/import/commit'))?.body).toEqual({
        importId: preview.importId,
        revision: preview.revision,
        serverIds: [serverId],
        userConfirmed: true,
      }),
    );
  });

  it('loads and updates a project override', async () => {
    const project = { id: 'e51cf4c7-96bd-4d84-b01c-cf8e74aa4801', name: 'Demo', description: '', remote: null, archived: false, lastEventAt: null, bindings: [] };
    const server = draft().server;
    const path = `/api/mcp/registry/servers/${server.id}/projects/${project.id}`;
    const calls = mockFetch({
      'GET /api/mcp/registry': reply({ revision: 1, servers: [server], drafts: [] }),
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([project]),
      [`GET ${path}`]: reply({ serverId: server.id, projectId: project.id, enabled: null, revision: 3 }),
      [`PUT ${path}`]: reply({ serverId: server.id, projectId: project.id, enabled: false, revision: 4 }),
    });
    render(<McpRegistry onClose={() => undefined} />);
    await screen.findByText('demo');
    await userEvent.selectOptions(screen.getByLabelText('Переопределение для проекта'), project.id);
    await screen.findByRole('option', { name: 'Включён в проекте' });
    await userEvent.selectOptions(screen.getByLabelText('Доступность в проекте'), 'disabled');
    await waitFor(() => expect(calls.find(call => call.method === 'PUT')?.body).toEqual({ revision: 3, enabled: false }));
  });

  it('deletes a server with its current revision', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const server = draft().server;
    const calls = mockFetch({
      'GET /api/mcp/registry': reply({ revision: 1, servers: [server], drafts: [] }),
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([]),
      [`DELETE /api/mcp/registry/servers/${server.id}`]: () => ({ status: 204 }),
    });
    render(<McpRegistry onClose={() => undefined} />);
    await screen.findByText(server.name);
    await userEvent.click(screen.getByRole('button', { name: /Удалить/ }));
    await waitFor(() => expect(calls.find(call => call.method === 'DELETE')?.body).toEqual({ revision: server.revision }));
  });

  it('edits the instance mode and machine allow-list', async () => {
    const server = draft().server;
    const calls = mockFetch({
      'GET /api/mcp/registry': reply({ revision: 1, servers: [server], drafts: [] }),
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([]),
      [`PATCH /api/mcp/registry/servers/${server.id}`]: reply({
        ...server,
        mode: 'per-session',
        machineScope: { allMachines: false, machineIds: [id] },
      }),
    });
    render(<McpRegistry onClose={() => undefined} />);
    await screen.findByText(server.name);
    await userEvent.click(screen.getByText('Изменить режим и доступ по машинам'));
    await userEvent.selectOptions(screen.getByLabelText('Режим запуска'), 'per-session');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Все машины' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'X1' }));
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    await waitFor(() =>
      expect(calls.find(call => call.method === 'PATCH')?.body).toEqual({
        revision: server.revision,
        mode: 'per-session',
        machineScope: { allMachines: false, machineIds: [id] },
      }),
    );
  });

  it('starts OAuth for an allowed online agent and shows the signed-out state', async () => {
    const server = { ...draft().server, transport: 'http' as const, url: 'https://example.test/mcp' };
    const authWindow = { opener: window, location: { href: '' }, close: vi.fn() } as unknown as Window;
    vi.spyOn(window, 'open').mockReturnValue(authWindow);
    let statusReads = 0;
    const calls = mockFetch({
      'GET /api/mcp/registry': reply({ revision: 1, servers: [server], drafts: [] }),
      'GET /api/mcp/registry/status': () => {
        statusReads += 1;
        return reply({
          revision: 1,
          agents: [{ machineId: id, machineName: 'X1', online: true, protocolVersion: '1.13', capabilities: ['mcp.oauth.v1'] }],
          gateways: [],
          oauth: statusReads === 1 ? [] : [{ serverId: id, machineId: id, state: 'pending' }],
        })();
      },
      [`POST /api/mcp/registry/servers/${id}/oauth/start`]: reply(
        {
          serverId: id,
          machineId: id,
          state: 'pending',
          authorizationUrl: 'https://auth.example.test/login?state=private',
          expiresAt: 1_800_000_000_000,
        },
        202,
      ),
    });
    render(<McpRegistry onClose={() => undefined} />);
    await screen.findByText(server.name);
    await screen.findAllByRole('option', { name: 'X1' });
    expect(screen.getByText('Нужен вход')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));
    await waitFor(() => expect(calls.find(call => call.url.endsWith('/oauth/start'))?.body).toEqual({ machineId: id }));
    expect(authWindow.location.href).toBe('https://auth.example.test/login?state=private');
    expect(await screen.findByText('Выполняется вход')).toBeInTheDocument();
  });

  it('revokes OAuth for the selected machine and refreshes the status', async () => {
    const server = { ...draft().server, transport: 'http' as const, url: 'https://example.test/mcp' };
    let revoked = false;
    const calls = mockFetch({
      'GET /api/mcp/registry': reply({ revision: 1, servers: [server], drafts: [] }),
      'GET /api/mcp/registry/status': () => {
        return reply({
          revision: 1,
          agents: [{ machineId: id, machineName: 'X1', online: true, protocolVersion: '1.13', capabilities: ['mcp.oauth.v1'] }],
          gateways: [],
          oauth: [
            {
              serverId: id,
              machineId: id,
              state: revoked ? 'needs-login' : 'signed-in',
              expiresAt: 1_800_000_000_000,
            },
          ],
        })();
      },
      [`POST /api/mcp/registry/servers/${id}/oauth/revoke`]: () => {
        revoked = true;
        return reply({ serverId: id, machineId: id, state: 'needs-login' })();
      },
    });
    render(<McpRegistry onClose={() => undefined} />);
    await screen.findByText(/Вход выполнен/);
    await userEvent.click(screen.getByRole('button', { name: 'Выйти' }));
    await waitFor(() => expect(calls.find(call => call.url.endsWith('/oauth/revoke'))?.body).toEqual({ machineId: id }));
    expect(await screen.findByText(/Нужен вход/)).toBeInTheDocument();
  });

  it('persists an OAuth draft, signs in, revalidates, and explicitly connects it', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(window, 'open').mockReturnValue({ opener: window, location: { href: '' }, close: vi.fn() } as unknown as Window);
    const persistedServerId = 'a6e6aab4-1528-4a36-a7fa-7beacdc5aa29';
    const httpDraft: McpRegistryDraftView = {
      ...draft('needs_auth'),
      state: 'needs_auth',
      server: { ...draft().server, transport: 'http', url: 'https://example.test/mcp' },
      validation: { ok: false, status: 'needs_auth', oauthRequired: true, tools: [] },
    };
    let statusReads = 0;
    const calls = mockFetch({
      'GET /api/mcp/registry': reply(blank),
      'GET /api/mcp/registry/status': () => {
        statusReads += 1;
        const oauth = statusReads === 1 ? [] : [{ serverId: persistedServerId, machineId: id, state: 'signed-in', validationState: 'needs_auth', connected: false }];
        return reply({
          revision: 1,
          agents: [{ machineId: id, machineName: 'X1', online: true, protocolVersion: '1.13', capabilities: ['mcp.oauth.v1'] }],
          gateways: [],
          oauth,
        })();
      },
      'GET /api/catalog/projects': reply([]),
      'POST /api/mcp/registry/drafts': reply(httpDraft, 201),
      [`POST /api/mcp/registry/drafts/${id}/validate`]: reply(httpDraft),
      [`POST /api/mcp/registry/drafts/${id}/connect`]: reply({ serverId: persistedServerId, state: 'connected', server: { ...httpDraft.server, id: persistedServerId } }),
      [`POST /api/mcp/registry/servers/${persistedServerId}/oauth/start`]: reply(
        {
          serverId: persistedServerId,
          machineId: id,
          state: 'pending',
          authorizationUrl: 'https://auth.example.test/login',
          expiresAt: 1_800_000_000_000,
        },
        202,
      ),
      [`POST /api/mcp/registry/servers/${persistedServerId}/oauth/validate`]: reply({ serverId: persistedServerId, machineId: id, state: 'checked' }),
      [`POST /api/mcp/registry/servers/${persistedServerId}/oauth/connect`]: reply({ serverId: persistedServerId, machineId: id, state: 'connected' }),
    });
    render(<McpRegistry onClose={() => undefined} />);
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('button', { name: 'Добавить сервер' }));
    await userEvent.selectOptions(screen.getByLabelText('Транспорт'), 'http');
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.type(screen.getByLabelText('Имя'), 'oauth-demo');
    await userEvent.type(screen.getByLabelText('URL'), 'https://example.test/mcp');
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.selectOptions(screen.getByLabelText('Машина для проверки'), id);
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить черновик и проверить' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Проверить' }));
    expect(await screen.findByText(/Сервер требует входа/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить и перейти ко входу' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Войти' }));
    await screen.findByRole('button', { name: 'Проверить после входа' }, { timeout: 5000 });
    await userEvent.click(screen.getByRole('button', { name: 'Проверить после входа' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Подключить' }));
    await waitFor(() => {
      expect(calls.some(call => call.url.endsWith('/oauth/start'))).toBe(true);
      expect(calls.some(call => call.url.endsWith('/oauth/validate'))).toBe(true);
      expect(calls.some(call => call.url.endsWith('/oauth/connect'))).toBe(true);
    });
  });

  it('toggles the per-machine registry and reflects the server response', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const calls = mockFetch({
      'GET /api/mcp/registry': reply(blank),
      'GET /api/mcp/registry/status': reply({
        revision: 0,
        agents: [{ machineId: id, machineName: 'X1', online: true, protocolVersion: '1.13', capabilities: ['mcp.registry.v1'], registryEnabled: false }],
        gateways: [],
        oauth: [],
      }),
      'GET /api/catalog/projects': reply([]),
      [`PUT /api/mcp/registry/machines/${id}`]: reply({ machineId: id, registryEnabled: true }),
    });
    render(<McpRegistry onClose={() => undefined} />);
    const toggle = await screen.findByRole('checkbox', { name: /X1/ });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/новых и возобновляемых сессий/i)).toBeInTheDocument();
    await userEvent.click(toggle);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('на X1'));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('.claude.json/.mcp.json'));
    await waitFor(() => expect(calls.find(call => call.url.includes('/machines/'))?.body).toEqual({ enabled: true }));
    expect(toggle).toBeChecked();
  });

  it('does not enable a machine registry when the confirmation is declined', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const calls = mockFetch({
      'GET /api/mcp/registry': reply(blank),
      'GET /api/mcp/registry/status': reply({
        revision: 0,
        agents: [{ machineId: id, machineName: 'X1', online: true, protocolVersion: '1.13', capabilities: [], registryEnabled: false }],
        gateways: [],
        oauth: [],
      }),
      'GET /api/catalog/projects': reply([]),
      [`PUT /api/mcp/registry/machines/${id}`]: reply({ machineId: id, registryEnabled: true }),
    });
    render(<McpRegistry onClose={() => undefined} />);
    const toggle = await screen.findByRole('checkbox', { name: /X1/ });

    await userEvent.click(toggle);

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('на X1'));
    expect(calls.some(call => call.url.includes('/machines/'))).toBe(false);
    expect(toggle).not.toBeChecked();
  });

  it('shows an error when a machine registry toggle fails', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockFetch({
      'GET /api/mcp/registry': reply(blank),
      'GET /api/mcp/registry/status': reply({
        revision: 0,
        agents: [{ machineId: id, machineName: 'X1', online: true, protocolVersion: '1.13', capabilities: [], registryEnabled: false }],
        gateways: [],
        oauth: [],
      }),
      'GET /api/catalog/projects': reply([]),
      [`PUT /api/mcp/registry/machines/${id}`]: reply({ error: 'unavailable', message: 'Machine update failed' }, 503),
    });
    render(<McpRegistry onClose={() => undefined} />);
    const toggle = await screen.findByRole('checkbox', { name: /X1/ });
    await userEvent.click(toggle);
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some(alert => alert.textContent?.includes('503 unavailable'))).toBe(true);
    expect(toggle).not.toBeChecked();
  });

  it('binds an environment entry to the named secret without placing its value in config', async () => {
    const secretValue = 'secret-env-payload';
    const calls = mockFetch({
      'GET /api/mcp/registry': reply(blank),
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([]),
      'POST /api/mcp/registry/drafts': reply(draft(), 201),
    });
    render(<McpRegistry onClose={() => undefined} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Добавить сервер' }));
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.type(screen.getByLabelText('Имя'), 'secret-env-demo');
    await userEvent.type(screen.getByLabelText('Команда'), 'node');
    await userEvent.type(screen.getByLabelText(/Переменные среды/), 'API_TOKEN=@secret');
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.type(screen.getByLabelText('Имя секрета (необязательно)'), 'API_TOKEN');
    await userEvent.type(screen.getByLabelText('Значение секрета'), secretValue);
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.selectOptions(screen.getByLabelText('Машина для проверки'), id);
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить черновик и проверить' }));

    const payload = calls.find(call => call.url.endsWith('/drafts'))?.body as {
      server: { env?: Record<string, unknown>; headers?: Record<string, unknown> };
      secrets?: Array<{ name: string; value: string }>;
    };
    expect(payload.server.env?.API_TOKEN).toEqual({ kind: 'secret-name', name: 'API_TOKEN' });
    expect(JSON.stringify(payload.server.env)).not.toContain(secretValue);
    expect(JSON.stringify(payload.server.headers ?? {})).not.toContain(secretValue);
    expect(payload.secrets).toEqual([{ name: 'API_TOKEN', value: secretValue }]);
  });

  it('binds HTTP headers and URL credentials to the separately entered secret', async () => {
    const secretValue = 'secret-http-payload';
    const calls = mockFetch({
      'GET /api/mcp/registry': reply(blank),
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([]),
      'POST /api/mcp/registry/drafts': reply(draft(), 201),
    });
    render(<McpRegistry onClose={() => undefined} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Добавить сервер' }));
    await userEvent.selectOptions(screen.getByLabelText('Транспорт'), 'http');
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.type(screen.getByLabelText('Имя'), 'secret-http-demo');
    await userEvent.type(screen.getByLabelText('URL'), 'https://example.test/mcp?api_key=__AGENT_HUB_SECRET__');
    await userEvent.type(screen.getByLabelText(/Заголовки/), 'Authorization=@secret');
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.type(screen.getByLabelText('Имя секрета (необязательно)'), 'api-token');
    await userEvent.type(screen.getByLabelText('Значение секрета'), secretValue);
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.selectOptions(screen.getByLabelText('Машина для проверки'), id);
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить черновик и проверить' }));

    const payload = calls.find(call => call.url.endsWith('/drafts'))?.body as {
      server: { url?: string; urlSecretName?: string; env?: Record<string, unknown>; headers?: Record<string, unknown> };
      secrets?: Array<{ name: string; value: string }>;
    };
    expect(payload.server.urlSecretName).toBe('api-token');
    expect(payload.server.headers?.Authorization).toEqual({ kind: 'secret-name', name: 'api-token' });
    expect(JSON.stringify(payload.server.headers)).not.toContain(secretValue);
    expect(payload.server.url).not.toContain(secretValue);
    expect(payload.secrets).toEqual([{ name: 'api-token', value: secretValue }]);
  });
});
