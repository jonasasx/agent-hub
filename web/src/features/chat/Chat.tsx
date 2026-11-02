/**
 * Chat of one session (docs/prototype.html chat(), banner(), composer()).
 * Requirements (sessions): Обмен сообщениями; Карточка разрешения; Прерывание хода; Смена режима прав и модели на
 * ходу; Статусы сессии; Засыпание по простою («уснёт через N мин», override of the timeout); Продолжение (resume);
 * Продолжение сессий, начатых вне хаба (warning); Офлайн-машина; Cron-сессии только для чтения;
 * Восстановление .jsonl из S3 перед resume (read-only banner).
 * Requirement (workspace-ui): Строка проекта под шапкой чата.
 * Requirement (runner-enrollment): Экран «Машины» — scenario «Нет входа в Claude»: the plaque in the session header.
 * Requirements (voice-input): Включение диктовки; Кнопка микрофона в композере; Запись голоса; Запись при смене
 * контекста.
 * API: GET /api/sessions/:id/events, POST …/messages, …/wake, …/interrupt, PATCH /api/sessions/:id,
 * POST …/permissions/:requestId (D10).
 */
import { Fragment, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ClipboardEvent, type CSSProperties, type DragEvent, type KeyboardEvent } from 'react';
import { useMenu } from '../ui/a11y';
import { IDLE_TIMEOUT_CHOICES, PROVIDER_LABELS, UI_PERMISSION_MODES, bypassUnavailable, type SessionView, type UiPermissionMode } from '../../api/types';
import { providerModels } from '../newSession/ProviderField';
import { projectKey, useStore } from '../../store';
import { Glyph } from '../sessions/Glyph';
import { childrenWorking, clockLabel, colorVar, displayStatus, externalText, isReadOnly, readOnlyText, runnerIndex, sleepsInMin, SOURCE_LABEL, statusText } from '../sessions/status';
import { cancelResume, confirmResume, decide, idleLabel, interrupt, loadOlder, retryLog, openSession, patchSession, sendMessage, wake } from '../workspace/actions';
import { ChatItemView, ItemBoundary } from './ChatItems';
import { AgentProvider } from './agentName';
import { ProviderIcon } from './ProviderIcon';
import { ProjectLine } from '../projects/ProjectButton';
import { ImageSourceContext, Markdown } from './Markdown';
import { buildChat, finishedMessageIds, knownLocalImages, matchPending, pendingSlot, type Undelivered } from './transcript';
import { addFiles, busy as attachmentsBusy, filesOf, restoreAttachments, settleOptimistic, useAttachments } from '../images/attachments';
import { AttachButton, AttachmentStrip } from '../images/AttachmentStrip';
import { ImageGroup } from '../images/ImagePreview';
import { SubagentHead, SubagentScope, SubagentsButton, UserLabel, subagentColor, useSubagentParent } from '../subagents/SubagentViews';
import { subTitle } from '../subagents/model';
import { CommandBox } from '../machines/EnrollModal';
import { claudeLoginCommand, needsClaudeLogin } from '../machines/machines';
import { MicButton } from '../voice/MicButton';
import { VoiceBar, VoiceNote, shownHere } from '../voice/VoiceBar';
import { claimDictation, finishDictation, useVoice } from '../voice/voice';
import { HeadSubscription } from '../subscriptions/HeadSubscription';
import { LimitChip } from '../limits/LimitChip';
import { switchSubscription } from '../subscriptions/actions';
import { McpButton, McpMenuItem, McpPanelHost } from '../mcp/McpViews';

/**
 * Current time for «уснёт через N мин» (D11, M2.1): N = ceil((sleepsAt − now) / 1 min), so the component re-renders
 * right after the next change of N — ((sleepsAt − now) mod 1 min) + 50 ms — and when the page becomes visible again
 * (timers of a hidden page are throttled). Requirement (sessions): Засыпание по простою, scenario «Отсчёт до сна».
 */
export function useSleepClock(sleepsAt: string | null): number {
  const [, tick] = useReducer((x: number) => x + 1, 0);
  const now = Date.now();
  useEffect(() => {
    const onVisible = () => tick();
    document.addEventListener('visibilitychange', onVisible);
    let t: ReturnType<typeof setTimeout> | null = null;
    const left = sleepsAt ? Date.parse(sleepsAt) - Date.now() : 0;
    if (left > 0) t = setTimeout(onVisible, (left % 60_000 || 60_000) + 50);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      if (t) clearTimeout(t);
    };
  });
  return now;
}

function Banner({ s }: { s: SessionView }) {
  const runners = useStore(st => st.runners);
  const idx = runnerIndex(runners);
  const r = idx[s.runnerId];
  const name = r?.name ?? s.runnerId;
  const st = displayStatus(s, idx);
  const ro = readOnlyText(s);
  if (st === 'offline')
    return (
      <div className="banner" role="status">
        <span className="dot bad" />
        <div className="b-text">
          <b>
            {name} не в сети с {clockLabel(r?.lastSeenAt ?? null)}.
          </b>
          <span className="b-long"> История — из копии в хабе, продолжить можно, когда машина вернётся.</span>
        </div>
        <button type="button" className="btn" onClick={() => useStore.setState({ modal: { type: 'fork', sessionId: s.id, mode: 'handoff' } })}>
          Handoff на другую машину
        </button>
      </div>
    );
  const ext = externalText(s);
  if (ext && st === 'external')
    return (
      <div className="banner" role="status">
        <span className="g-work" />
        <div className="b-text">
          <b>Сессия {ext}</b> на {name}
          <span className="b-long">. Хаб показывает её из копии; отправить сообщение отсюда — когда она остановится там.</span>
        </div>
      </div>
    );
  if (ro)
    return (
      <div className="banner" role="status">
        <div className="b-text">
          <b>{s.status === 'closed' ? 'Завершённая сессия' : 'Только чтение'}</b> · источник: {SOURCE_LABEL[s.originSource ?? s.source]}. {ro}
        </div>
      </div>
    );
  if (st === 'sleeping')
    return (
      <div className="banner" role="status">
        <span className="g-sleep" />
        <div className="b-text">
          <b>Спит с {clockLabel(s.sleptAt)}.</b>
          <span className="b-long"> Процесс завершён, история на диске. Сообщение или «Продолжить» поднимут её через resume.</span>
        </div>
        <button type="button" className="btn primary" onClick={() => void wake(s.id)}>
          Продолжить
        </button>
      </div>
    );
  if (st === 'closed')
    return (
      <div className="banner" role="status">
        <div className="b-text">
          <b>Завершённая сессия</b> · источник: {SOURCE_LABEL[s.originSource ?? s.source]}. Отправь сообщение — поднимется через resume на {name}.
        </div>
      </div>
    );
  return null;
}

/** «Нет входа в Claude» on the machine of the session (hello.claude / agent.status of agents 1.5). */
export function ClaudeLoginBanner({ s }: { s: SessionView }) {
  const runner = useStore(st => st.runners.find(r => r.id === s.runnerId));
  // a Codex session does not need the machine's Claude login (provider-parity)
  if (s.provider === 'codex' || !runner || !needsClaudeLogin(runner)) return null;
  return (
    <div className="banner warn" role="status">
      <span className="g-perm" aria-hidden="true">
        !
      </span>
      <div className="b-text">
        <b>Нет входа в Claude на {runner.name}.</b>
        <span className="b-long"> Ход не запустится, пока не войдёте. Выполните на машине:</span>
        <CommandBox command={claudeLoginCommand(runner.os)} label={`Команда входа в Claude на ${runner.name}`} />
      </div>
    </div>
  );
}

function ResumeWarning({ s }: { s: SessionView }) {
  const pending = useStore(st => st.pendingResume[s.id]);
  const runner = useStore(st => st.runners.find(r => r.id === s.runnerId));
  if (!pending) return null;
  return (
    <div className="banner warn" role="alertdialog" aria-label="Сессия, возможно, открыта в терминале">
      <span className="g-perm" aria-hidden="true">
        !
      </span>
      <div className="b-text">
        <b>Сессия, возможно, открыта в терминале на {runner?.name ?? s.runnerId}.</b> Файл сессии менялся вне хаба за последние 10 минут — второй процесс может испортить историю.
      </div>
      <button type="button" className="btn" onClick={() => cancelResume(s.id)}>
        Отмена
      </button>
      <button type="button" className="btn primary" onClick={() => void confirmResume(s.id)}>
        Продолжить всё равно
      </button>
    </div>
  );
}

function IdleControl({ s }: { s: SessionView }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useMenu(open, box, () => setOpen(false));
  const now = useSleepClock(s.status === 'waiting' ? s.sleepsAt : null);
  const mins = sleepsInMin(s, now);
  // one source for the label and the checked item: the timeout the hub applies now
  const current = s.effectiveIdleTimeoutMin;
  const label = mins !== null ? `уснёт через ${mins} мин` : current === 0 ? 'не усыплять' : `усыплять через ${idleLabel(current)}`;
  return (
    <span ref={box} style={{ position: 'relative' }}>
      ·{' '}
      <button type="button" className="idle-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} title="Таймаут простоя">
        {label}
      </button>
      {open && (
        <div className="menu" role="menu" aria-label="Усыплять при простое">
          <div className="m-title">Усыплять при простое</div>
          {IDLE_TIMEOUT_CHOICES.map(m => (
            <button
              key={m}
              type="button"
              role="menuitemradio"
              aria-checked={current === m}
              className={current === m ? 'on' : ''}
              onClick={() => {
                setOpen(false);
                void patchSession(s.id, { idleTimeoutMin: m });
              }}
            >
              {m === 0 ? 'не усыплять' : `через ${idleLabel(m)}`}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/**
 * Mode and model behind «⋯» — shown instead of the inline selects in a narrow pane (container query) and in the
 * phone top bar (UI review H1, M10).
 */
export function ModeModelMenu({ s }: { s: SessionView }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useMenu(open, box, () => setOpen(false));
  const ro = useStore(st => isReadOnly(s, runnerIndex(st.runners)));
  return (
    <span className="ctl-more" ref={box}>
      <button type="button" className="icon-btn" aria-haspopup="menu" aria-expanded={open} aria-label="Режим прав и модель" title="Режим прав и модель" onClick={() => setOpen(!open)}>
        ⋯
      </button>
      {open && (
        <div className="menu" role="menu" aria-label="Режим прав и модель">
          <button
            type="button"
            role="menuitem"
            className="btn menu-fork"
            onClick={() => {
              setOpen(false);
              useStore.setState({ modal: { type: 'fork', sessionId: s.id } });
            }}
          >
            ⑂ Форк…
          </button>
          <McpMenuItem s={s} onPick={() => setOpen(false)} />
          {/* UI review C1: a pick closes the menu, so «Идёт ход: прервать и переключить?» is not under it */}
          <ModeModelSelects s={s} disabled={ro} onSubscriptionPicked={() => setOpen(false)} />
          {!ro && (
            <label className="phone-only">
              Усыплять при простое
              <select className="mini" aria-label="Усыплять при простое" value={String(s.effectiveIdleTimeoutMin)} onChange={e => void patchSession(s.id, { idleTimeoutMin: Number(e.target.value) })}>
                {IDLE_TIMEOUT_CHOICES.map(m => (
                  <option key={m} value={m}>
                    {m === 0 ? 'не усыплять' : `через ${idleLabel(m)}`}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
    </span>
  );
}

function ModeModelSelects({ s, disabled, inline, onSubscriptionPicked }: { s: SessionView; disabled: boolean; inline?: boolean; onSubscriptionPicked?: () => void }) {
  const provider = s.provider ?? 'claude';
  const claudeModels = useStore(st => st.models);
  const runner = useStore(st => st.runners.find(r => r.id === s.runnerId));
  // agent-providers: a Codex session — the models its machine reported; its subscription is shown like Claude's (provider-parity)
  const models = providerModels(runner, provider, claudeModels);
  // runner-enrollment «Запуск под root»: the agent of this machine runs as root, Claude Code refuses bypassPermissions
  const noBypass = provider === 'claude' && bypassUnavailable(runner);
  const modelOptions = s.model && !models.some(m => m.value === s.model) ? [{ value: s.model, displayName: s.model }, ...models] : models;
  const mode = (
    <select className="mini" aria-label="Режим прав" disabled={disabled} value={s.permissionMode} onChange={e => void patchSession(s.id, { permissionMode: e.target.value as UiPermissionMode })}>
      {/* a mode the process reported that is not in the list (plan, a new mode of the SDK): shown as it is */}
      {!(UI_PERMISSION_MODES as readonly string[]).includes(s.permissionMode) && (
        <option value={s.permissionMode} disabled>
          {s.permissionMode}
        </option>
      )}
      {UI_PERMISSION_MODES.map(m => (
        <option key={m} value={m} disabled={noBypass && m === 'bypassPermissions'} title={noBypass && m === 'bypassPermissions' ? 'Агент работает под root — bypassPermissions недоступен' : undefined}>
          {noBypass && m === 'bypassPermissions' ? `${m} — недоступен под root` : m}
        </option>
      ))}
    </select>
  );
  const model = (
    <select className="mini" aria-label="Модель" disabled={disabled} value={s.model ?? ''} onChange={e => void patchSession(s.id, { model: e.target.value })}>
      {!s.model && <option value="">по умолчанию</option>}
      {modelOptions.map(m => (
        <option key={m.value} value={m.value}>
          {m.displayName}
        </option>
      ))}
    </select>
  );
  if (inline)
    return (
      <span className="ctl-inline">
        {mode}
        {model}
        <HeadSubscription s={s} inline />
      </span>
    );
  return (
    <>
      <label>Режим прав{mode}</label>
      <label>Модель{model}</label>
      <HeadSubscription s={s} onPicked={onSubscriptionPicked} />
    </>
  );
}

function ClassLine({ s }: { s: SessionView }) {
  const ro = useStore(st => isReadOnly(s, runnerIndex(st.runners)));
  return (
    <div className="classline">
      <ProjectLine s={s} />
      {!ro && <IdleControl s={s} />}
    </div>
  );
}

/**
 * Phone (≤760 px): the state of the session (the banner) and the project in one line under the top bar — the project
 * button, a short state with the whole text in the tooltip, «Продолжить» of a sleeping session; the idle timeout,
 * mode and model live behind «⋯» (Ivan, M4a: the feed gets ≥ 75% of the screen).
 */
function PhoneInfo({ s }: { s: SessionView }) {
  const runners = useStore(st => st.runners);
  const idx = runnerIndex(runners);
  const r = idx[s.runnerId];
  const name = r?.name ?? s.runnerId;
  const st = displayStatus(s, idx);
  const ro = readOnlyText(s);
  const source = SOURCE_LABEL[s.originSource ?? s.source];
  const ext = externalText(s);
  const [short, long] =
    ext && st === 'external'
      ? [ext, `Сессия ${ext} на ${name}. Хаб показывает её из копии.`]
      : st === 'offline'
        ? [`${name} не в сети`, `${name} не в сети с ${clockLabel(r?.lastSeenAt ?? null)}. История — из копии в хабе, продолжить можно, когда машина вернётся.`]
        : ro
          ? [s.status === 'closed' ? 'завершена' : 'только чтение', `${s.status === 'closed' ? 'Завершённая сессия' : 'Только чтение'} · источник: ${source}. ${ro}`]
          : st === 'sleeping'
            ? [`спит с ${clockLabel(s.sleptAt)}`, 'Процесс завершён, история на диске. Сообщение или «Продолжить» поднимут её через resume.']
            : st === 'closed'
              ? ['завершена', `Завершённая сессия · источник: ${source}. Отправь сообщение — поднимется через resume на ${name}.`]
              : [null, null];
  return (
    <div className="classline phone-info" role={short ? 'status' : undefined}>
      <ProjectLine s={s} note={short ?? undefined} noteTitle={long ?? undefined} />
      <SubagentsButton s={s} compact />
      <McpButton s={s} compact />
      <LimitChip s={s} phone />
      {st === 'sleeping' && (
        <button type="button" className="btn primary" onClick={() => void wake(s.id)}>
          Продолжить
        </button>
      )}
      {st === 'offline' && (
        <button type="button" className="btn" onClick={() => useStore.setState({ modal: { type: 'fork', sessionId: s.id, mode: 'handoff' } })}>
          Handoff
        </button>
      )}
    </div>
  );
}

function Composer({ s, paneId }: { s: SessionView; paneId: string }) {
  const runners = useStore(st => st.runners);
  const draft = useStore(st => st.drafts[s.id] ?? '');
  const modelName = useStore(st => st.models.find(m => m.value === s.model)?.displayName ?? s.model ?? 'модель по умолчанию');
  const idx = runnerIndex(runners);
  const st = displayStatus(s, idx);
  const disabled = isReadOnly(s, idx);

  const setDraft = (v: string) => useStore.setState({ drafts: { ...useStore.getState().drafts, [s.id]: v } });
  const atts = useAttachments(a => a.byKey[s.id]);
  const ready = !!atts?.some(a => a.status === 'ready');
  const loading = !!atts && attachmentsBusy(s.id);
  // with an image the message may go without text (chat-images «Прикрепление изображений к сообщению»)
  const empty = !draft.trim() && !ready;
  // the phone composer is one row: the field grows with the text up to five lines
  const phone = useStore(x => x.device === 'phone');
  // one line on the phone: the placeholder must not wrap the empty field into two lines
  const bypass = s.permissionMode === 'bypassPermissions';
  const placeholder = disabled
    ? 'Недоступно'
    : st === 'sleeping' || st === 'closed'
      ? phone
        ? 'Сообщение (через resume)…'
        : 'Сообщение поднимет сессию через resume…'
      : phone
        ? bypass
          ? 'Сообщение · bypass'
          : 'Сообщение…'
        : `Сообщение для ${PROVIDER_LABELS[s.provider ?? 'claude']}… (Enter — отправить)`;
  const area = useRef<HTMLTextAreaElement>(null);
  // dictation (voice-input): the button only when the hub has an ElevenLabs key; the bar instead of the field
  const voiceOn = useStore(x => x.auth.kind === 'signed_in' && !!x.auth.me.voiceInput);
  const recordingHere = useVoice(v => shownHere(v.active, s.id, paneId));
  // a dictation of this session left without a composer comes back to the first composer of the session on screen
  const orphan = useVoice(v => !!v.active && v.active.sessionId === s.id && v.active.paneId === null && v.active.phase !== 'starting');
  useLayoutEffect(() => {
    if (orphan) claimDictation(s.id, paneId);
  }, [orphan, s.id, paneId]);
  // the composer goes away (another tab in the pane, the pane closed, another phone screen) while recording here:
  // the recording finishes as «Готово», the text lands in this session's draft (Requirement «Запись при смене контекста»)
  useEffect(
    () => () => {
      const a = useVoice.getState().active;
      if (a && a.sessionId === s.id && a.paneId === paneId) void finishDictation({ detach: true });
    },
    [s.id, paneId],
  );
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    // the field grows with the text up to five lines (phone and desktop), then scrolls inside
    el.style.height = 'auto';
    const cs = getComputedStyle(el);
    const line = parseFloat(cs.lineHeight) || 21;
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const min = parseFloat(cs.minHeight) || 0;
    el.style.height = `${Math.max(min, Math.min(el.scrollHeight + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth), line * 5 + pad))}px`;
  }, [draft, phone, recordingHere]);
  const send = () => {
    if (!disabled && !empty && !loading) void sendMessage(s.id, draft);
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = filesOf(e.clipboardData);
    if (!files.length) return; // plain text is pasted as usual
    e.preventDefault();
    addFiles(s.id, files);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };
  // only a turn of the session itself can be interrupted, not its subagents working while it waits; «Прервать» stays
  // next to the dictation bar too (voice-input, Requirement «Запись голоса»: прервать сессию, не трогая запись)
  const interruptBtn =
    (st === 'working' || st === 'permission') && !childrenWorking(s) ? (
      <button type="button" className="btn c-interrupt" aria-label="Прервать" title="Прервать" onClick={() => void interrupt(s.id)}>
        <span aria-hidden="true">■</span>
        <span className="lbl"> Прервать</span>
      </button>
    ) : null;
  return (
    <div className={`composer${bypass ? ' bypass' : ''}`}>
      <div className="composer-inner">
        {recordingHere ? (
          <div className="voice-row">
            <VoiceBar sessionId={s.id} />
            {interruptBtn}
          </div>
        ) : (
          <>
            <AttachmentStrip akey={s.id} />
            <textarea
              ref={area}
              rows={1}
              data-composer={paneId}
              data-session={s.id}
              placeholder={placeholder}
              aria-label="Сообщение"
              disabled={disabled}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={onKey}
              onPaste={onPaste}
            />
            <div className="composer-row">
              <div className="left">
                <AttachButton akey={s.id} disabled={disabled} />
                {voiceOn && <MicButton sessionId={s.id} paneId={paneId} disabled={disabled} />}
                {/* the head shows model and mode in a wide pane; here only in a narrow one, bypassPermissions always */}
                <span className="mono narrow-only">{modelName}</span>
                {bypass ? (
                  <span className="pill bypass" title="Режим прав bypassPermissions: инструменты без подтверждения">
                    bypass
                  </span>
                ) : (
                  <span className="pill narrow-only">{s.permissionMode}</span>
                )}
              </div>
              <div className="left">
                {interruptBtn}
                {/* while the sleep banner offers «Продолжить», an empty composer does not compete with it */}
                <button
                  type="button"
                  className={`btn c-send${st === 'sleeping' && empty ? '' : ' primary'}`}
                  aria-label="Отправить"
                  disabled={disabled || empty || loading}
                  onClick={send}
                  title={loading ? 'Изображения ещё загружаются' : 'Отправить'}
                >
                  <svg className="ico" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
                  </svg>
                  <span className="lbl">Отправить</span>
                </button>
              </div>
            </div>
          </>
        )}
        <VoiceNote sessionId={s.id} />
      </div>
    </div>
  );
}

/** Three or four «messages» while the first page of the history loads (M4a preloaders). */
function HistorySkeleton() {
  return (
    <div className="msg-skeleton" role="status" aria-label="Загрузка истории">
      <span className="skeleton sk-user" />
      <span className="sk-block">
        <span className="skeleton sk-line" style={{ width: '92%' }} />
        <span className="skeleton sk-line" style={{ width: '78%' }} />
        <span className="skeleton sk-line" style={{ width: '60%' }} />
      </span>
      <span className="skeleton sk-user" style={{ width: '30%' }} />
      <span className="sk-block">
        <span className="skeleton sk-line" style={{ width: '85%' }} />
        <span className="skeleton sk-line" style={{ width: '40%' }} />
      </span>
    </div>
  );
}

/**
 * What the turn is doing now, from the events already in the chat (no new API): a new session before its first line —
 * «запускаем на <машина>»; after the hub's resume note — «поднимаем через resume»; a restore from the copy —
 * «восстанавливаем из копии»; a tool call without its result — «выполняет <инструмент>»; streaming text — «Claude
 * пишет»; otherwise «Claude думает» (`agent` — the session's provider label, provider-parity).
 */
export function turnLabel(items: ReturnType<typeof buildChat>, streaming: boolean, runnerName: string, agent = 'Claude'): string {
  const said = items.filter(i => i.kind === 'assistant' || i.kind === 'tool');
  const last = items.at(-1);
  if (!items.some(i => i.kind === 'user' || i.kind === 'assistant' || i.kind === 'tool')) return `Запускаем на ${runnerName}`;
  if (last?.kind === 'note' && /resume/i.test(last.text)) return 'Поднимаем через resume';
  if (last?.kind === 'note' && /копи/i.test(last.text)) return 'Восстанавливаем из копии';
  if (last?.kind === 'user' && !said.length) return `Запускаем на ${runnerName}`;
  if (streaming) return `${agent} пишет`;
  const tool = [...items].reverse().find(i => i.kind === 'tool');
  if (tool?.kind === 'tool' && !tool.result && items.indexOf(tool) > items.findLastIndex(i => i.kind === 'user')) return `Выполняет ${tool.name}`;
  return `${agent} думает`;
}

/** «Работает в фоне: 2» under the feed while the session waits and its subagents or background commands work. */
export function childrenLabel(n: number): string {
  return `Работает в фоне: ${n}`;
}

/**
 * The feed of a session — or of a subagent (`viewOnly`, change `subagents` S9): the same items, no permission buttons,
 * no turn indicator; `scope` is the session whose subagent registry the links of the feed look in.
 */
function Messages({ s, viewOnly = false, scope }: { s: SessionView; viewOnly?: boolean; scope?: string }) {
  const log = useStore(st => st.logs[s.id]);
  // A subagent's feed (`viewOnly`) is keyed by the subagent id: optimistic copies, drafts and the streamed partial
  // text belong to sessions only and are never read for it (review of subagents web, finding 5).
  const partialRaw = useStore(st => st.partial[s.id]);
  const partial = viewOnly ? undefined : partialRaw;
  const runners = useStore(st => st.runners);
  const idx = runnerIndex(runners);
  const st = viewOnly ? 'closed' : displayStatus(s, idx);
  const children = viewOnly ? 0 : childrenWorking(s);
  const ro = viewOnly || isReadOnly(s, idx);
  const items = useMemo(() => buildChat(log?.events ?? []), [log?.events]);
  const known = useMemo(() => knownLocalImages(log?.events ?? []), [log?.events]);
  const runnerName = idx[s.runnerId]?.name ?? s.runnerId;
  // images of a subagent's transcript are served by its session (the subagent id is not a session id)
  const imageSessionId = viewOnly && scope ? scope : s.id;
  const provider = s.provider ?? 'claude';
  const agent = PROVIDER_LABELS[provider];
  const imageSource = useMemo(() => ({ sessionId: imageSessionId, runnerName, known }), [imageSessionId, runnerName, known]);
  const optimisticRaw = useAttachments(a => a.optimistic[s.id]);
  const optimistic = viewOnly ? undefined : optimisticRaw;
  const matched = useMemo(() => matchPending(items, log?.events ?? [], optimistic ?? []), [items, log?.events, optimistic]);
  useEffect(() => {
    if (!viewOnly) settleOptimistic(s.id, matched);
  }, [s.id, matched, viewOnly]);
  // a copy stands where it was sent, the answers that follow are drawn below it
  const pending = useMemo(() => {
    const at = new Map<number, NonNullable<typeof optimistic>>();
    for (const m of optimistic ?? []) {
      if (matched.has(m.clientUuid)) continue;
      const slot = pendingSlot(items, log?.events ?? [], m.afterEventId);
      at.set(slot, [...(at.get(slot) ?? []), m]);
    }
    return at;
  }, [optimistic, matched, items, log?.events]);
  const pendingView = (list: NonNullable<typeof optimistic> | undefined) =>
    list?.map(m => (
      <div key={m.clientUuid} className="msg user pending">
        {m.text && <div className="bubble user-text">{m.text}</div>}
        <ImageGroup pics={m.images.map(i => ({ src: i.url, width: i.width, height: i.height, original: i.url }))} className="user-imgs" />
        <span className="pending-note" role="status">
          <span className="dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          доставляется…
        </span>
      </div>
    ));
  const done = useMemo(() => finishedMessageIds(items), [items]);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // The scroll event of our own «to the bottom» comes a frame later; by then more may have arrived, and measuring the
  // gap then would read «the user scrolled up» (typing makes the frames longer). Our own scrolls are not the user's.
  const ownTop = useRef<number | null>(null);
  const toBottom = (el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
    ownTop.current = el.scrollTop;
  };
  const showPartial = partial && !done.has(partial.messageId) && partial.text;

  // «Повторить» on «Сообщение не доставлено»: the text and the images back into the composer (UI review M3b)
  /** «Продолжить под другой подпиской» of a limit / rejected-token note: switch and repeat the last message. */
  const onSwitch = (subscriptionId: string) => void switchSubscription(s.id, subscriptionId, { repeatLast: true });
  const retry = (u: Undelivered) => {
    const cur = useStore.getState().drafts[s.id] ?? '';
    const text = cur.trim() ? (cur.includes(u.text) ? cur : `${cur}\n${u.text}`) : u.text;
    useStore.setState({ drafts: { ...useStore.getState().drafts, [s.id]: text } });
    restoreAttachments(s.id, u.attachments);
    const ta = box.current?.closest('.chat')?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Сообщение"]');
    if (ta)
      requestAnimationFrame(() => {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      });
  };

  // «Показать раньше» keeps the feed where it was (UI review M3b). Older events land above, and may also grow the first
  // item (the same assistant turn), so the distance from the reading position to the end of the feed is kept.
  const fromEnd = useRef<number | null>(null);
  const older = () => {
    const el = box.current;
    if (el) fromEnd.current = el.scrollHeight - el.scrollTop;
    void loadOlder(s.id);
  };

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    if (fromEnd.current !== null && !log?.loading) {
      el.scrollTop = el.scrollHeight - fromEnd.current;
      fromEnd.current = null;
      return;
    }
    if (stick.current) toBottom(el);
  }, [items, partial?.text, st, log?.loading]);

  // At the bottom the feed follows every growth after the render — an image arrives, a block opens, the composer grows,
  // a «доставляется…» copy or the turn indicator appears (bugs from Ivan, M4a/M4b: the last message under the composer).
  // A ResizeObserver on the feed and each of its items, a MutationObserver for items added outside React's deps.
  // Scrolled up, nothing moves: scrollTop and what is on screen stay.
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const follow = () => {
      if (stick.current && fromEnd.current === null) toBottom(el);
    };
    const ro = new ResizeObserver(follow);
    ro.observe(el);
    for (const c of Array.from(el.children)) ro.observe(c);
    const mo = new MutationObserver(list => {
      for (const m of list) for (const n of Array.from(m.addedNodes)) if (n instanceof Element) ro.observe(n);
      follow();
    });
    mo.observe(el, { childList: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, []);

  return (
    <SubagentScope.Provider value={scope ?? s.id}>
      <ImageSourceContext.Provider value={imageSource}>
        <AgentProvider.Provider value={provider}>
          <div
            className="messages"
            ref={box}
            onScroll={e => {
              const el = e.currentTarget;
              if (ownTop.current !== null && Math.abs(el.scrollTop - ownTop.current) <= 1) {
                ownTop.current = null;
                return;
              }
              ownTop.current = null;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
          >
            {log?.before && (
              <button type="button" className="btn ghost load-older" disabled={log.loading} aria-busy={log.loading} onClick={older}>
                {log.loading && <span className="spinner" aria-hidden="true" />}
                Показать раньше
              </button>
            )}
            {log?.error && (
              <div className="sysnote err" role="alert">
                {log.error}
                <button type="button" className="btn note-retry" onClick={() => retryLog(s.id)}>
                  Повторить
                </button>
              </div>
            )}
            {log?.loading && !log.events.length && <HistorySkeleton />}
            {items.map((it, i) => (
              <Fragment key={it.id}>
                {pendingView(pending.get(i))}
                <ItemBoundary id={it.id}>
                  <ChatItemView item={it} readOnly={ro} onDecide={(rid, d, extra) => void decide(s.id, rid, d, extra)} onRetry={retry} onSwitch={viewOnly ? undefined : onSwitch} />
                </ItemBoundary>
              </Fragment>
            ))}
            {showPartial && (
              <div className="msg assistant partial">
                <span className="who">
                  <ProviderIcon provider={provider} size={15} />
                </span>
                <div className="bubble md">
                  <Markdown text={partial.text} />
                </div>
              </div>
            )}
            {pendingView(pending.get(items.length))}
            {st === 'working' && (
              <div className="thinking" role="status">
                <span className="g-work" />
                <span className="t-label">{children ? childrenLabel(children) : turnLabel(items, !!showPartial, runnerName, agent)}</span>
                <span className="dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
              </div>
            )}
          </div>
        </AgentProvider.Provider>
      </ImageSourceContext.Provider>
    </SubagentScope.Provider>
  );
}

export function Chat({ session: s, paneId }: { session: SessionView; paneId: string }) {
  const runners = useStore(st => st.runners);
  const idx = runnerIndex(runners);
  const st = displayStatus(s, idx);
  const ro = isReadOnly(s, idx);
  const runnerName = idx[s.runnerId]?.name ?? s.runnerId;
  // images dropped on the chat panel go to the composer (chat-images «Перетаскивание нескольких файлов»)
  const [dropping, setDropping] = useState(false);
  const phone = useStore(x => x.device === 'phone');
  const hasFiles = (e: DragEvent) => [...e.dataTransfer.types].includes('Files');
  const dropProps = ro
    ? {}
    : {
        onDragOver: (e: DragEvent) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'copy';
          setDropping(true);
        },
        onDragLeave: (e: DragEvent) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false);
        },
        onDrop: (e: DragEvent) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          e.stopPropagation();
          setDropping(false);
          addFiles(s.id, filesOf(e.dataTransfer));
        },
      };
  return (
    <section className={`chat${dropping ? ' file-drop' : ''}${phone ? ' phone' : ''}`} style={{ '--gc': colorVar(s.project.colorKey) } as CSSProperties} aria-label={s.title} {...dropProps}>
      {dropping && (
        <div className="file-drop-hint" role="status">
          Отпустите, чтобы прикрепить изображения
        </div>
      )}
      <div className="chat-head">
        <div className="chat-title">
          <div className="title-row">
            <span className="title-text">{s.title}</span>
            {s.project.id && (
              <button
                type="button"
                className="project-chip"
                title="Открыть проект в боковой панели"
                onClick={() => useStore.setState(state => ({ openProjects: { ...state.openProjects, [projectKey(s.project.id)]: true } }))}
              >
                {s.project.title}
              </button>
            )}
            <span className="provider-badge" title={`Сессия ${PROVIDER_LABELS[s.provider ?? 'claude']}`}>
              <ProviderIcon provider={s.provider ?? 'claude'} size={18} />
            </span>
          </div>
          <span className="sub mono">
            {runnerName} · {s.cwd ?? '—'}
            {(s.originSource ?? s.source) !== 'hub' && ` · ${SOURCE_LABEL[s.originSource ?? s.source]}`}
            {s.isDriveImport && (s.originSource ?? s.source) !== 'drive_import' && (
              <span className="drive-tag" title="Сессия перенесена импортом из Google Drive (vault-sessions)">
                {' · из Drive'}
              </span>
            )}
            {s.remoteControl && (
              <>
                {' · '}
                <span className="rc-tag">Remote Control</span>
              </>
            )}
            {s.spawnedBy && (
              <>
                {' · субагент сессии '}
                <a
                  className="spawned-by"
                  href={`/s/${s.spawnedBy.id}`}
                  onClick={e => {
                    e.preventDefault();
                    void openSession(s.spawnedBy!.id);
                  }}
                >
                  {s.spawnedBy.title}
                </a>
              </>
            )}
            {s.forkOf && (
              <>
                {' · форк от '}
                <a
                  href={`/s/${s.forkOf.id}`}
                  onClick={e => {
                    e.preventDefault();
                    void openSession(s.forkOf!.id);
                  }}
                >
                  {s.forkOf.title}
                </a>
              </>
            )}
          </span>
        </div>
        <div className="head-controls">
          <span className="pill">
            <Glyph status={st} unread={s.unread} label={statusText(s, st)} />
            {statusText(s, st)}
          </span>
          <SubagentsButton s={s} />
          <McpButton s={s} />
          <ModeModelSelects s={s} disabled={ro} inline />
          <button type="button" className="btn fork-btn" title="Полная копия или handoff на другую машину" onClick={() => useStore.setState({ modal: { type: 'fork', sessionId: s.id } })}>
            ⑂ Форк
          </button>
          <ModeModelMenu s={s} />
        </div>
      </div>
      {phone ? (
        <>
          <ClaudeLoginBanner s={s} />
          <ResumeWarning s={s} />
          <PhoneInfo s={s} />
        </>
      ) : (
        <>
          <Banner s={s} />
          <ClaudeLoginBanner s={s} />
          <ResumeWarning s={s} />
          <ClassLine s={s} />
        </>
      )}
      <Messages s={s} />
      <Composer s={s} paneId={paneId} />
      <McpPanelHost s={s} />
    </section>
  );
}

/**
 * The read-only chat of a subagent (spec subagents «Чат субагента только для чтения»): its header with the link to
 * the parent session, its feed by pages and live; no composer, «Продолжить», mode, model, fork or project line.
 */
export function SubagentChat({ id }: { id: string }) {
  const v = useStore(st => st.subagents[id]);
  const parent = useSubagentParent(v);
  if (!v)
    return (
      <div className="empty" role="status">
        <span className="spinner" aria-hidden="true" /> Загрузка субагента…
      </div>
    );
  const feed: SessionView | null = parent ? { ...parent, id: v.id, title: subTitle(v) } : null;
  return (
    <section className="chat sub-chat" style={{ '--gc': subagentColor(parent) } as CSSProperties} aria-label={`Субагент: ${subTitle(v)}`}>
      <SubagentHead v={v} parent={parent} />
      <UserLabel.Provider value="Лид">{feed ? <Messages s={feed} viewOnly scope={v.sessionId} /> : <div className="messages" />}</UserLabel.Provider>
    </section>
  );
}
