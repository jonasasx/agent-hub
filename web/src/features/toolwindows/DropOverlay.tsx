/**
 * The ghost under the pointer, the drop frame with its label and the hint on the right edge of the app while a tool
 * window is dragged (ported from the prototype: .ghost, #dz, .edge-hint). It lives inside `.app`, which is positioned.
 */
import { WIN_TITLE } from './dock';
import { useDock } from './useDock';
import { useDrag } from './drag';

export function DropOverlay() {
  const { id, x, y, target } = useDrag();
  const rightUsed = useDock(s => s.dock.right.length > 0);
  if (!id) return null;
  return (
    <>
      {!rightUsed && <div className="tw-edge r" aria-hidden="true" />}
      {target && (
        <div
          className={`tw-dz${target.line ? ' line' : ''}${target.rt ? ' rt' : ''}`}
          style={{ left: target.rect.l, top: target.rect.t, width: target.rect.w, height: target.rect.h }}
          aria-hidden="true"
        >
          <span>{target.label}</span>
        </div>
      )}
      <div className="tw-ghost" style={{ left: x + 14, top: y + 10 }} aria-hidden="true">
        {WIN_TITLE[id]}
      </div>
    </>
  );
}
