import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { McpImportPreviewResponse, McpRegistryDraftView, McpRegistryResponse, McpRegistryServerUpdate, McpRegistryStatus } from '../../api/mcpRegistryTypes';
import { api } from '../../api/client';
import { useDialog } from '../ui/a11y';
import { useStore } from '../../store';
import type { UserProjectView } from '../../api/types';
import { McpRegistryList } from './McpRegistryList';
import { McpWizard } from './McpWizard';

const emptyRegistry: McpRegistryResponse = { revision: 0, servers: [], drafts: [] };
const emptyStatus: McpRegistryStatus = { revision: 0, agents: [], gateways: [], oauth: [] };

export function McpRegistry({ onClose, sessionId }: { onClose: () => void; sessionId?: string }) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const machines = useStore(state => state.runners);
  const [projects, setProjects] = useState<UserProjectView[]>([]);
  const [registry, setRegistry] = useState(emptyRegistry);
  const [status, setStatus] = useState(emptyStatus);
  const [selectedDraft, setSelectedDraft] = useState<McpRegistryDraftView | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [importMachineId, setImportMachineId] = useState('');
  const [importProjectId, setImportProjectId] = useState('');
  const [preview, setPreview] = useState<McpImportPreviewResponse | null>(null);
  const [selectedImportServerIds, setSelectedImportServerIds] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const reload = async () => {
    const [nextRegistry, nextStatus] = await Promise.all([api.mcpRegistry(), api.mcpRegistryStatus()]);
    setRegistry(nextRegistry);
    setStatus({
      revision: nextStatus.revision ?? nextRegistry.revision,
      agents: nextStatus.agents ?? [],
      gateways: nextStatus.gateways ?? [],
      oauth: nextStatus.oauth ?? [],
    });
  };

  const refreshStatus = async () => {
    const nextStatus = await api.mcpRegistryStatus();
    setStatus(current => ({
      ...current,
      ...nextStatus,
      oauth: nextStatus.oauth ?? [],
    }));
  };

  const toggleMachineRegistry = async (machineId: string, enabled: boolean) => {
    try {
      setError('');
      const result = await api.mcpRegistryMachineToggle(machineId, { enabled });
      setStatus(current => ({
        ...current,
        agents: current.agents.map(agent => (agent.machineId === result.machineId ? { ...agent, registryEnabled: result.registryEnabled } : agent)),
      }));
      return result;
    } catch (cause) {
      setError(errorText(cause));
      throw cause;
    }
  };

  useEffect(() => {
    void reload().catch(cause => setError(errorText(cause)));
    void api
      .catalogProjects()
      .then(setProjects)
      .catch(cause => setError(errorText(cause)));
  }, []);

  useEffect(() => {
    if (!status.oauth.some(item => item.state === 'pending')) return;
    const timer = window.setInterval(() => {
      void api
        .mcpRegistryStatus()
        .then(nextStatus => {
          setStatus(current => ({ ...current, ...nextStatus, oauth: nextStatus.oauth ?? [] }));
        })
        .catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [status.oauth]);

  const startNewServer = () => {
    setNotice('');
    setSelectedDraft(null);
    setWizardOpen(true);
    setError('');
  };

  const continueDraft = (draft: McpRegistryDraftView) => {
    setNotice('');
    setSelectedDraft(draft);
    setWizardOpen(true);
  };

  const updateDraft = (draft: McpRegistryDraftView) => {
    setRegistry(current => ({
      ...current,
      drafts: [draft, ...current.drafts.filter(item => item.draftId !== draft.draftId)],
    }));
  };

  const updateServer = async (serverId: string, update: McpRegistryServerUpdate) => {
    try {
      setError('');
      await api.mcpRegistryPatchServer(serverId, update);
      await reload();
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const updateProjectOverride = async (serverId: string, projectId: string, enabled: boolean, revision: number) => {
    try {
      setError('');
      return await api.mcpRegistryPutProjectOverride(serverId, projectId, { revision, enabled });
    } catch (cause) {
      setError(errorText(cause));
      throw cause;
    }
  };

  const clearProjectOverride = async (serverId: string, projectId: string, revision: number) => {
    try {
      setError('');
      return await api.mcpRegistryDeleteProjectOverride(serverId, projectId, revision);
    } catch (cause) {
      setError(errorText(cause));
      throw cause;
    }
  };

  const deleteServer = async (serverId: string, revision: number) => {
    try {
      setError('');
      await api.mcpRegistryDelete(serverId, revision);
      await reload();
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const previewImport = async () => {
    const project = projects.find(item => item.id === importProjectId);
    const binding = project?.bindings.find(item => item.runnerId === importMachineId);
    if (!binding) {
      setError('Выберите проект с путём для выбранной машины.');
      return;
    }
    try {
      setError('');
      const result = await api.mcpRegistryImportPreview({ machineId: importMachineId, projectRoot: binding.path });
      setPreview(result);
      setSelectedImportServerIds(result.servers.map(server => server.id));
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const commitImport = async () => {
    if (!preview) return;
    try {
      setError('');
      await api.mcpRegistryImportCommit({
        importId: preview.importId,
        revision: preview.revision,
        serverIds: selectedImportServerIds,
        userConfirmed: true,
      });
      setPreview(null);
      setSelectedImportServerIds([]);
      await reload();
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const doneWizard = async (message?: string) => {
    setWizardOpen(false);
    setSelectedDraft(null);
    setError('');
    await reload();
    if (message) setNotice(message);
  };

  const closePanel = () => {
    if (!wizardOpen) {
      onClose();
      return;
    }
    if (!window.confirm('Закрыть мастер? Несохранённый ввод будет потерян.')) return;
    setWizardOpen(false);
    setSelectedDraft(null);
  };

  useDialog(dialogRef, closePanel, closeButtonRef);

  return createPortal(
    <div className="scrim sub-scrim mcp-registry-scrim" onMouseDown={event => event.target === event.currentTarget && closePanel()}>
      <section ref={dialogRef} className="sub-list mcp-panel mcp-registry" role="dialog" aria-modal="true" aria-labelledby="registry-title" onClick={() => notice && setNotice('')}>
        <header className="sub-head">
          <div>
            <h2 id="registry-title">Реестр MCP</h2>
            {!wizardOpen && <span className="mcp-when">Изменение {registry.revision}</span>}
          </div>
          <button ref={closeButtonRef} className="icon-btn" aria-label="Закрыть" onClick={closePanel}>
            ×
          </button>
        </header>
        {error && (
          <p role="alert" className="mcp-note bad">
            {error}
          </p>
        )}
        {notice && (
          <p className="mcp-note info" role="status">
            {notice}
          </p>
        )}
        <OutdatedAgentNotice status={status} />
        {wizardOpen ? (
          <McpWizard
            initialDraft={selectedDraft}
            sessionId={sessionId}
            machines={machines.map(machine => ({ id: machine.id, name: machine.name, online: machine.online }))}
            onDraftChange={updateDraft}
            onDone={message => void doneWizard(message)}
            onClose={() => setWizardOpen(false)}
          />
        ) : (
          <McpRegistryList
            registry={registry}
            status={status}
            machines={machines.map(machine => ({ id: machine.id, name: machine.name, online: machine.online }))}
            projects={projects}
            importMachineId={importMachineId}
            importProjectId={importProjectId}
            selectedImportServerIds={selectedImportServerIds}
            preview={preview}
            onImportMachineChange={setImportMachineId}
            onImportProjectChange={setImportProjectId}
            onImportServerSelectionChange={setSelectedImportServerIds}
            onImportPreview={() => void previewImport()}
            onImportCommit={() => void commitImport()}
            onImportCancel={() => {
              setPreview(null);
              setSelectedImportServerIds([]);
            }}
            onAdd={startNewServer}
            onContinueDraft={continueDraft}
            onToggleServer={updateServer}
            onRenameServer={updateServer}
            onUpdateServer={updateServer}
            onDeleteServer={(serverId, revision) => void deleteServer(serverId, revision)}
            onProjectOverrideChange={updateProjectOverride}
            onProjectOverrideClear={clearProjectOverride}
            onRefreshStatus={refreshStatus}
            onMachineRegistryToggle={toggleMachineRegistry}
          />
        )}
      </section>
    </div>,
    document.body,
  );
}

function OutdatedAgentNotice({ status }: { status: McpRegistryStatus }) {
  const outdatedAgents = status.agents.filter(agent => agent.protocolVersion === '1.12');
  return outdatedAgents.map(agent => (
    <p role="note" className="mcp-note warn" key={agent.machineId}>
      Агент {agent.machineName || agent.machineId} устарел (протокол 1.12). Обновите агент до версии 1.13, чтобы управлять реестром MCP.
    </p>
  ));
}

function errorText(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return 'Запрос не выполнен';
}
