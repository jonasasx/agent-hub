/**
 * Session title in the chat head and the phone top bar (spec session-title): click to rename in place,
 * «✦» next to it asks the hub to name the session from its whole transcript.
 * Enter or leaving the field saves, Esc cancels; an empty or unchanged title changes nothing.
 */
import { useRef, useState, type KeyboardEvent } from 'react';
import { useT } from '../../i18n';
import { useUnsavedInput } from '../update/unsaved';
import { regenerateSessionTitle, renameSession } from '../workspace/actions';

const TITLE_MAX = 200;

export function SessionTitle({ sessionId, title }: { sessionId: string; title: string }) {
  const t = useT();
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'regenerate' | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const editing = draft !== null;
  useUnsavedInput(editing);

  const finish = async (commit: boolean) => {
    if (draft === null || busy) return;
    const next = draft.trim();
    if (!commit || !next || next === title) {
      setDraft(null);
      return;
    }
    setBusy('save');
    const saved = await renameSession(sessionId, next);
    setBusy(null);
    // On a refusal the field stays open with the typed text; the toast says why.
    if (saved) setDraft(null);
    else input.current?.focus();
  };

  const regenerate = async () => {
    if (busy) return;
    setDraft(null);
    setBusy('regenerate');
    await regenerateSessionTitle(sessionId);
    setBusy(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      void finish(false);
    }
  };

  return (
    <span className={`session-title${busy === 'regenerate' ? ' generating' : ''}`}>
      {editing ? (
        <input
          ref={input}
          className="input title-input"
          aria-label={t('chat.title.label')}
          autoFocus
          value={draft}
          maxLength={TITLE_MAX}
          disabled={busy === 'save'}
          onFocus={e => e.currentTarget.select()}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => void finish(true)}
        />
      ) : (
        <button type="button" className="title-edit" title={t('chat.title.edit')} disabled={busy !== null} onClick={() => setDraft(title)}>
          <span className="title-text">{title}</span>
        </button>
      )}
      <button
        type="button"
        className="title-regen"
        aria-label={t('chat.title.regenerate')}
        title={t('chat.title.regenerateHint')}
        disabled={busy !== null}
        // keeps the focus in the field, so the blur does not save a half-typed title before the hub names the session
        onMouseDown={e => e.preventDefault()}
        onClick={() => void regenerate()}
      >
        {busy === 'regenerate' ? '…' : '✦'}
      </button>
    </span>
  );
}
