import { colorVar } from '../sessions/status';
/**
 * «Новая сессия» (docs/prototype.html modal() type 'new').
 * Requirement (sessions): Запуск сессии из UI — runner (offline ones unavailable), permission mode (default
 * bypassPermissions), model, first message, project. session-folder D3: no folder field — the session starts in the
 * default folder of the machine or in the project folder under it (the hint shows where); «Каталог не найден» keeps
 * the form open. Change `multi-user`: «Начать первую сессию» opens the form with the machine chosen.
 * API: POST /api/sessions → 201 / 422 cwd_not_found (text under the project list) / 409 runner_offline (D10).
 * runner-enrollment «Запуск под root»: on a machine whose agent runs as root bypassPermissions is disabled with a hint,
 * the default is acceptEdits (the hub answers 422 bypass_root otherwise).
 * claude-subscriptions (Requirement: Выбор подписки при запуске и handoff): «Подписка» with the last choice preselected,
 * `subscriptionId` in the body; 422 subscription_unavailable — the list is reloaded, the text under the field.
 * agent-providers (Requirement: Запуск сессии Codex): «Агент» — Claude Code or Codex (when the machine reported it
 * signed in); Codex — its models, `provider` in the body. provider-parity: «Подписка» for both agents, from the registry
 * of the chosen agent (a Codex one is a ChatGPT sign-in).
 */
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDialog } from '../ui/a11y';
import { addFiles, busy as attachmentsBusy, clearAttachments, filesOf, readyRefs, useAttachments } from '../images/attachments';
import { AttachButton, AttachmentStrip } from '../images/AttachmentStrip';

/** Images of the first message (chat-images «Картинка в новой сессии»): the composer key of the form. */
const FORM_KEY = 'new';
import { UI_PERMISSION_MODES, bypassUnavailable, type Provider, type RunnerView, type UiPermissionMode } from '../../api/types';
import { usableRunner, useStore } from '../../store';
import { createSession } from '../workspace/actions';
import { SubscriptionField, useSubscriptionChoice } from '../subscriptions/SubscriptionField';
import { ProviderField, providerModels, providerUnavailable } from './ProviderField';
import { api } from '../../api/client';
import { useT } from '../../i18n';
import type { UserProjectView } from '../../api/types';
import { ProjectFolderField, folderInvalid, startFolder } from '../projects/ProjectFolderField';

export interface NewSessionPreset {
  runnerId?: string;
  /** The first session after connecting a machine: the hint about where sessions appear. */
  first?: boolean;
}

export function NewSessionModal({ onClose, preset = {} }: { onClose: () => void; preset?: NewSessionPreset }) {
  const tr = useT();
  const all = useStore(s => s.runners);
  const runners = all.filter(usableRunner);
  const claudeModels = useStore(s => s.models);
  const initial = runners.find(r => r.id === preset.runnerId) ?? runners.find(r => r.online);
  const [runnerId, setRunnerId] = useState(initial?.id ?? '');
  const runner = runners.find(r => r.id === runnerId);
  const [mode, setMode] = useState<UiPermissionMode>(bypassUnavailable(initial) ? 'acceptEdits' : 'bypassPermissions');
  const noBypass = bypassUnavailable(runner);
  // the default follows the machine (runsAsRoot may arrive after the form opened) until the user picks a mode himself
  const [modeTouched, setModeTouched] = useState(false);
  const launchChoiceTouched = useRef({ runner: false, provider: false });
  useEffect(() => {
    if (!modeTouched) setMode(noBypass ? 'acceptEdits' : 'bypassPermissions');
  }, [noBypass, modeTouched]);
  const [provider, setProvider] = useState<Provider>('claude');
  const [projects, setProjects] = useState<UserProjectView[]>([]);
  const [project, setProject] = useState('auto');
  const [projectSort, setProjectSort] = useState<'recent' | 'name'>('recent');
  const [projectName, setProjectName] = useState('');
  const [projectFolder, setProjectFolder] = useState('');
  const [projectDescription, setProjectDescription] = useState('');
  const [projectRemote, setProjectRemote] = useState('');
  const models = providerModels(runner, provider, claudeModels);
  const [model, setModel] = useState(models[0]?.value ?? '');
  const [prompt, setPrompt] = useState('');
  const [errors, setErrors] = useState<{ cwd?: string; runner?: string; prompt?: string; form?: string; subscription?: string }>({});
  const [busy, setBusy] = useState(false);
  const sub = useSubscriptionChoice(runner, provider);
  useEffect(() => {
    void api
      .catalogProjects(projectSort)
      .then(setProjects)
      .catch(() => setProjects([]));
  }, [projectSort]);
  useEffect(() => {
    void api
      .launchPreferences()
      .then(p => {
        const preferredRunner = runners.find(r => r.id === p.runnerId && r.online);
        if (!launchChoiceTouched.current.runner && preferredRunner) setRunnerId(preferredRunner.id);
        if (!launchChoiceTouched.current.provider && p.provider) setProvider(p.provider);
      })
      .catch(() => undefined);
    // Preferences apply once when the modal opens; later runner/provider changes are user choices.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 502 attachment_delivery_failed (D19): the form keeps the text and the thumbnails, «Повторить» starts again
  const [canRetry, setCanRetry] = useState(false);
  const uploading = useAttachments(a => !!a.byKey[FORM_KEY] && attachmentsBusy(FORM_KEY));
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  // UI review H3: focus stays in the dialog, the app behind is inert, the opener gets the focus back
  useDialog(dialog, onClose);

  useEffect(() => {
    // the list changes with the provider and the machine: keep a model of the list
    if (models[0] && !models.some(m => m.value === model)) setModel(models[0].value);
  }, [models, model]);
  useEffect(() => {
    // another machine without the chosen provider: back to Claude
    if (provider !== 'claude' && providerUnavailable(runner, provider)) setProvider('claude');
  }, [runner, provider]);
  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>('textarea')?.focus();
  }, []);

  const pick = (r: RunnerView) => {
    launchChoiceTouched.current.runner = true;
    setRunnerId(r.id);
    if (bypassUnavailable(r) && mode === 'bypassPermissions') setMode('acceptEdits');
    setErrors({});
  };

  const submit = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    const errs: typeof errors = {};
    if (!runner || !runner.online) errs.runner = tr('newSession.err.runner');
    if (attachmentsBusy(FORM_KEY)) return;
    const images = readyRefs(FORM_KEY);
    if (!prompt.trim() && !images.length) errs.prompt = tr('newSession.err.prompt');
    if (sub.blocked) errs.subscription = sub.blocked;
    if (!model) errs.form = tr('newSession.err.noModels');
    let explicitProjectId: string | undefined = project !== 'auto' && project !== 'create' ? project : undefined;
    if (project === 'create') {
      if (!projectName.trim()) errs.form = tr('newSession.err.projectName');
      if (folderInvalid(projectFolder)) errs.cwd = tr('projects.folder.invalid');
      if (!Object.keys(errs).length) {
        try {
          const created = await api.createCatalogProject({
            name: projectName.trim(),
            description: projectDescription,
            remote: projectRemote.trim() || null,
            folder: projectFolder.trim() || null,
          });
          setProjects(p => [created, ...p]);
          setProject(created.id);
          explicitProjectId = created.id;
        } catch {
          errs.form = tr('newSession.err.createFailed');
        }
      }
    }
    setErrors(errs);
    if (Object.keys(errs).length || !runner) return focusFirstInvalid(errs);
    setBusy(true);
    setCanRetry(false);
    const r = await createSession(
      {
        runnerId: runner.id,
        permissionMode: mode,
        model,
        prompt: prompt.trim(),
        ...(images.length ? { attachments: images } : {}),
        ...(provider !== 'claude' ? { provider } : {}),
        ...(explicitProjectId ? { projectId: explicitProjectId } : {}),
        ...(sub.send ? { subscriptionId: sub.send } : {}),
      },
      runner.name,
    );
    setBusy(false);
    if (r.ok) {
      clearAttachments(FORM_KEY);
      onClose();
    } else {
      if (r.field === 'subscription') sub.markUnavailable();
      setErrors({ [r.field]: r.message });
      setCanRetry(r.retry === true);
      focusFirstInvalid({ [r.field]: r.message });
    }
  };

  /** UI review M3: the first field with an error gets the focus (runner → directory → message). */
  const focusFirstInvalid = (errs: typeof errors) => {
    const root = dialog.current;
    if (!root) return;
    const target = errs.runner
      ? root.querySelector<HTMLElement>('[role="radio"]:not([disabled])')
      : errs.cwd
        ? root.querySelector<HTMLElement>(`.modal-body .runner-opts button`)
        : errs.prompt
          ? root.querySelector<HTMLElement>(`#${CSS.escape(`${titleId}-msg`)}`)
          : errs.subscription
            ? root.querySelector<HTMLElement>(`#${CSS.escape(`${titleId}-sub`)}`)
            : null;
    target?.focus();
  };

  return createPortal(
    <div className="scrim modal-top" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialog}>
        <form
          onSubmit={e => void submit(e)}
          onKeyDown={e => {
            // Ctrl/Cmd+Enter starts the session from any field of the form
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit(e);
          }}
        >
          <div className="modal-head">
            <h2 id={titleId}>{tr('newSession.title')}</h2>
            <p>{tr('newSession.lead')}</p>
          </div>
          <div className="modal-body">
            <div className="field">
              <span className="lbl" id={`${titleId}-r`}>
                {tr('newSession.where')}
              </span>
              <div className="runner-opts" role="radiogroup" aria-labelledby={`${titleId}-r`} aria-invalid={!!errors.runner} aria-describedby={errors.runner ? `${titleId}-r-err` : undefined}>
                {runners.map(r => (
                  <button key={r.id} type="button" role="radio" aria-checked={r.id === runnerId} className={`seg-opt${r.id === runnerId ? ' on' : ''}`} disabled={!r.online} onClick={() => pick(r)}>
                    <b>{r.name}</b>
                    <span>{r.online ? (r.os ?? tr('machines.status.online')) : tr('machines.status.offline')}</span>
                  </button>
                ))}
              </div>
              {errors.runner && (
                <span className="field-error" id={`${titleId}-r-err`} role="alert">
                  {errors.runner}
                </span>
              )}
            </div>
            <ProviderField
              id={`${titleId}-prov`}
              runner={runner}
              value={provider}
              onChange={value => {
                launchChoiceTouched.current.provider = true;
                setProvider(value);
              }}
            />
            <div className="field">
              <label htmlFor={`${titleId}-msg`}>{tr('newSession.firstMessage')}</label>
              <textarea
                id={`${titleId}-msg`}
                className="input"
                style={{ minHeight: 90 }}
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                onPaste={e => {
                  const files = filesOf(e.clipboardData);
                  if (!files.length) return;
                  e.preventDefault();
                  addFiles(FORM_KEY, files);
                }}
                onDragOver={e => {
                  if ([...e.dataTransfer.types].includes('Files')) e.preventDefault();
                }}
                onDrop={e => {
                  const files = filesOf(e.dataTransfer);
                  if (!files.length) return;
                  e.preventDefault();
                  addFiles(FORM_KEY, files);
                }}
                aria-invalid={!!errors.prompt}
                aria-describedby={errors.prompt ? `${titleId}-msg-err` : undefined}
              />
              {errors.prompt && (
                <span className="field-error" id={`${titleId}-msg-err`} role="alert">
                  {errors.prompt}
                </span>
              )}
              <AttachmentStrip akey={FORM_KEY} />
              <span>
                <AttachButton akey={FORM_KEY} />
              </span>
            </div>
            <div className="field">
              <div className="lbl project-heading">
                <span>{tr('newSession.project')}</span>
                <span className="project-sort" role="group" aria-label={tr('newSession.sortLabel')}>
                  <button type="button" aria-pressed={projectSort === 'recent'} onClick={() => setProjectSort('recent')}>
                    {tr('newSession.sortRecent')}
                  </button>
                  <button type="button" aria-pressed={projectSort === 'name'} onClick={() => setProjectSort('name')}>
                    {tr('newSession.sortName')}
                  </button>
                </span>
              </div>
              <div className="project-list">
                <button type="button" className={`seg-opt${project === 'auto' ? ' on' : ''}`} onClick={() => setProject('auto')} title={tr('newSession.autoTip')}>
                  <b>{tr('newSession.autoName')}</b>
                  <span>{tr('newSession.autoHint')}</span>
                </button>
                {projects
                  .filter(p => !p.archived)
                  .map(p => (
                    <button
                      type="button"
                      key={p.id}
                      className={`seg-opt project-option${project === p.id ? ' on' : ''}`}
                      onClick={() => setProject(p.id)}
                      title={startFolder(runner, p.folder) ?? undefined}
                    >
                      <div className="project-option-heading">
                        <span className="pdot project-initial" aria-hidden="true" style={{ background: colorVar(p.colorKey), display: 'inline-grid' }}>
                          {Array.from(p.name)[0]?.toLocaleUpperCase()}
                        </span>
                        <b>{p.name}</b>
                      </div>
                      {p.folder && <span className="mono">{p.folder}</span>}
                    </button>
                  ))}
                <button type="button" className={`seg-opt${project === 'create' ? ' on' : ''}`} onClick={() => setProject('create')}>
                  <b>{tr('newSession.createName')}</b>
                  <span>{tr('newSession.createHint')}</span>
                </button>
              </div>
            </div>
            {project === 'create' && (
              <>
                <div className="field">
                  <label htmlFor={`${titleId}-pname`}>{tr('newSession.name')}</label>
                  <input id={`${titleId}-pname`} className="input" value={projectName} onChange={e => setProjectName(e.target.value)} />
                </div>
                <ProjectFolderField id={`${titleId}-pfolder`} value={projectFolder} runner={runner} onChange={setProjectFolder} />
                <div className="field">
                  <label htmlFor={`${titleId}-pdesc`}>{tr('newSession.description')}</label>
                  <input id={`${titleId}-pdesc`} className="input" value={projectDescription} onChange={e => setProjectDescription(e.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor={`${titleId}-premote`}>{tr('newSession.remote')}</label>
                  <input id={`${titleId}-premote`} className="input mono" value={projectRemote} onChange={e => setProjectRemote(e.target.value)} placeholder={tr('newSession.remotePlaceholder')} />
                </div>
              </>
            )}
            {runner && project !== 'create' && <span className="hint">{tr('newSession.startsIn', { path: startFolder(runner, projects.find(p => p.id === project)?.folder) ?? '' })}</span>}
            {errors.cwd && (
              <span className="field-error" role="alert">
                {errors.cwd}
              </span>
            )}
            <div className="row2">
              <div className="field">
                <label htmlFor={`${titleId}-mode`}>{tr('newSession.mode')}</label>
                <select
                  id={`${titleId}-mode`}
                  className="input"
                  value={mode}
                  onChange={e => {
                    setModeTouched(true);
                    setMode(e.target.value as UiPermissionMode);
                  }}
                  aria-describedby={noBypass ? `${titleId}-mode-hint` : undefined}
                >
                  {UI_PERMISSION_MODES.map(m => (
                    <option key={m} value={m} disabled={noBypass && m === 'bypassPermissions'}>
                      {noBypass && m === 'bypassPermissions' ? tr('newSession.modeNoRoot', { mode: m }) : m}
                    </option>
                  ))}
                </select>
                {noBypass && (
                  <span className="hint" id={`${titleId}-mode-hint`}>
                    {tr('newSession.rootHint', { machine: runner?.name ?? '' })}
                  </span>
                )}
              </div>
              <div className="field">
                <label htmlFor={`${titleId}-model`}>{tr('newSession.model')}</label>
                <select id={`${titleId}-model`} className="input" value={model} onChange={e => setModel(e.target.value)}>
                  {models.map(m => (
                    <option key={m.value} value={m.value}>
                      {m.displayName}
                    </option>
                  ))}
                </select>
              </div>
            </div>
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
            {errors.form && (
              <div className="err-box" role="alert">
                {errors.form}
                {canRetry && (
                  <button type="button" className="btn attach-retry" disabled={busy} onClick={e => void submit(e)}>
                    {tr('newSession.retry')}
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="modal-foot">
            <span className="hint foot-hint">{tr('newSession.ctrlEnter')}</span>
            <button type="button" className="btn ghost" onClick={onClose}>
              {tr('newSession.cancel')}
            </button>
            <button type="submit" className="btn primary" disabled={busy || uploading || !!sub.blocked} title={uploading ? tr('newSession.uploading') : sub.blocked}>
              {busy ? tr('newSession.starting') : tr('newSession.start')}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
