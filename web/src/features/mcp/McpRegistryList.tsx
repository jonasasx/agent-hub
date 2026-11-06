import { useEffect, useMemo, useState } from 'react';
import type { McpImportPreviewResponse, McpProjectOverride, McpRegistryDraftView, McpRegistryResponse, McpRegistryServerUpdate, McpRegistryStatus } from '../../api/mcpRegistryTypes';
import { api } from '../../api/client';
import type { UserProjectView } from '../../api/types';
import { McpSegment } from './McpSegment';
import { MCP_MODE_LABELS, mcpStatusLabel, mcpStatusTone } from './mcpLabels';

interface MachineOption {
  id: string;
  name: string;
  online: boolean;
}

interface McpRegistryListProps {
  registry: McpRegistryResponse;
  status: McpRegistryStatus;
  machines: MachineOption[];
  projects: UserProjectView[];
  importMachineId: string;
  importProjectId: string;
  selectedImportServerIds: string[];
  preview: McpImportPreviewResponse | null;
  onImportMachineChange: (machineId: string) => void;
  onImportProjectChange: (projectId: string) => void;
  onImportServerSelectionChange: (serverIds: string[]) => void;
  onImportPreview: () => void;
  onImportCommit: () => void;
  onImportCancel: () => void;
  onAdd: () => void;
  onContinueDraft: (draft: McpRegistryDraftView) => void;
  onToggleServer: (serverId: string, update: McpRegistryServerUpdate) => void;
  onRenameServer: (serverId: string, update: McpRegistryServerUpdate) => void;
  onDeleteServer: (serverId: string, revision: number) => void;
  onUpdateServer: (serverId: string, update: McpRegistryServerUpdate) => void;
  onProjectOverrideChange: (serverId: string, projectId: string, enabled: boolean, revision: number) => Promise<McpProjectOverride>;
  onProjectOverrideClear: (serverId: string, projectId: string, revision: number) => Promise<McpProjectOverride>;
  onRefreshStatus: () => Promise<void>;
  onMachineRegistryToggle: (machineId: string, enabled: boolean) => Promise<{ machineId: string; registryEnabled: boolean }>;
}

export function McpRegistryList(props: McpRegistryListProps) {
  const {
    registry,
    status,
    machines,
    projects,
    importMachineId,
    importProjectId,
    selectedImportServerIds,
    preview,
    onImportMachineChange,
    onImportProjectChange,
    onImportServerSelectionChange,
    onImportPreview,
    onImportCommit,
    onImportCancel,
    onAdd,
    onContinueDraft,
    onToggleServer,
    onRenameServer,
    onDeleteServer,
    onUpdateServer,
    onProjectOverrideChange,
    onProjectOverrideClear,
    onRefreshStatus,
    onMachineRegistryToggle,
  } = props;

  return (
    <>
      <div className="mcp-registry-actions">
        <button className="btn primary" onClick={onAdd}>
          Добавить сервер
        </button>
      </div>
      <details className="mcp-import-section">
        <summary>Импортировать конфигурацию</summary>
        <ImportFields
          machines={machines}
          projects={projects}
          machineId={importMachineId}
          projectId={importProjectId}
          onMachineChange={onImportMachineChange}
          onProjectChange={onImportProjectChange}
          onPreview={onImportPreview}
        />
      </details>
      <MachineRegistryList agents={status.agents} onToggle={onMachineRegistryToggle} />
      <ServerList
        servers={registry.servers}
        status={status}
        machines={machines}
        projects={projects}
        onToggle={onToggleServer}
        onRename={onRenameServer}
        onDelete={onDeleteServer}
        onUpdate={onUpdateServer}
        onProjectOverrideChange={onProjectOverrideChange}
        onProjectOverrideClear={onProjectOverrideClear}
        onRefreshStatus={onRefreshStatus}
      />
      <DraftList drafts={registry.drafts} onContinue={onContinueDraft} />
      {preview && <ImportPreview preview={preview} selectedServerIds={selectedImportServerIds} onSelectionChange={onImportServerSelectionChange} onCommit={onImportCommit} onCancel={onImportCancel} />}
    </>
  );
}

function MachineRegistryList({ agents, onToggle }: { agents: McpRegistryStatus['agents']; onToggle: McpRegistryListProps['onMachineRegistryToggle'] }) {
  if (agents.length === 0) return null;

  return (
    <section className="mcp-machine-registry" aria-label="Реестр MCP на машинах">
      <h3>Реестр MCP на машинах</h3>
      <p>Настройка действует для новых и возобновляемых сессий. Когда реестр выключен, машина использует локальную конфигурацию MCP.</p>
      {agents.map(agent => (
        <MachineRegistryRow key={agent.machineId} agent={agent} onToggle={onToggle} />
      ))}
    </section>
  );
}

function MachineRegistryRow({ agent, onToggle }: { agent: McpRegistryStatus['agents'][number]; onToggle: McpRegistryListProps['onMachineRegistryToggle'] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const toggle = async (enabled: boolean) => {
    if (enabled) {
      const machineName = agent.machineName || agent.machineId;
      const confirmed = window.confirm(
        `Новые и возобновлённые сессии на ${machineName} будут получать MCP только из реестра; локальные .claude.json/.mcp.json и [mcp_servers] Codex перестанут использоваться. Включить?`,
      );
      if (!confirmed) return;
    }

    setBusy(true);
    setError('');
    try {
      await onToggle(agent.machineId, enabled);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mcp-machine-registry-row">
      <label>
        <input className="mcp-checkbox" type="checkbox" checked={agent.registryEnabled} disabled={busy} onChange={event => void toggle(event.target.checked)} />
        <span>{agent.machineName || agent.machineId}</span>
        <small>{agent.online ? 'онлайн' : 'не в сети'}</small>
      </label>
      {error && <small role="alert">{error}</small>}
    </div>
  );
}

function ImportFields({
  machines,
  projects,
  machineId,
  projectId,
  onMachineChange,
  onProjectChange,
  onPreview,
}: {
  machines: MachineOption[];
  projects: UserProjectView[];
  machineId: string;
  projectId: string;
  onMachineChange: (machineId: string) => void;
  onProjectChange: (projectId: string) => void;
  onPreview: () => void;
}) {
  const availableProjects = projects.filter(project => project.bindings.some(binding => binding.runnerId === machineId));
  const canImport = machines.some(machine => machine.id === machineId && machine.online);

  return (
    <>
      {!machineId && <p className="mcp-field-hint">Выберите онлайн-машину для импорта.</p>}
      <div className="mcp-import-controls">
        <McpSegment
          label="Машина для импорта"
          value={machineId}
          options={machines.map(machine => ({
            value: machine.id,
            label: machine.name,
            description: machine.online ? 'В сети' : 'Не в сети',
            disabled: !machine.online,
          }))}
          onChange={onMachineChange}
        />
        <label>
          Проект для импорта
          <select className="input" value={projectId} onChange={event => onProjectChange(event.target.value)} disabled={!machineId}>
            <option value="">Выберите проект</option>
            {availableProjects.map(project => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <button className="btn" disabled={!canImport || !projectId} onClick={onPreview}>
          Предпросмотр импорта
        </button>
      </div>
    </>
  );
}

function ServerList({
  servers,
  status,
  machines,
  projects,
  onToggle,
  onRename,
  onDelete,
  onUpdate,
  onProjectOverrideChange,
  onProjectOverrideClear,
  onRefreshStatus,
}: {
  servers: McpRegistryResponse['servers'];
  status: McpRegistryStatus;
  machines: MachineOption[];
  projects: UserProjectView[];
  onToggle: McpRegistryListProps['onToggleServer'];
  onRename: McpRegistryListProps['onRenameServer'];
  onDelete: McpRegistryListProps['onDeleteServer'];
  onUpdate: McpRegistryListProps['onUpdateServer'];
  onProjectOverrideChange: McpRegistryListProps['onProjectOverrideChange'];
  onProjectOverrideClear: McpRegistryListProps['onProjectOverrideClear'];
  onRefreshStatus: McpRegistryListProps['onRefreshStatus'];
}) {
  return servers.map(server => (
    <ServerRow
      key={server.id}
      server={server}
      status={status}
      machines={machines}
      projects={projects}
      onToggle={onToggle}
      onRename={onRename}
      onDelete={onDelete}
      onUpdate={onUpdate}
      onProjectOverrideChange={onProjectOverrideChange}
      onProjectOverrideClear={onProjectOverrideClear}
      onRefreshStatus={onRefreshStatus}
    />
  ));
}

function ServerRow({
  server,
  status,
  machines,
  projects,
  onToggle,
  onRename,
  onDelete,
  onUpdate,
  onProjectOverrideChange,
  onProjectOverrideClear,
  onRefreshStatus,
}: {
  server: McpRegistryResponse['servers'][number];
  status: McpRegistryStatus;
  machines: MachineOption[];
  projects: UserProjectView[];
  onToggle: McpRegistryListProps['onToggleServer'];
  onRename: McpRegistryListProps['onRenameServer'];
  onDelete: McpRegistryListProps['onDeleteServer'];
  onUpdate: McpRegistryListProps['onUpdateServer'];
  onProjectOverrideChange: McpRegistryListProps['onProjectOverrideChange'];
  onProjectOverrideClear: McpRegistryListProps['onProjectOverrideClear'];
  onRefreshStatus: McpRegistryListProps['onRefreshStatus'];
}) {
  const rename = () => {
    const name = window.prompt('Новое имя сервера', server.name);
    if (!name || name === server.name) return;
    onRename(server.id, { revision: server.revision, name });
  };

  const remove = () => {
    if (window.confirm(`Удалить сервер ${server.name}?`)) onDelete(server.id, server.revision);
  };

  return (
    <article className="mcp-row">
      <div className="mcp-r-top">
        <strong>{server.name}</strong>
        <span className={`pill mcp-status-pill ${mcpStatusTone(server.enabled ? 'enabled' : 'disabled')}`}>{mcpStatusLabel(server.enabled ? 'enabled' : 'disabled')}</span>
      </div>
      <p className="mcp-meta">
        {[
          server.transport === 'stdio' ? '\u041a\u043e\u043c\u0430\u043d\u0434\u0430 (stdio)' : '\u0423\u0434\u0430\u043b\u0451\u043d\u043d\u044b\u0439 HTTP',
          MCP_MODE_LABELS[server.mode],
          server.machineScope.allMachines ? '\u0432\u0441\u0435 \u043c\u0430\u0448\u0438\u043d\u044b' : server.machineScope.machineIds.join(', '),
        ]
          .filter(Boolean)
          .join(' \u00b7 ')}
      </p>
      {server.url && <code className="mcp-target">{server.url}</code>}
      <SecretList secrets={server.secrets} />
      {server.transport === 'http' && <RegistryOAuthControl server={server} status={status} onRefreshStatus={onRefreshStatus} />}
      <GatewayList serverId={server.id} status={status} />
      <ServerConfigEditor server={server} machines={machines} onSave={onUpdate} />
      <ProjectOverrideControl serverId={server.id} projects={projects} onChange={onProjectOverrideChange} onClear={onProjectOverrideClear} />
      <div className="mcp-actions">
        <button className="btn ghost" onClick={() => onToggle(server.id, { revision: server.revision, enabled: !server.enabled })}>
          {server.enabled ? 'Выключить для всех' : 'Включить для всех'}
        </button>
        <button className="btn ghost" onClick={rename}>
          Переименовать
        </button>
        <button className="btn danger" onClick={remove}>
          Удалить
        </button>
      </div>
    </article>
  );
}

function RegistryOAuthControl({
  server,
  status,
  onRefreshStatus,
}: {
  server: McpRegistryResponse['servers'][number];
  status: McpRegistryStatus;
  onRefreshStatus: McpRegistryListProps['onRefreshStatus'];
}) {
  const eligibleAgents = useMemo(
    () =>
      status.agents.filter(agent => {
        const allowed = server.machineScope.allMachines || server.machineScope.machineIds.includes(agent.machineId);
        return allowed && agent.online && agent.capabilities.includes('mcp.oauth.v1');
      }),
    [server.machineScope.allMachines, server.machineScope.machineIds, status.agents],
  );
  const serverStatuses = status.oauth.filter(item => item.serverId === server.id);
  const [machineId, setMachineId] = useState(eligibleAgents[0]?.machineId ?? '');
  const [startResponse, setStartResponse] = useState<Awaited<ReturnType<typeof api.mcpRegistryOAuthStart>> | null>(null);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const selectedStatus = serverStatuses.find(item => item.machineId === machineId);
  const displayedState = selectedStatus?.state ?? (startResponse ? 'pending' : 'needs-login');

  useEffect(() => {
    if (!eligibleAgents.some(agent => agent.machineId === machineId)) {
      setMachineId(eligibleAgents[0]?.machineId ?? '');
    }
  }, [eligibleAgents, machineId]);

  const startLogin = async () => {
    if (!machineId || busy) return;
    const loginWindow = window.open('about:blank', '_blank');
    setBusy(true);
    setError('');
    setStartResponse(null);
    setPopupBlocked(false);
    try {
      const response = await api.mcpRegistryOAuthStart(server.id, { machineId });
      setStartResponse(response);
      setPopupBlocked(!loginWindow);
      await onRefreshStatus();
      if (loginWindow) {
        loginWindow.opener = null;
        loginWindow.location.href = response.authorizationUrl;
      }
    } catch (cause) {
      loginWindow?.close();
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!machineId || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.mcpRegistryOAuthRevoke(server.id, { machineId });
      await onRefreshStatus();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const validateAndConnect = async () => {
    if (!machineId || busy) return;
    setBusy(true);
    setError('');
    try {
      const validation = await api.mcpRegistryOAuthValidate(server.id, { machineId });
      if (validation.state !== 'checked') {
        setError(validation.state === 'needs_auth' ? 'Сервер всё ещё требует входа.' : 'Проверка соединения не прошла.');
        await onRefreshStatus();
        return;
      }
      await api.mcpRegistryOAuthConnect(server.id, { machineId });
      await onRefreshStatus();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mcp-oauth" aria-label={`OAuth ${server.name}`}>
      <label>
        Машина для входа
        <select className="input" value={machineId} disabled={busy || eligibleAgents.length === 0} onChange={event => setMachineId(event.target.value)}>
          {eligibleAgents.map(agent => (
            <option key={agent.machineId} value={agent.machineId}>
              {agent.machineName}
            </option>
          ))}
        </select>
      </label>
      {eligibleAgents.length === 0 && <small role="note">Нет доступной онлайн-машины с поддержкой MCP OAuth.</small>}
      <p className="mcp-meta" role="status">
        <span className={`pill mcp-status-pill ${mcpStatusTone(displayedState)}`}>{oauthStatusLabel(displayedState)}</span>
        {selectedStatus?.expiresAt && selectedStatus.state !== 'needs-login' ? ` · срок токена: ${new Date(selectedStatus.expiresAt).toLocaleString()}` : ''}
      </p>
      {selectedStatus?.error && (
        <small className="bad" role="alert">
          {selectedStatus.error}
        </small>
      )}
      {error && (
        <small className="bad" role="alert">
          {error}
        </small>
      )}
      {selectedStatus?.state === 'signed-in' && !selectedStatus.connected && (
        <button className="btn primary" disabled={busy || !machineId} onClick={() => void validateAndConnect()}>
          Проверить и подключить
        </button>
      )}
      {selectedStatus?.state === 'signed-in' ? (
        <button className="btn ghost" disabled={busy || !machineId} onClick={() => void revoke()}>
          Выйти
        </button>
      ) : (
        <button className="btn" disabled={busy || !machineId || selectedStatus?.state === 'pending'} onClick={() => void startLogin()}>
          {busy ? 'Подготовка входа…' : 'Войти'}
        </button>
      )}
      {!busy && startResponse && popupBlocked && (
        <a className="btn" href={startResponse.authorizationUrl} target="_blank" rel="noreferrer">
          Открыть страницу входа
        </a>
      )}
    </section>
  );
}

function oauthStatusLabel(state: McpRegistryStatus['oauth'][number]['state']): string {
  return mcpStatusLabel(state);
}

function ServerConfigEditor({ server, machines, onSave }: { server: McpRegistryResponse['servers'][number]; machines: MachineOption[]; onSave: McpRegistryListProps['onUpdateServer'] }) {
  const [mode, setMode] = useState(server.mode);
  const [allMachines, setAllMachines] = useState(server.machineScope.allMachines);
  const [machineIds, setMachineIds] = useState(server.machineScope.machineIds);

  useEffect(() => {
    setMode(server.mode);
    setAllMachines(server.machineScope.allMachines);
    setMachineIds(server.machineScope.machineIds);
  }, [server.revision, server.mode, server.machineScope.allMachines, server.machineScope.machineIds]);

  const toggleMachine = (machineId: string) => {
    const selected = machineIds.includes(machineId);
    if (selected) {
      setMachineIds(machineIds.filter(id => id !== machineId));
      return;
    }
    setMachineIds([...machineIds, machineId]);
  };

  const save = () => {
    onSave(server.id, {
      revision: server.revision,
      mode,
      machineScope: { allMachines, machineIds: allMachines ? [] : machineIds },
    });
  };

  return (
    <details className="mcp-server-editor">
      <summary>Изменить режим и доступ по машинам</summary>
      <McpSegment
        label="Режим запуска"
        value={mode}
        options={[
          { value: 'remote', label: MCP_MODE_LABELS.remote, description: 'Подключение к удалённому серверу' },
          { value: 'machine-shared', label: MCP_MODE_LABELS['machine-shared'], description: 'Один процесс для машины' },
          { value: 'per-session', label: MCP_MODE_LABELS['per-session'], description: 'Отдельный процесс для сессии' },
        ]}
        onChange={setMode}
      />
      <label>
        <input className="mcp-checkbox" type="checkbox" checked={allMachines} onChange={event => setAllMachines(event.target.checked)} />
        Все машины
      </label>
      {!allMachines && (
        <fieldset>
          <legend>Разрешённые машины</legend>
          {machines.map(machine => (
            <label key={machine.id}>
              <input className="mcp-checkbox" type="checkbox" checked={machineIds.includes(machine.id)} onChange={() => toggleMachine(machine.id)} />
              {machine.name} {!machine.online && <small>Не в сети</small>}
            </label>
          ))}
        </fieldset>
      )}
      <button className="btn" disabled={!allMachines && machineIds.length === 0} onClick={save}>
        Сохранить настройки
      </button>
    </details>
  );
}

function ProjectOverrideControl({
  serverId,
  projects,
  onChange,
  onClear,
}: {
  serverId: string;
  projects: UserProjectView[];
  onChange: McpRegistryListProps['onProjectOverrideChange'];
  onClear: McpRegistryListProps['onProjectOverrideClear'];
}) {
  const [projectId, setProjectId] = useState('');
  const [override, setOverride] = useState<McpProjectOverride | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!projectId) {
      setOverride(null);
      return;
    }

    let cancelled = false;
    setOverride(null);
    setLoading(true);
    setError('');
    void api
      .mcpRegistryProjectOverride(serverId, projectId)
      .then(result => {
        if (!cancelled) setOverride(result);
      })
      .catch(cause => {
        if (!cancelled) setError(errorText(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [serverId, projectId]);

  const selectOverride = async (value: string) => {
    if (!override || !projectId) return;
    try {
      setLoading(true);
      setError('');
      const updated = value === 'inherit' ? await onClear(serverId, projectId, override.revision) : await onChange(serverId, projectId, value === 'enabled', override.revision);
      setOverride(updated);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mcp-project-override">
      <label>
        Переопределение для проекта
        <select className="input" value={projectId} onChange={event => setProjectId(event.target.value)}>
          <option value="">Выберите проект</option>
          {projects.map(project => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      {projectId && (
        <label>
          Доступность в проекте
          <select
            className="input"
            value={override?.enabled === null || !override ? 'inherit' : override.enabled ? 'enabled' : 'disabled'}
            disabled={loading || !override}
            onChange={event => void selectOverride(event.target.value)}
          >
            <option value="inherit">Как в реестре</option>
            <option value="enabled">Включён в проекте</option>
            <option value="disabled">Выключен в проекте</option>
          </select>
        </label>
      )}
      {loading && <small role="status">Загрузка override…</small>}
      {error && <small role="alert">{error}</small>}
    </div>
  );
}

function SecretList({ secrets }: { secrets: McpRegistryResponse['servers'][number]['secrets'] }) {
  if (!secrets) return null;
  return secrets.map(secret => (
    <small key={secret.secretId}>
      {secret.name}: {secret.state === 'set' ? 'задан' : 'нужен секрет'}
    </small>
  ));
}

function GatewayList({ serverId, status }: { serverId: string; status: McpRegistryStatus }) {
  const gateways = status.gateways.filter(gateway => gateway.serverId === serverId);
  return gateways.map(gateway => {
    const machineName = status.agents.find(agent => agent.machineId === gateway.machineId)?.machineName ?? gateway.machineId;
    const hasProblem = gateway.status === 'failed' || gateway.status === 'needs-secret';

    return (
      <p className={`mcp-meta ${hasProblem ? 'bad' : ''}`} key={`${gateway.machineId}:${gateway.sessionId ?? ''}`}>
        {machineName}: <span className={`pill mcp-status-pill ${mcpStatusTone(gateway.status)}`}>{mcpStatusLabel(gateway.status)}</span>
        {gateway.error ? ` — ${gateway.error}` : ''}
      </p>
    );
  });
}

function DraftList({ drafts, onContinue }: { drafts: McpRegistryResponse['drafts']; onContinue: (draft: McpRegistryDraftView) => void }) {
  if (drafts.length === 0) return null;
  return (
    <section aria-label="Черновики">
      <h3>Черновики от агента и мастера</h3>
      {drafts.map(draft => (
        <div className="mcp-row mcp-draft-row" key={draft.draftId}>
          <div className="mcp-draft-summary">
            <b>{draft.server.name}</b>
            <span className={`pill mcp-status-pill ${mcpStatusTone(draft.state)}`}>{mcpStatusLabel(draft.state)}</span>
          </div>
          <button className="btn" onClick={() => onContinue(draft)}>
            Продолжить и подключить
          </button>
        </div>
      ))}
    </section>
  );
}

function ImportPreview({
  preview,
  selectedServerIds,
  onSelectionChange,
  onCommit,
  onCancel,
}: {
  preview: McpImportPreviewResponse;
  selectedServerIds: string[];
  onSelectionChange: (serverIds: string[]) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const setSelected = (serverId: string, selected: boolean) => {
    const next = selected ? [...selectedServerIds, serverId] : selectedServerIds.filter(id => id !== serverId);
    onSelectionChange(next);
  };

  return (
    <section className="mcp-note info" aria-label="Предпросмотр импорта">
      <h3>Предпросмотр импорта</h3>
      <p>Будут просмотрены user и local записи из .claude.json, а также записи выбранного проекта из .mcp.json.</p>
      <p>
        {preview.servers.length} серверов; секретов найдено: {preview.secretsCaptured}.
      </p>
      <p>Значения секретов не возвращаются в браузер. Выбранные секреты будут зашифрованы и сохранены в хабе.</p>
      <ul className="mcp-import-servers">
        {preview.servers.map(server => {
          const secrets = server.secrets.filter(secret => secret.state === 'set');
          return (
            <li key={server.id}>
              <label>
                <input className="mcp-checkbox" type="checkbox" checked={selectedServerIds.includes(server.id)} onChange={event => setSelected(server.id, event.target.checked)} />
                <span>{server.name}</span>
                <small>{sourceLabel(server.source)}</small>
              </label>
              {secrets.length > 0 && <small>Секреты для шифрования: {secrets.map(secret => secret.name).join(', ')}</small>}
            </li>
          );
        })}
      </ul>
      {preview.warnings.map(warning => (
        <p key={warning}>{warning}</p>
      ))}
      <button className="btn primary" disabled={selectedServerIds.length === 0} onClick={onCommit}>
        Импортировать выбранные серверы
      </button>
      <button className="btn" onClick={onCancel}>
        Отмена
      </button>
    </section>
  );
}

function sourceLabel(source: McpImportPreviewResponse['servers'][number]['source']): string {
  if (source === 'user') return '.claude.json · user';
  if (source === 'local') return '.claude.json · local';
  return '.mcp.json · проект';
}

function errorText(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return 'Не удалось обновить override';
}
