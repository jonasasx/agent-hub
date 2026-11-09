/**
 * The «Разговор» button next to «Диктовка» and the bar that takes the place of the field during a conversation
 * (change voice-conversation, design D9): the state, the last line, «Завершить».
 * Requirements (voice-conversation): Включение разговора; Начало разговора; Полоса разговора.
 */
import { useT } from '../../i18n';
import { endTalk, startTalk, useTalk, type Talk, type TalkPhase } from './talk';
import { useVoice } from './voice';

const PHASE_TEXT = {
  connecting: 'chat.talk.connecting',
  listening: 'chat.talk.listening',
  thinking: 'chat.talk.thinking',
  speaking: 'chat.talk.speaking',
} as const satisfies Record<TalkPhase, string>;

/** The conversation this composer shows: started here. */
export function talkHere(a: Talk | null, sessionId: string, paneId: string): boolean {
  return !!a && a.sessionId === sessionId && a.paneId === paneId;
}

function TalkIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 6.5v3M5 4.5v7M8 2.5v11M11 4.5v7M13.5 6.5v3" />
    </svg>
  );
}

export function TalkButton({ sessionId, paneId, disabled }: { sessionId: string; paneId: string; disabled?: boolean }) {
  const t = useT();
  const talk = useTalk(x => x.active);
  const dictation = useVoice(v => !!v.active);
  // one microphone per window: a dictation anywhere or a conversation in another pane keeps this button waiting
  const other = !!talk && !talkHere(talk, sessionId, paneId);
  const title = other ? t('chat.talk.otherPane') : dictation ? t('chat.voice.otherBusy') : t('chat.talk.startHint');
  return (
    <button
      type="button"
      className="btn ghost mic-btn talk-btn"
      aria-label={t('chat.talk.start')}
      title={title}
      disabled={disabled || other || dictation}
      onClick={() => void startTalk(sessionId, paneId)}
    >
      <TalkIcon />
    </button>
  );
}

export function TalkBar() {
  const t = useT();
  const talk = useTalk(x => x.active);
  if (!talk) return null;
  return (
    <div className="talk-bar" role="group" aria-label={t('chat.talk.start')}>
      <span className={`talk-state ${talk.phase}`} aria-live="polite">
        {talk.phase === 'connecting' || talk.phase === 'thinking' ? <span className="spinner" aria-hidden="true" /> : <span className="talk-dot" aria-hidden="true" />}
        {t(PHASE_TEXT[talk.phase])}
      </span>
      <span className="talk-last" title={talk.last}>
        {talk.last}
      </span>
      <button type="button" className="btn talk-end" onClick={() => void endTalk()}>
        {t('chat.talk.end')}
      </button>
    </div>
  );
}
