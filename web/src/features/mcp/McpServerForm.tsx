import type { McpRegistryDraftView, McpRegistryOAuthStatus, McpRegistryOAuthValidateResponse } from '../../api/mcpRegistryTypes';
import type { McpWizardState } from './McpWizard';

export interface McpMachineOption {
  id: string;
  name: string;
}

interface McpServerFormProps {
  state: McpWizardState;
  machines: McpMachineOption[];
  busy: boolean;
  error: string;
  secretBindingError: string;
  draft: McpRegistryDraftView | null;
  onPatch: (patch: Partial<McpWizardState>) => void;
  onNext: () => void;
  onSaveDraft: () => void;
  onValidate: () => void;
  onConnect: () => void;
  onSaveSecret: () => void;
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
      return <ParametersStep state={props.state} onPatch={props.onPatch} onNext={props.onNext} />;
    case 2:
      return <SecretStep state={props.state} onPatch={props.onPatch} onNext={props.onNext} />;
    case 3:
      return <ScopeStep state={props.state} machines={props.machines} busy={props.busy} onPatch={props.onPatch} onSaveDraft={props.onSaveDraft} />;
    case 4:
      return <ValidationStep {...props} />;
    default:
      return null;
  }
}

function TransportStep({ state, onPatch, onNext }: Pick<McpServerFormProps, 'state' | 'onPatch' | 'onNext'>) {
  return (
    <>
      <label>
        Транспорт
        <select className="input" value={state.transport} onChange={event => onPatch({ transport: event.target.value as McpWizardState['transport'] })}>
          <option value="stdio">Команда (stdio)</option>
          <option value="http">Удалённый HTTP</option>
        </select>
      </label>
      <button className="btn primary" onClick={onNext}>
        Далее
      </button>
    </>
  );
}

function ParametersStep({ state, onPatch, onNext }: Pick<McpServerFormProps, 'state' | 'onPatch' | 'onNext'>) {
  const canContinue = state.name.trim().length > 0 && (state.transport === 'stdio' ? state.command.trim().length > 0 : state.url.trim().length > 0);

  return (
    <>
      <label>
        Имя
        <input className="input" value={state.name} onChange={event => onPatch({ name: event.target.value })} />
      </label>
      {state.transport === 'stdio' ? <StdioParameters state={state} onPatch={onPatch} /> : <HttpParameters state={state} onPatch={onPatch} />}
      <p>Не вводите ключи и пароли в обычные параметры. Для них используйте следующий шаг секретов.</p>
      <button className="btn primary" disabled={!canContinue} onClick={onNext}>
        Далее
      </button>
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
      <p>Чтобы связать переменную с секретом из следующего шага, укажите ИМЯ=@secret.</p>
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
      <p>Для секрета в URL используйте __AGENT_HUB_SECRET__; он будет подставлен из секрета на следующем шаге.</p>
      <label>
        Заголовки, по одному в строке ИМЯ=значение
        <textarea className="input" value={state.headersText} onChange={event => onPatch({ headersText: event.target.value })} />
      </label>
      <p>Чтобы связать заголовок с секретом из следующего шага, укажите ИМЯ=@secret.</p>
    </>
  );
}

function SecretStep({ state, onPatch, onNext }: Pick<McpServerFormProps, 'state' | 'onPatch' | 'onNext'>) {
  return (
    <>
      <label>
        Имя секрета (необязательно)
        <input className="input" value={state.secretName} onChange={event => onPatch({ secretName: event.target.value })} />
      </label>
      <label>
        Значение секрета
        <input className="input" type="password" autoComplete="new-password" value={state.secretValue} onChange={event => onPatch({ secretValue: event.target.value })} />
      </label>
      <p>Привязанные переменные и заголовки используют имя секрета. В URL подставляется __AGENT_HUB_SECRET__.</p>
      <p>После сохранения значение секрета больше не показывается.</p>
      <button className="btn primary" onClick={onNext}>
        Далее
      </button>
    </>
  );
}

function ScopeStep({ state, machines, busy, onPatch, onSaveDraft }: Pick<McpServerFormProps, 'state' | 'machines' | 'busy' | 'onPatch' | 'onSaveDraft'>) {
  const toggleMachine = (machineId: string) => {
    const selected = state.scopeMachineIds.includes(machineId);
    const machineIds = selected ? state.scopeMachineIds.filter(id => id !== machineId) : [...state.scopeMachineIds, machineId];
    onPatch({ scopeMachineIds: machineIds });
  };

  const hasScope = state.scope === 'all' || (state.scope === 'machines' && state.scopeMachineIds.length > 0) || (state.scope === 'project' && state.projectId.trim().length > 0);

  return (
    <>
      <label>
        Режим
        <select className="input" value={state.mode} onChange={event => onPatch({ mode: event.target.value as McpWizardState['mode'] })}>
          <option value="remote">remote</option>
          <option value="machine-shared">machine-shared</option>
          <option value="per-session">per-session</option>
        </select>
      </label>
      <label>
        Область
        <select className="input" value={state.scope} onChange={event => onPatch({ scope: event.target.value as McpWizardState['scope'] })}>
          <option value="all">Все машины и проекты</option>
          <option value="machines">Выбранные машины</option>
          <option value="project">Проект</option>
        </select>
      </label>
      {state.scope === 'machines' && (
        <fieldset>
          <legend>Разрешённые машины</legend>
          {machines.map(machine => (
            <label key={machine.id}>
              <input className="mcp-checkbox" type="checkbox" checked={state.scopeMachineIds.includes(machine.id)} onChange={() => toggleMachine(machine.id)} />
              {machine.name}
            </label>
          ))}
        </fieldset>
      )}
      {state.scope === 'project' && (
        <label>
          ID проекта
          <input className="input" value={state.projectId} onChange={event => onPatch({ projectId: event.target.value })} />
        </label>
      )}
      <label>
        Машина для проверки
        <select className="input" value={state.machineId} onChange={event => onPatch({ machineId: event.target.value })}>
          <option value="">Выберите машину</option>
          {machines.map(machine => (
            <option key={machine.id} value={machine.id}>
              {machine.name}
            </option>
          ))}
        </select>
      </label>
      <button className="btn primary" disabled={busy || !state.machineId || !hasScope} onClick={onSaveDraft}>
        Сохранить черновик и проверить
      </button>
    </>
  );
}

function ValidationStep({
  state,
  machines,
  busy,
  error,
  secretBindingError,
  draft,
  onPatch,
  onValidate,
  onConnect,
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
  return (
    <>
      <p>Проверка сервера на выбранной машине</p>
      <ValidationTarget state={state} />
      {secretBindingError && (
        <p className="mcp-inline-field-error" role="alert">
          {secretBindingError}
        </p>
      )}
      <label>
        Машина
        <select className="input" value={state.machineId} onChange={event => onPatch({ machineId: event.target.value })}>
          <option value="">Выберите машину</option>
          {machines.map(machine => (
            <option key={machine.id} value={machine.id}>
              {machine.name}
            </option>
          ))}
        </select>
      </label>
      {error && <p role="alert">{error}</p>}
      {draft?.validation?.ok && <ToolList draft={draft} />}
      {draft?.state === 'needs_auth' && !persistedServerId && <p role="status">Сервер требует входа. Сохраните его, чтобы начать OAuth.</p>}
      {draft?.validation?.error && draft.state !== 'needs_auth' && <p role="alert">Ошибка проверки: {draft.validation.error}</p>}
      {draft?.state === 'needs-secret' && <NeedsSecretStep value={state.secretValue} onChange={value => onPatch({ secretValue: value })} onSave={onSaveSecret} />}
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
      {!persistedServerId && (
        <button className="btn" disabled={busy || !state.machineId} onClick={onValidate}>
          Проверить
        </button>
      )}
      {!persistedServerId && (
        <button className="btn primary" disabled={(!draft?.validation?.ok && draft?.state !== 'needs_auth') || busy} onClick={onConnect}>
          {draft?.state === 'needs_auth' ? 'Сохранить и перейти ко входу' : 'Подключить'}
        </button>
      )}
      {!persistedServerId && (
        <button className="btn ghost" disabled={busy} onClick={onSaveUnchecked}>
          Сохранить без проверки…
        </button>
      )}
      <button className="btn" onClick={onClose}>
        Закрыть
      </button>
    </>
  );
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
      <code>{safeTargetUrl(state.url, state.secretValue)}</code>
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

function safeTargetUrl(value: string, secretValue: string): string {
  let safeValue = secretValue ? value.replaceAll(secretValue, '[secret]') : value;
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
      <p role="status">Проверка успешна · {tools.length} инструментов</p>
      <ul>
        {tools.map(tool => (
          <li key={tool.name}>
            {tool.name}
            {tool.description ? ` — ${tool.description}` : ''}
          </li>
        ))}
      </ul>
    </>
  );
}

function NeedsSecretStep({ value, onChange, onSave }: { value: string; onChange: (value: string) => void; onSave: () => void }) {
  return (
    <>
      <p role="status">Нужен секрет для запуска сервера.</p>
      <label>
        Значение секрета
        <input className="input" type="password" autoComplete="new-password" value={value} onChange={event => onChange(event.target.value)} />
      </label>
      <button className="btn" onClick={onSave}>
        Сохранить секрет
      </button>
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
      <p role="status">{status ? oauthStatusLabel(status.state) : 'Нужен вход'}</p>
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
  switch (state) {
    case 'needs-login':
      return 'Нужен вход';
    case 'pending':
      return 'Выполняется вход';
    case 'signed-in':
      return 'Вход выполнен';
    case 'refresh-error':
      return 'Ошибка обновления токена';
    case 'expired':
      return 'Срок входа истёк';
    case 'failed':
      return 'Ошибка входа';
    case 'not-required':
      return 'Вход не требуется';
  }
}
