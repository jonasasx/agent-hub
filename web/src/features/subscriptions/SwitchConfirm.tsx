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
import { useDialog } from '../ui/a11y';
import { cancelSwitch, confirmSwitch } from './actions';
import { subName } from './model';

export function SwitchConfirm() {
  const p = useStore(s => s.pendingSwitch);
  if (!p) return null;
  return <ConfirmDialog key={`${p.sessionId}:${p.subscriptionId}`} />;
}

function ConfirmDialog() {
  const p = useStore(s => s.pendingSwitch)!;
  const name = useStore(s => subName(s.subs, p.subscriptionId)) ?? 'другую подписку';
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
          <h2 id={titleId}>{background ? 'Работает в фоне: остановить и переключить?' : 'Идёт ход: прервать и переключить?'}</h2>
          {background ? (
            <p id={`${titleId}-d`}>
              Фоновые задачи сессии будут остановлены. Затем {title ? `«${title}»` : 'сессия'} поднимется под «{name}». Первый ход пересчитает контекст без кэша.
            </p>
          ) : (
            <p id={`${titleId}-d`}>
              {title ? `«${title}» ` : 'Сессия '}сейчас выполняет ход. Ход будет прерван, затем сессия поднимется под «{name}». Первый ход пересчитает контекст без кэша.
            </p>
          )}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn ghost" autoFocus onClick={cancelSwitch}>
            Отмена
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
            {busy ? 'Переключаем…' : background ? 'Остановить и переключить' : 'Прервать и переключить'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
