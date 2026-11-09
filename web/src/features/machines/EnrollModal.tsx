/**
 * «Подключить машину» (change `multi-user`).
 * Requirement (runner-enrollment): Окно подключения машины — name and OS (preselected by the browser) → the command with
 * «Скопировать» → live progress over WS `runner.enroll` («ждём машину» → «машина подключилась» → «проверяем Claude» →
 * «готово»), then «Начать первую сессию». Requirement: Код подключения — «Новый код» revokes the previous code;
 * scenario «Истёкший код» — the window offers «Новый код»; scenario «Машина не достаёт хаб» — a hint about :443.
 * Requirement: macOS — scenario «Mac без полного доступа к диску».
 * API: POST /api/runners, POST /api/runners/:id/enroll-code, GET /api/runners/:id (D10, design M4).
 * Requirement (machine-mcp-onboarding): Шаг MCP в мастере подключения машины — after «готово» a new machine gets the
 * import preview of its MCP configuration (`McpImportPanel`); «Пропустить» closes the wizard (change `mcp-hub-only`).
 */
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, api } from '../../api/client';
import { type EnrollCodeResponse, type EnrollStage, type MachineOs, type RunnerView } from '../../api/types';
import { useT } from '../../i18n';
import { fmt } from '../../i18n';
import { useStore } from '../../store';
import { useDialog } from '../ui/a11y';
import { McpImportPanel } from '../mcp/McpImportPanel';
import { DefaultDirField } from './DefaultDir';
import { OS_LABEL, OS_ORDER, STAGE_INDEX, claudeLoginCommand, copyText, detectOs, osFamily } from './machines';

/** Waiting this long without the code being used shows the hint about the machine's way out to the internet. */
export const NO_CONTACT_HINT_MS = 60_000;

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const t = useT();
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <button type="button" className="btn primary copy-btn" onClick={() => void copyText(text).then(ok => setState(ok ? 'ok' : 'fail'))}>
      <span aria-live="polite">{state === 'ok' ? t('machines.enroll.copied') : state === 'fail' ? t('machines.enroll.copyManual') : (label ?? t('machines.enroll.copy'))}</span>
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
  const t = useT();
  return (
    <li className={`enroll-step ${state}`} aria-current={state === 'active' ? 'step' : undefined}>
      <span className="es-mark" aria-hidden="true">
        {state === 'done' ? '✓' : state === 'active' ? <span className="spinner" /> : ''}
      </span>
      <span className="es-text">
        {children}
        <span className="sr-only">{state === 'done' ? t('machines.enroll.stepDone') : state === 'active' ? t('machines.enroll.stepActive') : ''}</span>
      </span>
    </li>
  );
}

/** The progress list of the waiting step (exported for the tests of every stage). */
export function EnrollProgress({ stage, runner }: { stage: EnrollStage; runner: RunnerView | null }) {
  const t = useT();
  const i = STAGE_INDEX[stage];
  // the first step is in progress from the start (waiting, code_used); each next one once the previous is done
  const st = (doneAt: number): StepState => (i >= doneAt ? 'done' : i === doneAt - 1 || doneAt === 2 ? 'active' : 'todo');
  const login = runner?.claudeLogin;
  const claudeDone = login === 'ok' ? t('machines.enroll.claudeOk') : login === 'missing' || login === 'rejected' ? t('machines.enroll.claudeMissing') : t('machines.enroll.claudeChecked');
  return (
    <ol className="enroll-steps" aria-label={t('machines.enroll.progressLabel')}>
      <Step state={st(2)}>{i >= 2 ? t('machines.enroll.connected') : i === 1 ? t('machines.enroll.codeUsed') : t('machines.enroll.waitingMachine')}</Step>
      <Step state={st(3)}>{i >= 3 ? claudeDone : t('machines.enroll.checkingClaude')}</Step>
      <Step state={st(4)}>{t('machines.enroll.ready')}</Step>
    </ol>
  );
}

export function EnrollModal({ runnerId: initialRunnerId, onClose }: { runnerId?: string; onClose: () => void }) {
  const t = useT();
  const reconnect = !!initialRunnerId;
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  useDialog(dialog, onClose);
  const [name, setName] = useState(() => t('machines.enroll.defaultName'));
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
      if (err instanceof ApiError && err.code === 'name_taken') setError({ field: 'name', text: t('machines.enroll.nameTaken') });
      else if (err instanceof ApiError && err.code === 'runner_disabled') setError({ field: 'form', text: t('machines.enroll.disabled') });
      else if (err instanceof ApiError && err.code === 'not_found') setError({ field: 'form', text: t('machines.enroll.notFound') });
      else setError({ field: 'form', text: t('machines.enroll.hubNoAnswer') });
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
    if (!n) return setError({ field: 'name', text: t('machines.enroll.nameRequired') });
    void issue(() => api.createRunner({ name: n, os }));
  };

  const expired = !!issued && stage === 'waiting' && Date.parse(issued.expiresAt) <= now;
  const showNoContact = !!issued && !expired && stage === 'waiting' && now - issuedAt >= NO_CONTACT_HINT_MS;
  const ready = stage === 'ready';
  const mcpStep = ready && !reconnect && !!runner;
  const command = issued ? (os === 'windows' ? issued.commands.windows : issued.commands.unix) : '';
  const until = issued ? fmt.time(new Date(issued.expiresAt)) : '';
  const host = typeof location !== 'undefined' ? location.host : '';
  const startFirst = () => {
    if (!runner) return;
    useStore.setState({ modal: { type: 'new', runnerId: runner.id, first: true } });
  };

  return createPortal(
    <div className="scrim modal-top" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal enroll" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialog}>
        <div className="modal-head">
          <h2 id={titleId}>{reconnect ? (runner?.name ? t('machines.enroll.titleReconnect', { name: runner.name }) : t('machines.enroll.titleReconnectFallback')) : t('machines.enroll.title')}</h2>
          <p>{reconnect ? t('machines.enroll.leadReconnect') : t('machines.enroll.lead')}</p>
        </div>
        {!issued && !reconnect ? (
          <form onSubmit={submit}>
            <div className="modal-body">
              <ol className="enroll-path" aria-label={t('machines.enroll.pathLabel')}>
                <li className="on">{t('machines.enroll.path1')}</li>
                <li>{t('machines.enroll.path2')}</li>
                <li>{t('machines.enroll.path3')}</li>
              </ol>
              <div className="field">
                <label htmlFor={`${titleId}-name`}>{t('machines.enroll.nameLabel')}</label>
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
                    {t('machines.enroll.nameHint')}
                  </span>
                )}
              </div>
              <div className="field">
                <span className="lbl" id={`${titleId}-os`}>
                  {t('machines.enroll.osLabel')}
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
                {t('machines.enroll.cancel')}
              </button>
              <button type="submit" className="btn primary" disabled={busy}>
                {busy ? t('machines.enroll.preparing') : t('machines.enroll.getCommand')}
              </button>
            </div>
          </form>
        ) : (
          <>
            <div className="modal-body">
              {!reconnect && (
                <ol className="enroll-path" aria-label={t('machines.enroll.pathLabel')}>
                  <li className="done">{t('machines.enroll.path1')}</li>
                  <li className={stage !== 'waiting' ? 'done' : 'on'}>{t('machines.enroll.path2')}</li>
                  <li className={ready ? 'done' : stage !== 'waiting' ? 'on' : ''}>{t('machines.enroll.path3')}</li>
                  <li className={mcpStep ? 'on' : ''}>{t('machines.enroll.path4')}</li>
                </ol>
              )}
              {!issued && busy && (
                <p className="hint" role="status">
                  <span className="spinner" aria-hidden="true" /> {t('machines.enroll.preparing')}
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
                    {os === 'windows' ? t('machines.enroll.runWindows') : t('machines.enroll.runUnix')}
                  </span>
                  <OsSwitch value={os} onChange={setOs} labelledBy={`${titleId}-cmd-os`} />
                  {expired ? (
                    <div className="err-box" role="alert">
                      {t('machines.enroll.expired')}
                    </div>
                  ) : (
                    <>
                      <CommandBox command={command} label={t('machines.enroll.cmdLabel', { os: OS_LABEL[os] })} />
                      <span className="hint">{os === 'windows' ? t('machines.enroll.codeHintWindows', { until }) : t('machines.enroll.codeHintUnix', { until })}</span>
                    </>
                  )}
                </div>
              )}
              {issued && (
                <div aria-live="polite">
                  <EnrollProgress stage={stage} runner={runner} />
                </div>
              )}
              {showNoContact && <p className="hint enroll-hint">{t('machines.enroll.noContact', { host })}</p>}
              {ready && runner?.protectedDirsOk === false && <MacDiskWarning />}
              {ready && (runner?.claudeLogin === 'missing' || runner?.claudeLogin === 'rejected') && (
                <div className="banner warn inline-warn" role="status">
                  <div className="b-text">
                    <b>{t('machines.enroll.noLoginTitle')}</b> {t('machines.enroll.noLoginRun')}
                    <CommandBox command={claudeLoginCommand(runner.os)} label={t('machines.enroll.loginCmdLabel')} />
                  </div>
                </div>
              )}
              {ready && runner && <DefaultDirField runner={runner} />}
              {ready && <p className="hint">{t('machines.enroll.readyHint')}</p>}
              {mcpStep && (
                <section className="enroll-mcp" aria-labelledby={`${titleId}-mcp`}>
                  <h3 id={`${titleId}-mcp`}>{t('machines.enroll.mcpTitle')}</h3>
                  <McpImportPanel
                    machineId={runner.id}
                    onClose={onClose}
                    doneActions={
                      <button type="button" className="btn primary" onClick={startFirst}>
                        {t('machines.enroll.startFirst')}
                      </button>
                    }
                  />
                </section>
              )}
            </div>
            {!mcpStep && (
              <div className="modal-foot">
                {issued && !ready && (
                  <button type="button" className={`btn${expired ? ' primary' : ''}`} disabled={busy} onClick={() => runnerId && void issue(() => api.enrollCode(runnerId))}>
                    {t('machines.enroll.newCode')}
                  </button>
                )}
                <button type="button" className="btn ghost" onClick={onClose}>
                  {ready ? t('machines.enroll.ready') : t('machines.enroll.close')}
                </button>
                {ready && (
                  <button type="button" className="btn primary" onClick={startFirst} autoFocus>
                    {t('machines.enroll.startFirst')}
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** Requirement: macOS — «нет доступа к защищённым папкам macOS» with the way to grant it. */
export function MacDiskWarning() {
  const t = useT();
  return (
    <div className="banner warn inline-warn" role="status">
      <div className="b-text">
        <b>{t('machines.enroll.macTitle')}</b> {t('machines.enroll.macBefore')} <code>~/.agent-hub/node/bin/node</code>
        {t('machines.enroll.macAfter')}
      </div>
    </div>
  );
}
