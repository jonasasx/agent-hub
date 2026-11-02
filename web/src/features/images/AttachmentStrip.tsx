/**
 * Thumbnails of attached images over the composer and the «Прикрепить» button (design.md D19 p. 1).
 * Requirement (chat-images): Прикрепление изображений к сообщению — thumbnails with «Убрать» and the upload
 * progress, a refused file shows a mark and its name instead of a picture (the tile keeps the size of the others) and
 * the reason in a line under the strip, at most 10; on the phone the file
 * input offers gallery and camera (no `capture`, which would hide the gallery).
 */
import { useRef } from 'react';
import { useStore } from '../../store';
import { addFiles, removeAttachment, useAttachments } from './attachments';
import { IMAGE_MIMES } from './format';

export function AttachmentStrip({ akey }: { akey: string }) {
  const list = useAttachments(s => s.byKey[akey]);
  const note = useAttachments(s => s.note[akey]);
  const retry = useAttachments(s => s.retry[akey]);
  if (!list?.length && !note) return null;
  const errors = (list ?? []).filter(a => a.status === 'error');
  return (
    <div className="attach-strip">
      {!!list?.length && (
        <ul className="attach-list" aria-label="Прикреплённые изображения">
          {list.map((a, i) => (
            <li
              key={a.id}
              className={`attach-item ${a.status}`}
              title={a.error ?? a.name}
              aria-label={a.status === 'error' ? `${a.name}: не прикреплено` : undefined}
              aria-describedby={a.status === 'error' ? `attach-why-${a.id}` : undefined}
            >
              {a.status !== 'error' && <img src={a.url} alt={`Изображение ${i + 1}: ${a.name}`} />}
              {(a.status === 'processing' || a.status === 'uploading') && (
                <span className="attach-progress" role="progressbar" aria-label={`Загрузка ${a.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(a.progress * 100)}>
                  <span style={{ width: `${Math.round(a.progress * 100)}%` }} />
                </span>
              )}
              {a.status === 'error' && (
                // the tile keeps the size of the others (UI review M3b): a mark and the name; the reason is under the strip
                <span className="attach-error" aria-hidden="true">
                  <span className="attach-error-mark">!</span>
                  <span className="attach-error-name">{a.name}</span>
                </span>
              )}
              <button type="button" className="attach-remove" aria-label={`Убрать ${a.name}`} onClick={() => removeAttachment(akey, a.id)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {!!errors.length && (
        <ul className="attach-errors" aria-label="Не прикреплены">
          {errors.map(a => (
            <li key={a.id} id={`attach-why-${a.id}`}>
              <span className="attach-error-name">{a.name}</span> — <span className="attach-error-why">{a.error}</span>
            </li>
          ))}
        </ul>
      )}
      {note && (
        <p className="attach-note" role="alert">
          {note}
          {retry && (
            <button type="button" className="btn attach-retry" onClick={retry}>
              Повторить
            </button>
          )}
        </p>
      )}
    </div>
  );
}

export function AttachButton({ akey, disabled }: { akey: string; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  // on the phone `image/*` makes Android and iOS offer the gallery and the camera; the format is checked by content
  const phone = useStore(s => s.device === 'phone');
  return (
    <>
      <button type="button" className="btn ghost attach-btn" disabled={disabled} onClick={() => input.current?.click()} aria-label="Прикрепить изображение" title="Прикрепить изображение">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M13.5 7.5 8 13a3.5 3.5 0 0 1-5-5l5.5-5.5a2.3 2.3 0 0 1 3.3 3.3L6.3 11.3a1.2 1.2 0 0 1-1.7-1.7L9.5 4.7" />
        </svg>
        <span className="attach-label">Прикрепить</span>
      </button>
      <input
        ref={input}
        type="file"
        accept={phone ? 'image/*' : IMAGE_MIMES.join(',')}
        multiple
        hidden
        data-testid={`attach-input-${akey}`}
        onChange={e => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (files.length) addFiles(akey, files);
        }}
      />
    </>
  );
}
