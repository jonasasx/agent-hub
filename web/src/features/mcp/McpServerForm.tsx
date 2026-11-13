import { useState } from 'react';
import type { McpRegistryDraftView, McpRegistryOAuthStatus, McpRegistryOAuthValidateResponse } from '../../api/mcpRegistryTypes';
import type { McpWizardState } from './McpWizard';
import { McpSegment } from './McpSegment';
import { MCP_MODE_LABELS, mcpStatusLabel, mcpStatusTone } from './mcpLabels';
import { mcpErrorMessage, type McpTransport } from './mcpErrors';
import { useT } from '../../i18n';

export interface McpMachineOption {
  id: string;
  name: string;
  online: boolean;
}

export interface McpSecretField {
  key: string;
  name: string;
  value: string;
}

interface McpServerFormProps {
  state: McpWizardState;
  machines: McpMachineOption[];
  busy: boolean;
  validating: boolean;
  secretBindingError: string;
  secretConflict: string;
  hasSecretBindings: boolean;
  secretFields: McpSecretField[];
  missingSecretFields: McpSecretField[];
  draft: McpRegistryDraftView | null;
  onPatch: (patch: Partial<McpWizardState>) => void;
  onNext: () => void;
  onBack: () => void;
  onSaveDraft: () => void;
  onValidate: () => void;
  onConnect: () => void;
  onSecretChange: (key: string, value: string) => void;
  onSaveSecret: (key: string) => void;
  onStartOAuth: () => void;
  oauthRegistrationRejected: boolean;
  onSaveOAuthClientId: (clientId: string) => void;
  persistedServerId: string;
  oauthStatus: McpRegistryOAuthStatus | null;
  oauthValidationState: McpRegistryOAuthValidateResponse['state'] | null;
  oauthLink: string;
  oauthManualCallback: boolean;
  onOAuthComplete: (callbackUrl: string) => Promise<boolean>;
  onOAuthValidate: () => void;
  onOAuthConnect: () => void;
  onSaveUnchecked: () => void;
  onClose: () => void;
}

export function McpServerForm(props: McpServerFormProps) {
  switch (props.state.step) {
    case 0:
      return <TransportStep state={props.state} onPatch={props.onPatch} onNext={props.onNext} />;
    case 1:
      return <ParametersStep state={props.state} onPatch={props.onPatch} onBack={() => props.onPatch({ step: 0 })} onNext={props.onNext} />;
    case 2:
      return (
        <SecretStep
          state={props.state}
          secretFields={props.secretFields}
          onPatch={props.onPatch}
          onSecretChange={props.onSecretChange}
          onBack={() => props.onPatch({ step: 1 })}
          onNext={props.onNext}
        />
      );
    case 3:
      return (
        <ScopeStep
          state={props.state}
          machines={props.machines}
          busy={props.busy}
          onPatch={props.onPatch}
          onBack={() => props.onPatch({ step: props.hasSecretBindings ? 2 : 1 })}
          onSaveDraft={props.onSaveDraft}
        />
      );
    case 4:
      return <ValidationStep {...props} />;
    default:
      return null;
  }
}

function TransportStep({ state, onPatch, onNext }: Pick<McpServerFormProps, 'state' | 'onPatch' | 'onNext'>) {
  const t = useT();
  return (
    <>
      <McpSegment
        label={t('mcp.form.transport')}
        value={state.transport === 'sse' ? 'http' : state.transport}
        options={[
          { value: 'stdio', label: t('mcp.list.server.stdio'), description: t('mcp.form.stdioDesc') },
          { value: 'http', label: t('mcp.list.server.http'), description: t('mcp.form.httpDesc') },
        ]}
        onChange={transport =>
          onPatch({
            transport: transport as McpWizardState['transport'],
            ...(transport === 'stdio' && state.mode === 'remote' ? { mode: 'machine-shared' } : {}),
          })
        }
      />
      <button className="btn primary" onClick={onNext}>
        {t('mcp.form.next')}
      </button>
    </>
  );
}

function ParametersStep({ state, onPatch, onBack, onNext }: Pick<McpServerFormProps, 'state' | 'onPatch' | 'onBack' | 'onNext'>) {
  const t = useT();
  const canContinue = state.name.trim().length > 0 && (state.transport === 'stdio' ? state.command.trim().length > 0 : state.url.trim().length > 0);

  return (
    <>
      <label>
        {t('mcp.form.name')}
        <input className="input" value={state.name} onChange={event => onPatch({ name: event.target.value })} />
      </label>
      {state.transport === 'stdio' ? <StdioParameters state={state} onPatch={onPatch} /> : <HttpParameters state={state} onPatch={onPatch} />}
      <p className="mcp-field-hint">{t('mcp.form.noKeys')}</p>
      <div className="mcp-validation-actions">
        <button className="btn" onClick={onBack}>
          {t('mcp.form.back')}
        </button>
        <button className="btn primary" disabled={!canContinue} onClick={onNext}>
          {t('mcp.form.next')}
        </button>
      </div>
    </>
  );
}

function StdioParameters({ state, onPatch }: Pick<McpServerFormProps, 'state' | 'onPatch'>) {
  const t = useT();
  return (
    <>
      <label>
        {t('mcp.form.command')}
        <input className="input" value={state.command} onChange={event => onPatch({ command: event.target.value })} />
      </label>
      <label>
        {t('mcp.form.args')}
        <textarea className="input" value={state.argsText} onChange={event => onPatch({ argsText: event.target.value })} />
      </label>
      <label>
        {t('mcp.form.env')}
        <textarea className="input" value={state.envText} onChange={event => onPatch({ envText: event.target.value })} />
      </label>
      <p className="mcp-field-hint">{t('mcp.form.envHint')}</p>
    </>
  );
}

function HttpParameters({ state, onPatch }: Pick<McpServerFormProps, 'state' | 'onPatch'>) {
  const t = useT();
  return (
    <>
      <label>
        URL
        <input className="input" type="url" value={state.url} onChange={event => onPatch({ url: event.target.value })} />
      </label>
      <p className="mcp-field-hint">{t('mcp.form.urlHint')}</p>
      <label>
        {t('mcp.form.headers')}
        <textarea className="input" value={state.headersText} onChange={event => onPatch({ headersText: event.target.value })} />
      </label>
      <p className="mcp-field-hint">{t('mcp.form.headersHint')}</p>
      <label>
        {t('mcp.wizard.oauthClientId.label')}
        <input className="input" value={state.oauthClientId} onChange={event => onPatch({ oauthClientId: event.target.value })} />
      </label>
      <p className="mcp-field-hint">{t('mcp.wizard.oauthClientId.hint')}</p>
    </>
  );
}

function MachineSegment({ label, machines, value, onChange }: { label: string; machines: McpMachineOption[]; value: string; onChange: (value: string) => void }) {
  const t = useT();
  const options = machines.map(machine => ({
    value: machine.id,
    label: machine.name,
    description: machine.online ? t('mcp.list.import.online') : t('mcp.list.import.offline'),
    disabled: !machine.online,
  }));
  const hasSelectedMachine = machines.some(machine => machine.id === value);

  return (
    <>
      {!value && machines.length > 0 && <p className="mcp-field-hint">{t('mcp.form.pickMachine')}</p>}
      {machines.length === 0 && <p className="mcp-field-hint">{t('mcp.form.noMachines')}</p>}
      {value && !hasSelectedMachine && <p className="mcp-field-hint">{t('mcp.form.machineGone')}</p>}
      <McpSegment label={label} value={value} options={options} onChange={onChange} />
    </>
  );
}

function SecretStep({ state, secretFields, onPatch, onSecretChange, onBack, onNext }: Pick<McpServerFormProps, 'state' | 'secretFields' | 'onPatch' | 'onSecretChange' | 'onBack' | 'onNext'>) {
  const t = useT();
  const suggestedName = suggestedSecretName(state);
  const currentName = state.secretNameTouched ? state.secretName : suggestedName;
  const hasNamedFieldBinding = secretFields.some(field => field.key !== 'URL');
  return (
    <>
      <label>
        {t('mcp.form.secretName')}
        <input className="input" value={currentName} disabled={!hasNamedFieldBinding} onChange={event => onPatch({ secretName: event.target.value, secretNameTouched: true })} />
      </label>
      <p className="mcp-field-hint">{t('mcp.form.secretNameHint')}</p>
      {secretFields.map(field => (
        <label key={field.key}>
          {t('mcp.form.secretValue', { name: field.name })}
          <input className="input" type="password" autoComplete="new-password" value={field.value} onChange={event => onSecretChange(field.key, event.target.value)} />
        </label>
      ))}
      <p className="mcp-field-hint">{t('mcp.form.secretBound')}</p>
      <p className="mcp-field-hint">{t('mcp.form.secretOnce')}</p>
      <div className="mcp-validation-actions">
        <button className="btn" onClick={onBack}>
          {t('mcp.form.back')}
        </button>
        <button className="btn primary" onClick={onNext}>
          {t('mcp.form.next')}
        </button>
      </div>
    </>
  );
}

function machinesInScope(state: McpWizardState, machines: McpMachineOption[]): McpMachineOption[] {
  if (state.scope === 'all') return machines;
  return machines.filter(machine => state.scopeMachineIds.includes(machine.id));
}

function ScopeStep({ state, machines, busy, onPatch, onBack, onSaveDraft }: Pick<McpServerFormProps, 'state' | 'machines' | 'busy' | 'onPatch' | 'onBack' | 'onSaveDraft'>) {
  const t = useT();
  const toggleMachine = (machineId: string) => {
    const selected = state.scopeMachineIds.includes(machineId);
    const machineIds = selected ? state.scopeMachineIds.filter(id => id !== machineId) : [...state.scopeMachineIds, machineId];
    onPatch({ scopeMachineIds: machineIds, ...(selected && state.machineId === machineId ? { machineId: '' } : {}) });
  };

  const hasScope = state.scope === 'all' || state.scopeMachineIds.length > 0;
  const checkMachines = machinesInScope(state, machines);
  const canCheckMachine = checkMachines.some(machine => machine.id === state.machineId && machine.online);
  const modeOptions =
    state.transport === 'stdio'
      ? [
          { value: 'machine-shared', label: MCP_MODE_LABELS['machine-shared'], description: t('mcp.list.editor.modeShared') },
          { value: 'per-session', label: MCP_MODE_LABELS['per-session'], description: t('mcp.list.editor.modePerSession') },
        ]
      : [
          { value: 'remote', label: MCP_MODE_LABELS.remote, description: t('mcp.list.editor.modeRemote') },
          { value: 'machine-shared', label: MCP_MODE_LABELS['machine-shared'], description: t('mcp.list.editor.modeShared') },
          { value: 'per-session', label: MCP_MODE_LABELS['per-session'], description: t('mcp.list.editor.modePerSession') },
        ];

  return (
    <>
      <McpSegment label={t('mcp.form.mode')} value={state.mode} options={modeOptions} onChange={mode => onPatch({ mode: mode as McpWizardState['mode'] })} />
      <McpSegment
        label={t('mcp.form.scope')}
        value={state.scope}
        options={[
          { value: 'all', label: t('mcp.list.editor.allMachines'), description: t('mcp.form.scopeAllDesc') },
          { value: 'machines', label: t('mcp.form.scopeSelected'), description: t('mcp.form.scopeSelectedDesc') },
        ]}
        onChange={scope => onPatch({ scope: scope as McpWizardState['scope'], ...(scope === 'machines' && !state.scopeMachineIds.includes(state.machineId) ? { machineId: '' } : {}) })}
      />
      {state.scope === 'machines' && (
        <fieldset>
          <legend>{t('mcp.list.editor.allowed')}</legend>
          {machines.map(machine => (
            <label key={machine.id}>
              <input className="mcp-checkbox" type="checkbox" checked={state.scopeMachineIds.includes(machine.id)} onChange={() => toggleMachine(machine.id)} />
              {machine.name} {!machine.online && <small>{t('mcp.list.editor.offline')}</small>}
            </label>
          ))}
        </fieldset>
      )}
      <MachineSegment label={t('mcp.form.checkMachine')} machines={checkMachines} value={state.machineId} onChange={machineId => onPatch({ machineId })} />
      <div className="mcp-validation-actions">
        <button className="btn" onClick={onBack}>
          {t('mcp.form.back')}
        </button>
        <button className="btn primary" disabled={busy || !canCheckMachine || !hasScope} onClick={onSaveDraft}>
          {t('mcp.form.saveDraft')}
        </button>
      </div>
      {!hasScope && <p className="mcp-field-hint">{t('mcp.form.noScope')}</p>}
    </>
  );
}

function ValidationStep({
  state,
  machines,
  busy,
  validating,
  secretBindingError,
  secretConflict,
  missingSecretFields,
  draft,
  onPatch,
  onBack,
  onValidate,
  onConnect,
  onSecretChange,
  onSaveSecret,
  onStartOAuth,
  oauthRegistrationRejected,
  onSaveOAuthClientId,
  persistedServerId,
  oauthStatus,
  oauthValidationState,
  oauthLink,
  oauthManualCallback,
  onOAuthComplete,
  onOAuthValidate,
  onOAuthConnect,
  onSaveUnchecked,
  onClose,
}: Omit<McpServerFormProps, 'onNext' | 'onSaveDraft'>) {
  const t = useT();
  const checkMachines = machinesInScope(state, machines);
  const canCheckMachine = checkMachines.some(machine => machine.id === state.machineId && machine.online);

  return (
    <>
      <p>{t('mcp.form.validationTitle')}</p>
      <ValidationTarget state={state} />
      {secretBindingError && missingSecretFields.length > 0 && (
        <NeedsSecretStep fields={missingSecretFields} message={secretBindingError} conflict={secretConflict} onChange={onSecretChange} onSave={onSaveSecret} />
      )}
      <MachineSegment label={t('mcp.form.machine')} machines={checkMachines} value={state.machineId} onChange={machineId => onPatch({ machineId })} />
      {draft?.validation?.ok && <ToolList draft={draft} />}
      {draft?.state === 'needs_auth' && !persistedServerId && <p role="status">{t('mcp.form.needsAuthSave')}</p>}
      {draft?.validation?.error && draft.state !== 'needs_auth' && <DraftValidationError draft={draft} transport={state.transport} />}
      {draft?.state === 'needs-secret' && missingSecretFields.length > 0 && !secretBindingError && (
        <NeedsSecretStep fields={missingSecretFields} conflict={secretConflict} onChange={onSecretChange} onSave={onSaveSecret} />
      )}
      {draft?.state === 'needs-secret' && missingSecretFields.length === 0 && (
        <div className="mcp-note" role="status">
          <p>{t('mcp.form.hubNoBinding')}</p>
          <button className="btn" disabled={busy || !canCheckMachine} onClick={onValidate}>
            {t('mcp.form.checkAgain')}
          </button>
        </div>
      )}
      {persistedServerId && (
        <OAuthStep
          busy={busy}
          machineId={state.machineId}
          status={oauthStatus}
          validationState={oauthValidationState}
          link={oauthLink}
          manualCallback={oauthManualCallback}
          registrationRejected={oauthRegistrationRejected}
          initialClientId={state.oauthClientId}
          onSaveClientId={onSaveOAuthClientId}
          onComplete={onOAuthComplete}
          onStart={onStartOAuth}
          onValidate={onOAuthValidate}
          onConnect={onOAuthConnect}
        />
      )}
      <div className="mcp-validation-footer">
        {!persistedServerId && (
          <button className="btn" disabled={busy} onClick={onBack}>
            {t('mcp.form.back')}
          </button>
        )}
        <div className="mcp-validation-actions">
          {!persistedServerId && (
            <button className="btn" disabled={busy || !canCheckMachine || Boolean(secretBindingError)} onClick={onValidate}>
              {validating ? t('mcp.form.checking') : t('mcp.form.check')}
            </button>
          )}
          {!persistedServerId && (
            <button className="btn primary" disabled={(!draft?.validation?.ok && draft?.state !== 'needs_auth') || busy} onClick={onConnect}>
              {draft?.state === 'needs_auth' ? t('mcp.form.saveAndLogin') : t('mcp.form.connect')}
            </button>
          )}
          {!persistedServerId && (
            <button className="btn ghost" disabled={busy || Boolean(secretBindingError)} onClick={onSaveUnchecked}>
              {t('mcp.form.saveUnchecked')}
            </button>
          )}
          <button className="btn" onClick={onClose}>
            {t('mcp.form.close')}
          </button>
        </div>
      </div>
    </>
  );
}

function suggestedSecretName(state: McpWizardState): string {
  const text = state.transport === 'stdio' ? state.envText : state.headersText;
  for (const line of text.split('\n')) {
    const separator = line.indexOf('=');
    if (separator > 0 && line.slice(separator + 1).trim() === '@secret') {
      return line.slice(0, separator).trim();
    }
  }

  return 'token';
}

function ValidationTarget({ state }: { state: McpWizardState }) {
  const t = useT();
  if (state.transport === 'stdio') {
    const args = state.argsText
      .split('\n')
      .map(argument => argument.trim())
      .filter(Boolean);

    return (
      <div className="mcp-validation-target" role="note">
        <strong>{t('mcp.form.targetCommand')}</strong>
        <code>{maskStdioArguments(state.command, args)}</code>
      </div>
    );
  }

  return (
    <div className="mcp-validation-target" role="note">
      <strong>{t('mcp.form.targetUrl')}</strong>
      <code>{safeTargetUrl(state.url, Object.values(state.secretValues))}</code>
    </div>
  );
}

function maskStdioArguments(command: string, args: string[]): string {
  const sensitiveName = /(?:token|api[-_]?key|secret|password|credential|authorization|cookie)/i;
  const tokenLike = /\b(?:[a-f0-9]{32,}|[A-Za-z0-9+/_-]{40,}={0,2})\b/gi;
  const safeArguments: string[] = [];
  let maskNext = false;

  for (const argument of [command, ...args].filter(Boolean)) {
    if (maskNext) {
      safeArguments.push('••••');
      maskNext = false;
      continue;
    }

    const separator = argument.indexOf('=');
    if (separator > 0 && sensitiveName.test(argument.slice(0, separator))) {
      safeArguments.push(`${argument.slice(0, separator)}=••••`);
      continue;
    }

    if (sensitiveName.test(argument) && /^--?[\w-]+$/.test(argument)) {
      safeArguments.push(argument);
      maskNext = true;
      continue;
    }

    const safeArgument = argument.replace(/\bBearer\s+\S+/gi, 'Bearer ••••').replace(tokenLike, '••••');
    safeArguments.push(safeArgument);
  }

  return safeArguments.join(' ');
}

function safeTargetUrl(value: string, secretValues: string[]): string {
  let safeValue = value;
  for (const secretValue of secretValues) {
    if (secretValue) safeValue = safeValue.replaceAll(secretValue, '[secret]');
  }
  try {
    const url = new URL(safeValue);
    if (url.username) url.username = '[secret]';
    if (url.password) url.password = '[secret]';
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:token|api[-_]?key|secret|password|credential|authorization|cookie)/i.test(key)) {
        url.searchParams.set(key, '[secret]');
      }
    }
    safeValue = url.toString();
  } catch {
    // Keep malformed URLs visible so the user can correct them before validation.
  }
  return safeValue;
}

function ToolList({ draft }: { draft: McpRegistryDraftView }) {
  const t = useT();
  const tools = draft.validation?.tools ?? [];
  return (
    <>
      <p className="mcp-validation-success" role="status">
        <span className="pill mcp-status-pill ok">{t('mcp.form.validationOk')}</span> · {t('mcp.form.toolsCount', { count: tools.length })}
      </p>
      <details className="mcp-tool-list">
        <summary>{t('mcp.form.toolsList')}</summary>
        <ul>
          {tools.map(tool => (
            <li key={tool.name}>
              {tool.name}
              {tool.description ? ` — ${tool.description}` : ''}
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}

function DraftValidationError({ draft, transport }: { draft: McpRegistryDraftView; transport: McpTransport }) {
  const t = useT();
  const failure = mcpErrorMessage(draft.validation?.error ?? 'MCP validation failed', transport);
  return (
    <div className="mcp-error-message" role="alert">
      <p>{failure.message}</p>
      {failure.details && failure.details !== failure.message && (
        <details>
          <summary>{t('mcp.form.details')}</summary>
          <pre>{failure.details}</pre>
        </details>
      )}
    </div>
  );
}

function NeedsSecretStep({
  fields,
  message,
  conflict,
  onChange,
  onSave,
}: {
  fields: McpSecretField[];
  message?: string;
  conflict: string;
  onChange: (key: string, value: string) => void;
  onSave: (key: string) => void;
}) {
  const t = useT();
  return (
    <>
      <p className="mcp-inline-field-error" role="alert">
        {conflict || message || t('mcp.form.needsSecret')}
      </p>
      {fields.map(field => (
        <div className="mcp-secret-input" key={field.key}>
          <label>
            {t('mcp.form.secretValue', { name: field.name })}
            <input className="input" type="password" autoComplete="new-password" value={field.value} onChange={event => onChange(field.key, event.target.value)} />
          </label>
          <button className="btn" disabled={!field.value.trim() || Boolean(conflict)} onClick={() => onSave(field.key)}>
            {t('mcp.form.saveSecret')}
          </button>
        </div>
      ))}
    </>
  );
}

function OAuthStep({
  busy,
  machineId,
  status,
  validationState,
  link,
  manualCallback,
  registrationRejected,
  initialClientId,
  onSaveClientId,
  onComplete,
  onStart,
  onValidate,
  onConnect,
}: {
  busy: boolean;
  machineId: string;
  status: McpRegistryOAuthStatus | null;
  validationState: McpRegistryOAuthValidateResponse['state'] | null;
  link: string;
  manualCallback: boolean;
  registrationRejected: boolean;
  initialClientId: string;
  onSaveClientId: (clientId: string) => void;
  onComplete: (callbackUrl: string) => Promise<boolean>;
  onStart: () => void;
  onValidate: () => void;
  onConnect: () => void;
}) {
  const t = useT();
  const [pastedUrl, setPastedUrl] = useState('');
  const [clientId, setClientId] = useState(initialClientId);
  const signedIn = status?.state === 'signed-in';
  const showPaste = manualCallback && status?.state === 'pending';
  const complete = async () => {
    if (busy || !pastedUrl.trim()) return;
    if (await onComplete(pastedUrl)) setPastedUrl('');
  };

  return (
    <section className="mcp-oauth" aria-label="OAuth">
      <p role="status">
        <span className={`pill mcp-status-pill ${mcpStatusTone(status?.state ?? 'needs-login')}`}>{oauthStatusLabel(status?.state ?? 'needs-login')}</span>
      </p>
      {status?.error && <small role="alert">{status.error}</small>}
      {!signedIn && registrationRejected && (
        <>
          <label>
            {t('mcp.wizard.oauthClientId.label')}
            <input className="input" value={clientId} disabled={busy} onChange={event => setClientId(event.target.value)} />
          </label>
          <small role="note">{t('mcp.wizard.oauthClientId.hint')}</small>
          <button className="btn primary" disabled={!machineId || busy || !clientId.trim()} onClick={() => onSaveClientId(clientId.trim())}>
            {t('mcp.wizard.oauthClientId.retry')}
          </button>
        </>
      )}
      {!signedIn && !registrationRejected && (
        <button className="btn" disabled={!machineId || busy} onClick={onStart}>
          {t('mcp.list.oauth.signIn')}
        </button>
      )}
      {showPaste && (
        <>
          <small role="note">{t('mcp.list.oauth.manual.hint')}</small>
          <label>
            {t('mcp.list.oauth.manual.label')}
            <input
              className="input"
              value={pastedUrl}
              placeholder="http://localhost:45129/callback?code=…"
              disabled={busy}
              onChange={event => setPastedUrl(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') void complete();
              }}
            />
          </label>
          <button className="btn primary" disabled={busy || !pastedUrl.trim()} onClick={() => void complete()}>
            {t('mcp.list.oauth.manual.complete')}
          </button>
        </>
      )}
      {signedIn && validationState !== 'checked' && (
        <button className="btn" disabled={busy || !machineId} onClick={onValidate}>
          {t('mcp.form.checkAfterLogin')}
        </button>
      )}
      {signedIn && validationState === 'checked' && (
        <button className="btn primary" disabled={busy || !machineId} onClick={onConnect}>
          {t('mcp.form.connect')}
        </button>
      )}
      {link && !busy && (
        <a className="btn" href={link} target="_blank" rel="noreferrer">
          {t('mcp.list.oauth.openLogin')}
        </a>
      )}
    </section>
  );
}

function oauthStatusLabel(state: McpRegistryOAuthStatus['state']): string {
  return mcpStatusLabel(state);
}
