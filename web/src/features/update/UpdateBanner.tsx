/**
 * «Доступна новая версия · Позже · Обновить» — the pinned first item of the toast stack, no timer (design D5,
 * docs/prototype.html `renderUpd`). With input a reload would lose: «Черновик пропадёт» and a confirmation.
 */
import { dismissUpdate, requestUpdate, useUpdate } from './check';
import { useHasUnsavedInput } from './silent';
import { useT } from '../../i18n';

export function UpdateBanner() {
  const t = useT();
  const shown = useUpdate(s => s.available && !s.dismissed && s.hub !== null);
  const unsaved = useHasUnsavedInput();
  if (!shown) return null;
  return (
    <div className="toast upd" role="status" aria-label={t('workspace.update.available')}>
      <div className="tt">
        <b>{t('workspace.update.available')}</b>
        {unsaved && <span className="u-warn">{t('workspace.update.draftLost')}</span>}
      </div>
      <div className="u-acts">
        <button type="button" className="btn ghost" onClick={dismissUpdate}>
          {t('workspace.update.later')}
        </button>
        <button type="button" className="btn primary" onClick={() => requestUpdate()}>
          {t('workspace.update.update')}
        </button>
      </div>
    </div>
  );
}
