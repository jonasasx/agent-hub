/**
 * «Подключить машину» (change `multi-user`).
 * Requirement (runner-enrollment): Окно подключения машины — name and OS (preselected by the browser) → the command with
 * «Скопировать» → live progress over WS `runner.enroll` («ждём машину» → «машина подключилась» → «проверяем Claude» →
 * «готово»), then «Начать первую сессию». Requirement: Код подключения — «Новый код» revokes the previous code;
 * scenario «Истёкший код» — the window offers «Новый код»; scenario «Машина не достаёт хаб» — a hint about :443.
 * Requirement: macOS — scenario «Mac без полного доступа к диску».
 * API: POST /api/runners, POST /api/runners/:id/enroll-code, GET /api/runners/:id (D10, design M4).
 */
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, api } from '../../api/client';
import { DEFAULT_MACHINE_NAME, type EnrollCodeResponse, type EnrollStage, type MachineOs, type RunnerView } from '../../api/types';
import { useStore } from '../../store';
import { useDialog } from '../ui/a11y';
import { OS_LABEL, OS_ORDER, STAGE_INDEX, claudeLoginCommand, copyText, detectOs, osFamily } from './machines';

/** Waiting this long without the code being used shows the hint about the machine's way out to the internet. */
export const NO_CONTACT_HINT_MS = 60_000;

export function CopyButton({ text, label = 'Скопировать' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const t = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(t);
  }, [state]);
  return (
    <button type="button" className="btn primary copy-btn" onClick={() => void copyText(text).then(ok => setState(ok ? 'ok' : 'fail'))}>
      <span aria-live="polite">{state === 'ok' ? 'Скопировано' : state === 'fail' ? 'Выделите и скопируйте' : label}</span>
    </button>
  );
}

/** A command in a monospace box with «Скопировать»; the box selects itself on focus for manual copying. */
export function CommandBox({ command, label }: { command: string; label: string }) {
  return (
    <div className="cmd-box">
      <code
        className="cmd mono"
        tabIndex={0}
        aria-label={label}
        onFocus={e => {
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(e.currentTarget);
          sel?.removeAllRanges();
          sel?.addRange(range);
        }}
      >
        {command}
      </code>
      <CopyButton text={command} />
    </div>
  );
}

function OsSwitch({ value, onChange, labelledBy }: { value: MachineOs; onChange: (os: MachineOs) => void; labelledBy: string }) {
  return (
    <div className="segmini os-seg" role="radiogroup" aria-labelledby={labelledBy}>
      {OS_ORDER.map(os => (
        <button key={os} type="button" role="radio" aria-checked={os === value} className={os === value ? 'on' : ''} onClick={() => onChange(os)}>
          {OS_LABEL[os]}
        </button>
      ))}
    </div>
  );
}

type StepState = 'done' | 'active' | 'todo';

function Step({ state, children }: { state: StepState; children: React.ReactNode }) {
  return (
    <li className={`enroll-step ${state}`} aria-current={state === 'active' ? 'step' : undefined}>
      <span className="es-mark" aria-hidden="true">
        {state === 'done' ? '✓' : state === 'active' ? <span className="spinner" /> : ''}
      </span>
      <span className="es-text">
        {children}
        <span className="sr-only">{state === 'done' ? ' — готово' : state === 'active' ? ' — идёт' : ''}</span>
      </span>
    </li>
  );
}

/** The progress list of the waiting step (exported for the tests of every stage). */
export function EnrollProgress({ stage, runner }: { stage: EnrollStage; runner: RunnerView | null }) {
  const i = STAGE_INDEX[stage];
  // the first step is in progress from the start (waiting, code_used); each next one once the previous is done
  const st = (doneAt: number): StepState => (i >= doneAt ? 'done' : i === doneAt - 1 || doneAt === 2 ? 'active' : 'todo');
  const login = runner?.claudeLogin;
  const claudeDone = login === 'ok' ? 'Claude: вход есть' : login === 'missing' || login === 'rejected' ? 'Claude: нет входа' : 'Claude проверен';
  return (
    <ol className="enroll-steps" aria-label="Ход подключения">
      <Step state={st(2)}>{i >= 2 ? 'Машина подключилась' : i === 1 ? 'Код принят, ставим агента…' : 'Ждём машину — запустите команду'}</Step>
      <Step state={st(3)}>{i >= 3 ? claudeDone : 'Проверяем Claude'}</Step>
      <Step state={st(4)}>Готово</Step>
    </ol>
  );
}

export function EnrollModal({ runnerId: initialRunnerId, onClose }: { runnerId?: string; onClose: () => void }) {
  const reconnect = !!initialRunnerId;
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  useDialog(dialog, onClose);
  const [name, setName] = useState(DEFAULT_MACHINE_NAME);
  const [os, setOs] = useState<MachineOs>(detectOs);
  const [issued, setIssued] = useState<EnrollCodeResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field: 'name' | 'form'; text: string } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [issuedAt, setIssuedAt] = useState(0);
  const runnerId = issued?.runner.id ?? initialRunnerId ?? null;
  const live = useStore(s => (runnerId ? s.enroll[runnerId] : undefined));
  // issue() drops the stage of an older code: until a new event the window is «ждём машину»
  const stage: EnrollStage = (issued && live?.stage) || 'waiting';
  const runner = live?.runner ?? issued?.runner ?? null;

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const issue = async (fn: () => Promise<EnrollCodeResponse>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      // the stage of the previous code is dropped: the window waits for the new one
      useStore.setState({ enroll: { ...useStore.getState().enroll, [r.runner.id]: undefined } });
      setIssued(r);
      setIssuedAt(Date.now());
      setNow(Date.now());
    } catch (err) {
      if (err instanceof ApiError && err.code === 'name_taken') setError({ field: 'name', text: 'Машина с таким именем уже есть — выберите другое' });
      else if (err instanceof ApiError && err.code === 'runner_disabled') setError({ field: 'form', text: 'Машина отключена — подключите её заново через «Добавить машину»' });
      else if (err instanceof ApiError && err.code === 'not_found') setError({ field: 'form', text: 'Машина не найдена' });
      else setError({ field: 'form', text: 'Хаб не ответил. Проверьте связь и попробуйте ещё раз.' });
    } finally {
      setBusy(false);
    }
  };

  // «Переподключить» / the command of a pending machine: a new code right away, the OS from the machine
  useEffect(() => {
    if (!initialRunnerId) return;
    let cancelled = false;
    api
      .runner(initialRunnerId)
      .then(d => {
        if (!cancelled && d.os) setOs(osFamily(d.os));
      })
      .catch(() => undefined);
    void issue(() => api.enrollCode(initialRunnerId)).then(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [initialRunnerId]);

  useEffect(() => {
    if (!issued) dialog.current?.querySelector<HTMLInputElement>('input')?.select();
  }, [issued]);

  const submit = (e: { preventDefault(): void }) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return setError({ field: 'name', text: 'Укажите имя машины' });
    void issue(() => api.createRunner({ name: n, os }));
  };

  const expired = !!issued && stage === 'waiting' && Date.parse(issued.expiresAt) <= now;
  const showNoContact = !!issued && !expired && stage === 'waiting' && now - issuedAt >= NO_CONTACT_HINT_MS;
  const ready = stage === 'ready';
  const command = issued ? (os === 'windows' ? issued.commands.windows : issued.commands.unix) : '';
  const until = issued ? new Date(issued.expiresAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '';
  const host = typeof location !== 'undefined' ? location.host : '';
  const startFirst = () => {
    if (!runner) return;
    useStore.setState({ modal: { type: 'new', runnerId: runner.id, cwd: runner.homeDir ?? '', first: true } });
  };

  return createPortal(
    <div className="scrim modal-top" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal enroll" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialog}>
        <div className="modal-head">
          <h2 id={titleId}>{reconnect ? `Переподключить ${runner?.name ?? 'машину'}` : 'Подключить машину'}</h2>
          <p>{reconnect ? 'Новый код. Машина работает по старому токену, пока не подключится по новому.' : 'Агент ставится одной командой. Токены копировать не нужно.'}</p>
        </div>
        {!issued && !reconnect ? (
          <form onSubmit={submit}>
            <div className="modal-body">
              <ol className="enroll-path" aria-label="Шаги">
                <li className="on">1. Имя и система</li>
                <li>2. Команда</li>
                <li>3. Подключение</li>
              </ol>
              <div className="field">
                <label htmlFor={`${titleId}-name`}>Имя машины</label>
                <input
                  id={`${titleId}-name`}
                  className="input"
                  value={name}
                  maxLength={64}
                  onChange={e => setName(e.target.value)}
                  aria-invalid={error?.field === 'name'}
                  aria-describedby={error?.field === 'name' ? `${titleId}-name-err` : `${titleId}-name-hint`}
                />
                {error?.field === 'name' ? (
                  <span className="field-error" id={`${titleId}-name-err`} role="alert">
                    {error.text}
                  </span>
                ) : (
                  <span className="hint" id={`${titleId}-name-hint`}>
                    Можно поменять потом в «Настройки → Машины».
                  </span>
                )}
              </div>
              <div className="field">
                <span className="lbl" id={`${titleId}-os`}>
                  Система
                </span>
                <OsSwitch value={os} onChange={setOs} labelledBy={`${titleId}-os`} />
              </div>
              {error?.field === 'form' && (
                <div className="err-box" role="alert">
                  {error.text}
                </div>
              )}
            </div>
            <div className="modal-foot">
              <button type="button" className="btn ghost" onClick={onClose}>
                Отмена
              </button>
              <button type="submit" className="btn primary" disabled={busy}>
                {busy ? 'Готовим команду…' : 'Получить команду'}
              </button>
            </div>
          </form>
        ) : (
          <>
            <div className="modal-body">
              {!reconnect && (
                <ol className="enroll-path" aria-label="Шаги">
                  <li className="done">1. Имя и система</li>
                  <li className={stage !== 'waiting' ? 'done' : 'on'}>2. Команда</li>
                  <li className={ready ? 'done' : stage !== 'waiting' ? 'on' : ''}>3. Подключение</li>
                </ol>
              )}
              {!issued && busy && (
                <p className="hint" role="status">
                  <span className="spinner" aria-hidden="true" /> Готовим команду…
                </p>
              )}
              {error?.field === 'form' && (
                <div className="err-box" role="alert">
                  {error.text}
                </div>
              )}
              {issued && !ready && (
                <div className="field">
                  <span className="lbl" id={`${titleId}-cmd-os`}>
                    Запустите на машине{os === 'windows' ? ' в PowerShell' : ' в терминале'}
                  </span>
                  <OsSwitch value={os} onChange={setOs} labelledBy={`${titleId}-cmd-os`} />
                  {expired ? (
                    <div className="err-box" role="alert">
                      Код истёк — получите новый и запустите команду снова.
                    </div>
                  ) : (
                    <>
                      <CommandBox command={command} label={`Команда установки для ${OS_LABEL[os]}`} />
                      <span className="hint">
                        Код одноразовый, действует до {until}. {os === 'windows' ? 'PowerShell сам запросит права администратора.' : 'sudo не нужен.'}
                      </span>
                    </>
                  )}
                </div>
              )}
              {issued && (
                <div aria-live="polite">
                  <EnrollProgress stage={stage} runner={runner} />
                </div>
              )}
              {showNoContact && (
                <p className="hint enroll-hint">Машина не отвечает? Проверьте, что у неё есть выход в интернет на {host}:443. Если команда напечатала «Код истёк», нажмите «Новый код».</p>
              )}
              {ready && runner?.protectedDirsOk === false && <MacDiskWarning />}
              {ready && (runner?.claudeLogin === 'missing' || runner?.claudeLogin === 'rejected') && (
                <div className="banner warn inline-warn" role="status">
                  <div className="b-text">
                    <b>Нет входа в Claude.</b> Выполните на машине:
                    <CommandBox command={claudeLoginCommand(runner.os)} label="Команда входа в Claude" />
                  </div>
                </div>
              )}
              {ready && <p className="hint">Сессии будут появляться слева, по проектам — по git-репозиторию каталога.</p>}
            </div>
            <div className="modal-foot">
              {issued && !ready && (
                <button type="button" className={`btn${expired ? ' primary' : ''}`} disabled={busy} onClick={() => runnerId && void issue(() => api.enrollCode(runnerId))}>
                  Новый код
                </button>
              )}
              <button type="button" className="btn ghost" onClick={onClose}>
                {ready ? 'Готово' : 'Закрыть'}
              </button>
              {ready && (
                <button type="button" className="btn primary" onClick={startFirst} autoFocus>
                  Начать первую сессию
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** Requirement: macOS — «нет доступа к защищённым папкам macOS» with the way to grant it. */
export function MacDiskWarning() {
  return (
    <div className="banner warn inline-warn" role="status">
      <div className="b-text">
        <b>Нет доступа к защищённым папкам macOS.</b> Агент не читает ~/Documents, ~/Desktop и ~/Downloads. Откройте «Системные настройки → Конфиденциальность и безопасность → Полный доступ к диску» и
        добавьте <code>~/.agent-hub/node/bin/node</code>. Каталоги вне этих папок (например, ~/code) работают и так.
      </div>
    </div>
  );
}
