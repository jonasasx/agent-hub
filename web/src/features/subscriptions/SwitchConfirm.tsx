/**
 * «Идёт ход: прервать и переключить?» (Requirement: Подписка в шапке вкладки и переключение — scenario «Переключение
 * посреди хода»): shown after 409 turn_in_progress; «Прервать и переключить» repeats the switch with `interrupt: true`,
 * «Отмена» changes nothing. A waiting session with working subagents / background commands (`subagents.working`) gets
 * «Работает в фоне: остановить и переключить?» — the same 409, the hub's busyForSwitch.
 * UI review M10: the destructive action is `btn danger`, the focus starts on «Отмена».
 */
import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import { useDialog } from '../ui/a11y';
import { cancelSwitch, confirmSwitch } from './actions';
import { subName } from './model';

export function SwitchConfirm() {
  const p = useStore(s => s.pendingSwitch);
  if (!p) return null;
  return <ConfirmDialog key={`${p.sessionId}:${p.subscriptionId}`} />;
}

function ConfirmDialog() {
  const t = useT();
  const p = useStore(s => s.pendingSwitch)!;
  const name = useStore(s => subName(s.subs, p.subscriptionId)) ?? t('subscriptions.switch.otherSub');
  const title = useStore(s => s.sessions[p.sessionId]?.title);
  // the hub refuses a switch of a waiting session while its subagents or background commands work (busyForSwitch):
  // stopping the process stops them, not a turn
  const background = useStore(s => {
    const x = s.sessions[p.sessionId];
    return !!x && x.status === 'waiting' && (x.subagents?.working ?? 0) > 0;
  });
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialog(dialog, cancelSwitch);
  return createPortal(
    <div className="scrim modal-top" onMouseDown={e => e.target === e.currentTarget && cancelSwitch()}>
      <div className="modal confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={`${titleId}-d`} ref={dialog}>
        <div className="modal-head">
          <h2 id={titleId}>{background ? t('subscriptions.switch.titleBackground') : t('subscriptions.switch.titleTurn')}</h2>
          {background ? (
            <p id={`${titleId}-d`}>{t('subscriptions.switch.bodyBackground', { subject: title ? `«${title}»` : t('subscriptions.switch.session'), name })}</p>
          ) : (
            <p id={`${titleId}-d`}>{t('subscriptions.switch.bodyTurn', { subject: title ? `«${title}»` : t('subscriptions.switch.sessionCap'), name })}</p>
          )}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn ghost" autoFocus onClick={cancelSwitch}>
            {t('subscriptions.switch.cancel')}
          </button>
          <button
            type="button"
            className="btn danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void confirmSwitch();
            }}
          >
            {busy ? t('subscriptions.switch.switching') : background ? t('subscriptions.switch.stopAndSwitch') : t('subscriptions.switch.interruptAndSwitch')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
