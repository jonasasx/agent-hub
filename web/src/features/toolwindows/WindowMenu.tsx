/**
 * The «⋯» menu of a window (docs/prototypes/tool-windows.html menuHtml): «Переместить» — every place of both sides
 * (a tab to a window, a window of the column, a new window) with a check at the current one — and «Скрыть окно». The
 * same moves as dragging, for the keyboard and the touch screen.
 */
import { useState } from 'react';
import { WIN_TITLE, SIDES, where, type Side, type WinId } from './dock';
import { IconDots } from './icons';
import { menuKeys, usePopupMenu } from './useFlipMenu';
import { useDock } from './useDock';

const sideName = (side: Side) => (side === 'left' ? 'Слева' : 'Справа');
const names = (ids: WinId[]) => ids.map(o => `«${WIN_TITLE[o]}»`).join(', ');

export function WindowMenu({ id }: { id: WinId }) {
  const [open, setOpen] = useState(false);
  const dock = useDock(s => s.dock);
  const move = useDock(s => s.move);
  const hide = useDock(s => s.hide);
  const { box, trigger, menu } = usePopupMenu(open, () => setOpen(false));
  const w = where(dock, id);

  const item = (key: string, text: string, checked: boolean, run: () => void) => (
    <button
      key={key}
      type="button"
      role="menuitem"
      onClick={() => {
        setOpen(false);
        run();
      }}
    >
      <span className="tw-ck" aria-hidden="true">
        {checked ? '✓' : ''}
      </span>
      {text}
    </button>
  );

  const entries = () =>
    SIDES.flatMap((side, k) => {
      const out = [] as React.ReactNode[];
      if (k) out.push(<hr key={`hr-${side}`} />);
      dock[side].forEach((sl, si) => {
        const others = sl.ids.filter(o => o !== id);
        const text = others.length ? `${sideName(side)} · вкладкой к ${others.length > 1 ? 'окнам' : 'окну'} ${names(others)}` : `${sideName(side)} · ${si + 1}-е окно столбика`;
        out.push(item(`${side}-${si}`, text, sl.ids.includes(id) || !others.length, () => move(id, { side, si, idx: null })));
      });
      const lastOwn = !!w && w.side === side && w.slot.ids.length === 1 && w.si === dock[side].length - 1;
      if (!lastOwn) {
        const text = `${sideName(side)} · новым окном${dock[side].length ? ' внизу' : ''}`;
        out.push(item(`${side}-new`, text, false, () => move(id, { side, si: dock[side].length, asNew: true })));
      }
      return out;
    });

  return (
    <span ref={box} className="tw-pop">
      <button
        ref={trigger}
        type="button"
        className={`tw-hbtn${open ? ' on' : ''}`}
        title="Ещё"
        aria-label={`Меню окна «${WIN_TITLE[id]}»`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {IconDots}
      </button>
      {open && (
        <div ref={menu} className="tw-menu" role="menu" aria-label={`Окно «${WIN_TITLE[id]}»`} onKeyDown={menuKeys}>
          <h6>Переместить «{WIN_TITLE[id]}»</h6>
          {entries()}
          <hr />
          {item('hide', 'Скрыть окно', false, () => hide(id))}
        </div>
      )}
    </span>
  );
}
