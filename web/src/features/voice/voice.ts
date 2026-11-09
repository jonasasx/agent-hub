/**
 * One dictation per window (voice-input design D7 `voice.ts`): recording → «Распознаю…» → the text at the end of the
 * draft of the session where the recording started, or an error with «Повторить» that keeps the recording in memory.
 * The store, not the composer, owns the dictation: it lives through switching tabs and closing the pane, and the result
 * lands in `drafts[sessionId]` even when that chat is not on screen.
 * Requirements (voice-input): Запись голоса; Отмена записи; Завершение записи и вставка текста; Лимит длительности
 * записи; Ошибки доступа к микрофону; Ошибки распознавания; Одна запись на окно; Запись при смене контекста.
 */
import { create } from 'zustand';
import { VOICE_COUNTDOWN_MS, VOICE_MAX_DURATION_MS } from '../../api/types';
import { ApiError, transcribe } from '../../api/client';
import { fmt, t } from '../../i18n';
import { useStore } from '../../store';
import { appendDictation } from './append';
import { micError, startRecording, type Recording } from './recorder';
import { useTalk } from './talk';

export type VoicePhase = 'starting' | 'recording' | 'transcribing' | 'error';

export interface Dictation {
  id: number;
  sessionId: string;
  /** The pane whose composer shows the bar; null once that composer is gone (tab switched, pane closed). */
  paneId: string | null;
  phase: VoicePhase;
  /** Window clock (ms) when the microphone started. */
  startedAt: number;
  mime: string;
  /** Text of the error phase. */
  error?: string;
}

interface State {
  active: Dictation | null;
  /** Hint under the composer of a session: no microphone, «Речь не распознана». */
  note: Record<string, string | undefined>;
}

export const useVoice = create<State>()(() => ({ active: null, note: {} }));

// Notes hold the dictionary key: VoiceNote translates it when it renders, so a language switch applies at once.
export const EMPTY_TEXT = 'chat.voice.empty';
/** The recorder failed (MediaRecorder `error`): there is nothing to send or to retry. */
export const INTERRUPTED_TEXT = 'chat.voice.interrupted';

/** Injected in tests (fake microphone, fake hub). */
export const voiceDeps = {
  startRecording: (onError?: (err: unknown) => void): Promise<Recording> => startRecording(undefined, onError),
  transcribe,
};

let recording: Recording | null = null;
let blob: Blob | null = null;
let request: AbortController | null = null;
let limitTimer: ReturnType<typeof setTimeout> | null = null;
let seq = 0;

const get = () => useVoice.getState();
const current = (id: number) => get().active?.id === id;
const patch = (p: Partial<Dictation>) => {
  const a = get().active;
  if (a) useVoice.setState({ active: { ...a, ...p } });
};

export function setVoiceNote(sessionId: string, note: string | undefined) {
  useVoice.setState({ note: { ...get().note, [sessionId]: note } });
}

/** Current loudness 0…1 for the wave of the bar. */
export function voiceLevel(): number {
  return recording?.level() ?? 0;
}

/** Requirement «Лимит длительности записи»: `м:сс` from 0:00, the last 30 s count down to the limit. */
export function timerLabel(elapsedMs: number): { text: string; countdown: boolean } {
  const left = VOICE_MAX_DURATION_MS - elapsedMs;
  const countdown = left <= VOICE_COUNTDOWN_MS;
  const sec = countdown ? Math.max(0, Math.ceil(left / 1000)) : Math.max(0, Math.floor(elapsedMs / 1000));
  return { text: `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`, countdown };
}

/** `resetAt` (ISO) → «ДД.ММ» in the window's time zone. */
export function resetLabel(iso: unknown): string | null {
  if (typeof iso !== 'string') return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return fmt.dayMonth(d);
}

/** Hub answer → the text of the bar (design.md D2, table «код ответа → текст в UI»). */
export function voiceErrorText(err: unknown): string {
  if (!(err instanceof ApiError)) return t('chat.voice.failed');
  switch (err.code) {
    case 'voice_quota_exceeded': {
      const at = resetLabel(err.body?.resetAt);
      return at ? t('chat.voice.quotaReset', { at }) : t('chat.voice.quota');
    }
    case 'voice_busy':
      return t('chat.voice.busy');
    case 'voice_key_rejected':
      return t('chat.voice.keyRejected');
    case 'too_large':
      return t('chat.voice.tooLarge');
    default:
      // voice_timeout, voice_upstream_error, empty_audio, unsupported_audio, the client's timeout, a lost connection
      return t('chat.voice.failed');
  }
}

function onVisibility() {
  // Requirement «Запись при смене контекста»: a page in the background (locked phone, minimised window) stops the
  // recording as «Готово» — mobile systems cut the microphone of a hidden page anyway.
  if (document.visibilityState === 'hidden') void finishDictation({ detach: true });
}

function stopWatching() {
  if (limitTimer) clearTimeout(limitTimer);
  limitTimer = null;
  document.removeEventListener('visibilitychange', onVisibility);
}

/** «Диктовка»: asks for the microphone and starts recording. Does nothing while another dictation runs. */
export async function startDictation(sessionId: string, paneId: string): Promise<void> {
  // one microphone per window: no dictation during a voice conversation (change voice-conversation)
  if (get().active || useTalk.getState().active) return;
  const id = ++seq;
  setVoiceNote(sessionId, undefined);
  useVoice.setState({ active: { id, sessionId, paneId, phase: 'starting', startedAt: Date.now(), mime: '' } });
  let r: Recording;
  // Requirement «Запись голоса», scenario «Запись прервалась»: the recorder failing mid-recording ends the dictation
  // at once — the bar does not keep saying «Идёт запись» over a dead microphone
  const onError = () => {
    if (!current(id) || get().active?.phase !== 'recording') return;
    cancelDictation();
    setVoiceNote(sessionId, INTERRUPTED_TEXT);
  };
  try {
    r = await voiceDeps.startRecording(onError);
  } catch (err) {
    if (!current(id)) return;
    useVoice.setState({ active: null });
    setVoiceNote(sessionId, micError(err).message);
    return;
  }
  if (!current(id)) {
    // cancelled (or the composer went away) while the browser asked for the permission
    r.cancel();
    return;
  }
  recording = r;
  blob = null;
  patch({ phase: 'recording', startedAt: Date.now(), mime: r.mime });
  limitTimer = setTimeout(() => void finishDictation(), VOICE_MAX_DURATION_MS);
  document.addEventListener('visibilitychange', onVisibility);
}

/**
 * «Готово», the 5-minute limit, the page going to the background, the composer of the session going away
 * (`detach`: the bar moves to whichever composer shows the session next). Stops the recording and sends it.
 */
export async function finishDictation(opts: { detach?: boolean } = {}): Promise<void> {
  const a = get().active;
  if (!a) return;
  if (a.phase === 'starting') return cancelDictation();
  if (a.phase !== 'recording') {
    if (opts.detach) patch({ paneId: null });
    return;
  }
  stopWatching();
  const r = recording;
  recording = null;
  patch({ phase: 'transcribing', ...(opts.detach ? { paneId: null } : {}) });
  let b: Blob;
  try {
    b = await r!.stop();
  } catch {
    // Requirement «Запись голоса», scenario «Запись прервалась»: no recording — no «Повторить»; the composer comes
    // back with the hint, the draft as it was
    if (!current(a.id)) return;
    cancelDictation();
    setVoiceNote(a.sessionId, INTERRUPTED_TEXT);
    return;
  }
  if (!current(a.id)) return;
  blob = b;
  await send(a.id);
}

async function send(id: number) {
  const a = get().active;
  if (!a || !blob) return;
  const ctl = new AbortController();
  request = ctl;
  patch({ phase: 'transcribing', error: undefined });
  let text: string;
  try {
    text = (await voiceDeps.transcribe(blob, blob.type || a.mime, ctl.signal)).text.trim();
  } catch (err) {
    if (current(id) && request === ctl) patch({ phase: 'error', error: voiceErrorText(err) });
    return;
  } finally {
    if (request === ctl) request = null;
  }
  // «Отмена» during «Распознаю…»: a late answer is dropped
  if (!current(id)) return;
  blob = null;
  useVoice.setState({ active: null });
  if (!text) {
    setVoiceNote(a.sessionId, EMPTY_TEXT);
    return;
  }
  const drafts = useStore.getState().drafts;
  useStore.setState({ drafts: { ...drafts, [a.sessionId]: appendDictation(drafts[a.sessionId] ?? '', text) } });
  focusComposer(a.sessionId, a.paneId);
}

/**
 * A composer of the session takes a dictation left without one (`paneId` null: its composer went away). The first
 * composer to ask wins, so a session open in two panes shows the bar — and moves the focus — in one of them only.
 */
export function claimDictation(sessionId: string, paneId: string): void {
  const a = get().active;
  if (a && a.sessionId === sessionId && a.paneId === null && a.phase !== 'starting') patch({ paneId });
}

/** «Повторить»: the same recording again, the microphone is not asked again. */
export function retryDictation(): void {
  const a = get().active;
  if (a?.phase === 'error' && blob) void send(a.id);
}

/** «Отмена», `Esc`: drops the recording and an answer still on its way; nothing changes in the draft. */
export function cancelDictation(): void {
  stopWatching();
  recording?.cancel();
  recording = null;
  request?.abort();
  request = null;
  blob = null;
  useVoice.setState({ active: null });
}

/** The field of the session gets the focus with the cursor at the end (after the composer is back from the bar). */
export function focusComposer(sessionId: string, paneId: string | null = null): void {
  const raf = globalThis.requestAnimationFrame ?? ((f: FrameRequestCallback) => setTimeout(() => f(0), 16));
  raf(() => {
    const sel = (p: string | null) => `textarea[data-session="${sessionId}"]${p ? `[data-composer="${p}"]` : ''}`;
    const ta = (paneId && document.querySelector<HTMLTextAreaElement>(sel(paneId))) || document.querySelector<HTMLTextAreaElement>(sel(null));
    if (!ta || ta.disabled) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  });
}

/** Tests: drop the dictation and the hints. */
export function resetVoice(): void {
  cancelDictation();
  useVoice.setState({ active: null, note: {} });
}
