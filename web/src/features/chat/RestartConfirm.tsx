/**
 * «Идёт ход: прервать и перезапустить?» (change session-restart, design D1): shown before a restart of a busy session
 * and after the hub's 409 turn_in_progress. «Прервать и перезапустить» repeats the restart with `interrupt: true`,
 * «Отмена» changes nothing. A waiting session with working subagents or background commands gets «Работает в фоне:
 * остановить и перезапустить?». The same dialog as the subscription switch: the destructive action is `btn danger`,
 * the focus starts on «Отмена».
 */
import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import { useDialog } from '../ui/a11y';
import { cancelRestart, confirmRestart } from './restart';

export function RestartConfirm() {
  const p = useStore(s => s.pendingRestart);
  if (!p) return null;
  return <ConfirmDialog key={p.sessionId} />;
}

function ConfirmDialog() {
  const t = useT();
  const p = useStore(s => s.pendingRestart)!;
  const title = useStore(s => s.sessions[p.sessionId]?.title);
  const background = useStore(s => {
    const x = s.sessions[p.sessionId];
    return !!x && x.status === 'waiting' && (x.subagents?.working ?? 0) > 0;
  });
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialog(dialog, cancelRestart);
  const subject = title ? `«${title}»` : t('chat.restart.session');
  return createPortal(
    <div className="scrim modal-top" onMouseDown={e => e.target === e.currentTarget && cancelRestart()}>
      <div className="modal confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={`${titleId}-d`} ref={dialog}>
        <div className="modal-head">
          <h2 id={titleId}>{background ? t('chat.restart.titleBackground') : t('chat.restart.titleTurn')}</h2>
          <p id={`${titleId}-d`}>{background ? t('chat.restart.bodyBackground', { subject }) : t('chat.restart.bodyTurn', { subject })}</p>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn ghost" autoFocus onClick={cancelRestart}>
            {t('chat.restart.cancel')}
          </button>
          <button
            type="button"
            className="btn danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void confirmRestart();
            }}
          >
            {busy ? t('chat.restart.restarting') : background ? t('chat.restart.stop') : t('chat.restart.interrupt')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
