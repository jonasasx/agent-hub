/**
 * «Доступна новая версия · Позже · Обновить» — the pinned first item of the toast stack, no timer (design D5,
 * docs/prototype.html `renderUpd`). With input a reload would lose: «Черновик пропадёт» and a confirmation.
 */
import { dismissUpdate, requestUpdate, useUpdate } from './check';
import { useHasUnsavedInput } from './silent';

export function UpdateBanner() {
  const shown = useUpdate(s => s.available && !s.dismissed && s.hub !== null);
  const unsaved = useHasUnsavedInput();
  if (!shown) return null;
  return (
    <div className="toast upd" role="status" aria-label="Доступна новая версия">
      <div className="tt">
        <b>Доступна новая версия</b>
        {unsaved && <span className="u-warn">Черновик пропадёт</span>}
      </div>
      <div className="u-acts">
        <button type="button" className="btn ghost" onClick={dismissUpdate}>
          Позже
        </button>
        <button type="button" className="btn primary" onClick={() => requestUpdate()}>
          Обновить
        </button>
      </div>
    </div>
  );
}
