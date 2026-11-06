import type { McpRegistryDraftView, McpRegistryOAuthStatus, McpRegistryOAuthValidateResponse } from '../../api/mcpRegistryTypes';
import type { McpWizardState } from './McpWizard';
import { McpSegment } from './McpSegment';
import { MCP_MODE_LABELS, mcpStatusLabel, mcpStatusTone } from './mcpLabels';
import { mcpErrorMessage, type McpTransport } from './mcpErrors';

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
  persistedServerId: string;
  oauthStatus: McpRegistryOAuthStatus | null;
  oauthValidationState: McpRegistryOAuthValidateResponse['state'] | null;
  oauthLink: string;
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
  return (
    <>
      <McpSegment
        label="Транспорт"
        value={state.transport === 'sse' ? 'http' : state.transport}
        options={[
          { value: 'stdio', label: 'Команда (stdio)', description: 'npx, uvx, локальный процесс' },
          { value: 'http', label: 'Удалённый HTTP', description: 'URL сервера' },
        ]}
        onChange={transport =>
          onPatch({
            transport: transport as McpWizardState['transport'],
            ...(transport === 'stdio' && state.mode === 'remote' ? { mode: 'machine-shared' } : {}),
          })
        }
      />
      <button className="btn primary" onClick={onNext}>
        Далее
      </button>
    </>
  );
}

function ParametersStep({ state, onPatch, onBack, onNext }: Pick<McpServerFormProps, 'state' | 'onPatch' | 'onBack' | 'onNext'>) {
  const canContinue = state.name.trim().length > 0 && (state.transport === 'stdio' ? state.command.trim().length > 0 : state.url.trim().length > 0);

  return (
    <>
      <label>
        Имя
        <input className="input" value={state.name} onChange={event => onPatch({ name: event.target.value })} />
      </label>
      {state.transport === 'stdio' ? <StdioParameters state={state} onPatch={onPatch} /> : <HttpParameters state={state} onPatch={onPatch} />}
      <p className="mcp-field-hint">Не вводите ключи и пароли в обычные параметры. Для них используйте следующий шаг секретов.</p>
      <div className="mcp-validation-actions">
        <button className="btn" onClick={onBack}>
          Назад
        </button>
        <button className="btn primary" disabled={!canContinue} onClick={onNext}>
          Далее
        </button>
      </div>
    </>
  );
}

function StdioParameters({ state, onPatch }: Pick<McpServerFormProps, 'state' | 'onPatch'>) {
  return (
    <>
      <label>
        Команда
        <input className="input" value={state.command} onChange={event => onPatch({ command: event.target.value })} />
      </label>
      <label>
        Аргументы, по одному в строке
        <textarea className="input" value={state.argsText} onChange={event => onPatch({ argsText: event.target.value })} />
      </label>
      <label>
        Переменные среды, по одной в строке ИМЯ=значение
        <textarea className="input" value={state.envText} onChange={event => onPatch({ envText: event.target.value })} />
      </label>
      <p className="mcp-field-hint">Чтобы связать переменную с секретом из следующего шага, укажите ИМЯ=@secret.</p>
    </>
  );
}

function HttpParameters({ state, onPatch }: Pick<McpServerFormProps, 'state' | 'onPatch'>) {
  return (
    <>
      <label>
        URL
        <input className="input" type="url" value={state.url} onChange={event => onPatch({ url: event.target.value })} />
      </label>
      <p className="mcp-field-hint">Для секрета в URL используйте __AGENT_HUB_SECRET__; он будет подставлен из секрета на следующем шаге.</p>
      <label>
        Заголовки, по одному в строке ИМЯ=значение
        <textarea className="input" value={state.headersText} onChange={event => onPatch({ headersText: event.target.value })} />
      </label>
      <p className="mcp-field-hint">Чтобы связать заголовок с секретом из следующего шага, укажите ИМЯ=@secret.</p>
    </>
  );
}

function MachineSegment({ label, machines, value, onChange }: { label: string; machines: McpMachineOption[]; value: string; onChange: (value: string) => void }) {
  const options = machines.map(machine => ({
    value: machine.id,
    label: machine.name,
    description: machine.online ? 'В сети' : 'Не в сети',
    disabled: !machine.online,
  }));
  const hasSelectedMachine = machines.some(machine => machine.id === value);

  return (
    <>
      {!value && machines.length > 0 && <p className="mcp-field-hint">Выберите машину для проверки среди вариантов ниже.</p>}
      {machines.length === 0 && <p className="mcp-field-hint">Нет машин в выбранной области. Вернитесь назад и выберите машины.</p>}
      {value && !hasSelectedMachine && <p className="mcp-field-hint">Машина выпала из области. Выберите другую.</p>}
      <McpSegment label={label} value={value} options={options} onChange={onChange} />
    </>
  );
}

function SecretStep({ state, secretFields, onPatch, onSecretChange, onBack, onNext }: Pick<McpServerFormProps, 'state' | 'secretFields' | 'onPatch' | 'onSecretChange' | 'onBack' | 'onNext'>) {
  const suggestedName = suggestedSecretName(state);
  const currentName = state.secretNameTouched ? state.secretName : suggestedName;
  const hasNamedFieldBinding = secretFields.some(field => field.key !== 'URL');
  return (
    <>
      <label>
        Имя секрета (необязательно)
        <input className="input" value={currentName} disabled={!hasNamedFieldBinding} onChange={event => onPatch({ secretName: event.target.value, secretNameTouched: true })} />
      </label>
      <p className="mcp-field-hint">По умолчанию используется имя переменной или заголовка; его можно изменить.</p>
      {secretFields.map(field => (
        <label key={field.key}>
          Значение секрета «{field.name}»
          <input className="input" type="password" autoComplete="new-password" value={field.value} onChange={event => onSecretChange(field.key, event.target.value)} />
        </label>
      ))}
      <p className="mcp-field-hint">Привязанные переменные и заголовки используют имя секрета. В URL подставляется __AGENT_HUB_SECRET__.</p>
      <p className="mcp-field-hint">После сохранения значение секрета больше не показывается.</p>
      <div className="mcp-validation-actions">
        <button className="btn" onClick={onBack}>
          Назад
        </button>
        <button className="btn primary" onClick={onNext}>
          Далее
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
          { value: 'machine-shared', label: MCP_MODE_LABELS['machine-shared'], description: 'Один процесс для машины' },
          { value: 'per-session', label: MCP_MODE_LABELS['per-session'], description: 'Отдельный процесс для сессии' },
        ]
      : [
          { value: 'remote', label: MCP_MODE_LABELS.remote, description: 'Подключение к удалённому серверу' },
          { value: 'machine-shared', label: MCP_MODE_LABELS['machine-shared'], description: 'Один процесс для машины' },
          { value: 'per-session', label: MCP_MODE_LABELS['per-session'], description: 'Отдельный процесс для сессии' },
        ];

  return (
    <>
      <McpSegment label="Режим" value={state.mode} options={modeOptions} onChange={mode => onPatch({ mode: mode as McpWizardState['mode'] })} />
      <McpSegment
        label="Область"
        value={state.scope}
        options={[
          { value: 'all', label: 'Все машины', description: 'Доступен на каждой машине' },
          { value: 'machines', label: 'Выбранные машины', description: 'Только отмеченные машины' },
        ]}
        onChange={scope => onPatch({ scope: scope as McpWizardState['scope'], ...(scope === 'machines' && !state.scopeMachineIds.includes(state.machineId) ? { machineId: '' } : {}) })}
      />
      {state.scope === 'machines' && (
        <fieldset>
          <legend>Разрешённые машины</legend>
          {machines.map(machine => (
            <label key={machine.id}>
              <input className="mcp-checkbox" type="checkbox" checked={state.scopeMachineIds.includes(machine.id)} onChange={() => toggleMachine(machine.id)} />
              {machine.name} {!machine.online && <small>Не в сети</small>}
            </label>
          ))}
        </fieldset>
      )}
      <MachineSegment label="Машина для проверки" machines={checkMachines} value={state.machineId} onChange={machineId => onPatch({ machineId })} />
      <div className="mcp-validation-actions">
        <button className="btn" onClick={onBack}>
          Назад
        </button>
        <button className="btn primary" disabled={busy || !canCheckMachine || !hasScope} onClick={onSaveDraft}>
          Сохранить черновик и проверить
        </button>
      </div>
      {!hasScope && <p className="mcp-field-hint">Отметьте хотя бы одну машину в области.</p>}
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
  persistedServerId,
  oauthStatus,
  oauthValidationState,
  oauthLink,
  onOAuthValidate,
  onOAuthConnect,
  onSaveUnchecked,
  onClose,
}: Omit<McpServerFormProps, 'onNext' | 'onSaveDraft'>) {
  const checkMachines = machinesInScope(state, machines);
  const canCheckMachine = checkMachines.some(machine => machine.id === state.machineId && machine.online);

  return (
    <>
      <p>Проверка сервера на выбранной машине</p>
      <ValidationTarget state={state} />
      {secretBindingError && missingSecretFields.length > 0 && (
        <NeedsSecretStep fields={missingSecretFields} message={secretBindingError} conflict={secretConflict} onChange={onSecretChange} onSave={onSaveSecret} />
      )}
      <MachineSegment label="Машина" machines={checkMachines} value={state.machineId} onChange={machineId => onPatch({ machineId })} />
      {draft?.validation?.ok && <ToolList draft={draft} />}
      {draft?.state === 'needs_auth' && !persistedServerId && <p role="status">Сервер требует входа. Сохраните его, чтобы начать OAuth.</p>}
      {draft?.validation?.error && draft.state !== 'needs_auth' && <DraftValidationError draft={draft} transport={state.transport} />}
      {draft?.state === 'needs-secret' && missingSecretFields.length > 0 && !secretBindingError && (
        <NeedsSecretStep fields={missingSecretFields} conflict={secretConflict} onChange={onSecretChange} onSave={onSaveSecret} />
      )}
      {draft?.state === 'needs-secret' && missingSecretFields.length === 0 && (
        <div className="mcp-note" role="status">
          <p>Хаб сообщает, что серверу нужен секрет, но привязка не найдена в текущей конфигурации. Проверьте имена секретов или сохраните сервер заново.</p>
          <button className="btn" disabled={busy || !canCheckMachine} onClick={onValidate}>
            Проверить снова
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
          onStart={onStartOAuth}
          onValidate={onOAuthValidate}
          onConnect={onOAuthConnect}
        />
      )}
      <div className="mcp-validation-footer">
        {!persistedServerId && (
          <button className="btn" disabled={busy} onClick={onBack}>
            Назад
          </button>
        )}
        <div className="mcp-validation-actions">
          {!persistedServerId && (
            <button className="btn" disabled={busy || !canCheckMachine || Boolean(secretBindingError)} onClick={onValidate}>
              {validating ? 'Проверяю…' : 'Проверить'}
            </button>
          )}
          {!persistedServerId && (
            <button className="btn primary" disabled={(!draft?.validation?.ok && draft?.state !== 'needs_auth') || busy} onClick={onConnect}>
              {draft?.state === 'needs_auth' ? 'Сохранить и перейти ко входу' : 'Подключить'}
            </button>
          )}
          {!persistedServerId && (
            <button className="btn ghost" disabled={busy || Boolean(secretBindingError)} onClick={onSaveUnchecked}>
              Сохранить без проверки…
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Закрыть
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
  if (state.transport === 'stdio') {
    const args = state.argsText
      .split('\n')
      .map(argument => argument.trim())
      .filter(Boolean);

    return (
      <div className="mcp-validation-target" role="note">
        <strong>Команда для запуска на машине</strong>
        <code>{maskStdioArguments(state.command, args)}</code>
      </div>
    );
  }

  return (
    <div className="mcp-validation-target" role="note">
      <strong>URL для подключения с машины</strong>
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
  const tools = draft.validation?.tools ?? [];
  return (
    <>
      <p className="mcp-validation-success" role="status">
        <span className="pill mcp-status-pill ok">Проверка успешна</span> · {tools.length} инструментов
      </p>
      <details className="mcp-tool-list">
        <summary>Список инструментов</summary>
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
  const failure = mcpErrorMessage(draft.validation?.error ?? 'MCP validation failed', transport);
  return (
    <div className="mcp-error-message" role="alert">
      <p>{failure.message}</p>
      {failure.details && failure.details !== failure.message && (
        <details>
          <summary>Подробности</summary>
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
  return (
    <>
      <p className="mcp-inline-field-error" role="alert">
        {conflict || message || 'Нужен секрет для запуска сервера.'}
      </p>
      {fields.map(field => (
        <div className="mcp-secret-input" key={field.key}>
          <label>
            Значение секрета «{field.name}»
            <input className="input" type="password" autoComplete="new-password" value={field.value} onChange={event => onChange(field.key, event.target.value)} />
          </label>
          <button className="btn" disabled={!field.value.trim() || Boolean(conflict)} onClick={() => onSave(field.key)}>
            Сохранить секрет
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
  onStart,
  onValidate,
  onConnect,
}: {
  busy: boolean;
  machineId: string;
  status: McpRegistryOAuthStatus | null;
  validationState: McpRegistryOAuthValidateResponse['state'] | null;
  link: string;
  onStart: () => void;
  onValidate: () => void;
  onConnect: () => void;
}) {
  const signedIn = status?.state === 'signed-in';

  return (
    <section className="mcp-oauth" aria-label="OAuth">
      <p role="status">
        <span className={`pill mcp-status-pill ${mcpStatusTone(status?.state ?? 'needs-login')}`}>{oauthStatusLabel(status?.state ?? 'needs-login')}</span>
      </p>
      {status?.error && <small role="alert">{status.error}</small>}
      {!signedIn && (
        <button className="btn" disabled={!machineId || busy || status?.state === 'pending'} onClick={onStart}>
          Войти
        </button>
      )}
      {signedIn && validationState !== 'checked' && (
        <button className="btn" disabled={busy || !machineId} onClick={onValidate}>
          Проверить после входа
        </button>
      )}
      {signedIn && validationState === 'checked' && (
        <button className="btn primary" disabled={busy || !machineId} onClick={onConnect}>
          Подключить
        </button>
      )}
      {link && !busy && (
        <a className="btn" href={link} target="_blank" rel="noreferrer">
          Открыть страницу входа
        </a>
      )}
    </section>
  );
}

function oauthStatusLabel(state: McpRegistryOAuthStatus['state']): string {
  return mcpStatusLabel(state);
}
