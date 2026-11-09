import { useEffect, useReducer, useState } from 'react';
import type { McpDraftCreateRequest, McpRegistryDraftView, McpRegistryOAuthStatus, McpRegistryOAuthValidateResponse, McpServerConfig } from '../../api/mcpRegistryTypes';
import { ApiError, api } from '../../api/client';
import { McpServerForm, type McpMachineOption, type McpSecretField } from './McpServerForm';
import { mcpErrorMessage } from './mcpErrors';
import { mcpErrorText } from './actions';
import { t, useT } from '../../i18n';

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
  secretNameTouched: boolean;
  secretValues: Record<string, string>;
  mode: McpServerConfig['mode'];
  scope: 'all' | 'machines';
  scopeMachineIds: string[];
  machineId: string;
  oauthUrl: string;
}

type WizardAction = { type: 'reset' } | { type: 'patch'; patch: Partial<McpWizardState> } | { type: 'secret-value'; key: string; value: string };

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
  secretNameTouched: false,
  secretValues: {},
  mode: 'machine-shared',
  scope: 'all',
  scopeMachineIds: [],
  machineId: '',
  oauthUrl: '',
};

function wizardReducer(state: McpWizardState, action: WizardAction): McpWizardState {
  switch (action.type) {
    case 'reset':
      return initialState;
    case 'patch':
      return { ...state, ...action.patch };
    case 'secret-value':
      return { ...state, secretValues: { ...state.secretValues, [action.key]: action.value } };
  }
}

function useMcpWizard(initialDraft: McpRegistryDraftView | null) {
  const [state, dispatch] = useReducer(wizardReducer, initialDraft, createInitialState);

  const patch = (changes: Partial<McpWizardState>) => {
    dispatch({ type: 'patch', patch: changes });
  };

  const setSecretValue = (key: string, value: string) => {
    dispatch({ type: 'secret-value', key, value });
  };

  return { state, patch, setSecretValue };
}

function createInitialState(draft: McpRegistryDraftView | null): McpWizardState {
  if (!draft) return initialState;

  const server = draft.server;
  const machineIds = server.machineScope.machineIds;
  const selectedMachineId = !server.machineScope.allMachines && machineIds.length === 1 ? (machineIds[0] ?? '') : '';
  const envText = configEntriesText(server.env);
  const headersText = configEntriesText(server.headers);
  const firstSecretName = server.secrets.find(secret => secret.state === 'needs-secret')?.name ?? server.secrets[0]?.name ?? '';
  const scope: McpWizardState['scope'] = server.machineScope.allMachines && server.projectIds.length === 0 ? 'all' : 'machines';

  return {
    ...initialState,
    step: 4,
    transport: server.transport,
    name: server.name,
    command: server.command ?? '',
    url: server.url ?? '',
    argsText: server.args?.join('\n') ?? '',
    envText,
    headersText,
    secretName: firstSecretName,
    secretNameTouched: Boolean(firstSecretName),
    mode: server.transport === 'stdio' && server.mode === 'remote' ? 'machine-shared' : server.mode,
    scope,
    scopeMachineIds: machineIds,
    machineId: selectedMachineId,
  };
}

function configEntriesText(entries: McpServerConfig['env']): string {
  if (!entries) return '';
  return Object.entries(entries)
    .map(([name, value]) => {
      if (value.kind === 'literal') return `${name}=${value.value}`;
      return `${name}=@secret`;
    })
    .join('\n');
}

function parseEntries(text: string, state: McpWizardState, draft: McpRegistryDraftView | null): NonNullable<McpDraftCreateRequest['server']['env']> {
  const entries: NonNullable<McpDraftCreateRequest['server']['env']> = {};
  const sensitiveName = /(?:token|api[-_]?key|secret|password|credential|authorization|cookie)/i;
  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error(t('mcp.wizard.paramFormat'));

    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (value === '@secret') {
      const existingValue = savedSecretReference(state, draft, name);
      if (existingValue?.kind === 'secret') {
        entries[name] = existingValue;
      } else {
        const binding = secretBindings(state, draft).find(item => normalizeFieldName(state, item.fieldName) === normalizeFieldName(state, name));
        entries[name] = { kind: 'secret-name', name: binding?.secretName ?? name };
      }
      continue;
    }
    if (sensitiveName.test(name)) throw new Error(t('mcp.wizard.looksSecret'));

    entries[name] = { kind: 'literal', value };
  }

  return entries;
}

function serverCandidate(state: McpWizardState, draft: McpRegistryDraftView | null): McpDraftCreateRequest['server'] {
  const scopeMachineIds = state.scope === 'machines' ? state.scopeMachineIds : [];
  const server = {
    id: draft?.server.id ?? crypto.randomUUID(),
    name: state.name,
    enabled: true,
    transport: state.transport,
    mode: state.mode,
    ...(state.transport === 'stdio'
      ? {
          command: state.command,
          args: state.argsText.split('\n').filter(Boolean),
          env: parseEntries(state.envText, state, draft),
        }
      : {
          url: state.url,
          headers: parseEntries(state.headersText, state, draft),
          ...(draft?.server.urlSecretId && state.url === draft.server.url
            ? { urlSecretId: draft.server.urlSecretId }
            : state.url.includes('__AGENT_HUB_SECRET__')
              ? { urlSecretName: secretBindings(state, draft).find(binding => binding.isUrl)?.secretName ?? uniqueUrlSecretName(state, draft) }
              : {}),
        }),
    machineScope: { allMachines: state.scope !== 'machines', machineIds: scopeMachineIds },
    projectIds: [],
  };
  return server;
}

interface SecretBinding {
  fieldName: string;
  secretName: string;
  isUrl: boolean;
}

function secretBindings(state: McpWizardState, draft: McpRegistryDraftView | null): SecretBinding[] {
  const text = state.transport === 'stdio' ? state.envText : state.headersText;
  const configuredName = state.secretName.trim();
  const configuredSecretName = state.secretNameTouched && configuredName ? configuredName : undefined;
  const bindings = text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.includes('=') && line.slice(line.indexOf('=') + 1).trim() === '@secret')
    .map((line, index) => {
      const fieldName = line.slice(0, line.indexOf('=')).trim();
      const ref = savedSecretReference(state, draft, fieldName);
      const savedSecret = ref?.kind === 'secret' ? draft?.server.secrets.find(secret => secret.secretId === ref.secretId) : undefined;
      let secretName = savedSecret?.name ?? fieldName;
      if (!savedSecret && index === 0 && configuredSecretName) secretName = configuredSecretName;
      return { fieldName, secretName, isUrl: false };
    });

  if (state.transport !== 'stdio' && state.url.includes('__AGENT_HUB_SECRET__')) {
    const urlSecretId = draft?.server.urlSecretId;
    const savedName = urlSecretId ? draft.server.secrets.find(secret => secret.secretId === urlSecretId)?.name : undefined;
    const secretName = savedName ?? uniqueUrlSecretName(state, draft);
    bindings.push({ fieldName: 'URL', secretName, isUrl: true });
  }
  return bindings;
}

function uniqueUrlSecretName(state: McpWizardState, draft: McpRegistryDraftView | null): string {
  const usedNames = new Set((draft?.server.secrets ?? []).map(secret => secret.name.toLocaleLowerCase()));
  for (const line of state.headersText.split('\n')) {
    const separator = line.indexOf('=');
    if (separator > 0) usedNames.add(line.slice(0, separator).trim().toLocaleLowerCase());
  }
  if (state.secretNameTouched && state.secretName.trim()) usedNames.add(state.secretName.trim().toLocaleLowerCase());

  const baseName = 'url-token';
  if (!usedNames.has(baseName)) return baseName;
  let suffix = 2;
  while (usedNames.has(`${baseName}-${suffix}`)) suffix += 1;
  return `${baseName}-${suffix}`;
}

function savedSecretReference(state: McpWizardState, draft: McpRegistryDraftView | null, fieldName: string) {
  const values = state.transport === 'stdio' ? draft?.server.env : draft?.server.headers;
  const targetName = normalizeFieldName(state, fieldName);
  return Object.entries(values ?? {}).find(([name]) => normalizeFieldName(state, name) === targetName)?.[1];
}

function normalizeFieldName(state: McpWizardState, fieldName: string): string {
  return state.transport === 'stdio' ? fieldName : fieldName.toLocaleLowerCase();
}

function secretBindingConflict(state: McpWizardState, draft: McpRegistryDraftView | null, checkSecretNames: boolean): string {
  const normalize = (value: string) => (state.transport === 'stdio' ? value : value.toLocaleLowerCase());
  const configText = state.transport === 'stdio' ? state.envText : state.headersText;
  const fields = new Set<string>();
  if (state.transport !== 'stdio' && state.url.includes('__AGENT_HUB_SECRET__')) fields.add(normalize('URL'));
  for (const line of configText.split('\n')) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const fieldName = line.slice(0, separator).trim();
    const key = normalize(fieldName);
    if (fields.has(key)) return t('mcp.wizard.dupField', { field: fieldName });
    fields.add(key);
  }
  if (!checkSecretNames) return '';
  const bindings = secretBindings(state, draft).filter(binding => !isSecretSaved(binding, state, draft));
  for (const binding of bindings) {
    const bindingSecretId = secretIdForBinding(binding, state, draft);
    const normalizedName = normalize(binding.secretName);
    for (const savedSecret of draft?.server.secrets ?? []) {
      if (savedSecret.state !== 'set' || normalize(savedSecret.name) !== normalizedName) continue;
      if (savedSecret.secretId === bindingSecretId) continue;
      const owner = savedSecretOwner(savedSecret.secretId, binding, state, draft);
      if (owner) {
        return t('mcp.wizard.bindingOwned', { field: binding.fieldName, secret: binding.secretName, owner });
      }
    }
  }
  for (let index = 0; index < bindings.length; index += 1) {
    const binding = bindings[index]!;
    const bindingKey = normalize(binding.secretName);
    for (const other of bindings.slice(index + 1)) {
      const sameSecret = secretIdForBinding(binding, state, draft) && secretIdForBinding(binding, state, draft) === secretIdForBinding(other, state, draft);
      if (!sameSecret && bindingKey === normalize(other.secretName)) {
        return t('mcp.wizard.bindingsClash', { field: binding.fieldName, other: other.fieldName, secret: binding.secretName });
      }
    }
  }
  return '';
}

function savedSecretOwner(secretId: string, binding: SecretBinding, state: McpWizardState, draft: McpRegistryDraftView | null): string | null {
  if (!draft) return null;
  if (draft.server.urlSecretId === secretId && !binding.isUrl) return 'URL';

  const values = state.transport === 'stdio' ? draft.server.env : draft.server.headers;
  for (const [fieldName, value] of Object.entries(values ?? {})) {
    if (value.kind !== 'secret' || value.secretId !== secretId) continue;
    if (binding.isUrl || normalizeFieldName(state, fieldName) !== normalizeFieldName(state, binding.fieldName)) return fieldName;
  }
  return null;
}

function secretIdForBinding(binding: SecretBinding, state: McpWizardState, draft: McpRegistryDraftView | null): string | undefined {
  if (binding.isUrl) return draft?.server.urlSecretId;
  const value = savedSecretReference(state, draft, binding.fieldName);
  return value?.kind === 'secret' ? value.secretId : undefined;
}

function secretFields(state: McpWizardState, draft: McpRegistryDraftView | null, onlyMissing: boolean): McpSecretField[] {
  const bindings = secretBindings(state, draft).filter(binding => !onlyMissing || !isSecretSaved(binding, state, draft));
  return bindings.map(binding => ({
    key: binding.fieldName,
    name: binding.secretName,
    value: state.secretValues[binding.fieldName] ?? '',
  }));
}

function isSecretSaved(binding: SecretBinding, state: McpWizardState, draft: McpRegistryDraftView | null): boolean {
  const value = binding.isUrl ? undefined : savedSecretReference(state, draft, binding.fieldName);
  const secretId = binding.isUrl ? draft?.server.urlSecretId : value?.kind === 'secret' ? value.secretId : undefined;
  if (secretId) return draft?.server.secrets.find(item => item.secretId === secretId)?.state === 'set';

  const namedSecret = draft?.server.secrets.find(item => item.name === binding.secretName);
  if (!draft || !namedSecret || namedSecret.state !== 'set') return false;
  if (draft.server.urlSecretId === namedSecret.secretId) return false;

  const values = state.transport === 'stdio' ? draft.server.env : draft.server.headers;
  const ownedByOtherField = Object.entries(values ?? {}).some(([fieldName, fieldValue]) => {
    return fieldValue.kind === 'secret' && fieldValue.secretId === namedSecret.secretId && normalizeFieldName(state, fieldName) !== normalizeFieldName(state, binding.fieldName);
  });
  return !ownedByOtherField;
}

interface MissingSecretBinding {
  message: string;
  secretName: string;
}

function missingSecretBindingDetails(state: McpWizardState, draft: McpRegistryDraftView | null): MissingSecretBinding | null {
  const fieldType = state.transport === 'stdio' ? t('mcp.wizard.fieldTypeEnv') : t('mcp.wizard.fieldTypeHeader');
  const binding = secretBindings(state, draft).find(item => !isSecretSaved(item, state, draft));
  if (!binding) return null;
  if (binding.isUrl) {
    return { message: t('mcp.wizard.secretUrlMissing', { secret: binding.secretName }), secretName: binding.secretName };
  }
  return {
    message: t('mcp.wizard.secretFieldMissing', { type: fieldType, field: binding.fieldName, secret: binding.secretName }),
    secretName: binding.secretName,
  };
}

function missingSecretBinding(state: McpWizardState, draft: McpRegistryDraftView | null): string {
  return missingSecretBindingDetails(state, draft)?.message ?? '';
}

function secretBindingExists(state: McpWizardState): boolean {
  return secretBindings(state, null).length > 0;
}

interface McpWizardProps {
  initialDraft: McpRegistryDraftView | null;
  sessionId?: string;
  machines: McpMachineOption[];
  onDraftChange: (draft: McpRegistryDraftView) => void;
  onDone: (message?: string) => void;
  onClose: () => void;
}

export function McpWizard({ initialDraft, sessionId, machines, onDraftChange, onDone, onClose }: McpWizardProps) {
  const t = useT();
  const { state, patch, setSecretValue } = useMcpWizard(initialDraft);
  const [draft, setDraft] = useState(initialDraft);
  const [busy, setBusy] = useState(false);
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState('');
  const [errorDetails, setErrorDetails] = useState('');
  const [persistedServerId, setPersistedServerId] = useState('');
  const [oauthStatus, setOauthStatus] = useState<McpRegistryOAuthStatus | null>(null);
  const [oauthValidationState, setOauthValidationState] = useState<McpRegistryOAuthValidateResponse['state'] | null>(null);
  const [oauthLink, setOauthLink] = useState('');
  // A pre-registered client sends the browser to localhost: the user pastes that address back.
  const [oauthManualCallback, setOauthManualCallback] = useState(false);

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

  const clearError = () => {
    setError('');
    setErrorDetails('');
  };

  const reportError = (cause: unknown) => {
    const message = cause instanceof ApiError && cause.code === 'revision_conflict' ? mcpErrorText(cause).message : errorText(cause);
    setError(message);
    setErrorDetails('');
  };

  const refreshDraftAfterConflict = async (cause: unknown, currentDraft: McpRegistryDraftView | null) => {
    if (!(cause instanceof ApiError) || cause.code !== 'revision_conflict' || !currentDraft) return;
    try {
      const latest = await api.mcpRegistryDraft(currentDraft.draftId);
      setDraft(latest);
      onDraftChange(latest);
      if (latest.state === 'connected') onDone(t('mcp.wizard.draftConnected'));
      if (latest.state === 'saved-unchecked') onDone(t('mcp.wizard.draftSavedUnchecked'));
    } catch {
      // Keep the translated conflict message visible if the draft can no longer be read.
    }
  };

  const reportValidationError = (cause: unknown) => {
    const result = mcpErrorMessage(cause, state.transport);
    setError(result.message);
    setErrorDetails(result.details);
  };

  const next = () => {
    const conflict = secretBindingConflict(state, draft, true);
    if (conflict) {
      setError(conflict);
      return;
    }
    clearError();
    patch({ step: state.step + 1 });
  };

  const nextAfterParameters = () => {
    const conflict = secretBindingConflict(state, draft, false);
    if (conflict) {
      setError(conflict);
      return;
    }
    clearError();
    patch({ step: secretBindingExists(state) ? 2 : 3 });
  };

  const changeSecretValue = (key: string, value: string) => {
    setSecretValue(key, value);
  };

  const saveDraft = async () => {
    const bindingConflict = secretBindingConflict(state, draft, true);
    if (bindingConflict) {
      setError(bindingConflict);
      return;
    }
    setBusy(true);
    clearError();

    try {
      const unsavedBindings = secretBindings(state, draft).filter(binding => !isSecretSaved(binding, state, draft));
      const secrets = unsavedBindings.flatMap(binding => {
        const value = state.secretValues[binding.fieldName]?.trim();
        return value ? [{ name: binding.secretName, value: state.secretValues[binding.fieldName]! }] : [];
      });
      const server = serverCandidate(state, draft);
      let saved: McpRegistryDraftView;
      if (draft) {
        const { id: _id, ...update } = server;
        saved = await api.mcpRegistryUpdate(draft.draftId, {
          revision: draft.revision,
          server: update,
          secrets: secrets.length > 0 ? secrets : undefined,
        });
      } else {
        saved = await api.mcpRegistryCreate({
          server,
          secrets: secrets.length > 0 ? secrets : undefined,
          ...(sessionId ? { sessionId } : {}),
        });
      }
      setDraft(saved);
      onDraftChange(saved);
      patch({ secretValues: {}, step: 4 });
    } catch (cause) {
      reportError(cause);
      await refreshDraftAfterConflict(cause, draft);
    } finally {
      setBusy(false);
    }
  };

  const runValidation = async () => {
    if (!draft) return;
    if (missingSecretBinding(state, draft)) return;
    if (state.scope === 'machines' && !state.scopeMachineIds.includes(state.machineId)) {
      setError(t('mcp.wizard.machineOutOfScope'));
      return;
    }
    setBusy(true);
    setValidating(true);
    clearError();

    try {
      const validated = await api.mcpRegistryValidate(draft.draftId, {
        machineId: state.machineId,
        revision: draft.revision,
      });
      setDraft(validated);
      onDraftChange(validated);
    } catch (cause) {
      reportValidationError(cause);
      await refreshDraftAfterConflict(cause, draft);
    } finally {
      setValidating(false);
      setBusy(false);
    }
  };

  const connect = async () => {
    if (!draft || !window.confirm(t('mcp.wizard.confirmConnect'))) return;
    setBusy(true);
    clearError();

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
      reportError(cause);
      await refreshDraftAfterConflict(cause, draft);
    } finally {
      setBusy(false);
    }
  };

  const saveUnchecked = async () => {
    if (!draft) return;
    if (missingSecretBinding(state, draft)) return;
    if (!window.confirm(t('mcp.wizard.confirmSaveUnchecked'))) return;
    setBusy(true);
    clearError();

    try {
      await api.mcpRegistrySaveUnchecked(draft.draftId, { revision: draft.revision, userConfirmed: true });
      onDone();
    } catch (cause) {
      reportError(cause);
      await refreshDraftAfterConflict(cause, draft);
    } finally {
      setBusy(false);
    }
  };

  const saveSecret = async (key: string) => {
    const bindingConflict = secretBindingConflict(state, draft, true);
    if (bindingConflict) {
      setError(bindingConflict);
      setErrorDetails('');
      return;
    }
    const binding = secretBindings(state, draft).find(item => item.fieldName === key);
    const value = state.secretValues[key];
    if (!draft || !binding || !value) return;
    setBusy(true);
    clearError();

    try {
      const updated = await api.mcpRegistryUpdate(draft.draftId, {
        revision: draft.revision,
        server: {},
        secrets: [{ name: binding.secretName, value }],
      });
      setDraft(updated);
      onDraftChange(updated);
      setSecretValue(key, '');
    } catch (cause) {
      reportError(cause);
      await refreshDraftAfterConflict(cause, draft);
    } finally {
      setBusy(false);
    }
  };

  const startOAuth = async () => {
    if (!persistedServerId) return;
    const loginWindow = window.open('about:blank', '_blank');
    setBusy(true);
    clearError();
    setOauthLink('');

    try {
      const result = await api.mcpRegistryOAuthStart(persistedServerId, { machineId: state.machineId });
      setOauthManualCallback(result.callback === 'manual');
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
      reportError(cause);
    } finally {
      setBusy(false);
    }
  };

  const completeOAuth = async (callbackUrl: string): Promise<boolean> => {
    if (!persistedServerId || !callbackUrl.trim()) return false;
    setBusy(true);
    clearError();
    try {
      await api.mcpRegistryOAuthComplete(persistedServerId, { machineId: state.machineId, callbackUrl: callbackUrl.trim() });
      const status = await api.mcpRegistryStatus();
      const next = status.oauth?.find(item => item.serverId === persistedServerId && item.machineId === state.machineId);
      if (next) setOauthStatus(next);
      return true;
    } catch (cause) {
      reportError(cause);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const validateOAuthServer = async () => {
    if (!persistedServerId) return;
    setBusy(true);
    clearError();
    try {
      const result = await api.mcpRegistryOAuthValidate(persistedServerId, { machineId: state.machineId });
      setOauthValidationState(result.state);
      if (result.state === 'validation-failed') setError(t('mcp.list.oauth.checkFailed'));
      if (result.state === 'needs_auth') setError(t('mcp.list.oauth.stillNeedsLogin'));
      const status = await api.mcpRegistryStatus();
      const next = status.oauth?.find(item => item.serverId === persistedServerId && item.machineId === state.machineId);
      if (next) setOauthStatus(next);
    } catch (cause) {
      reportError(cause);
    } finally {
      setBusy(false);
    }
  };

  const connectOAuthServer = async () => {
    if (!persistedServerId || oauthValidationState !== 'checked') return;
    setBusy(true);
    clearError();
    try {
      await api.mcpRegistryOAuthConnect(persistedServerId, { machineId: state.machineId });
      onDone();
    } catch (cause) {
      reportError(cause);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mcp-wizard">
      <h3>{t('mcp.wizard.title', { step: wizardStepNumber(state), total: secretBindingExists(state) ? 5 : 4 })}</h3>
      {error && (
        <div className="mcp-error-message" role="alert">
          <p>{error}</p>
          {errorDetails && (
            <details>
              <summary>{t('mcp.form.details')}</summary>
              <pre>{errorDetails}</pre>
            </details>
          )}
        </div>
      )}
      <McpServerForm
        state={state}
        machines={machines}
        busy={busy}
        validating={validating}
        secretBindingError={missingSecretBinding(state, draft)}
        secretConflict={secretBindingConflict(state, draft, true)}
        hasSecretBindings={secretBindingExists(state)}
        secretFields={secretFields(state, null, false)}
        missingSecretFields={secretFields(state, draft, true)}
        draft={draft}
        onPatch={patch}
        onNext={state.step === 1 ? nextAfterParameters : next}
        onBack={() => patch({ step: 3 })}
        onSaveDraft={() => void saveDraft()}
        onValidate={() => void runValidation()}
        onConnect={() => void connect()}
        onSecretChange={changeSecretValue}
        onSaveSecret={key => void saveSecret(key)}
        onStartOAuth={() => void startOAuth()}
        persistedServerId={persistedServerId}
        oauthStatus={oauthStatus}
        oauthValidationState={oauthValidationState}
        oauthLink={oauthLink}
        oauthManualCallback={oauthManualCallback}
        onOAuthComplete={completeOAuth}
        onOAuthValidate={() => void validateOAuthServer()}
        onOAuthConnect={() => void connectOAuthServer()}
        onSaveUnchecked={() => void saveUnchecked()}
        onClose={onClose}
      />
    </section>
  );
}

function wizardStepNumber(state: McpWizardState): number {
  if (secretBindingExists(state) || state.step < 3) return Math.min(state.step + 1, 5);
  return state.step;
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    if ('serverMessage' in error && typeof error.serverMessage === 'string' && error.serverMessage) return error.serverMessage;
    return error.message || t('mcp.wizard.notDone');
  }
  if (typeof error === 'string') return error || t('mcp.wizard.notDone');
  return String(error) || t('mcp.wizard.notDone');
}
