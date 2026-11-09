/**
 * The «Диктовка» button next to «Прикрепить» (voice-input design D7).
 * Requirements (voice-input): Кнопка микрофона в композере; Одна запись на окно.
 */
import { useT } from '../../i18n';
import { useTalk } from './talk';
import { startDictation, useVoice } from './voice';

function MicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5.5" y="1.75" width="5" height="8" rx="2.5" />
      <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2" />
    </svg>
  );
}

export function MicButton({ sessionId, paneId, disabled }: { sessionId: string; paneId: string; disabled?: boolean }) {
  const t = useT();
  const active = useVoice(v => v.active);
  const mine = !!active && active.sessionId === sessionId && (active.paneId === paneId || active.paneId === null);
  const starting = mine && active.phase === 'starting';
  // one microphone per window: while a dictation runs anywhere else, this button waits
  const other = !!active && !mine;
  const talking = useTalk(x => !!x.active);
  const title = other ? (active.paneId && active.paneId !== paneId ? t('chat.voice.otherPane') : t('chat.voice.otherBusy')) : talking ? t('chat.talk.otherPane') : t('chat.voice.dictation');
  return (
    <button
      type="button"
      className="btn ghost mic-btn"
      aria-label={t('chat.voice.dictation')}
      title={title}
      aria-busy={starting || undefined}
      disabled={disabled || other || starting || talking}
      onClick={() => void startDictation(sessionId, paneId)}
    >
      {starting ? <span className="spinner" aria-hidden="true" /> : <MicIcon />}
    </button>
  );
}
