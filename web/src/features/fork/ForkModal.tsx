/**
 * «Форк» (task 4.15, design.md D14, spec session-fork «Форма форка»).
 * - «Полная копия»: the same machine and directory, the whole history, a new session waiting for a message; unavailable
 *   with a reason for an offline machine, a cron session, a missing directory or an unknown machine.
 * - «Handoff»: the hub writes a prompt from the replica (indicator, «Повторить» on an error), the prompt is editable,
 *   the runner is chosen (by default the source's; with the source offline — the first runner in the network). No folder
 *   field (session-folder D3): the hub starts the copy in the folder of the source's project on that runner.
 * - «Открыть справа, рядом с исходной» (on by default, desktop only) — see openFork.
 * API: POST /api/sessions/:id/fork {mode:'copy'} → 201 / 409 copy_unavailable|runner_offline|agent_outdated;
 * POST …/handoff-drafts → 202, WS handoff.draft; POST …/fork {mode:'handoff', prompt, runnerId, draftId} → 201 /
 * 422 cwd_not_found / 409 runner_offline (D10).
 * claude-subscriptions (Requirement: Выбор подписки при запуске и handoff): «Подписка» in the handoff form only (a full
 * copy resumes under the last choice), `subscriptionId` in the body; 422 subscription_unavailable — under the field.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, api } from '../../api/client';
import type { RunnerView, SessionView } from '../../api/types';
import { useStore } from '../../store';
import { t as tNow, useT } from '../../i18n';
import { useDialog } from '../ui/a11y';
import { openFork } from '../workspace/actions';
import { draftError, startDraft, stopDraftPolling, useDrafts } from './drafts';
import { SubscriptionField, useSubscriptionChoice } from '../subscriptions/SubscriptionField';
import { ProviderField, providerUnavailable } from '../newSession/ProviderField';
import type { Provider } from '../../api/types';
import { loadSubscriptions } from '../subscriptions/actions';

/** Why «Полная копия» is unavailable (spec session-fork «Форма форка»), or null. */
export function copyUnavailable(s: SessionView, runners: RunnerView[]): string | null {
  const r = runners.find(x => x.id === s.runnerId);
  if (!r || s.readOnlyReason === 'unknown_runner') return tNow('sessions.fork.unavailable.noDir');
  if (!r.online) return tNow('sessions.fork.unavailable.offline');
  if (s.isCron || s.readOnlyReason === 'cron') return tNow('sessions.fork.unavailable.cron');
  if (s.readOnlyReason === 'cwd_missing') return tNow('sessions.fork.unavailable.noDir');
  return null;
}

/** The runner a handoff starts with: the source's, or the first online runner. */
export function handoffTarget(s: SessionView, runners: RunnerView[]): { runnerId: string } {
  const src = runners.find(r => r.id === s.runnerId);
  if (src?.online) return { runnerId: src.id };
  return { runnerId: runners.find(r => r.online)?.id ?? '' };
}

function forkError(err: unknown, runnerName: string): { field: 'cwd' | 'runner' | 'form' | 'subscription'; message: string } {
  if (err instanceof ApiError) {
    if (err.code === 'subscription_unavailable') {
      void loadSubscriptions();
      return { field: 'subscription', message: tNow('sessions.fork.error.subscription') };
    }
    if (err.code === 'cwd_not_found') return { field: 'cwd', message: err.serverMessage ?? tNow('sessions.fork.error.cwdNotFound', { runner: runnerName }) };
    if (err.code === 'runner_offline') return { field: 'runner', message: tNow('sessions.fork.error.runnerOffline', { runner: runnerName }) };
    if (err.code === 'agent_outdated') return { field: 'form', message: tNow('sessions.fork.error.agentOutdated', { runner: runnerName }) };
    if (err.code === 'copy_unavailable') return { field: 'form', message: err.serverMessage ?? tNow('sessions.fork.error.copyUnavailable') };
    if (err.serverMessage) return { field: 'form', message: err.serverMessage };
  }
  return { field: 'form', message: tNow('sessions.fork.error.hubSilent') };
}

export function ForkModal({ sessionId, initialMode, onClose }: { sessionId: string; initialMode?: 'copy' | 'handoff'; onClose: () => void }) {
  const t = useT();
  const s = useStore(st => st.sessions[sessionId]);
  const runners = useStore(st => st.runners);
  const phone = useStore(st => st.device === 'phone');
  const blocked = s ? copyUnavailable(s, runners) : t('sessions.fork.unavailable.generic');
  const [mode, setMode] = useState<'copy' | 'handoff'>(blocked || initialMode === 'handoff' ? 'handoff' : 'copy');
  const start = s ? handoffTarget(s, runners) : { runnerId: '' };
  const [runnerId, setRunnerId] = useState(start.runnerId);
  const [right, setRight] = useState(true);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftFail, setDraftFail] = useState<string | null>(null);
  const draft = useDrafts(d => (draftId ? d.byId[draftId] : undefined));
  const [prompt, setPrompt] = useState('');
  const [edited, setEdited] = useState(false);
  const [errors, setErrors] = useState<{ cwd?: string; runner?: string; prompt?: string; form?: string; subscription?: string }>({});
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  useDialog(dialog, onClose);
  const runner = runners.find(r => r.id === runnerId);
  // agent-providers: the agent of the new session; the source's one when the machine has it
  const [provider, setProvider] = useState<Provider>(s?.provider ?? 'claude');
  const sub = useSubscriptionChoice(runner, provider);
  useEffect(() => {
    if (provider !== 'claude' && providerUnavailable(runner, provider)) setProvider('claude');
  }, [runner, provider]);

  const requestDraft = () => {
    setDraftFail(null);
    setDraftId(null);
    setEdited(false);
    startDraft(sessionId, undefined, undefined, provider === 'claude' ? sub.picked : undefined).then(setDraftId, (err: unknown) =>
      setDraftFail(err instanceof ApiError && err.serverMessage ? err.serverMessage : t('sessions.fork.draft.startFailed')),
    );
  };
  useEffect(() => stopDraftPolling, []);
  // the prompt is asked for when «Handoff» is first shown
  useEffect(() => {
    if (mode === 'handoff' && !draftId && !draftFail) requestDraft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);
  // the text of a ready draft fills the field unless the user already wrote there
  useEffect(() => {
    if (draft?.status === 'ready' && !edited) setPrompt(draft.text ?? '');
  }, [draft?.status, draft?.text, edited]);

  if (!s) return null;
  const pending = mode === 'handoff' && !draftFail && (!draft || draft.status === 'pending');
  const failed = mode === 'handoff' ? (draftFail ?? (draft?.status === 'error' ? (draftError(draft) ?? t('sessions.fork.draft.failed')) : null)) : null;

  const submit = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    const errs: typeof errors = {};
    if (mode === 'handoff') {
      if (!runner || !runner.online) errs.runner = t('sessions.fork.validation.runner');
      if (!prompt.trim()) errs.prompt = pending ? t('sessions.fork.validation.promptWait') : t('sessions.fork.validation.prompt');
      if (sub.blocked) errs.subscription = sub.blocked;
    }
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const created =
        mode === 'copy'
          ? await api.fork(s.id, { mode: 'copy' })
          : await api.fork(s.id, {
              mode: 'handoff',
              prompt: prompt.trim(),
              runnerId,
              ...(draftId ? { draftId } : {}),
              ...(provider !== 'claude' ? { provider } : {}),
              ...(sub.send ? { subscriptionId: sub.send } : {}),
            });
      useStore.getState().upsertSessions([created]);
      useStore.setState({ modal: null });
      openFork(created.id, s.id, right && !phone);
      useStore.getState().pushToast({
        title: mode === 'copy' ? t('sessions.fork.toast.copy') : t('sessions.fork.toast.handoff'),
        text: t('sessions.fork.toast.text', { title: created.title, source: s.title }),
        color: 'var(--accent)',
      });
    } catch (err) {
      const r = forkError(err, mode === 'copy' ? (runners.find(x => x.id === s.runnerId)?.name ?? s.runnerId) : (runner?.name ?? runnerId));
      if (r.field === 'subscription') sub.markUnavailable();
      setErrors({ [r.field]: r.message });
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="scrim modal-top" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal fork-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialog}>
        <form
          onSubmit={e => void submit(e)}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit(e);
          }}
        >
          <div className="modal-head">
            <h2 id={titleId}>{t('sessions.fork.title')}</h2>
            <p>{t('sessions.fork.subtitle', { title: s.title })}</p>
          </div>
          <div className="modal-body">
            <div className="field">
              <span className="lbl" id={`${titleId}-m`}>
                {t('sessions.fork.modeLabel')}
              </span>
              <div className="runner-opts fork-modes" role="radiogroup" aria-labelledby={`${titleId}-m`}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={mode === 'copy'}
                  className={`seg-opt${mode === 'copy' ? ' on' : ''}`}
                  disabled={!!blocked}
                  aria-describedby={blocked ? `${titleId}-why` : undefined}
                  onClick={() => setMode('copy')}
                >
                  <b>{t('sessions.fork.mode.copy')}</b>
                  <span>{t('sessions.fork.mode.copyHint')}</span>
                </button>
                <button type="button" role="radio" aria-checked={mode === 'handoff'} className={`seg-opt${mode === 'handoff' ? ' on' : ''}`} onClick={() => setMode('handoff')}>
                  <b>{t('sessions.fork.mode.handoff')}</b>
                  <span>{t('sessions.fork.mode.handoffHint')}</span>
                </button>
              </div>
              {blocked && (
                <span className="hint fork-why" id={`${titleId}-why`}>
                  {t('sessions.fork.copyWhy', { reason: blocked.toLowerCase() })}
                </span>
              )}
            </div>
            {mode === 'handoff' && (
              <>
                <div className="field">
                  <label htmlFor={`${titleId}-p`}>{t('sessions.fork.prompt.label')}</label>
                  {pending && (
                    <span className="hint draft-wait" role="status">
                      <span className="spinner" aria-hidden="true" /> {t('sessions.fork.prompt.preparing')}
                    </span>
                  )}
                  {failed && (
                    <span className="field-error draft-err" role="alert">
                      {failed}{' '}
                      <button type="button" className="btn" onClick={requestDraft}>
                        {t('sessions.fork.prompt.retry')}
                      </button>
                    </span>
                  )}
                  <textarea
                    id={`${titleId}-p`}
                    className="input"
                    style={{ minHeight: phone ? 160 : 220 }}
                    value={prompt}
                    aria-busy={pending}
                    aria-invalid={!!errors.prompt}
                    aria-describedby={errors.prompt ? `${titleId}-p-err` : undefined}
                    onChange={e => {
                      setPrompt(e.target.value);
                      setEdited(true);
                    }}
                  />
                  {errors.prompt && (
                    <span className="field-error" id={`${titleId}-p-err`} role="alert">
                      {errors.prompt}
                    </span>
                  )}
                </div>
                <div className="field">
                  <span className="lbl" id={`${titleId}-r`}>
                    {t('sessions.fork.where')}
                  </span>
                  <div className="runner-opts" role="radiogroup" aria-labelledby={`${titleId}-r`} aria-invalid={!!errors.runner}>
                    {runners.map(r => (
                      <button
                        key={r.id}
                        type="button"
                        role="radio"
                        aria-checked={r.id === runnerId}
                        className={`seg-opt${r.id === runnerId ? ' on' : ''}`}
                        disabled={!r.online}
                        onClick={() => {
                          setRunnerId(r.id);
                          setErrors({});
                        }}
                      >
                        <b>{r.name}</b>
                        <span>{r.online ? (r.os ?? t('sessions.fork.runner.online')) : t('sessions.fork.runner.offline')}</span>
                      </button>
                    ))}
                  </div>
                  {(errors.runner ?? errors.cwd) && (
                    <span className="field-error" role="alert">
                      {errors.runner ?? errors.cwd}
                    </span>
                  )}
                </div>
                <ProviderField id={`${titleId}-prov`} runner={runner} value={provider} onChange={setProvider} />
                <SubscriptionField
                  id={`${titleId}-sub`}
                  runner={runner}
                  provider={provider}
                  value={sub.value}
                  error={errors.subscription}
                  unavailableId={sub.unavailable}
                  onChange={id => {
                    sub.pick(id);
                    setErrors(e => ({ ...e, subscription: undefined }));
                  }}
                />
              </>
            )}
            {!phone && (
              <label className="check">
                <input type="checkbox" checked={right} onChange={e => setRight(e.target.checked)} /> {t('sessions.fork.openRight')}
              </label>
            )}
            {errors.form && (
              <div className="err-box" role="alert">
                {errors.form}
              </div>
            )}
          </div>
          <div className="modal-foot">
            <span className="hint foot-hint">{mode === 'copy' ? t('sessions.fork.hint.create') : t('sessions.fork.hint.launch')}</span>
            <button type="button" className="btn ghost" onClick={onClose}>
              {t('sessions.fork.cancel')}
            </button>
            <button type="submit" className="btn primary" disabled={busy || (mode === 'handoff' && !!sub.blocked)} title={mode === 'handoff' ? sub.blocked : undefined}>
              {busy ? t('sessions.fork.busy') : mode === 'copy' ? t('sessions.fork.submit.copy') : t('sessions.fork.submit.handoff')}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
