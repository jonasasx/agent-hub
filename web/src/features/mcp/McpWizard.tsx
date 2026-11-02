import { useEffect, useReducer, useState } from 'react';
import type { McpDraftCreateRequest, McpRegistryDraftView, McpRegistryOAuthStatus, McpRegistryOAuthValidateResponse, McpServerConfig } from '../../api/mcpRegistryTypes';
import { api } from '../../api/client';
import { McpServerForm, type McpMachineOption } from './McpServerForm';

export interface McpWizardState {
  step: number;
  transport: 'stdio' | 'http' | 'sse';
  name: string;
  command: string;
  url: string;
  argsText: string;
  envText: string;
  headersText: string;
  secretName: string;
  secretValue: string;
  mode: McpServerConfig['mode'];
  scope: 'all' | 'machines' | 'project';
  scopeMachineIds: string[];
  machineId: string;
  projectId: string;
  oauthUrl: string;
}

type WizardAction = { type: 'reset' } | { type: 'patch'; patch: Partial<McpWizardState> };

const initialState: McpWizardState = {
  step: 0,
  transport: 'stdio',
  name: '',
  command: '',
  url: '',
  argsText: '',
  envText: '',
  headersText: '',
  secretName: '',
  secretValue: '',
  mode: 'machine-shared',
  scope: 'all',
  scopeMachineIds: [],
  machineId: '',
  projectId: '',
  oauthUrl: '',
};

function wizardReducer(state: McpWizardState, action: WizardAction): McpWizardState {
  switch (action.type) {
    case 'reset':
      return initialState;
    case 'patch':
      return { ...state, ...action.patch };
  }
}

function useMcpWizard(initialDraft: McpRegistryDraftView | null) {
  const [state, dispatch] = useReducer(wizardReducer, initialDraft, createInitialState);

  const patch = (changes: Partial<McpWizardState>) => {
    dispatch({ type: 'patch', patch: changes });
  };

  return { state, patch };
}

function createInitialState(draft: McpRegistryDraftView | null): McpWizardState {
  if (!draft) return initialState;

  const server = draft.server;
  let scope: McpWizardState['scope'] = 'machines';
  if (server.machineScope.allMachines) scope = 'all';
  if (server.projectIds.length > 0) scope = 'project';

  return {
    ...initialState,
    step: 4,
    transport: server.transport,
    name: server.name,
    command: server.command ?? '',
    url: server.url ?? '',
    argsText: server.args?.join('\n') ?? '',
    mode: server.mode,
    scope,
    scopeMachineIds: server.machineScope.machineIds,
    machineId: server.machineScope.machineIds[0] ?? '',
    projectId: server.projectIds[0] ?? '',
  };
}

function parseEntries(text: string, secretName: string): NonNullable<McpDraftCreateRequest['server']['env']> {
  const entries: NonNullable<McpDraftCreateRequest['server']['env']> = {};
  const sensitiveName = /(?:token|api[-_]?key|secret|password|credential|authorization|cookie)/i;
  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error('Параметры вводятся построчно в формате ИМЯ=значение');

    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (value === '@secret') {
      entries[name] = { kind: 'secret-name', name: secretName };
      continue;
    }
    if (sensitiveName.test(name)) throw new Error('Поле похоже на секрет. Введите его на шаге секретов.');

    entries[name] = { kind: 'literal', value };
  }

  return entries;
}

function serverCandidate(state: McpWizardState): McpDraftCreateRequest['server'] {
  const secretName = state.secretName.trim() || 'token';
  const scopeMachineIds = state.scope === 'machines' ? state.scopeMachineIds : [];
  const projectIds = state.scope === 'project' && state.projectId ? [state.projectId] : [];
  const server = {
    id: crypto.randomUUID(),
    name: state.name,
    enabled: true,
    transport: state.transport,
    mode: state.mode,
    ...(state.transport === 'stdio'
      ? { command: state.command, args: state.argsText.split('\n').filter(Boolean), env: parseEntries(state.envText, secretName) }
      : {
          url: state.url,
          headers: parseEntries(state.headersText, secretName),
          ...(state.url.includes('__AGENT_HUB_SECRET__') ? { urlSecretName: secretName } : {}),
        }),
    machineScope: { allMachines: state.scope === 'all', machineIds: scopeMachineIds },
    projectIds,
  };
  return server;
}

function missingSecretBinding(state: McpWizardState): string {
  if (state.secretValue.trim()) return '';

  const text = state.transport === 'stdio' ? state.envText : state.headersText;
  const fieldType = state.transport === 'stdio' ? 'Переменная среды' : 'Заголовок';
  for (const line of text
    .split('\n')
    .map(value => value.trim())
    .filter(Boolean)) {
    const separator = line.indexOf('=');
    if (separator > 0 && line.slice(separator + 1).trim() === '@secret') {
      const fieldName = line.slice(0, separator).trim();
      return `${fieldType} «${fieldName}»: введите значение секрета на шаге «Секреты».`;
    }
  }

  return '';
}

interface McpWizardProps {
  initialDraft: McpRegistryDraftView | null;
  machines: McpMachineOption[];
  onDraftChange: (draft: McpRegistryDraftView) => void;
  onDone: () => void;
  onClose: () => void;
}

export function McpWizard({ initialDraft, machines, onDraftChange, onDone, onClose }: McpWizardProps) {
  const { state, patch } = useMcpWizard(initialDraft);
  const [draft, setDraft] = useState(initialDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [persistedServerId, setPersistedServerId] = useState('');
  const [oauthStatus, setOauthStatus] = useState<McpRegistryOAuthStatus | null>(null);
  const [oauthValidationState, setOauthValidationState] = useState<McpRegistryOAuthValidateResponse['state'] | null>(null);
  const [oauthLink, setOauthLink] = useState('');

  useEffect(() => {
    if (!persistedServerId || oauthStatus?.state !== 'pending') return;
    const timer = window.setInterval(() => {
      void api
        .mcpRegistryStatus()
        .then(status => {
          const next = status.oauth?.find(item => item.serverId === persistedServerId && item.machineId === state.machineId);
          if (next) {
            setOauthStatus(next);
            if (next.state !== 'pending') setOauthLink('');
          }
        })
        .catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [oauthStatus?.state, persistedServerId, state.machineId]);

  const next = () => patch({ step: state.step + 1 });

  const saveDraft = async () => {
    setBusy(true);
    setError('');

    try {
      const secrets = state.secretValue ? [{ name: state.secretName.trim() || 'token', value: state.secretValue }] : undefined;
      const created = await api.mcpRegistryCreate({ server: serverCandidate(state), secrets });
      setDraft(created);
      onDraftChange(created);
      patch({ secretValue: '', step: 4 });
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const runValidation = async () => {
    if (!draft) return;
    if (missingSecretBinding(state)) return;
    setBusy(true);
    setError('');

    try {
      const validated = await api.mcpRegistryValidate(draft.draftId, {
        machineId: state.machineId,
        revision: draft.revision,
      });
      setDraft(validated);
      onDraftChange(validated);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    if (!draft || !window.confirm('Подключить этот сервер?')) return;
    setBusy(true);
    setError('');

    try {
      const result = await api.mcpRegistryConnect(draft.draftId, { revision: draft.revision, userConfirmed: true });
      if (draft.state === 'needs_auth') {
        setPersistedServerId(result.serverId);
        setOauthStatus({ serverId: result.serverId, machineId: state.machineId, state: 'needs-login', validationState: 'needs_auth', connected: false });
        setOauthValidationState('needs_auth');
        patch({ oauthUrl: '' });
        return;
      }
      onDone();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const saveUnchecked = async () => {
    if (!draft) return;
    if (missingSecretBinding(state)) return;
    if (!window.confirm('Сохранить сервер без проверки? Он будет помечен как непроверенный.')) return;
    setBusy(true);
    setError('');

    try {
      await api.mcpRegistrySaveUnchecked(draft.draftId, { revision: draft.revision, userConfirmed: true });
      onDone();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const saveSecret = async () => {
    if (!draft || !state.secretValue) return;
    setBusy(true);
    setError('');

    try {
      const updated = await api.mcpRegistryUpdate(draft.draftId, {
        revision: draft.revision,
        server: {},
        secrets: [{ name: state.secretName || 'token', value: state.secretValue }],
      });
      setDraft(updated);
      onDraftChange(updated);
      patch({ secretValue: '' });
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const startOAuth = async () => {
    if (!persistedServerId) return;
    const loginWindow = window.open('about:blank', '_blank');
    setBusy(true);
    setError('');
    setOauthLink('');

    try {
      const result = await api.mcpRegistryOAuthStart(persistedServerId, { machineId: state.machineId });
      setOauthStatus({ serverId: result.serverId, machineId: result.machineId, state: result.state, validationState: 'needs_auth', connected: false, expiresAt: result.expiresAt });
      setOauthValidationState(null);
      if (loginWindow) {
        loginWindow.opener = null;
        loginWindow.location.href = result.authorizationUrl;
        setOauthLink('');
      } else {
        setOauthLink(result.authorizationUrl);
      }
    } catch (cause) {
      loginWindow?.close();
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const validateOAuthServer = async () => {
    if (!persistedServerId) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.mcpRegistryOAuthValidate(persistedServerId, { machineId: state.machineId });
      setOauthValidationState(result.state);
      if (result.state === 'validation-failed') setError('Проверка соединения не прошла.');
      if (result.state === 'needs_auth') setError('Сервер всё ещё требует входа.');
      const status = await api.mcpRegistryStatus();
      const next = status.oauth?.find(item => item.serverId === persistedServerId && item.machineId === state.machineId);
      if (next) setOauthStatus(next);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const connectOAuthServer = async () => {
    if (!persistedServerId || oauthValidationState !== 'checked') return;
    setBusy(true);
    setError('');
    try {
      await api.mcpRegistryOAuthConnect(persistedServerId, { machineId: state.machineId });
      onDone();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mcp-wizard">
      <h3>Добавление сервера · шаг {Math.min(state.step + 1, 5)} из 5</h3>
      <McpServerForm
        state={state}
        machines={machines}
        busy={busy}
        error={error}
        secretBindingError={missingSecretBinding(state)}
        draft={draft}
        onPatch={patch}
        onNext={next}
        onSaveDraft={() => void saveDraft()}
        onValidate={() => void runValidation()}
        onConnect={() => void connect()}
        onSaveSecret={() => void saveSecret()}
        onStartOAuth={() => void startOAuth()}
        persistedServerId={persistedServerId}
        oauthStatus={oauthStatus}
        oauthValidationState={oauthValidationState}
        oauthLink={oauthLink}
        onOAuthValidate={() => void validateOAuthServer()}
        onOAuthConnect={() => void connectOAuthServer()}
        onSaveUnchecked={() => void saveUnchecked()}
        onClose={onClose}
      />
    </section>
  );
}

function errorText(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return 'Запрос не выполнен';
}
