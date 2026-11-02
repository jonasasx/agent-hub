/**
 * Dictation in the composer (voice-input design D7): the bar that takes
 * the place of the field while recording (× «Отмена», the live wave, the timer `м:сс`, ✓ «Готово»), «Распознаю…» with
 * «Отмена», an error with «Повторить» / «Отмена», and the hint under the composer.
 * Requirements (voice-input): Кнопка микрофона в композере; Запись голоса; Отмена записи; Лимит длительности записи;
 * Ошибки доступа к микрофону; Ошибки распознавания; Одна запись на окно.
 */
import { useEffect, useReducer, useRef } from 'react';
import { useStore } from '../../store';
import { EMPTY_TEXT, cancelDictation, finishDictation, focusComposer, retryDictation, setVoiceNote, timerLabel, useVoice, voiceLevel, type Dictation } from './voice';

const BARS = 32;

/**
 * The dictation this composer shows: started here, or claimed here after its composer went away (tab switched, pane
 * closed — `claimDictation`). One composer at most, even when the session is open in two panes.
 */
export function shownHere(a: Dictation | null, sessionId: string, paneId: string): boolean {
  return !!a && a.sessionId === sessionId && a.phase !== 'starting' && a.paneId === paneId;
}

/** Hint under the composer: no microphone, «Речь не распознана». */
export function VoiceNote({ sessionId }: { sessionId: string }) {
  const note = useVoice(v => v.note[sessionId]);
  if (!note) return null;
  return (
    <p className={`voice-note${note === EMPTY_TEXT ? ' soft' : ''}`} role="alert">
      <span>{note}</span>
      <button type="button" className="btn ghost voice-note-close" aria-label="Скрыть подсказку" title="Скрыть" onClick={() => setVoiceNote(sessionId, undefined)}>
        ×
      </button>
    </p>
  );
}

function Wave() {
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const bars = Array.from(el.children) as HTMLElement[];
    const levels: number[] = new Array<number>(BARS).fill(0);
    let raf = 0;
    let last = 0;
    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      if (t - last < 60) return; // ~16 samples a second: the wave scrolls left like the mobile app's
      last = t;
      levels.shift();
      levels.push(voiceLevel());
      for (let i = 0; i < bars.length; i++) bars[i]!.style.transform = `scaleY(${Math.max(0.08, levels[i]!)})`;
    };
    if (typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(frame);
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
  return (
    <span className="voice-wave" ref={box} aria-hidden="true">
      {Array.from({ length: BARS }, (_, i) => (
        <i key={i} />
      ))}
    </span>
  );
}

function Timer({ startedAt }: { startedAt: number }) {
  const [, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, []);
  const { text, countdown } = timerLabel(Date.now() - startedAt);
  return (
    <span className={`voice-timer mono${countdown ? ' countdown' : ''}`} title={countdown ? 'До конца записи' : 'Длительность записи'}>
      {countdown && <span className="sr-only">Осталось </span>}
      {text}
    </span>
  );
}

/** The focus is in a field or a composer other than the one of `bar`. */
function typingElsewhere(bar: HTMLElement | null): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body) return false;
  const own = bar?.closest('.composer');
  if (own?.contains(el)) return false;
  return !!el.closest('.composer') || el.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
}

const PHASE_TEXT = { recording: 'Идёт запись', transcribing: 'Распознаю…' } as const;

export function VoiceBar({ sessionId }: { sessionId: string }) {
  const a = useVoice(v => v.active);
  const first = useRef<HTMLButtonElement>(null);
  const phase = a?.sessionId === sessionId ? a.phase : null;

  // the focus follows the bar: «Готово» while recording, «Отмена» while recognising, «Повторить» on an error. A bar
  // that appears (recording started here, or a dictation claimed by this composer) does not take the focus from another
  // composer or field Иван is typing in; a phase change inside the same bar always moves it.
  const shown = useRef(false);
  useEffect(() => {
    const appeared = !shown.current;
    shown.current = true;
    if (appeared && typingElsewhere(first.current)) return;
    first.current?.focus({ preventScroll: true });
  }, [phase]);

  // Esc cancels the recording only — never a recording kept for «Повторить» or one being recognised (a dialog or a menu
  // takes Esc first: they prevent it or stop it in the capture phase)
  useEffect(() => {
    if (phase !== 'recording') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || useStore.getState().modal) return;
      e.preventDefault();
      const paneId = useVoice.getState().active?.paneId ?? null;
      cancelDictation();
      focusComposer(sessionId, paneId);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [sessionId, phase]);

  if (!a || !phase || phase === 'starting') return null;
  const paneId = a.paneId;
  const cancel = () => {
    cancelDictation();
    focusComposer(sessionId, paneId);
  };

  return (
    <div className={`voice-bar ${phase}`} role="group" aria-label="Диктовка">
      <span className="sr-only" role="status" aria-live="polite">
        {phase === 'error' ? '' : PHASE_TEXT[phase]}
      </span>
      {phase === 'recording' && (
        <>
          <button type="button" className="btn ghost voice-btn voice-cancel" aria-label="Отмена" title="Отмена (Esc)" onClick={cancel}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
          <span className="voice-rec-dot" aria-hidden="true" />
          <Wave />
          <Timer startedAt={a.startedAt} />
          <button ref={first} type="button" className="btn primary voice-btn voice-done" aria-label="Готово" title="Готово" onClick={() => void finishDictation()}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 8.5l3.2 3.2L13 4.8" />
            </svg>
          </button>
        </>
      )}
      {phase === 'transcribing' && (
        <>
          {/* the live region above announces it; the visible copy is not read twice */}
          <span className="voice-status" aria-hidden="true">
            <span className="spinner" />
            Распознаю…
          </span>
          <button ref={first} type="button" className="btn voice-text-btn" onClick={cancel}>
            Отмена
          </button>
        </>
      )}
      {phase === 'error' && (
        <>
          <span className="voice-status voice-error" role="alert">
            {a.error}
          </span>
          <button ref={first} type="button" className="btn primary voice-text-btn" onClick={retryDictation}>
            Повторить
          </button>
          <button type="button" className="btn voice-text-btn" onClick={cancel}>
            Отмена
          </button>
        </>
      )}
    </div>
  );
}
