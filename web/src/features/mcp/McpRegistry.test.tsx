import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { McpRegistry } from './McpRegistry';
import { mcpImportPreview, mockFetch, runner } from '../../test/factories';
import { useStore } from '../../store';
import type { McpImportEntry, McpRegistryDraftState, McpRegistryDraftView, McpRegistryValidation } from '../../api/mcpRegistryTypes';

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
  await userEvent.click(screen.getByRole('radio', { name: /X1/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Сохранить черновик и проверить' }));
  await screen.findByText('Проверка сервера на выбранной машине');
}

async function getToCheckWithMissingSecret(transport: 'stdio' | 'http') {
  await userEvent.click(screen.getByRole('button', { name: 'Добавить сервер' }));
  if (transport === 'http') {
    await userEvent.click(screen.getByRole('radio', { name: /Удалённый HTTP/ }));
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
  await userEvent.click(screen.getByRole('radio', { name: /X1/ }));
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
  it('renders transport choices as descriptive radio segments', async () => {
    mockFetch({
      'GET /api/mcp/registry': initial,
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([]),
    });
    render(<McpRegistry onClose={() => undefined} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Добавить сервер' }));

    const group = screen.getByRole('radiogroup', { name: 'Транспорт' });
    expect(group).toHaveClass('seg');
    expect(screen.getByRole('radio', { name: /Команда \(stdio\).*npx, uvx, локальный процесс/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Удалённый HTTP.*URL сервера/ })).toBeInTheDocument();
  });
  it('returns to the registry when closing the wizard after confirming unsaved input', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockFetch({
      'GET /api/mcp/registry': initial,
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([]),
    });
    render(<McpRegistry onClose={() => undefined} />);
    await userEvent.click(await screen.findByRole('button', { name: /Добавить сервер/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.type(screen.getByLabelText('Имя'), 'unsaved');
    await userEvent.click(screen.getByRole('button', { name: 'Закрыть' }));

    expect(confirm).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Добавить сервер/ })).toBeInTheDocument();
  });

  it('skips secrets and restricts scope to machine options', async () => {
    const calls = mockFetch({
      'GET /api/mcp/registry': initial,
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([]),
      'POST /api/mcp/registry/drafts': reply(draft(), 201),
    });
    useStore.setState({ runners: [runner({ id, name: 'X1' }), runner({ id: 'vm-2', name: 'Y2' })] });
    render(<McpRegistry onClose={() => undefined} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Добавить сервер' }));
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.type(screen.getByLabelText('Имя'), 'no-secret-demo');
    await userEvent.type(screen.getByLabelText('Команда'), 'node');
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));

    expect(screen.queryByLabelText('Имя секрета (необязательно)')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Добавление сервера · шаг 3 из 4' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Режим' })).toBeInTheDocument();
    const scopeGroup = screen.getAllByRole('radiogroup').at(-2)!;
    expect(scopeGroup.querySelectorAll('[role="radio"]')).toHaveLength(2);
    await userEvent.click(scopeGroup.querySelectorAll('[role="radio"]')[1] as HTMLElement);
    await userEvent.click(screen.getByRole('checkbox', { name: /X1/ }));
    await userEvent.click(screen.getByRole('radio', { name: /X1/ }));
    expect(screen.getAllByRole('radiogroup').at(-1)).not.toHaveTextContent('Y2');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить черновик и проверить' }));
    const createCall = await waitFor(() => calls.find(call => call.url.endsWith('/drafts')));
    expect(createCall?.body).toMatchObject({
      server: { machineScope: { allMachines: false, machineIds: [id] }, projectIds: [] },
    });
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
    render(<McpRegistry sessionId="originating-session" onClose={() => undefined} />);
    await screen.findByText('Изменение 0');
    await getToCheck();
    await userEvent.click(screen.getByRole('button', { name: 'Проверить' }));
    expect(await screen.findByText(/Проверка успешна/)).toBeInTheDocument();
    expect(screen.getByText('search')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Подключить' }));
    await waitFor(() => expect(calls.some(c => c.url.includes('/connect'))).toBe(true));
    expect(calls.find(call => call.url.endsWith('/drafts'))?.body).toMatchObject({ sessionId: 'originating-session' });
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
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection refused');
    expect(screen.queryByText('Подробности')).not.toBeInTheDocument();
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
    await userEvent.click(screen.getByRole('radio', { name: /X1/ }));
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
  it('shows a single grammatical prompt when no validation machine is selected', async () => {
    mockFetch({
      'GET /api/mcp/registry': initial,
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([]),
    });
    render(<McpRegistry onClose={() => undefined} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Добавить сервер' }));
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.type(screen.getByLabelText('Имя'), 'prompt-demo');
    await userEvent.type(screen.getByLabelText('Команда'), 'node');
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));

    expect(screen.getAllByText('Выберите машину для проверки среди вариантов ниже.')).toHaveLength(1);
    expect(screen.queryByText('Выберите онлайн-машину из доступных вариантов.')).not.toBeInTheDocument();
  });

  it('does not render a separator under a draft name without a description', async () => {
    mockFetch({
      'GET /api/mcp/registry': reply({ ...blank, drafts: [draft('validation-failed')] }),
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([]),
    });
    render(<McpRegistry onClose={() => undefined} />);

    expect(await screen.findByRole('region', { name: /Черновики/ })).not.toHaveTextContent('·');
  });

  it('maps legacy project drafts to the selected machines scope', async () => {
    const resumedDraft = draft();
    resumedDraft.server.machineScope = { allMachines: true, machineIds: ['vm'] };
    resumedDraft.server.projectIds = ['e51cf4c7-96bd-4d84-b01c-cf8e74aa4801'];
    useStore.setState({ runners: [runner({ id: 'vm', name: 'VM', online: false })] });
    mockFetch({
      'GET /api/mcp/registry': reply({ ...blank, drafts: [resumedDraft] }),
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([]),
    });
    render(<McpRegistry onClose={() => undefined} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Продолжить и подключить' }));

    const machineGroup = await screen.findByRole('radiogroup', { name: 'Машина' });
    expect(machineGroup).toHaveClass('seg');
    await userEvent.click(document.querySelector<HTMLButtonElement>('.mcp-validation-footer > .btn')!);
    const scopeGroup = screen.getAllByRole('radiogroup').at(-2)!;
    expect(scopeGroup.querySelectorAll('[role="radio"]')[1]).toHaveAttribute('aria-checked', 'true');
    const allowedMachine = screen.getByRole('checkbox', { name: /VM/ });
    expect(allowedMachine).toBeEnabled();
    expect(allowedMachine).toBeChecked();
    await userEvent.click(allowedMachine);
    expect(allowedMachine).not.toBeChecked();
  });

  it('preselects the only machine in a resumed draft scope', async () => {
    const resumedDraft = draft();
    resumedDraft.server.machineScope = { allMachines: false, machineIds: ['vm'] };
    useStore.setState({ runners: [runner({ id: 'vm', name: 'VM', online: true })] });
    mockFetch({
      'GET /api/mcp/registry': reply({ ...blank, drafts: [resumedDraft] }),
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([]),
    });
    render(<McpRegistry onClose={() => undefined} />);

    await userEvent.click(await screen.findByRole('button', { name: /Продолжить/ }));

    const machineGroup = await screen.findByRole('radiogroup', { name: 'Машина' });
    expect(screen.getByRole('radio', { name: /VM/ })).toHaveAttribute('aria-checked', 'true');
    expect(machineGroup).toBeInTheDocument();
  });

  it('updates a resumed draft after going back and preserves its secret reference', async () => {
    const secretId = '6d8397ca-e369-4ee6-8809-a6f083d79416';
    const resumedDraft = draft();
    resumedDraft.server.machineScope = { allMachines: false, machineIds: [id] };
    resumedDraft.server.env = { QA_TOKEN: { kind: 'secret', secretId } };
    resumedDraft.server.secrets = [{ secretId, name: 'QA_TOKEN', state: 'set' }];
    const calls = mockFetch({
      'GET /api/mcp/registry': reply({ ...blank, drafts: [resumedDraft] }),
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([]),
      [`PATCH /api/mcp/registry/drafts/${id}`]: reply(resumedDraft),
    });
    render(<McpRegistry onClose={() => undefined} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Продолжить и подключить' }));
    await userEvent.click(screen.getByRole('button', { name: 'Назад' }));
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить черновик и проверить' }));

    const updateCall = await waitFor(() => calls.find(call => call.url.endsWith(`/drafts/${id}`)));
    expect(updateCall?.method).toBe('PATCH');
    expect(updateCall?.body).toMatchObject({
      revision: resumedDraft.revision,
      server: { env: { QA_TOKEN: { kind: 'secret', secretId } } },
    });
    expect(calls.some(call => call.url.endsWith('/drafts'))).toBe(false);
  });

  it('refreshes a draft and shows a translated message after a PATCH revision conflict', async () => {
    const resumedDraft = draft();
    resumedDraft.server.machineScope = { allMachines: false, machineIds: [id] };
    const latestDraft = { ...resumedDraft, revision: 2, server: { ...resumedDraft.server, revision: 2 } };
    let updateAttempts = 0;
    const calls = mockFetch({
      'GET /api/mcp/registry': reply({ ...blank, drafts: [resumedDraft] }),
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([]),
      [`PATCH /api/mcp/registry/drafts/${id}`]: () => {
        updateAttempts += 1;
        if (updateAttempts === 1) return { status: 409, body: { error: 'revision_conflict', message: 'Draft revision changed' } };
        return { status: 200, body: latestDraft };
      },
      [`GET /api/mcp/registry/drafts/${id}`]: reply(latestDraft),
    });
    render(<McpRegistry onClose={() => undefined} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Продолжить и подключить' }));
    await userEvent.click(screen.getByRole('button', { name: 'Назад' }));
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить черновик и проверить' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Черновик изменился на сервере');
    expect(calls.some(call => call.method === 'GET' && call.url.endsWith(`/drafts/${id}`))).toBe(true);
    await userEvent.click(document.querySelector<HTMLButtonElement>('.mcp-wizard .btn.primary')!);
    await waitFor(() => expect(updateAttempts).toBe(2));
    expect(calls.filter(call => call.method === 'PATCH').map(call => call.body)).toEqual([expect.objectContaining({ revision: 1 }), expect.objectContaining({ revision: 2 })]);
  });

  it('offers validation again when the hub reports needs-secret without a missing binding', async () => {
    const needsSecretDraft = draft('needs-secret');
    needsSecretDraft.server.machineScope = { allMachines: false, machineIds: [id] };
    const calls = mockFetch({
      'GET /api/mcp/registry': reply({ ...blank, drafts: [needsSecretDraft] }),
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([]),
      [`POST /api/mcp/registry/drafts/${id}/validate`]: reply(draft('checked', { ok: true })),
    });
    render(<McpRegistry onClose={() => undefined} />);
    await userEvent.click(await screen.findByRole('button', { name: /Продолжить и подключить/ }));
    const fallback = await screen.findByRole('status');
    expect(fallback.querySelector('button')).toBeInTheDocument();
    await userEvent.click(fallback.querySelector('button')!);
    await waitFor(() => expect(calls.some(call => call.url.endsWith('/validate'))).toBe(true));
  });

  it('closes with a status message when a validation conflict reloads a connected draft', async () => {
    const resumedDraft = draft('checked', { ok: true });
    resumedDraft.server.machineScope = { allMachines: false, machineIds: [id] };
    const connectedDraft = { ...resumedDraft, state: 'connected' as const };
    const calls = mockFetch({
      'GET /api/mcp/registry': reply({ ...blank, drafts: [resumedDraft] }),
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([]),
      [`POST /api/mcp/registry/drafts/${id}/validate`]: reply({ error: 'revision_conflict', message: 'Draft revision changed' }, 409),
      [`GET /api/mcp/registry/drafts/${id}`]: reply(connectedDraft),
    });
    render(<McpRegistry onClose={() => undefined} />);
    await userEvent.click(await screen.findByRole('button', { name: /Продолжить и подключить/ }));
    await userEvent.click(document.querySelector<HTMLButtonElement>('.mcp-validation-actions .btn')!);
    await waitFor(() => expect(calls.some(call => call.method === 'GET' && call.url.endsWith(`/drafts/${id}`))).toBe(true));
    expect(document.querySelector('.mcp-wizard')).not.toBeInTheDocument();
    expect(await screen.findByRole('status')).toHaveTextContent('закрыт');
  });

  it('shows a neutral notice when a validation conflict reloads a saved-unchecked draft', async () => {
    const resumedDraft = draft('checked', { ok: true });
    resumedDraft.server.machineScope = { allMachines: false, machineIds: [id] };
    const savedDraft = { ...resumedDraft, state: 'saved-unchecked' as const };
    mockFetch({
      'GET /api/mcp/registry': reply({ ...blank, drafts: [resumedDraft] }),
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([]),
      [`POST /api/mcp/registry/drafts/${id}/validate`]: reply({ error: 'revision_conflict', message: 'Draft revision changed' }, 409),
      [`GET /api/mcp/registry/drafts/${id}`]: reply(savedDraft),
    });
    render(<McpRegistry onClose={() => undefined} />);
    await userEvent.click(await screen.findByRole('button', { name: /Продолжить/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Проверить' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Черновик уже сохранён');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(document.querySelector('.mcp-wizard')).not.toBeInTheDocument();
  });

  it('can save an edited resumed draft unchecked after PATCH', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const resumedDraft = draft();
    resumedDraft.server.machineScope = { allMachines: false, machineIds: [id] };
    const updatedDraft = { ...resumedDraft, revision: 2, server: { ...resumedDraft.server, revision: 2 } };
    const calls = mockFetch({
      'GET /api/mcp/registry': reply({ ...blank, drafts: [resumedDraft] }),
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([]),
      [`PATCH /api/mcp/registry/drafts/${id}`]: reply(updatedDraft),
      [`POST /api/mcp/registry/drafts/${id}/save-unchecked`]: reply({}),
    });
    render(<McpRegistry onClose={() => undefined} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Продолжить и подключить' }));
    await userEvent.click(screen.getByRole('button', { name: 'Назад' }));
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить черновик и проверить' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Сохранить без проверки…' }));

    expect(calls.find(call => call.method === 'PATCH')?.body).toMatchObject({ revision: resumedDraft.revision });
    expect(calls.find(call => call.url.endsWith('/save-unchecked'))?.body).toMatchObject({ revision: updatedDraft.revision, userConfirmed: true });
  });

  it('saves the missing URL binding when the HTTP header secret is already set', async () => {
    const headerSecretId = 'c6b87d25-b814-4ea4-b5f0-f0741bcd1017';
    const urlSecretId = '65236db4-1ab3-431f-a3a5-198682e41e07';
    const resumedDraft = draft('needs-secret');
    resumedDraft.server.transport = 'http';
    resumedDraft.server.url = 'https://example.test/__AGENT_HUB_SECRET__/mcp';
    resumedDraft.server.urlSecretId = urlSecretId;
    resumedDraft.server.headers = { Authorization: { kind: 'secret', secretId: headerSecretId } };
    resumedDraft.server.secrets = [
      { secretId: headerSecretId, name: 'AUTH_TOKEN', state: 'set' },
      { secretId: urlSecretId, name: 'URL_TOKEN', state: 'needs-secret' },
    ];
    resumedDraft.server.machineScope = { allMachines: false, machineIds: [id] };
    const updatedDraft = {
      ...resumedDraft,
      revision: 2,
      server: {
        ...resumedDraft.server,
        revision: 2,
        secrets: resumedDraft.server.secrets.map(secret => ({ ...secret, state: 'set' as const })),
      },
    };
    const calls = mockFetch({
      'GET /api/mcp/registry': reply({ ...blank, drafts: [resumedDraft] }),
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([]),
      [`PATCH /api/mcp/registry/drafts/${id}`]: reply(updatedDraft),
    });
    render(<McpRegistry onClose={() => undefined} />);
    await userEvent.click(await screen.findByRole('button', { name: /Продолжить и подключить/ }));
    await userEvent.type(document.querySelector<HTMLInputElement>('input[type="password"]')!, 'url-secret-value');
    await userEvent.click(document.querySelector<HTMLButtonElement>('.mcp-secret-input button')!);
    const updateCall = await waitFor(() => calls.find(call => call.method === 'PATCH'));
    expect(updateCall?.body).toMatchObject({ secrets: [{ name: 'URL_TOKEN', value: 'url-secret-value' }] });
  });

  it('gives a new URL secret a unique name and requires its value', async () => {
    const secretId = 'c6b87d25-b814-4ea4-b5f0-f0741bcd1017';
    const urlSecretId = '65236db4-1ab3-431f-a3a5-198682e41e07';
    const resumedDraft = draft();
    resumedDraft.server.transport = 'http';
    resumedDraft.server.url = 'https://example.test/__AGENT_HUB_SECRET__/mcp';
    resumedDraft.server.headers = { Authorization: { kind: 'secret', secretId } };
    resumedDraft.server.secrets = [{ secretId, name: 'token', state: 'set' }];
    resumedDraft.server.machineScope = { allMachines: false, machineIds: [id] };
    const updatedDraft = {
      ...resumedDraft,
      revision: 2,
      server: {
        ...resumedDraft.server,
        revision: 2,
        urlSecretId,
        secrets: [...resumedDraft.server.secrets, { secretId: urlSecretId, name: 'url-token', state: 'set' as const }],
      },
    };
    let patchCount = 0;
    const patchBodies: unknown[] = [];
    const calls = mockFetch({
      'GET /api/mcp/registry': reply({ ...blank, drafts: [resumedDraft] }),
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([]),
      [`PATCH /api/mcp/registry/drafts/${id}`]: init => {
        patchCount += 1;
        patchBodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
        return { status: 200, body: patchCount === 1 ? { ...resumedDraft, revision: 2 } : updatedDraft };
      },
    });
    render(<McpRegistry onClose={() => undefined} />);
    await userEvent.click(await screen.findByRole('button', { name: /Продолжить и подключить/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Назад' }));
    await userEvent.click(screen.getByRole('radio', { name: /X1/ }));
    await userEvent.click(screen.getByRole('button', { name: /Сохранить черновик и проверить/ }));
    const updateCall = await waitFor(() => calls.find(call => call.method === 'PATCH'));
    expect(updateCall?.body).toMatchObject({ server: { urlSecretName: 'url-token' } });
    const urlSecretInput = await screen.findByLabelText('Значение секрета «url-token»');
    expect(screen.getByRole('button', { name: 'Проверить' })).toBeDisabled();
    expect(calls.some(call => call.url.endsWith('/validate'))).toBe(false);
    await userEvent.type(urlSecretInput, 'url-secret-value');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить секрет' }));
    await waitFor(() => expect(patchCount).toBe(2));
    expect(patchBodies[1]).toMatchObject({ secrets: [{ name: 'url-token', value: 'url-secret-value' }] });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('blocks a new header binding from reusing the saved URL secret name', async () => {
    const urlSecretId = '65236db4-1ab3-431f-a3a5-198682e41e07';
    const resumedDraft = draft();
    resumedDraft.server.transport = 'http';
    resumedDraft.server.url = 'https://example.test/__AGENT_HUB_SECRET__/mcp';
    resumedDraft.server.urlSecretId = urlSecretId;
    resumedDraft.server.secrets = [{ secretId: urlSecretId, name: 'token', state: 'set' }];
    mockFetch({
      'GET /api/mcp/registry': reply({ ...blank, drafts: [resumedDraft] }),
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([]),
    });
    render(<McpRegistry onClose={() => undefined} />);
    await userEvent.click(await screen.findByRole('button', { name: /Продолжить/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Назад' }));
    await userEvent.click(screen.getByRole('button', { name: 'Назад' }));
    await userEvent.click(screen.getByRole('button', { name: 'Назад' }));
    await userEvent.type(screen.getByLabelText(/Заголовки/), 'token=@secret');
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.type(screen.getByLabelText('Значение секрета «token»'), 'replacement-value');
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/уже принадлежит полю «URL»/);
    expect(screen.queryByRole('button', { name: 'Сохранить черновик и проверить' })).not.toBeInTheDocument();
  });

  it('restores HTTP header and URL secret references when updating a draft', async () => {
    const headerSecretId = 'c6b87d25-b814-4ea4-b5f0-f0741bcd1017';
    const urlSecretId = '65236db4-1ab3-431f-a3a5-198682e41e07';
    const resumedDraft = draft();
    resumedDraft.server.transport = 'http';
    resumedDraft.server.url = 'https://example.test/__AGENT_HUB_SECRET__/mcp';
    resumedDraft.server.urlSecretId = urlSecretId;
    resumedDraft.server.headers = { Authorization: { kind: 'secret', secretId: headerSecretId } };
    resumedDraft.server.secrets = [
      { secretId: headerSecretId, name: 'AUTH_TOKEN', state: 'set' },
      { secretId: urlSecretId, name: 'URL_TOKEN', state: 'set' },
    ];
    resumedDraft.server.machineScope = { allMachines: false, machineIds: [id] };
    const calls = mockFetch({
      'GET /api/mcp/registry': reply({ ...blank, drafts: [resumedDraft] }),
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([]),
      [`PATCH /api/mcp/registry/drafts/${id}`]: reply(resumedDraft),
    });
    render(<McpRegistry onClose={() => undefined} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Продолжить и подключить' }));
    await userEvent.click(screen.getByRole('button', { name: 'Назад' }));
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить черновик и проверить' }));

    const updateCall = await waitFor(() => calls.find(call => call.url.endsWith(`/drafts/${id}`)));
    expect(updateCall?.body).toMatchObject({
      server: {
        urlSecretId,
        headers: { Authorization: { kind: 'secret', secretId: headerSecretId } },
      },
    });
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
    await userEvent.type(screen.getByLabelText(/Переменные среды/), 'API_TOKEN=@secret');
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.clear(screen.getByLabelText('Имя секрета (необязательно)'));
    await userEvent.type(screen.getByLabelText('Имя секрета (необязательно)'), 'token');
    await userEvent.type(document.querySelector<HTMLInputElement>('input[type="password"]')!, sentinel);
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.click(screen.getByRole('radio', { name: /X1/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить черновик и проверить' }));
    await screen.findByText('Проверка сервера на выбранной машине');
    expect(document.body).not.toHaveTextContent(sentinel);
    expect(screen.queryByDisplayValue(sentinel)).not.toBeInTheDocument();
  });

  it('saves a missing binding with its own name, clears the value, and checks the draft', async () => {
    const secretId = '1789db2b-28dc-4f8f-8b69-7f2826085d6a';
    const needsSecretDraft = draft('needs-secret');
    needsSecretDraft.server.env = { API_TOKEN: { kind: 'secret', secretId } };
    needsSecretDraft.server.secrets = [{ secretId, name: 'API_TOKEN', state: 'needs-secret' }];
    const checkedDraft: McpRegistryDraftView = {
      ...needsSecretDraft,
      revision: 2,
      state: 'checked',
      server: {
        ...needsSecretDraft.server,
        revision: 2,
        secrets: [{ secretId, name: 'API_TOKEN', state: 'set' }],
      },
      validation: { ok: true, status: 'checked', tools: [], oauthRequired: false },
    };
    const calls = mockFetch({
      'GET /api/mcp/registry': initial,
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([]),
      'POST /api/mcp/registry/drafts': reply(needsSecretDraft, 201),
      [`PATCH /api/mcp/registry/drafts/${id}`]: reply(checkedDraft),
      [`POST /api/mcp/registry/drafts/${id}/validate`]: reply(checkedDraft),
    });
    render(<McpRegistry onClose={() => undefined} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Добавить сервер' }));
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.type(screen.getByLabelText('Имя'), 'needs-secret-demo');
    await userEvent.type(screen.getByLabelText('Команда'), 'node');
    await userEvent.type(screen.getByLabelText(/Переменные среды/), 'API_TOKEN=@secret');
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.click(screen.getByRole('radio', { name: /X1/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить черновик и проверить' }));
    await screen.findByLabelText('Значение секрета «API_TOKEN»');
    await userEvent.type(screen.getByLabelText('Значение секрета «API_TOKEN»'), 'secret-value');
    expect(screen.getByRole('button', { name: 'Сохранить секрет' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить секрет' }));

    const secretUpdate = await waitFor(() => calls.find(call => call.method === 'PATCH'));
    expect(secretUpdate?.body).toMatchObject({ secrets: [{ name: 'API_TOKEN', value: 'secret-value' }] });
    expect(screen.queryByLabelText('Значение секрета «API_TOKEN»')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Проверить' }));
    expect(await waitFor(() => calls.some(call => call.url.endsWith('/validate')))).toBe(true);
  });

  it('blocks saving a missing secret that belongs to another field', async () => {
    const urlSecretId = '65236db4-1ab3-431f-a3a5-198682e41e07';
    const headerSecretId = 'c6b87d25-b814-4ea4-b5f0-f0741bcd1017';
    const needsSecretDraft = draft('needs-secret');
    needsSecretDraft.server.transport = 'http';
    needsSecretDraft.server.url = 'https://example.test/__AGENT_HUB_SECRET__/mcp';
    needsSecretDraft.server.urlSecretId = urlSecretId;
    needsSecretDraft.server.headers = { Authorization: { kind: 'secret', secretId: headerSecretId } };
    needsSecretDraft.server.secrets = [
      { secretId: urlSecretId, name: 'token', state: 'set' },
      { secretId: headerSecretId, name: 'token', state: 'needs-secret' },
    ];
    const calls = mockFetch({
      'GET /api/mcp/registry': reply({ ...blank, drafts: [needsSecretDraft] }),
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([]),
    });
    render(<McpRegistry onClose={() => undefined} />);
    await userEvent.click(await screen.findByRole('button', { name: /Продолжить/ }));
    const secretInput = await screen.findByLabelText('Значение секрета «token»');
    await userEvent.type(secretInput, 'replacement-value');

    expect(screen.getByRole('alert')).toHaveTextContent('уже принадлежит полю «URL»');
    expect(screen.getByRole('button', { name: 'Сохранить секрет' })).toBeDisabled();
    expect(calls.some(call => call.method === 'PATCH')).toBe(false);
  });

  it('assigns different secret names to separate @secret fields', async () => {
    const calls = mockFetch({
      'GET /api/mcp/registry': initial,
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([]),
      'POST /api/mcp/registry/drafts': reply(draft(), 201),
    });
    render(<McpRegistry onClose={() => undefined} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Добавить сервер' }));
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.type(screen.getByLabelText('Имя'), 'two-secrets-demo');
    await userEvent.type(screen.getByLabelText('Команда'), 'node');
    await userEvent.type(screen.getByLabelText(/Переменные среды/), 'A=@secret\nB=@secret');
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    const secretInputs = document.querySelectorAll<HTMLInputElement>('input[type="password"]');
    await userEvent.type(secretInputs[0]!, 'secret-a');
    await userEvent.type(secretInputs[1]!, 'secret-b');
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.click(screen.getByRole('radio', { name: /X1/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить черновик и проверить' }));

    const createCall = await waitFor(() => calls.find(call => call.url.endsWith('/drafts')));
    expect(createCall?.body).toMatchObject({
      server: {
        env: {
          A: { kind: 'secret-name', name: 'A' },
          B: { kind: 'secret-name', name: 'B' },
        },
      },
      secrets: [
        { name: 'A', value: 'secret-a' },
        { name: 'B', value: 'secret-b' },
      ],
    });
  });

  it('stores separate values for missing secrets in resumed drafts', async () => {
    const resumedDraft = draft('needs-secret');
    const secretA = 'c6b87d25-b814-4ea4-b5f0-f0741bcd1017';
    const secretB = '65236db4-1ab3-431f-a3a5-198682e41e07';
    resumedDraft.server.machineScope = { allMachines: false, machineIds: [id] };
    resumedDraft.server.env = {
      A: { kind: 'secret', secretId: secretA },
      B: { kind: 'secret', secretId: secretB },
    };
    resumedDraft.server.secrets = [
      { secretId: secretA, name: 'A', state: 'needs-secret' },
      { secretId: secretB, name: 'B', state: 'needs-secret' },
    ];
    const afterFirst = {
      ...resumedDraft,
      revision: 2,
      server: {
        ...resumedDraft.server,
        revision: 2,
        secrets: [
          { secretId: secretA, name: 'A', state: 'set' as const },
          { secretId: secretB, name: 'B', state: 'needs-secret' as const },
        ],
      },
    };
    const afterSecond = {
      ...afterFirst,
      revision: 3,
      server: {
        ...afterFirst.server,
        revision: 3,
        secrets: afterFirst.server.secrets.map(secret => ({ ...secret, state: 'set' as const })),
      },
    };
    let patchCount = 0;
    const calls = mockFetch({
      'GET /api/mcp/registry': reply({ ...blank, drafts: [resumedDraft] }),
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([]),
      [`PATCH /api/mcp/registry/drafts/${id}`]: () => {
        patchCount += 1;
        return { status: 200, body: patchCount === 1 ? afterFirst : afterSecond };
      },
    });
    render(<McpRegistry onClose={() => undefined} />);
    await userEvent.click(await screen.findByRole('button', { name: /Продолжить и подключить/ }));
    const inputs = document.querySelectorAll<HTMLInputElement>('input[type="password"]');
    await userEvent.type(inputs[0]!, 'value-a');
    await userEvent.type(inputs[1]!, 'value-b');
    const saveButtons = document.querySelectorAll<HTMLButtonElement>('.mcp-secret-input button');
    await userEvent.click(saveButtons[0]!);
    await waitFor(() => expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1));
    await userEvent.click(document.querySelector<HTMLButtonElement>('.mcp-secret-input button')!);
    await waitFor(() => expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(2));
    expect(calls.filter(call => call.method === 'PATCH').map(call => call.body)).toEqual([
      expect.objectContaining({ secrets: [{ name: 'A', value: 'value-a' }] }),
      expect.objectContaining({ secrets: [{ name: 'B', value: 'value-b' }] }),
    ]);
  });

  it('gives a URL binding a distinct name from a new header binding', async () => {
    mockFetch({
      'GET /api/mcp/registry': initial,
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([]),
    });
    render(<McpRegistry onClose={() => undefined} />);
    await userEvent.click(screen.getByRole('button', { name: 'Добавить сервер' }));
    await userEvent.click(screen.getByRole('radio', { name: /Удалённый HTTP/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.type(screen.getByLabelText('Имя'), 'duplicate-secret-demo');
    await userEvent.type(screen.getByLabelText('URL'), 'https://example.test/__AGENT_HUB_SECRET__');
    await userEvent.type(screen.getByLabelText(/Заголовки/), 'token=@secret');
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));

    expect(screen.getByLabelText('Значение секрета «token»')).toBeInTheDocument();
    expect(screen.getByLabelText('Значение секрета «url-token»')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('uses the unique default name for a URL-only secret binding', async () => {
    const secretValue = 'url-only-secret';
    const calls = mockFetch({
      'GET /api/mcp/registry': initial,
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([]),
      'POST /api/mcp/registry/drafts': reply(draft(), 201),
    });
    render(<McpRegistry onClose={() => undefined} />);
    await userEvent.click(await screen.findByRole('button', { name: /Добавить сервер/ }));
    await userEvent.click(screen.getByRole('radio', { name: /HTTP/ }));
    await userEvent.click(document.querySelector<HTMLButtonElement>('.mcp-wizard .btn.primary')!);
    const textInputs = document.querySelectorAll<HTMLInputElement>('.mcp-wizard input');
    await userEvent.type(textInputs[0]!, 'url-only-demo');
    await userEvent.type(textInputs[1]!, 'https://example.test/__AGENT_HUB_SECRET__');
    await userEvent.click(document.querySelector<HTMLButtonElement>('.mcp-wizard .btn.primary')!);
    await userEvent.type(document.querySelector<HTMLInputElement>('input[type="password"]')!, secretValue);
    await userEvent.click(document.querySelector<HTMLButtonElement>('.mcp-wizard .btn.primary')!);
    await userEvent.click(screen.getByRole('radio', { name: /X1/ }));
    await userEvent.click(document.querySelector<HTMLButtonElement>('.mcp-wizard .btn.primary')!);
    const payload = calls.find(call => call.url.endsWith('/drafts'))?.body as {
      server: { urlSecretName?: string };
      secrets?: Array<{ name: string; value: string }>;
    };
    expect(payload.server.urlSecretName).toBe('url-token');
    expect(payload.secrets).toEqual([{ name: 'url-token', value: secretValue }]);
    expect(screen.getByRole('alert').textContent).not.toMatch(/\u00ab\s*\u00bb/);
  });

  it('imports from a picked machine: source, masked secrets, only the checked servers are committed', async () => {
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
    const preview = mcpImportPreview({
      machineId: id,
      revision: 4,
      servers: [entry(1, { source: 'project', origin: 'C:/work/demo/.mcp.json', secrets: [{ name: 'API_TOKEN', masked: true }] }), entry(2)],
      secretsCaptured: 1,
    });
    const calls = mockFetch({
      'GET /api/mcp/registry': initial,
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([]),
      'POST /api/mcp/registry/import/preview': reply(preview),
      'POST /api/mcp/registry/import/commit': reply({ imported: 1, servers: [] }),
    });
    render(<McpRegistry onClose={() => undefined} />);
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByText('Импортировать конфигурацию'));
    await userEvent.click(screen.getByRole('radio', { name: /X1/ }));
    expect(await screen.findByText('Claude · .mcp.json')).toBeInTheDocument();
    expect(screen.getByText('C:/work/demo/.mcp.json')).toBeInTheDocument();
    expect(screen.getByText('Секреты: API_TOKEN')).toBeInTheDocument();
    expect(calls.find(call => call.url.endsWith('/import/preview'))?.body).toEqual({ machineId: id });
    await userEvent.click(screen.getByRole('checkbox', { name: 'srv2' }));
    await userEvent.click(screen.getByRole('button', { name: 'Импортировать 1 сервер' }));
    await waitFor(() =>
      expect(calls.find(call => call.url.endsWith('/import/commit'))?.body).toEqual({
        importId: preview.importId,
        revision: preview.revision,
        serverIds: [entry(1).id],
        userConfirmed: true,
      }),
    );
    expect(await screen.findByText('Импортировано: 1.')).toBeInTheDocument();
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
    await userEvent.click(screen.getByRole('radio', { name: /На сессию/ }));
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
    expect(await screen.findByText('Ожидает входа')).toBeInTheDocument();
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
    await userEvent.click(screen.getByRole('radio', { name: /Удалённый HTTP/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.type(screen.getByLabelText('Имя'), 'oauth-demo');
    await userEvent.type(screen.getByLabelText('URL'), 'https://example.test/mcp');
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.click(screen.getByRole('radio', { name: /X1/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить черновик и проверить' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Проверить' }));
    expect(await screen.findByText(/Сервер требует входа/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить и перейти ко входу' }));
    expect(screen.queryByRole('button', { name: 'Назад' })).not.toBeInTheDocument();
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

  it('wizard: a loopback sign-in takes the pasted address and keeps «Войти» available while pending', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(window, 'open').mockReturnValue({ opener: window, location: { href: '' }, close: vi.fn() } as unknown as Window);
    const persistedServerId = 'b7e6aab4-1528-4a36-a7fa-7beacdc5aa30';
    const httpDraft: McpRegistryDraftView = {
      ...draft('needs_auth'),
      state: 'needs_auth',
      server: { ...draft().server, transport: 'http', url: 'https://example.test/mcp' },
      validation: { ok: false, status: 'needs_auth', oauthRequired: true, tools: [] },
    };
    let completed = false;
    const loopback = 'http://localhost:45129/callback?code=abc&state=s1';
    const calls = mockFetch({
      'GET /api/mcp/registry': reply(blank),
      'GET /api/mcp/registry/status': () => {
        const oauth = [{ serverId: persistedServerId, machineId: id, state: completed ? 'signed-in' : 'pending', validationState: 'needs_auth', connected: false }];
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
          authorizationUrl: 'https://auth.example.test/login?state=s1',
          expiresAt: 1_800_000_000_000,
          callback: 'manual',
        },
        202,
      ),
      [`POST /api/mcp/registry/servers/${persistedServerId}/oauth/complete`]: () => {
        completed = true;
        return reply({ serverId: persistedServerId, machineId: id, state: 'pending' })();
      },
    });
    render(<McpRegistry onClose={() => undefined} />);
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('button', { name: 'Добавить сервер' }));
    await userEvent.click(screen.getByRole('radio', { name: /Удалённый HTTP/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.type(screen.getByLabelText('Имя'), 'loopback-demo');
    await userEvent.type(screen.getByLabelText('URL'), 'https://example.test/mcp');
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.click(screen.getByRole('radio', { name: /X1/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить черновик и проверить' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Проверить' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Сохранить и перейти ко входу' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Войти' }));
    const field = await screen.findByLabelText('Адрес после входа');
    expect(screen.getByRole('button', { name: 'Войти' })).toBeEnabled();
    await userEvent.type(field, loopback);
    await userEvent.click(screen.getByRole('button', { name: 'Завершить вход' }));
    await waitFor(() => expect(calls.find(call => call.url.endsWith('/oauth/complete'))?.body).toEqual({ machineId: id, callbackUrl: loopback }));
    expect(await screen.findByRole('button', { name: 'Проверить после входа' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Адрес после входа')).toBeNull();
  });

  it('wizard: a rejected client registration asks for a client id, saves it, and signs in by the pasted address', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(window, 'open').mockReturnValue({ opener: window, location: { href: '' }, close: vi.fn() } as unknown as Window);
    const persistedServerId = 'c8e6aab4-1528-4a36-a7fa-7beacdc5aa31';
    const httpDraft: McpRegistryDraftView = {
      ...draft('needs_auth'),
      state: 'needs_auth',
      server: { ...draft().server, transport: 'http', url: 'https://example.test/mcp' },
      validation: { ok: false, status: 'needs_auth', oauthRequired: true, tools: [] },
    };
    let persisted = false;
    let starts = 0;
    const calls = mockFetch({
      'GET /api/mcp/registry': () => reply(persisted ? { revision: 2, servers: [{ ...httpDraft.server, id: persistedServerId, revision: 3 }], drafts: [] } : blank)(),
      'GET /api/mcp/registry/status': reply({
        revision: 1,
        agents: [{ machineId: id, machineName: 'X1', online: true, protocolVersion: '1.13', capabilities: ['mcp.oauth.v1'] }],
        gateways: [],
        oauth: [],
      }),
      'GET /api/catalog/projects': reply([]),
      'POST /api/mcp/registry/drafts': reply(httpDraft, 201),
      [`POST /api/mcp/registry/drafts/${id}/validate`]: reply(httpDraft),
      [`POST /api/mcp/registry/drafts/${id}/connect`]: () => {
        persisted = true;
        return reply({ serverId: persistedServerId, state: 'needs-login', server: { ...httpDraft.server, id: persistedServerId } })();
      },
      [`PATCH /api/mcp/registry/servers/${persistedServerId}`]: reply({ ...httpDraft.server, id: persistedServerId, revision: 4, oauthClientId: 'hr-portal-mcp' }),
      [`POST /api/mcp/registry/servers/${persistedServerId}/oauth/start`]: () => {
        starts += 1;
        if (starts === 1) return reply({ error: 'oauth_registration_rejected', message: 'The authorization server does not allow automatic client registration' }, 502)();
        return reply(
          { serverId: persistedServerId, machineId: id, state: 'pending', authorizationUrl: 'https://auth.example.test/login?state=s1', expiresAt: 1_800_000_000_000, callback: 'manual' },
          202,
        )();
      },
    });
    render(<McpRegistry onClose={() => undefined} />);
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('button', { name: 'Добавить сервер' }));
    await userEvent.click(screen.getByRole('radio', { name: /Удалённый HTTP/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    expect(screen.getByLabelText('OAuth client ID (необязательно)')).toHaveValue('');
    await userEvent.type(screen.getByLabelText('Имя'), 'dcr-rejected-demo');
    await userEvent.type(screen.getByLabelText('URL'), 'https://example.test/mcp');
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.click(screen.getByRole('radio', { name: /X1/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить черновик и проверить' }));
    expect(calls.find(call => call.url.endsWith('/api/mcp/registry/drafts'))?.body).not.toHaveProperty('server.oauthClientId');
    await userEvent.click(await screen.findByRole('button', { name: 'Проверить' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Сохранить и перейти ко входу' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Войти' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/запрещает автоматическую регистрацию клиента — укажите заранее созданный client ID/);
    expect(screen.queryByRole('button', { name: 'Войти' })).toBeNull();
    const retry = screen.getByRole('button', { name: 'Сохранить и войти' });
    expect(retry).toBeDisabled();
    await userEvent.type(screen.getByLabelText('OAuth client ID (необязательно)'), '  hr-portal-mcp ');
    await userEvent.click(retry);
    await waitFor(() => expect(calls.find(call => call.method === 'PATCH')?.body).toEqual({ revision: 3, oauthClientId: 'hr-portal-mcp' }));
    expect(await screen.findByLabelText('Адрес после входа')).toBeInTheDocument();
    expect(starts).toBe(2);
    expect(screen.queryByRole('button', { name: 'Сохранить и войти' })).toBeNull();
  });

  it('edits and clears the OAuth client id of a remote server in its card', async () => {
    const server = { ...draft().server, transport: 'http' as const, mode: 'remote' as const, url: 'https://example.test/mcp', oauthClientId: 'old-client' };
    const calls = mockFetch({
      'GET /api/mcp/registry': reply({ revision: 1, servers: [server], drafts: [] }),
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([]),
      [`PATCH /api/mcp/registry/servers/${server.id}`]: reply(server),
    });
    render(<McpRegistry onClose={() => undefined} />);
    await screen.findByText(server.name);
    await userEvent.click(screen.getByText('Изменить режим и доступ по машинам'));
    const field = screen.getByLabelText('OAuth client ID');
    expect(field).toHaveValue('old-client');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    await waitFor(() => expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1));
    expect(calls.filter(call => call.method === 'PATCH')[0]?.body).not.toHaveProperty('oauthClientId');
    await userEvent.clear(field);
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    await waitFor(() => expect(calls.filter(call => call.method === 'PATCH')[1]?.body).toMatchObject({ revision: server.revision, oauthClientId: null }));
  });

  it('explains a rejected client registration when signing in from the card', async () => {
    const server = { ...draft().server, transport: 'http' as const, url: 'https://example.test/mcp' };
    vi.spyOn(window, 'open').mockReturnValue({ opener: window, location: { href: '' }, close: vi.fn() } as unknown as Window);
    mockFetch({
      'GET /api/mcp/registry': reply({ revision: 1, servers: [server], drafts: [] }),
      'GET /api/mcp/registry/status': reply({
        revision: 1,
        agents: [{ machineId: id, machineName: 'X1', online: true, protocolVersion: '1.13', capabilities: ['mcp.oauth.v1'] }],
        gateways: [],
        oauth: [],
      }),
      [`POST /api/mcp/registry/servers/${id}/oauth/start`]: reply({ error: 'oauth_registration_rejected', message: 'raw' }, 502),
    });
    render(<McpRegistry onClose={() => undefined} />);
    await screen.findByText(server.name);
    await screen.findAllByRole('option', { name: 'X1' });
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));
    expect(await screen.findByText(/запрещает автоматическую регистрацию клиента — укажите заранее созданный client ID/)).toBeInTheDocument();
  });

  it('switches a server off on one machine and resets a machine-specific config', async () => {
    const server = { ...draft().server, machines: [{ machineId: id, enabled: true, customConfig: true }] };
    const calls = mockFetch({
      'GET /api/mcp/registry': reply({ revision: 1, servers: [server], drafts: [] }),
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([]),
      [`PUT /api/mcp/registry/servers/${server.id}/machines/${id}`]: reply({ serverId: server.id, revision: 2, machines: [] }),
    });
    render(<McpRegistry onClose={() => undefined} />);
    const machines = await screen.findByRole('region', { name: `Машины сервера ${server.name}` });
    expect(within(machines).getByText('своя настройка')).toBeInTheDocument();
    await userEvent.click(within(machines).getByRole('switch', { name: 'X1' }));
    await waitFor(() => expect(calls.filter(call => call.method === 'PUT').map(call => call.body)).toEqual([{ revision: server.revision, enabled: false }]));
    await userEvent.click(within(machines).getByRole('button', { name: 'Сбросить' }));
    await waitFor(() => expect(calls.filter(call => call.method === 'PUT').at(-1)?.body).toEqual({ revision: server.revision, resetConfig: true }));
  });

  it('shows an error when a machine switch fails', async () => {
    const server = { ...draft().server, machines: [{ machineId: id, enabled: true, customConfig: false }] };
    mockFetch({
      'GET /api/mcp/registry': reply({ revision: 1, servers: [server], drafts: [] }),
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([]),
      [`PUT /api/mcp/registry/servers/${server.id}/machines/${id}`]: reply({ error: 'unavailable', message: 'Machine update failed' }, 503),
    });
    render(<McpRegistry onClose={() => undefined} />);
    const machines = await screen.findByRole('region', { name: `Машины сервера ${server.name}` });
    expect(within(machines).queryByRole('button', { name: 'Сбросить' })).toBeNull();
    await userEvent.click(within(machines).getByRole('switch', { name: 'X1' }));
    expect(await within(machines).findByRole('alert')).toBeInTheDocument();
    expect(within(machines).getByRole('switch', { name: 'X1' })).toBeChecked();
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
    await userEvent.clear(screen.getByLabelText('Имя секрета (необязательно)'));
    await userEvent.type(screen.getByLabelText('Имя секрета (необязательно)'), 'API_TOKEN');
    await userEvent.type(document.querySelector<HTMLInputElement>('input[type="password"]')!, secretValue);
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.click(screen.getByRole('radio', { name: /X1/ }));
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

  it('keeps a saved environment secret available for validation and suggests its field name', async () => {
    const secretValue = 'saved-qa-token';
    const created = draft();
    created.server.secrets = [{ secretId: 'aa65ffec-733e-4b6f-9d6c-25ea7d29fd0d', name: 'QA_TOKEN', state: 'set' }];
    const calls = mockFetch({
      'GET /api/mcp/registry': reply(blank),
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([]),
      'POST /api/mcp/registry/drafts': reply(created, 201),
      [`POST /api/mcp/registry/drafts/${id}/validate`]: reply(draft('checked', { ok: true })),
    });
    render(<McpRegistry onClose={() => undefined} />);
    await userEvent.click(await screen.findByRole('button', { name: /Добавить сервер/ }));
    await userEvent.click(screen.getByRole('button', { name: /^Далее$/ }));
    await userEvent.type(screen.getByLabelText('Имя'), 'saved-secret-demo');
    await userEvent.type(screen.getByLabelText('Команда'), 'node');
    await userEvent.type(screen.getByLabelText(/Переменные среды/), 'QA_TOKEN=@secret');
    await userEvent.click(screen.getByRole('button', { name: /^Далее$/ }));
    expect(screen.getByLabelText('Имя секрета (необязательно)')).toHaveValue('QA_TOKEN');
    await userEvent.type(document.querySelector<HTMLInputElement>('input[type="password"]')!, secretValue);
    await userEvent.click(screen.getByRole('button', { name: /^Далее$/ }));
    await userEvent.click(screen.getByRole('radio', { name: /X1/ }));
    await userEvent.click(screen.getByRole('button', { name: /Сохранить черновик и проверить/ }));
    await screen.findByText(/Проверка сервера на выбранной машине/);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^Проверить$/ }));
    await waitFor(() => expect(calls.map(call => call.url)).toEqual(expect.arrayContaining([expect.stringContaining('/validate')])));
    const payload = calls.find(call => call.url.endsWith('/drafts'))?.body as {
      secrets?: Array<{ name: string; value: string }>;
    };
    expect(payload.secrets).toEqual([{ name: 'QA_TOKEN', value: secretValue }]);
  });

  it('explains when a bound secret is missing and offers an input to save it', async () => {
    mockFetch({
      'GET /api/mcp/registry': reply(blank),
      'GET /api/mcp/registry/status': reply({}),
      'GET /api/catalog/projects': reply([]),
      'POST /api/mcp/registry/drafts': reply(draft(), 201),
    });
    render(<McpRegistry onClose={() => undefined} />);
    await screen.findByText(/Изменение 0/);
    await getToCheckWithMissingSecret('stdio');

    expect(screen.getByRole('alert')).toHaveTextContent('API_TOKEN');
    expect(screen.getByLabelText(/Значение секрета/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Проверить$/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Сохранить без проверки/ })).toBeDisabled();
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
    await userEvent.click(screen.getByRole('radio', { name: /Удалённый HTTP/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.type(screen.getByLabelText('Имя'), 'secret-http-demo');
    await userEvent.type(screen.getByLabelText('URL'), 'https://example.test/mcp?api_key=__AGENT_HUB_SECRET__');
    await userEvent.type(screen.getByLabelText(/Заголовки/), 'Authorization=@secret');
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.clear(screen.getByLabelText('Имя секрета (необязательно)'));
    await userEvent.type(screen.getByLabelText('Имя секрета (необязательно)'), 'api-token');
    const secretInputs = document.querySelectorAll<HTMLInputElement>('input[type="password"]');
    await userEvent.type(secretInputs[0]!, secretValue);
    await userEvent.type(secretInputs[1]!, 'url-secret-payload');
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.click(screen.getByRole('radio', { name: /X1/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить черновик и проверить' }));

    const payload = calls.find(call => call.url.endsWith('/drafts'))?.body as {
      server: { url?: string; urlSecretName?: string; env?: Record<string, unknown>; headers?: Record<string, unknown> };
      secrets?: Array<{ name: string; value: string }>;
    };
    expect(payload.server.urlSecretName).toBe('url-token');
    expect(payload.server.headers?.Authorization).toEqual({ kind: 'secret-name', name: 'api-token' });
    expect(JSON.stringify(payload.server.headers)).not.toContain(secretValue);
    expect(payload.server.url).not.toContain(secretValue);
    expect(payload.secrets).toEqual([
      { name: 'api-token', value: secretValue },
      { name: 'url-token', value: 'url-secret-payload' },
    ]);
  });
});
