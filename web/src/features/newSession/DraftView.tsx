/**
 * The new-session draft tab (change new-session-draft-tab): the launch chips — machine, agent, project, model, mode,
 * subscription — over the same composer as a running session; sending launches the session and the tab becomes its tab.
 * Requirements (new-session-draft): Чипы запуска; Чип проекта; Запуск из черновика; Ошибка запуска; Черновик на телефоне.
 * The choices live in `useDrafts` by the draft id, the text in `st.drafts`, the attachments in `useAttachments`: the
 * workspace renders only the active tab, the draft must survive switching tabs.
 * API: POST /api/sessions → 201 / 409 runner_offline (the machine chip) / 422 cwd_not_found (the project chip) /
 * 422 subscription_unavailable (the subscription chip) / 502 attachment_delivery_failed (the banner with «Повторить»).
 */
import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { PROVIDER_LABELS, PROVIDERS, UI_PERMISSION_MODES, bypassUnavailable, type EffortLevel, type RunnerView } from '../../api/types';
import { usableRunner, useStore } from '../../store';
import { useT } from '../../i18n';
import { useMenu } from '../ui/a11y';
import { addFiles, busy as attachmentsBusy, clearAttachments, filesOf, readyRefs, useAttachments } from '../images/attachments';
import { AttachButton, AttachmentStrip } from '../images/AttachmentStrip';
import { MicButton } from '../voice/MicButton';
import { VoiceBar, VoiceNote, shownHere } from '../voice/VoiceBar';
import { claimDictation, finishDictation, useVoice } from '../voice/voice';
import { createSession, moveToProject } from '../workspace/actions';
import { subscriptionChoice, unavailableText } from '../subscriptions/SubscriptionField';
import { activeSubs, choiceWarning, formField, optionLabel, outdatedText, subName } from '../subscriptions/model';
import { ProjectPicker, type Row } from '../projects/ProjectButton';
import { startFolder } from '../projects/ProjectFolderField';
import { providerModels, providerSubline, providerUnavailable } from './ProviderField';
import { chooseInDraft, patchDraft, useDrafts, type Draft, type DraftField } from './draftStore';

export function DraftView({ draftId, paneId }: { draftId: string; paneId: string }) {
  const d = useDrafts(s => s.byId[draftId]);
  if (!d) return null;
  return <DraftBody draftId={draftId} paneId={paneId} d={d} />;
}

/** The values the launch uses: the draft's choices where they still fit the machine, the defaults otherwise. */
function useLaunch(draftId: string, d: Draft) {
  const all = useStore(s => s.runners);
  const claudeModels = useStore(s => s.models);
  const subs = useStore(s => s.subs);
  const runners = all.filter(usableRunner);
  const runner = d.runnerId ? runners.find(r => r.id === d.runnerId) : runners.find(r => r.online);
  // another machine without the chosen agent: back to Claude
  const provider = d.provider !== 'claude' && providerUnavailable(runner, d.provider) ? 'claude' : d.provider;
  const noBypass = bypassUnavailable(runner);
  const mode = noBypass && (d.mode ?? 'bypassPermissions') === 'bypassPermissions' ? 'acceptEdits' : (d.mode ?? 'bypassPermissions');
  const models = providerModels(runner, provider, claudeModels);
  const model = models.some(m => m.value === d.model) ? d.model : (models[0]?.value ?? '');
  // session-effort D7: the levels come from the model's entry; a level the model does not have is dropped
  const efforts = provider === 'claude' ? (models.find(m => m.value === model)?.efforts ?? []) : [];
  const effort = (efforts as string[]).includes(d.effort) ? d.effort : '';
  const sub = subscriptionChoice(
    subs,
    runner,
    provider,
    d.subPicked,
    d.subUnavailable,
    id => chooseInDraft(draftId, 'subscription', { subPicked: id }),
    id => patchDraft(draftId, { subUnavailable: id }),
  );
  return { runners, runner, provider, noBypass, mode, models, model, efforts, effort, sub, subs };
}

const FIELD_OF: Record<string, DraftField> = { cwd: 'project', runner: 'runner', subscription: 'subscription', form: 'form' };

function DraftBody({ draftId, paneId, d }: { draftId: string; paneId: string; d: Draft }) {
  const t = useT();
  const l = useLaunch(draftId, d);
  const projects = useDrafts(s => s.projects);
  const folder = projects?.find(p => p.id === d.project)?.folder;
  const launch = async () => {
    const text = useStore.getState().drafts[draftId] ?? '';
    const images = readyRefs(draftId);
    if (d.busy || attachmentsBusy(draftId) || (!text.trim() && !images.length)) return;
    const fail = (field: DraftField, message: string) => patchDraft(draftId, { error: { field, message }, canRetry: false });
    if (!l.runner || !l.runner.online) return fail('runner', t('newSession.err.runner'));
    if (l.sub.blocked) return fail('subscription', l.sub.blocked);
    if (!l.model) return fail('model', t('newSession.err.noModels'));
    const explicit = d.project !== 'auto' && d.project !== 'none' ? d.project : undefined;
    patchDraft(draftId, { busy: true, error: null, canRetry: false });
    const r = await createSession(
      {
        runnerId: l.runner.id,
        permissionMode: l.mode,
        model: l.model,
        ...(l.effort ? { effort: l.effort as EffortLevel } : {}),
        prompt: text.trim(),
        ...(images.length ? { attachments: images } : {}),
        ...(l.provider !== 'claude' ? { provider: l.provider } : {}),
        ...(explicit ? { projectId: explicit } : {}),
        ...(l.sub.send ? { subscriptionId: l.sub.send } : {}),
      },
      l.runner.name,
      draftId,
    );
    if (r.ok) {
      clearAttachments(draftId);
      // «Без проекта»: the manual pin right after the launch overrides the classifier (design: Проект)
      if (d.project === 'none') await moveToProject(r.session.id, 'none');
      return;
    }
    if (r.field === 'subscription') l.sub.markUnavailable();
    patchDraft(draftId, { busy: false, error: { field: FIELD_OF[r.field] ?? 'form', message: r.message }, canRetry: r.retry === true });
  };
  return (
    <div className="draft">
      <div className="draft-space" />
      <DraftChips draftId={draftId} d={d} l={l} folder={folder} />
      {d.error && (
        <div className="err-box draft-err" role="alert">
          {d.error.field === 'subscription' && d.subUnavailable ? unavailableText(l.subs, d.subUnavailable, l.sub.value) : d.error.message}
          {d.canRetry && (
            <button type="button" className="btn attach-retry" disabled={d.busy} onClick={() => void launch()}>
              {t('newSession.retry')}
            </button>
          )}
        </div>
      )}
      <DraftComposer draftId={draftId} paneId={paneId} busy={d.busy} onSend={() => void launch()} />
    </div>
  );
}

type Launch = ReturnType<typeof useLaunch>;

function DraftChips({ draftId, d, l, folder }: { draftId: string; d: Draft; l: Launch; folder: string | null | undefined }) {
  const t = useT();
  const bad = (f: DraftField) => d.error?.field === f;
  const subField = formField(l.subs, l.runner, l.provider);
  const subList = activeSubs(l.subs, l.provider);
  const pickRunner = (r: RunnerView) => chooseInDraft(draftId, 'runner', { runnerId: r.id, touched: { ...d.touched, runner: true } });
  const projectLabel = d.project === 'auto' ? t('newSession.autoName') : d.project === 'none' ? t('projects.none') : d.projectTitle;
  const hint = l.runner ? t('newSession.startsIn', { path: startFolder(l.runner, d.project === 'auto' || d.project === 'none' ? null : folder) ?? '' }) : null;
  const auto: Row = { key: 'auto', kind: 'auto', id: 'auto', title: t('newSession.autoName'), colorKey: 'none', path: '', tag: '', archived: false };
  return (
    <div className="draft-chips" role="group" aria-label={t('newSession.chips')}>
      <Chip label={t('newSession.chip.machine')} value={l.runner?.name ?? t('newSession.chip.noMachine')} invalid={bad('runner')}>
        {close =>
          l.runners.map(r => (
            <Option
              key={r.id}
              on={r.id === l.runner?.id}
              disabled={!r.online}
              title={r.name}
              sub={r.online ? (r.os ?? t('machines.status.online')) : t('machines.status.offline')}
              onPick={() => {
                pickRunner(r);
                close();
              }}
            />
          ))
        }
      </Chip>
      <Chip label={t('newSession.provider.label')} value={PROVIDER_LABELS[l.provider]}>
        {close =>
          PROVIDERS.map(p => {
            const why = providerUnavailable(l.runner, p);
            return (
              <Option
                key={p}
                on={p === l.provider}
                disabled={!!why}
                title={PROVIDER_LABELS[p]}
                sub={why ?? providerSubline(l.runner, p)}
                onPick={() => {
                  chooseInDraft(draftId, 'form', { provider: p, touched: { ...d.touched, provider: true } });
                  close();
                }}
              />
            );
          })
        }
      </Chip>
      <Chip label={t('newSession.project')} value={projectLabel} invalid={bad('project')} wide>
        {close => (
          <ProjectPicker
            listId={draftId}
            current={d.project}
            extra={[auto]}
            onPick={row => {
              chooseInDraft(draftId, 'project', { project: row.id, projectTitle: row.title });
              close();
            }}
            foot={hint && <div className="proj-foot hint">{hint}</div>}
          />
        )}
      </Chip>
      <Chip label={t('newSession.model')} value={l.models.find(m => m.value === l.model)?.displayName ?? '—'} invalid={bad('model')}>
        {close =>
          l.models.map(m => (
            <Option
              key={m.value}
              on={m.value === l.model}
              title={m.displayName}
              onPick={() => {
                chooseInDraft(draftId, 'model', { model: m.value, effort: '' });
                close();
              }}
            />
          ))
        }
      </Chip>
      {l.efforts.length > 0 && (
        <Chip label={t('newSession.effort')} value={l.effort || t('chat.selects.default')}>
          {close =>
            ['', ...l.efforts].map(e => (
              <Option
                key={e}
                on={e === l.effort}
                title={e || t('chat.selects.default')}
                onPick={() => {
                  chooseInDraft(draftId, 'form', { effort: e });
                  close();
                }}
              />
            ))
          }
        </Chip>
      )}
      <Chip label={t('newSession.mode')} value={l.mode} bypass={l.mode === 'bypassPermissions'}>
        {close => (
          <>
            {UI_PERMISSION_MODES.map(m => (
              <Option
                key={m}
                on={m === l.mode}
                disabled={l.noBypass && m === 'bypassPermissions'}
                title={l.noBypass && m === 'bypassPermissions' ? t('newSession.modeNoRoot', { mode: m }) : m}
                onPick={() => {
                  chooseInDraft(draftId, 'form', { mode: m });
                  close();
                }}
              />
            ))}
            {l.noBypass && <div className="hint chip-note">{t('newSession.rootHint', { machine: l.runner?.name ?? '' })}</div>}
          </>
        )}
      </Chip>
      {subField === 'outdated' && (
        <span className="pill hint" role="note">
          {outdatedText(l.runner?.name ?? t('subscriptions.field.machineFallback'))}
        </span>
      )}
      {subField === 'select' && (
        <Chip label={t('subscriptions.field.label')} value={subName(l.subs, l.sub.value) ?? '—'} invalid={bad('subscription') || !!l.sub.blocked}>
          {close => {
            const warning = choiceWarning(subList.find(s => s.id === l.sub.value));
            return (
              <>
                {subList.map(s => (
                  <Option
                    key={s.id}
                    on={s.id === l.sub.value}
                    title={optionLabel(s)}
                    onPick={() => {
                      l.sub.pick(s.id);
                      close();
                    }}
                  />
                ))}
                {(l.sub.blocked ?? warning) && <div className="hint chip-note">{l.sub.blocked ?? warning?.text}</div>}
              </>
            );
          }}
        </Chip>
      )}
    </div>
  );
}

/** A chip with its list: a popover on the desktop, a bottom sheet on the phone (`.chip-menu` in app.css). */
function Chip({ label, value, invalid, bypass, wide, children }: { label: string; value: string; invalid?: boolean; bypass?: boolean; wide?: boolean; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    btn.current?.focus();
  };
  useMenu(open, box, close);
  // the project list: the search field gets the focus, not the first option
  useEffect(() => {
    if (open) box.current?.querySelector<HTMLElement>('input')?.focus();
  }, [open]);
  return (
    <span ref={box} className="proj-box">
      <button
        ref={btn}
        type="button"
        className={`pill chip${invalid ? ' invalid' : ''}${bypass ? ' bypass' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-invalid={invalid || undefined}
        aria-label={`${label}: ${value}`}
        onClick={() => setOpen(!open)}
      >
        <span className="chip-k">{label}</span>
        <span className="chip-v">{value}</span>
        <span className="caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <>
          <div className="proj-backdrop" aria-hidden="true" onClick={close} />
          <div className={`menu chip-menu${wide ? ' proj-menu' : ''}`} role={wide ? 'dialog' : 'menu'} aria-label={label}>
            {children(close)}
          </div>
        </>
      )}
    </span>
  );
}

function Option({ on, disabled, title, sub, onPick }: { on: boolean; disabled?: boolean; title: string; sub?: string; onPick: () => void }) {
  return (
    <button type="button" role="menuitemradio" aria-checked={on} className={on ? 'on' : undefined} disabled={disabled} onClick={onPick}>
      <span className="opt-t">{title}</span>
      {sub && <span className="opt-s">{sub}</span>}
    </button>
  );
}

/** The composer of the draft: the session composer without the conversation, the queue and «Прервать». */
function DraftComposer({ draftId, paneId, busy, onSend }: { draftId: string; paneId: string; busy: boolean; onSend: () => void }) {
  const t = useT();
  const draft = useStore(st => st.drafts[draftId] ?? '');
  const setDraft = (v: string) => useStore.setState({ drafts: { ...useStore.getState().drafts, [draftId]: v } });
  const atts = useAttachments(a => a.byKey[draftId]);
  const ready = !!atts?.some(a => a.status === 'ready');
  const loading = !!atts && attachmentsBusy(draftId);
  const empty = !draft.trim() && !ready;
  const phone = useStore(x => x.device === 'phone');
  const area = useRef<HTMLTextAreaElement>(null);
  const voiceOn = useStore(x => x.auth.kind === 'signed_in' && !!x.auth.me.voiceInput);
  const recordingHere = useVoice(v => shownHere(v.active, draftId, paneId));
  const orphan = useVoice(v => !!v.active && v.active.sessionId === draftId && v.active.paneId === null && v.active.phase !== 'starting');
  useLayoutEffect(() => {
    if (orphan) claimDictation(draftId, paneId);
  }, [orphan, draftId, paneId]);
  useEffect(
    () => () => {
      const a = useVoice.getState().active;
      if (a && a.sessionId === draftId && a.paneId === paneId) void finishDictation({ detach: true });
    },
    [draftId, paneId],
  );
  useEffect(() => {
    area.current?.focus();
  }, []);
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    // the field grows with the text up to five lines, then scrolls inside (as the session composer)
    el.style.height = 'auto';
    const cs = getComputedStyle(el);
    const line = parseFloat(cs.lineHeight) || 21;
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const min = parseFloat(cs.minHeight) || 0;
    el.style.height = `${Math.max(min, Math.min(el.scrollHeight + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth), line * 5 + pad))}px`;
  }, [draft, phone, recordingHere]);
  const send = () => {
    if (!empty && !loading && !busy) onSend();
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };
  const take = (e: ClipboardEvent<HTMLTextAreaElement> | DragEvent<HTMLTextAreaElement>, data: DataTransfer) => {
    const files = filesOf(data);
    if (!files.length) return;
    e.preventDefault();
    addFiles(draftId, files);
  };
  return (
    <div className="composer">
      <div className="composer-inner">
        {recordingHere ? (
          <div className="voice-row">
            <VoiceBar sessionId={draftId} />
          </div>
        ) : (
          <>
            <AttachmentStrip akey={draftId} />
            <textarea
              ref={area}
              rows={1}
              data-composer={paneId}
              data-session={draftId}
              placeholder={phone ? t('newSession.placeholderPhone') : t('newSession.placeholder')}
              aria-label={t('newSession.firstMessage')}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={onKey}
              onPaste={e => take(e, e.clipboardData)}
              onDragOver={e => {
                if ([...e.dataTransfer.types].includes('Files')) e.preventDefault();
              }}
              onDrop={e => take(e, e.dataTransfer)}
            />
            <div className="composer-row">
              <div className="left">
                <AttachButton akey={draftId} />
                {voiceOn && <MicButton sessionId={draftId} paneId={paneId} />}
              </div>
              <div className="left">
                <button
                  type="button"
                  className="btn c-send primary"
                  aria-label={t('newSession.start')}
                  disabled={empty || loading || busy}
                  onClick={send}
                  title={loading ? t('newSession.uploading') : t('newSession.start')}
                >
                  <svg className="ico" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
                  </svg>
                  <span className="lbl">{busy ? t('newSession.starting') : t('newSession.start')}</span>
                </button>
              </div>
            </div>
          </>
        )}
      </div>
      <VoiceNote sessionId={draftId} />
    </div>
  );
}
